// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  // 勾选要导出的文案 ID，可以跨筛选累计；导出时由服务端按所选模块再校一遍
  pickedIds: new Set(),
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：语言区与文案区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' ? target : target.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'i18n-workbench-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  const saved = window.localStorage.getItem(OPERATOR_KEY) || '';
  el('operator').value = saved;
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadLanguages() {
  const payload = await request('/api/languages');
  state.languages = payload.languages || [];
  renderLanguages();
  renderTranslationInputs();
}

async function loadEntries() {
  const params = new URLSearchParams();
  const module = el('filter-module').value;
  const keyword = el('filter-keyword').value.trim();
  if (module) params.set('module', module);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/entries${query ? `?${query}` : ''}`);
  state.entries = payload.entries || [];
  state.modules = payload.modules || [];
  renderModules();
  renderEntries();
}

function renderModules() {
  const select = el('filter-module');
  const current = select.value;
  const rows = ['<option value="">全部模块</option>']
    .concat(state.modules.map((item) => `<option value="${escapeHtml(item.module)}">${escapeHtml(item.module)}（${item.count}）</option>`));
  select.innerHTML = rows.join('');
  if (state.modules.some((item) => item.module === current)) select.value = current;
}

function renderLanguages() {
  const body = el('language-body');
  const rows = state.languages.map((item) => {
    const defaultTag = item.isDefault ? '<span class="tag on">默认</span>' : '';
    const enabledTag = item.enabled ? '<span class="tag on">已启用</span>' : '<span class="tag off">已停用</span>';
    const actions = [
      `<button type="button" class="link" data-language-default="${escapeHtml(item.code)}"${item.isDefault ? ' disabled' : ''}>设为默认</button>`,
      `<button type="button" class="link" data-language-toggle="${escapeHtml(item.code)}">${item.enabled ? '停用' : '启用'}</button>`,
      `<button type="button" class="link" data-language-rename="${escapeHtml(item.code)}">改名</button>`,
      `<button type="button" class="link danger" data-language-delete="${escapeHtml(item.code)}">删除</button>`,
    ];
    return `<tr${item.enabled ? '' : ' class="muted"'}>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${defaultTag}</td>
      <td>${enabledTag}</td>
      <td>${item.filled} 条</td>
      <td class="actions">${actions.join('')}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');
  el('language-empty').classList.toggle('hidden', state.languages.length > 0);
}

