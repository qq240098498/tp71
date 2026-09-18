// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  exportOpen: false,
  exportSelection: new Set(),
  exportPreview: null,
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
  if (state.exportOpen) renderExportLanguages();
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
  if (state.exportOpen) {
    renderExportModules();
    refreshExportScopeHint();
  }
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

function renderEntries() {
  const head = el('entry-head-row');
  const headCells = [
    '<th class="pick-col"><input type="checkbox" id="entry-select-all" title="全选当前筛选结果"></th>',
    '<th>模块</th>',
    '<th>文案键</th>',
  ]
    .concat(state.languages.map((item) => `<th>${escapeHtml(item.code)}</th>`))
    .concat(['<th>备注</th>', '<th>最近改动人</th>', '<th>更新时间</th>', '<th>操作</th>']);
  head.innerHTML = headCells.join('');

  const body = el('entry-body');
  body.innerHTML = state.entries.map((item) => {
    const cells = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) return '<td class="missing">未登记</td>';
      if (!value.trim()) return '<td class="missing">待翻译</td>';
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    });
    return `<tr>
      <td class="pick-col"><input type="checkbox" class="entry-pick" data-entry-id="${escapeHtml(item.id)}"${state.exportSelection.has(item.id) ? ' checked' : ''}></td>
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
  syncSelectAll();
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

// ---------- 导出面板 ----------

function renderExportLanguages() {
  const box = el('export-languages');
  const checked = new Set(checkedValues('.export-language'));
  box.innerHTML = state.languages.map((item) => {
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="check-item"><input type="checkbox" class="export-language" value="${escapeHtml(item.code)}"${checked.has(item.code) ? ' checked' : ''}>
      <span class="mono">${escapeHtml(item.code)}</span> ${escapeHtml(item.name)} ${suffix}</label>`;
  }).join('');
}

function renderExportModules() {
  const box = el('export-modules');
  const checked = new Set(checkedValues('.export-module'));
  box.innerHTML = state.modules.map((item) => `<label class="check-item">
    <input type="checkbox" class="export-module" value="${escapeHtml(item.module)}"${checked.has(item.module) ? ' checked' : ''}>
    <span class="mono">${escapeHtml(item.module)}</span>（${item.count} 条）
  </label>`).join('');
}

function openExportPanel() {
  state.exportOpen = true;
  el('export-panel').classList.remove('hidden');
  renderExportLanguages();
  renderExportModules();

  // 整体带走时，模块勾选默认跟着文案区的模块筛选走：筛选了某个模块就只预选它
  const activeModule = el('filter-module').value;
  document.querySelectorAll('.export-module').forEach((box2) => {
    box2.checked = !activeModule || box2.value === activeModule;
  });
  document.querySelectorAll('.export-language').forEach((box2) => { box2.checked = true; });
  invalidateExportPreview();
  refreshExportScopeHint();
}

function closeExportPanel() {
  state.exportOpen = false;
  el('export-panel').classList.add('hidden');
}

function exportScope() {
  const checked = document.querySelector('input[name="export-scope"]:checked');
  return checked ? checked.value : 'filter';
}

function refreshExportScopeHint() {
  const keyword = el('filter-keyword').value.trim();
  const hint = el('export-scope-hint');
  if (exportScope() === 'entries') {
    hint.textContent = `已在列表里勾选 ${state.exportSelection.size} 条文案；勾选的模块也必须选上，否则会被拒绝。`;
  } else {
    hint.textContent = keyword
      ? `按搜索“${keyword}”与所勾选的模块整体导出。`
      : '按所勾选的模块整体导出；搜索框里的关键词也会作为筛选条件。';
  }
}

// 范围有任何改动，上一次的预演就作废，避免照着旧清单下载
function invalidateExportPreview() {
  state.exportPreview = null;
  el('export-result').classList.add('hidden');
  el('export-result').innerHTML = '';
}

function syncSelectAll() {
  const selectAll = el('entry-select-all');
  if (!selectAll) return;
  const visibleIds = state.entries.map((item) => item.id);
  const picked = visibleIds.filter((id) => state.exportSelection.has(id));
  selectAll.checked = visibleIds.length > 0 && picked.length === visibleIds.length;
  selectAll.indeterminate = picked.length > 0 && picked.length < visibleIds.length;
  if (state.exportOpen) refreshExportScopeHint();
}

function checkedValues(selector) {
  return Array.from(document.querySelectorAll(selector))
    .filter((node) => node.checked)
    .map((node) => node.value);
}

// 把页面上的选择收成导出请求；范围一条没选这种明显问题在页面上直接拦下
function collectExportPayload() {
  const payload = {
    scope: exportScope(),
    languageCodes: checkedValues('.export-language'),
    moduleNames: checkedValues('.export-module'),
    includeEmpty: el('export-include-empty').checked,
  };
  if (payload.scope === 'filter') {
    payload.keyword = el('filter-keyword').value.trim();
  } else {
    payload.entryIds = Array.from(state.exportSelection);
    if (payload.entryIds.length === 0) {
      const failure = new Error('一条文案都没勾选，请先在文案列表里勾选要导出的几条');
      failure.field = 'entryIds';
      throw failure;
    }
  }
  return payload;
}

