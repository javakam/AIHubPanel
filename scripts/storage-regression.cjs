const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TEMP_USER_DATA = path.join(os.tmpdir(), `aihubpanel-storage-${process.pid}`);
// 存储回归全程是同步 fs 调用加窗口 await，任何一步卡住都会让 npm test 无声挂死。
const WATCHDOG_MS = Number(process.env.AIHUB_STORAGE_WATCHDOG_MS) || 120000;

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
  const watchdog = setTimeout(() => {
    console.error(`storage regression watchdog fired after ${WATCHDOG_MS}ms`);
    app.exit(1);
  }, WATCHDOG_MS);
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
    const migratedConfig = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
    const migratedKeys = JSON.parse(fs.readFileSync(path.join(configDir, "apikey.json"), "utf8"));
    assert(migratedConfig.stations.every(station => !Object.prototype.hasOwnProperty.call(station, "apikey")), "legacy config migration must remove API Key fields");
    assert(migratedKeys.version === 1 && Object.keys(migratedKeys.keys || {}).length === payload.stations.length, "legacy config migration must create apikey.json");

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
    const savedKeys = JSON.parse(fs.readFileSync(path.join(configDir, "apikey.json"), "utf8"));
    assert(Array.isArray(saved.stations) && saved.stations.length === payload.stations.length, "batch write lost station data");
    assert(saved.settings && saved.settings.concurrency === payload.settings.concurrency, "batch write lost settings");
    assert(saved.uiState && saved.uiState.selectedStationId === payload.uiState.selectedStationId, "batch write lost UI state");
    assert(saved.stations.every(station => !Object.prototype.hasOwnProperty.call(station, "apikey") && !Object.prototype.hasOwnProperty.call(station, "apiKey")), "config.json must not contain station API Key fields");
    assert(!JSON.stringify(saved).includes("sk-storage-fake-"), "config.json must not contain API Key values");
    assert(savedKeys.version === 1 && savedKeys.keys && Object.keys(savedKeys.keys).length === payload.stations.length, "apikey.json must contain one key per station");

    const updatedStations = payload.stations.map(station => ({
      ...station,
      apikey: station.id === payload.stations[0].id ? "" : station.apikey
    }));
    await win.webContents.executeJavaScript(`
      window.aihubStore.setItem("aihub.stations.v2", ${JSON.stringify(JSON.stringify(updatedStations))})
    `, true);
    const afterKeyRemoval = JSON.parse(fs.readFileSync(path.join(configDir, "apikey.json"), "utf8"));
    assert(!Object.prototype.hasOwnProperty.call(afterKeyRemoval.keys || {}, payload.stations[0].id), "clearing a station API Key must remove it from apikey.json");
    const roundTripStations = JSON.parse(await win.webContents.executeJavaScript("window.aihubStore.getItem('aihub.stations.v2')", true));
    assert(roundTripStations[0].apikey === "", "cleared API Key must stay cleared after reload");

    // A station whose id is not a usable string cannot have its Key filed under apikey.json.
    // The read path must keep the field on the station instead of dropping it: dropping made
    // the Key vanish from both files, and the next save persisted that loss.
    const orphanConfig = { stations: [{ name: "no-id station", baseurl: "https://orphan.example.com/v1", apikey: "sk-orphan-fake-0001" }] };
    fs.writeFileSync(path.join(configDir, "config.json"), `${JSON.stringify(orphanConfig, null, 2)}\n`, "utf8");
    const orphanRead = JSON.parse(await win.webContents.executeJavaScript("window.aihubStore.getItem('aihub.stations.v2')", true));
    assert(orphanRead.length === 1 && orphanRead[0].apikey === "sk-orphan-fake-0001", "a station without a string id must keep its API Key", orphanRead);
    const orphanSaved = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
    assert(orphanSaved.stations[0].apikey === "sk-orphan-fake-0001", "migration must not strip the API Key of a station that has no id", orphanSaved.stations[0]);

    // The read filter must not re-apply the UI's length/control-character rules: a Key that is
    // on disk has to come back out, otherwise the next save erases it.
    const longKey = `sk-${"a".repeat(3000)}`;
    const longKeyStations = JSON.stringify([{ id: "storage-station-longkey", name: "long key station", baseurl: "https://longkey.example.com/v1", apikey: longKey }]);
    await win.webContents.executeJavaScript(`window.aihubStore.setItem("aihub.stations.v2", ${JSON.stringify(longKeyStations)})`, true);
    const longKeySaved = JSON.parse(fs.readFileSync(path.join(configDir, "apikey.json"), "utf8"));
    assert(longKeySaved.keys["storage-station-longkey"] === longKey, "a long API Key must survive the write path", { length: longKey.length });
    const longKeyRead = await win.webContents.executeJavaScript(`(() => { const list = JSON.parse(window.aihubStore.getItem("aihub.stations.v2") || "[]"); return list[0] && list[0].apikey; })()`, true);
    assert(longKeyRead === longKey, "a long API Key must survive the read path", { length: longKeyRead ? longKeyRead.length : 0 });

    // A corrupted config.json must be recovered from the .bak left by the overwrite fallback.
    // Treating it as "no stations at all" let the user's next save wipe the file for good.
    const backupConfig = { stations: [{ id: "bak-station", name: "from backup", baseurl: "https://backup.example.com/v1" }] };
    fs.writeFileSync(path.join(configDir, "config.json.bak"), `${JSON.stringify(backupConfig, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(configDir, "config.json"), `{ "stations": [ truncated`, "utf8");
    const recovered = JSON.parse(await win.webContents.executeJavaScript("window.aihubStore.getItem('aihub.stations.v2')", true));
    assert(recovered.length === 1 && recovered[0].name === "from backup", "a corrupted config.json must be recovered from its backup", recovered);
    const healed = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
    assert(healed.stations[0].name === "from backup", "recovering from the backup must rewrite config.json", healed.stations[0]);

    console.log(`storage passed: ${payload.stations.length} stations, ${payload.stations.reduce((total, station) => total + station.models.length, 0)} models, ${Buffer.byteLength(payloadText, "utf8")} config bytes, 3 writes ${timings.singleWritesMs.toFixed(1)}ms, batch ${timings.batchWriteMs.toFixed(1)}ms`);
  } finally {
    clearTimeout(watchdog);
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
