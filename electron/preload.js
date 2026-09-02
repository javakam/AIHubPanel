// AIHubPanel 桌面版的存储桥。
// 网页版把三份数据写进浏览器 localStorage，桌面版改成写 exe 同目录的明文 config.json。
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

let cache = null;      // 最近一次读到或写出的完整配置
let cacheStamp = "";   // 对应的文件 mtime + 大小，用来发现文件被外部改过

function stampOf() {
  try {
    const info = fs.statSync(configFile);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

// 用户随时可能自己打开 config.json 改内容，所以每次访问都先比对文件戳；
// 只有确认文件没变才用缓存，避免把手工修改覆盖掉。
function readConfig() {
  const stamp = stampOf();
  if (cache && stamp && stamp === cacheStamp) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 文件不存在时按空配置处理；内容损坏时也不立刻清空，留到下一次写入整体覆盖。
    cache = {};
  }
  cacheStamp = stamp;
  return cache;
}

function writeConfig(config) {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const temp = `${configFile}.tmp`;
  // 先写临时文件再改名，写一半断电也不会留下半截 JSON。
  // 改名可能被杀软或正打开该文件的编辑器挡住，那种情况退回直接覆写。
  try {
    fs.writeFileSync(temp, text, "utf8");
    fs.renameSync(temp, configFile);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch { /* 临时文件残留不影响结果 */ }
    fs.writeFileSync(configFile, text, "utf8");
  }
  cache = config;
  cacheStamp = stampOf();
}

const store = {
  // 沿用 localStorage 的约定：没有这一项就返回 null。
  // 前端靠它区分「第一次运行，植入默认站」和「用户主动删空，保留空数组」。
  getItem(key) {
    const field = FIELDS[key];
    if (!field || !configFile) return null;
    const text = JSON.stringify(readConfig()[field]);
    return text === undefined ? null : text;
  },
  // 写失败时直接抛出，前端原有的 try/catch 会据此提示用户，不会静默丢数据。
  setItem(key, value) {
    const field = FIELDS[key];
    if (!field) throw new Error(`不支持的存储项：${key}`);
    if (!configFile) throw new Error("没有拿到配置目录，无法写入 config.json");
    writeConfig({ ...readConfig(), [field]: JSON.parse(value) });
  }
};

// 拿不到目录就不挂桥，前端会自动退回 localStorage，界面仍然可用。
if (configFile) contextBridge.exposeInMainWorld("aihubStore", store);
