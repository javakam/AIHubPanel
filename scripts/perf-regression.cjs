const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const NODE_BIN = process.env.npm_node_execpath || "node";
const TEMP_USER_DATA = path.join(os.tmpdir(), `aihubpanel-perf-${process.pid}`);

const STATION_COUNT = 60;
const NORMAL_MODEL_COUNT = 30;
const HEAVY_MODEL_COUNT = 420;
const LOGS_PER_STATION = 16;

const LIMITS_MS = new Map([
  ["seeded-load", 6000],
  ["search-filter", 700],
  ["search-clear", 700],
  ["select-normal-detail", 1000],
  ["select-heavy-detail", 1400],
  ["switch-grid", 1000],
  ["switch-list", 1000],
  ["repeat-view-cycles", 4500],
  ["mobile-focus-heavy", 1600]
]);
const MAX_DOM_NODES = 18000;
const MAX_REPEAT_RENDERER_DELTA_MIB = 120;

app.setPath("userData", TEMP_USER_DATA);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("enable-precise-memory-info");
app.commandLine.appendSwitch("js-flags", "--expose-gc");

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message, details) {
  if (condition) return;
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function startPanelServer(port) {
  const child = spawn(NODE_BIN, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, AI_HUB_HOST: "127.0.0.1", AI_HUB_PORT: String(port) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.output = "";
  child.stdout.on("data", chunk => { child.output += chunk; });
  child.stderr.on("data", chunk => { child.output += chunk; });
  return child;
}

function waitForHttp(url, child) {
  const deadline = Date.now() + 6000;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (child.exitCode !== null) {
        reject(new Error(`server.mjs exited early:\n${child.output}`));
        return;
      }
      const req = http.get(url, res => {
        res.resume();
        if (res.statusCode === 200 && res.headers["x-aihub-proxy"] === "1") resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(800, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`server.mjs did not become ready:\n${child.output}`));
      else setTimeout(tick, 80);
    };
    tick();
  });
}

function fakeModel(stationIndex, modelIndex) {
  const ok = modelIndex % 7 !== 0;
  const tested = modelIndex % 3 !== 2;
  return {
    id: `provider-${stationIndex % 9}/model-${String(stationIndex).padStart(3, "0")}-${String(modelIndex).padStart(4, "0")}-VeryLongRoutingNameForPerfAuditABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    test: tested ? (ok ? "ok" : "fail") : "idle",
    latency: tested && ok ? 120 + ((stationIndex * 31 + modelIndex * 17) % 1600) : null,
    lastRequestAt: Date.now() - modelIndex * 1000,
    err: tested && !ok ? "模型测试失败：上游返回内容为空或鉴权失败" : null,
    capability: null
  };
}

function fakeLogs(stationIndex, models) {
  return Array.from({ length: LOGS_PER_STATION }, (_, index) => {
    const model = models[index % models.length];
    return {
      id: `perf-log-${stationIndex}-${index}`,
      at: Date.now() - index * 1200,
      level: index % 5 === 0 ? "warn" : "ok",
      kind: index % 2 ? "模型测试" : "余额查询",
      method: index % 2 ? "POST" : "GET",
      endpoint: index % 2 ? "/v1/chat/completions" : "/dashboard/billing/credit_grants",
      model: model.id,
      status: 200,
      latency: 180 + index * 13,
      transport: "builtin",
      message: "性能审计用长日志摘要，不包含真实请求体或凭据。".repeat(12)
    };
  });
}

function fakeStation(index) {
  const modelCount = index === 0 ? HEAVY_MODEL_COUNT : NORMAL_MODEL_COUNT;
  const models = Array.from({ length: modelCount }, (_, modelIndex) => fakeModel(index, modelIndex));
  const okModels = models.filter(model => model.test === "ok").length;
  return {
    id: `station-${String(index).padStart(3, "0")}`,
    name: `性能审计站点 ${String(index).padStart(3, "0")} VeryLongStationNameForRenderAndMemoryAuditABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    baseurl: `https://perf-${String(index).padStart(3, "0")}.example.com/v1/long-path-segment/long-path-segment/long-path-segment`,
    apikey: `sk-perf-${String(index).padStart(3, "0")}-${"A".repeat(48)}-END`,
    group: index % 4 === 0 ? "主链路-长分组名称-ABCDEFGHIJKLMNOPQRSTUVWXYZ" : `业务组-${index % 6}`,
    note: "这是一段性能审计用备注，验证长文本不会撑开详情，也不会让渲染不断膨胀。".repeat(10),
    balancePath: "",
    headers: { "User-Agent": "aihubpanel-perf-audit/1.0" },
    order: index,
    status: {
      connectivity: index % 6 === 0 ? "offline" : "online",
      latency: 80 + index * 11,
      balance: 1000000 + index * 12345.67,
      balanceKind: "quota",
      balanceUnlimited: false,
      balanceUnit: index % 3 === 0 ? "超长额度单位-ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "USD",
      balanceSource: "性能审计假数据",
      balanceNote: null,
      balanceRaw: null,
      balanceError: null,
      modelListError: null,
      modelListEmpty: false,
      lastTest: Date.now() - index * 10000,
      error: index % 6 === 0 ? "连接失败" : null,
      transport: "builtin",
      authMode: index % 2 ? "bearer" : "x-api-key",
      logs: fakeLogs(index, models)
    },
    models,
    okModels
  };
}