// 新建文案的表单按当前登记的语言逐条生成译文输入框，停用的语言照样可以查看与补填
function renderTranslationInputs(values) {
  const box = el('entry-translations');
  const current = values || collectTranslations();
  box.innerHTML = state.languages.map((item) => {
    const value = current[item.code] === undefined ? '' : current[item.code];
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="translation" data-field="translations.${escapeHtml(item.code)}">
      <span>${escapeHtml(item.code)} ${suffix}</span>
      <input class="translation-input" data-code="${escapeHtml(item.code)}" maxlength="200" value="${escapeHtml(value)}">
    </label>`;
  }).join('');
}

function collectTranslations() {
  const result = {};
  document.querySelectorAll('.translation-input').forEach((input) => {
    result[input.dataset.code] = input.value;
  });
  return result;
}

// 勾选列：全选框只作用于当前筛选结果里的文案
function syncPickAll() {
  const pickAll = el('entry-pick-all');
  if (!pickAll) return;
  const visibleIds = state.entries.map((item) => item.id);
  const chosen = visibleIds.filter((id) => state.pickedIds.has(id));
  pickAll.checked = visibleIds.length > 0 && chosen.length === visibleIds.length;
  pickAll.indeterminate = chosen.length > 0 && chosen.length < visibleIds.length;
}

function renderEntries() {
  const head = el('entry-head-row');
  const pickAll = '<th class="pick-col"><input type="checkbox" id="entry-pick-all" title="全选当前筛选结果"></th>';
  head.innerHTML = [pickAll]
    .concat(['模块', '文案键'])
    .concat(state.languages.map((item) => item.code))
    .concat(['备注', '最近改动人', '更新时间', '操作'])
    .map((text, index) => (index === 0 ? text : `<th>${escapeHtml(text)}</th>`))
    .join('');

  const body = el('entry-body');
  body.innerHTML = state.entries.map((item) => {
    const cells = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) return '<td class="missing">未登记</td>';
      if (!value.trim()) return '<td class="missing">待翻译</td>';
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    });
    return `<tr>
      <td class="pick-col"><input type="checkbox" class="entry-pick" data-entry-id="${escapeHtml(item.id)}"${state.pickedIds.has(item.id) ? ' checked' : ''}></td>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
  syncPickAll();
}

function openEntryForm(entry) {
  state.editingId = entry ? entry.id : '';
  el('entry-form-title').textContent = entry ? `编辑文案：${entry.key}` : '新建文案';
  el('entry-module').value = entry ? entry.module : '';
  el('entry-key').value = entry ? entry.key : '';
  el('entry-note').value = entry ? entry.note : '';
  el('entry-translations').innerHTML = '';
  renderTranslationInputs(entry ? entry.translations : {});
  el('entry-form').classList.remove('hidden');
  el('entry-module').focus();
}

function closeEntryForm() {
  state.editingId = '';
  el('entry-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitLanguage(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('language-code').value,
    name: el('language-name').value,
    enabled: el('language-enabled').checked,
    isDefault: el('language-default').checked,
  };
  try {
    await request('/api/languages', { method: 'POST', body: JSON.stringify(payload) });
    el('language-code').value = '';
    el('language-name').value = '';
    el('language-default').checked = false;
    notify('语言已新增', 'ok');
    await loadLanguages();
    await loadEntries();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitEntry(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
  };
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/entries/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文案已保存', 'ok');
    } else {
      await request('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
      notify('文案已新增', 'ok');
    }
    closeEntryForm();
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 语言与文案列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const code = node.dataset.languageDefault || node.dataset.languageToggle
    || node.dataset.languageRename || node.dataset.languageDelete;
  if (code) {
    clearNotice();
    try {
      if (node.dataset.languageDefault) {
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
        notify(`${code} 已设为默认语言`, 'ok');
      } else if (node.dataset.languageToggle) {
        const target = state.languages.find((item) => item.code === code);
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !target.enabled }) });
        notify(`${code} 已${target.enabled ? '停用' : '启用'}`, 'ok');
      } else if (node.dataset.languageRename) {
        const target = state.languages.find((item) => item.code === code);
        const next = window.prompt(`把 ${code} 的名称改成`, target ? target.name : '');
        if (next === null) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify(`${code} 的名称已更新`, 'ok');
      } else {
        if (!window.confirm(`确定删除语言 ${code} 吗？`)) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        notify(`${code} 已删除`, 'ok');
      }
      await loadLanguages();
      await loadEntries();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.entryEdit) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryEdit);
    if (found) openEntryForm(found);
    return;
  }

  if (node.dataset.entryDelete) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryDelete);
    if (!window.confirm(`确定删除文案 ${found ? found.key : ''} 吗？`)) return;
    try {
      await request(`/api/entries/${encodeURIComponent(node.dataset.entryDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
      state.pickedIds.delete(node.dataset.entryDelete);
      notify('文案已删除', 'ok');
      await loadEntries();
      await loadLanguages();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('language-form').addEventListener('submit', submitLanguage);
el('entry-form').addEventListener('submit', submitEntry);
el('entry-new').addEventListener('click', () => {
  clearNotice();
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-module').value = '';
  el('filter-keyword').value = '';
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('entry-refresh').addEventListener('click', () => {
  clearNotice();
  loadLanguages()
    .then(loadEntries)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-module').addEventListener('change', () => {
  loadEntries().catch((err) => notify(err.message, 'error'));
});

// ===== 导出交付 =====

function showExportError(message) {
  const box = el('export-error');
  box.textContent = message;
  box.classList.remove('hidden');
}

function clearExportError() {
  const box = el('export-error');
  box.textContent = '';
  box.classList.add('hidden');
  el('export-modal').querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把服务端指出的出错位置标到弹窗里对应的范围分组上
function markExportField(field) {
  if (!field) return;
  const name = field === 'entryIds' ? 'scope' : field.split('.')[0];
  const target = el('export-modal').querySelector(`[data-field="${name}"]`);
  if (target) target.classList.add('invalid');
}

function checkedModules() {
  return Array.from(el('export-modules').querySelectorAll('input:checked')).map((input) => input.value);
}

function checkedLanguages() {
  const picked = new Set(Array.from(el('export-languages').querySelectorAll('input:checked')).map((input) => input.value));
  return state.languages.map((item) => item.code).filter((code) => picked.has(code));
}

// 勾选条数是全局累计的，直接显示；整体范围以服务端按所选模块＋关键词算出的为准，这里只说明口径
function updateScopeHint() {
  const keyword = el('filter-keyword').value.trim();
  const wordText = keyword ? `匹配关键词「${keyword}」的` : '全部';
  el('export-scope-hint').textContent = `「整体带走」＝所选模块下${wordText}文案；勾选模式只带走你打勾的条目，当前已累计勾选 ${state.pickedIds.size} 条（可跨筛选累计）。`;
  el('export-picked-count').textContent = String(state.pickedIds.size);
}

// 每次打开都按当前数据重建勾选项：已启用的语言默认勾上，模块默认全选
function openExportModal() {
  clearNotice();
  clearExportError();
  el('export-languages').innerHTML = state.languages.map((item) => {
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="check"><input type="checkbox" value="${escapeHtml(item.code)}"${item.enabled ? ' checked' : ''}>
      <span class="mono">${escapeHtml(item.code)}</span> ${escapeHtml(item.name)} ${suffix}</label>`;
  }).join('');
  // 页面上已经按某个模块筛选时，默认只勾这个模块，让「整体带走」与当前列表对齐；否则全选
  const activeModule = el('filter-module').value;
  el('export-modules').innerHTML = state.modules.map((item) => {
    const checked = !activeModule || item.module === activeModule ? ' checked' : '';
    return `<label class="check"><input type="checkbox" value="${escapeHtml(item.module)}"${checked}>
      <span class="mono">${escapeHtml(item.module)}</span>（${item.count}）</label>`;
  }).join('');
  const scopeAll = el('export-modal').querySelector('input[name="export-scope"][value="all"]');
  scopeAll.checked = true;
  el('export-include-empty').checked = false;
  el('export-preview').classList.add('hidden');
  el('export-actions').classList.add('hidden');
  el('export-form').classList.remove('hidden');
  setScopeFieldsDisabled(false);
  updateScopeHint();
  el('export-modal').classList.remove('hidden');
}

