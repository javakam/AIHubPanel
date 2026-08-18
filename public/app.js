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
const VERSION = 3;                          // 导出文件版本号
const DEFAULT_SETTINGS = Object.freeze({ view:"list", theme:"system", proxy:"", concurrency:5, timeout:15 });
// 本地 server.mjs 可提供受限的同源转发。默认仍由浏览器直连；只有直连受到 CORS
// 或浏览器网络策略拦截时才探测并使用它。Chrome 扩展页面具备 host_permissions，
// 不存在同源 Node 服务，因此绝不尝试 /api/proxy。
const IS_EXTENSION_PAGE = location.protocol === "chrome-extension:";
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
const BALANCE_KINDS = new Set(["balance","quota"]);
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
  group:"主力",
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
let quickImportActive = false;                         // 当前添加弹窗是否处于「粘贴快速导入」模式
let quickImportExistingId = null;                      // 快速识别命中的已有站点，用于定位而不重复新增
const connectivityRequests = new Map();               // 每站仅允许一个连通性探测，避免竞态
const runningBatches = new Map();                      // 正在批量测试的站点及其配置版本，防止重复发起请求
const manualModelTests = new Map();                    // 手动单模型测试在首个 await 前占位，避免与批测交错
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
const ARROW_UP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m18 15-6-6-6 6"/></svg>';
const ARROW_DOWN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';
const RETRY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 11a8 8 0 1 0 2 5.3"/><path d="M20 4v7h-7"/></svg>';

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
  return key.length<=2048 ? key : "";
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
    timeout: clampInt(raw.timeout, 3, 120, DEFAULT_SETTINGS.timeout)
  };
}
function normalizeModel(model){
  const id = text(typeof model === "string" ? model : model && (model.id || model.name), 256);
  if(!id) return null;
  const source = model && typeof model === "object" ? model : {};
  const latency = source.latency === "" || source.latency == null ? NaN : Number(source.latency);
  return {
    id,
    // testing 只代表当前页面内正在进行的请求。页面刷新/关闭后没有对应的运行时请求，
    // 必须恢复为 idle，避免遗留状态永久锁死模型刷新、测试和编辑删除操作。
    test: source.test === "ok" || source.test === "fail" ? source.test : "idle",
    latency: Number.isFinite(latency) && latency >= 0 ? latency : null,
    err: text(source.err, 500) || null
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
}

// 把任意（含旧版/导入）站点对象规整为当前结构，补全缺失字段，保证后续逻辑安全
function normalizeStation(source){
  const s = source && typeof source === "object" ? source : {};
  const status = s.status && typeof s.status === "object" ? s.status : {};
  const latency = status.latency === "" || status.latency == null ? NaN : Number(status.latency);
  const balance = status.balance === "" || status.balance == null ? NaN : Number(status.balance);
  const models = [];
  const modelIds = new Set();
  (Array.isArray(s.models) ? s.models : []).forEach(raw=>{
    const model = normalizeModel(raw);
    if(model && !modelIds.has(model.id)){ modelIds.add(model.id); models.push(model); }
  });
  const balancePath = normalizeBalancePath(s.balancePath);
  return {
    id: normalizeId(s.id),
    name: text(s.name,120) || "未命名",
    baseurl: normalizeBaseUrl(s.baseurl),
    apikey: normalizeApiKey(s.apikey),
    group: text(s.group,80),
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
      balanceRaw: status.balanceRaw == null ? null : status.balanceRaw,
      balanceError: text(status.balanceError,500) || null,
      modelListError: text(status.modelListError,500) || null,
      lastTest: Number.isFinite(Number(status.lastTest)) ? Number(status.lastTest) : null,
      error: text(status.error,500) || null,
      // direct / builtin / custom 只记录最近一次已完成的诊断通道，便于解释 CORS 恢复行为。
      transport: ["direct","builtin","custom"].includes(status.transport) ? status.transport : null,
      authMode: ["bearer","x-api-key"].includes(status.authMode) ? status.authMode : "bearer"
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

// 持久化：仅写 stations / settings 两个 key
function save(){
  try{ localStorage.setItem(LS_STATIONS, JSON.stringify(stations)); return true; }
  catch(e){ console.warn("保存中转站数据失败", e); return false; }
}
function saveSettings(){
  try{ localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); return true; }
  catch(e){ console.warn("保存设置失败", e); return false; }
}

// 按 order 字段排序（就地），保证拖拽/增删后顺序稳定
function byOrder(){ stations.sort((a,b)=> a.order-b.order); }
function getById(id){ return stations.find(s=>s.id===id); }
function hasStationCredentials(st){ return !!(st && st.baseurl && st.apikey); }
function findSameStation(baseurl, apikey, excludeId=null){
  return stations.find(st=>st.id!==excludeId && st.baseurl===baseurl && st.apikey===apikey) || null;
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
    let baseurl, apikey;
    Object.entries(value).forEach(([key,item])=>{
      const name=quickImportFieldName(key);
      if(name==="baseurl") baseurl=item;
      if(name==="apikey") apikey=item;
    });
    if(baseurl !== undefined || apikey !== undefined) pairs.push({ baseurl, apikey });
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
// 因而只会返回同一直接对象中的 baseURL 与 apiKey；截断掉外层花括号的常见粘贴仍可识别。
function collectQuickImportFragmentPairs(input){
  const root={ baseurl:undefined, apikey:undefined };
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
      const frame={ baseurl:undefined, apikey:undefined };
      frames.push(frame); stack.push(frame); cursor++;
      continue;
    }
    if(char==="}"){
      if(stack.length>1) stack.pop();
      else {
        // 片段可能从某对象内部开始。遇到无法配对的 } 时，不能继续用同一个虚拟根，
        // 否则会把该对象前后的字段误认为同一组配置。
        const boundary={ baseurl:undefined, apikey:undefined };
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
    if(field!=="baseurl" && field!=="apikey") continue;
    const valueStart=skipQuickImportTrivia(input,colon+1);
    if(input[valueStart]!=="\"") continue;
    const valueToken=readQuickImportString(input,valueStart);
    if(!valueToken || valueToken.end<=valueStart) break;
    cursor=valueToken.end;
    if(typeof valueToken.value==="string") stack[stack.length-1][field]=valueToken.value;
  }
  return frames.filter(frame=>frame.baseurl!==undefined || frame.apikey!==undefined);
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
    throw new Error("未识别到同一配置对象内的 baseURL 与 apiKey");
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
  if(scheduledRenderHandle !== null) return;
  const commit=()=>{ scheduledRenderHandle=null; render(); };
  scheduledRenderHandle=typeof requestAnimationFrame === "function" ? requestAnimationFrame(commit) : setTimeout(commit,0);
}
function isConnectivityRunning(id){
  const entry = connectivityRequests.get(id);
  return !!entry && entry.revision === stationRevision(id);
}
function isBatchRunning(id){ return runningBatches.get(id) === stationRevision(id); }
function isManualModelTestRunning(id){ return manualModelTests.get(id) === stationRevision(id); }
// 手动单测必须在第一个 await 前占位。批测 worker 不使用这个锁，以便按并发设置运行。
function claimManualModelTest(id, revision){
  if(!isCurrentStation(id, revision) || isManualModelTestRunning(id)) return false;
  manualModelTests.set(id, revision);
  scheduleRender();
  return true;
}
function releaseManualModelTest(id, revision){
  if(manualModelTests.get(id) !== revision) return;
  manualModelTests.delete(id);
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
function networkErrorMessage(error){
  if(error && error.message === "请求超时") return "请求超时";
  if(error && error.aiHubRelayUnavailable) return text(error.message,500);
  if(error instanceof TypeError) return "网络不可达或被 CORS 拦截";
  return text(error && error.message, 500) || "请求失败";
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
  if(IS_EXTENSION_PAGE) return false;
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
      const canUseLocalRelay=!IS_EXTENSION_PAGE && !settings.proxy && isCrossOriginHttpUrl(url) && isCorsLikeError(directError);
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
function localProxyHint(code){
  const hints={
    blocked_target:"内置转发只允许公网 HTTP(S) 地址；内网地址请让站点开启 CORS，或在设置中使用你信任的内网代理。",
    dns_failed:"本机无法解析该站点域名，请检查 Base URL、DNS 或网络。",
    upstream_unavailable:"本地转发已工作，但无法连接目标服务；请检查目标站是否可用、域名是否正确或本机出网限制。",
    upstream_timeout:"本地转发已连接目标，但上游响应超时；可稍后重试或在设置中提高超时。",
    invalid_redirect:"目标服务给出了无效的重定向地址，请检查 Base URL 是否填写为该站点的 API 根地址。",
    too_many_redirects:"目标服务重定向次数过多，请检查 Base URL 是否存在循环跳转。",
    same_origin_required:"内置转发只能由当前面板页面调用，请通过本面板打开后重试。",
    body_too_large:"请求体超过内置转发允许的大小。"
  };
  return hints[code] || "本地同源转发返回了错误。";
}
async function responseError(response){
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
  return message;
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
  const request=mode=>fetchWithTimeout(url,{ ...options, headers:stationAuthHeaders(st,mode,options.headers || {}) },timeoutSeconds);
  let response=await request(preferred);
  if(response.ok){
    if(st && st.status) st.status.authMode=preferred;
    return response;
  }
  if(response.status!==401 && response.status!==403) return response;
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
// 不会阻止之后的模型列表获取、单模型测试或批量测试。
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
    try{
      for(const candidate of connectivityCandidates(st)){
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
              finishResponse(response);
              if(mode && st.status) st.status.authMode=mode;
              const state=candidate.requiresAuth ? "online" : "reachable";
              const routeNote=transport === "builtin" ? "已通过本地同源转发完成请求" : transport === "custom" ? "已通过自定义代理完成请求" : null;
              const note=candidate.requiresAuth ? routeNote : ["服务状态接口可达，尚未验证模型 API Key",routeNote].filter(Boolean).join("；");
              setConn(id, state, latency, note, revision, transport);
              toast(candidate.source+"可用（"+Math.round(latency)+"ms）"+(transport === "builtin" ? "，已自动使用本地同源转发" : ""), candidate.requiresAuth ? "ok" : "warn");
              return { ok:true, latency, state, source:candidate.source, transport };
            }
            const status=response.status;
            const transport=responseTransport(response);
            const message=await responseError(response);
            errors.push(candidate.path+"："+message);
            if(transport === "builtin" && (status===502 || status===504)) hardFailure=true;
            if(!(mode === "bearer" && candidate.requiresAuth && (response.status===401 || response.status===403))) break;
          }catch(error){
            if(!isCurrentStation(id, revision)) return { ok:false, stale:true };
            if(error && error.aiHubRelayUnavailable){
              errors.push(candidate.path+"："+networkErrorMessage(error));
              hardFailure=true;
              break;
            }
            if(isCorsLikeError(error)){
              corsBlocked=true;
              break;
            }
            errors.push(candidate.path+"："+networkErrorMessage(error));
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
          setConn(id, "reachable", latency, note, revision);
          toast("服务可达，但浏览器跨域限制了认证响应", "warn");
          return { ok:true, reachable:true, cors:true, latency };
        }
        if(reachability.error) errors.push("跨域探测："+networkErrorMessage(reachability.error));
      }
      if(!isCurrentStation(id, revision)) return { ok:false, stale:true };
      const message=errors.length ? errors.slice(-4).join("；") : (corsBlocked ? "浏览器跨域限制，无法读取认证响应" : "未找到可用诊断接口");
      setConn(id, "offline", null, message, revision);
      return { ok:false, error:message };
    }catch(error){
      if(!isCurrentStation(id, revision)) return { ok:false, stale:true };
      const message=networkErrorMessage(error);
      setConn(id, "offline", null, message, revision);
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
function setConn(id, state, latency, error, revision, transport=null){
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
  for(const candidate of balanceCandidates(st)){
    let response;
    try{
      response = await fetchStationApi(st, buildUrl(balanceEndpointUrl(st, candidate)));
      if(!isCurrentStation(id, revision)){ finishResponse(response); return; }
      const transport=rememberRequestTransport(st,response);
      if(!response.ok){
        errors.push(candidate.path + "：" + await responseError(response));
        continue;
      }
      const data = await responseData(response);
      if(!isCurrentStation(id, revision)) return;
      const result = await extractBalanceForCandidate(data, candidate, st, revision);
      if(!isCurrentStation(id, revision)) return;
      if(result){
        setBalanceResult(st, result, data, candidate);
        st.status.balanceError=null;
        save(); scheduleRender();
        toast(balanceLabel(st) + "：" + balanceDisplay(st) + "（" + candidate.source + "）" + (transport === "builtin" ? "，已通过本地同源转发" : ""), "ok");
        return;
      }
      lastReturned={ data, candidate };
      errors.push(candidate.path + "：未识别可用余额/额度字段");
    }catch(error){
      if(!isCurrentStation(id, revision)) return;
      const message = networkErrorMessage(error);
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
    st.status.balanceRaw = lastReturned.data;
    st.status.balanceError=null;
    save(); scheduleRender();
    toast("余额接口已返回，但未识别可用余额字段；可查看原始返回或填写自定义路径", "warn");
  }else{
    const message=text(errors.join("；"),500) || "未找到可用余额接口";
    st.status.balanceError=message;
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
  st.status.balanceRaw=data;
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
    toast("单模型测试进行中，暂不能刷新模型列表", "warn"); return;
  }
  try{
    // 不读取也不修改连通性诊断状态：模型列表接口用自己的响应决定成败。
    const response = await fetchStationApi(st, buildUrl(apiUrl(st.baseurl, "/v1/models")));
    if(!isCurrentStation(id, revision)){ finishResponse(response); return; }
    const transport=rememberRequestTransport(st,response);
    if(!response.ok){
      const message=await responseError(response);
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
        return { id:modelId, test:old ? old.test : "idle", latency:old ? old.latency : null, err:old ? old.err : null };
      });
    if(isSelectionStation(id)){
      selectedModels = new Set([...selectedModels].filter(modelId=>st.models.some(model=>model.id===modelId)));
    }
    st.status.modelListError=null;
    save(); scheduleRender();
    toast("获取到 " + st.models.length + " 个模型" + (transport === "builtin" ? "，已通过本地同源转发" : ""), "ok");
  }catch(error){
    if(isCurrentStation(id, revision)){
      const current=getById(id);
      const message=networkErrorMessage(error);
      if(current){ current.status.modelListError=message; save(); scheduleRender(); }
      toast("获取模型失败：" + message, "err");
    }
  }
}

// 单模型测试：手动单测与批测 worker 显式区分，并只与正在执行的连通性诊断保持互斥。
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
    if(isBatchRunning(id) || isRequestRunning(modelListRequests,id) || isManualModelTestRunning(id) || st.models.some(item=>item.test==="testing")){
      toast("已有模型请求进行中，请完成后再单独测试", "warn");
      return false;
    }
    if(!claimManualModelTest(id, revision)) return false;
  }
  try{
    st = getById(id);
    model = st && st.models.find(item=>item.id===modelId);
    if(!model || model.test === "testing") return false;
    if(fromBatch){
      if(!isBatchRunning(id) || isManualModelTestRunning(id)) return false;
    }else if(manualModelTests.get(id)!==revision || isBatchRunning(id) || isRequestRunning(modelListRequests,id) || st.models.some(item=>item.id!==modelId && item.test==="testing")){
      return false;
    }
    model.test = "testing"; model.latency = null; model.err = null; persistModelProgress(id, revision);
    const started = performance.now();
    const response = await fetchStationApi(st, buildUrl(apiUrl(st.baseurl, "/v1/chat/completions")), {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ model:modelId, messages:[{ role:"user", content:"ping" }], max_tokens:5, stream:false })
    });
    if(!isCurrentStation(id, revision)){ finishResponse(response); return false; }
    rememberRequestTransport(st,response);
    if(!response.ok){
      const message=await responseError(response);
      if(!isCurrentStation(id, revision)) return false;
      model.test="fail"; model.latency=null; model.err=message;
    }
    else { finishResponse(response); model.test="ok"; model.latency=performance.now()-started; model.err=null; }
  }catch(error){
    if(!isCurrentStation(id, revision)) return false;
    model.test="fail"; model.latency=null; model.err=networkErrorMessage(error);
  }finally{
    if(!fromBatch) releaseManualModelTest(id, revision);
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
    toast("模型列表或单模型测试进行中，请完成后再批量测试", "warn");
    return;
  }
  // 在第一个 await 前冻结选择范围；切换站点或重新渲染均不会污染本次批测的统计。
  const pickedIds=new Set([...selectedModels].filter(modelId=>station.models.some(model=>model.id===modelId)));
  if(!pickedIds.size){ toast("请先勾选要测试的模型", "warn"); return; }
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
        await testModel(id, model.id, revision, { fromBatch:true });
      }
    };
    await Promise.all(Array.from({ length:Math.min(limit, picks.length) }, worker));
    if(!isCurrentStation(id, revision)) return;
    const current = getById(id);
    const passed = current.models.filter(model=>pickedIds.has(model.id) && model.test==="ok").length;
    toast("批量测试完成：选中 " + picks.length + " 个，通过 " + passed + " 个", passed===picks.length ? "ok" : "warn");
  }catch(error){
    if(isCurrentStation(id, revision)) toast("批量测试失败：" + networkErrorMessage(error), "err");
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

// 排序是卡片级属性，独立放在右上角；筛选时仍禁用，避免隐藏项排序造成无反馈。
function stationOrderControls(st){
  const orderLocked=isSearchFiltered();
  const orderIndex=stations.findIndex(item=>item.id===st.id);
  const upDisabled=orderLocked || orderIndex<=0;
  const downDisabled=orderLocked || orderIndex<0 || orderIndex>=stations.length-1;
  const upTitle=orderLocked ? "请先清空搜索再调整顺序" : upDisabled ? "已是第一个中转站" : "上移";
  const downTitle=orderLocked ? "请先清空搜索再调整顺序" : downDisabled ? "已是最后一个中转站" : "下移";
  const escapedId=esc(st.id);
  return `<span class="station-order" role="group" aria-label="调整 ${esc(st.name)} 的排序">
    <button type="button" class="btn sm" data-act="up" data-id="${escapedId}" title="${upTitle}" aria-label="${upTitle}" ${upDisabled?"disabled":""}>${ARROW_UP_ICON}</button>
    <button type="button" class="btn sm" data-act="down" data-id="${escapedId}" title="${downTitle}" aria-label="${downTitle}" ${downDisabled?"disabled":""}>${ARROW_DOWN_ICON}</button>
  </span>`;
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

// 左栏把诊断结果本身做成重试入口：颜色表达当前状态，循环箭头表达可重新诊断。
function connectivityRetryMarkup(st){
  const activity=getStationActivity(st);
  const missingConfig=!hasStationCredentials(st);
  const disabled=missingConfig || activity.connection || activity.balance || activity.modelWork;
  const {txt,cls}=connectivityPresentation(st);
  const running=activity.connection;
  const label=running ? "检测中…" : txt;
  const title=missingConfig ? "请先填写 Base URL 和 API Key" :
    running ? "正在检测连通性" :
    activity.balance || activity.modelWork ? "该站点已有请求进行中，完成后可重新诊断" :
    st.status.connectivity==="unknown" ? "开始连通性诊断（含延时）" : "重新诊断连通性（含延时）";
  const ariaLabel=running ? "正在检测连通性" : label+"，点击"+(st.status.connectivity==="unknown" ? "开始" : "重新")+"诊断连通性（含延时）";
  return `<button type="button" class="row-metric status ${cls}" data-act="conn" data-id="${esc(st.id)}" title="${title}" aria-label="${ariaLabel}" aria-busy="${running?"true":"false"}" ${disabled?"disabled":""}><span class="m-label">状态</span><span class="m-val status-value"><span class="m-ico">${running?SPINNER_ICON:RETRY_ICON}</span><span class="m-txt">${label}</span></span></button>`;
}

// Grid 操作条保留独立连通性按钮；列表指标带复用 connectivityRetryMarkup，避免重复入口。
function opsBar(st){
  const activity=getStationActivity(st);
  const missingConfig=!hasStationCredentials(st);
  const connectionDisabled=missingConfig || activity.connection || activity.balance || activity.modelWork;
  const connectionTitle=missingConfig ? "请先填写 Base URL 和 API Key" : activity.connection ? "正在检测连通性" : activity.balance || activity.modelWork ? "该站点已有请求进行中" : "测试连通性";
  const escapedId = esc(st.id);
  return `
    <div class="ops" role="group" aria-label="${esc(st.name)} 的站点操作">
      <button type="button" class="btn action sm station-connect" data-act="conn" data-id="${escapedId}" title="${connectionTitle}" ${connectionDisabled?"disabled":""}>${activity.connection?SPINNER_ICON+"检测中…":"连通性"}</button>
      ${stationManageControls(st)}
    </div>`;
}
// 拖拽手柄；点击拦截在 bindListOrGrid 中绑定，避免内联事件属性。
function dragHandle(enabled=true){
  if(!enabled) return "";
  return `<span class="handle" title="拖拽排序"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>`;
}

/* ---------------- 主渲染（核心调度） ---------------- */
// 全量重绘不可避免（模型测试状态会频繁更新），因此把各滚动容器作为渲染状态的一部分保存与恢复。
function captureScrollState(){
  const page=document.scrollingElement;
  const list=document.getElementById("listPane");
  const detail=document.getElementById("detailPane");
  const focus=document.getElementById("focusView");
  let detailAnchor=null;
  if(detail && detail.offsetParent!==null){
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
  if(focus && focus.offsetParent!==null){
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
  if(scheduledRenderHandle !== null){
    if(typeof cancelAnimationFrame === "function") cancelAnimationFrame(scheduledRenderHandle);
    else clearTimeout(scheduledRenderHandle);
    scheduledRenderHandle=null;
  }
  const scrollState=options.scrollState || captureScrollState();
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
    renderDetailInto(focus, focusedStation, true);
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
    else if(st) renderDetailInto(dp, st, false);
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

// 列表左栏：标题操作、连续四格指标、URL 与紧凑 Key；展开后完整 Key 自然换行显示。
function renderListPane(activeId=selectedId){
  const pane = document.getElementById("listPane");
  const data = filtered();
  const orderingEnabled=!isSearchFiltered();
  const listHeader = `<div class="pane-head"><div><span class="pane-eyebrow">服务目录</span><strong>中转站</strong></div><span class="pane-count">${data.length}<small>个站点</small></span></div>`;
  if(!data.length){
    pane.innerHTML = listHeader + emptyInline(stations.length? "没有匹配的中转站" : "还没有中转站", stations.length? "换个关键词试试" : "点击下方「添加中转站」开始");
    const ea = document.getElementById("emptyAdd"); if(ea) ea.onclick = ()=>openForm(null);
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
      <div class="row-item ${st.status.connectivity} ${activeId===st.id?'selected':''}" data-id="${esc(st.id)}" draggable="${orderingEnabled?"true":"false"}">
        <div class="row-top">
          ${dragHandle(orderingEnabled)}
          <div class="row-name"><button type="button" class="station-open" data-open-station="${esc(st.id)}" aria-label="打开 ${esc(st.name)} 的详情">${esc(st.name)}</button>${st.group?`<span class="row-group">· ${esc(st.group)}</span>`:""}</div>
          <div class="row-actions">${stationOrderControls(st)}${stationManageControls(st)}</div>
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
  bindListOrGrid("#listPane");
}

// 网格主区：卡片点开整页专注（见 onStationClick）
function renderGrid(grid){
  const data = filtered();
  const gridHeader = `<div class="grid-head"><div><span class="grid-eyebrow">API 服务</span><h2>中转站总览</h2></div><div class="grid-summary"><strong>${data.length} 个站点</strong><span class="grid-hint">点击卡片进入工作台</span></div></div>`;
  if(!data.length){
    grid.innerHTML = gridHeader + emptyInline(stations.length? "没有匹配的中转站" : "还没有中转站", stations.length? "换个关键词试试" : "点击下方「添加中转站」开始");
    const ea = document.getElementById("emptyAdd"); if(ea) ea.onclick = ()=>openForm(null);
    return;
  }
  grid.innerHTML = gridHeader + data.map(st=>`
    <div class="card ${st.status.connectivity}" data-id="${esc(st.id)}" draggable="false">
      <span class="accent"></span>
      <div class="card-head"><span class="card-kicker">${esc(st.group || "未分组")}</span><span class="card-head-side"><span class="lat ${latencyCls(st.status.latency)}">${fmtLat(st.status.latency)}</span>${stationOrderControls(st)}</span></div>
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
  // 操作按钮：conn/up/down/edit/del
  document.querySelectorAll(scope+' [data-act]').forEach(btn=>{
    btn.onclick = (e)=>{
      e.stopPropagation();
      const id = btn.dataset.id, act = btn.dataset.act;
      if(act==="conn") testConnectivity(id);
      else if(act==="up") moveOrder(id,-1);
      else if(act==="down") moveOrder(id,1);
      else if(act==="edit") openForm(id);
      else if(act==="del") openDelete(id);
    };
  });
  document.querySelectorAll(scope+' .handle').forEach(handle=>{
    handle.onclick = event=>event.stopPropagation();
  });
  // 独立的真实按钮保证键盘也能进入详情，避免把含其他操作的整卡伪装成 button。
  document.querySelectorAll(scope+' [data-open-station]').forEach(button=>{
    button.onclick=e=>{ e.stopPropagation(); onStationClick(button.dataset.openStation); };
  });
  bindUrlInteractions(document.querySelector(scope));
  // 整行/整卡点击：网格或窄屏→整页专注；宽屏列表→右侧详情
  document.querySelectorAll(scope+' .row-item, '+scope+' .card').forEach(el=>{
    el.onclick = ()=> onStationClick(el.dataset.id);
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

/* ---------------- 列表交互：拖拽排序 ---------------- */
let dragId = null;          // 当前被拖拽项的 id
let lastDropAfter = true;   // 上次落点在上半区(false)还是下半区(true)，决定插入到目标前/后
function attachDrag(scope){
  document.querySelectorAll(scope+' [draggable=true]').forEach(card=>{
    card.addEventListener("dragstart", e=>{
      dragId=card.dataset.id; card.classList.add("dragging"); e.dataTransfer.effectAllowed="move";
      try{ e.dataTransfer.setData("text/plain", dragId); }catch(_){}
    });
    card.addEventListener("dragend", ()=>{ card.classList.remove("dragging"); clearDropMarks(); dragId=null; });
    // 拖拽悬停：根据鼠标在卡片的上/下半区标记插入位置
    card.addEventListener("dragover", e=>{
      e.preventDefault();
      if(!dragId || dragId===card.dataset.id) return;
      const r = card.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height/2;
      lastDropAfter = after;
      clearDropMarks();
      card.classList.add(after?"drop-after":"drop-before");
    });
    card.addEventListener("drop", e=>{
      e.preventDefault();
      if(!dragId || dragId===card.dataset.id) return;
      reorder(dragId, card.dataset.id);
    });
  });
}
function clearDropMarks(){ document.querySelectorAll(".drop-before,.drop-after").forEach(e=>e.classList.remove("drop-before","drop-after")); }

// 拖拽落定：把 from 重排到 to 的前或后，并重写 order 持久化
function reorder(fromId, toId){
  if(isSearchFiltered()){ toast("请先清空搜索再调整顺序", "warn"); return; }
  byOrder();
  const from = stations.find(s=>s.id===fromId);
  const to = stations.find(s=>s.id===toId);
  if(!from || !to) return;
  stations = stations.filter(s=>s.id!==fromId);
  const newIdx = stations.findIndex(s=>s.id===toId);
  const insertAt = lastDropAfter ? newIdx + 1 : newIdx;
  stations.splice(insertAt, 0, from);
  stations.forEach((s,i)=> s.order=i);
  save(); render();
  toast("已调整顺序", "ok");
}

// 移动端 ↑/↓ 兜底排序（HTML5 拖拽在触屏不触发）
function moveOrder(id, dir){
  if(isSearchFiltered()){ toast("请先清空搜索再调整顺序", "warn"); return; }
  byOrder();
  const idx = stations.findIndex(s=>s.id===id);
  const swap = idx + dir;
  if(idx<0 || swap<0 || swap>=stations.length) return;
  const a = stations[idx], b = stations[swap];
  stations[idx]=b; stations[swap]=a;
  stations.forEach((s,i)=> s.order=i);
  save(); render();
}

/* ---------------- 选中 / 专注 ---------------- */
// 点击行/卡：网格或窄屏→整页专注；宽屏列表→选中并刷新右栏
function onStationClick(id){
  if(settings.view==="grid" || isNarrow()){ openFocus(id); }
  else { selectStation(id); }
}
function selectStation(id){
  selectedId = id; selectedModels = new Set();   // 切换站点清空模型勾选（避免跨站残留）
  document.querySelectorAll("#listPane .row-item").forEach(r=> r.classList.toggle("selected", r.dataset.id===id));
  const st = getById(id); const dp = document.getElementById("detailPane");
  if(st) renderDetailInto(dp, st, false); else dp.innerHTML = emptyDetail();
}
function openFocus(id){
  focusReturnScroll=captureScrollState();
  focusReturnStationId=id;
  focusId = id; selectedModels = new Set();
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
  const connectionDisabled=missingConfig || connectionBusy || balanceBusy || activity.modelWork;
  // 余额接口可独立于 /v1/models 工作；即使模型连通性未通过，也允许直接查询管理余额接口。
  const balanceDisabled=missingConfig || connectionBusy || balanceBusy;
  // 连通性结果只是诊断记录；模型操作只与「诊断正在执行」及自身请求互斥。
  const modelControlsDisabled=missingConfig || connectionBusy || activity.modelWork;
  const stationBusy=activity.any;
  const selectedCount = st.models.reduce((count,model)=>count+(selectedModels.has(model.id)?1:0),0);
  const balanceTxt = hasBalance(st) ? balanceDisplay(st) : "已获取（查看原始返回）";
  const balanceMeta=[st.status.balanceSource,st.status.balanceNote].filter(Boolean).join(" · ");
  const balanceActionLabel=balanceBusy ? SPINNER_ICON+"余额获取中…" : "查询余额";
  const modelFetchLabel=modelListBusy ? SPINNER_ICON+"模型获取中…" : st.models.length ? "刷新模型列表" : "获取模型列表";
  const feedback=[];
  if(missingConfig){
    feedback.push(`<span class="detail-feedback-item error">请先通过编辑或快速导入填写 Base URL 和 API Key。</span>`);
  }else if(st.status.connectivity==="offline"){
    feedback.push(`<span class="detail-feedback-item error" title="${esc(st.status.error || "该诊断请求未通过。")}">诊断原因：${esc(st.status.error || "该诊断请求未通过。")}；模型列表、单测和批测仍可单独发起。</span>`);
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
  const modelsHtml = st.models.length ? st.models.map((m,index)=>{
    const testDisabled = modelControlsDisabled;
    const testLabel=m.test==="testing" ? "测试中…" : "单测";
    const selected=selectedModels.has(m.id);
    const modelInputId=`dwModel-${st.id}-${index}`;
    return `
      <div class="model ${selected?"selected":""}" data-model-id="${esc(m.id)}">
        <input id="${esc(modelInputId)}" type="checkbox" data-m="${esc(m.id)}" ${selected?"checked":""} ${modelControlsDisabled?"disabled":""}>
        <div class="m-main">
          <div class="model-name-row"><label class="model-select" for="${esc(modelInputId)}" title="切换选择 ${esc(m.id)}"><span class="mname">${esc(m.id)}</span></label><button type="button" class="btn model-copy" data-copy="${esc(m.id)}" title="复制模型 ID" aria-label="复制模型 ID ${esc(m.id)}">${COPY_ICON}</button></div>
          <div class="m-meta"><span class="mst ${m.test}"${m.err?` title="${esc(m.err)}"`:""}>${m.test==="ok"?"通过":m.test==="fail"?"失败":m.test==="testing"?"测试中":"未测"}</span><span class="mlat ${latencyCls(m.latency)}">${fmtLat(m.latency)}</span></div>
        </div>
        <div class="model-actions">
          <button type="button" class="btn action sm model-test" data-model-test="${esc(m.id)}" ${testDisabled?"disabled":""} title="单独测试此模型">${m.test==="testing"?SPINNER_ICON+testLabel:testLabel}</button>
        </div>
      </div>`;
  }).join("")
    : `<div class="models-empty muted">暂无模型，点「获取列表」拉取。</div>`;

  return `
    <div class="detail-head">
      ${isFocus?`<button type="button" class="btn sm" id="dwBack">← 返回</button>`:""}
      <div class="detail-title"><span class="badge ${cls}"><span class="d ${cls}"></span>${txt}</span><span class="d-name">${esc(st.name)}</span><span class="lat ${latencyCls(st.status.latency)}">${fmtLat(st.status.latency)}</span></div>
      <div class="detail-head-actions" role="group" aria-label="${esc(st.name)} 的诊断与余额操作">
        <button type="button" class="btn action sm" id="dwConn" ${connectionDisabled?"disabled":""} aria-busy="${connectionBusy?"true":"false"}" title="${missingConfig?"请先填写 Base URL 和 API Key":"测试连通性（含延时）"}">${connectionBusy?SPINNER_ICON+"检测中…":"测试连通性"}</button>
        <button type="button" class="btn action sm" id="dwBal" ${balanceDisabled?"disabled":""} aria-busy="${balanceBusy?"true":"false"}" title="${missingConfig?"请先填写 Base URL 和 API Key":"查询可用余额或额度"}">${balanceActionLabel}</button>
      </div>
    </div>
    ${feedbackHtml}

    <div class="sec">
      <div class="model-toolbar">
        <div class="model-titleline"><span class="title">模型（${st.models.length}）</span><button type="button" class="btn action sm" id="dwFetch" ${modelControlsDisabled?"disabled":""} aria-busy="${modelListBusy?"true":"false"}" title="获取或刷新模型列表">${modelFetchLabel}</button><span class="selection-count" title="批量测试并发 ${esc(settings.concurrency)}">已选 ${selectedCount} · 并发 ${esc(settings.concurrency)}</span></div>
        <div class="model-toolbar-actions">
          <button type="button" class="btn sm" id="dwSelAll" ${modelControlsDisabled?"disabled":""}>全选</button>
          <button type="button" class="btn sm" id="dwSelNone" ${modelControlsDisabled?"disabled":""}>清空</button>
          <button type="button" class="btn primary sm" id="dwBatch" ${modelControlsDisabled?"disabled":""} aria-busy="${batchBusy?"true":"false"}">${batchBusy?SPINNER_ICON+"批量测试中…":"测试选中"}</button>
        </div>
      </div>
      ${st.status.modelListError?`<div class="models-error">最近获取失败：${esc(st.status.modelListError)}</div>`:""}
      <div class="models" id="dwModels">${modelsHtml}</div>
    </div>

    <div class="sec">
      <div class="sec-h"><span class="title">连接信息</span><button type="button" class="btn sm connection-edit" data-edit-station="${esc(st.id)}" data-focus-field="f_baseurl" title="${stationBusy?"请求进行中，暂不能编辑":"编辑 Base URL 与 API Key"}" ${stationBusy?"disabled":""}>${EDIT_ICON}<span>编辑</span></button></div>
      <div class="connection-grid">
        <div class="field"><label>Base URL</label><div class="val"><span class="txt">${esc(st.baseurl)}</span><button type="button" data-copy="${esc(st.baseurl)}" title="复制 Base URL" aria-label="复制 Base URL">${COPY_ICON}</button></div></div>
        <div class="field"><label>API Key</label><div class="val">${apiKeyControlsMarkup(st,{detail:true,displayId:"dwKey",toggleId:"dwKeyToggle"})}</div></div>
        ${st.group?`<div class="field"><label>分组</label><div class="val"><span class="txt">${esc(st.group)}</span></div></div>`:""}
        ${st.note?`<div class="field wide"><label>备注</label><div class="val"><span class="txt">${esc(st.note)}</span></div></div>`:""}
      </div>
    </div>

    <div class="detail-footer" aria-label="站点管理">
      <div class="detail-footer-copy"><span class="detail-footer-title">危险操作</span><span class="detail-footer-hint">删除站点后无法恢复</span></div>
      <div class="detail-footer-actions">
        <button type="button" class="btn station-delete" id="dwDel" title="${stationBusy?"请求进行中，暂不能删除":"删除此站点"}" ${stationBusy?"disabled":""}>${TRASH_ICON}<span>删除站点</span></button>
      </div>
    </div>
  `;
}

// 详情重绘时除了像素滚动量，还保存当前可见模型锚点与焦点，避免 100 个模型的状态刷新把用户甩回列表顶部。
function captureDetailRenderState(container){
  const models=container.querySelector(".models");
  let modelAnchor=null;
  if(models){
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
function renderDetailInto(container, st, isFocus){
  const state=captureDetailRenderState(container);
  container.innerHTML = detailHTML(st, isFocus);
  bindDetail(container, st);
  restoreDetailRenderState(container,state);
}

// 绑定详情内所有按钮与勾选框
function bindDetail(c, st){
  const id = st.id;
  const conn=c.querySelector("#dwConn"); if(conn && !conn.disabled) conn.onclick=()=>testConnectivity(id);
  const proxySetup=c.querySelector("#dwProxySetup"); if(proxySetup) proxySetup.onclick=openSettings;
  const bal=c.querySelector("#dwBal"); if(bal && !bal.disabled) bal.onclick=()=>fetchBalance(id);
  const fet=c.querySelector("#dwFetch"); if(fet && !fet.disabled) fet.onclick=()=>fetchModels(id);
  const bat=c.querySelector("#dwBatch"); if(bat && !bat.disabled) bat.onclick=()=>batchTest(id);
  // 勾选框 → 维护 selectedModels 唯一真源
  c.querySelectorAll("#dwModels input[type=checkbox]").forEach(ch=>{
    ch.onchange=()=>{
      if(ch.checked) selectedModels.add(ch.dataset.m); else selectedModels.delete(ch.dataset.m);
      const card=ch.closest(".model"); if(card) card.classList.toggle("selected",ch.checked);
      updateSelectionCount(c, st);
    };
  });
  const sa=c.querySelector("#dwSelAll"); if(sa && !sa.disabled) sa.onclick=()=>{ c.querySelectorAll("#dwModels input").forEach(ch=>{ch.checked=true; selectedModels.add(ch.dataset.m); ch.closest(".model")?.classList.add("selected");}); updateSelectionCount(c, st); };
  const sn=c.querySelector("#dwSelNone"); if(sn && !sn.disabled) sn.onclick=()=>{ c.querySelectorAll("#dwModels input").forEach(ch=>{ch.checked=false; ch.closest(".model")?.classList.remove("selected");}); selectedModels.clear(); updateSelectionCount(c, st); };
  c.querySelectorAll("[data-model-test]").forEach(button=>{
    if(!button.disabled) button.onclick=()=>testModel(id, button.dataset.modelTest);
  });
  c.querySelectorAll("[data-edit-station]").forEach(button=>{
    if(!button.disabled) button.onclick=()=>openForm(button.dataset.editStation, { focusField:button.dataset.focusField || "" });
  });
  const dl=c.querySelector("#dwDel"); if(dl) dl.onclick=()=>openDelete(id);
  bindApiKeyControls(c);
  c.querySelectorAll("[data-copy]").forEach(b=> b.onclick=()=>copyText(b.dataset.copy));
  const back=c.querySelector("#dwBack"); if(back) back.onclick=closeFocus;
}
function updateSelectionCount(container, st){
  const count=st.models.reduce((total,model)=>total+(selectedModels.has(model.id)?1:0),0);
  const label=container.querySelector(".selection-count");
  if(label) label.textContent="已选 " + count + " · 并发 " + settings.concurrency;
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
      setQuickImportFeedback("该配置已存在，不会重复新增。", "warn", existing.id);
      return;
    }
    document.getElementById("f_name").value=config.name;
    document.getElementById("f_baseurl").value=config.baseurl;
    setFormApiKeyValue(config.apikey);
    // 成功后立即清除原始粘贴内容，避免明文 Key 长时间留在 textarea 中。
    document.getElementById("quickImportText").value="";
    setQuickImportFeedback("已识别并填入："+config.name+"。请确认后保存。", "success");
  }catch(error){
    setQuickImportFeedback(text(error && error.message, 240) || "识别失败，请检查配置格式。", "error");
  }
}
function openQuickImportExisting(){
  const id=quickImportExistingId;
  if(!id || !getById(id)) return;
  hideModal("formModal");
  selectedModels=new Set();
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
  if(findSameStation(baseurl, apikey, editingId)){
    toast("相同 Base URL 和 API Key 的站点已存在，请勿重复添加", "warn");
    return;
  }

  if(editingId){
    const st = getById(editingId);
    if(!st){ hideModal("formModal"); return; }
    const connectionChanged = st.baseurl !== baseurl || st.apikey !== apikey;
    const balancePathChanged = st.balancePath !== balancePath;
    Object.assign(st, { name, baseurl, apikey, group, note, balancePath });
    // 更换服务地址或密钥后，旧连通性/余额/模型测试均不再可信；让迟到请求失效。
    if(connectionChanged){ revealedApiKeyIds.delete(st.id); invalidateStation(st.id); resetStationRuntime(st); selectedModels.clear(); }
    else if(balancePathChanged){
      // 自定义余额路径变更时同样使未完成请求失效，防止旧路径的响应回写新配置。
      invalidateStation(st.id);
      st.status.balance=null; st.status.balanceKind="balance"; st.status.balanceUnlimited=false;
      st.status.balanceUnit=null; st.status.balanceSource=null; st.status.balanceNote=null; st.status.balanceRaw=null; st.status.balanceError=null;
    }
    toast("已保存修改","ok");
  } else {
    const maxOrder = stations.reduce((m,s)=>Math.max(m, s.order), -1);
    stations.push(normalizeStation({ id:uid(), name, baseurl, apikey, group, note, balancePath, order:maxOrder+1 }));
    toast("已添加「"+name+"」","ok");
  }
  const scrollState=captureScrollState();
  save();
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
  invalidateStation(deletingId); // 删除后忽略所有未结束网络请求的迟到响应
  revealedApiKeyIds.delete(deletingId);
  stations = stations.filter(s=>s.id!==deletingId);
  stations.forEach((s,i)=> s.order=i);                       // 重整 order
  if(selectedId===deletingId) selectedId = stations.length ? stations[0].id : null;  // 选中项重定向
  if(focusId===deletingId){ focusId = null; focusReturnScroll=null; focusReturnStationId=null; } // 专注页关闭并回到进入前的位置
  selectedModels.clear();
  deletingId=null;
  save();
  hideModal("delModal",{ restoreFocus:false });
  render({ scrollState });
  toast("已删除","ok");
}

/* ---------------- 导入/导出 ---------------- */
function exportJSON(){
  const data = { version:VERSION, exportedAt:new Date().toISOString(), settings, stations };
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
      const incoming = Array.isArray(data) ? data : data && data.stations;   // 兼容「裸数组」与「带元信息对象」
      if(!Array.isArray(incoming)) throw new Error("找不到 stations 数组");
      if(incoming.length > 2000) throw new Error("一次最多导入 2000 个中转站");
      const importSettings = !Array.isArray(data) && data && data.settings && typeof data.settings === "object" && !Array.isArray(data.settings) ? data.settings : null;
       const importHasProxy = !!importSettings && Object.prototype.hasOwnProperty.call(importSettings,"proxy");
       const skippedProxy = !!importHasProxy && text(importSettings.proxy) !== settings.proxy;
       const normalized = normalizeStations(incoming);
       const norm = normalized.filter(hasStationCredentials);
       const skippedInvalid = normalized.length - norm.length;
       if(!norm.length) throw new Error("备份中没有包含有效 Base URL 与 API Key 的站点");
       // 导入会按 ID 覆盖站点配置；先使全部旧请求失效，防止旧地址/密钥的迟到响应回写到同 ID 新站点。
       stations.forEach(station=>invalidateStation(station.id));
       // 同 ID 覆盖原位置，新 ID 追加；Map 避开对象原型键带来的污染风险。
       const merged = stations.slice();
      const indices = new Map(merged.map((station,index)=>[station.id,index]));
      norm.forEach(station=>{
        if(indices.has(station.id)) merged[indices.get(station.id)] = station;
        else { indices.set(station.id, merged.length); merged.push(station); }
      });
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
      selectedModels.clear();
      save(); saveSettings(); render();
       toast("已导入 "+norm.length+" 个中转站（按 ID 合并）" + (skippedInvalid ? "；已跳过 "+skippedInvalid+" 个缺少配置的站点" : "") + (skippedProxy ? "；代理设置未自动导入" : ""),"ok");
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
  document.getElementById("s_view").value = settings.view;
  const proxyHint=document.getElementById("s_proxy_hint");
  if(proxyHint) proxyHint.textContent=IS_EXTENSION_PAGE
    ? "扩展已获得 HTTP(S) 请求权限；留空时直接请求站点。填入的代理会收到请求与 API Key，请只使用你信任的地址。"
    : "本地通过 server.mjs 打开时，会在浏览器跨域请求失败后自动使用同源转发；它不会影响其它网页。填入的代理会收到请求与 API Key，请只使用你信任的地址。";
  showModal("setModal");
}
function saveSettingsModal(){
  applySettings({
    theme: document.getElementById("s_theme").value,
    proxy: document.getElementById("s_proxy").value,
    concurrency: document.getElementById("s_concurrency").value,
    timeout: document.getElementById("s_timeout").value,
    view: document.getElementById("s_view").value
  });
  save(); saveSettings(); render(); hideModal("setModal");
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
    settings.view = b.dataset.view; saveSettings(); focusId=null; focusReturnScroll=null; focusReturnStationId=null; selectedModels=new Set(); render({ scrollState });
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
  // 弹窗关闭：点取消 / 点遮罩空白处
  document.querySelectorAll("[data-close]").forEach(b=> b.onclick = ()=> hideModal(b.dataset.close));
  document.querySelectorAll(".modal").forEach(m=> m.addEventListener("click", e=>{ if(e.target===m) hideModal(m.id); }));

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
      if(openModal){ hideModal(openModal.id); return; }
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
selectedId = stations.length ? stations[0].id : null;   // 默认选中第一个，便于宽屏直接显示详情
applyTheme();
updateThemeBtn();
bindGlobal();
render();
syncDetailOffset();
