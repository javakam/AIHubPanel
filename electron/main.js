// AIHubPanel 桌面版主进程。
// 职责只有两件：把现有 server.mjs 在本进程里跑起来、开窗口加载它。
// 转发和 SSE 流式全部由 server.mjs 和前端原样承担，这里不碰网络。
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { pathToFileURL } = require("node:url");

const HEALTH_PATH = "/api/proxy/health";
const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 80;

let mainWindow = null;

// 打包后 server.mjs 和 public/ 会被 asarUnpack 解到 app.asar.unpacked。
// server.mjs 用自身位置推算 public/ 目录，静态文件也得是真实文件，所以路径统一换到 unpacked 下。
function appPath(...segments) {
  const full = path.join(__dirname, "..", ...segments);
  const packed = `${path.sep}app.asar${path.sep}`;
  return full.includes(packed) ? full.replace(packed, `${path.sep}app.asar.unpacked${path.sep}`) : full;
}

// 让系统分配空闲端口：listen 0 拿到端口号后立刻释放。
// 网页版可能正占着 4398，桌面版不写死端口就不会和它互相抢。
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 用面板自带的健康检查确认服务真的能应答，而不是只看端口有没有被占。
function probeHealth(port) {
  return new Promise(resolve => {
    const req = http.get({ host: "127.0.0.1", port, path: HEALTH_PATH, timeout: 1000 }, res => {
      const ok = res.statusCode === 200 && res.headers["x-aihub-proxy"] === "1";
      res.resume();
      resolve(ok);
    });
    req.once("timeout", () => req.destroy());
    req.once("error", () => resolve(false));
  });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// config.json 放 exe 同目录，用户打开程序所在文件夹就能看到、随手改。
// portable 包运行时会把自己解压到临时目录，app.getPath("exe") 指的是那个临时副本，
// 只有 PORTABLE_EXECUTABLE_DIR 才是用户看到的 exe 位置。
// 开发态（npm start）的 exe 在 node_modules 里，配置写那儿等于丢文件，所以退回仓库根目录。
function configDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  return app.isPackaged ? path.dirname(app.getPath("exe")) : path.join(__dirname, "..");
}

// server.mjs 只用 Node 内置模块，而主进程本身就是完整的 Node 环境，
// 所以直接 import 进来即可，不必再开一个子进程：省一份运行时内存，
// 也不会在异常退出时留下占着端口的孤儿进程。
// 它在模块加载时就读取环境变量，因此端口必须先写进 process.env。
async function startServer() {
  const port = await pickFreePort();
  process.env.AI_HUB_PORT = String(port);
  process.env.AI_HUB_HOST = "127.0.0.1";
  // 用户系统里若设过这个变量，同源校验就只认那个 origin，本窗口的请求会被一律拒掉。
  // 桌面版固定回环监听，用不上它，清掉以免继承到外部配置。
  delete process.env.AI_HUB_ALLOWED_ORIGIN;

  // server.mjs 在模块顶层就建目录、校验参数并 listen；配置不合法会直接抛，
  // 在这里能原样拿到错误信息，比从子进程的 stderr 里捞更准。
  await import(pathToFileURL(appPath("server.mjs")).href);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth(port)) return port;
    await wait(READY_POLL_MS);
  }
  throw new Error(`本地服务在 ${READY_TIMEOUT_MS / 1000} 秒内没有就绪`);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "AIHubPanel",
    backgroundColor: "#f5f6f8",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // preload 要用 fs 同步读写 config.json，sandbox 开着就 require 不到。
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
      // preload 拿不到 app 对象，配置目录只能从主进程传过去。
      additionalArguments: [`--aihub-config-dir=${configDir()}`],
      spellcheck: false
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  // 站点地址等外链交给系统浏览器，不在面板窗口里打开陌生网页。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    } catch { /* 非法 URL 直接忽略 */ }
    return { action: "deny" };
  });
  void mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

// 单实例锁：两个实例会同时读写同一份配置文件，后写的会覆盖前写的。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      createWindow(await startServer());
    } catch (error) {
      dialog.showErrorBox("AIHubPanel 启动失败", `本地服务没能启动。\n\n${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    }
  });

  app.on("window-all-closed", () => app.quit());
}
