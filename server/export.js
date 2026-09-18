// 文案导出：把页面上选定的语言与模块打包成交付物。
// 范围由前端按页面上的实际选择传上来：整条筛选结果或勾选的若干条文案。
// 导出前先做预演，把条数、每种语言的情况与空译文清单摆到页面上，确认后再打包。
const { load } = require('./store');
const { ApiError, pickText, pickFlag } = require('./errors');

// 语言代码与模块名都是文本，去重去空并保持页面勾选的先后顺序
function normalizeStringList(raw, field, codeName) {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'EXPORT_SCOPE_INVALID', `${codeName}需要按勾选顺序组成清单`, field);
  }
  const seen = new Set();
  const result = [];
  raw.forEach((item) => {
    const value = pickText(item);
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

// 把页面选的范围解析成语言清单、模块清单与候选文案，三类不成立的情况在这里当场拒绝，
// 而不是让调用方拿到一份空交付物
function resolveScope(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};

  const languageCodes = normalizeStringList(input.languageCodes, 'languageCodes', '语言');
  if (!languageCodes.length) {
    throw new ApiError(400, 'EXPORT_LANGUAGE_REQUIRED', '一条语言都没选，请先勾选要交付的语言', 'languageCodes');
  }

  const moduleNames = normalizeStringList(input.moduleNames, 'moduleNames', '模块');
  if (!moduleNames.length) {
    throw new ApiError(400, 'EXPORT_MODULE_REQUIRED', '一个模块都没选，请先勾选要导出的模块', 'moduleNames');
  }

  const data = load();
  const languageByCode = new Map();
  data.languages.forEach((item) => languageByCode.set(item.code.toLowerCase(), item));

  const unknownLanguage = languageCodes.find((code) => !languageByCode.has(code.toLowerCase()));
  if (unknownLanguage) {
    throw new ApiError(404, 'EXPORT_LANGUAGE_UNKNOWN', `语言 ${unknownLanguage} 没有登记过，请刷新页面后重新选择`, 'languageCodes');
  }

  const knownModules = new Set(data.entries.map((item) => item.module));
  const unknownModule = moduleNames.find((name) => !knownModules.has(name));
  if (unknownModule) {
    throw new ApiError(404, 'EXPORT_MODULE_NOT_FOUND', `模块 ${unknownModule} 不存在，请刷新页面后重新选择`, 'moduleNames');
  }

  // 页面勾选语言/模块的先后顺序决定交付物里文件与统计的排列，这里保留下来
  const languages = languageCodes.map((code) => languageByCode.get(code.toLowerCase()));
  const moduleSet = new Set(moduleNames);

  const scope = pickText(input.scope) === 'entries' ? 'entries' : 'filter';
  let entries = data.entries.filter((item) => moduleSet.has(item.module));

  if (scope === 'entries') {
    const selectedIds = normalizeStringList(input.entryIds, 'entryIds', '文案');
    const entryById = new Map(data.entries.map((item) => [item.id, item]));
    const missingId = selectedIds.find((id) => !entryById.has(id));
    if (missingId) {
      throw new ApiError(404, 'EXPORT_ENTRY_NOT_FOUND', `有勾选的文案已经不存在了，请刷新页面后重新选择`, 'entryIds');
    }
    // 勾选的文案必须落在所选模块里，模块没选上的条目不允许混进交付物
    const outside = selectedIds
      .map((id) => entryById.get(id))
      .find((item) => !moduleSet.has(item.module));
    if (outside) {
      throw new ApiError(400, 'EXPORT_ENTRY_OUT_OF_SCOPE', `文案 ${outside.key} 不属于所选模块，请把它所在模块也选上`, 'entryIds');
    }
    entries = selectedIds.map((id) => entryById.get(id));
  } else {
    // 整体带走时沿用页面上的筛选条件：模块与关键词
    const keyword = pickText(input.keyword).toLowerCase();
    if (keyword) {
      entries = entries.filter((item) => {
        if (item.key.toLowerCase().includes(keyword)) return true;
        return Object.keys(item.translations).some((code) => item.translations[code].toLowerCase().includes(keyword));
      });
    }
  }

  if (!entries.length) {
    const reason = scope === 'entries' ? '勾选的文案' : '当前筛选结果';
    throw new ApiError(400, 'EXPORT_ENTRY_REQUIRED', `一条文案都没选中（${reason}为空），请先勾选文案或调整筛选条件`, 'entryIds');
  }

  return { languages, moduleNames, entries, scope, includeEmpty: pickFlag(input.includeEmpty, false) };
}

// 预演：总数、模块分布、每种语言的条数、空译文的条数与具体是哪几条
function buildPreview(payload) {
  const resolved = resolveScope(payload);
  const { languages, entries, includeEmpty } = resolved;

  const moduleCounts = {};
  entries.forEach((item) => {
    moduleCounts[item.module] = (moduleCounts[item.module] || 0) + 1;
  });

  const languageStats = languages.map((language) => {
    let filled = 0;
    const emptyKeys = [];
    entries.forEach((item) => {
      const value = item.translations[language.code];
      if (typeof value === 'string' && value.trim()) {
        filled += 1;
      } else {
        emptyKeys.push({ key: item.key, module: item.module });
      }
    });
    return {
      code: language.code,
      name: language.name,
      enabled: language.enabled,
      filled,
      empty: entries.length - filled,
      emptyKeys,
    };
  });

  // 不带上空译文时，所选语言下全空的文案一条都不会写进交付文件，这里提前数出来
  const deliverableEntries = entries.filter((item) => languages.some((language) => {
    const value = item.translations[language.code];
    return typeof value === 'string' && value.trim();
  })).length;

  return {
    totalEntries: entries.length,
    deliverableEntries,
    moduleNames: resolved.moduleNames,
    moduleCounts: resolved.moduleNames.map((name) => ({ module: name, count: moduleCounts[name] || 0 })),
    scope: resolved.scope,
    includeEmpty,
    languages: languageStats,
    emptyTotal: languageStats.reduce((sum, item) => sum + item.empty, 0),
  };
}

// 按导出选项把每条文案整理成交付内容；不带上空译文时，未登记与待翻译都直接缺省
function serializeEntry(entry, languageCodes, includeEmpty) {
  const translations = {};
  languageCodes.forEach((code) => {
    const value = entry.translations[code];
    if (typeof value === 'string') {
      if (includeEmpty || value.trim()) translations[code] = value;
    } else if (includeEmpty) {
      translations[code] = '';
    }
  });
  return {
    key: entry.key,
    module: entry.module,
    translations,
    note: entry.note,
  };
}

function buildExport(payload) {
  const resolved = resolveScope(payload);
  const { languages, entries, includeEmpty } = resolved;
  const languageCodes = languages.map((item) => item.code);

  const files = languages.map((language) => {
    const items = entries
      .map((entry) => serializeEntry(entry, [language.code], includeEmpty))
      // 不带空译文时，整条都是空的就不塞进交付文件
      .filter((item) => includeEmpty || Object.keys(item.translations).length > 0)
      .map((item) => ({ key: item.key, module: item.module, note: item.note, value: item.translations[language.code] }));
    const content = {
      language: language.code,
      languageName: language.name,
      generatedAt: new Date().toISOString(),
      total: items.length,
      entries: items,
    };
    return { name: `${language.code}.json`, content: `${JSON.stringify(content, null, 2)}\n` };
  });

  const payloadItems = entries.map((entry) => serializeEntry(entry, languageCodes, includeEmpty))
    .filter((item) => includeEmpty || Object.keys(item.translations).length > 0);
  const generatedAt = new Date().toISOString();
  const manifest = {
    generatedAt,
    modules: resolved.moduleNames,
    scope: resolved.scope,
    includeEmpty,
    totalEntries: entries.length,
    exportedEntries: payloadItems.length,
    languages: languageCodes,
  };
  files.push({ name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` });

  return { files, totalEntries: entries.length, languageCodes };
}

// 下面是不依赖任何第三方库的 ZIP（store 方式）打包，足够交付 JSON 文案这类小文件

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let crc = n;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS 时间：ZIP 头里用的时间格式，导出只发生在本机，直接按本地时间填
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11)
    | ((date.getMinutes() & 0x3f) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5)
    | (date.getDate() & 0x1f);
  return { time, day };
}

// 把若干 { name, content } 文本文件打成 ZIP Buffer，文件名按 UTF-8 写入并打上语言标志位
function zipFiles(files) {
  const { time, day } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const contentBuffer = Buffer.from(file.content, 'utf8');
    const crc = crc32(contentBuffer);
    const size = contentBuffer.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 第 11 位：文件名与注释按 UTF-8 解析
    local.writeUInt16LE(0, 8);       // store，不压缩
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, contentBuffer);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + contentBuffer.length;
  });

  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, end]);
}

module.exports = {
  buildPreview,
  buildExport,
  zipFiles,
};
