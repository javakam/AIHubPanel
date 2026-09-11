const { app } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ELECTRON_BIN = process.execPath;
const STARTUP_EXECUTABLE = process.env.AIHUB_STARTUP_EXECUTABLE || ELECTRON_BIN;
const STARTUP_IS_PACKAGED = STARTUP_EXECUTABLE.toLowerCase() !== ELECTRON_BIN.toLowerCase();
const STARTUP_MAX_TOTAL_MS = Number(process.env.AIHUB_STARTUP_MAX_TOTAL_MS || 5000);
const RUNS = 3;
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_STATION_COUNT = 60;
const STARTUP_NORMAL_MODEL_COUNT = 30;
const STARTUP_HEAVY_MODEL_COUNT = 420;

app.setPath("userData", path.join(os.tmpdir(), `aihubpanel-startup-harness-${process.pid}`));
console.log(`startup harness: exec ${STARTUP_EXECUTABLE}, packaged ${STARTUP_IS_PACKAGED ? "1" : "0"}, runAsNode ${process.env.ELECTRON_RUN_AS_NODE || "0"}`);

function startupModel(stationIndex, modelIndex) {
  return {
    id: `startup-provider-${stationIndex % 8}/model-${stationIndex}-${modelIndex}-long-routing-name`,
    test: modelIndex % 4 === 0 ? "ok" : "idle",
    latency: modelIndex % 4 === 0 ? 120 + ((stationIndex * 13 + modelIndex * 17) % 900) : null,
    lastRequestAt: modelIndex % 4 === 0 ? Date.now() - modelIndex * 1000 : null,
    err: null,
    capability: null
  };
}

function startupStation(index) {
  const modelCount = index === 0 ? STARTUP_HEAVY_MODEL_COUNT : STARTUP_NORMAL_MODEL_COUNT;
  return {
    id: `startup-station-${String(index).padStart(3, "0")}`,
    name: `启动回归站点 ${String(index).padStart(3, "0")}`,
    baseurl: `https://startup-${String(index).padStart(3, "0")}.example.com/v1`,
    apikey: `sk-startup-fake-${String(index).padStart(3, "0")}`,
    group: index % 3 === 0 ? "startup-long-group-name" : "",
    note: "",
    balancePath: "",
    headers: {},
    order: index,
    status: {
      connectivity: index % 5 === 0 ? "offline" : "unknown",
      latency: null,
      balance: null,
      balanceKind: "balance",
      balanceUnlimited: false,
      balanceUnit: null,
      balanceSource: null,
      balanceNote: null,
      balanceRaw: null,
      balanceError: null,
      modelListError: null,
      modelListEmpty: false,
      lastTest: null,
      error: null,
      transport: null,
      authMode: "bearer",
      logs: []
    },
    models: Array.from({ length: modelCount }, (_, modelIndex) => startupModel(index, modelIndex))
  };
}

const STARTUP_CONFIG_TEXT = JSON.stringify({
  stations: Array.from({ length: STARTUP_STATION_COUNT }, (_, index) => startupStation(index)),
  settings: {
    view: "list",
    theme: "light",
    proxy: "",
    concurrency: 5,
    timeout: 15,
    testDepth: "basic",
    longContextKB: 4
  },
  uiState: {
    selectedStationId: "startup-station-000",
    selectedModelsByStation: {}
  }
});

function assert(condition, message, details) {
  if (condition) return;
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
}

function parseTrace(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^(\d+)\s+\+\s*(\d+)ms\s+(\S+)\s*(.*)$/);
    return match ? { at: Number(match[1]), sinceMain: Number(match[2]), stage: match[3], label: match[4] } : null;
  }).filter(Boolean);
}

function stageMap(trace) {
  return new Map(trace.map(entry => [entry.stage, entry]));
}

function stageDuration(stages, startStage, endStage) {
  const start = stages.get(startStage);
  const end = stages.get(endStage);
  if (!start || !end) return null;
  const duration = end.at - start.at;
  return duration >= 0 ? duration : null;
}

