"use strict";
/* =========================================================================
   AIHubPanel · 中转站管理 —— 无构建、零依赖的单页应用
   数据存浏览器 localStorage；请求优先浏览器直连，CORS 失败时可回退受限同源转发。
   本文件结构：
     1) 常量与默认数据   2) 存储层   3) 工具函数   4) 网络层（连通/余额/模型/批量）
     5) 健康总览         6) 渲染（列表/网格/详情/专注）  7) 交互（拖拽/选中/表单/删除/导入导出）
     8) 主题             9) 启动
   终审已修复：fileInput 非法嵌套、亮色对比度、徽标文字、主按钮白字、balanceRaw 展示、
   连通中禁用重测、拖拽手柄点击误选中、剪贴板非安全上下文兜底、matchMedia 兼容、死代码清理。
   ========================================================================= */

/* ---------------- 常量与默认数据 ---------------- */
const LS_STATIONS = "aihub.stations.v2";   // 中转站数组的 localStorage key
const LS_SETTINGS  = "aihub.settings.v2";  // 设置的 localStorage key
const LS_UI_STATE   = "aihub.ui.v1";       // 非敏感界面状态（不含 API Key）
const VERSION = 3;                          // 导出文件版本号
const EXPORT_FORMAT = "aihubpanel.stations"; // 导出格式标识，避免误把其它项目会话文件当站点备份
const DEFAULT_SETTINGS = Object.freeze({ view:"list", theme:"system", proxy:"", concurrency:5, timeout:15, modelSort:"source", testDepth:"basic", longContextKB:4 });
// 本地 server.mjs 可提供受限的同源转发。默认仍由浏览器直连；只有直连受到 CORS
// 或浏览器网络策略拦截时才探测并使用它。纯静态部署没有该路径，会自动回退到直连提示。
const LOCAL_PROXY_PATH = "/api/proxy";
const LOCAL_PROXY_HEALTH_PATH = "/api/proxy/health";
const LOCAL_PROXY_RECHECK_MS = 15000;
let localProxySupport = null;
let localProxyProbe = null;
let localProxyLastCheckedAt = 0;
// connectivity 的「reachable」表示已通过无凭据的跨域探测确认服务可达，
// 但浏览器无法读取带 Authorization 的响应（典型是未配置 CORS 的 OpenAI 网关）。
// 它与 online 分开，避免把“网络可达”误报成“API Key 已验证”。
const CONNECTIVITY_STATES = new Set(["unknown","testing","online","reachable","offline"]);
const MODEL_STATES = new Set(["idle","testing","ok","fail"]);
// 模型响应达到此阈值仍视为成功，但在卡片上明确标为“延迟较高”。
const MODEL_SLOW_LATENCY_MS = 800;
// 日志只保留有限的摘要，既能排查请求又不会随批量测试无限增长。
const REQUEST_LOG_MAX = 60;
const REQUEST_LOG_TEXT_MAX = 500;
const BALANCE_KINDS = new Set(["balance","quota"]);
const MODEL_SORT_MODES = new Set(["source","available","latency"]);
// 测试深度：ping 只验证能否调通（1 次请求）；basic 验证能否正常使用（3 次）；
// deep 额外验证工具调用、JSON 输出与长上下文（6 次，其中长上下文请求体最大）。
const TEST_DEPTHS = new Set(["ping","basic","deep"]);
const TEST_DEPTH_LABELS = Object.freeze({ ping:"连通", basic:"标准", deep:"深度" });
// 探针键必须与 runProbe 分支一一对应；持久化时按此白名单过滤，旧数据与导入备份不会带入未知项。
const PROBE_KEYS = new Set(["chat","identity","stream","context","tools","json","long"]);
const PROBE_LABELS = Object.freeze({
  chat:"指令遵循", identity:"模型一致", stream:"流式输出",
  context:"多轮上下文", tools:"工具调用", json:"JSON 输出", long:"长上下文"
});
const PROBE_STATES = new Set(["pass","fail","skip"]);
const CAPABILITY_GRADES = new Set(["usable","limited","unusable"]);
// 单模型能力报告的持久化上限：探针数固定，detail 文本另有 redact 截断，避免 localStorage 被写爆。
const PROBE_DETAIL_MAX = 200;
// 长上下文填充：默认 4KB，够识别“声明长上下文但实际早早截断”，又不至于单次请求过于昂贵。
const LONG_CONTEXT_KB_MIN = 1;
const LONG_CONTEXT_KB_MAX = 32;
// 流式探针的读取上限：正常回答远小于此值，超出即视为上游异常刷屏并主动断开。
const STREAM_PROBE_MAX_BYTES = 256 * 1024;
// 留空余额路径时的主流中转站探测顺序。管理接口使用站点根路径，兼容 Base URL 已填 /v1 的情况。
const DEFAULT_BALANCE_ENDPOINTS = Object.freeze([
  { path:"/v1/usage", source:"Sub2API", parser:"sub2api" },
  { path:"/api/usage/token", source:"New API", parser:"newapi", root:true },
  { path:"/api/user/self", source:"New API 用户信息", parser:"generic", root:true },
  { path:"/api/user/info", source:"兼容用户信息", parser:"generic", root:true },
  { path:"/v1/user/info/balance", source:"兼容余额接口", parser:"generic" }
]);

// 默认预置中转站（首次打开、无本地数据时植入）；凭据绝不写入静态源码。
const DEFAULT_STATION = {
  name:"新疆-m",
  baseurl:"https://api.hcnsec.cn",
  apikey:"",
  group:"",
  note:"请通过快速导入或编辑填写 API Key",
  balancePath:""
};

// 全局状态
let stations = [];                                   // 中转站数组（有序）
let settings = { ...DEFAULT_SETTINGS };
let editingId = null;                                 // 正在编辑的中转站 id（null=新增）
let deletingId = null;                                // 正在删除确认的中转站 id
let selectedId = null;                                // 列表视图右侧详情所选中项
let focusId = null;                                   // 网格视图点开后的专注页 id
let focusReturnScroll = null;                          // 进入专注页前的视口位置，返回时恢复，避免跳回页面顶部
let focusReturnStationId = null;                       // 专注页返回后恢复到来源站点入口，方便键盘连续操作
let renderRestoreFrame = 0;                            // 合并同一帧内的滚动恢复，避免批测刷新互相抢位置
let scheduledRenderHandle = null;                      // 合并同一帧内的请求状态更新，避免按钮状态连续重绘导致抖动
let selectedModels = new Set();                       // 详情中勾选的「待批量测试」模型 id 集合（唯一真源）
// 按站点保存模型勾选集合；只写入模型/站点 ID，不会把 API Key 放进 UI 状态。
let selectedModelsByStation = new Map();
// 非 source 排序只在用户主动切换排序时建立快照；模型测试状态变化不得改变卡片位置。
const modelDisplaySnapshots = new Map();
// 原生拖拽期间冻结全量渲染，避免异步请求把正在拖动的 DOM 替换掉。
let activeDrag = null;
let renderAfterDrag = false;
let quickImportActive = false;                         // 当前添加弹窗是否处于「粘贴快速导入」模式
let quickImportExistingId = null;                      // 快速识别命中的已有站点，用于定位而不重复新增
const connectivityRequests = new Map();               // 每站仅允许一个连通性探测，避免竞态
const runningBatches = new Map();                      // 正在批量测试的站点及其配置版本，防止重复发起请求
const manualModelTests = new Map();                    // 每站手动测试中的模型集合，允许不同模型并行
const batchRefreshTimers = new Map();                  // 批量测试进度节流，避免 100 模型时高频全页重绘
const balanceRequests = new Map();                     // 每站一个余额请求，防止重复点击与迟到覆盖
const modelListRequests = new Map();                   // 每站一个模型列表请求，防止与批测冲突
const stationRevisions = new Map();                    // 配置变化后递增，丢弃旧请求的迟到响应
const responseTimeouts = new WeakMap();                // AbortController 持续覆盖到响应体读取完成
const responseTransports = new WeakMap();              // Response 实际使用的请求通道（不写入响应体）
let modalTrigger = null;                               // 关闭弹窗后恢复焦点
// API Key 的完整显示只存在于当前页面会话，绝不写入 localStorage；默认始终为半隐私显示。
const revealedApiKeyIds = new Set();
// 表单使用内存中的原始值；输入框在半隐私态只承载掩码文本，避免把完整值留在静态 DOM 属性中。
let formApiKeyValue = "";
let formApiKeyMode = "masked";
let formApiKeyEditing = false;

// 统一图标（内联 SVG，避免使用 unicode 字形导致跨平台不一致）
const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const EYE_ICON  = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A11.7 11.7 0 0 1 12 4c7 0 11 8 11 8a18.2 18.2 0 0 1-3 3.9M6.6 6.6C3.1 8.3 1 12 1 12s4 8 11 8a10.8 10.8 0 0 0 4.1-.8"/></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v4M14 11v4"/></svg>';
const SPINNER_ICON = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/></svg>';
const LIGHTNING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13 2 4.5 13h6.7L10 22l9.5-12h-6.7L13 2Z"/></svg>';
const RETRY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/></svg>';
const LOCATE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>';

/* ---------------- 存储层 ---------------- */
// 生成唯一 id：优先使用浏览器原生 UUID，旧浏览器降级为时间戳 + 随机串
function uid(){
  if(globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return "s_" + globalThis.crypto.randomUUID();
  return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2,10);
}