function buildStations() {
  return Array.from({ length: STATION_COUNT }, (_, index) => fakeStation(index));
}

function pagePerfProbe() {
  function raf(count = 1) {
    return new Promise(resolve => {
      const tick = () => {
        count -= 1;
        if (count <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  function click(selector) {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`missing selector: ${selector}`);
    target.click();
  }
  function setSearch(value) {
    const search = document.getElementById("search");
    if (!search) throw new Error("missing search input");
    search.value = value;
    search.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function metrics(label) {
    const doc = document.documentElement;
    const selected = document.querySelector(".row-item.selected, .card.selected");
    const focus = document.body.classList.contains("focus-active");
    return {
      label,
      domNodes: document.querySelectorAll("*").length,
      rows: document.querySelectorAll(".list-pane .row-item").length,
      cards: document.querySelectorAll("#gridView .card").length,
      models: document.querySelectorAll(".model").length,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowX: Math.max(0, doc.scrollWidth - doc.clientWidth),
      selectedId: selected ? selected.dataset.id || null : null,
      focus
    };
  }
  async function step(label, action, frames = 4) {
    const started = performance.now();
    action();
    await raf(frames);
    const finished = performance.now();
    return {
      ...metrics(label),
      ms: Math.round((finished - started) * 10) / 10
    };
  }
  async function desktopScenario() {
    await raf(4);
    const results = [metrics("initial-list")];
    results.push(await step("search-filter", () => setSearch("站点 005")));
    results.push(await step("search-clear", () => setSearch("")));
    results.push(await step("select-normal-detail", () => click('.row-item[data-id="station-005"]')));
    results.push(await step("select-heavy-detail", () => click('.row-item[data-id="station-000"]')));
    results.push(await step("switch-grid", () => click('#viewToggle button[data-view="grid"]')));
    results.push(await step("switch-list", () => click('#viewToggle button[data-view="list"]')));
    return results;
  }
  async function repeatCycles() {
    await raf(2);
    const started = performance.now();
    for (let index = 0; index < 8; index += 1) {
      click('#viewToggle button[data-view="grid"]');
      await raf(2);
      click('#viewToggle button[data-view="list"]');
      await raf(2);
      setSearch(index % 2 ? "站点 001" : "VeryLongStationName");
      await raf(2);
      setSearch("");
      await raf(2);
      click(index % 2 ? '.row-item[data-id="station-000"]' : '.row-item[data-id="station-005"]');
      await raf(2);
    }
    return {
      ...metrics("repeat-view-cycles"),
      ms: Math.round((performance.now() - started) * 10) / 10
    };
  }
  async function mobileFocusScenario() {
    await raf(4);
    return step("mobile-focus-heavy", () => click('.row-item[data-id="station-000"]'), 6);
  }
  return { desktopScenario, repeatCycles, mobileFocusScenario };
}

async function runPageFunction(win, name) {
  console.log(`perf phase: ${name} start`);
  const started = performance.now();
  const result = await win.webContents.executeJavaScript(`(async()=>{ const probe=(${pagePerfProbe.toString()})(); return await probe.${name}(); })()`, true);
  console.log(`perf phase: ${name} done (${Math.round(performance.now() - started)}ms)`);
  return result;
}

async function loadSeededPage(win, baseUrl) {
  await win.loadURL(baseUrl);
  const stations = buildStations();
  const settings = {
    view: "list",
    theme: "light",
    proxy: "",
    concurrency: 20,
    timeout: 15,
    testDepth: "basic",
    longContextKB: 4
  };
  const ui = { selectedStationId: "station-000", selectedModelsByStation: {} };
  const storageScript = `
    localStorage.clear();
    localStorage.setItem("aihub.stations.v2", ${JSON.stringify(JSON.stringify(stations))});
    localStorage.setItem("aihub.settings.v2", ${JSON.stringify(JSON.stringify(settings))});
    localStorage.setItem("aihub.ui.v1", ${JSON.stringify(JSON.stringify(ui))});
    location.reload();
  `;
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const started = performance.now();
  await win.webContents.executeJavaScript(storageScript, true);
  await loaded;
  await delay(160);
  console.log(`perf phase: seeded page ready (${Math.round(performance.now() - started)}ms)`);
  return {
    label: "seeded-load",
    ms: Math.round((performance.now() - started) * 10) / 10,
    stations: STATION_COUNT,
    selectedModels: HEAVY_MODEL_COUNT,
    totalModels: stations.reduce((total, station) => total + station.models.length, 0),
    storageBytes: Buffer.byteLength(JSON.stringify(stations), "utf8")
  };
}

async function installFastFrameScheduler(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      const schedule = callback => setTimeout(() => callback(performance.now()), 16);
      window.requestAnimationFrame = schedule;
      window.cancelAnimationFrame = clearTimeout;
    })();
  `, true);
}

function asMiB(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 1024 * 1024 ? numeric / 1024 / 1024 : numeric / 1024;
}

function roundMiB(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

function memoryFields(source) {
  if (!source || typeof source !== "object") return null;
  return {
    workingSetMiB: roundMiB(asMiB(source.workingSetSize)),
    privateMiB: roundMiB(asMiB(source.privateBytes)),
    peakWorkingSetMiB: roundMiB(asMiB(source.peakWorkingSetSize))
  };
}

async function forceRendererGc(win) {
  try {
    await win.webContents.executeJavaScript("if(window.gc){ window.gc(); true } else false", true);
  } catch {
    // Some Electron builds do not expose renderer GC even with --expose-gc.
  }
  await delay(120);
}

async function collectMemory(win, label) {
  await forceRendererGc(win);
  const rendererPid = win.webContents.getOSProcessId();
  const rendererMetric = app.getAppMetrics().find(metric => metric.pid === rendererPid);
  let mainMemory = null;
  if (typeof process.getProcessMemoryInfo === "function") {
    mainMemory = await process.getProcessMemoryInfo();
  }
  const heap = await win.webContents.executeJavaScript(`
    (() => {
      const memory = performance.memory;
      if (!memory) return null;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit
      };
    })()
  `, true).catch(() => null);
  return {
    label,
    main: memoryFields(mainMemory),
    renderer: memoryFields(rendererMetric && rendererMetric.memory),
    heap: heap ? {
      usedMiB: roundMiB(heap.usedJSHeapSize / 1024 / 1024),
      totalMiB: roundMiB(heap.totalJSHeapSize / 1024 / 1024),
      limitMiB: roundMiB(heap.jsHeapSizeLimit / 1024 / 1024)
    } : null
  };
}

function rendererFootprint(memory) {
  if (!memory) return null;
  if (memory.renderer && memory.renderer.workingSetMiB != null) return memory.renderer.workingSetMiB;
  if (memory.renderer && memory.renderer.privateMiB != null) return memory.renderer.privateMiB;
  if (memory.heap && memory.heap.usedMiB != null) return memory.heap.usedMiB;
  return null;
}

function assertTimings(results) {
  results.forEach(result => {
    const limit = LIMITS_MS.get(result.label);
    if (limit != null) assert(result.ms <= limit, `${result.label} exceeded ${limit}ms`, result);
    if (result.domNodes != null) assert(result.domNodes <= MAX_DOM_NODES, `${result.label} DOM node count is too high`, result);
    if (result.overflowX != null) assert(result.overflowX <= 2, `${result.label} has horizontal overflow`, result);
    // 只比耗时是不够的：一次「快了」的重绘完全可能是少渲染了内容（空列表、空详情）。
    // 这几个步骤还要核对渲染结果，慢但正确和快但残缺必须能分辨出来。
    if (result.label === "search-filter") assert(result.rows === 1 && result.models === 0, "filtering must keep exactly the matching row and drop the filtered-out detail pane", result);
    if (result.label === "search-clear") assert(result.rows === STATION_COUNT && result.models === HEAVY_MODEL_COUNT, "clearing the search must restore every station row and the selected station's models", result);
    if (result.label === "select-normal-detail") assert(result.selectedId === "station-005" && result.models === NORMAL_MODEL_COUNT, "selecting a normal station must render that station's full model list", result);
    if (result.label === "select-heavy-detail") assert(result.selectedId === "station-000" && result.models === HEAVY_MODEL_COUNT, "selecting the heavy station must render its full model list", result);
    if (result.label === "switch-grid") assert(result.rows === 0 && result.models === 0, "grid view must release list/detail markup", result);
    if (result.label === "switch-list") assert(result.cards === 0, "list view must release grid markup", result);
    if (result.label === "mobile-focus-heavy") assert(result.rows === 0 && result.cards === 0, "focus view must release list/grid markup", result);
  });
}

function assertMemory(before, after) {
  const beforeMiB = rendererFootprint(before);
  const afterMiB = rendererFootprint(after);
  // 以前取不到内存就 return null 静默跳过，等于这道门禁可以无声失效。
  // 拿不到可比较的数字时宁可失败：那说明采集方式坏了，而不是「内存没问题」。
  assert(beforeMiB != null && afterMiB != null, "renderer memory could not be measured, so the leak gate cannot be trusted", { before, after });
  const deltaMiB = Math.round((afterMiB - beforeMiB) * 10) / 10;
  assert(deltaMiB <= MAX_REPEAT_RENDERER_DELTA_MIB, `renderer memory grew more than ${MAX_REPEAT_RENDERER_DELTA_MIB} MiB after repeated view changes`, { before, after, deltaMiB });
  return deltaMiB;
}

function summarize(results, memoryDeltaMiB) {
  const byLabel = new Map(results.map(result => [result.label, result]));
  const parts = [
    `load ${byLabel.get("seeded-load").ms}ms`,
    `search ${byLabel.get("search-filter").ms}ms`,
    `heavy detail ${byLabel.get("select-heavy-detail").ms}ms`,
    `grid ${byLabel.get("switch-grid").ms}ms`,
    `repeat ${byLabel.get("repeat-view-cycles").ms}ms`
  ];
  if (memoryDeltaMiB != null) parts.push(`renderer delta ${memoryDeltaMiB} MiB`);
  const final = results[results.length - 1];
  parts.push(`dom ${final.domNodes || "n/a"}`);
  return parts.join(", ");
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startPanelServer(port);
  let win;
  try {
    await waitForHttp(`${baseUrl}/api/proxy/health`, server);
    await app.whenReady();
    win = new BrowserWindow({
      show: true,
      x: -10000,
      y: -10000,
      width: 1280,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: `aihub-perf-${process.pid}`
      }
    });
    win.webContents.setBackgroundThrottling(false);

    console.log("perf phase: loading seeded workload");
    const loadResult = await loadSeededPage(win, baseUrl);
    await installFastFrameScheduler(win);
    console.log("perf phase: seeded workload loaded");
    const desktopResults = await runPageFunction(win, "desktopScenario");
    assertTimings([loadResult, ...desktopResults]);

    console.log("perf phase: collecting baseline memory");
    const memoryBefore = await collectMemory(win, "before-repeat");
    const repeatResult = await runPageFunction(win, "repeatCycles");
    const memoryAfter = await collectMemory(win, "after-repeat");
    const memoryDeltaMiB = assertMemory(memoryBefore, memoryAfter);
    assertTimings([repeatResult]);

    win.setContentSize(390, 760);
    await delay(180);
    const mobileResult = await runPageFunction(win, "mobileFocusScenario");
    assertTimings([mobileResult]);

    const results = [loadResult, ...desktopResults, repeatResult, mobileResult];
    console.log(`perf passed: ${summarize(results, memoryDeltaMiB)}`);
    console.log(JSON.stringify({
      workload: {
        stations: STATION_COUNT,
        normalModels: NORMAL_MODEL_COUNT,
        selectedModels: HEAVY_MODEL_COUNT,
        totalModels: loadResult.totalModels,
        logsPerStation: LOGS_PER_STATION,
        storageBytes: loadResult.storageBytes
      },
      timings: results.map(result => ({
        label: result.label,
        ms: result.ms,
        domNodes: result.domNodes ?? null,
        rows: result.rows ?? null,
        cards: result.cards ?? null,
        models: result.models ?? null,
        overflowX: result.overflowX ?? 0
      })),
      memory: {
        beforeRepeat: memoryBefore,
        afterRepeat: memoryAfter,
        rendererDeltaMiB: memoryDeltaMiB
      }
    }, null, 2));
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (server.exitCode === null) server.kill();
    app.quit();
    try {
      fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true });
    } catch {
      // Temporary Electron profile cleanup is best effort.
    }
  }
}

main().catch(error => {
  console.error(error.message);
  app.exit(1);
});