function measureTrace(trace, launchAt) {
  const stages = stageMap(trace);
  const elapsed = stage => {
    const item = stages.get(stage);
    return item ? item.at - launchAt : null;
  };
  const result = {
    mainStart: elapsed("main-start"),
    appReady: elapsed("app-ready"),
    windowCreateStart: elapsed("window-create-start"),
    windowCreated: elapsed("window-created"),
    serverStart: elapsed("server-start"),
    portPicked: elapsed("port-picked"),
    serverImportStart: elapsed("server-import-start"),
    serverImported: elapsed("server-imported"),
    serverReady: elapsed("server-ready"),
    navigationStarted: elapsed("navigation-started"),
    domReady: elapsed("dom-ready"),
    pageLoaded: elapsed("page-loaded"),
    didStopLoading: elapsed("did-stop-loading"),
    readyToShow: elapsed("ready-to-show"),
    windowShown: elapsed("window-shown"),
    configDir: stages.get("config-dir")?.label || null,
    eventOrderAnomalies: []
  };
  if (result.mainStart != null) result.processBootstrap = result.mainStart;
  result.browserWindowCreate = stageDuration(stages, "window-create-start", "window-created");
  result.serverStartup = stageDuration(stages, "server-start", "server-ready");
  result.serverImport = stageDuration(stages, "server-import-start", "server-imported");
  result.pageToReady = stageDuration(stages, "navigation-started", "ready-to-show");
  result.domToReady = stageDuration(stages, "dom-ready", "ready-to-show");
  result.loadedToReady = stageDuration(stages, "page-loaded", "ready-to-show");
  [
    ["browserWindowCreate", "window-create-start", "window-created"],
    ["serverStartup", "server-start", "server-ready"],
    ["serverImport", "server-import-start", "server-imported"],
    ["pageToReady", "navigation-started", "ready-to-show"],
    ["domToReady", "dom-ready", "ready-to-show"],
    ["loadedToReady", "page-loaded", "ready-to-show"]
  ].forEach(([field, startStage, endStage]) => {
    if (stages.has(startStage) && stages.has(endStage) && result[field] === null) {
      result.eventOrderAnomalies.push(`${endStage} before ${startStage}`);
    }
  });
  if (result.windowShown != null) result.total = result.windowShown;
  const timingEntry = trace.find(entry => entry.stage === "page-timing");
  if (timingEntry) {
    try { result.pageTiming = JSON.parse(timingEntry.label); } catch { /* Ignore malformed diagnostic text. */ }
  }
  return result;
}

function terminateChild(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    let forceTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    child.once("close", finish);
    try { child.kill(); } catch { /* The process may have exited between the check and kill. */ }
    forceTimer = setTimeout(() => {
      if (settled) return;
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.once("close", finish);
      killer.once("error", finish);
      setTimeout(finish, 2000);
    }, 500);
  });
}

