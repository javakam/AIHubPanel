const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const NODE_BIN = process.env.npm_node_execpath || "node";
const TEMP_USER_DATA = path.join(os.tmpdir(), `aihubpanel-layout-${process.pid}`);

app.setPath("userData", TEMP_USER_DATA);
app.commandLine.appendSwitch("disable-gpu");

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
      const req = require("node:http").get(url, res => {
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

function seededStation() {
  const name = "超长站点名称-VeryLongUnbrokenSegment1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZVeryLongUnbrokenSegment1234567890ABCDEFGHIJKLMNOPQRSTU";
  const note = "备注文本也很长：".concat("这是一段需要自然换行的中文说明，".repeat(18), "VeryLongUnbrokenSegment1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const modelIds = [
    "openai/gpt-5.1-chat-latest-with-extra-long-routing-prefix",
    "anthropic/claude-sonnet-4.5-thinking-super-long-model-id",
    "google/gemini-3-pro-preview-long-context-json-tools-stream",
    "deepseek/deepseek-reasoner-extremely-long-provider-model-name"
  ];
  const models = Array.from({ length: 18 }, (_, index) => ({
    id: `${modelIds[index % modelIds.length]}-${index}-VeryLongUnbrokenSegment1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    test: index < 4 ? "ok" : "idle",
    latency: index < 4 ? 180 + index * 70 : null,
    lastRequestAt: Date.now() - index * 1000,
    err: null,
    capability: null
  }));
  const logs = models.slice(0, 8).map((model, index) => ({
    id: `log-${index}`,
    at: Date.now() - index * 1000,
    level: index % 2 ? "warn" : "ok",
    kind: index % 2 ? "模型测试" : "余额查询",
    method: index % 2 ? "POST" : "GET",
    endpoint: index % 2 ? "/v1/chat/completions" : "/dashboard/billing/credit_grants",
    model: model.id,
    status: index % 2 ? 200 : null,
    latency: index % 2 ? 1000 + index : null,
    transport: "builtin",
    message: "这是一段很长的日志摘要，用于确认请求日志不会撑开页面 ".repeat(20)
  }));
  return {
    id: "s_layout_long",
    name,
    baseurl: "https://very-long-subdomain-name-for-aihub-panel-audit.example.com/v1/extremely-long-path-segment/extremely-long-path-segment/extremely-long-path-segment/extremely-long-path-segment",
    apikey: "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-END",
    group: "超长分组-VeryLongUnbrokenSegment1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ-业务分组-备用线路",
    note,
    balancePath: "",
    headers: {
      "User-Agent": "claude-cli/2.0.0 (external, cli)",
      "X-Audit-Long": "VeryLongUnbrokenSegment1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    },
    order: 0,
    status: {
      connectivity: "offline",
      latency: 98765,
      balance: 1234567890123.45,
      balanceKind: "quota",
      balanceUnlimited: false,
      balanceUnit: "超长单位-VeryLongUnbrokenSegment1234",
      balanceSource: "自定义接口 · /very/long/balance/path",
      balanceNote: null,
      balanceRaw: null,
      balanceError: null,
      modelListError: null,
      modelListEmpty: false,
      lastTest: Date.now(),
      error: "连接失败",
      transport: "builtin",
      authMode: "x-api-key",
      logs
    },
    models
  };
}

function layoutProbe(label) {
  const info = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
      title: element.getAttribute("title") || "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom)
      },
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      whiteSpace: style.whiteSpace,
      flexShrink: style.flexShrink,
      overflowX: style.overflowX
    };
  };
  const row = [...document.querySelectorAll(".list-pane .row-item")]
    .find(element => (element.textContent || "").includes("超长站点名称"));
  const balanceMetric = row && row.querySelectorAll(".row-metric")[1];
  const balanceValue = balanceMetric && balanceMetric.querySelector(".m-val");
  const metricRect = balanceMetric && balanceMetric.getBoundingClientRect();
  const valueRect = balanceValue && balanceValue.getBoundingClientRect();
  const noteField = document.querySelector(".field-note");
  return {
    label,
    page: {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    },
    badge: info(document.querySelector(".detail-title .badge")),
    balance: {
      metric: info(balanceMetric),
      value: info(balanceValue),
      exceedsMetric: !!(metricRect && valueRect && (valueRect.right > metricRect.right + 1 || valueRect.left < metricRect.left - 1))
    },
    note: {
      field: info(noteField),
      text: info(noteField && noteField.querySelector(".txt"))
    }
  };
}

async function collect(win, label) {
  return win.webContents.executeJavaScript(`(${layoutProbe.toString()})(${JSON.stringify(label)})`, true);
}

async function loadSeededPage(win, baseUrl) {
  await win.loadURL(baseUrl);
  const station = seededStation();
  await win.webContents.executeJavaScript(`
    localStorage.clear();
    localStorage.setItem("aihub.stations.v2", ${JSON.stringify(JSON.stringify([station]))});
    localStorage.setItem("aihub.settings.v2", ${JSON.stringify(JSON.stringify({ view: "list", theme: "light", proxy: "", concurrency: 20, timeout: 15, testDepth: "basic", longContextKB: 4 }))});
    localStorage.setItem("aihub.ui.v1", ${JSON.stringify(JSON.stringify({ selectedStationId: station.id, selectedModelsByStation: {} }))});
    location.reload();
  `, true);
  await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  await delay(120);
}

async function loadEmptyPage(win, baseUrl) {
  await win.loadURL(baseUrl);
  await win.webContents.executeJavaScript(`
    localStorage.clear();
    location.reload();
  `, true);
  await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  await delay(120);
  const empty = await win.webContents.executeJavaScript(`({
    rows: document.querySelectorAll(".row-item").length,
    cards: document.querySelectorAll(".card").length,
    hasEmptyState: !!document.querySelector(".list-pane .empty")
  })`, true);
  assert(empty.rows === 0 && empty.cards === 0 && empty.hasEmptyState, "first run must show an empty station state", empty);
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
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `aihub-layout-${process.pid}`
      }
    });
    await loadEmptyPage(win, baseUrl);
    await loadSeededPage(win, baseUrl);

    win.setContentSize(1280, 900);
    await delay(120);
    const desktop = await collect(win, "desktop-list");
    assert(desktop.badge && desktop.badge.rect.width >= 70 && desktop.badge.rect.height <= 36, "desktop badge must stay one line", desktop.badge);
    assert(!desktop.balance.exceedsMetric, "desktop balance must not overflow its metric cell", desktop.balance);
    assert(desktop.page.scrollWidth <= desktop.page.clientWidth + 2, "desktop page must not have horizontal overflow", desktop.page);

    win.setContentSize(320, 720);
    await delay(160);
    const mobileList = await collect(win, "mobile-list");
    assert(!mobileList.balance.exceedsMetric, "mobile balance must not overflow its metric cell", mobileList.balance);
    assert(mobileList.page.scrollWidth <= mobileList.page.clientWidth + 2, "mobile list must not have horizontal overflow", mobileList.page);

    await win.webContents.executeJavaScript(`document.querySelector(".station-open").click()`, true);
    await delay(160);
    const mobileFocus = await collect(win, "mobile-focus");
    assert(mobileFocus.badge && mobileFocus.badge.rect.width >= 70 && mobileFocus.badge.rect.height <= 36, "mobile focus badge must stay one line", mobileFocus.badge);
    assert(mobileFocus.note.text && mobileFocus.note.text.clientHeight >= 48 && mobileFocus.note.text.whiteSpace === "normal", "long note must be readable in multiple lines", mobileFocus.note);
    assert(mobileFocus.note.field && mobileFocus.note.field.title.length > 100, "long note must keep full title text", mobileFocus.note.field);
    assert(mobileFocus.page.scrollWidth <= mobileFocus.page.clientWidth + 2, "mobile focus must not have horizontal overflow", mobileFocus.page);

    console.log("layout passed: long title, balance, note, and mobile overflow");
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