function renderExportPreview(preview) {
  const moduleLine = preview.moduleCounts
    .map((item) => `${item.module} ${item.count} 条`)
    .join('、');
  const languageBlocks = preview.languages.map((item) => {
    const status = item.empty === 0
      ? '<span class="export-ok">全部已填</span>'
      : `<span class="export-warn">空译文 ${item.empty} 条</span>`;
    const emptyList = item.emptyKeys.length
      ? `<ul class="empty-list">${item.emptyKeys.map((row) => `<li><span class="mono">${escapeHtml(row.key)}</span>（${escapeHtml(row.module)}）</li>`).join('')}</ul>`
      : '';
    return `<li>
      <div><span class="mono">${escapeHtml(item.code)}</span> ${escapeHtml(item.name)}：已填 <strong>${item.filled}</strong> 条，空 <strong>${item.empty}</strong> 条 ${status}</div>
      ${emptyList}
    </li>`;
  }).join('');

  let emptyNote = '';
  if (preview.emptyTotal > 0) {
    emptyNote = preview.includeEmpty
      ? `<p class="export-note">已选择带上空译文：共有 ${preview.emptyTotal} 处空译文会以空字符串写进交付文件。</p>`
      : `<p class="export-note">空译文不带：共有 ${preview.emptyTotal} 处空译文会缺省；其中 ${preview.totalEntries - preview.deliverableEntries} 条文案在所选语言下全是空的，不会出现在交付文件里。</p>`;
  }

  const box = el('export-result');
  box.innerHTML = `
    <h4>交付预演</h4>
    <p class="export-summary">一共 <strong>${preview.totalEntries}</strong> 条文案，模块分布：${escapeHtml(moduleLine)}</p>
    <ul class="export-lang-stats">${languageBlocks}</ul>
    ${emptyNote}
    <div class="form-actions">
      <button type="button" id="export-download-btn">确认无误，下载交付物（ZIP）</button>
    </div>`;
  box.classList.remove('hidden');
}

async function requestExportPreview() {
  clearNotice();
  clearFieldMarks();
  let payload;
  try {
    payload = collectExportPayload();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
    return;
  }
  try {
    const preview = await request('/api/export/preview', { method: 'POST', body: JSON.stringify(payload) });
    state.exportPreview = preview;
    renderExportPreview(preview);
    notify('交付预演已生成，确认后即可下载', 'ok');
  } catch (err) {
    invalidateExportPreview();
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 下载走二进制响应，出错时服务端仍然返回 JSON，这里分别处理
async function downloadExport() {
  clearNotice();
  clearFieldMarks();
  let payload;
  try {
    payload = collectExportPayload();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
    return;
  }
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let failure;
      try {
        const data = await res.json();
        failure = new Error((data.error && data.error.message) || `导出失败（状态码 ${res.status}）`);
        failure.code = (data.error && data.error.code) || '';
        failure.field = (data.error && data.error.field) || '';
      } catch (err) {
        failure = new Error(`导出失败（状态码 ${res.status}）`);
      }
      throw failure;
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const filename = match ? match[1] : 'i18n-export.zip';
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
    notify(`交付物已下载：${filename}`, 'ok');
  } catch (err) {
    invalidateExportPreview();
    notify(err.message, 'error');
    markField(err.field);
  }
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
      state.exportSelection.delete(node.dataset.entryDelete);
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
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
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 导出面板相关
el('entry-export').addEventListener('click', () => {
  clearNotice();
  if (state.exportOpen) {
    closeExportPanel();
  } else {
    openExportPanel();
  }
});
el('export-close').addEventListener('click', closeExportPanel);
el('export-preview-btn').addEventListener('click', requestExportPreview);
el('export-include-empty').addEventListener('change', invalidateExportPreview);

document.querySelectorAll('input[name="export-scope"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    invalidateExportPreview();
    refreshExportScopeHint();
  });
});

// 语言、模块勾选一变，旧预演立即作废
document.addEventListener('change', (event) => {
  if (event.target.closest('#export-panel')
    && event.target.matches('.export-language, .export-module')) {
    invalidateExportPreview();
  }
});

// 全选/全不选只动面板里这一组复选框
function setGroupChecked(selector, checked) {
  document.querySelectorAll(selector).forEach((node) => { node.checked = checked; });
  invalidateExportPreview();
}
el('export-lang-all').addEventListener('click', () => setGroupChecked('.export-language', true));
el('export-lang-none').addEventListener('click', () => setGroupChecked('.export-language', false));
el('export-module-all').addEventListener('click', () => setGroupChecked('.export-module', true));
el('export-module-none').addEventListener('click', () => setGroupChecked('.export-module', false));

// 文案勾选与表头全选用 change 事件委托，列表重绘后仍然有效
document.addEventListener('change', (event) => {
  const node = event.target;
  if (node.id === 'entry-select-all') {
    state.entries.forEach((item) => {
      if (node.checked) state.exportSelection.add(item.id);
      else state.exportSelection.delete(item.id);
    });
    renderEntries();
    invalidateExportPreview();
    return;
  }
  if (node.classList.contains('entry-pick')) {
    if (node.checked) state.exportSelection.add(node.dataset.entryId);
    else state.exportSelection.delete(node.dataset.entryId);
    syncSelectAll();
    invalidateExportPreview();
  }
});

// 下载按钮在预演结果渲染后才存在，用事件委托接住
document.addEventListener('click', (event) => {
  if (event.target.closest('#export-download-btn')) downloadExport();
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列
restoreOperator();
loadHealth();
loadLanguages()
  .then(loadEntries)
  .catch((err) => notify(err.message, 'error'));