function runOne(index) {
  return new Promise((resolve, reject) => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `aihubpanel-startup-${process.pid}-${index}-`));
    const traceFile = path.join(runDir, "boot.log");
    const userDataDir = path.join(runDir, "user-data");
    const dataDir = STARTUP_IS_PACKAGED ? path.join(runDir, "app") : path.join(runDir, "config");
    fs.mkdirSync(dataDir, { recursive: true });
    let executable = STARTUP_EXECUTABLE;
    if (STARTUP_IS_PACKAGED) {
      if (path.basename(path.dirname(STARTUP_EXECUTABLE)).toLowerCase() === "win-unpacked") {
        fs.cpSync(path.dirname(STARTUP_EXECUTABLE), dataDir, { recursive: true });
        executable = path.join(dataDir, path.basename(STARTUP_EXECUTABLE));
      } else {
        executable = path.join(dataDir, path.basename(STARTUP_EXECUTABLE));
        fs.copyFileSync(STARTUP_EXECUTABLE, executable);
      }
    }
    fs.writeFileSync(path.join(dataDir, "config.json"), `${STARTUP_CONFIG_TEXT}\n`, "utf8");
    const launchAt = Date.now();
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const childArgs = STARTUP_IS_PACKAGED
      ? [`--user-data-dir=${userDataDir}`]
      : [ROOT, `--user-data-dir=${userDataDir}`];
    const launchEnv = {
      ...childEnv,
      AIHUB_BOOT_TRACE: traceFile,
      AIHUB_STARTUP_PROBE: "1"
    };
    if (STARTUP_IS_PACKAGED) {
      // 让 portable 启动器自己注入实际 exe 目录，验证生产运行时路径。
      delete launchEnv.PORTABLE_EXECUTABLE_DIR;
      delete launchEnv.PORTABLE_EXECUTABLE_FILE;
    } else {
      // 源码回归仍把配置隔离到临时目录，避免读写项目根目录。
      launchEnv.PORTABLE_EXECUTABLE_DIR = dataDir;
    }
    const child = spawn(executable, childArgs, {
      cwd: ROOT,
      env: launchEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let pollTimer = null;
    let settled = false;
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    const finish = async (error = null) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      await terminateChild(child);
      if (error) {
        reject(error);
      } else {
        const trace = parseTrace(traceFile);
        try {
          assert(trace.some(entry => entry.stage === "window-shown"), `startup run ${index} did not reach window-shown`, { trace, output });
          const result = { index, ...measureTrace(trace, launchAt), trace };
          assert(result.configDir, `startup run ${index} did not report config directory`, { trace, output });
          assert(
            path.resolve(result.configDir).toLowerCase() === path.resolve(dataDir).toLowerCase(),
            `startup run ${index} did not use executable-side data directory`,
            { expected: dataDir, actual: result.configDir, trace }
          );
          resolve(result);
        } catch (assertionError) {
          reject(assertionError);
        }
      }
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* Best effort cleanup. */ }
    };
    const poll = async () => {
      if (settled) return;
      if (fs.existsSync(traceFile) && fs.readFileSync(traceFile, "utf8").includes("window-shown")) {
        await finish();
        return;
      }
      if (child.exitCode !== null) {
        await finish(new Error(`startup child exited with code ${child.exitCode}\n${output}`));
        return;
      }
      if (Date.now() >= deadline) {
        await finish(new Error(`startup run ${index} timed out after ${STARTUP_TIMEOUT_MS}ms\n${output}`));
        return;
      }
      pollTimer = setTimeout(poll, 25);
    };
    poll();
  });
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function summarize(runs) {
  const fields = ["total", "browserWindowCreate", "serverStartup", "pageToReady", "domToReady"];
  return Object.fromEntries(fields.map(field => [field, median(runs.map(run => run[field]))]));
}

async function main() {
  const runs = [];
  for (let index = 1; index <= RUNS; index += 1) {
    const run = await runOne(index);
    runs.push(run);
    console.log(`startup run ${index}: total ${run.total}ms, BrowserWindow ${run.browserWindowCreate}ms, server ${run.serverStartup}ms, page→ready ${run.pageToReady}ms`);
  }
  const summary = summarize(runs);
  assert(Number.isFinite(STARTUP_MAX_TOTAL_MS) && STARTUP_MAX_TOTAL_MS > 0, "AIHUB_STARTUP_MAX_TOTAL_MS must be a positive number");
  assert(summary.total != null && summary.total <= STARTUP_MAX_TOTAL_MS, `startup total exceeded ${STARTUP_MAX_TOTAL_MS}ms`, { summary, runs });
  assert(summary.browserWindowCreate != null && summary.browserWindowCreate <= 2500, "BrowserWindow creation exceeded 2500ms", { summary, runs });
  assert(summary.serverStartup != null && summary.serverStartup <= 1000, "server startup exceeded 1000ms", { summary, runs });
  assert(summary.pageToReady != null && summary.pageToReady <= 2500, "page to ready-to-show exceeded 2500ms", { summary, runs });
  console.log(`startup workload: ${STARTUP_STATION_COUNT} stations, ${STARTUP_HEAVY_MODEL_COUNT + (STARTUP_STATION_COUNT - 1) * STARTUP_NORMAL_MODEL_COUNT} models, ${Buffer.byteLength(STARTUP_CONFIG_TEXT, "utf8")} config bytes`);
  console.log(`startup passed: median ${JSON.stringify(summary)}`);
  console.log(JSON.stringify({ summary, runs }, null, 2));
  app.quit();
}

main().catch(error => {
  console.error(error.message);
  app.exit(1);
});