function closeExportModal() {
  el('export-modal').classList.add('hidden');
  clearExportError();
}

function setScopeFieldsDisabled(disabled) {
  el('export-languages').querySelectorAll('input').forEach((input) => { input.disabled = disabled; });
  el('export-modules').querySelectorAll('input').forEach((input) => { input.disabled = disabled; });
  el('export-modal').querySelectorAll('input[name="export-scope"]').forEach((input) => { input.disabled = disabled; });
}

// 收集这次导出的范围；预演与确认下载共用同一份口径
function collectExportPayload() {
  const payload = {
    languages: checkedLanguages(),
    modules: checkedModules(),
    includeEmpty: el('export-include-empty').checked,
  };
  const picked = el('export-modal').querySelector('input[name="export-scope"]:checked').value === 'picked';
  if (picked) {
    payload.entryIds = Array.from(state.pickedIds);
  } else {
    const keyword = el('filter-keyword').value.trim();
    if (keyword) payload.keyword = keyword;
  }
  return payload;
}

async function runExportPreview(event) {
  event.preventDefault();
  clearExportError();
  const payload = collectExportPayload();
  try {
    const preview = await request('/api/exports/preview', { method: 'POST', body: JSON.stringify(payload) });
    state.exportPayload = payload;
    renderExportPreview(preview);
  } catch (err) {
    showExportError(err.message);
    markExportField(err.field);
  }
}

