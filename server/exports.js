// 导出交付：操作者在页面上选好语言、模块与文案范围后，先拿回一份预演（条数与空缺），
// 确认后再生成交付 JSON。范围的合法与否以这一层为准，页面上的勾选只是在收集选择
const { load } = require('./store');
const { ApiError, pickText } = require('./errors');

function readCodeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  value.forEach((item) => {
    const text = pickText(item);
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result;
}

// 解析并校验语言选择：不允许为空，不允许选到没有登记过的语言（忽略大小写）
function resolveLanguages(data, rawLanguages) {
  const picked = readCodeList(rawLanguages);
  if (!picked.length) {
    throw new ApiError(400, 'LANGUAGES_REQUIRED', '请至少选择一种要交付的语言', 'languages');
  }
  const byLower = new Map();
  data.languages.forEach((item) => byLower.set(item.code.toLowerCase(), item));
  const languages = [];
  picked.forEach((code) => {
    const found = byLower.get(code.toLowerCase());
    if (!found) {
      throw new ApiError(404, 'LANGUAGE_UNKNOWN', `语言 ${code} 没有登记过，请先在语言区登记这种语言`, 'languages');
    }
    if (!languages.some((item) => item.code === found.code)) languages.push(found);
  });
  return languages;
}

// 解析并校验模块选择：不允许为空，列表里每一个都必须是真实存在的模块
function resolveModules(data, rawModules) {
  const picked = readCodeList(rawModules);
  if (!picked.length) {
    throw new ApiError(400, 'MODULES_REQUIRED', '请至少选择一个模块', 'modules');
  }
  const existing = new Set(data.entries.map((item) => item.module));
  const missing = picked.filter((name) => !existing.has(name));
  if (missing.length) {
    throw new ApiError(404, 'MODULE_NOT_FOUND', `模块 ${missing.join('、')} 不存在，请重新选择模块`, 'modules');
  }
  return picked;
}

// 解析「只选其中几条」时提交上来的文案 ID 清单，去重，不能一条都没选
function resolveEntryIds(rawIds) {
  const picked = readCodeList(rawIds);
  if (!picked.length) {
    throw new ApiError(400, 'EXPORT_ENTRIES_REQUIRED', '请勾选至少一条文案，或改选当前筛选结果整体导出', 'entryIds');
  }
  return picked;
}

// 按模块集合从全部文案里挑出范围内的条目，再按关键词收窄（与文案列表的搜索口径一致），
// 最后按模块、键排序，与列表接口保持一致的顺序
function scopedEntries(data, modules, keyword) {
  const allowed = new Set(modules);
  const word = pickText(keyword).toLowerCase();
  return data.entries
    .filter((item) => allowed.has(item.module))
    .filter((item) => {
      if (!word) return true;
      if (item.key.toLowerCase().includes(word)) return true;
      return Object.keys(item.translations).some((code) => item.translations[code].toLowerCase().includes(word));
    })
    .sort((a, b) => {
      if (a.module !== b.module) return a.module < b.module ? -1 : 1;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
}

// 从整体范围里再按 ID 收窄成操作者勾选的那几条；ID 不存在、或虽存在但不在选中模块内，都当场拒绝
function pickEntries(all, rawIds, data) {
  const ids = resolveEntryIds(rawIds);
  const inScope = new Map(all.map((item) => [item.id, item]));
  const anywhere = new Map((data ? data.entries : []).map((item) => [item.id, item]));
  const ordered = [];
  const seen = new Set();
  ids.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const found = inScope.get(id);
    if (!found) {
      const outside = anywhere.get(id);
      if (outside) {
        throw new ApiError(400, 'EXPORT_ENTRY_OUT_OF_SCOPE', `勾选的文案 ${outside.key} 属于模块 ${outside.module}，不在这次选中的模块里，请把该模块也勾上或去掉这条文案`, 'modules');
      }
      throw new ApiError(404, 'EXPORT_ENTRY_NOT_FOUND', `勾选的某条文案不存在或已被删除，请重新勾选后再试`, 'entryIds');
    }
    ordered.push(found);
  });
  return ordered;
}

// 把一条文案在选中语言下的情况逐个点清：已填几条、空了哪几个格子（未登记与空串都算空）
function inspectEntry(entry, languageCodes) {
  const values = {};
  const blanks = [];
  languageCodes.forEach((code) => {
    const value = entry.translations[code];
    const filled = typeof value === 'string' && !!value.trim();
    values[code] = filled ? value : '';
    if (!filled) blanks.push({ entryId: entry.id, module: entry.module, key: entry.key, language: code });
  });
  return { values, blanks };
}

// 预演与确认共用的收集步骤：校验范围，算出每条文案在所选语言下的填写情况
function collectExport(input) {
  const data = load();
  const languages = resolveLanguages(data, input.languages);
  const modules = resolveModules(data, input.modules);
  const languageCodes = languages.map((item) => item.code);

  // 整体导出时沿用页面上的关键词，「整体」指的是当前筛选结果的整体；勾选模式下 ID 已经唯一确定范围
  const keyword = input.entryIds === undefined ? input.keyword : '';
  const inScope = scopedEntries(data, modules, keyword);
  const selected = input.entryIds === undefined ? inScope : pickEntries(inScope, input.entryIds, data);
  if (!selected.length) {
    throw new ApiError(404, 'EXPORT_SCOPE_EMPTY', '选中的模块下没有文案可导出，请调整模块或筛选条件', 'modules');
  }

  const blankRows = [];
  const filledCount = {};
  languageCodes.forEach((code) => { filledCount[code] = 0; });
  const items = selected.map((entry) => {
    const { values, blanks } = inspectEntry(entry, languageCodes);
    blanks.forEach((row) => blankRows.push(row));
    languageCodes.forEach((code) => {
      if (values[code]) filledCount[code] += 1;
    });
    return {
      id: entry.id,
      module: entry.module,
      key: entry.key,
      note: entry.note,
      values,
    };
  });

  return { languages, modules, languageCodes, items, blankRows, filledCount };
}

// 对外的预演结果：条数、每种语言已填/空缺数、空译文明细，但不含可下载内容
function summarize(collected) {
  const { languages, modules, items, blankRows, filledCount } = collected;
  return {
    totalEntries: items.length,
    languages: languages.map((item) => ({
      code: item.code,
      name: item.name,
      enabled: item.enabled,
      filled: filledCount[item.code],
      blank: items.length - filledCount[item.code],
    })),
    modules,
    blankCount: blankRows.length,
    blankRows,
  };
}

// 预演：不生成文件，只把这次交付的账算清楚——多少条、每种语言已填多少、哪些格子还空着
function previewExport(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  return summarize(collectExport(input));
}

// 确认导出：重新收集一遍保证范围仍合法，然后按操作者的决定处理空译文并生成交付 JSON
function confirmExport(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const collected = collectExport(input);
  const includeEmpty = input.includeEmpty === true;

  const items = collected.items.map((item) => {
    const translations = {};
    collected.languageCodes.forEach((code) => {
      const value = item.values[code];
      if (value || includeEmpty) translations[code] = value;
    });
    return { module: item.module, key: item.key, note: item.note, translations };
  });

  // 不带空译文时，若选中的格子全是空的，导出只会得到一堆没有译文的键，没有交付价值
  const usable = items.filter((item) => Object.keys(item.translations).length > 0);
  if (!includeEmpty && usable.length === 0) {
    throw new ApiError(400, 'EXPORT_NOTHING_FILLED', '选中的文案在所选语言下全部还没有译文，本次没有可交付的内容；若要把空缺清单一起带走，请勾选「空译文也一并导出」', 'includeEmpty');
  }

  const summary = summarize(collected);
  const generatedAt = new Date().toISOString();
  const content = {
    format: 'i18n-delivery',
    version: 1,
    generatedAt,
    languages: collected.languageCodes,
    modules: collected.modules,
    totalEntries: items.length,
    includeEmpty,
    items,
  };
  return {
    fileName: buildFileName(collected.modules, generatedAt),
    content,
    totalEntries: items.length,
    languages: summary.languages,
    blankCount: summary.blankCount,
  };
}

// 文件名里带上模块与时间，例：i18n-home_order-20260918-093000.json
function buildFileName(modules, isoAt) {
  const stamp = isoAt.replace(/[-:T.Z]/g, '').slice(0, 14);
  return `i18n-${modules.join('_')}-${stamp}.json`;
}

module.exports = {
  previewExport,
  confirmExport,
};