function text(value, max=2048){ return String(value==null ? "" : value).trim().slice(0,max); }
function normalizeApiKey(value){
  if(typeof value !== "string") return "";
  const key=value.trim();
  return key.length<=2048 && !/[\u0000-\u001f\u007f]/.test(key) ? key : "";
}
function clampInt(value, min, max, fallback){
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
function validId(value){ return /^[A-Za-z0-9_-]{1,96}$/.test(value); }
function normalizeId(value){ const id=text(value,96); return validId(id) ? id : uid(); }
function normalizeBaseUrl(value){
  const raw = typeof value === "string" ? value.trim() : "";
  if(raw.length>2048) return "";
  if(!raw) return "";
  try{
    const url = new URL(raw);
    if(!["http:","https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return "";
    url.search = ""; url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/+$/, "");
  }catch(e){ return ""; }
}
function normalizeBalancePath(value){
  const raw = text(value,1024);
  if(!raw) return "";
  if(/^[A-Za-z][A-Za-z\d+.-]*:/.test(raw) || raw.startsWith("//") || raw.split("/").includes("..")) return null;
  return "/" + raw.replace(/^\/+/, "");
}
function normalizeSettings(source){
  const raw = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return {
    view: raw.view === "grid" ? "grid" : "list",
    theme: ["light","dark","system"].includes(raw.theme) ? raw.theme : "system",
    proxy: text(raw.proxy),
    concurrency: clampInt(raw.concurrency, 1, 20, DEFAULT_SETTINGS.concurrency),
    timeout: clampInt(raw.timeout, 3, 120, DEFAULT_SETTINGS.timeout),
    // 排序只改变当前展示，不重写接口返回的原始模型顺序。
    modelSort: MODEL_SORT_MODES.has(raw.modelSort) ? raw.modelSort : DEFAULT_SETTINGS.modelSort,
    testDepth: TEST_DEPTHS.has(raw.testDepth) ? raw.testDepth : DEFAULT_SETTINGS.testDepth,
    longContextKB: clampInt(raw.longContextKB, LONG_CONTEXT_KB_MIN, LONG_CONTEXT_KB_MAX, DEFAULT_SETTINGS.longContextKB)
  };
}
// 能力报告随站点一起持久化，因此必须像 model 一样做白名单校验：
// 旧版本缓存没有该字段（返回 null 即降级为“未测”），导入的备份也可能被手工改坏。
function normalizeCapability(source, apikey=""){
  if(!source || typeof source !== "object" || Array.isArray(source)) return null;
  const depth = TEST_DEPTHS.has(source.depth) ? source.depth : null;
  const grade = CAPABILITY_GRADES.has(source.grade) ? source.grade : null;
  if(!depth || !grade) return null;
  // Number(null) 和 Number("") 都等于 0，直接转会把「没测到」写成「0ms」，
  // 于是未跑流式的模型也会显示「首字 0ms」。先挡掉空值再转数字。
  const num = value=>{
    if(value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const at = num(source.at);
  const rawProbes = Array.isArray(source.probes) ? source.probes : [];
  const seen = new Set();
  const probes = rawProbes.map(probe=>{
    if(!probe || typeof probe !== "object") return null;
    const key = text(probe.key, 20);
    if(!PROBE_KEYS.has(key) || seen.has(key)) return null;
    seen.add(key);
    return {
      key,
      state: PROBE_STATES.has(probe.state) ? probe.state : "fail",
      ms: num(probe.ms),
      detail: redactSensitiveText(probe.detail, apikey, PROBE_DETAIL_MAX) || ""
    };
  }).filter(Boolean).slice(0, PROBE_KEYS.size);
  if(!probes.length) return null;
  const metrics = source.metrics && typeof source.metrics === "object" && !Array.isArray(source.metrics) ? source.metrics : {};
  return {
    depth, grade, probes, at,
    metrics: { ttft:num(metrics.ttft), total:num(metrics.total), outputTokens:num(metrics.outputTokens), tps:num(metrics.tps) }
  };
}
function normalizeModel(model, apikey=""){
  const id = text(typeof model === "string" ? model : model && (model.id || model.name), 256);
  if(!id) return null;
  const source = model && typeof model === "object" ? model : {};
  const latency = source.latency === "" || source.latency == null ? NaN : Number(source.latency);
  const lastRequestAt = source.lastRequestAt === "" || source.lastRequestAt == null ? NaN : Number(source.lastRequestAt);
  return {
    id,
    // testing 只代表当前页面内正在进行的请求。页面刷新/关闭后没有对应的运行时请求，
    // 必须恢复为 idle，避免遗留状态永久锁死模型刷新、测试和编辑删除操作。
    test: source.test === "ok" || source.test === "fail" ? source.test : "idle",
    latency: Number.isFinite(latency) && latency >= 0 ? latency : null,
    lastRequestAt: Number.isFinite(lastRequestAt) && lastRequestAt >= 0 ? lastRequestAt : null,
    // 旧缓存/导入数据可能来自未脱敏版本；加载时重新按当前站点 Key 清洗。
    err: redactSensitiveText(source.err, apikey, 500) || null,
    capability: normalizeCapability(source.capability, apikey)
  };
}
function normalizeStations(list){
  const used = new Set();
  if(!Array.isArray(list)) return [];
  return list.filter(item=>item && typeof item === "object").map(item=>{
    const station = normalizeStation(item);
    while(used.has(station.id)) station.id = uid();
    used.add(station.id);
    return station;
  });
}

// 加载本地数据：优先读 stations；无数据或解析失败则植入默认站
function load(){
  try{
    const raw = localStorage.getItem(LS_STATIONS);
    // 仅在首次没有 key 时植入默认站；合法空数组代表用户主动删空，必须保留。
    if(raw === null) seedDefault();
    else {
      const arr = JSON.parse(raw);
      if(!Array.isArray(arr)) throw new Error("stations 不是数组");
      stations = normalizeStations(arr);
    }
  }catch(e){
    // 不回写损坏原值，避免一次读取异常就覆盖用户尚可恢复的 localStorage 数据。
    console.warn("读取中转站数据失败，当前会话使用默认站", e);
    seedDefault(false);
  }

  // 只接受白名单字段及合法范围，避免导入或损坏缓存污染运行时状态。
  try{ settings = normalizeSettings(JSON.parse(localStorage.getItem(LS_SETTINGS) || "null")); }
  catch(e){ settings = { ...DEFAULT_SETTINGS }; }
  loadUIState();
}

// 日志是可持久化的诊断摘要，不保存请求体、响应体或任何凭据。
function normalizeRequestLog(entry, apikey=""){
  if(!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const at=Number(entry.at);
  const latency=Number(entry.latency);
  const status=Number(entry.status);
  const level=["info","ok","warn","error"].includes(entry.level) ? entry.level : "info";
  const method=text(entry.method,10).toUpperCase();
  const safeMethod=/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : "—";
  const endpoint=redactSensitiveText(entry.endpoint,apikey,240);
  const message=redactSensitiveText(entry.message,apikey,REQUEST_LOG_TEXT_MAX);
  if(!endpoint && !message && !Number.isFinite(at)) return null;
  return {
    id:text(entry.id,80) || uid(),
    at:Number.isFinite(at) && at >= 0 ? at : Date.now(),
    level,
    kind:text(entry.kind,40) || "request",
    method:safeMethod,
    endpoint:endpoint || "—",
    model:text(entry.model,256) || null,
    status:Number.isFinite(status) && status >= 0 ? Math.trunc(status) : null,
    latency:Number.isFinite(latency) && latency >= 0 ? latency : null,
    transport:["direct","builtin","custom"].includes(entry.transport) ? entry.transport : null,
    message:message || "请求完成"
  };
}
function normalizeRequestLogs(list, apikey=""){
  if(!Array.isArray(list)) return [];
  const logs=[];
  list.slice(-REQUEST_LOG_MAX).forEach(entry=>{
    const normalized=normalizeRequestLog(entry,apikey);
    if(normalized) logs.push(normalized);
  });
  return logs;
}

// 把任意（含旧版/导入）站点对象规整为当前结构，补全缺失字段，保证后续逻辑安全
function normalizeStation(source){
  const s = source && typeof source === "object" ? source : {};
  const apikey = normalizeApiKey(s.apikey);
  const status = s.status && typeof s.status === "object" ? s.status : {};
  const latency = status.latency === "" || status.latency == null ? NaN : Number(status.latency);
  const balance = status.balance === "" || status.balance == null ? NaN : Number(status.balance);
  const models = [];
  const modelIds = new Set();
  (Array.isArray(s.models) ? s.models : []).forEach(raw=>{
    const model = normalizeModel(raw, apikey);
    if(model && !modelIds.has(model.id)){ modelIds.add(model.id); models.push(model); }
  });
  const balancePath = normalizeBalancePath(s.balancePath);
  return {
    id: normalizeId(s.id),
    name: text(s.name,120) || "未命名",
    baseurl: normalizeBaseUrl(s.baseurl),
    apikey,
    // 旧版本曾把默认站点标为“主力”；该概念已移除，兼容读取时清除旧标签。
    group: text(s.group,80) === "主力" ? "" : text(s.group,80),
    note: text(s.note,1000),
    balancePath: balancePath === null ? "" : balancePath,
    order: Number.isFinite(Number(s.order)) ? Number(s.order) : 0,
    // 状态对象：连通性、余额及其来源/单位、原始返回、最近测试时间/错误原因
    status: {
      connectivity: CONNECTIVITY_STATES.has(status.connectivity) ? status.connectivity : "unknown",
      latency: Number.isFinite(latency) && latency >= 0 ? latency : null,
      balance: Number.isFinite(balance) ? balance : null,
      balanceKind: BALANCE_KINDS.has(status.balanceKind) ? status.balanceKind : "balance",
      balanceUnlimited: status.balanceUnlimited === true,
      balanceUnit: text(status.balanceUnit,32) || null,
      balanceSource: text(status.balanceSource,160) || null,
      balanceNote: text(status.balanceNote,240) || null,
      // 历史缓存/导入文件中的原始余额响应也可能含调试凭据；加载时统一转为可安全展示的副本。
      balanceRaw: status.balanceRaw == null ? null : sanitizeBalanceRaw(status.balanceRaw,apikey),
      balanceError: redactSensitiveText(status.balanceError,apikey,500) || null,
      modelListError: redactSensitiveText(status.modelListError,apikey,500) || null,
      // null/空值表示从未测试；Number(null) 会得到 0，不能把它误判为有效时间戳。
      lastTest: (typeof status.lastTest === "number" || (typeof status.lastTest === "string" && status.lastTest.trim() !== "")) && Number.isFinite(Number(status.lastTest))
        ? Number(status.lastTest)
        : null,
      error: redactSensitiveText(status.error,apikey,500) || null,
      // direct / builtin / custom 只记录最近一次已完成的诊断通道，便于解释 CORS 恢复行为。
      transport: ["direct","builtin","custom"].includes(status.transport) ? status.transport : null,
      authMode: ["bearer","x-api-key"].includes(status.authMode) ? status.authMode : "bearer",
      logs: normalizeRequestLogs(status.logs, apikey)
    },
    models
  };
}

// 首次无数据时植入默认「新疆-m」
function seedDefault(persist=true){
  const s = normalizeStation(Object.assign({ id:uid() }, DEFAULT_STATION));
  s.order = 0;
  s.status.connectivity = "unknown";
  stations = [s];
  if(persist) save();
}

// 持久化失败的统一告警：高频写入（测试进度、连通性诊断等）不应连续轰炸，
// 故按 4 秒去重弹一次红色提示；调用方仍负责关键结构性操作的显式回滚。
let warnPersistenceAt = 0;
function warnPersistence(){
  const now = Date.now();
  if(now - warnPersistenceAt < 4000) return;
  warnPersistenceAt = now;
  toast("浏览器存储写入失败（可能已满或被禁用），改动未持久化，建议导出备份后清理", "err");
}

// 持久化：仅写 stations / settings 两个 key
function save(){
  try{ localStorage.setItem(LS_STATIONS, JSON.stringify(stations)); return true; }
  catch(e){ console.warn("保存中转站数据失败", e); warnPersistence("stations"); return false; }
}
function saveSettings(){
  try{ localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); return true; }
  catch(e){ console.warn("保存设置失败", e); warnPersistence("settings"); return false; }
}

// 读取/保存只影响界面位置的状态。任何异常值都会被丢弃，且绝不包含站点凭据。
function loadUIState(){
  selectedModelsByStation = new Map();
  try{
    const raw = JSON.parse(localStorage.getItem(LS_UI_STATE) || "null");
    if(!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    if(typeof raw.selectedStationId === "string" && getById(raw.selectedStationId)) selectedId = raw.selectedStationId;
    const groups = raw.selectedModelsByStation;
    if(groups && typeof groups === "object" && !Array.isArray(groups)){
      Object.keys(groups).slice(0,2000).forEach(id=>{
        if(!getById(id) || !Array.isArray(groups[id])) return;
        const valid = new Set(getById(id).models.map(model=>model.id));
        const picked = groups[id].filter(value=>typeof value === "string" && valid.has(value)).slice(0,2000);
        if(picked.length) selectedModelsByStation.set(id, picked);
      });
    }
  }catch(_){ /* 损坏的 UI 状态不影响站点配置加载 */ }
}
function saveUIState(){
  try{
    const activeStationId = focusId || selectedId;
    const selectedStationId = activeStationId && getById(activeStationId) ? activeStationId : null;
    const selectedModelsOut = {};
    selectedModelsByStation.forEach((models,id)=>{
      if(getById(id) && Array.isArray(models) && models.length) selectedModelsOut[id] = models.slice(0,2000);
    });
    localStorage.setItem(LS_UI_STATE, JSON.stringify({ selectedStationId, selectedModelsByStation:selectedModelsOut }));
    return true;
  }catch(e){ console.warn("保存界面状态失败", e); warnPersistence("ui"); return false; }
}
function rememberCurrentModelSelection(){
  const activeId = focusId || selectedId;
  if(!activeId || !getById(activeId)) return;
  const valid = new Set(getById(activeId).models.map(model=>model.id));
  const picked = [...selectedModels].filter(modelId=>valid.has(modelId));
  if(picked.length) selectedModelsByStation.set(activeId,picked);
  else selectedModelsByStation.delete(activeId);
  saveUIState();
}
function restoreModelSelection(id){
  const st=getById(id);
  const valid = new Set(st ? st.models.map(model=>model.id) : []);
  selectedModels = new Set((selectedModelsByStation.get(id) || []).filter(modelId=>valid.has(modelId)));
  if(selectedModels.size) selectedModelsByStation.set(id,[...selectedModels]);
  else selectedModelsByStation.delete(id);
}

// 按 order 字段排序（就地），保证拖拽/增删后顺序稳定
function byOrder(){ stations.sort((a,b)=> a.order-b.order); }
function getById(id){ return stations.find(s=>s.id===id); }
function hasStationCredentials(st){ return !!(st && st.baseurl && st.apikey); }
// 判重只使用规范化后的 Base URL 与 API Key 明文值；同一 URL 使用不同 Key 仍然是不同站点。
function stationCredentialKey(baseurl, apikey){
  const url=normalizeBaseUrl(baseurl);
  const key=normalizeApiKey(apikey);
  return url && key ? url+"\u0000"+key : "";
}
function findSameStation(baseurl, apikey, excludeId=null){
  const target=stationCredentialKey(baseurl,apikey);
  if(!target) return null;
  return stations.find(st=>st.id!==excludeId && stationCredentialKey(st.baseurl,st.apikey)===target) || null;
}
function duplicateStationMessage(st){
  const name=text(st && st.name,120) || "未命名";
  return `相同 Base URL 和 API Key 已添加到「${name}」，未重复新增`;
}
function stationNameFromBaseUrl(baseurl){
  try{ return new URL(baseurl).hostname || "未命名"; }
  catch(e){ return "未命名"; }
}

/* ---------------- 工具函数 ---------------- */
// API Key 半隐私掩码：始终保留首尾识别片段，中段统一用 *，不暴露原始长度。
function maskKey(k){
  if(!k) return "—";
  if(k.length===1) return "*";
  if(k.length<=4) return k.slice(0,1) + "*".repeat(Math.max(1,k.length-2)) + k.slice(-1);
  if(k.length<=10) return k.slice(0,2) + "****" + k.slice(-2);
  return k.slice(0,6) + "********" + k.slice(-4);
}
// 列表卡片使用更长但仍不暴露中段内容的掩码，避免短字符串在宽容器里显得空。
function listMaskKey(k){
  if(!k) return "—";
  if(k.length<=10) return maskKey(k);
  return k.slice(0,8) + "************" + k.slice(-6);
}
// HTML 转义，防止站点名/地址等用户输入破坏结构或注入
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function isApiKeyRevealed(id){ return revealedApiKeyIds.has(id); }
function apiKeyVisibilityLabel(visible){ return visible ? "隐藏完整 API Key，改为半隐私显示" : "显示完整 API Key"; }
// 静态展示不把原始 Key 写进 DOM 属性；复制时再按站点 ID 从内存读取。
function apiKeyControlsMarkup(st, options={}){
  const hasKey=!!st.apikey;
  const visible=hasKey && isApiKeyRevealed(st.id);
  const displayId=options.displayId ? ` id="${esc(options.displayId)}"` : "";
  const toggleId=options.toggleId ? ` id="${esc(options.toggleId)}"` : "";
  const textClass=options.detail ? "key-secret txt" : "key-secret";
  const label=hasKey ? apiKeyVisibilityLabel(visible) : "暂无 API Key";
  const disabled=hasKey ? "" : " disabled";
  const keyDisplay=!hasKey && options.list ? "暂无 API Key" : (visible ? st.apikey : (options.list ? listMaskKey(st.apikey) : maskKey(st.apikey)));
  const keyValue=`<span class="${textClass}"${displayId} data-key-value="${esc(st.id)}">${esc(keyDisplay)}</span>`;
  const toggleButton=`<button type="button" class="key-action"${toggleId} data-key-toggle="${esc(st.id)}" aria-pressed="${visible?"true":"false"}" title="${label}" aria-label="${label}"${disabled}>${visible?EYE_OFF_ICON:EYE_ICON}</button>`;
  const copyButton=`<button type="button" class="key-action" data-copy-key-id="${esc(st.id)}" title="${hasKey?"复制 API Key":"暂无 API Key"}" aria-label="${hasKey?"复制 API Key":"暂无 API Key"}"${disabled}>${COPY_ICON}</button>`;
  if(options.list){
    return `<span class="api-key-inline list-api-key ${visible?"is-revealed":""} ${hasKey?"":"is-empty"}" data-key-control="${esc(st.id)}"><span class="key-box">${keyValue}</span><span class="key-actions">${toggleButton}${copyButton}</span></span>`;
  }
  return `<span class="api-key-inline ${visible?"is-revealed":""}" data-key-control="${esc(st.id)}">${keyValue}${toggleButton}${copyButton}</span>`;
}
function syncApiKeyControls(id){
  const st=getById(id); if(!st) return;
  const visible=isApiKeyRevealed(id);
  const label=apiKeyVisibilityLabel(visible);
  document.querySelectorAll("[data-key-control]").forEach(group=>{
    if(group.dataset.keyControl!==id) return;
    group.classList.toggle("is-revealed",visible);
    const value=group.querySelector("[data-key-value]");
    if(value){
      value.textContent=visible ? st.apikey : (!st.apikey && group.classList.contains("list-api-key") ? "暂无 API Key" : (group.classList.contains("list-api-key") ? listMaskKey(st.apikey) : maskKey(st.apikey)));
      // 进入全文态始终从开头显示，既不改卡片尺寸，也不会保留上次横向滚动位置。
      if(visible) value.scrollLeft=0;
    }
  });
  document.querySelectorAll("[data-key-toggle]").forEach(button=>{
    if(button.dataset.keyToggle!==id) return;
    button.setAttribute("aria-pressed",String(visible));
    button.setAttribute("aria-label",label);
    button.title=label;
    button.innerHTML=visible ? EYE_OFF_ICON : EYE_ICON;
  });
}
function toggleApiKeyVisibility(id){
  if(!getById(id)) return;
  if(isApiKeyRevealed(id)) revealedApiKeyIds.delete(id); else revealedApiKeyIds.add(id);
  syncApiKeyControls(id);
}
function copyStationApiKey(id){
  const st=getById(id);
  if(!st || !st.apikey){ toast("暂无可复制的 API Key","warn"); return; }
  copyText(st.apikey);
}
function bindApiKeyControls(root){
  if(!root || !root.querySelectorAll) return;
  root.querySelectorAll("[data-key-toggle]").forEach(button=>{
    button.onclick=event=>{ event.stopPropagation(); toggleApiKeyVisibility(button.dataset.keyToggle); };
  });
  root.querySelectorAll("[data-copy-key-id]").forEach(button=>{
    button.onclick=event=>{ event.stopPropagation(); copyStationApiKey(button.dataset.copyKeyId); };
  });
}
function formApiKeyIsFullyVisible(){ return !!formApiKeyValue && (formApiKeyMode==="revealed" || formApiKeyEditing); }
function readFormApiKeyValue(){
  const input=document.getElementById("f_apikey");
  if(input && formApiKeyIsFullyVisible()) formApiKeyValue=input.value.slice(0,2048);
  return formApiKeyValue;
}
function setFormApiKeyValue(value){
  formApiKeyValue=typeof value==="string" ? value.slice(0,2048) : "";
  formApiKeyMode="masked";
  formApiKeyEditing=false;
  updateFormApiKeyControls();
}
function updateFormApiKeyControls(){
  const input=document.getElementById("f_apikey");
  const toggle=document.getElementById("f_apikey_toggle");
  const copy=document.getElementById("f_apikey_copy");
  if(!input || !toggle || !copy) return;
  const hasKey=!!formApiKeyValue;
  const visible=hasKey && formApiKeyIsFullyVisible();
  const editable=!hasKey || visible;
  const shown=!hasKey ? "" : (visible ? formApiKeyValue : maskKey(formApiKeyValue));
  if(input.value!==shown) input.value=shown;
  input.type="text";
  input.readOnly=!editable;
  input.setAttribute("aria-readonly",String(!editable));
  input.closest(".sensitive-input")?.classList.toggle("is-revealed",visible);
  const label=hasKey ? apiKeyVisibilityLabel(visible) : "暂无 API Key";
  toggle.disabled=!hasKey;
  toggle.setAttribute("aria-pressed",String(visible));
  toggle.setAttribute("aria-label",label);
  toggle.title=label;
  toggle.innerHTML=visible ? EYE_OFF_ICON : EYE_ICON;
  copy.disabled=!hasKey;
  copy.innerHTML=COPY_ICON;
}
function setFormApiKeyVisibility(visible){
  readFormApiKeyValue();
  formApiKeyMode=visible && !!formApiKeyValue ? "revealed" : "masked";
  formApiKeyEditing=false;
  updateFormApiKeyControls();
}
function startFormApiKeyEditing(){
  // 已有密钥的半隐私态保持只读，只有眼睛显式切到全文后才能编辑。
  if(formApiKeyMode==="revealed" || formApiKeyValue) return;
  formApiKeyEditing=true;
  updateFormApiKeyControls();
  const input=document.getElementById("f_apikey");
  if(input && document.activeElement===input){
    try{ input.setSelectionRange(input.value.length,input.value.length); }catch(_){ }
  }
}
function finishFormApiKeyEditing(){
  const input=document.getElementById("f_apikey");
  if(!input || input.readOnly) return;
  readFormApiKeyValue();
  formApiKeyEditing=false;
  formApiKeyMode="masked";
  updateFormApiKeyControls();
}
function handleFormApiKeyInput(){
  const input=document.getElementById("f_apikey");
  if(!input || input.readOnly) return;
  if(!formApiKeyIsFullyVisible()) formApiKeyEditing=true;
  formApiKeyValue=input.value.slice(0,2048);
  updateFormApiKeyControls();
}
function clearFormApiKeyValue(){ setFormApiKeyValue(""); }
// 延时分级配色：<200ms 绿、<800ms 黄、更慢红、无值灰
function latencyCls(ms){ if(!Number.isFinite(ms) || ms<0) return "na"; return ms<200?"good":ms<800?"mid":"bad"; }
function fmtLat(ms){ return !Number.isFinite(ms) || ms<0 ? "—" : Math.round(ms)+"ms"; }
function fmtRequestTime(value){
  if(!Number.isFinite(value) || value<0) return "—";
  try{
    return new Intl.DateTimeFormat("zh-CN",{ hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }).format(new Date(value));
  }catch(_){ return "—"; }
}
// 日志只保存脱敏的请求摘要，永远不记录请求体、响应体或 API Key。
function appendRequestLog(st, entry={}){
  if(!st || !st.status) return null;
  if(!Array.isArray(st.status.logs)) st.status.logs=[];
  const normalized=normalizeRequestLog({ ...entry, at:Number.isFinite(Number(entry.at)) ? Number(entry.at) : Date.now() }, st.apikey);
  if(!normalized) return null;
  st.status.logs.push(normalized);
  if(st.status.logs.length > REQUEST_LOG_MAX) st.status.logs.splice(0, st.status.logs.length-REQUEST_LOG_MAX);
  return normalized;
}
function modelVisualState(model){
  if(!model || model.test === "idle") return "idle";
  if(model.test === "testing") return "testing";
  if(model.test === "fail") return "fail";
  if(model.test === "ok" && Number.isFinite(model.latency) && model.latency >= MODEL_SLOW_LATENCY_MS) return "slow";
  return "ok";
}
function requestLogEntries(st){
  if(!st || !Array.isArray(st.models)) return { entries:[], count:0 };
  const saved=Array.isArray(st.status && st.status.logs) ? st.status.logs : [];
  if(saved.length){
    const entries=saved.slice(-REQUEST_LOG_MAX).map(log=>({ log })).sort((a,b)=>{
      const atA=Number.isFinite(a.log.at) ? a.log.at : -1;
      const atB=Number.isFinite(b.log.at) ? b.log.at : -1;
      return atB-atA;
    });
    return { entries, count:entries.length };
  }
  // 兼容没有结构化日志的旧缓存：仅由模型状态生成受限摘要，下一次请求会迁移到 logs。
  const entries=st.models.map((model,index)=>{
    const state=modelVisualState(model);
    const textValue=state==="testing" ? "正在请求 /v1/chat/completions" : state==="ok" || state==="slow" ? "请求成功 · "+fmtLat(model.latency) : state==="fail" ? (model.err || "请求失败") : "";
    if(!textValue) return null;
    return { index, log:{ id:"legacy-"+index, at:Number.isFinite(model.lastRequestAt)?model.lastRequestAt:0, level:state==="fail"?"error":state==="testing"?"info":"ok", kind:"模型测试", method:"POST", endpoint:"/v1/chat/completions", model:model.id, status:null, latency:model.latency, transport:null, message:redactSensitiveText(textValue,st.apikey,REQUEST_LOG_TEXT_MAX) } };
  }).filter(Boolean).sort((a,b)=>(b.log.at-a.log.at)||a.index-b.index).slice(0,REQUEST_LOG_MAX);
  return { entries, count:entries.length };
}
// 「开始」类 info 日志只有在对应请求仍在进行时才算 live；完成后仅作为历史记录，
// 不能一直顶着 spinner，否则用户会误以为请求卡死或仍在发起。
function isLogEntryLive(log, st){
  if(!log || log.level !== "info" || !st) return false;
  if(log.kind === "模型测试" && log.model){
    const model=Array.isArray(st.models) ? st.models.find(m=>m.id===log.model) : null;
    return !!model && model.test === "testing";
  }
  if(log.kind === "连通诊断") return st.status && st.status.connectivity === "testing";
  return false;
}
function requestLogPanelMarkup(st){
  const logData=requestLogEntries(st);
  const entries=logData.entries;
  const logRows=entries.length ? entries.map(({log})=>{
    const live=isLogEntryLive(log, st);
    // 非 live 的 info 日志回落为中性默认样式（无 testing 琥珀色），只有进行中才着色并转圈。
    const cls=log.level === "error" ? "fail" : log.level === "warn" ? "warn" : log.level === "ok" ? "ok" : (live ? "testing" : "info");
    const status=Number.isFinite(log.status) ? "HTTP "+log.status : "—";
    const latency=Number.isFinite(log.latency) ? fmtLat(log.latency) : "—";
    const transport=log.transport === "builtin" ? "本地转发" : log.transport === "custom" ? "自定义代理" : log.transport === "direct" ? "浏览器直连" : "—";
    const subject=log.model ? ` · ${log.model}` : "";
    return `<div class="request-log-entry ${cls}">
      <div class="request-log-entry-head"><strong>${esc(log.kind || "请求")}${esc(subject)}</strong><time>${esc(fmtRequestTime(log.at))}</time></div>
      <div class="request-log-entry-meta"><span>${esc(log.method || "—")} ${esc(log.endpoint || "—")}</span><span>${esc(status)}</span><span>${esc(latency)}</span><span>${esc(transport)}</span></div>
      <div class="request-log-entry-text">${live?SPINNER_ICON:""}${esc(log.message || "请求完成")}</div>
    </div>`;
  }).join("") : `<div class="request-log-empty">暂无请求记录</div>`;
  return `<section class="request-log-panel" aria-label="日志">
    <div class="request-log-head">
      <div class="request-log-heading"><span class="title">日志</span><span class="request-log-count">${logData.count ? logData.count+" 条" : "等待请求"}</span></div>
      <span class="request-log-summary">仅保留最近 ${REQUEST_LOG_MAX} 条脱敏核心请求信息</span>
    </div>
    <div class="request-log-list">${logRows}</div>
  </section>`;
}
// 是否窄屏（≤1024px）；对老浏览器无 matchMedia 时安全降级为「非窄屏」。
// 此处与 CSS 断点保持一致，避免 100 个模型在中等宽度详情栏被压成单列。
function isNarrow(){ const mq = window.matchMedia ? window.matchMedia("(max-width:1024px)") : null; return mq ? mq.matches : false; }
// 当前全局勾选集只服务正在展示的一个详情；旧站点异步刷新不得改写新站点的勾选。
function isSelectionStation(id){
  return focusId === id || (!focusId && settings.view === "list" && !isNarrow() && selectedId === id);
}

// API 地址拼接：同时接受服务根地址与已包含 /v1 的 OpenAI Base URL，避免出现 /v1/v1。
function apiUrl(baseurl, endpoint){
  const base = normalizeBaseUrl(baseurl);
  const path = "/" + text(endpoint,1024).replace(/^\/+/, "");
  const baseHasV1 = /\/v1$/i.test(base);
  const pathHasV1 = /^\/v1(?:\/|$)/i.test(path);
  return base + (baseHasV1 && pathHasV1 ? path.slice(3) : path);
}

// New API / Sub2API 的后台接口通常位于服务根 /api/*；若用户填的是 .../v1，也不应拼成 .../v1/api/*。
function rootApiUrl(baseurl, endpoint){
  const base = normalizeBaseUrl(baseurl).replace(/\/v1$/i, "");
  return base + "/" + text(endpoint,1024).replace(/^\/+/, "");
}

// 拼接最终请求地址：代理支持 ?u= 前缀、已有 query 参数，以及 {url} 占位符三种常见形式。
function buildUrl(target){
  const prefix = settings.proxy;
  if(!prefix) return target;
  if(prefix.includes("{url}")) return prefix.replaceAll("{url}", encodeURIComponent(target));
  if(/[?&]u=$/.test(prefix) || prefix.endsWith("=")) return prefix + encodeURIComponent(target);
  return prefix + (prefix.includes("?") ? "&u=" : "?u=") + encodeURIComponent(target);
}

// 快速导入只解析 JSON（或 JSON 字段片段），绝不执行粘贴内容。截断片段会走下面的受限扫描器，
// 只读取双引号 JSON 字符串和花括号层级，既不会执行输入，也不会把不同对象中的两个字段误配。
const QUICK_IMPORT_MAX_LENGTH = 20 * 1024;
const QUICK_IMPORT_MAX_OBJECTS = 512;
const QUICK_IMPORT_MAX_DEPTH = 32;
function prepareQuickImportInput(raw){
  if(typeof raw !== "string") throw new Error("请粘贴文本格式的 JSON 配置");
  if(raw.length > QUICK_IMPORT_MAX_LENGTH) throw new Error("粘贴内容不能超过 20 KiB");
  let input=raw.replace(/^\uFEFF/,"").trim();
  const fenced=input.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if(fenced) input=fenced[1].trim();
  if(!input) throw new Error("请先粘贴站点配置");
  return input;
}
function parseQuickImportJson(raw){
  let input=prepareQuickImportInput(raw);
  // 用户常复制 “options”: { ... }, 这类字段片段；仅安全地补一层对象，不接受 JS 对象字面量或注释。
  input=input.replace(/,\s*$/,"");
  const json=/^[{[]/.test(input) ? input : "{"+input+"}";
  try{ return JSON.parse(json); }
  catch(e){ throw new Error("无法识别完整 JSON"); }
}
function quickImportFieldName(key){ return String(key).replace(/[_-]/g,"").toLowerCase(); }
function createQuickImportFields(){
  return { baseurl:undefined, apikey:undefined, newApiType:undefined, newApiUrl:undefined, newApiKey:undefined };
}
function setQuickImportField(fields, key, value){
  const name=quickImportFieldName(key);
  if(name==="baseurl" || name==="apikey"){
    fields[name]=value;
    return;
  }
  // NewAPI 通道连接导出有明确的类型标识。只有同一对象带此标识时，才将 url/key
  // 视为连接配置，避免把普通 JSON 中无关的 url 和 key 误识别成站点凭据。
  if(key==="_type") fields.newApiType=value;
  else if(name==="url") fields.newApiUrl=value;
  else if(name==="key") fields.newApiKey=value;
}
function quickImportPairsFromFields(fields){
  const pairs=[];
  if(fields.baseurl!==undefined || fields.apikey!==undefined){
    pairs.push({ baseurl:fields.baseurl, apikey:fields.apikey });
  }
  if(fields.newApiType==="newapi_channel_conn" && (fields.newApiUrl!==undefined || fields.newApiKey!==undefined)){
    pairs.push({ baseurl:fields.newApiUrl, apikey:fields.newApiKey });
  }
  return pairs;
}
function collectQuickImportPairs(root){
  const queue=[{ value:root, depth:0 }];
  const seen=new Set();
  const pairs=[];
  let visited=0, cursor=0;
  while(cursor<queue.length){
    const current=queue[cursor++];
    const value=current.value;
    if(!value || typeof value!=="object" || seen.has(value)) continue;
    if(++visited > QUICK_IMPORT_MAX_OBJECTS || current.depth > QUICK_IMPORT_MAX_DEPTH) throw new Error("配置层级或条目过多");
    seen.add(value);
    if(Array.isArray(value)){
      value.forEach(item=>queue.push({ value:item, depth:current.depth+1 }));
      continue;
    }
    const fields=createQuickImportFields();
    Object.entries(value).forEach(([key,item])=>{
      setQuickImportField(fields,key,item);
    });
    pairs.push(...quickImportPairsFromFields(fields));
    Object.values(value).forEach(item=>{
      if(item && typeof item==="object") queue.push({ value:item, depth:current.depth+1 });
    });
  }
  return pairs;
}
// 跳过空白和代码注释。完整 JSON 不允许注释；这里跳过它们是为了防止截断配置片段中的
// 注释文本被当成真实字段，而不是为了把 JavaScript 当作配置执行。
function skipQuickImportTrivia(input, start){
  let cursor=start;
  while(cursor<input.length){
    while(cursor<input.length && /\s/.test(input[cursor])) cursor++;
    if(input.startsWith("//",cursor)){
      const end=input.indexOf("\n",cursor+2);
      cursor=end===-1 ? input.length : end+1;
      continue;
    }
    if(input.startsWith("/*",cursor)){
      const end=input.indexOf("*/",cursor+2);
      cursor=end===-1 ? input.length : end+2;
      continue;
    }
    break;
  }
  return cursor;
}
// 仅读取一个完整的 JSON 双引号字符串；JSON.parse 只用于解码字符串转义，不会执行内容。
function readQuickImportString(input, start){
  if(input[start]!=="\"") return null;
  let cursor=start+1;
  while(cursor<input.length){
    const char=input[cursor++];
    if(char==="\\"){
      if(cursor>=input.length) return { value:null, end:input.length };
      cursor++;
      continue;
    }
    if(char==="\""){
      let value=null;
      try{ value=JSON.parse(input.slice(start,cursor)); }catch(e){}
      return { value, end:cursor };
    }
    // 未转义换行不属于 JSON 字符串；从换行后继续扫描，避免异常片段卡住页面。
    if(char==="\n" || char==="\r") return { value:null, end:cursor };
  }
  return { value:null, end:input.length };
}
// 容错扫描器：为被截断的对象建立“虚拟根对象”，但每遇到 { / } 都严格切换作用域。
// 因而只会返回同一直接对象中的 legacy 或 NewAPI 连接字段；截断掉外层花括号的常见粘贴仍可识别。
function collectQuickImportFragmentPairs(input){
  const root=createQuickImportFields();
  const frames=[root];
  const stack=[root];
  let objectCount=1, cursor=0;
  while(cursor<input.length){
    cursor=skipQuickImportTrivia(input,cursor);
    if(cursor>=input.length) break;
    const char=input[cursor];
    if(char==="{"){
      if(++objectCount>QUICK_IMPORT_MAX_OBJECTS || stack.length>=QUICK_IMPORT_MAX_DEPTH+1){
        throw new Error("配置层级或条目过多");
      }
      const frame=createQuickImportFields();
      frames.push(frame); stack.push(frame); cursor++;
      continue;
    }
    if(char==="}"){
      if(stack.length>1) stack.pop();
      else {
        // 片段可能从某对象内部开始。遇到无法配对的 } 时，不能继续用同一个虚拟根，
        // 否则会把该对象前后的字段误认为同一组配置。
        const boundary=createQuickImportFields();
        frames.push(boundary); stack[0]=boundary;
      }
      cursor++;
      continue;
    }
    if(char!=="\""){ cursor++; continue; }
    const keyToken=readQuickImportString(input,cursor);
    if(!keyToken || keyToken.end<=cursor) break;
    cursor=keyToken.end;
    if(typeof keyToken.value!=="string") continue;
    const colon=skipQuickImportTrivia(input,cursor);
    if(input[colon]!==":") continue;
    const field=quickImportFieldName(keyToken.value);
    if(field!=="baseurl" && field!=="apikey" && keyToken.value!=="_type" && field!=="url" && field!=="key") continue;
    const valueStart=skipQuickImportTrivia(input,colon+1);
    if(input[valueStart]!=="\"") continue;
    const valueToken=readQuickImportString(input,valueStart);
    if(!valueToken || valueToken.end<=valueStart) break;
    cursor=valueToken.end;
    if(typeof valueToken.value==="string") setQuickImportField(stack[stack.length-1],keyToken.value,valueToken.value);
  }
  return frames.flatMap(quickImportPairsFromFields);
}
function parseQuickImportConfig(raw){
  const input=prepareQuickImportInput(raw);
  let pairs;
  try{
    // 完整 JSON 优先走严格解析，能正确处理数组、转义字段名等所有标准 JSON 情况。
    pairs=collectQuickImportPairs(parseQuickImportJson(input));
  }catch(error){
    // 用户可能只粘贴了 provider/options 的某一段，甚至在对象尚未闭合处截断。
    pairs=collectQuickImportFragmentPairs(input);
  }
  if(!pairs.some(pair=>pair.baseurl !== undefined && pair.apikey !== undefined)){
    throw new Error("未识别到同一配置对象内的 baseURL + apiKey，或 NewAPI 通道连接（_type + url + key）");
  }
  const configs=[];
  pairs.forEach(pair=>{
    if(typeof pair.baseurl!=="string" || typeof pair.apikey!=="string") return;
    const rawBaseurl=pair.baseurl.trim();
    const rawApiKey=pair.apikey.trim();
    if(!rawBaseurl || rawBaseurl.length>2048 || !rawApiKey || rawApiKey.length>2048) return;
    const baseurl=normalizeBaseUrl(rawBaseurl);
    const apikey=normalizeApiKey(rawApiKey);
    if(baseurl && apikey) configs.push({ baseurl, apikey });
  });
  if(!configs.length) throw new Error("Base URL 或 API Key 格式无效");
  const unique=new Map();
  configs.forEach(config=>unique.set(config.baseurl+"\u0000"+config.apikey,config));
  if(unique.size>1) throw new Error("检测到多组站点配置，请一次只粘贴一个");
  const config=[...unique.values()][0];
  return { ...config, name:stationNameFromBaseUrl(config.baseurl) };
}

// 轻量 toast 提示，3.2s 后自动淡出移除
function toast(msg, type){
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + (type||"");
  const icon = type==="ok" ? "✓" : type==="err" ? "✕" : type==="warn" ? "!" : "ℹ";
  el.innerHTML = `<span class="ti">${icon}</span><span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transform="translateX(20px)"; setTimeout(()=>el.remove(),200); }, 3200);
}

/* ---------------- 网络层 ---------------- */
function stationRevision(id){ return stationRevisions.get(id) || 0; }
function isCurrentStation(id, revision){ return !!getById(id) && stationRevision(id) === revision; }
function invalidateStation(id){
  stationRevisions.set(id, stationRevision(id) + 1);
  modelDisplaySnapshots.delete(id);
  const timer=batchRefreshTimers.get(id);
  if(timer){ clearTimeout(timer); batchRefreshTimers.delete(id); }
  // 请求通道变更后，旧响应会因 revision 失效；同步撤销纯运行时的 testing 标记，
  // 防止已失效请求把模型永久留在“测试中”并锁死后续操作。
  const station=getById(id);
  if(station){
    station.models.forEach(model=>{
      if(model.test!=="testing") return;
      model.test="idle";
      model.latency=null;
      model.err=null;
    });
  }
}
function scheduleRender(){
  // 拖拽中不替换列表/网格 DOM；网络请求可继续完成，结果在落下后一次性呈现。
  if(activeDrag){ renderAfterDrag=true; return; }
  if(scheduledRenderHandle !== null) return;
  // 异步状态只应更新内容，不应由旧模型锚点重新计算内部滚动位置。
  // 对于模型测试，这能确保点击闪电后当前可见 Grid 保持原地。
  const commit=()=>{ scheduledRenderHandle=null; render({ preserveModelAnchors:false }); };
  scheduledRenderHandle=typeof requestAnimationFrame === "function" ? requestAnimationFrame(commit) : setTimeout(commit,0);
}
function isConnectivityRunning(id){
  const entry = connectivityRequests.get(id);
  return !!entry && entry.revision === stationRevision(id);
}
function isBatchRunning(id){ return runningBatches.get(id) === stationRevision(id); }
function manualModelTestEntry(id, revision, create=false){
  const current=manualModelTests.get(id);
  if(current && current.revision===revision) return current;
  if(!create || !isCurrentStation(id, revision)) return null;
  const entry={ revision, models:new Set() };
  manualModelTests.set(id, entry);
  return entry;
}
function isManualModelTestRunning(id, modelId=null){
  const entry=manualModelTests.get(id);
  if(!entry || entry.revision!==stationRevision(id)) return false;
  return modelId == null ? entry.models.size>0 : entry.models.has(modelId);
}
function manualModelTestCount(id){
  const entry=manualModelTests.get(id);
  return entry && entry.revision===stationRevision(id) ? entry.models.size : 0;
}
// 手动模型测试在首个 await 前只占用当前模型；不同模型可以并行测试，批量测试仍保持站点级互斥。
function claimManualModelTest(id, modelId, revision){
  if(!isCurrentStation(id, revision) || isManualModelTestRunning(id, modelId)) return false;
  const entry=manualModelTestEntry(id, revision, true);
  // 运行时也强制并发上限，避免同一帧快速点多个模型绕过 disabled 状态。
  if(!entry || entry.models.has(modelId) || entry.models.size >= settings.concurrency) return false;
  entry.models.add(modelId);
  scheduleRender();
  return true;
}
function releaseManualModelTest(id, modelId, revision){
  const entry=manualModelTests.get(id);
  if(!entry || entry.revision!==revision) return;
  entry.models.delete(modelId);
  if(!entry.models.size) manualModelTests.delete(id);
  scheduleRender();
}
function isRequestRunning(requests, id){
  const entry = requests.get(id);
  return !!entry && entry.revision === stationRevision(id);
}
function getStationActivity(st){
  if(!st) return { connection:false, balance:false, modelList:false, batch:false, modelTesting:false, modelWork:false, any:false };
  const connection=isConnectivityRunning(st.id);
  const balance=isRequestRunning(balanceRequests, st.id);
  const modelList=isRequestRunning(modelListRequests, st.id);
  const batch=isBatchRunning(st.id);
  const modelTesting=isManualModelTestRunning(st.id) || st.models.some(model=>model.test==="testing");
  const modelWork=modelList || batch || modelTesting;
  return { connection, balance, modelList, batch, modelTesting, modelWork, any:connection || balance || modelWork };
}
function hasConnectivityConflict(st){
  const activity=getStationActivity(st);
  return activity.balance || activity.modelWork;
}
function runStationRequest(requests, id, revision, work){
  const active = requests.get(id);
  if(active && active.revision === revision) return active.promise;
  const promise = Promise.resolve().then(work);
  const entry = { revision, promise };
  requests.set(id, entry);
  scheduleRender();
  const clear = ()=>{
    if(requests.get(id) === entry){ requests.delete(id); scheduleRender(); }
  };
  promise.then(clear, clear);
  return promise;
}
function persistModelProgress(id, revision){
  if(!isCurrentStation(id, revision)) return;
  if(!isBatchRunning(id)){ save(); scheduleRender(); return; }
  if(batchRefreshTimers.has(id)) return;
  const timer=setTimeout(()=>{
    batchRefreshTimers.delete(id);
    if(isCurrentStation(id, revision)){ save(); scheduleRender(); }
  },100);
  batchRefreshTimers.set(id,timer);
}
function flushModelProgress(id, revision){
  const timer=batchRefreshTimers.get(id);
  if(timer){ clearTimeout(timer); batchRefreshTimers.delete(id); }
  if(isCurrentStation(id, revision)){ save(); scheduleRender(); }
}
function redactSensitiveText(value, apikey="", max=500){
  let message=text(value,max);
  const key=normalizeApiKey(apikey);
  if(key) message=message.split(key).join("[已隐藏 API Key]");
  // 上游偶尔会把请求头写进错误正文；界面和本地存储都不应保留这些值。
  message=message
    .replace(/((?:authorization|x[_-]?api[_-]?key|api[_-]?key|bearer|(?:access|refresh|id|auth)?[_-]?token|(?:client|api)?[_-]?secret|password|passwd|credential|cookie|set[_-]?cookie|session|private[_-]?key)\s*["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s,;"'}`\]]+/gi,"$1[已隐藏]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]{8,}/gi,"Bearer [已隐藏]");
  return message;
}
// 原始余额响应仅用于排查字段兼容性，绝不应把上游意外返回的凭据持久化或回显。
// 这些限制同时避免恶意站点用超深/超大 JSON 拖慢保存、导出或详情渲染。
const BALANCE_RAW_MAX_DEPTH=8;
const BALANCE_RAW_MAX_ITEMS=600;
const BALANCE_RAW_MAX_BRANCH_ITEMS=120;
const BALANCE_RAW_MAX_STRING=2048;
const SENSITIVE_BALANCE_FIELD=/(?:^|[-_])(?:x[-_]?api[-_]?key|api[-_]?key|authorization|bearer|(?:access|refresh|id|auth)?[-_]?token|(?:client|api)?[-_]?secret|password|passwd|credential|cookie|set[-_]?cookie|session|private[-_]?key)(?:$|[-_])/i;
function isSensitiveBalanceField(field){ return SENSITIVE_BALANCE_FIELD.test(text(field,160)); }
function sanitizeBalanceRaw(raw, apikey=""){
  const seen=new WeakSet();
  let itemCount=0;
  const limit=(reason)=>"[已截断："+reason+"]";
  const walk=(value, depth, field="")=>{
    if(isSensitiveBalanceField(field)) return "[已隐藏]";
    if(itemCount >= BALANCE_RAW_MAX_ITEMS) return limit("响应项过多");
    itemCount++;
    if(typeof value === "string") return redactSensitiveText(value,apikey,BALANCE_RAW_MAX_STRING);
    if(value === null || typeof value === "boolean") return value;
    if(typeof value === "number") return Number.isFinite(value) ? value : null;
    if(typeof value !== "object") return "[已省略：不支持的响应值]";
    if(depth >= BALANCE_RAW_MAX_DEPTH) return limit("嵌套过深");
    if(seen.has(value)) return limit("循环引用");
    seen.add(value);
    if(Array.isArray(value)){
      const output=[];
      const length=Math.min(value.length,BALANCE_RAW_MAX_BRANCH_ITEMS);
      for(let index=0; index<length; index++){
        if(itemCount >= BALANCE_RAW_MAX_ITEMS){ output.push(limit("响应项过多")); return output; }
        output.push(walk(value[index],depth+1));
      }
      if(value.length > length) output.push(limit("数组项过多"));
      return output;
    }
    // 使用无原型对象，避免导入的 __proto__ 字段影响清洗副本。
    const output=Object.create(null);
    let branchItems=0;
    for(const key in value){
      if(!Object.prototype.hasOwnProperty.call(value,key)) continue;
      if(branchItems >= BALANCE_RAW_MAX_BRANCH_ITEMS || itemCount >= BALANCE_RAW_MAX_ITEMS){
        output["[已截断]"]=limit("对象字段过多");
        break;
      }
      const safeKey=text(key,160) || "[空字段]";
      try{ output[safeKey]=walk(value[key],depth+1,key); }
      catch(_){ output[safeKey]="[已省略：字段读取失败]"; }
      branchItems++;
    }
    return output;
  };
  return walk(raw,0);
}
function networkErrorMessage(error, apikey=""){
  if(error && error.message === "请求超时") return "请求超时";
  if(error && error.aiHubRelayUnavailable) return redactSensitiveText(error.message,apikey);
  if(error instanceof TypeError) return "网络不可达或被 CORS 拦截";
  return redactSensitiveText(error && error.message,apikey) || "请求失败";
}
function isCrossOriginHttpUrl(url){
  try{
    const target=new URL(url, location.href);
    return /^https?:$/.test(target.protocol) && target.origin !== location.origin;
  }catch(e){ return false; }
}
function localProxyUrl(target){ return LOCAL_PROXY_PATH+"?url="+encodeURIComponent(target); }
function responseTransport(response){ return responseTransports.get(response) || (settings.proxy ? "custom" : "direct"); }
function rememberRequestTransport(st, response){
  const transport=responseTransport(response);
  if(st && st.status && ["direct","builtin","custom"].includes(transport)) st.status.transport=transport;
  return transport;
}
function localRelayUnavailableError(){
  const error=new Error("浏览器直连失败（可能被 CORS 拦截），且当前页面没有可用的本地同源转发。请通过 server.mjs 启动本面板后从 http://127.0.0.1:4179 打开，或在设置中配置可信代理。");
  error.aiHubRelayUnavailable=true;
  return error;
}
async function checkLocalProxy(){
  const now=Date.now();
  if(localProxySupport === true) return true;
  if(localProxySupport === false && now-localProxyLastCheckedAt < LOCAL_PROXY_RECHECK_MS) return false;
  if(localProxyProbe) return localProxyProbe;
  // 探测不携带站点地址、API Key 或 Cookie；以签名和 JSON 双重确认，防止把任意同源路径误认为中转。
  localProxyProbe=(async()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),1500);
    try{
      const response=await fetch(LOCAL_PROXY_HEALTH_PATH,{ cache:"no-store", signal:controller.signal });
      const signature=response.headers.get("x-aihub-proxy") === "1";
      let data=null;
      try{ data=await response.json(); }catch(e){}
      localProxySupport=!!(response.ok && signature && data && data.proxy === true && data.version === 1);
    }catch(e){
      localProxySupport=false;
    }finally{
      clearTimeout(timer);
      localProxyLastCheckedAt=Date.now();
    }
    return localProxySupport;
  })();
  try{ return await localProxyProbe; }
  finally{ localProxyProbe=null; }
}
async function fetchWithTimeout(url, options={}, timeoutSeconds=settings.timeout){
  const controller = new AbortController();
  const seconds=clampInt(timeoutSeconds, 1, 120, settings.timeout);
  const timer = setTimeout(()=>controller.abort(), seconds * 1000);
  try{
    let response;
    let transport=settings.proxy ? "custom" : "direct";
    try{
      // 先走浏览器的原生网络路径（包括用户自己的系统代理/VPN）；绝不让本地 Node 先行接管。
      response = await fetch(url, { ...options, signal:controller.signal });
    }catch(directError){
      if(controller.signal.aborted) throw new Error("请求超时");
      const canUseLocalRelay=!settings.proxy && isCrossOriginHttpUrl(url) && isCorsLikeError(directError);
      if(!canUseLocalRelay) throw directError;
      if(!(await checkLocalProxy())) throw localRelayUnavailableError();
      try{
        response=await fetch(localProxyUrl(url), { ...options, signal:controller.signal });
      }catch(relayError){
        if(controller.signal.aborted) throw new Error("请求超时");
        throw localRelayUnavailableError();
      }
      // 带签名的 4xx/5xx 是目标或中转的真实结果，必须交给调用方展示；不能再直连覆盖它。
      if(response.headers.get("x-aihub-proxy") !== "1"){
        try{ await response.body?.cancel(); }catch(e){}
        localProxySupport=false;
        localProxyLastCheckedAt=Date.now();
        throw localRelayUnavailableError();
      }
      transport="builtin";
    }
    responseTransports.set(response,transport);
    responseTimeouts.set(response, { controller, timer });
    return response;
  }
  catch(error){
    // 网络错误发生在拿到 Response 之前，没有 finishResponse 可调用；及时清理计时器，
    // 避免一次失败请求在页面后台继续占用定时器直到原超时期限。
    clearTimeout(timer);
    if(controller.signal.aborted) throw new Error("请求超时");
    throw error;
  }
}
function finishResponse(response){
  const state = responseTimeouts.get(response);
  if(state){ clearTimeout(state.timer); responseTimeouts.delete(response); }
}
async function responseData(response){
  const state = responseTimeouts.get(response);
  try{
    const raw = await response.text();
    if(!raw.trim()) return null;
    try{ return JSON.parse(raw); }catch(e){ return raw; }
  }catch(error){
    if(state && state.controller.signal.aborted) throw new Error("请求超时");
    throw error;
  }finally{ finishResponse(response); }
}
// 流式读取：responseData 用 response.text() 一次读完，测不出首字延迟，也无法在超长响应中途停手。
// 这里增量解析 SSE，回调每个 delta，并把首字时间点交还调用方。
// 与 responseData 一样在所有出口调用 finishResponse，避免 AbortController 计时器泄漏。
async function readSseStream(response, onDelta){
  const state = responseTimeouts.get(response);
  const aborted = ()=>!!(state && state.controller.signal.aborted);
  const reader = response.body && typeof response.body.getReader === "function" ? response.body.getReader() : null;
  if(!reader){ finishResponse(response); throw new Error("当前环境不支持流式读取"); }
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let chunks = 0;
  let ttft = null;
  let done = false;
  const started = performance.now();
  const handleEvent = payload=>{
    if(payload === "[DONE]"){ done = true; return; }
    let parsed;
    try{ parsed = JSON.parse(payload); }catch(e){ return; }
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const delta = choice && choice.delta && typeof choice.delta === "object" ? choice.delta : null;
    const piece = delta && typeof delta.content === "string" ? delta.content : "";
    if(piece){
      chunks++;
      if(ttft === null) ttft = performance.now()-started;
      if(typeof onDelta === "function") onDelta(piece);
    }
  };
  try{
    while(true){
      const step = await reader.read();
      if(step.done) break;
      bytes += step.value ? step.value.length : 0;
      if(bytes > STREAM_PROBE_MAX_BYTES){ done = true; break; }
      buffer += decoder.decode(step.value, { stream:true });
      // SSE 事件以空行分隔；只取 data: 行，忽略注释与其它字段。
      let boundary;
      while((boundary = buffer.indexOf("\n\n")) !== -1){
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary+2);
        block.split("\n").forEach(line=>{
          const trimmed = line.trim();
          if(trimmed.startsWith("data:")) handleEvent(trimmed.slice(5).trim());
        });
      }
      if(done) break;
    }
    // 部分上游最后一个事件不带结尾空行；补一次解析，避免漏掉整段回答。
    if(!done && buffer.trim()){
      buffer.split("\n").forEach(line=>{
        const trimmed = line.trim();
        if(trimmed.startsWith("data:")) handleEvent(trimmed.slice(5).trim());
      });
    }
    return { chunks, ttft, done, total:performance.now()-started };
  }catch(error){
    if(aborted()) throw new Error("请求超时");
    throw error;
  }finally{
    try{ await reader.cancel(); }catch(e){}
    finishResponse(response);
  }
}
function localProxyHint(code){
  const hints={
    blocked_target:"内置转发只允许公网 HTTP(S) 地址；内网地址请让站点开启 CORS，或在设置中使用你信任的内网代理。",
    dns_failed:"本机无法解析该站点域名，请检查 Base URL、DNS 或网络。",
    upstream_unavailable:"本地转发已工作，但无法连接目标服务；请检查目标站是否可用、域名是否正确或本机出网限制。",
    upstream_timeout:"本地转发已连接目标，但上游响应超时；可稍后重试或在设置中提高超时。",
    upstream_redirect_not_supported:"目标站返回了重定向。为避免 API Key 被转发到其它域名，请把 Base URL 改为最终的 HTTPS API 地址后重试。",
    invalid_redirect:"目标服务给出了无效的重定向地址，请检查 Base URL 是否填写为该站点的 API 根地址。",
    too_many_redirects:"目标服务重定向次数过多，请检查 Base URL 是否存在循环跳转。",
    same_origin_required:"内置转发只能由当前面板页面调用，请通过本面板打开后重试。",
    body_too_large:"请求体超过内置转发允许的大小。",
    upstream_response_too_large:"上游响应超过 50 MiB 限制，请缩小请求范围或改用支持分页的接口。"
  };
  return hints[code] || "本地同源转发返回了错误。";
}
async function responseError(response, apikey=""){
  let message = "HTTP " + response.status + (response.statusText ? " " + response.statusText : "");
  try{
    const data = await responseData(response);
    const detail = data && typeof data === "object" ? (data.error && data.error.message) || data.message || data.detail : "";
    const code=data && typeof data === "object" && data.error && typeof data.error === "object" ? text(data.error.code,80) : "";
    if(responseTransport(response)==="builtin"){
      const prefix=detail ? "本地同源转发："+text(detail,220) : "本地同源转发请求失败";
      message += "："+prefix+"。"+localProxyHint(code);
    }else if(detail) message += "：" + text(detail,300);
  }catch(e){}
  return redactSensitiveText(message,apikey);
}
async function discardResponse(response){
  try{ await response.body?.cancel(); }catch(e){}
  finishResponse(response);
}
function stationAuthHeaders(st, mode, originalHeaders={}){
  const headers={ ...originalHeaders };
  Object.keys(headers).forEach(key=>{
    if(key.toLowerCase()==="authorization" || key.toLowerCase()==="x-api-key") delete headers[key];
  });
  if(mode === "x-api-key") headers["x-api-key"]=st.apikey;
  else headers.Authorization="Bearer "+st.apikey;
  return headers;
}
// OpenAI 兼容通常是 Bearer，但一部分 Sub2API/New API 衍生网关仅接受 x-api-key。
// 只在明确的认证失败（401/403）后切换一次，避免重复非幂等请求或掩盖其它真实错误。
async function fetchStationApi(st, url, options={}, timeoutSeconds=settings.timeout){
  const preferred=st && st.status && st.status.authMode === "x-api-key" ? "x-api-key" : "bearer";
  const alternate=preferred === "bearer" ? "x-api-key" : "bearer";
  const { allowAuthRetry: requestedAuthRetry, ...requestOptions } = options || {};
  const method=String(requestOptions.method || "GET").toUpperCase();
  // GET/HEAD 可安全地切换认证头；POST 等请求可能产生计费或副作用，禁止自动重发。
  const allowAuthRetry=requestedAuthRetry === true || (requestedAuthRetry !== false && ["GET","HEAD"].includes(method));
  const request=mode=>fetchWithTimeout(url,{ ...requestOptions, headers:stationAuthHeaders(st,mode,requestOptions.headers || {}) },timeoutSeconds);
  let response=await request(preferred);
  if(response.ok){
    if(st && st.status) st.status.authMode=preferred;
    return response;
  }
  if(!allowAuthRetry || (response.status!==401 && response.status!==403)) return response;
  await discardResponse(response);
  response=await request(alternate);
  if(response.ok && st && st.status) st.status.authMode=alternate;
  return response;
}

// 诊断候选接口：不同中转站对 /v1/models 的权限并不一致。
// 先尝试带凭据的 OpenAI 目录/用量接口，再尝试 New API 的根路径状态接口；
// 这些探测只用于显示诊断，不会作为模型、余额请求的前置许可。
function connectivityCandidates(st){
  const candidates=[
    { path:"/v1/models", source:"OpenAI 模型目录", root:false, requiresAuth:true },
    { path:"/v1/usage", source:"Sub2API 用量接口", root:false, requiresAuth:true },
    { path:"/api/status", source:"New API 状态接口", root:true, requiresAuth:false },
    { path:"/api/usage/token", source:"New API 用量接口", root:true, requiresAuth:true }
  ];
  const seen=new Set();
  return candidates.map(candidate=>{
    const rawUrl=candidate.root ? rootApiUrl(st.baseurl,candidate.path) : apiUrl(st.baseurl,candidate.path);
    return { ...candidate, rawUrl, url:buildUrl(rawUrl) };
  }).filter(candidate=>candidate.url && !seen.has(candidate.url) && seen.add(candidate.url));
}

function isCorsLikeError(error){
  // Chromium/Firefox 对 CORS 预检失败通常只暴露 TypeError("Failed to fetch")，
  // 不要依赖具体英文文案；TypeError 也覆盖浏览器拦截的 opaque 读取错误。
  return error instanceof TypeError || /cors|跨域|failed to fetch|networkerror/i.test(String(error && error.message || error || ""));
}

// 不带自定义头的 no-cors GET 只能确认网络可达，不能读取 HTTP 状态或响应正文。
// 仅在认证请求被浏览器 CORS 拦截后调用，避免把无效 API Key 误判为已验证。
async function probeOpaqueReachability(url){
  const started=performance.now();
  try{
    const response=await fetchWithTimeout(url,{ method:"GET", mode:"no-cors", cache:"no-store" },Math.min(settings.timeout,8));
    const latency=performance.now()-started;
    const opaque=response.type === "opaque";
    const ok=opaque || response.ok;
    finishResponse(response);
    return { ok, opaque, latency };
  }catch(error){
    return { ok:false, error };
  }
}

function connectivityHeaders(st, mode){
  if(mode === "x-api-key") return { "x-api-key":st.apikey };
  return { "Authorization":"Bearer "+st.apikey };
}

// 连通性测试 + RTT：这是单独的诊断请求，而不是模型操作的前置许可。
// /v1/models 的权限、网关或 CORS 策略可能与实际推理接口不同；因此诊断失败仅记录结果，
// 不会阻止之后的模型列表获取、模型测试或批量测试。
function testConnectivity(id){
  const revision = stationRevision(id);
  const station=getById(id); if(!station) return Promise.resolve({ ok:false });
  const active = connectivityRequests.get(id);
  if(active && active.revision === revision) return active.promise;
  if(!hasStationCredentials(station)){
    toast("请先通过编辑或快速导入填写 Base URL 和 API Key", "warn");
    return Promise.resolve({ ok:false, missingConfig:true });
  }
  if(hasConnectivityConflict(station)){
    toast("该站点已有请求进行中，请完成后再检测连通性", "warn");
    return Promise.resolve({ ok:false, busy:true });
  }
  const promise = Promise.resolve().then(async()=>{
    const st = getById(id); if(!st) return { ok:false };
    setConn(id, "testing", null, null, revision);
    const started = performance.now();
    const errors=[];
    let corsBlocked=false;
    let hardFailure=false;
    let primaryUrl="";
    let diagnosticEndpoint="/v1/models";
    try{
      for(const candidate of connectivityCandidates(st)){
        diagnosticEndpoint=candidate.path;
        if(!primaryUrl) primaryUrl=settings.proxy ? candidate.url : candidate.rawUrl;
        // 同一站点常见两种认证头：OpenAI 标准 Bearer 和部分网关的 x-api-key。
        // 仅在 Bearer 得到 401/403 时尝试第二种，避免无意义地重复请求。
        const modes=candidate.requiresAuth ? ["bearer","x-api-key"] : [null];
        for(const mode of modes){
          let response;
          try{
            response=await fetchWithTimeout(candidate.url, {
              method:"GET",
              headers:mode ? connectivityHeaders(st,mode) : {}
            });
            if(!isCurrentStation(id, revision)){ finishResponse(response); return { ok:false, stale:true }; }
              if(response.ok){
               const latency=performance.now()-started;
               const transport=responseTransport(response);
               await discardResponse(response);
              if(mode && st.status) st.status.authMode=mode;
              const state=candidate.requiresAuth ? "online" : "reachable";
              const routeNote=transport === "builtin" ? "已通过本地同源转发完成请求" : transport === "custom" ? "已通过自定义代理完成请求" : null;
              const note=candidate.requiresAuth ? routeNote : ["服务状态接口可达，尚未验证模型 API Key",routeNote].filter(Boolean).join("；");
              setConn(id, state, latency, note, revision, transport, diagnosticEndpoint);
              toast(candidate.source+"可用（"+Math.round(latency)+"ms）"+(transport === "builtin" ? "，已自动使用本地同源转发" : ""), candidate.requiresAuth ? "ok" : "warn");
              return { ok:true, latency, state, source:candidate.source, transport };
            }
            const status=response.status;
            const transport=responseTransport(response);
            const message=await responseError(response,st.apikey);
            errors.push(candidate.path+"："+message);
            if(transport === "builtin" && (status===502 || status===504)) hardFailure=true;
            if(!(mode === "bearer" && candidate.requiresAuth && (response.status===401 || response.status===403))) break;
          }catch(error){
            if(!isCurrentStation(id, revision)) return { ok:false, stale:true };
            if(error && error.aiHubRelayUnavailable){
              errors.push(candidate.path+"："+networkErrorMessage(error,st.apikey));
              hardFailure=true;
              break;
            }
            if(isCorsLikeError(error)){
              corsBlocked=true;
              break;
            }
            errors.push(candidate.path+"："+networkErrorMessage(error,st.apikey));
            if(error && error.message === "请求超时") hardFailure=true;
            break;
          }
        }
        // CORS 预检失败后，同源策略会让同一站点的其它候选接口得到相同结果；
        // 立即转入一次无凭据可达性探测，避免用户等待多轮无效超时。
        if(corsBlocked || hardFailure) break;
      }

      if(corsBlocked && primaryUrl){
        const reachability=await probeOpaqueReachability(primaryUrl);
        if(!isCurrentStation(id, revision)) return { ok:false, stale:true };
        if(reachability.ok){
          const latency=reachability.latency;
          const note="服务可达，但浏览器阻止读取认证响应（CORS）；已确认网络可达，若模型请求也被拦截，请在设置中配置可信请求代理";
          setConn(id, "reachable", latency, note, revision, null, diagnosticEndpoint);
          toast("服务可达，但浏览器跨域限制了认证响应", "warn");
          return { ok:true, reachable:true, cors:true, latency };
        }
        if(reachability.error) errors.push("跨域探测："+networkErrorMessage(reachability.error,st.apikey));
      }
      if(!isCurrentStation(id, revision)) return { ok:false, stale:true };
      const message=errors.length ? errors.slice(-4).join("；") : (corsBlocked ? "浏览器跨域限制，无法读取认证响应" : "未找到可用诊断接口");
      setConn(id, "offline", null, message, revision, null, diagnosticEndpoint);
      return { ok:false, error:message };
    }catch(error){
      if(!isCurrentStation(id, revision)) return { ok:false, stale:true };
      const message=networkErrorMessage(error,st.apikey);
      setConn(id, "offline", null, message, revision, null, diagnosticEndpoint);
      return { ok:false, error:message };
    }
  });
  const entry = { revision, promise };
  connectivityRequests.set(id, entry);
  promise.then(
    ()=>{ if(connectivityRequests.get(id) === entry){ connectivityRequests.delete(id); scheduleRender(); } },
    ()=>{ if(connectivityRequests.get(id) === entry){ connectivityRequests.delete(id); scheduleRender(); } }
  );
  return promise;
}

// 状态写入 + 持久化 + 重渲染。revision 防止编辑/删除后旧请求覆盖新配置。
function setConn(id, state, latency, error, revision, transport=null, endpoint="/v1/models"){
  if(revision != null && !isCurrentStation(id, revision)) return false;
  const st = getById(id); if(!st) return false;
  st.status.connectivity = CONNECTIVITY_STATES.has(state) ? state : "unknown";
  if(state === "testing"){
    st.status.latency = null; st.status.error = null; st.status.transport=null;
  }else if(state === "online"){
    st.status.latency = Number.isFinite(latency) ? latency : null;
    st.status.error = text(error,500) || null; st.status.lastTest = Date.now();
    st.status.transport=["direct","builtin","custom"].includes(transport) ? transport : null;
  }else if(state === "reachable"){
    st.status.latency = Number.isFinite(latency) ? latency : null;
    st.status.error = text(error,500) || "服务可达，但认证响应受浏览器跨域限制";
    st.status.lastTest = Date.now();
    st.status.transport=["direct","builtin","custom"].includes(transport) ? transport : null;
  }else if(state === "offline"){
    st.status.latency = null;
    st.status.error = text(error,500) || "连接失败"; st.status.transport=null;
    st.status.lastTest = Date.now();
  }
  appendRequestLog(st,{
    level:state === "offline" ? "error" : state === "testing" ? "info" : "ok",
    kind:"连通诊断",
    method:"GET",
    endpoint:text(endpoint,240) || "/v1/models",
    latency,
    transport:st.status.transport || transport,
    message:state === "testing" ? "开始诊断" : error || (state === "online" ? "诊断通过" : state === "reachable" ? "服务可达" : "连接失败")
  });
  save(); scheduleRender();
  return true;
}

// 获取余额：留空时自动探测 OpenAI 兼容、New API、Sub2API；填写自定义路径时只请求该路径。
// 余额管理接口与 /v1/models 的权限、CORS 策略可能不同，因此不能把模型连通性作为余额请求的前置条件。
function fetchBalance(id){
  const station=getById(id);
  if(!hasStationCredentials(station)){
    toast("请先通过编辑或快速导入填写 Base URL 和 API Key", "warn");
    return Promise.resolve();
  }
  const revision = stationRevision(id);
  if(!station) return Promise.resolve();
  return runStationRequest(balanceRequests, id, revision, ()=>fetchBalanceRequest(id, revision));
}

function balanceCandidates(st){
  if(st.balancePath){
    return [{
      path:st.balancePath,
      source:"自定义接口",
      parser:"generic",
      root:/^\/api\//i.test(st.balancePath)
    }];
  }
  return DEFAULT_BALANCE_ENDPOINTS;
}
function balanceEndpointUrl(st, candidate){
  return candidate.root || /^\/api\//i.test(candidate.path)
    ? rootApiUrl(st.baseurl, candidate.path)
    : apiUrl(st.baseurl, candidate.path);
}

async function fetchBalanceRequest(id, revision){
  const st = getById(id); if(!st) return;
  const errors=[];
  let lastReturned=null;
  let lastCandidatePath="";
  for(const candidate of balanceCandidates(st)){
    lastCandidatePath=candidate.path;
    let response;
    try{
      response = await fetchStationApi(st, buildUrl(balanceEndpointUrl(st, candidate)));
      if(!isCurrentStation(id, revision)){ finishResponse(response); return; }
      const transport=rememberRequestTransport(st,response);
      if(!response.ok){
        errors.push(candidate.path + "：" + await responseError(response,st.apikey));
        continue;
      }
      const data = await responseData(response);
      if(!isCurrentStation(id, revision)) return;
      const result = await extractBalanceForCandidate(data, candidate, st, revision);
      if(!isCurrentStation(id, revision)) return;
      if(result){
        setBalanceResult(st, result, data, candidate);
        st.status.balanceError=null;
        appendRequestLog(st,{ level:"ok", kind:"余额查询", method:"GET", endpoint:candidate.path, latency:null, transport, message:balanceLabel(st)+"："+balanceDisplay(st) });
        save(); scheduleRender();
        toast(balanceLabel(st) + "：" + balanceDisplay(st) + "（" + candidate.source + "）" + (transport === "builtin" ? "，已通过本地同源转发" : ""), "ok");
        return;
      }
      lastReturned={ data, candidate };
      errors.push(candidate.path + "：未识别可用余额/额度字段");
    }catch(error){
      if(!isCurrentStation(id, revision)) return;
      const message = networkErrorMessage(error,st.apikey);
      errors.push(candidate.path + "：" + message);
      // 网络/CORS 与超时通常不是切换站内路径能解决的，避免连续等待三次超时。
      if(error instanceof TypeError || (error && error.aiHubRelayUnavailable) || message === "请求超时") break;
    }
  }
  if(!isCurrentStation(id, revision)) return;
  if(lastReturned){
    st.status.balance = null;
    st.status.balanceKind = "balance";
    st.status.balanceUnlimited = false;
    st.status.balanceUnit = null;
    st.status.balanceSource = lastReturned.candidate.source + " · " + lastReturned.candidate.path;
    st.status.balanceNote = null;
    st.status.balanceRaw = sanitizeBalanceRaw(lastReturned.data,st.apikey);
    st.status.balanceError=null;
    appendRequestLog(st,{ level:"warn", kind:"余额查询", method:"GET", endpoint:lastReturned.candidate.path, message:"接口已返回，但未识别可用余额字段" });
    save(); scheduleRender();
    toast("余额接口已返回，但未识别可用余额字段；可查看原始返回或填写自定义路径", "warn");
  }else{
    const message=text(errors.join("；"),500) || "未找到可用余额接口";
    st.status.balanceError=message;
    // 端点记录最后一次实际请求的候选路径；不再写死某个未必探测过的接口。
    appendRequestLog(st,{ level:"error", kind:"余额查询", method:"GET", endpoint:lastCandidatePath || "—", message });
    save(); scheduleRender();
    toast("获取余额失败：" + message, "err");
  }
}

// 从余额响应中抽取可用金额/额度：支持 data、data.user、data.token 等主流包装；不把 used_quota 误当余额。
function numberValue(value){
  if(typeof value === "number" && Number.isFinite(value)) return value;
  if(typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function readAmount(scope, keys){
  if(!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  for(const key of keys){
    const value=numberValue(scope[key]);
    if(value !== null) return value;
  }
  return null;
}
function balanceScopes(data){
  if(!data || typeof data !== "object" || Array.isArray(data)) return [];
  const base = data.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : data;
  const scopes=[];
  const push = value=>{ if(value && typeof value === "object" && !Array.isArray(value) && !scopes.includes(value)) scopes.push(value); };
  push(base); push(data);
  [base,data].forEach(scope=>{
    if(!scope || typeof scope !== "object") return;
    push(scope.user); push(scope.token); push(scope.account); push(scope.result);
    if(scope.data && typeof scope.data === "object"){
      push(scope.data); push(scope.data.user); push(scope.data.token); push(scope.data.account);
    }
  });
  return scopes;
}
function payloadData(data){
  return data && typeof data === "object" && !Array.isArray(data) && data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data : data;
}
function balanceUnit(value){
  const unit=text(value,32);
  if(!unit) return null;
  return ["usd","cny"].includes(unit.toLowerCase()) ? unit.toUpperCase() : unit;
}
function isQuotaUnit(unit){ return /^(token|tokens|quota|points?|额度|点)$/i.test(unit||""); }
function extractSub2ApiBalance(data){
  const usage=payloadData(data);
  if(!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const quota=usage.quota && typeof usage.quota === "object" ? usage.quota : null;
  let remaining=numberValue(usage.remaining);
  if(remaining === null && quota) remaining=numberValue(quota.remaining);
  if(remaining === null) remaining=numberValue(usage.balance);
  if(remaining === null) return null;
  const unit=balanceUnit(usage.unit || (quota && quota.unit));
  // Sub2API 的无限订阅会以 unrestricted + remaining:-1 表示，不能误展示为负余额。
  if(usage.mode === "unrestricted" && remaining === -1){
    return { value:null, kind:"quota", unit:unit || "额度", unlimited:true, note:"Sub2API 已标记为不限额" };
  }
  // Sub2API 的 quota_limited 是 Key 总额度，即使它以 USD 展示也应明确标为「可用额度」。
  const quotaLimited=usage.mode === "quota_limited";
  return { value:remaining, kind:quotaLimited || isQuotaUnit(unit)?"quota":"balance", unit, unlimited:false, note:null };
}
function extractNewApiBalance(data, statusData){
  const usage=payloadData(data);
  if(!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  if(usage.unlimited_quota === true){
    return { value:null, kind:"quota", unit:"额度", unlimited:true, note:"New API 已标记为无限额度" };
  }
  const raw=numberValue(usage.total_available);
  if(raw === null) return null;
  const status=payloadData(statusData);
  const quotaPerUnit=status && numberValue(status.quota_per_unit);
  // 旧版 New API 仅提供 display_in_currency；其语义等价于以 USD 展示可用额度。
  const displayType=status ? (text(status.quota_display_type,32).toUpperCase() || (status.display_in_currency === true ? "USD" : "")) : "";
  const usdRate=status && numberValue(status.usd_exchange_rate);
  const customRate=status && numberValue(status.custom_currency_exchange_rate);
  const rawNote="New API 原始额度：" + formatBalance(raw);
  if(quotaPerUnit && quotaPerUnit > 0 && displayType === "USD"){
    return { value:raw/quotaPerUnit, kind:"balance", unit:"USD", unlimited:false, note:rawNote };
  }
  if(quotaPerUnit && quotaPerUnit > 0 && displayType === "CNY" && usdRate !== null && usdRate > 0){
    return { value:raw/quotaPerUnit*usdRate, kind:"balance", unit:"CNY", unlimited:false, note:rawNote };
  }
  if(quotaPerUnit && quotaPerUnit > 0 && displayType === "CUSTOM" && customRate !== null && customRate > 0){
    return {
      value:raw/quotaPerUnit*customRate,
      kind:"balance",
      unit:balanceUnit(status.custom_currency_symbol) || "自定义货币",
      unlimited:false,
      note:rawNote
    };
  }
  // 无法取到展示配置、或站点选择 TOKENS 时，保留原始额度并明确不作为货币展示。
  return { value:raw, kind:"quota", unit:"额度", unlimited:false, note:rawNote };
}
function extractGenericBalance(data, fallbackKind="balance"){
  const moneyKeys=["total_balance","remain_balance","remaining_balance","available_balance","balance","remain","credit","available_credit"];
  const availableQuotaKeys=["remain_quota","remaining_quota","available_quota","left_quota","total_available"];
  for(const scope of balanceScopes(data)){
    const unit=balanceUnit(scope.unit || scope.currency);
    const balance=readAmount(scope, moneyKeys);
    if(balance !== null) return { value:balance, kind:isQuotaUnit(unit)?"quota":"balance", unit, unlimited:false, note:null };
    const availableQuota=readAmount(scope,availableQuotaKeys);
    if(availableQuota !== null) return { value:availableQuota, kind:"quota", unit:isQuotaUnit(unit)?unit:null, unlimited:false, note:null };
    // New API / One API 常返回 quota（总额度）+ used_quota（已用）。必须先相减，不能把总额度直接显示为可用额度。
    const total=readAmount(scope,["total_quota","quota"]);
    const used=readAmount(scope,["used_quota"]);
    if(total !== null && used !== null) return { value:total-used, kind:"quota", unit:isQuotaUnit(unit)?unit:null, unlimited:false, note:null };
    const quota=readAmount(scope,["quota"]);
    if(quota !== null) return { value:quota, kind:"quota", unit:isQuotaUnit(unit)?unit:null, unlimited:false, note:null };
  }
  return null;
}
async function fetchNewApiStatus(st, revision){
  let response;
  try{
    // 仅用于正确显示 New API 配额单位，失败不影响已拿到的余额；最多等待 5 秒。
    response=await fetchWithTimeout(buildUrl(rootApiUrl(st.baseurl,"/api/status")), {}, Math.min(settings.timeout,5));
    if(!isCurrentStation(st.id, revision)){ finishResponse(response); return null; }
    if(!response.ok){ finishResponse(response); return null; }
    return await responseData(response);
  }catch(error){ return null; }
}
async function extractBalanceForCandidate(data, candidate, st, revision){
  if(candidate.parser === "sub2api"){
    return extractSub2ApiBalance(data) || extractGenericBalance(data, "balance");
  }
  if(candidate.parser === "newapi"){
    const usage=payloadData(data);
    if(usage && typeof usage === "object" && (usage.unlimited_quota === true || Object.prototype.hasOwnProperty.call(usage,"total_available"))){
      const status=await fetchNewApiStatus(st, revision);
      return extractNewApiBalance(data, status);
    }
  }
  return extractGenericBalance(data, "balance");
}
function setBalanceResult(st, result, data, candidate){
  st.status.balance=result.unlimited ? null : result.value;
  st.status.balanceKind=BALANCE_KINDS.has(result.kind) ? result.kind : "balance";
  st.status.balanceUnlimited=result.unlimited === true;
  st.status.balanceUnit=balanceUnit(result.unit) || null;
  st.status.balanceSource=candidate.source + " · " + candidate.path;
  st.status.balanceNote=text(result.note,240) || null;
  // 余额提取已经使用过原始 data；持久化时仅保留脱敏、受限大小的诊断副本。
  st.status.balanceRaw=sanitizeBalanceRaw(data,st.apikey);
  st.status.balanceError=null;
}
function balanceLabel(st){ return st.status.balanceKind === "quota" ? "可用额度" : "可用余额"; }
function formatBalance(value){
  const amount=Number(value);
  if(!Number.isFinite(amount)) return "—";
  // 面板只展示可读精度；完整接口原始值仍保留在 status.balanceRaw 中。
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits:2 }).format(amount);
}
function hasBalance(st){ return st.status.balanceUnlimited === true || st.status.balance != null; }
function balanceDisplay(st){
  if(st.status.balanceUnlimited) return "不限额";
  const value=formatBalance(st.status.balance);
  return st.status.balanceUnit ? value + " " + st.status.balanceUnit : value;
}

// 获取模型列表：覆盖模型清单，同时保留同名模型的已有测试结果。
function fetchModels(id){
  const station=getById(id);
  if(!hasStationCredentials(station)){
    toast("请先通过编辑或快速导入填写 Base URL 和 API Key", "warn");
    return Promise.resolve();
  }
  // 仅在诊断请求实际进行时短暂互斥；此前的「诊断未通过」状态不会阻断模型操作。
  if(isConnectivityRunning(id)){
    toast("连通性诊断进行中，请完成后再获取模型列表", "warn");
    return Promise.resolve();
  }
  if(isBatchRunning(id) || isManualModelTestRunning(id) || station.models.some(model=>model.test==="testing")){
    toast("模型测试进行中，暂不能刷新模型列表", "warn");
    return Promise.resolve();
  }
  const revision = stationRevision(id);
  if(!station) return Promise.resolve();
  return runStationRequest(modelListRequests, id, revision, ()=>fetchModelsRequest(id, revision));
}
async function fetchModelsRequest(id, revision){
  const st = getById(id); if(!st) return;
  if(isBatchRunning(id)){ toast("批量测试进行中，暂不能刷新模型列表", "warn"); return; }
  if(isManualModelTestRunning(id) || st.models.some(model=>model.test==="testing")){
    toast("模型测试进行中，暂不能刷新模型列表", "warn"); return;
  }
  const requestStarted=performance.now();
  try{
    // 不读取也不修改连通性诊断状态：模型列表接口用自己的响应决定成败。
    const response = await fetchStationApi(st, buildUrl(apiUrl(st.baseurl, "/v1/models")));
    if(!isCurrentStation(id, revision)){ finishResponse(response); return; }
    const transport=rememberRequestTransport(st,response);
    if(!response.ok){
      const message=await responseError(response,st.apikey);
      appendRequestLog(st,{ level:"error", kind:"模型列表", method:"GET", endpoint:"/v1/models", status:response.status, latency:performance.now()-requestStarted, transport, message });
      st.status.modelListError=message;
      save(); scheduleRender();
      toast("获取模型失败：" + message, "err");
      return;
    }
    const data = await responseData(response);
    if(!isCurrentStation(id, revision)){ finishResponse(response); return; }
    const source = data && typeof data === "object" ? (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null) : null;
  if(!source) throw new Error("返回中未找到模型列表");
    const previous = new Map(st.models.map(model=>[model.id, model]));
    const seen = new Set();
    st.models = source.map(item=>text(typeof item === "string" ? item : item && (item.id || item.name),256))
      .filter(modelId=>modelId && !seen.has(modelId) && seen.add(modelId))
      .map(modelId=>{
        const old = previous.get(modelId);
        return {
          id:modelId,
          test:old ? old.test : "idle",
          latency:old ? old.latency : null,
          lastRequestAt:old ? old.lastRequestAt : null,
          err:old ? old.err : null,
          capability:old ? old.capability : null
        };
      });
    if(isSelectionStation(id)){
      selectedModels = new Set([...selectedModels].filter(modelId=>st.models.some(model=>model.id===modelId)));
      rememberCurrentModelSelection();
    }else if(selectedModelsByStation.has(id)){
      // 非当前站点的模型列表刷新也要清理已不存在的模型 ID。
      const valid = new Set(st.models.map(model=>model.id));
      const picked = selectedModelsByStation.get(id).filter(modelId=>valid.has(modelId));
      if(picked.length) selectedModelsByStation.set(id,picked); else selectedModelsByStation.delete(id);
      saveUIState();
    }
    modelDisplaySnapshots.delete(id);
    st.status.modelListError=null;
    appendRequestLog(st,{ level:"ok", kind:"模型列表", method:"GET", endpoint:"/v1/models", status:response.status, latency:performance.now()-requestStarted, transport, message:"获取到 "+st.models.length+" 个模型" });
    save(); scheduleRender();
    toast("获取到 " + st.models.length + " 个模型" + (transport === "builtin" ? "，已通过本地同源转发" : ""), "ok");
  }catch(error){
    if(isCurrentStation(id, revision)){
      const current=getById(id);
      const message=networkErrorMessage(error,st.apikey);
      if(current){
        appendRequestLog(current,{ level:"error", kind:"模型列表", method:"GET", endpoint:"/v1/models", latency:performance.now()-requestStarted, message });
        current.status.modelListError=message; save(); scheduleRender();
      }
      toast("获取模型失败：" + message, "err");
    }
  }
}

/* ---------------- 模型能力探针 ---------------- */
// 旧的 ping 只能证明“认证通过且路由存在”：它丢弃响应体，因此 200 空回复、
// 网关把请求静默换成便宜模型、流式坏掉、多轮上下文被吃掉都测不出来。
// 每个探针只回答一个可判定的问题，结果写入 model.capability。
// identity 复用 chat 探针的响应，不额外发请求：ping 1 次、basic 3 次、deep 6 次。
const DEPTH_PROBES = Object.freeze({
  ping:["chat"],
  basic:["chat","identity","stream","context"],
  deep:["chat","identity","stream","context","tools","json","long"]
});
const CAPABILITY_GRADE_LABELS = Object.freeze({ usable:"可用", limited:"受限", unusable:"不可用" });
function probeToken(prefix){ return prefix + "-" + Math.random().toString(36).slice(2,8).toUpperCase(); }
async function probeChat(st, payload, timeoutSeconds=settings.timeout){
  const response = await fetchStationApi(st, buildUrl(apiUrl(st.baseurl, "/v1/chat/completions")), {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  }, timeoutSeconds);
  rememberRequestTransport(st, response);
  return response;
}
// 兼容两种主流响应形态：content 为字符串，或 Anthropic 风格的分段数组。
function chatMessageContent(data){
  const choice = data && typeof data === "object" && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message && typeof choice.message === "object" ? choice.message : null;
  if(!message) return "";
  if(typeof message.content === "string") return message.content;
  if(Array.isArray(message.content)){
    return message.content.map(part=>part && typeof part.text === "string" ? part.text : "").join("");
  }
  return "";
}
function chatToolCalls(data){
  const choice = data && typeof data === "object" && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message && typeof choice.message === "object" ? choice.message : null;
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.filter(call=>call && typeof call === "object");
}
const PROBE_RUNNERS = Object.freeze({
  // 核心探针：只有它能区分“网关返回 200”和“模型真的产出了内容”。失败即判不可用。
  async chat(st, ctx){
    const response = await probeChat(st, {
      model:ctx.modelId,
      messages:[{ role:"user", content:"只回复数字 7，不要任何其它内容。" }],
      max_tokens:16, temperature:0, stream:false
    });
    if(!response.ok) return { ok:false, detail: await responseError(response, st.apikey) };
    const data = await responseData(response);
    const content = chatMessageContent(data);
    ctx.answered = true;
    ctx.reportedModel = data && typeof data === "object" ? text(data.model, 200) : "";
    if(!content.trim()) return { ok:false, detail:"返回 200 但内容为空，请求很可能没有真正到达模型" };
    // 小模型偶尔不严格照做，这不代表站点坏了；如实记录但不判失败。
    if(!/7/.test(content)) return { ok:true, detail:"已产出内容，但未严格遵循指令：" + text(content, 60) };
    return { ok:true, detail:"按指令回复 " + text(content.trim(), 40) };
  },
  // 不发请求：直接比对响应里回报的 model 与请求的 model，用来发现网关偷换模型。
  async identity(st, ctx){
    if(!ctx.answered) return { skip:true, detail:"上一步未取得响应，无法比对" };
    if(!ctx.reportedModel) return { skip:true, detail:"响应未回报 model 字段" };
    if(ctx.reportedModel === ctx.modelId) return { ok:true, detail:"与请求的模型一致" };
    // provider/gpt-4o、gpt-4o-2024-08-06 这类前后缀差异属于同系列版本，不算偷换。
    if(ctx.reportedModel.includes(ctx.modelId) || ctx.modelId.includes(ctx.reportedModel)){
      return { ok:true, detail:"返回 " + ctx.reportedModel + "，同系列变体" };
    }
    return { ok:false, detail:"请求 " + ctx.modelId + "，实际返回 " + ctx.reportedModel };
  },
  // 流式是聊天客户端的默认路径；顺带量出首字延迟，它比总耗时更能反映实际手感。
  async stream(st, ctx){
    const response = await probeChat(st, {
      model:ctx.modelId,
      messages:[{ role:"user", content:"从 1 数到 10，用空格分隔。" }],
      max_tokens:64, temperature:0, stream:true
    });
    if(!response.ok) return { ok:false, detail: await responseError(response, st.apikey) };
    const result = await readSseStream(response);
    if(!result.chunks) return { ok:false, detail:"未收到任何增量，站点可能不支持 stream 或被中间层整段缓冲" };
    ctx.metrics.ttft = result.ttft;
    ctx.metrics.total = result.total;
    // 增量条数只是输出规模的近似值：多数网关一个 delta 一个 token，够用来估吞吐。
    ctx.metrics.outputTokens = result.chunks;
    if(result.total > 0) ctx.metrics.tps = result.chunks / (result.total/1000);
    const ttftText = Number.isFinite(result.ttft) ? Math.round(result.ttft) + "ms 首字" : "首字时间未知";
    if(result.chunks < 2) return { ok:true, detail:"仅 1 个增量，可能被中间层缓冲成一次性返回" };
    return { ok:true, detail:result.chunks + " 个增量 · " + ttftText };
  },
  // 多轮：口令只出现在历史消息里。网关只转发最后一条时，模型答不出来。
  async context(st, ctx){
    const token = probeToken("KW");
    const response = await probeChat(st, {
      model:ctx.modelId,
      messages:[
        { role:"user", content:"记住这个口令：" + token + "。只回复 OK。" },
        { role:"assistant", content:"OK" },
        { role:"user", content:"刚才的口令是什么？只回复口令本身。" }
      ],
      max_tokens:32, temperature:0, stream:false
    });
    if(!response.ok) return { ok:false, detail: await responseError(response, st.apikey) };
    const data = await responseData(response);
    const content = chatMessageContent(data);
    if(!content.trim()) return { ok:false, detail:"返回内容为空" };
    if(content.toUpperCase().includes(token)) return { ok:true, detail:"正确复述历史消息中的口令" };
    return { ok:false, detail:"未复述出口令，历史消息可能未被转发：" + text(content, 60) };
  },
  // 工具调用是 Agent 场景的硬门槛，很多便宜中转站在这一步暴露真实上游。
  async tools(st, ctx){
    const response = await probeChat(st, {
      model:ctx.modelId,
      messages:[{ role:"user", content:"查一下北京现在的天气，必须使用提供的工具。" }],
      tools:[{ type:"function", function:{
        name:"get_weather",
        description:"查询指定城市的当前天气",
        parameters:{ type:"object", properties:{ city:{ type:"string", description:"城市名称" } }, required:["city"] }
      } }],
      tool_choice:"auto", max_tokens:128, stream:false
    });
    if(!response.ok) return { ok:false, detail: await responseError(response, st.apikey) };
    const data = await responseData(response);
    const calls = chatToolCalls(data);
    if(!calls.length) return { ok:false, detail:"未返回 tool_calls，模型或网关不支持函数调用" };
    const fn = calls[0].function && typeof calls[0].function === "object" ? text(calls[0].function.name, 60) : "";
    return { ok:true, detail:"发起调用 " + (fn || "未命名函数") };
  },
  // 结构化输出：程序化调用一般依赖它，返回自然语言会直接把下游解析打断。
  async json(st, ctx){
    const response = await probeChat(st, {
      model:ctx.modelId,
      messages:[{ role:"user", content:'只返回 JSON 对象 {"ok": true}，不要解释，不要代码块。' }],
      response_format:{ type:"json_object" }, max_tokens:64, temperature:0, stream:false
    });
    if(!response.ok) return { ok:false, detail: await responseError(response, st.apikey) };
    const data = await responseData(response);
    const content = chatMessageContent(data).trim();
    if(!content) return { ok:false, detail:"返回内容为空" };
    // 允许模型习惯性包一层代码块，只要剥掉后是合法 JSON 就算通过。
    const body = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    let parsed;
    try{ parsed = JSON.parse(body); }
    catch(e){ return { ok:false, detail:"输出不是合法 JSON：" + text(body, 60) }; }
    if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)){
      return { ok:false, detail:"输出是合法 JSON 但不是对象" };
    }
    return { ok:true, detail:"输出可直接解析为 JSON 对象" };
  },
  // 长上下文：口令放在靠前位置。声明了大窗口但实际从最旧内容开始截断的站点会在这里失败。
  async long(st, ctx){
    const kb = clampInt(settings.longContextKB, LONG_CONTEXT_KB_MIN, LONG_CONTEXT_KB_MAX, DEFAULT_SETTINGS.longContextKB);
    const token = probeToken("NL");
    const filler = "这是一段用于填充上下文的占位文本，本身不含任何有效信息。";
    const target = kb * 1024;
    const lines = [];
    let size = 0;
    while(size < target){
      const row = (lines.length + 1) + ". " + filler;
      lines.push(row);
      size += row.length * 3;   // 中文按 UTF-8 3 字节估算，够用来控制请求体规模
    }
    lines.splice(Math.floor(lines.length * 0.1), 0, "口令：" + token);
    const prompt = lines.join("\n") + "\n\n上文中出现过一个口令，只回复该口令本身。";
    // 请求体最大的一个探针，给它更宽的超时，避免把慢而可用的站点误判为失败。
    const response = await probeChat(st, {
      model:ctx.modelId,
      messages:[{ role:"user", content:prompt }],
      max_tokens:32, temperature:0, stream:false
    }, Math.max(settings.timeout, 30));
    if(!response.ok) return { ok:false, detail: await responseError(response, st.apikey) };
    const data = await responseData(response);
    const content = chatMessageContent(data);
    if(!content.trim()) return { ok:false, detail:"返回内容为空" };
    if(content.toUpperCase().includes(token)) return { ok:true, detail:"约 " + kb + "KB 上下文内取回口令" };
    return { ok:false, detail:"约 " + kb + "KB 上下文下未取回口令：" + text(content, 60) };
  }
});
async function runProbe(st, key, ctx){
  const started = performance.now();
  try{
    const outcome = await PROBE_RUNNERS[key](st, ctx);
    const state = outcome && outcome.skip ? "skip" : outcome && outcome.ok ? "pass" : "fail";
    return { key, state, ms:Math.round(performance.now()-started), detail: text(outcome && outcome.detail, PROBE_DETAIL_MAX) };
  }catch(error){
    return { key, state:"fail", ms:Math.round(performance.now()-started), detail: text(networkErrorMessage(error, st && st.apikey), PROBE_DETAIL_MAX) };
  }
}
// chat 失败说明这个模型根本用不了；其余探针失败只说明部分场景受限，仍可日常问答。
function gradeCapability(probes){
  const chat = probes.find(probe=>probe.key === "chat");
  if(!chat || chat.state !== "pass") return "unusable";
  return probes.some(probe=>probe.state === "fail") ? "limited" : "usable";
}
function capabilitySummary(capability){
  if(!capability) return "";
  const total = capability.probes.filter(probe=>probe.state !== "skip").length;
  const passed = capability.probes.filter(probe=>probe.state === "pass").length;
  return (TEST_DEPTH_LABELS[capability.depth] || capability.depth) + "档 " + passed + "/" + total + " 项通过";
}
// 探针在单个模型内串行（后续探针依赖前面的响应，也避免同模型并发触发限流）；
// 模型之间的并行由 batchTest 的工作池控制。alive() 在每个探针之间检查站点是否还是同一个。
async function runCapabilitySuite(st, modelId, depth, alive){
  const keys = DEPTH_PROBES[depth] || DEPTH_PROBES.basic;
  const ctx = { modelId, answered:false, reportedModel:"", metrics:{ ttft:null, total:null, outputTokens:null, tps:null } };
  const probes = [];
  for(const key of keys){
    if(!alive()) return null;
    probes.push(await runProbe(st, key, ctx));
    // chat 都没通过，后面的探针只会重复同一个失败原因，白花请求。
    if(key === "chat" && probes[0].state !== "pass") break;
  }
  if(!alive()) return null;
  return { depth, grade:gradeCapability(probes), probes, at:Date.now(), metrics:ctx.metrics };
}


async function testModel(id, modelId, revision=stationRevision(id), options={}){
  const fromBatch=options && options.fromBatch === true;
  if(!isCurrentStation(id, revision)) return false;
  let st = getById(id);
  if(!hasStationCredentials(st)){
    toast("请先通过编辑或快速导入填写 Base URL 和 API Key", "warn");
    return false;
  }
  let model = st && st.models.find(item=>item.id===modelId);
  if(!model || model.test === "testing") return false;
  if(isConnectivityRunning(id)){
    if(!fromBatch) toast("连通性诊断进行中，请完成后再测试模型", "warn");
    return false;
  }
  if(fromBatch){
    if(!isBatchRunning(id) || isManualModelTestRunning(id)) return false;
  }else{
    if(isBatchRunning(id) || isRequestRunning(modelListRequests,id) || isManualModelTestRunning(id, modelId)){
      toast("该模型已有测试请求进行中，其他模型仍可继续测试", "warn");
      return false;
    }
    if(manualModelTestCount(id) >= settings.concurrency){
      toast("已达到模型测试并发上限（" + settings.concurrency + "）", "warn");
      return false;
    }
    if(!claimManualModelTest(id, modelId, revision)) return false;
  }
  const depth = TEST_DEPTHS.has(options && options.depth) ? options.depth : settings.testDepth;
  let started=performance.now();
  try{
    st = getById(id);
    model = st && st.models.find(item=>item.id===modelId);
    if(!model || model.test === "testing") return false;
    if(fromBatch){
      if(!isBatchRunning(id) || isManualModelTestRunning(id)) return false;
    }else if(!isManualModelTestRunning(id, modelId) || isBatchRunning(id) || isRequestRunning(modelListRequests,id)){
      return false;
    }
    model.test = "testing"; model.latency = null; model.err = null; model.lastRequestAt=Date.now();
    appendRequestLog(st,{ level:"info", kind:"模型测试", method:"POST", endpoint:"/v1/chat/completions", model:modelId, message:(TEST_DEPTH_LABELS[depth]||depth)+"档测试开始" });
    persistModelProgress(id, revision);
    started = performance.now();
    const capability = await runCapabilitySuite(st, modelId, depth, ()=>isCurrentStation(id, revision));
    // 站点在测试期间被删除或改动：结果已失效，直接丢弃，不写回任何字段。
    if(!capability || !isCurrentStation(id, revision)) return false;
    st = getById(id);
    model = st && st.models.find(item=>item.id===modelId);
    if(!model) return false;
    const chat = capability.probes.find(probe=>probe.key === "chat");
    const failed = capability.probes.filter(probe=>probe.state === "fail");
    const ok = capability.grade !== "unusable";
    model.test = ok ? "ok" : "fail";
    // 延迟仍取非流式单轮往返，保持与旧数据和「响应速度」排序的口径一致。
    model.latency = ok && chat && Number.isFinite(chat.ms) ? chat.ms : null;
    model.lastRequestAt = Date.now();
    // 受限时也保留失败原因，用户不展开明细也能看到卡在哪一项。
    model.err = failed.length ? redactSensitiveText(failed.map(probe=>(PROBE_LABELS[probe.key]||probe.key)+"："+probe.detail).join("；"), st.apikey, 500) : null;
    model.capability = normalizeCapability(capability, st.apikey);
    appendRequestLog(st,{
      level: ok ? (failed.length ? "warn" : "ok") : "error",
      kind:"模型测试", method:"POST", endpoint:"/v1/chat/completions", model:modelId,
      latency: model.latency, transport: st.status && st.status.transport,
      message: capabilitySummary(capability) + "，判定" + (CAPABILITY_GRADE_LABELS[capability.grade] || capability.grade)
    });
  }catch(error){
    if(!isCurrentStation(id, revision)) return false;
    const message=networkErrorMessage(error,st && st.apikey);
    model.test="fail"; model.latency=null; model.lastRequestAt=Date.now(); model.err=message; model.capability=null;
    appendRequestLog(st,{ level:"error", kind:"模型测试", method:"POST", endpoint:"/v1/chat/completions", model:modelId, latency:performance.now()-started, message });
  }finally{
    if(!fromBatch) releaseManualModelTest(id, modelId, revision);
  }
  if(!isCurrentStation(id, revision)) return false;
  persistModelProgress(id, revision);
  return model.test === "ok";
}

// 批量测试：工作池受 settings.concurrency 限制；运行中禁止同站重复测试。
async function batchTest(id){
  const revision = stationRevision(id);
  if(isBatchRunning(id)){ toast("该站点正在批量测试", "warn"); return; }
  const station=getById(id);
  if(!hasStationCredentials(station)){
    toast("请先通过编辑或快速导入填写 Base URL 和 API Key", "warn");
    return;
  }
  if(!station) return;
  if(isConnectivityRunning(id)){
    toast("连通性诊断进行中，请完成后再批量测试", "warn");
    return;
  }
  if(isRequestRunning(modelListRequests,id) || isManualModelTestRunning(id) || station.models.some(model=>model.test==="testing")){
    toast("模型列表或模型测试进行中，请完成后再批量测试", "warn");
    return;
  }
  // 在第一个 await 前冻结选择范围；切换站点或重新渲染均不会污染本次批测的统计。
  const pickedIds=new Set([...selectedModels].filter(modelId=>station.models.some(model=>model.id===modelId)));
  if(!pickedIds.size){ toast("请先勾选要测试的模型", "warn"); return; }
  // 档位同样在开测前冻结：中途改选择框不会让同一批结果混用两种深度。
  const depth = settings.testDepth;
  runningBatches.set(id, revision); scheduleRender();
  try{
    const st = getById(id);
    const picks = st.models.filter(model=>pickedIds.has(model.id));
    if(!picks.length){ toast("选中的模型已不在当前列表中，已跳过批量测试", "warn"); return; }
    const limit = settings.concurrency;
    let cursor = 0;
    const worker = async()=>{
      while(cursor < picks.length && isCurrentStation(id, revision)){
        const model = picks[cursor++];
        await testModel(id, model.id, revision, { fromBatch:true, depth });
      }
    };
    await Promise.all(Array.from({ length:Math.min(limit, picks.length) }, worker));
    if(!isCurrentStation(id, revision)) return;
    const current = getById(id);
    const tested = current.models.filter(model=>pickedIds.has(model.id));
    const usable = tested.filter(model=>model.capability ? model.capability.grade==="usable" : model.test==="ok").length;
    const limited = tested.filter(model=>model.capability && model.capability.grade==="limited").length;
    const summary = "批量测试完成（" + (TEST_DEPTH_LABELS[depth]||depth) + "档）：选中 " + picks.length + " 个，可用 " + usable + " 个"
      + (limited ? "，受限 " + limited + " 个" : "");
    toast(summary, usable===picks.length ? "ok" : "warn");
  }catch(error){
    if(isCurrentStation(id, revision)){
      const current=getById(id);
      toast("批量测试失败：" + networkErrorMessage(error,current && current.apikey), "err");
    }
  }finally{
    if(runningBatches.get(id) === revision){
      runningBatches.delete(id);
      flushModelProgress(id, revision);
    }
  }
}

/* ---------------- 顶栏紧凑总览 ---------------- */
function renderTitleStats(){
  const total = stations.length;
  const online = stations.filter(s=>s.status.connectivity==="online" || s.status.connectivity==="reachable").length;
  let tested=0;
  stations.forEach(s=> s.models.forEach(m=>{ if(m.test==="ok") tested++; }));
  const box = document.getElementById("titleStats");
  box.innerHTML = `
    <span class="title-stat total" title="中转站总数"><span class="dot"></span><b>${total}</b><span>中转站</span></span>
    <span class="title-stat online" title="在线中转站数"><span class="dot"></span><b>${online}</b><span>在线</span></span>
    <span class="title-stat passed" title="已通过测试的模型数"><span class="dot"></span><b>${tested}</b><span>模型通过</span></span>
  `;
}

/* ---------------- 过滤 / 徽标 / 操作条 ---------------- */
// 按搜索框过滤（名称/分组/地址），并先按 order 排序
function currentSearchQuery(){ return (document.getElementById("search").value||"").trim().toLowerCase(); }
function isSearchFiltered(){ return !!currentSearchQuery(); }
function filtered(){
  const q = currentSearchQuery();
  byOrder();
  if(!q) return stations.slice();
  return stations.filter(s=>
    (s.name||"").toLowerCase().includes(q) ||
    (s.group||"").toLowerCase().includes(q) ||
    (s.baseurl||"").toLowerCase().includes(q)
  );
}

// 模型接口返回顺序是用户可预期的基线。非默认排序使用运行时快照：
// 测试状态从 idle -> testing -> ok/fail 时只更新当前卡片内容，绝不把卡片换到新位置。
function modelSourceSignature(st){
  return Array.isArray(st && st.models) ? st.models.map(model=>model.id).join("\u0001") : "";
}
function computeModelDisplayOrder(st, mode){
  const indexed=(st && Array.isArray(st.models) ? st.models : []).map((model,index)=>({ model,index }));
  const availabilityRank=model=>{
    if(model.test === "ok") return 0;
    if(model.test === "testing") return 1;
    if(model.test === "idle") return 2;
    return 3;
  };
  indexed.sort((a,b)=>{
    if(mode === "available"){
      const rank=availabilityRank(a.model)-availabilityRank(b.model);
      if(rank) return rank;
      // 已通过模型中，较快的排在前面；其余情况保持接口原顺序。
      if(a.model.test === "ok" && b.model.test === "ok"){
        const latency=(Number.isFinite(a.model.latency) ? a.model.latency : Infinity) - (Number.isFinite(b.model.latency) ? b.model.latency : Infinity);
        if(latency) return latency;
      }
      return a.index-b.index;
    }
    // 响应速度仅比较已有成功响应的模型；未测试与失败模型仍按接口顺序排在后面。
    const aMeasured=a.model.test === "ok" && Number.isFinite(a.model.latency);
    const bMeasured=b.model.test === "ok" && Number.isFinite(b.model.latency);
    if(aMeasured !== bMeasured) return aMeasured ? -1 : 1;
    if(aMeasured){
      const latency=a.model.latency-b.model.latency;
      if(latency) return latency;
    }
    const rank=availabilityRank(a.model)-availabilityRank(b.model);
    return rank || a.index-b.index;
  });
  return indexed;
}

function modelDisplayOrder(st){
  const indexed=(st && Array.isArray(st.models) ? st.models : []).map((model,index)=>({ model,index }));
  const mode=MODEL_SORT_MODES.has(settings.modelSort) ? settings.modelSort : "source";
  if(mode === "source") return indexed;
  const signature=modelSourceSignature(st);
  const previous=modelDisplaySnapshots.get(st.id);
  if(previous && previous.mode===mode && previous.signature===signature){
    const byId=new Map(indexed.map(entry=>[entry.model.id,entry]));
    const ordered=previous.ids.map(id=>byId.get(id)).filter(Boolean);
    if(ordered.length===indexed.length) return ordered;
  }
  const ordered=computeModelDisplayOrder(st,mode);
  modelDisplaySnapshots.set(st.id,{ mode, signature, ids:ordered.map(entry=>entry.model.id) });
  return ordered;
}

function setModelSort(mode){
  if(!MODEL_SORT_MODES.has(mode) || settings.modelSort === mode) return;
  settings.modelSort=mode;
  saveSettings();
  // 用户主动切换排序才丢弃快照并计算新顺序；保留当前可见模型锚点，
  // 让长列表重新排列时仍停留在用户正在查看的位置。
  modelDisplaySnapshots.clear();
  render();
}
// 档位只影响下一次测试，不重排也不清空已有结果；换档后重新渲染是为了同步按钮提示文案。
function setTestDepth(depth){
  if(!TEST_DEPTHS.has(depth) || settings.testDepth === depth) return;
  settings.testDepth=depth;
  saveSettings();
  render();
}

// 非默认排序故意在测试期间稳定展示。用户主动点击时才按刚得到的结果重新排序。
function refreshModelSort(stationId){
  const st=getById(stationId);
  const mode=MODEL_SORT_MODES.has(settings.modelSort) ? settings.modelSort : "source";
  if(!st || mode==="source" || !st.models.length) return;
  modelDisplaySnapshots.delete(st.id);
  render();
}

// 连通性状态在详情/Grid 中用于静态展示，在左栏中会复用为可重试按钮。
function connectivityPresentation(st){
  const map = { unknown:["未诊断","unknown"], online:["连通正常","online"], reachable:["服务可达","online"], offline:["连接失败","offline"], testing:["检测中","testing"] };
  const [txt,cls] = map[st.status.connectivity] || map.unknown;
  return { txt, cls };
}
// 状态徽标：未知/已验证/服务可达/离线/检测中（带颜色圆点）
function statusBadge(st){
  const {txt,cls}=connectivityPresentation(st);
  return `<span class="badge ${cls}"><span class="d ${cls}"></span>${txt}</span>`;
}

// 编辑和删除在 Grid 操作条与列表底栏复用，保证禁用规则、图标和提示一致。
function stationManageControls(st){
  const activity=getStationActivity(st);
  const stationBusy=activity.any;
  const escapedId = esc(st.id);
  return `<span class="station-manage" role="group" aria-label="站点管理">
    <button type="button" class="btn sm station-edit" data-act="edit" data-id="${escapedId}" title="${stationBusy?"请求进行中，暂不能编辑":"编辑站点"}" aria-label="编辑站点" ${stationBusy?"disabled":""}>${EDIT_ICON}<span>编辑</span></button>
    <button type="button" class="btn sm station-delete" data-act="del" data-id="${escapedId}" title="${stationBusy?"请求进行中，暂不能删除":"删除站点"}" aria-label="删除站点" ${stationBusy?"disabled":""}>${TRASH_ICON}<span>删除</span></button>
  </span>`;
}

function connectivityRetryState(st){
  const activity=getStationActivity(st);
  const missingConfig=!hasStationCredentials(st);
  const disabled=missingConfig || activity.connection || activity.balance || activity.modelWork;
  const {txt,cls}=connectivityPresentation(st);
  // 响应已落盘后，即使请求锁尚未在同一微任务中释放，也应立即展示最终状态。
  const running=activity.connection && st.status.connectivity==="testing";
  const label=running ? "检测中…" : txt;
  const title=missingConfig ? "请先填写 Base URL 和 API Key" :
    running ? "正在检测连通性" :
    activity.balance || activity.modelWork ? "该站点已有请求进行中，完成后可重新诊断" :
    st.status.connectivity==="unknown" ? "开始连通性诊断（含延时）" : "重新诊断连通性（含延时）";
  const ariaLabel=running ? "正在检测连通性" : label+"，点击"+(st.status.connectivity==="unknown" ? "开始" : "重新")+"诊断连通性（含延时）";
  const refreshTitle=missingConfig ? "请先填写 Base URL 和 API Key" : running ? "正在检测连通性" : st.status.connectivity==="unknown" ? "开始连通性诊断（含延时）" : "重新诊断连通性（含延时）";
  return { activity, disabled, cls, label, running, title, ariaLabel, refreshTitle };
}
// 左栏状态值复用普通指标的两行结构，四格的基线与行高完全一致。
function connectivityRetryMarkup(st){
  const {cls,label,ariaLabel,running}=connectivityRetryState(st);
  return `<div class="row-metric status ${cls}" aria-label="${ariaLabel}" aria-busy="${running?"true":"false"}">
    <span class="m-label">状态</span>
    <span class="m-val">${running?"检测中…":label}</span>
  </div>`;
}
function connectivityRefreshControl(st){
  const {disabled,cls,running,refreshTitle,ariaLabel}=connectivityRetryState(st);
  return `<button type="button" class="status-refresh ${cls}" data-act="conn" data-id="${esc(st.id)}" title="${refreshTitle}" aria-label="${ariaLabel}" aria-busy="${running?"true":"false"}" ${disabled?"disabled":""}>${running?SPINNER_ICON:RETRY_ICON}</button>`;
}

// 网格操作条保留独立连通性入口；列表则使用同样的图标放在编辑按钮左侧。
function opsBar(st){
  const activity=getStationActivity(st);
  const missingConfig=!hasStationCredentials(st);
  const connectionDisabled=missingConfig || activity.connection || activity.balance || activity.modelWork;
  const connectionRunning=activity.connection && st.status.connectivity==="testing";
  const connectionTitle=missingConfig ? "请先填写 Base URL 和 API Key" : connectionRunning ? "正在检测连通性" : activity.balance || activity.modelWork ? "该站点已有请求进行中" : "测试连通性";
  const escapedId = esc(st.id);
  return `
    <div class="ops" role="group" aria-label="${esc(st.name)} 的站点操作">
      <button type="button" class="btn action sm station-connect" data-act="conn" data-id="${escapedId}" title="${connectionTitle}" ${connectionDisabled?"disabled":""}>${connectionRunning?SPINNER_ICON+"检测中…":"连通性"}</button>
      ${stationManageControls(st)}
    </div>`;
}
// 拖拽只从手柄开始，避免点击站点、Key 或其他操作时误触排序。
function dragHandle(enabled=true){
  if(!enabled) return "";
  return `<button type="button" class="handle" data-station-drag-handle title="拖拽调整顺序" aria-label="拖拽调整顺序"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>`;
}

/* ---------------- 主渲染（核心调度） ---------------- */
// 全量重绘不可避免（模型测试状态会频繁更新），因此把各滚动容器作为渲染状态的一部分保存与恢复。
function captureScrollState(options={}){
  const preserveModelAnchors=options.preserveModelAnchors !== false;
  const page=document.scrollingElement;
  const list=document.getElementById("listPane");
  const detail=document.getElementById("detailPane");
  const focus=document.getElementById("focusView");
  let detailAnchor=null;
  if(preserveModelAnchors && detail && detail.offsetParent!==null){
    const panelRect=detail.getBoundingClientRect();
    const visible=[...detail.querySelectorAll("[data-model-id]")].find(card=>{
      const rect=card.getBoundingClientRect();
      return rect.bottom>panelRect.top+1 && rect.top<panelRect.bottom-1;
    });
    if(visible) detailAnchor={ id:visible.dataset.modelId || "", offset:visible.getBoundingClientRect().top-panelRect.top };
  }
  // 专注页由文档本身滚动。记录当前首个可见模型相对视口的位置，
  // 让顶部诊断/错误信息的出现不会把用户正在查看的模型向下推走。
  let focusAnchor=null;
  if(preserveModelAnchors && focus && focus.offsetParent!==null){
    const visible=[...focus.querySelectorAll("[data-model-id]")].find(card=>{
      const rect=card.getBoundingClientRect();
      return rect.bottom>0 && rect.top<window.innerHeight;
    });
    if(visible) focusAnchor={ id:visible.dataset.modelId || "", top:visible.getBoundingClientRect().top };
  }
  return {
    pageX:window.scrollX || (page ? page.scrollLeft : 0) || 0,
    pageY:window.scrollY || (page ? page.scrollTop : 0) || 0,
    listTop:list ? list.scrollTop : 0,
    detailTop:detail ? detail.scrollTop : 0,
    detailAnchor,
    focusTop:focus ? focus.scrollTop : 0,
    focusAnchor
  };
}
function restoreScrollState(state, target="preserve"){
  if(!state) return;
  const apply=()=>{
    const list=document.getElementById("listPane");
    const detail=document.getElementById("detailPane");
    const focus=document.getElementById("focusView");
    if(list) list.scrollTop=state.listTop || 0;
    if(detail) detail.scrollTop=state.detailTop || 0;
    if(focus) focus.scrollTop=state.focusTop || 0;
    if(detail && state.detailAnchor){
      const anchor=[...detail.querySelectorAll("[data-model-id]")].find(card=>card.dataset.modelId===state.detailAnchor.id);
      if(anchor){
        const offset=anchor.getBoundingClientRect().top-detail.getBoundingClientRect().top;
        const delta=offset-state.detailAnchor.offset;
        if(Math.abs(delta)>.5) detail.scrollTop+=delta;
      }
    }
    if(target==="focus-top" && focus){
      const bar=document.querySelector(".topbar");
      const offset=(bar ? bar.getBoundingClientRect().height : 0) + 14;
      const top=Math.max(0,(window.scrollY || 0) + focus.getBoundingClientRect().top - offset);
      window.scrollTo(state.pageX || 0,top);
    }else{
      window.scrollTo(state.pageX || 0,state.pageY || 0);
      if(state.focusAnchor && focus && focus.offsetParent!==null){
        const anchor=[...focus.querySelectorAll("[data-model-id]")].find(card=>card.dataset.modelId===state.focusAnchor.id);
        if(anchor){
          const delta=anchor.getBoundingClientRect().top-state.focusAnchor.top;
          if(Math.abs(delta)>.5) window.scrollTo(state.pageX || 0,Math.max(0,(window.scrollY || 0)+delta));
        }
      }
    }
  };
  // 先同步恢复，再在浏览器完成本帧布局后校正一次；批测高频刷新时只保留最后一次校正。
  apply();
  if(renderRestoreFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(renderRestoreFrame);
  if(typeof requestAnimationFrame === "function"){
    renderRestoreFrame=requestAnimationFrame(()=>{ renderRestoreFrame=0; apply(); });
  }else{
    setTimeout(apply,0);
  }
}
function finishRender(scrollState, scrollTarget){
  syncDetailOffset();
  restoreScrollState(scrollState,scrollTarget);
}
function render(options={}){
  // 拖拽过程中任何全量 render 都会销毁指针目标；把状态刷新合并到落下后。
  if(activeDrag){
    renderAfterDrag=true;
    return;
  }
  if(scheduledRenderHandle !== null){
    if(typeof cancelAnimationFrame === "function") cancelAnimationFrame(scheduledRenderHandle);
    else clearTimeout(scheduledRenderHandle);
    scheduledRenderHandle=null;
  }
  const preserveModelAnchors=options.preserveModelAnchors !== false;
  const scrollState=options.scrollState || captureScrollState({ preserveModelAnchors });
  const scrollTarget=options.scrollTarget || "preserve";
  byOrder();
  renderTitleStats();
  // 同步视图切换按钮的激活态
  document.querySelectorAll("#viewToggle button").forEach(b=> b.classList.toggle("active", b.dataset.view===settings.view));

  const split=document.getElementById("splitView");
  const grid=document.getElementById("gridView");
  const focus=document.getElementById("focusView");
  const focusedStation=focusId ? getById(focusId) : null;

  // 专注页优先：网格点开后整块替换主区；清空隐藏详情，避免重复 dw* id。
  if(focusedStation){
    document.body.classList.add("focus-active");
    split.style.display="none"; grid.style.display="none"; focus.style.display="block";
    document.getElementById("detailPane").innerHTML = "";
    renderDetailInto(focus, focusedStation, true, { preserveModelAnchor:preserveModelAnchors });
    finishRender(scrollState,scrollTarget);
    return;
  }
  document.body.classList.remove("focus-active");
  if(focusId){
    focusReturnScroll=null; // 目标已不存在时不再保留过期返回位置
    focusReturnStationId=null;
  }
  focusId = null;   // 退出专注态时清空，保证后续渲染一致
  focus.innerHTML = ""; // 退出专注页后移除旧详情，避免与常驻详情产生重复 id

  if(settings.view==="grid"){
    split.style.display="none"; focus.style.display="none"; grid.style.display="grid";
    renderGrid(grid);
  } else {
    grid.style.display="none"; focus.style.display="none"; split.style.display="flex";
    const visibleStations=filtered();
    const filtering=isSearchFiltered();
    let st=visibleStations.find(item=>item.id===selectedId) || null;
    // 未筛选时保留旧有的“默认首站”体验；筛选后不悄悄切换详情，
    // 以免用户在右侧对一个并未出现在结果中的站点执行操作。
    if(!st && !filtering){
      st=visibleStations[0] || null;
      if(st) selectedId=st.id;
    }
    renderListPane(st ? st.id : null);
    const dp = document.getElementById("detailPane");
    // 窄屏下详情被 CSS 隐藏，无需渲染（省开销）；宽屏才渲染右侧常驻详情
    if(isNarrow()){ /* 隐藏态，跳过 */ }
    else if(st) renderDetailInto(dp, st, false, { preserveModelAnchor:preserveModelAnchors });
    else dp.innerHTML = emptyDetail(filtering);
  }
  finishRender(scrollState,scrollTarget);
}
function syncDetailOffset(){
  const bar=document.querySelector(".topbar");
  if(!bar) return;
  document.documentElement.style.setProperty("--detail-top", Math.ceil(bar.getBoundingClientRect().height + 16) + "px");
}

// 空状态（列表无匹配 / 全空）
function emptyInline(title, sub){
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(sub)}</p>${stations.length?'':'<button class="btn primary" id="emptyAdd">+ 添加第一个中转站</button>'}</div>`;
}
function emptyDetail(filteredOut=false){
  const title=filteredOut ? "请选择匹配的中转站" : "选择左侧中转站";
  const sub=filteredOut ? "当前已选站点不在筛选结果中，请从左侧选择匹配项。" : "点击任一站点查看详情与测试";
  return `<div class="empty" style="height:100%"><h3>${title}</h3><p>${sub}</p></div>`;
}

// 列表左栏：标题操作、连续四格指标、URL 与固定高度 Key 轨道；展开只改变轨道内显示，不推动卡片布局。
function renderListPane(activeId=selectedId){
  const pane = document.getElementById("listPane");
  const data = filtered();
  const orderingEnabled=!isSearchFiltered();
  const listHeader = `<div class="pane-head"><div><span class="pane-eyebrow">服务目录</span><strong>中转站</strong></div><div class="pane-tools"><button type="button" class="pane-locate" id="btnLocate" title="定位到当前站点" aria-label="定位到当前站点">${LOCATE_ICON}</button><span class="pane-count">${data.length}<small>个站点</small></span></div></div>`;
  const bindLocate=()=>{ const btn=document.getElementById("btnLocate"); if(btn) btn.onclick=()=>locateActiveStation(); };
  if(!data.length){
    pane.innerHTML = listHeader + emptyInline(stations.length? "没有匹配的中转站" : "还没有中转站", stations.length? "换个关键词试试" : "点击下方「添加中转站」开始");
    const ea = document.getElementById("emptyAdd"); if(ea) ea.onclick = ()=>openForm(null);
    bindLocate();
    return;
  }
  pane.innerHTML = listHeader + data.map(st=>{
    const okModels = st.models.filter(m=>m.test==="ok").length;
    const balanceValue=hasBalance(st) ? balanceDisplay(st) : "未查询";
    const modelValue=st.models.length ? okModels+" / "+st.models.length : "未获取";
    const balanceTitle=hasBalance(st) ? balanceLabel(st)+" "+balanceDisplay(st) : "尚未查询余额";
    const modelTitle=st.models.length ? "已通过 "+okModels+" / 共 "+st.models.length+" 个模型" : "尚未获取模型列表";
    const latClass=latencyCls(st.status.latency);
    const url=esc(st.baseurl);
    return `
      <div class="row-item ${st.status.connectivity} ${activeId===st.id?'selected':''}" data-id="${esc(st.id)}">
        <div class="row-top">
          ${dragHandle(orderingEnabled)}
          <div class="row-name"><button type="button" class="station-open" data-open-station="${esc(st.id)}" aria-label="打开 ${esc(st.name)} 的详情">${esc(st.name)}</button>${st.group?`<span class="row-group">· ${esc(st.group)}</span>`:""}</div>
          <div class="row-actions">${connectivityRefreshControl(st)}${stationManageControls(st)}</div>
        </div>
        <div class="row-metrics">
          ${connectivityRetryMarkup(st)}
          <div class="row-metric" title="${esc(balanceTitle)}"><span class="m-label">余额</span><span class="m-val">${esc(balanceValue)}</span></div>
          <div class="row-metric" title="${esc(modelTitle)}"><span class="m-label">模型</span><span class="m-val pri">${esc(modelValue)}</span></div>
          <div class="row-metric"><span class="m-label">延迟</span><span class="m-val ${latClass}">${fmtLat(st.status.latency)}</span></div>
        </div>
        <a class="row-url" href="${url}" target="_blank" rel="noopener noreferrer" data-url="${url}" title="点击新标签打开 · 右键复制"><span class="url-text">${url}</span></a>
        <div class="row-key" aria-label="API Key">${apiKeyControlsMarkup(st,{list:true})}</div>
      </div>`;
  }).join("");
  bindLocate();
  bindListOrGrid("#listPane");
}

// 网格主区：卡片点开整页专注（见 onStationClick）
function renderGrid(grid){
  const data = filtered();
  const orderingEnabled=!isSearchFiltered();
  const gridHeader = `<div class="grid-head"><div><span class="grid-eyebrow">API 服务</span><h2>中转站总览</h2></div><div class="grid-summary"><strong>${data.length} 个站点</strong><span class="grid-hint">点击卡片进入工作台</span></div></div>`;
  if(!data.length){
    grid.innerHTML = gridHeader + emptyInline(stations.length? "没有匹配的中转站" : "还没有中转站", stations.length? "换个关键词试试" : "点击下方「添加中转站」开始");
    const ea = document.getElementById("emptyAdd"); if(ea) ea.onclick = ()=>openForm(null);
    return;
  }
  grid.innerHTML = gridHeader + data.map(st=>`
    <div class="card ${st.status.connectivity}" data-id="${esc(st.id)}">
      <span class="accent"></span>
      <div class="card-head"><span class="card-head-start">${dragHandle(orderingEnabled)}<span class="card-kicker">${esc(st.group || "未分组")}</span></span><span class="card-head-side"><span class="lat ${latencyCls(st.status.latency)}">${fmtLat(st.status.latency)}</span></span></div>
      <div class="meta">
        <div class="name"><button type="button" class="station-open" data-open-station="${esc(st.id)}" aria-label="打开 ${esc(st.name)} 的详情">${esc(st.name)}</button>${st.group?`<span class="grp">· ${esc(st.group)}</span>`:""}</div>
        <div class="url">${esc(st.baseurl)}</div>
        <div class="keys">${apiKeyControlsMarkup(st)}</div>
      </div>
      <div class="card-status">${statusBadge(st)}</div>
      <div class="card-ops">${opsBar(st)}</div>
    </div>`).join("");
  bindListOrGrid("#gridView");
}

// 绑定列表/网格内交互：操作按钮 + 整行点击 + 拖拽
function bindListOrGrid(scope){
  // 操作按钮：conn/edit/del
  document.querySelectorAll(scope+' [data-act]').forEach(btn=>{
    btn.onclick = (e)=>{
      e.stopPropagation();
      const id = btn.dataset.id, act = btn.dataset.act;
      if(act==="conn") testConnectivity(id);
      else if(act==="edit") openForm(id);
      else if(act==="del") openDelete(id);
    };
  });
  document.querySelectorAll(scope+' [data-station-drag-handle]').forEach(handle=>{
    handle.onclick = event=>{ event.preventDefault(); event.stopPropagation(); };
  });
  // 独立的真实按钮保证键盘也能进入详情，避免把含其他操作的整卡伪装成 button。
  document.querySelectorAll(scope+' [data-open-station]').forEach(button=>{
    button.onclick=e=>{ e.stopPropagation(); onStationClick(button.dataset.openStation); };
  });
  bindUrlInteractions(document.querySelector(scope));
  // 整行/整卡点击：网格或窄屏→整页专注；宽屏列表→右侧详情
  document.querySelectorAll(scope+' .row-item, '+scope+' .card').forEach(el=>{
    el.onclick = event=>{
      // Pointer 拖拽松手后浏览器会补发一次 click；消费它，不能误打开详情。
      if(performance.now()<suppressStationOpenClickUntil){ event.preventDefault(); event.stopPropagation(); return; }
      onStationClick(el.dataset.id);
    };
  });
  bindApiKeyControls(document.querySelector(scope));
  attachDrag(scope);
}

/* ---------------- 列表 URL 交互：新标签打开 + 右键菜单 ---------------- */
let urlMenuEl = null;
function bindUrlInteractions(root){
  if(!root) return;
  root.querySelectorAll(".row-url").forEach(link=>{
    link.onclick=event=>event.stopPropagation();
    link.oncontextmenu=event=>{
      event.preventDefault();
      event.stopPropagation();
      openUrlMenu(event.clientX,event.clientY,link.dataset.url || link.href);
    };
  });
}
function ensureUrlMenu(){
  if(urlMenuEl) return urlMenuEl;
  const menu=document.createElement("div");
  menu.className="url-menu";
  menu.setAttribute("role","menu");
  menu.innerHTML='<button type="button" data-url-action="open" role="menuitem">打开链接</button><button type="button" data-url-action="copy" role="menuitem">复制链接</button>';
  menu.onclick=event=>{
    const button=event.target.closest("[data-url-action]");
    if(!button) return;
    const url=menu.dataset.url || "";
    if(button.dataset.urlAction==="open"){
      const opened=window.open(url,"_blank","noopener,noreferrer");
      if(!opened){ copyText(url); toast("弹窗被拦截，已复制链接","warn"); }
    }else if(url){
      copyText(url);
    }
    closeUrlMenu();
  };
  document.addEventListener("click",event=>{ if(!menu.contains(event.target)) closeUrlMenu(); });
  document.addEventListener("contextmenu",event=>{ if(!menu.contains(event.target)) closeUrlMenu(); });
  document.addEventListener("scroll",closeUrlMenu,true);
  document.addEventListener("keydown",event=>{ if(event.key==="Escape") closeUrlMenu(); });
  document.body.appendChild(menu);
  urlMenuEl=menu;
  return menu;
}
function openUrlMenu(x,y,url){
  const menu=ensureUrlMenu();
  menu.dataset.url=url;
  menu.style.display="block";
  const rect=menu.getBoundingClientRect();
  const left=Math.min(Math.max(8,x),Math.max(8,window.innerWidth-rect.width-8));
  const below=y+6;
  const top=below+rect.height<=window.innerHeight ? below : Math.max(8,y-rect.height-6);
  menu.style.left=left+"px";
  menu.style.top=top+"px";
}
function closeUrlMenu(){ if(urlMenuEl) urlMenuEl.style.display="none"; }

/* ---------------- 站点拖拽排序 ---------------- */
let dropCard = null;
let dropAfter = null;
let suppressStationOpenClickUntil = 0;
let dragGlobalEventsBound = false;
// 拖拽让位动画中其它卡片的 translateY。重算落点布局时用它把 getBoundingClientRect
// 还原回未位移的原始坐标系，否则让位动画会污染落点判断，越拖越偏。
const dragShifts = new Map();

// 拖动开始后缓存目标卡片的视口坐标。长列表不能在每一次 pointermove 里反复触发布局测量。
function captureStationDropLayout(root, fromId){
  const items=[...root.querySelectorAll(".row-item[data-id], .card[data-id]")]
    .filter(card=>card.dataset.id!==fromId)
    .map(card=>{
      const rect=card.getBoundingClientRect();
      const shift=dragShifts.get(card)||0;
      return { card, id:card.dataset.id, top:rect.top-shift, bottom:rect.bottom-shift, left:rect.left, right:rect.right, width:rect.width, height:rect.height };
    })
    .filter(item=>item.width>0 && item.height>0);
  if(root.id!=="gridView") return { kind:"list", items:items.sort((a,b)=>a.top-b.top || a.left-b.left) };

  const rows=[];
  items.sort((a,b)=>a.top-b.top || a.left-b.left).forEach(item=>{
    let row=rows.find(candidate=>Math.abs(candidate.top-item.top)<10);
    if(!row){ row={ top:item.top, bottom:item.bottom, items:[] }; rows.push(row); }
    row.bottom=Math.max(row.bottom,item.bottom);
    row.items.push(item);
  });
  rows.forEach(row=>row.items.sort((a,b)=>a.left-b.left));
  return { kind:"grid", items, rows };
}
function clearDropMarks(){
  if(dropCard) dropCard.classList.remove("drop-before","drop-after");
  dropCard=null;
  dropAfter=null;
}
function applyDropMark(card, after){
  if(dropCard===card && dropAfter===after) return;
  clearDropMarks();
  dropCard=card;
  dropAfter=after;
  card.classList.add(after ? "drop-after" : "drop-before");
}
function resolveListDrop(layout, clientY){
  const ordered=layout.items;
  if(!ordered.length) return null;
  const first=ordered[0], last=ordered[ordered.length-1];
  if(clientY<=first.top) return { card:first.card, toId:first.id, after:false };
  if(clientY>=last.bottom) return { card:last.card, toId:last.id, after:true };
  const item=ordered.reduce((nearest,candidate)=>{
    const candidateDistance=clientY<candidate.top ? candidate.top-clientY : clientY>candidate.bottom ? clientY-candidate.bottom : 0;
    const nearestDistance=clientY<nearest.top ? nearest.top-clientY : clientY>nearest.bottom ? clientY-nearest.bottom : 0;
    return candidateDistance<nearestDistance ? candidate : nearest;
  },first);
  return { card:item.card, toId:item.id, after:clientY>item.top+item.height/2 };
}
function resolveGridDrop(layout, clientX, clientY){
  const rows=layout.rows;
  if(!rows.length) return null;
  if(clientY<=rows[0].top) {
    const item=rows[0].items[0];
    return { card:item.card, toId:item.id, after:false };
  }
  if(clientY>=rows[rows.length-1].bottom){
    const lastRow=rows[rows.length-1], item=lastRow.items[lastRow.items.length-1];
    return { card:item.card, toId:item.id, after:true };
  }
  let row=rows.find(item=>clientY>=item.top && clientY<=item.bottom);
  if(!row){
    const nextRow=rows.find(item=>clientY<item.top);
    if(nextRow){ const item=nextRow.items[0]; return { card:item.card, toId:item.id, after:false }; }
    row=rows[rows.length-1];
  }
  const nextItem=row.items.find(item=>clientX<item.left+item.width/2);
  if(nextItem) return { card:nextItem.card, toId:nextItem.id, after:false };
  const item=row.items[row.items.length-1];
  return { card:item.card, toId:item.id, after:true };
}
function resolveStationDrop(layout, clientX, clientY){
  if(!layout || !layout.items.length) return null;
  return layout.kind==="grid" ? resolveGridDrop(layout,clientX,clientY) : resolveListDrop(layout,clientY);
}
// 列表视图实时让位：按当前落点把源卡片插入新顺序，其余卡片用 translateY 平滑腾出空位，
// 拖到哪里空位就开到哪里，排序效果一目了然。网格是多列二维布局，单轴位移无法表达，
// 退回插入线指示（drop-before/drop-after）。
function applyListShifts(drag, drop){
  const items=drag.layout.items;
  const sourceHeight=Number.isFinite(drag.sourceHeight) ? drag.sourceHeight : 0;
  if(!items.length || !sourceHeight) return;
  const gap=items.length>1 ? items[1].top-(items[0].top+items[0].height) : 10;
  let insertIndex=items.length;
  if(drop){
    const idx=items.findIndex(item=>item.id===drop.toId);
    if(idx>=0) insertIndex=drop.after ? idx+1 : idx;
  }
  // 基准取列表首个可见位置（源卡片原本可能在最前，items 已把它排除）。
  const startY=Math.min(items[0].top, Number.isFinite(drag.sourceTop) ? drag.sourceTop : Infinity);
  let y=startY;
  const targets=new Map();
  items.forEach((item,index)=>{
    if(index===insertIndex) y+=sourceHeight+gap;
    targets.set(item.card, Math.round(y-item.top));
    y+=item.height+gap;
  });
  items.forEach(item=>{
    const shift=targets.get(item.card)||0;
    if(shift===(dragShifts.get(item.card)||0)) return;
    if(shift){
      item.card.classList.add("drag-shift");
      item.card.style.transform=`translateY(${shift}px)`;
      dragShifts.set(item.card,shift);
    }else{
      item.card.style.transform="";
      item.card.classList.remove("drag-shift");   // 回到原位即摘除让位类，避免一次长拖拽累积 z-index/GPU 层
      dragShifts.delete(item.card);
    }
  });
}
// 未提交（原地放手 / pointercancel）时让所有卡片带过渡平滑复位；
// .drag-shift 类等 220ms 位移过渡播完后再摘除，避免残留到下一次交互。
function clearStationShifts(){
  dragShifts.forEach((_shift,card)=>{
    card.style.transform="";
    setTimeout(()=>{ card.classList.remove("drag-shift"); },260);
  });
  dragShifts.clear();
}
function cancelStationDragFrame(drag){
  if(!drag || drag.moveFrame===null) return;
  if(typeof cancelAnimationFrame === "function") cancelAnimationFrame(drag.moveFrame);
  else clearTimeout(drag.moveFrame);
  drag.moveFrame=null;
}
function updateStationDragDrop(drag, point){
  if(activeDrag!==drag || !drag.moved || !point) return;
  if(drag.layoutInvalid || !drag.layout){
    drag.layout=captureStationDropLayout(drag.root,drag.fromId);
    drag.layoutInvalid=false;
  }
  const drop=resolveStationDrop(drag.layout,point.x,point.y);
  drag.drop=drop ? { toId:drop.toId, after:drop.after } : null;
  if(drop) applyDropMark(drop.card,drop.after); else clearDropMarks();
  if(drag.layout.kind==="list") applyListShifts(drag, drop);
}
function queueStationDragDrop(drag){
  if(!drag || drag.moveFrame!==null) return;
  const commit=()=>{
    drag.moveFrame=null;
    updateStationDragDrop(drag,drag.pendingPoint);
  };
  drag.moveFrame=typeof requestAnimationFrame === "function" ? requestAnimationFrame(commit) : setTimeout(commit,0);
}
function flushStationDragDrop(drag){
  cancelStationDragFrame(drag);
  updateStationDragDrop(drag,drag.pendingPoint);
}
function invalidateStationDragLayout(){
  const drag=activeDrag;
  if(!drag || !drag.moved) return;
  drag.layoutInvalid=true;
  queueStationDragDrop(drag);
}
function cancelQueuedRenderForDrag(){
  let cancelled=false;
  if(scheduledRenderHandle!==null){
    if(typeof cancelAnimationFrame === "function") cancelAnimationFrame(scheduledRenderHandle);
    else clearTimeout(scheduledRenderHandle);
    scheduledRenderHandle=null;
    cancelled=true;
  }
  if(renderRestoreFrame){
    if(typeof cancelAnimationFrame === "function") cancelAnimationFrame(renderRestoreFrame);
    else clearTimeout(renderRestoreFrame);
    renderRestoreFrame=0;
    cancelled=true;
  }
  if(cancelled) renderAfterDrag=true;
}
function beginStationDrag(event){
  const root=event.currentTarget;
  const handle=event.target.closest("[data-station-drag-handle]");
  if(!handle || !root.contains(handle) || isSearchFiltered() || event.isPrimary===false || (event.pointerType==="mouse" && event.button!==0)) return;
  if(activeDrag) cancelStationDrag();
  const source=handle.closest(".row-item[data-id], .card[data-id]");
  if(!source || !root.contains(source)) return;
  cancelQueuedRenderForDrag();
  activeDrag={ root, handle, pointerId:event.pointerId, fromId:source.dataset.id, source, startX:event.clientX, startY:event.clientY, moved:false, drop:null, layout:null, layoutInvalid:true, pendingPoint:null, moveFrame:null };
  try{ handle.setPointerCapture(event.pointerId); }catch(_){}
  handle.addEventListener("lostpointercapture", cancelStationDrag, { once:true });
  event.preventDefault();
  event.stopPropagation();
}
function moveStationDrag(event){
  const drag=activeDrag;
  if(!drag || event.pointerId!==drag.pointerId) return;
  if(isSearchFiltered()){
    cancelStationDrag(event);
    return;
  }
  const distance=Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY);
  if(!drag.moved && distance<5) return;
  if(!drag.moved){
    drag.moved=true;
    const rect=drag.source.getBoundingClientRect();
    drag.sourceTop=rect.top;
    drag.sourceHeight=rect.height;
    drag.source.classList.add("dragging");
    drag.root.classList.add("drag-active");
  }
  // 源卡片完全跟手浮起：transform 直接等于指针增量、不加过渡，所见即所得；
  // 落点与让位计算已由 queueStationDragDrop 合并到一帧内完成。
  drag.source.style.transform=`translate(${event.clientX-drag.startX}px,${event.clientY-drag.startY}px)`;
  event.preventDefault();
  drag.pendingPoint={ x:event.clientX, y:event.clientY };
  // 浏览器最多一帧计算一次落点；长列表拖动时不会因指针采样率而反复强制布局。
  queueStationDragDrop(drag);
}
function finishStationDrag(event, commit){
  const drag=activeDrag;
  if(!drag || (event && "pointerId" in event && event.pointerId!==drag.pointerId)) return;
  if(commit && drag.moved && event) drag.pendingPoint={ x:event.clientX, y:event.clientY };
  if(commit && drag.moved) flushStationDragDrop(drag); else cancelStationDragFrame(drag);
  const latestDrop=commit && drag.moved ? drag.drop : null;
  const deferred=renderAfterDrag;
  clearDropMarks();
  drag.source.classList.remove("dragging");
  drag.source.style.transform="";
  drag.root.classList.remove("drag-active");
  activeDrag=null;
  if(drag.moved) suppressStationOpenClickUntil=performance.now()+420;
  try{ if(drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId); }catch(_){}
  renderAfterDrag=false;
  if(latestDrop && reorder(drag.fromId,latestDrop.toId,latestDrop.after)){
    renderWithStationFlip(()=>render({ preserveModelAnchors:false }));
    dragShifts.clear(); // 旧卡片已随重绘移除，只清引用，不再触碰样式
    toast("已调整顺序", "ok");
  }else{
    // 未提交或顺序未变：让位/跟随的卡片带过渡平滑归位。
    clearStationShifts();
    if(deferred) scheduleRender();
  }
}
// 排序提交后的 FLIP 过渡：重绘前记录各站点的视觉位置，重绘后把位移的卡片从旧位置
// 平滑滑到新位置。让位动画已把多数卡片提前送到目标位，这里只补齐最后一小段，
// 避免整列在松手瞬间跳变。
function renderWithStationFlip(renderFn){
  const before=new Map();
  document.querySelectorAll(".row-item[data-id], .card[data-id]").forEach(el=>{
    const rect=el.getBoundingClientRect();
    if(rect.width||rect.height) before.set(el.dataset.id, rect.top);
  });
  renderFn();
  const moved=[];
  document.querySelectorAll(".row-item[data-id], .card[data-id]").forEach(el=>{
    const prevTop=before.get(el.dataset.id);
    if(prevTop==null) return;
    const delta=prevTop-el.getBoundingClientRect().top;
    if(Math.abs(delta)<2) return;
    el.style.transition="none";
    el.style.transform=`translateY(${delta}px)`;
    moved.push(el);
  });
  if(!moved.length) return;
  void moved[0].offsetWidth; // 先提交初始位移，再开过渡归零
  moved.forEach(el=>{
    el.style.transition="transform .24s cubic-bezier(.2,.9,.25,1)";
    el.style.transform="";
    el.addEventListener("transitionend",()=>{ el.style.transition=""; },{once:true});
  });
}
function endStationDrag(event){ finishStationDrag(event,true); }
function cancelStationDrag(event){ finishStationDrag(event,false); }
function attachDrag(scope){
  const root=document.querySelector(scope);
  if(!root || root.dataset.dragBound==="true") return;
  root.dataset.dragBound="true";
  root.addEventListener("pointerdown",beginStationDrag);
  root.addEventListener("pointermove",moveStationDrag);
  root.addEventListener("pointerup",endStationDrag);
  root.addEventListener("pointercancel",cancelStationDrag);
  if(!dragGlobalEventsBound){
    dragGlobalEventsBound=true;
    window.addEventListener("blur",()=>cancelStationDrag());
    window.addEventListener("resize",invalidateStationDragLayout);
    // 页面或可滚动容器滚动后，下一帧才重新取一次坐标，避免缓存坐标陈旧。
    document.addEventListener("scroll",invalidateStationDragLayout,true);
    document.addEventListener("visibilitychange",()=>{ if(document.hidden) cancelStationDrag(); });
  }
}
// 显式携带落点方向，删除原项后再定位目标项，杜绝复用上一轮拖拽方向。
function reorder(fromId, toId, after){
  if(isSearchFiltered()){ toast("请先清空搜索再调整顺序", "warn"); return false; }
  if(!fromId || !toId || fromId===toId) return false;
  byOrder();
  const previous=stations.slice();
  const from=previous.find(st=>st.id===fromId);
  const target=previous.find(st=>st.id===toId);
  if(!from || !target) return false;
  const next=previous.filter(st=>st.id!==fromId);
  const targetIndex=next.findIndex(st=>st.id===toId);
  if(targetIndex<0) return false;
  next.splice(after ? targetIndex+1 : targetIndex,0,from);
  if(next.every((station,index)=>station===previous[index])) return false;
  stations=next;
  stations.forEach((station,index)=>{ station.order=index; });
  save();
  return true;
}

/* ---------------- 选中 / 专注 ---------------- */
// 列表可能很长；一键把当前正在查看的站点滚动到视野中央，并用主色描边闪烁两下。
function locateActiveStation(){
  const id=focusId || selectedId;
  if(!id || !getById(id)){ toast("还没有选中的站点，先在左侧点开一个", "warn"); return; }
  const row=document.querySelector(`#listPane .row-item[data-id="${cssEscape(id)}"]`);
  if(!row){ toast("当前站点不在搜索结果中，请先清空搜索", "warn"); return; }
  row.scrollIntoView({ block:"center", behavior:"smooth" });
  row.classList.remove("locate-flash");
  void row.offsetWidth; // 重新触发动画
  row.classList.add("locate-flash");
  row.addEventListener("animationend",()=>row.classList.remove("locate-flash"),{once:true});
}
function cssEscape(value){
  return window.CSS && typeof CSS.escape==="function" ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g,"\\$&");
}
// 点击行/卡：网格或窄屏→整页专注；宽屏列表→选中并刷新右栏
function onStationClick(id){
  if(settings.view==="grid" || isNarrow()){ openFocus(id); }
  else { selectStation(id); }
}
function selectStation(id){
  rememberCurrentModelSelection();
  selectedId = id;
  restoreModelSelection(id);
  saveUIState();
  document.querySelectorAll("#listPane .row-item").forEach(r=> r.classList.toggle("selected", r.dataset.id===id));
  const st = getById(id); const dp = document.getElementById("detailPane");
  if(st) renderDetailInto(dp, st, false); else dp.innerHTML = emptyDetail();
}
function openFocus(id){
  rememberCurrentModelSelection();
  focusReturnScroll=captureScrollState();
  focusReturnStationId=id;
  focusId = id;
  selectedId = id;
  restoreModelSelection(id);
  saveUIState();
  render({ scrollTarget:"focus-top" });
}
function restoreStationOpenFocus(id){
  if(!id) return;
  const apply=()=>{
    const target=[...document.querySelectorAll("[data-open-station]")].find(button=>button.dataset.openStation===id);
    if(!(target instanceof HTMLElement)) return;
    try{ target.focus({ preventScroll:true }); }catch(_){ target.focus(); }
  };
  if(typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
  else setTimeout(apply,0);
}
function closeFocus(){
  const returnState=focusReturnScroll;
  const returnStationId=focusReturnStationId || focusId;
  focusReturnScroll=null;
  focusReturnStationId=null;
  focusId = null;
  render({ scrollState:returnState || captureScrollState() });
  restoreStationOpenFocus(returnStationId);
}

/* ---------------- 详情（右侧栏 / 专注页共用） ---------------- */
// 详情标题承载当前诊断和两项高频操作；模型获取仍留在模型区，避免把三种请求混在一组。
function detailHTML(st, isFocus){
  const map={unknown:["未诊断","unknown"],online:["连通正常","online"],reachable:["服务可达","online"],offline:["连接失败","offline"],testing:["检测中","testing"]};
  const [txt,cls]=map[st.status.connectivity]||map.unknown;
  const activity=getStationActivity(st);
  const missingConfig=!hasStationCredentials(st);
  const connectionBusy=activity.connection;
  const balanceBusy=activity.balance;
  const modelListBusy=activity.modelList;
  const batchBusy=activity.batch;
  // 余额接口可独立于 /v1/models 工作；即使模型连通性未通过，也允许直接查询管理余额接口。
  const balanceDisabled=missingConfig || connectionBusy || balanceBusy;
  // 连通性结果只是诊断记录；模型操作只与「诊断正在执行」及自身请求互斥。
  const modelControlsDisabled=missingConfig || connectionBusy || activity.modelWork;
  const stationBusy=activity.any;
  const selectedCount = st.models.reduce((count,model)=>count+(selectedModels.has(model.id)?1:0),0);
  // 未选择模型时不提供无效的批量入口；原生 disabled 保持按钮尺寸，选择后再启用，不会触发布局变化。
  const batchDisabled = modelControlsDisabled || selectedCount === 0;
  const balanceTxt = hasBalance(st) ? balanceDisplay(st) : "已获取（查看原始返回）";
  const balanceMeta=[st.status.balanceSource,st.status.balanceNote].filter(Boolean).join(" · ");
  const balanceActionLabel=balanceBusy ? SPINNER_ICON+"余额获取中…" : "查询余额";
  const modelFetchLabel=modelListBusy ? SPINNER_ICON+"获取中…" : "获取模型列表";
  const feedback=[];
  if(missingConfig){
    feedback.push(`<span class="detail-feedback-item error">请先通过编辑或快速导入填写 Base URL 和 API Key。</span>`);
  }else if(st.status.connectivity==="offline"){
    feedback.push(`<span class="detail-feedback-item error" title="${esc(st.status.error || "该诊断请求未通过。")}">诊断原因：${esc(st.status.error || "该诊断请求未通过。")}；模型列表、模型测试和批量测试仍可单独发起。</span>`);
  }else if(st.status.connectivity==="reachable"){
    feedback.push(`<span class="detail-feedback-item error" title="${esc(st.status.error || "服务可达，但认证响应受浏览器跨域限制。")}">${esc(st.status.error || "服务可达，但认证响应受浏览器跨域限制。")}</span><button type="button" class="inline-action" id="dwProxySetup">配置可信代理</button>`);
  }
  if(hasBalance(st) || st.status.balanceRaw!==null){
    const balanceTitle=[balanceTxt,balanceMeta].filter(Boolean).join(" · ");
    feedback.push(`<span class="detail-feedback-item" title="${esc(balanceTitle)}"><strong>${esc(balanceLabel(st))}：</strong>${esc(balanceTxt)}${balanceMeta?` · ${esc(balanceMeta)}`:""}</span>`);
  }
  if(st.status.balanceError){
    feedback.push(`<span class="detail-feedback-item error" title="${esc(st.status.balanceError)}">余额查询失败：${esc(st.status.balanceError)}</span>`);
  }
  if(st.status.balanceRaw!==null){
    feedback.push(`<details class="raw"><summary>查看原始返回</summary><pre>${esc(JSON.stringify(st.status.balanceRaw,null,2))}</pre></details>`);
  }
  const feedbackHtml=feedback.length ? `<div class="detail-feedback">${feedback.join("")}</div>` : "";
  const displayModels = modelDisplayOrder(st);
  const depthLabel = TEST_DEPTH_LABELS[settings.testDepth] || settings.testDepth;
  const modelsHtml = displayModels.length ? displayModels.map(({model:m,index})=>{
    const manualAtCapacity = manualModelTestCount(st.id) >= settings.concurrency && m.test!=="testing";
    const modelTestDisabled = missingConfig || connectionBusy || modelListBusy || batchBusy || m.test==="testing" || manualAtCapacity;
    const selected=selectedModels.has(m.id);
    const visualState=modelVisualState(m);
    const modelInputId=`dwModel-${st.id}-${index}`;
    const testTitle=missingConfig ? "请先填写 Base URL 和 API Key" : m.test==="testing" ? "该模型正在测试" : manualAtCapacity ? "已达到模型测试并发上限" : batchBusy ? "批量测试进行中" : modelListBusy ? "正在获取模型列表" : connectionBusy ? "连通性诊断进行中" : "按「"+depthLabel+"」档测试此模型";
    const cap=m.capability;
    // 有能力报告时状态位直接显示判定结果；没有就沿用旧的成功/失败文案，不并列两套说法。
    const stateLabel=cap ? (CAPABILITY_GRADE_LABELS[cap.grade] || cap.grade)
      : visualState==="ok"?"测试成功":visualState==="slow"?"延迟较高":visualState==="fail"?"测试失败":visualState==="testing"?"测试中":"未测试";
    const stateCls=cap && cap.grade==="limited" ? "limited" : visualState;
    const stateTitle=cap ? capabilitySummary(cap)+(m.err?"；"+m.err:"") : (m.err || "");
    const ttft=cap && cap.metrics && Number.isFinite(cap.metrics.ttft) ? Math.round(cap.metrics.ttft) : null;
    // 逐项结果直接平铺一行：条目最多 7 个，比折叠面板少一次点击，也不额外占高。
    const probeHtml=cap ? `<div class="m-probes">${cap.probes.map(probe=>{
      const label=PROBE_LABELS[probe.key] || probe.key;
      const mark=probe.state==="pass" ? "✓" : probe.state==="fail" ? "✕" : "–";
      const word=probe.state==="pass" ? "通过" : probe.state==="fail" ? "未通过" : "跳过";
      const detail=probe.detail ? "：" + probe.detail : "";
      return `<span class="probe ${probe.state}" title="${esc(label+" "+word+detail)}" aria-label="${esc(label+" "+word+detail)}">${esc(label)}<b>${mark}</b></span>`;
    }).join("")}</div>` : "";
    return `
      <div class="model model-state-${visualState} ${selected?"selected":""}" data-model-id="${esc(m.id)}">
        <input id="${esc(modelInputId)}" type="checkbox" data-m="${esc(m.id)}" ${selected?"checked":""} ${modelControlsDisabled?"disabled":""}>
        <div class="m-main">
          <div class="model-name-row"><label class="model-select" for="${esc(modelInputId)}" title="切换选择 ${esc(m.id)}"><span class="mname">${esc(m.id)}</span></label><button type="button" class="btn model-run" data-model-test="${esc(m.id)}" ${modelTestDisabled?"disabled":""} title="${esc(testTitle)}" aria-label="${esc(testTitle)}" aria-busy="${m.test==="testing"?"true":"false"}">${m.test==="testing"?SPINNER_ICON:LIGHTNING_ICON}</button><button type="button" class="btn model-copy" data-copy="${esc(m.id)}" title="复制模型 ID" aria-label="复制模型 ID ${esc(m.id)}">${COPY_ICON}</button></div>
          <div class="m-meta"><span class="mst ${stateCls}"${stateTitle?` title="${esc(stateTitle)}"`:""}>${esc(stateLabel)}</span><span class="mlat ${latencyCls(m.latency)}">${fmtLat(m.latency)}</span>${ttft!==null?`<span class="mttft" title="流式首字延迟">首字 ${ttft}ms</span>`:""}</div>
          ${probeHtml}
        </div>
      </div>`;
  }).join("")
    : `<div class="models-empty muted">暂无模型，点「获取列表」拉取。</div>`;

  return `
    <div class="detail-head">
      ${isFocus?`<button type="button" class="btn sm" id="dwBack">← 返回</button>`:""}
      <div class="detail-title"><span class="badge ${cls}"><span class="d ${cls}"></span>${txt}</span><span class="d-name">${esc(st.name)}</span></div>
      <div class="detail-head-actions" role="group" aria-label="${esc(st.name)} 的余额操作">
        <button type="button" class="btn action sm" id="dwBal" ${balanceDisabled?"disabled":""} aria-busy="${balanceBusy?"true":"false"}" title="${missingConfig?"请先填写 Base URL 和 API Key":"查询可用余额或额度"}">${balanceActionLabel}</button>
      </div>
    </div>
    ${feedbackHtml}

    <div class="sec">
      <div class="model-toolbar">
        <div class="model-toolbar-heading"><span class="title">模型（${st.models.length}）</span><span class="selection-count" title="批量测试并发 ${esc(settings.concurrency)}">已选 ${selectedCount} · 并发 ${esc(settings.concurrency)}</span></div>
        <div class="model-toolbar-groups">
          <div class="model-tools-group data-tools ${settings.modelSort!=="source"?"has-refresh":""}" role="group" aria-label="模型数据操作">
            <button type="button" class="btn action sm" id="dwFetch" ${modelControlsDisabled?"disabled":""} aria-busy="${modelListBusy?"true":"false"}" title="从当前站点获取模型列表">${modelFetchLabel}</button>
            <label class="model-sort" for="dwModelSort"><span>排序</span><select id="dwModelSort" aria-label="模型排序方式" ${!st.models.length?"disabled":""}>
              <option value="source" ${settings.modelSort==="source"?"selected":""}>获取顺序</option>
              <option value="available" ${settings.modelSort==="available"?"selected":""}>可用性</option>
              <option value="latency" ${settings.modelSort==="latency"?"selected":""}>响应速度</option>
            </select></label>
          </div>
          <div class="model-tools-group selection-tools" role="group" aria-label="模型选择与测试">
            <label class="model-sort" for="dwTestDepth"><span>测试</span><select id="dwTestDepth" aria-label="测试深度" title="连通：只验证能否调通（1 次请求）&#10;标准：验证能否正常使用，含流式与多轮（3 次）&#10;深度：再验证工具调用、JSON 与长上下文（6 次）">
              <option value="ping" ${settings.testDepth==="ping"?"selected":""}>连通</option>
              <option value="basic" ${settings.testDepth==="basic"?"selected":""}>标准</option>
              <option value="deep" ${settings.testDepth==="deep"?"selected":""}>深度</option>
            </select></label>
            <button type="button" class="btn sm" id="dwToggleSelection" ${modelControlsDisabled?"disabled":""} title="${selectedCount ? "清空当前选择" : "选择全部模型"}" aria-label="${selectedCount ? "清空当前选择" : "选择全部模型"}">${selectedCount ? "清空已选" : "全选"}</button>
            <button type="button" class="btn primary sm" id="dwBatch" data-controls-disabled="${modelControlsDisabled?"true":"false"}" ${batchDisabled?"disabled":""} aria-busy="${batchBusy?"true":"false"}" title="${batchBusy?"正在批量测试选中的模型":selectedCount?"按「"+depthLabel+"」档测试选中的模型":"请先选择要测试的模型"}">${batchBusy?SPINNER_ICON+"批量测试中…":"测试选中"}</button>
          </div>
        </div>
      </div>
      ${st.status.modelListError?`<div class="models-error">最近获取失败：${esc(st.status.modelListError)}</div>`:""}
      <div class="models" id="dwModels">${modelsHtml}</div>
      ${requestLogPanelMarkup(st)}
    </div>

    <div class="sec">
      <div class="sec-h"><span class="title">连接信息</span></div>
      <div class="connection-grid">
        <div class="field"><label>Base URL</label><div class="val"><span class="txt">${esc(st.baseurl)}</span><button type="button" data-copy="${esc(st.baseurl)}" title="复制 Base URL" aria-label="复制 Base URL">${COPY_ICON}</button></div></div>
        <div class="field"><label>API Key</label><div class="val">${apiKeyControlsMarkup(st,{detail:true,displayId:"dwKey",toggleId:"dwKeyToggle"})}</div></div>
        ${st.group?`<div class="field"><label>分组</label><div class="val"><span class="txt">${esc(st.group)}</span></div></div>`:""}
        ${st.note?`<div class="field wide"><label>备注</label><div class="val"><span class="txt">${esc(st.note)}</span></div></div>`:""}
      </div>
    </div>

  `;
}

// 详情重绘时除了像素滚动量，还保存当前可见模型锚点与焦点，避免 100 个模型的状态刷新把用户甩回列表顶部。
function captureDetailRenderState(container, options={}){
  const preserveModelAnchor=options.preserveModelAnchor !== false;
  const models=container.querySelector(".models");
  let modelAnchor=null;
  if(preserveModelAnchor && models){
    const modelsRect=models.getBoundingClientRect();
    const visible=[...models.querySelectorAll(".model")].find(card=>card.getBoundingClientRect().bottom > modelsRect.top + 1);
    if(visible){
      modelAnchor={ id:visible.dataset.modelId || "", offset:visible.getBoundingClientRect().top-modelsRect.top };
    }
  }
  const active=document.activeElement;
  let focus=null;
  if(active instanceof HTMLElement && container.contains(active)){
    // 只恢复操作控件和模型勾选框；不记录或派生任何敏感字段的值。
    if(active.id) focus={kind:"id",value:active.id};
    else if(active.dataset.modelTest!=null) focus={kind:"model-test",value:active.dataset.modelTest};
    else if(active.dataset.m!=null) focus={kind:"model-check",value:active.dataset.m};
  }
  return {
    panelTop:container.scrollTop,
    panelLeft:container.scrollLeft,
    modelTop:models ? models.scrollTop : 0,
    modelAnchor,
    rawOpen:!!container.querySelector("details.raw[open]"),
    focus
  };
}
function findDetailFocusable(container, focus){
  if(!focus) return null;
  if(focus.kind==="id") return [...container.querySelectorAll("[id]")].find(element=>element.id===focus.value) || null;
  if(focus.kind==="model-test") return [...container.querySelectorAll("[data-model-test]")].find(element=>element.dataset.modelTest===focus.value) || null;
  if(focus.kind==="model-check") return [...container.querySelectorAll("[data-m]")].find(element=>element.dataset.m===focus.value) || null;
  return null;
}
function restoreDetailRenderState(container, state){
  container.scrollTop=state.panelTop || 0;
  container.scrollLeft=state.panelLeft || 0;
  const models=container.querySelector(".models");
  if(models){
    models.scrollTop=state.modelTop || 0;
    if(state.modelAnchor && state.modelAnchor.id){
      const anchor=[...models.querySelectorAll(".model")].find(card=>card.dataset.modelId===state.modelAnchor.id);
      if(anchor){
        const offset=anchor.getBoundingClientRect().top-models.getBoundingClientRect().top;
        models.scrollTop += offset-state.modelAnchor.offset;
      }
    }
  }
  const raw=container.querySelector("details.raw");
  if(raw) raw.open=state.rawOpen;
  const nextFocus=findDetailFocusable(container,state.focus);
  if(nextFocus instanceof HTMLElement && !nextFocus.hasAttribute("disabled")){
    try{ nextFocus.focus({ preventScroll:true }); }catch(_){ nextFocus.focus(); }
  }
}
function renderDetailInto(container, st, isFocus, options={}){
  const state=captureDetailRenderState(container, options);
  container.innerHTML = detailHTML(st, isFocus);
  bindDetail(container, st);
  restoreDetailRenderState(container,state);
}

// 绑定详情内所有按钮与勾选框
function bindDetail(c, st){
  const id = st.id;
  const proxySetup=c.querySelector("#dwProxySetup"); if(proxySetup) proxySetup.onclick=openSettings;
  const bal=c.querySelector("#dwBal"); if(bal && !bal.disabled) bal.onclick=()=>fetchBalance(id);
  const fet=c.querySelector("#dwFetch"); if(fet && !fet.disabled) fet.onclick=()=>fetchModels(id);
  const sort=c.querySelector("#dwModelSort"); if(sort && !sort.disabled) sort.onchange=()=>setModelSort(sort.value);
  const depth=c.querySelector("#dwTestDepth"); if(depth && !depth.disabled) depth.onchange=()=>setTestDepth(depth.value);
  // 批量按钮初始会因“未选择模型”而禁用；仍需预先绑定，勾选后动态启用才能正常触发。
  const bat=c.querySelector("#dwBatch"); if(bat) bat.onclick=()=>batchTest(id);
  // 勾选框 → 维护 selectedModels 唯一真源
  c.querySelectorAll("#dwModels input[type=checkbox]").forEach(ch=>{
    ch.onchange=()=>{
      if(ch.checked) selectedModels.add(ch.dataset.m); else selectedModels.delete(ch.dataset.m);
      rememberCurrentModelSelection();
      const card=ch.closest(".model"); if(card) card.classList.toggle("selected",ch.checked);
      updateSelectionCount(c, st);
    };
  });
  const selectionToggle=c.querySelector("#dwToggleSelection");
  if(selectionToggle && !selectionToggle.disabled) selectionToggle.onclick=()=>{
    // 只按当前站点可见模型判断，避免旧列表 ID 残留时把“全选/清空”语义弄反。
    const visibleSelectedCount=st.models.reduce((count,model)=>count+(selectedModels.has(model.id)?1:0),0);
    const selectAll=st.models.length>0 && visibleSelectedCount===0;
    // 选择集只保存当前站点当前列表的模型，模型列表更新后不保留失效 ID。
    selectedModels.clear();
    c.querySelectorAll("#dwModels input").forEach(ch=>{
      ch.checked=selectAll;
      if(selectAll) selectedModels.add(ch.dataset.m);
      ch.closest(".model")?.classList.toggle("selected",selectAll);
    });
    rememberCurrentModelSelection();
    updateSelectionCount(c, st);
  };
  c.querySelectorAll("[data-model-test]").forEach(button=>{
    if(!button.disabled) button.onclick=()=>testModel(id, button.dataset.modelTest);
  });
  bindApiKeyControls(c);
  c.querySelectorAll("[data-copy]").forEach(b=> b.onclick=()=>copyText(b.dataset.copy));
  const back=c.querySelector("#dwBack"); if(back) back.onclick=closeFocus;
}
function updateSelectionCount(container, st){
  const count=st.models.reduce((total,model)=>total+(selectedModels.has(model.id)?1:0),0);
  const label=container.querySelector(".selection-count");
  if(label) label.textContent="已选 " + count + " · 并发 " + settings.concurrency;
  const selectionToggle=container.querySelector("#dwToggleSelection");
  if(selectionToggle){
    const clearSelection=count>0;
    selectionToggle.textContent=clearSelection ? "清空已选" : "全选";
    selectionToggle.title=clearSelection ? "清空当前选择" : "选择全部模型";
    selectionToggle.setAttribute("aria-label",selectionToggle.title);
  }
  const batch=container.querySelector("#dwBatch");
  if(batch){
    const controlsDisabled=batch.dataset.controlsDisabled === "true";
    batch.disabled=controlsDisabled || count===0;
    // 这里是勾选变化后的增量刷新，档位提示必须与首次渲染的文案一致，否则一勾选就丢档位信息。
    batch.title=batch.getAttribute("aria-busy")==="true" ? "正在批量测试选中的模型"
      : count ? "按「"+(TEST_DEPTH_LABELS[settings.testDepth]||settings.testDepth)+"」档测试选中的模型"
      : "请先选择要测试的模型";
  }
}

// 复制：优先 Clipboard API（需安全上下文 https/localhost）；非安全上下文（如局域网 http）降级 execCommand
function copyText(t){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(()=>toast("已复制","ok")).catch(()=>fallbackCopy(t));
  } else fallbackCopy(t);
}
function fallbackCopy(t){
  const ta=document.createElement("textarea");
  ta.value=t; ta.style.position="fixed"; ta.style.left="-9999px"; ta.style.opacity="0";  // 离屏，避免页面跳动
  document.body.appendChild(ta); ta.focus(); ta.select();
  let ok=false;
  try{ ok=document.execCommand("copy"); }catch(e){ ok=false; }
  ta.remove();
  toast(ok?"已复制":"复制失败（请手动复制）", ok?"ok":"err");   // 据真实返回值提示，不谎报成功
}

/* ---------------- 添加/编辑弹窗 ---------------- */
function setQuickImportFeedback(message="", type="", existingId=null){
  const feedback=document.getElementById("quickImportFeedback");
  const openExisting=document.getElementById("quickImportOpenExisting");
  quickImportExistingId=existingId;
  feedback.textContent=message;
  feedback.className="quick-import-feedback" + (type ? " "+type : "");
  feedback.hidden=!message;
  openExisting.hidden=!existingId;
}
function clearQuickImportTransient(){
  document.getElementById("quickImportText").value="";
  setQuickImportFeedback();
  if(quickImportActive){
    ["f_name","f_baseurl","f_group","f_note","f_balancePath"].forEach(id=>{ document.getElementById(id).value=""; });
    clearFormApiKeyValue();
  }
  quickImportActive=false;
  quickImportExistingId=null;
}
function recognizeQuickImport(){
  try{
    const config=parseQuickImportConfig(document.getElementById("quickImportText").value);
    const existing=findSameStation(config.baseurl, config.apikey);
    if(existing){
      // 已识别出的凭据无需继续滞留在粘贴框；用户可直接打开现有站点。
      document.getElementById("quickImportText").value="";
      setQuickImportFeedback(duplicateStationMessage(existing), "warn", existing.id);
      return;
    }
    // 仅补全当前为空的字段，保留用户已经手动输入的内容（尤其手敲的 API Key）。
    const skipped=[];
    const nameEl=document.getElementById("f_name");
    if(!nameEl.value.trim()) nameEl.value=config.name; else skipped.push("名称");
    const urlEl=document.getElementById("f_baseurl");
    if(!urlEl.value.trim()) urlEl.value=config.baseurl; else skipped.push("Base URL");
    if(!readFormApiKeyValue()) setFormApiKeyValue(config.apikey); else skipped.push("API Key");
    // 成功后立即清除原始粘贴内容，避免明文 Key 长时间留在 textarea 中。
    document.getElementById("quickImportText").value="";
    setQuickImportFeedback(
      skipped.length ? "已填入空白字段；"+skipped.join("、")+"已保留你的输入。请确认后保存。" : "已识别并填入："+config.name+"。请确认后保存。",
      "success"
    );
  }catch(error){
    setQuickImportFeedback(text(error && error.message, 240) || "识别失败，请检查配置格式。", "error");
  }
}
function openQuickImportExisting(){
  const id=quickImportExistingId;
  if(!id || !getById(id)) return;
  hideModal("formModal");
  if(settings.view==="grid" || isNarrow()) openFocus(id);
  else selectStation(id);
}
function openForm(id, options={}){
  editingId = id || null;
  const st = id ? getById(id) : null;
  quickImportActive=!st && options.quick===true;
  document.getElementById("quickImportBox").hidden=!quickImportActive;
  document.getElementById("quickImportText").value="";
  setQuickImportFeedback();
  document.getElementById("formTitle").textContent = st ? "编辑中转站" : quickImportActive ? "快速导入站点" : "添加中转站";
  document.getElementById("f_name").value = st?st.name:"";
  document.getElementById("f_baseurl").value = st?st.baseurl:"";
  setFormApiKeyValue(st?st.apikey:"");
  document.getElementById("f_group").value = st?st.group:"";
  document.getElementById("f_note").value = st?st.note:"";
  document.getElementById("f_balancePath").value = st?st.balancePath:"";
  const hasAdvanced = !!(st && st.balancePath);
  document.getElementById("advBox").style.display = hasAdvanced ? "block" : "none";
  document.getElementById("advToggle").textContent = (hasAdvanced ? "▾ " : "▸ ") + "高级选项";
  document.getElementById("advToggle").setAttribute("aria-expanded", String(hasAdvanced));
  showModal("formModal");
  const focusField=options.focusField || (quickImportActive ? "quickImportText" : "f_name");
  setTimeout(()=>{
    const target=document.getElementById(focusField);
    if(!(target instanceof HTMLElement)) return;
    target.focus();
    // 从连接信息直达编辑时把光标放在 URL 末尾，方便微调且不会误覆盖原配置。
    if(focusField==="f_baseurl" && "setSelectionRange" in target){
      const value=String(target.value || "");
      try{ target.setSelectionRange(value.length,value.length); }catch(_){ /* 某些输入类型不支持选择范围 */ }
    }
  },50);
}
function resetStationRuntime(st){
  modelDisplaySnapshots.delete(st.id);
  st.status = { connectivity:"unknown", latency:null, balance:null, balanceKind:"balance", balanceUnlimited:false, balanceUnit:null, balanceSource:null, balanceNote:null, balanceRaw:null, balanceError:null, modelListError:null, lastTest:null, error:null, transport:null, authMode:"bearer" };
  st.models = [];
}
function saveForm(){
  const name = text(document.getElementById("f_name").value,120);
  const rawBaseurl = document.getElementById("f_baseurl").value;
  const baseurl = normalizeBaseUrl(rawBaseurl);
  const apikey = normalizeApiKey(readFormApiKeyValue());
  const group = text(document.getElementById("f_group").value,80);
  const note = text(document.getElementById("f_note").value,1000);
  const rawBalancePath = document.getElementById("f_balancePath").value;
  const balancePath = normalizeBalancePath(rawBalancePath);
  if(!name || !text(rawBaseurl) || !apikey){ toast("名称、Base URL、API Key 均为必填","warn"); return; }
  if(!baseurl){ toast("请输入有效的 http(s) Base URL","warn"); return; }
  if(balancePath === null){ toast("余额接口路径只能是站内相对路径","warn"); return; }
  const duplicate=findSameStation(baseurl, apikey, editingId);
  if(duplicate){
    toast(duplicateStationMessage(duplicate), "warn");
    return;
  }

  const scrollState=captureScrollState();
  let persisted=false;
  if(editingId){
    const st = getById(editingId);
    if(!st){ hideModal("formModal"); return; }
    const connectionChanged = st.baseurl !== baseurl || st.apikey !== apikey;
    const balancePathChanged = st.balancePath !== balancePath;
    // 持久化失败时需要把单站状态还原到 Object.assign 之前，避免内存与磁盘脱节却谎报成功。
    const stationSnapshot=JSON.stringify(st);
    Object.assign(st, { name, baseurl, apikey, group, note, balancePath });
    // 更换服务地址或密钥后，旧连通性/余额/模型测试均不再可信；让迟到请求失效。
    if(connectionChanged){ revealedApiKeyIds.delete(st.id); invalidateStation(st.id); resetStationRuntime(st); selectedModelsByStation.delete(st.id); if((focusId || selectedId)===st.id) selectedModels.clear(); }
    else if(balancePathChanged){
      // 自定义余额路径变更时同样使未完成请求失效，防止旧路径的响应回写新配置。
      invalidateStation(st.id);
      st.status.balance=null; st.status.balanceKind="balance"; st.status.balanceUnlimited=false;
      st.status.balanceUnit=null; st.status.balanceSource=null; st.status.balanceNote=null; st.status.balanceRaw=null; st.status.balanceError=null;
    }
    persisted=save();
    if(!persisted){
      // 还原单站字段；invalidate/resetStationRuntime 产生的运行时标记对用户不可见，无需回退。
      Object.assign(st, JSON.parse(stationSnapshot));
      toast("保存失败：浏览器存储不可用（已满或被禁用），请先导出备份再清理空间","err");
      return;   // 不关弹窗、不渲染，让用户看到错误并决定如何处理
    }
    toast("已保存修改","ok");
  } else {
    const stationsSnapshot=JSON.stringify(stations);
    const maxOrder = stations.reduce((m,s)=>Math.max(m, s.order), -1);
    stations.push(normalizeStation({ id:uid(), name, baseurl, apikey, group, note, balancePath, order:maxOrder+1 }));
    persisted=save();
    if(!persisted){
      stations=JSON.parse(stationsSnapshot);   // 弹出刚 push 的站点，内存与磁盘保持一致
      toast("保存失败：浏览器存储不可用（已满或被禁用），请先导出备份再清理空间","err");
      return;
    }
    toast("已添加「"+name+"」","ok");
  }
  // 先关闭覆盖层，再以原视口位置更新背景，避免「保存」瞬间看到整页重排。
  hideModal("formModal",{ restoreFocus:false });
  render({ scrollState });
}

/* ---------------- 删除弹窗（单按钮确认） ---------------- */
function openDelete(id){
  const st = getById(id); if(!st) return;
  deletingId = id;
  document.getElementById("delName").textContent = st.name;
  showModal("delModal");
}
function doDelete(){
  const st = getById(deletingId); if(!st) return;
  const scrollState=focusId===deletingId ? (focusReturnScroll || captureScrollState()) : captureScrollState();
  // 删除是结构性变更，持久化失败需整体还原，否则刷新后“已删除”的站点又回来了却无人提示。
  const stationsSnapshot=JSON.stringify(stations);
  const prevSelectedId=selectedId, prevFocusId=focusId, prevFocusReturnScroll=focusReturnScroll, prevFocusReturnStationId=focusReturnStationId;
  invalidateStation(deletingId); // 删除后忽略所有未结束网络请求的迟到响应
  revealedApiKeyIds.delete(deletingId);
  const wasActiveStation = selectedId === deletingId || focusId === deletingId;
  stations = stations.filter(s=>s.id!==deletingId);
  selectedModelsByStation.delete(deletingId);
  stations.forEach((s,i)=> s.order=i);                       // 重整 order
  if(selectedId===deletingId) selectedId = stations.length ? stations[0].id : null;  // 选中项重定向
  if(focusId===deletingId){ focusId = null; focusReturnScroll=null; focusReturnStationId=null; } // 专注页关闭并回到进入前的位置
  // 仅当删除的正是当前展示站点时才重置勾选，并立即恢复新站点已保存的选择；
  // 删除其它站点不得清空当前站点的勾选，否则界面会与持久化数据脱节。
  if(wasActiveStation){
    selectedModels.clear();
    if(selectedId) restoreModelSelection(selectedId);
  }
  const uiOk=saveUIState();
  const dataOk=save();
  if(!dataOk || !uiOk){
    // 还原全部结构性状态，保持删除弹窗打开以便用户处理存储问题后再试。
    stations=JSON.parse(stationsSnapshot);
    selectedId=prevSelectedId; focusId=prevFocusId; focusReturnScroll=prevFocusReturnScroll; focusReturnStationId=prevFocusReturnStationId;
    deletingId=null;
    toast("删除失败：浏览器存储不可用（已满或被禁用），请先导出备份再清理空间","err");
    return;
  }
  deletingId=null;
  hideModal("delModal",{ restoreFocus:false });
  render({ scrollState });
  toast("已删除","ok");
}

/* ---------------- 导入/导出 ---------------- */
function exportJSON(){
  // 导出只包含本项目定义的站点记录；显式列出字段，避免把浏览器会话/其它项目对象混入备份。
  const stationRecords=stations.map(st=>({
    id:st.id,
    name:st.name,
    baseurl:st.baseurl,
    apikey:st.apikey,
    group:st.group,
    note:st.note,
    balancePath:st.balancePath,
    order:st.order,
    status:st.status,
    models:st.models
  }));
  const data = {
    format:EXPORT_FORMAT,
    schemaVersion:1,
    version:VERSION,
    exportedAt:new Date().toISOString(),
    settings,
    stations:stationRecords
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "aihub-stations-"+new Date().toISOString().slice(0,10)+".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),0);
  toast("已导出 JSON（含 API Key，请妥善保存）","ok");
}
function importJSON(file){
  if(!file) return;
  if(file.size > 5 * 1024 * 1024){ toast("导入文件不能超过 5 MB","warn"); return; }
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      // 只接受本项目明确导出的对象格式；兼容早期 AIHubPanel 的“stations”对象，
      // 但拒绝裸数组、session-out.json（records/rawHits）以及未知会话结构，
      // 这样既能恢复本项目旧备份，也不会把其它项目会话误当成站点配置写入本地存储。
      const isCurrentBackup = !!data && typeof data === "object" && !Array.isArray(data) && data.format === EXPORT_FORMAT;
      const legacyStations = !!data && typeof data === "object" && !Array.isArray(data) &&
        data.format == null && Array.isArray(data.stations) &&
        !Object.prototype.hasOwnProperty.call(data,"records") && !Object.prototype.hasOwnProperty.call(data,"rawHits") &&
        data.stations.every(item=>item && typeof item === "object" &&
          (Object.prototype.hasOwnProperty.call(item,"baseurl") || Object.prototype.hasOwnProperty.call(item,"baseURL")) &&
          (Object.prototype.hasOwnProperty.call(item,"apikey") || Object.prototype.hasOwnProperty.call(item,"apiKey")));
      if(!isCurrentBackup && !legacyStations){
        throw new Error("这不是 AIHubPanel 站点备份文件，未导入其它项目会话数据");
      }
      if(data.schemaVersion != null && Number(data.schemaVersion) > 1){
        throw new Error("站点备份版本过新，请先升级 AIHubPanel");
      }
      const rawIncoming = data.stations;
      if(!Array.isArray(rawIncoming)) throw new Error("这不是 AIHubPanel 站点备份文件（未找到 stations 数组）");
      // 早期备份可能使用 baseURL/apiKey 大小写；仅在已通过上面的站点白名单后做字段归一化。
      const incoming = rawIncoming.map(item=>{
        if(!item || typeof item !== "object") return item;
        const normalized = { ...item };
        if(normalized.baseurl == null && typeof normalized.baseURL === "string") normalized.baseurl = normalized.baseURL;
        if(normalized.apikey == null && typeof normalized.apiKey === "string") normalized.apikey = normalized.apiKey;
        return normalized;
      });
      if(incoming.length > 2000) throw new Error("一次最多导入 2000 个中转站");
      const importSettings = data.settings && typeof data.settings === "object" && !Array.isArray(data.settings) ? data.settings : null;
      const importHasProxy = !!importSettings && Object.prototype.hasOwnProperty.call(importSettings,"proxy");
      const skippedProxy = !!importHasProxy && text(importSettings.proxy) !== settings.proxy;
      const normalized = normalizeStations(incoming);
      const norm = normalized.filter(hasStationCredentials);
      const skippedInvalid = normalized.length - norm.length;
      if(!norm.length) throw new Error("备份中没有包含有效 Base URL 与 API Key 的站点");
      // 同 ID 只恢复同一条记录；不同 ID 但 URL+Key 完全相同的记录不再新增，并报告已有站点名。
      const merged = stations.slice();
      const indices = new Map(merged.map((station,index)=>[station.id,index]));
      const duplicateNotes=[];
      let importedCount=0;
      norm.forEach(station=>{
        const targetIndex=indices.has(station.id) ? indices.get(station.id) : -1;
        const credentialKey=stationCredentialKey(station.baseurl,station.apikey);
        const conflict=merged.find((candidate,index)=>index!==targetIndex && stationCredentialKey(candidate.baseurl,candidate.apikey)===credentialKey);
        if(conflict){
          duplicateNotes.push(`导入项「${text(station.name,120)||"未命名"}」：${duplicateStationMessage(conflict)}`);
          return;
        }
        if(targetIndex>=0){
          invalidateStation(merged[targetIndex].id);
          merged[targetIndex]=station;
        }else{
          indices.set(station.id,merged.length);
          merged.push(station);
        }
        importedCount++;
      });
      // 导入是结构性变更；持久化失败必须整体还原，避免刷新后导入项丢失却谎报成功。
      const prevStationsSnapshot=JSON.stringify(stations);
      const prevSettingsSnapshot=JSON.stringify(settings);
      const prevSelectedId=selectedId, prevFocusId=focusId, prevFocusReturnScroll=focusReturnScroll, prevFocusReturnStationId=focusReturnStationId;
      stations = merged;
      // 导入可能替换同 ID 的密钥，完整显示状态不跨导入保留。
      revealedApiKeyIds.clear();
      stations.forEach((s,i)=> s.order=i);
      if(importSettings){
        // 代理会接触所有后续 Bearer 请求；绝不从外部备份静默接管，必须由用户在设置中手动确认。
        const importedSettings = { ...importSettings, proxy: settings.proxy };
        applySettings({ ...settings, ...importedSettings });
      }
      selectedId = getById(selectedId) ? selectedId : (stations[0] ? stations[0].id : null);
      if(focusId && !getById(focusId)){ focusId = null; focusReturnScroll=null; focusReturnStationId=null; }
      selectedModelsByStation = new Map();
      selectedModels.clear();
      restoreModelSelection(selectedId);
      const dataOk=save();
      const settingsOk=saveSettings();
      const uiOk=saveUIState();
      if(!dataOk || !settingsOk || !uiOk){
        // 还原导入前的全部状态并抛错走统一 catch，确保给出明确失败提示。
        stations=JSON.parse(prevStationsSnapshot);
        settings=normalizeSettings(JSON.parse(prevSettingsSnapshot));
        selectedId=prevSelectedId; focusId=prevFocusId; focusReturnScroll=prevFocusReturnScroll; focusReturnStationId=prevFocusReturnStationId;
        selectedModelsByStation = new Map();
        selectedModels.clear();
        restoreModelSelection(selectedId);
        applyTheme(); updateThemeBtn(); render();
        throw new Error("浏览器存储不可用（已满或被禁用），导入已回滚，请先清理空间再重试");
      }
      render();
      const duplicateText=duplicateNotes.length ? "；"+duplicateNotes.slice(0,4).join("；")+(duplicateNotes.length>4?`；另有 ${duplicateNotes.length-4} 个重复项` : "") : "";
      const importedText=importedCount ? `已导入 ${importedCount} 个中转站（每站独立记录）` : "没有新增站点";
      toast(importedText + duplicateText + (skippedInvalid ? "；已跳过 "+skippedInvalid+" 个缺少配置的站点" : "") + (skippedProxy ? "；代理设置未自动导入" : ""), importedCount ? "ok" : "warn");
    }catch(e){
      toast("导入失败：" + e.message, "err");
    }
  };
  reader.onerror = ()=>toast("读取导入文件失败","err");
  reader.readAsText(file);
}