function renderExportPreview(preview) {
  const languageRows = preview.languages.map((item) => {
    const suffix = item.enabled ? '' : ' <span class="tag off">已停用</span>';
    return `<tr>
      <td><span class="mono">${escapeHtml(item.code)}</span> ${escapeHtml(item.name)}${suffix}</td>
      <td>${item.filled} 条</td>
      <td class="${item.blank > 0 ? 'missing' : ''}">${item.blank} 条</td>
    </tr>`;
  }).join('');

  let blankBlock;
  if (!preview.blankCount) {
    blankBlock = '<p class="export-ok">所选语言下这一批文案都已填好，没有空缺。</p>';
  } else {
    const limit = 50;
    const rows = preview.blankRows.slice(0, limit).map((row) =>
      `<li><span class="mono">${escapeHtml(row.key)}</span> 在 <span class="mono">${escapeHtml(row.language)}</span> 下为空</li>`).join('');
    const more = preview.blankCount > limit ? `<p class="panel-tip">其余 ${preview.blankCount - limit} 条空缺没有列全，下载文件里可以逐条核对。</p>` : '';
    blankBlock = `<div class="blank-list">
      <h4>空译文清单（${preview.blankCount} 个格子）</h4>
      <ul>${rows}</ul>${more}
    </div>`;
  }

  el('export-preview').innerHTML = `
    <h3>交付预演</h3>
    <p class="export-summary">共 <strong>${preview.totalEntries}</strong> 条文案，模块：${preview.modules.map(escapeHtml).join('、')}；空译文格子共 <strong>${preview.blankCount}</strong> 个。</p>
    <div class="table-wrap">
      <table class="grid">
        <thead><tr><th>语言</th><th>已填译文</th><th>空缺</th></tr></thead>
        <tbody>${languageRows}</tbody>
      </table>
    </div>
    ${blankBlock}
    <p class="panel-tip">空译文是否一并带上，由下方的勾选项决定；改完直接点下载即可，不用重新预演。</p>`;
  el('export-preview').classList.remove('hidden');
  el('export-actions').classList.remove('hidden');
  setScopeFieldsDisabled(true);
}

async function confirmExportDownload() {
  clearExportError();
  if (!state.exportPayload) return;
  const payload = { ...state.exportPayload, includeEmpty: el('export-include-empty').checked };
  try {
    const result = await request('/api/exports', { method: 'POST', body: JSON.stringify(payload) });
    const blob = new Blob([JSON.stringify(result.content, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    notify(`已导出 ${result.totalEntries} 条文案：${result.fileName}`, 'ok');
    closeExportModal();
  } catch (err) {
    showExportError(err.message);
    markExportField(err.field);
  }
}

el('export-open').addEventListener('click', openExportModal);
el('export-close').addEventListener('click', closeExportModal);
el('export-cancel').addEventListener('click', closeExportModal);
el('export-form').addEventListener('submit', runExportPreview);
el('export-download').addEventListener('click', confirmExportDownload);
el('export-rerun').addEventListener('click', () => {
  clearExportError();
  el('export-preview').classList.add('hidden');
  el('export-actions').classList.add('hidden');
  setScopeFieldsDisabled(false);
  state.exportPayload = null;
});
el('export-modules').addEventListener('change', updateScopeHint);
el('filter-keyword').addEventListener('input', updateScopeHint);
el('export-modal').addEventListener('click', (event) => {
  if (event.target === el('export-modal')) closeExportModal();
});

// 勾选列与弹窗复选框都靠事件委托，列表重绘后不用重新绑定
document.addEventListener('change', (event) => {
  const input = event.target;
  if (input.id === 'entry-pick-all') {
    state.entries.forEach((item) => {
      if (input.checked) state.pickedIds.add(item.id);
      else state.pickedIds.delete(item.id);
    });
    renderEntries();
    updateScopeHint();
    return;
  }
  if (input.classList.contains('entry-pick')) {
    const id = input.dataset.entryId;
    if (input.checked) state.pickedIds.add(id);
    else state.pickedIds.delete(id);
    syncPickAll();
    updateScopeHint();
  }
});

el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列
restoreOperator();
loadHealth();
loadLanguages()
  .then(loadEntries)
  .catch((err) => notify(err.message, 'error'));
