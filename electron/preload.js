// AIHubPanel 桌面版的存储桥。
// 网页版把三份数据写进浏览器 localStorage，桌面版把普通配置写入 config.json，
// API Key 单独写入同目录的 apikey.json。
// 这里只暴露 getItem / setItem 两个同步方法，取值约定和 localStorage 完全一致，
// 前端那 5 个存储函数因此只需要换内部实现，几十处调用点一行不动。
const { contextBridge } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 只认这三个 key，桥不会变成任意文件的读写通道。
const FIELDS = {
  "aihub.stations.v2": "stations",
  "aihub.settings.v2": "settings",
  "aihub.ui.v1": "uiState"
};

// app.getPath 只在主进程可用，配置目录由主进程通过 additionalArguments 传进来。
const DIR_FLAG = "--aihub-config-dir=";
const configDir = (process.argv.find(arg => arg.startsWith(DIR_FLAG)) || "").slice(DIR_FLAG.length);
const configFile = configDir ? path.join(configDir, "config.json") : "";
const apiKeyFile = configDir ? path.join(configDir, "apikey.json") : "";

let configCache = null;      // 最近一次读到或写出的不含 API Key 的配置
let apiKeyCache = null;      // 最近一次读到或写出的 API Key 映射
let configStamp = "";        // config.json 的 mtime + 大小
let apiKeyStamp = "";        // apikey.json 的 mtime + 大小
let cacheLoaded = false;

