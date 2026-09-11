const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEMP_USER_DATA = path.join(os.tmpdir(), `aihubpanel-storage-${process.pid}`);

app.setPath("userData", TEMP_USER_DATA);
app.commandLine.appendSwitch("disable-gpu");

function assert(condition, message, details) {
  if (condition) return;
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
}

function storagePayload() {
  const models = Array.from({ length: 420 }, (_, index) => ({
    id: `storage-provider/model-${String(index).padStart(4, "0")}-long-name`,
    test: index % 3 === 0 ? "ok" : "idle",
    latency: index % 3 === 0 ? 120 + index : null,
    lastRequestAt: null,
    err: null,
    capability: null
  }));
  const stations = Array.from({ length: 60 }, (_, stationIndex) => ({
    id: `storage-station-${String(stationIndex).padStart(3, "0")}`,
    name: `存储回归站点 ${stationIndex}`,
    baseurl: `https://storage-${stationIndex}.example.com/v1`,
    apikey: `sk-storage-fake-${stationIndex}`,
    group: stationIndex % 2 ? "" : "storage-test",
    note: "",
    balancePath: "",
    headers: {},
    order: stationIndex,
    status: {
      connectivity: "unknown",
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
    models: stationIndex === 0 ? models : models.slice(0, 30)
  }));
  return {
    stations,
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
      selectedStationId: "storage-station-000",
      selectedModelsByStation: {}
    }
  };
}

async function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `aihubpanel-storage-run-${process.pid}-`));
  const configDir = path.join(runDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const payload = storagePayload();
  const payloadText = JSON.stringify(payload);
  let win;
  try {
    await app.whenReady();
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 600,
      webPreferences: {
        preload: path.join(ROOT, "electron", "preload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        additionalArguments: [`--aihub-config-dir=${configDir}`]
      }
    });
    await win.loadURL("data:text/html,<html><body>storage regression</body></html>");

    const emptyReads = await win.webContents.executeJavaScript(`
      (() => [
        window.aihubStore.getItem("aihub.stations.v2"),
        window.aihubStore.getItem("aihub.stations.v2"),
        window.aihubStore.getItem("aihub.stations.v2")
      ])()
    `, true);
    assert(emptyReads.every(value => value === null), "missing config reads must follow localStorage semantics", emptyReads);

    fs.writeFileSync(path.join(configDir, "config.json"), `${payloadText}\n`, "utf8");
    const externalRead = await win.webContents.executeJavaScript(`
      JSON.parse(window.aihubStore.getItem("aihub.stations.v2") || "null")?.length || 0
    `, true);
    assert(externalRead === payload.stations.length, "preload cache must notice an external config change", { externalRead });

    const timings = await win.webContents.executeJavaScript(`
      (() => {
        const store = window.aihubStore;
        const stations = ${JSON.stringify(JSON.stringify(payload.stations))};
        const settings = ${JSON.stringify(JSON.stringify(payload.settings))};
        const uiState = ${JSON.stringify(JSON.stringify(payload.uiState))};
        const singleStart = performance.now();
        store.setItem("aihub.stations.v2", stations);
        store.setItem("aihub.settings.v2", settings);
        store.setItem("aihub.ui.v1", uiState);
        const singleWritesMs = performance.now() - singleStart;
        const batchStart = performance.now();
        store.setItems({
          "aihub.stations.v2": stations,
          "aihub.settings.v2": settings,
          "aihub.ui.v1": uiState
        });
        return {
          singleWritesMs,
          batchWriteMs: performance.now() - batchStart,
          hasBatchApi: typeof store.setItems === "function"
        };
      })()
    `, true);
    assert(timings.hasBatchApi, "desktop storage bridge must expose setItems");

    const saved = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
    assert(Array.isArray(saved.stations) && saved.stations.length === payload.stations.length, "batch write lost station data");
    assert(saved.settings && saved.settings.concurrency === payload.settings.concurrency, "batch write lost settings");
    assert(saved.uiState && saved.uiState.selectedStationId === payload.uiState.selectedStationId, "batch write lost UI state");
    console.log(`storage passed: ${payload.stations.length} stations, ${payload.stations.reduce((total, station) => total + station.models.length, 0)} models, ${Buffer.byteLength(payloadText, "utf8")} config bytes, 3 writes ${timings.singleWritesMs.toFixed(1)}ms, batch ${timings.batchWriteMs.toFixed(1)}ms`);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true });
    } catch {
      // Temporary test data cleanup is best effort.
    }
  }
}

main().catch(error => {
  console.error(error.message);
  app.exit(1);
});