/* ---------------- 设置 + 主题 ---------------- */
function applySettings(next){
  const previousProxy = settings.proxy;
  settings = normalizeSettings(next);
  // 代理变化意味着请求路径已变，旧在线缓存不能再作为后续操作的放行依据。
  if(previousProxy !== settings.proxy){
    stations.forEach(st=>{
      invalidateStation(st.id);
      st.status.connectivity="unknown";
      st.status.latency=null;
      st.status.error=null;
    });
  }
}
function openSettings(){
  document.getElementById("s_theme").value = settings.theme||"system";
  document.getElementById("s_proxy").value = settings.proxy||"";
  document.getElementById("s_concurrency").value = settings.concurrency;
  document.getElementById("s_timeout").value = settings.timeout;
  document.getElementById("s_longcontext").value = settings.longContextKB;
  document.getElementById("s_view").value = settings.view;
  showModal("setModal");
}
function saveSettingsModal(){
  const settingsSnapshot=JSON.stringify(settings);
  applySettings({
    // 排序与测试档位属于详情栏里的即时选择，设置窗口不提供改动项时必须保留当前值。
    modelSort: settings.modelSort,
    testDepth: settings.testDepth,
    theme: document.getElementById("s_theme").value,
    proxy: document.getElementById("s_proxy").value,
    concurrency: document.getElementById("s_concurrency").value,
    timeout: document.getElementById("s_timeout").value,
    longContextKB: document.getElementById("s_longcontext").value,
    view: document.getElementById("s_view").value
  });
  const dataOk=save();
  const settingsOk=saveSettings();
  if(!dataOk || !settingsOk){
    settings=normalizeSettings(JSON.parse(settingsSnapshot));
    applyTheme(); updateThemeBtn(); render();
    toast("设置保存失败：浏览器存储不可用（已满或被禁用），请先导出备份再清理空间","err");
    return;
  }
  render(); hideModal("setModal");
  applyTheme(); updateThemeBtn();
  toast("设置已保存","ok");
}