function stampOf(file) {
  try {
    const info = fs.statSync(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

function readJsonSource(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

// 文件被写坏（断电、被外部编辑器截断）时，上一次走「改名失败退回覆写」留下的 .bak
// 是唯一还能找回全部站点和 Key 的东西。这里读到坏文件就退回备份并重新落盘，
// 否则界面会当成「一个站点都没有」，用户随手保存一次就把磁盘上的数据彻底覆盖掉。
// 主文件不存在时不看备份：删掉 config.json 就是明确的「重置」，不该被备份复活。
function readJson(file) {
  try {
    fs.accessSync(file);
  } catch {
    return {};
  }
  try {
    return readJsonSource(file);
  } catch {
    try {
      const recovered = readJsonSource(`${file}.bak`);
      writeJsonAtomic(file, recovered);
      return recovered;
    } catch {
      return {};
    }
  }
}

function normalizeApiKeys(source) {
  const input = source && typeof source === "object" && !Array.isArray(source)
    ? (source.keys && typeof source.keys === "object" && !Array.isArray(source.keys) ? source.keys : source)
    : {};
  const keys = {};
  Object.entries(input).forEach(([id, value]) => {
    // 读侧只校验类型。长度和不可见字符由前端 normalizeApiKey 在写入侧把关，
    // 这里再筛一遍等于把 apikey.json 里真实存在的 Key 悄悄丢掉，
    // 紧接着的一次保存就会把它从文件里抹掉——读路径不该销毁数据。
    if (typeof id !== "string" || !id || typeof value !== "string") return;
    const key = value.trim();
    if (key) keys[id] = key;
  });
  return keys;
}

function stripStationKey(station) {
  const clean = station && typeof station === "object" && !Array.isArray(station) ? { ...station } : {};
  delete clean.apikey;
  delete clean.apiKey;
  return clean;
}

function splitStationKeys(list, previousKeys) {
  const keys = { ...previousKeys };
  const stations = Array.isArray(list) ? list : [];
  const activeIds = new Set();
  const cleanStations = stations.map(station => {
    const source = station && typeof station === "object" && !Array.isArray(station) ? { ...station } : {};
    const id = typeof source.id === "string" ? source.id : "";
    if (!id) {
      // 没有可用 id 的站点挂不到 apikey.json 的某个键上。原样保留它的 Key 字段，
      // 不能让「拆不出去」变成「直接丢掉」。
      return source;
    }
    activeIds.add(id);
    const field = Object.prototype.hasOwnProperty.call(source, "apikey") ? "apikey"
      : (Object.prototype.hasOwnProperty.call(source, "apiKey") ? "apiKey" : "");
    if (field) {
      const key = typeof source[field] === "string" ? source[field].trim() : "";
      if (key) keys[id] = key;
      else delete keys[id];
    }
    return stripStationKey(source);
  });
  Object.keys(keys).forEach(id => {
    if (!activeIds.has(id)) delete keys[id];
  });
  return { stations: cleanStations, keys };
}

function stationsWithKeys(list, keys) {
  return (Array.isArray(list) ? list : []).map(station => {
    const clean = station && typeof station === "object" && !Array.isArray(station) ? { ...station } : {};
    if (typeof clean.id === "string" && clean.id) clean.apikey = keys[clean.id] || "";
    return clean;
  });
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.tmp`;
  // 先写临时文件再改名，写一半断电也不会留下半截 JSON。
  // 改名可能被杀软或正打开该文件的编辑器挡住，那种情况退回直接覆写。
  try {
    fs.writeFileSync(temp, text, "utf8");
    fs.renameSync(temp, file);
    return;
  } catch {
    /* 落到下面的覆写兜底 */
  }
  // 覆写是原地截断，写到一半失败就没有第二份数据了：先留一份 .bak 再动手。
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch { /* 备份失败仍然继续写，否则配置根本无法保存 */ }
  try {
    fs.rmSync(temp, { force: true });
  } catch { /* 临时文件残留不影响结果 */ }
  fs.writeFileSync(file, text, "utf8");
}

function loadState() {
  const nextConfigStamp = stampOf(configFile);
  const nextApiKeyStamp = stampOf(apiKeyFile);
  if (cacheLoaded && nextConfigStamp === configStamp && nextApiKeyStamp === apiKeyStamp) {
    return { config: configCache, keys: apiKeyCache };
  }

  const rawConfig = readJson(configFile);
  const rawKeys = normalizeApiKeys(readJson(apiKeyFile));
  const hasStations = Array.isArray(rawConfig.stations);
  const split = hasStations
    ? splitStationKeys(rawConfig.stations, rawKeys)
    : { stations: rawConfig.stations, keys: rawKeys };
  const config = { ...rawConfig };
  if (hasStations) config.stations = split.stations;
  const legacyKeyCount = Array.isArray(rawConfig.stations)
    ? rawConfig.stations.filter(station => station && typeof station === "object" && (typeof station.apikey === "string" || typeof station.apiKey === "string")).length
    : 0;
  const needsMigration = legacyKeyCount > 0 || (hasStations && JSON.stringify(rawConfig.stations) !== JSON.stringify(split.stations));

  // 旧版 config.json 里的 Key 只在首次读取时迁移；后续以 apikey.json 为唯一来源。
  // 先写独立 Key 文件，再清理普通配置，避免清理成功但 Key 尚未落盘。
  if (needsMigration) {
    try {
      writeJsonAtomic(apiKeyFile, { version: 1, keys: split.keys });
      writeJsonAtomic(configFile, config);
    } catch {
      // 迁移失败时仍用内存中的合并结果运行，下一次写入会再次尝试。
    }
  }

  configCache = config;
  apiKeyCache = split.keys;
  cacheLoaded = true;
  configStamp = stampOf(configFile);
  apiKeyStamp = stampOf(apiKeyFile);
  return { config: configCache, keys: apiKeyCache };
}

function writeState(config, keys) {
  // 配置和 Key 分开落盘；即使其中一个文件被占用，也不会把 API Key 写回普通配置。
  writeJsonAtomic(apiKeyFile, { version: 1, keys });
  writeJsonAtomic(configFile, config);
  configCache = config;
  apiKeyCache = keys;
  cacheLoaded = true;
  configStamp = stampOf(configFile);
  apiKeyStamp = stampOf(apiKeyFile);
}

function parseUpdates(items) {
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    throw new Error("批量存储数据格式无效");
  }
  const updates = {};
  for (const [key, value] of Object.entries(items)) {
    const field = FIELDS[key];
    if (!field) throw new Error(`不支持的存储项：${key}`);
    if (typeof value !== "string") throw new Error(`存储项格式无效：${key}`);
    updates[field] = JSON.parse(value);
  }
  return updates;
}

const store = {
  // 沿用 localStorage 的约定：没有这一项就返回 null。
  // 前端按缺失项和空数组统一显示空状态，用户可从界面添加自己的站点。
  getItem(key) {
    const field = FIELDS[key];
    if (!field || !configFile) return null;
    const state = loadState();
    const rawValue = state.config[field];
    const value = field === "stations" && Array.isArray(rawValue)
      ? stationsWithKeys(rawValue, state.keys)
      : rawValue;
    const text = JSON.stringify(value);
    return text === undefined ? null : text;
  },
  // 写失败时直接抛出，前端原有的 try/catch 会据此提示用户，不会静默丢数据。
  setItem(key, value) {
    if (!configFile) throw new Error("没有拿到配置目录，无法写入本地配置");
    store.setItems({ [key]: value });
  },
  // 多个 localStorage key 合并为一次配置写入，设置/删除/导入时避免重复改名和磁盘刷新。
  setItems(items) {
    if (!configFile) throw new Error("没有拿到配置目录，无法写入本地配置");
    const state = loadState();
    const updates = parseUpdates(items);
    const config = { ...state.config };
    let keys = { ...state.keys };
    if (Object.prototype.hasOwnProperty.call(updates, "stations")) {
      const split = splitStationKeys(updates.stations, keys);
      config.stations = split.stations;
      keys = split.keys;
    }
    Object.entries(updates).forEach(([field, value]) => {
      if (field !== "stations") config[field] = value;
    });
    writeState(config, keys);
  }
};

// 拿不到目录就不挂桥，前端会自动退回 localStorage，界面仍然可用。
if (configFile) contextBridge.exposeInMainWorld("aihubStore", store);