// 主题图标（跟随系统 / 亮 / 暗）
const THEME_ICONS = {
  light:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  system:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
};
// 应用主题：system 解析为系统 prefers-color-scheme；结果写入 <html data-theme>。
// 暗色走 :root 默认，亮色走 [data-theme="light"] 覆盖。matchMedia 缺失时安全降级暗色。
function applyTheme(){
  const t = settings.theme || "system";
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const dark = mq ? mq.matches : false;
  const resolved = t==="system" ? (dark ? "dark" : "light") : t;
  document.documentElement.dataset.theme = resolved;
}
function updateThemeBtn(){
  const t = settings.theme || "system";
  const btn = document.getElementById("btnTheme");
  const label = "主题：" + (t==="light"?"亮色":t==="dark"?"暗色":"跟随系统");
  if(btn){
    btn.innerHTML = THEME_ICONS[t] || THEME_ICONS.system;
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
  const menuBtn=document.getElementById("menuTheme");
  if(menuBtn){
    menuBtn.innerHTML=(THEME_ICONS[t] || THEME_ICONS.system)+"<span>"+esc(label)+"</span>";
    menuBtn.title=label;
    menuBtn.setAttribute("aria-label", label);
  }
}
// 顶栏主题按钮：亮→暗→跟随系统 三态循环
function cycleTheme(){
  const order = ["light","dark","system"];
  const i = order.indexOf(settings.theme||"system");
  settings.theme = order[(i+1)%3];
  saveSettings(); applyTheme(); updateThemeBtn();
}

/* ---------------- 顶栏更多菜单 ---------------- */
function isMoreMenuOpen(){
  const menu=document.getElementById("moreMenu");
  return !!menu && !menu.hidden;
}
function openMoreMenu(focusFirst=false){
  const menu=document.getElementById("moreMenu");
  const trigger=document.getElementById("btnMore");
  if(!menu || !trigger) return;
  menu.hidden=false;
  trigger.setAttribute("aria-expanded","true");
  if(focusFirst){
    const first=[...menu.querySelectorAll('[role="menuitem"]')].find(item=>item instanceof HTMLElement && item.offsetParent !== null);
    if(first) first.focus();
  }
}
function closeMoreMenu(returnFocus=false){
  const menu=document.getElementById("moreMenu");
  const trigger=document.getElementById("btnMore");
  if(!menu || !trigger) return;
  const wasOpen=!menu.hidden;
  menu.hidden=true;
  trigger.setAttribute("aria-expanded","false");
  if(returnFocus && wasOpen) trigger.focus();
}
function toggleMoreMenu(){
  if(isMoreMenuOpen()) closeMoreMenu(); else openMoreMenu();
}

/* ---------------- modal 通用 ---------------- */
function syncModalScrollLock(){
  const hasOpenModal=!!document.querySelector(".modal.show");
  document.documentElement.classList.toggle("modal-open",hasOpenModal);
  document.body.classList.toggle("modal-open",hasOpenModal);
}
function showModal(id){
  const modal = document.getElementById(id);
  if(!modal) return;
  const active = document.activeElement;
  modalTrigger = active instanceof HTMLElement ? active : null;
  modal.classList.add("show");
  modal.setAttribute("aria-hidden","false");
  syncModalScrollLock();
  setTimeout(()=>{
    if(!modal.classList.contains("show")) return;
    const first = modal.querySelector("input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex='-1'])");
    if(first instanceof HTMLElement) first.focus();
  },0);
}
function hideModal(id, options={}){
  const modal = document.getElementById(id);
  if(!modal) return;
  const restoreFocus=options.restoreFocus!==false;
  modal.classList.remove("show");
  modal.setAttribute("aria-hidden","true");
  syncModalScrollLock();
  if(id==="formModal") clearFormApiKeyValue();
  if(id==="formModal" && quickImportActive) clearQuickImportTransient();
  if(restoreFocus && !document.querySelector(".modal.show") && modalTrigger && document.contains(modalTrigger)) modalTrigger.focus();
  if(!document.querySelector(".modal.show")) modalTrigger = null;
}

/* ---------------- 事件绑定 ---------------- */
function bindGlobal(){
  // 视图切换：grid/list；若在专注页则先退出，保证切换生效
  document.getElementById("viewToggle").addEventListener("click", e=>{
    const b = e.target.closest("button[data-view]"); if(!b) return;
    if(settings.view===b.dataset.view && !focusId) return;
    const scrollState=focusId ? (focusReturnScroll || captureScrollState()) : captureScrollState();
    rememberCurrentModelSelection();
    settings.view = b.dataset.view; saveSettings(); focusId=null; focusReturnScroll=null; focusReturnStationId=null; restoreModelSelection(selectedId); saveUIState(); render({ scrollState });
  });
  document.getElementById("search").addEventListener("input", render);
  document.getElementById("btnAdd").onclick = ()=> openForm(null);
  document.getElementById("btnQuickImport").onclick = ()=> openForm(null, { quick:true });
  document.getElementById("quickImportParse").onclick = recognizeQuickImport;
  document.getElementById("quickImportOpenExisting").onclick = openQuickImportExisting;
  const formKeyInput=document.getElementById("f_apikey");
  const formKeyToggle=document.getElementById("f_apikey_toggle");
  const formKeyCopy=document.getElementById("f_apikey_copy");
  if(formKeyInput){
    formKeyInput.addEventListener("focus",startFormApiKeyEditing);
    formKeyInput.addEventListener("blur",finishFormApiKeyEditing);
    formKeyInput.addEventListener("input",handleFormApiKeyInput);
  }
  if(formKeyToggle){
    // 鼠标点眼睛时保持输入框状态，避免先 blur 再误判当前显隐模式。
    formKeyToggle.onmousedown=event=>event.preventDefault();
    formKeyToggle.onclick=()=>{
      const wasVisible=formApiKeyIsFullyVisible();
      setFormApiKeyVisibility(!wasVisible);
      if(wasVisible && formKeyInput) formKeyInput.blur();
      if(!wasVisible && formKeyInput){
        formKeyInput.focus();
        try{ formKeyInput.setSelectionRange(formKeyInput.value.length,formKeyInput.value.length); }catch(_){ }
      }
    };
  }
  if(formKeyCopy) formKeyCopy.onclick=()=>{
    const value=readFormApiKeyValue();
    if(!value){ toast("暂无可复制的 API Key","warn"); return; }
    copyText(value);
  };
  updateFormApiKeyControls();
  const moreButton=document.getElementById("btnMore");
  const moreMenu=document.getElementById("moreMenu");
  const moreWrap=document.getElementById("moreMenuWrap");
  if(moreButton){
    moreButton.onclick=toggleMoreMenu;
    moreButton.onkeydown=e=>{
      if(e.key==="ArrowDown"){
        e.preventDefault(); openMoreMenu(true);
      }
    };
  }
  if(moreMenu){
    moreMenu.addEventListener("keydown", e=>{
      const items=[...moreMenu.querySelectorAll('[role="menuitem"]')]
        .filter(item=>item instanceof HTMLElement && item.offsetParent !== null);
      const index=items.indexOf(document.activeElement);
      if(e.key==="Escape"){
        e.preventDefault(); e.stopPropagation(); closeMoreMenu(true); return;
      }
      if(!items.length) return;
      let next=-1;
      if(e.key==="ArrowDown") next=(index+1+items.length)%items.length;
      else if(e.key==="ArrowUp") next=(index-1+items.length)%items.length;
      else if(e.key==="Home") next=0;
      else if(e.key==="End") next=items.length-1;
      if(next>=0){ e.preventDefault(); items[next].focus(); }
    });
  }
  if(moreWrap){
    moreWrap.addEventListener("focusout", ()=>setTimeout(()=>{
      if(!moreWrap.contains(document.activeElement)) closeMoreMenu();
    },0));
  }
  document.addEventListener("click", e=>{
    if(moreWrap && !moreWrap.contains(e.target)) closeMoreMenu();
  });
  document.querySelectorAll("[data-menu-action]").forEach(button=>{
    button.onclick=()=>{
      const action=button.dataset.menuAction;
      closeMoreMenu();
      if(action==="quick-import") openForm(null, { quick:true });
      else if(action==="import") document.getElementById("fileInput").click();
      else if(action==="export") exportJSON();
      else if(action==="settings") openSettings();
      else if(action==="theme") cycleTheme();
    };
  });
  document.getElementById("btnExport").onclick = exportJSON;
  document.getElementById("btnImport").onclick = ()=> document.getElementById("fileInput").click();
  document.getElementById("fileInput").onchange = (e)=>{ if(e.target.files[0]) importJSON(e.target.files[0]); e.target.value=""; };
  document.getElementById("btnSettings").onclick = openSettings;
  document.getElementById("setSave").onclick = saveSettingsModal;
  document.getElementById("stationForm").addEventListener("submit", e=>{ e.preventDefault(); saveForm(); });
  document.getElementById("delBtn").onclick = doDelete;
  document.getElementById("btnTheme").onclick = cycleTheme;
  document.getElementById("advToggle").onclick = ()=>{
    const box = document.getElementById("advBox");
    const show = box.style.display!=="block";
    box.style.display = show?"block":"none";
    document.getElementById("advToggle").textContent = (show?"▾ ":"▸ ")+"高级选项";
    document.getElementById("advToggle").setAttribute("aria-expanded", String(show));
  };
  // 站点填写/编辑包含敏感配置，遮罩和 Esc 都不能误关；只能由明确的取消/关闭控件退出。
  document.querySelectorAll("[data-close]").forEach(b=> b.onclick = ()=> hideModal(b.dataset.close));
  document.querySelectorAll(".modal").forEach(m=> m.addEventListener("click", e=>{
    if(e.target===m && m.dataset.backdropClose!=="false") hideModal(m.id);
  }));

  // 键盘快捷键：Esc 关弹窗/退出专注；/ 聚焦搜索；N 新建
  document.addEventListener("keydown", e=>{
    const openModal = document.querySelector(".modal.show");
    if(e.key === "Tab" && openModal){
      const focusable = [...openModal.querySelectorAll("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter(element=>element instanceof HTMLElement && element.offsetParent !== null);
      if(focusable.length){
        const first = focusable[0], last = focusable[focusable.length-1];
        if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
        else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
      }
    }
    if(e.key==="Escape"){
      if(isMoreMenuOpen()){ closeMoreMenu(true); return; }
      if(openModal){
        if(openModal.id!=="formModal") hideModal(openModal.id);
        else e.preventDefault();
        return;
      }
      if(focusId){ closeFocus(); return; }
    }
    if(openModal && quickImportActive && (e.ctrlKey || e.metaKey) && e.key==="Enter"){
      e.preventDefault(); recognizeQuickImport(); return;
    }
    // 弹窗拥有完整键盘焦点范围；其余全局快捷键不得越过遮罩改动后台页面或打开第二个弹窗。
    if(openModal) return;
    if(isMoreMenuOpen()) return;
    if(e.ctrlKey || e.metaKey || e.altKey) return;
    const active = document.activeElement;
    const editing = active && active.matches("input, textarea, select, [contenteditable='true']");
    if(e.key==="/" && !editing){
      e.preventDefault(); document.getElementById("search").focus();
    }
    if((e.key==="n"||e.key==="N") && !editing){
      openForm(null);
    }
  });

  // 跟随系统主题变化：仅当主题为 system 时实时刷新
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  if(mq && mq.addEventListener) mq.addEventListener("change", ()=>{ if((settings.theme||"system")==="system") applyTheme(); });
  else if(mq && mq.addListener) mq.addListener(()=>{ if((settings.theme||"system")==="system") applyTheme(); });   // 旧浏览器兜底

  // 跨过 1024px 断点时重渲染：窄屏隐藏详情，回到宽屏后也能立即恢复右栏内容。
  const layoutMq = window.matchMedia ? window.matchMedia("(max-width:1024px)") : null;
  const onLayoutChange = ()=>render();
  if(layoutMq && layoutMq.addEventListener) layoutMq.addEventListener("change", onLayoutChange);
  else if(layoutMq && layoutMq.addListener) layoutMq.addListener(onLayoutChange);

  window.addEventListener("resize", syncDetailOffset);
  const topbar=document.querySelector(".topbar");
  if(topbar && typeof ResizeObserver === "function") new ResizeObserver(syncDetailOffset).observe(topbar);
}

/* ---------------- 启动 ---------------- */
load();
// 首次打开默认选第一站；若 UI 状态中仍有有效站点，则保持用户上次选择。
selectedId = getById(selectedId) ? selectedId : (stations.length ? stations[0].id : null);
restoreModelSelection(selectedId);
saveUIState();
applyTheme();
updateThemeBtn();
bindGlobal();
render();
syncDetailOffset();
