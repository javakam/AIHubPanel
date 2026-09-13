// AIHubPanel 桌面版主进程。
// 职责只有两件：把现有 server.mjs 在本进程里跑起来、开窗口加载它。
// 转发和 SSE 流式全部由 server.mjs 和前端原样承担，这里不碰网络。
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const STARTUP_PROBE = process.env.AIHUB_STARTUP_PROBE === "1";
// 启动耗时诊断。默认完全关闭，设了 AIHUB_BOOT_TRACE=<文件路径> 才逐段记时间，
// 用来回答「到底慢在自解压、服务启动还是页面渲染」，不必再改代码重打包。
// 每行前面是绝对时间戳：便携 exe 自解压那几秒发生在本进程存在之前，
// 只有拿外部计时器的启动时刻和这里的绝对时间相减才量得出来。
// 阶段名单独一列且是 ASCII，方便外部脚本按 window-shown 判断「量完了」。
const TRACE_FILE = process.env.AIHUB_BOOT_TRACE || "";
const T0 = Date.now();
function trace(stage, label) {
  if (!TRACE_FILE) return;
  try {
    const line = `${Date.now()} +${String(Date.now() - T0).padStart(5)}ms ${stage} ${label}\n`;
    fs.appendFileSync(TRACE_FILE, line);
  } catch { /* 诊断写不进去不影响启动 */ }
}
trace("main-start", "main.js 开始执行");

let mainWindow = null;

// 打包后 server.mjs 和 public/ 会被 asarUnpack 解到 app.asar.unpacked。
// server.mjs 用自身位置推算 public/ 目录，静态文件也得是真实文件，所以路径统一换到 unpacked 下。
function appPath(...segments) {
  const full = path.join(__dirname, "..", ...segments);
  const packed = `${path.sep}app.asar${path.sep}`;
  return full.includes(packed) ? full.replace(packed, `${path.sep}app.asar.unpacked${path.sep}`) : full;
}

// config.json 和 apikey.json 放 exe 同目录，用户打开程序所在文件夹就能看到、随手改。
// portable 包运行时会把自己解压到临时目录，app.getPath("exe") 指的是那个临时副本。
// electron-builder portable 会提供 PORTABLE_EXECUTABLE_DIR；FILE 作为兼容兜底。
// 开发态（npm start）的 exe 在 node_modules 里，配置写那儿等于丢文件，所以退回仓库根目录。
function configDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  if (process.env.PORTABLE_EXECUTABLE_FILE) return path.dirname(path.resolve(process.env.PORTABLE_EXECUTABLE_FILE));
  return app.isPackaged ? path.dirname(app.getPath("exe")) : path.join(__dirname, "..");
}

// Electron 默认把用户数据和缓存放到 C 盘。便携版配置已经在 exe 同级，
// 这里把运行数据也放到同级隐藏目录，尽量不占用系统盘。
// 单文件 portable 启动前的自解压仍由启动器写入系统临时目录，主进程无法提前接管。
function configureRuntimePaths() {
  const runtimeDir = path.join(configDir(), ".aihubpanel-data");
  const tempDir = path.join(runtimeDir, "temp");
  const paths = {
    appData: path.join(runtimeDir, "app-data"),
    userData: runtimeDir,
    sessionData: path.join(runtimeDir, "session"),
    temp: tempDir,
    logs: path.join(runtimeDir, "logs"),
    crashDumps: path.join(runtimeDir, "crash-dumps")
  };
  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch (error) {
    trace("runtime-dir-fallback", error instanceof Error ? error.message : String(error));
    return null;
  }
  Object.entries(paths).forEach(([name, value]) => {
    try { app.setPath(name, value); } catch { /* 某些 Electron 版本不允许覆盖个别系统路径。 */ }
  });
  try { app.setAppLogsPath(paths.logs); } catch { /* 日志路径已由 setPath 尽量接管。 */ }
  app.commandLine.appendSwitch("disk-cache-dir", path.join(runtimeDir, "cache"));
  app.commandLine.appendSwitch("media-cache-dir", path.join(runtimeDir, "media-cache"));
  app.commandLine.appendSwitch("gpu-cache-dir", path.join(runtimeDir, "gpu-cache"));
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;
  process.env.TMPDIR = tempDir;
  trace("runtime-dir", runtimeDir);
  trace("temp-dir", os.tmpdir());
  return runtimeDir;
}

// server.mjs 只用 Node 内置模块，而主进程本身就是完整的 Node 环境，
// 所以直接 import 进来即可，不必再开一个子进程：省一份运行时内存，
// 也不会在异常退出时留下占着端口的孤儿进程。
// 它在模块加载时就读取环境变量，因此端口必须先写进 process.env。
async function startServer() {
  trace("server-start", "开始启动本地服务");
  // 直接让服务 listen(0) 并返回系统分配的端口，避免“先探测、释放、再监听”的
  // 两次 socket 操作和端口被抢占的竞态。
  process.env.AI_HUB_PORT = "0";
  process.env.AI_HUB_HOST = "127.0.0.1";
  // 用户系统里若设过这个变量，同源校验就只认那个 origin，本窗口的请求会被一律拒掉。
  // 桌面版固定回环监听，用不上它，清掉以免继承到外部配置。
  delete process.env.AI_HUB_ALLOWED_ORIGIN;

  // server.mjs 在模块顶层就建目录、校验参数并 listen；配置不合法会直接抛，
  // 在这里能原样拿到错误信息，比从子进程的 stderr 里捞更准。
  trace("server-import-start", "开始加载 server.mjs");
  const serverModule = await import(pathToFileURL(appPath("server.mjs")).href);
  trace("server-imported", "server.mjs import 完成");
  const address = await serverModule.serverReady;
  const port = address && typeof address === "object" ? address.port : null;
  if (!Number.isInteger(port) || port <= 0) throw new Error("本地服务没有返回有效端口");
  trace("server-ready", "server.listen 已就绪，端口 " + port);
  return port;
}

function createWindow() {
  trace("window-create-start", "开始创建 BrowserWindow");
  const dataDir = configDir();
  trace("config-dir", dataDir);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "AIHubPanel",
    // 打包后的 exe 自带图标资源，开发态（npm start）不指定就会显示 Electron 默认图标。
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#f5f6f8",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // preload 要用 fs 同步读写本地 JSON，sandbox 开着就 require 不到。
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
      // preload 拿不到 app 对象，配置目录只能从主进程传过去。
      additionalArguments: [`--aihub-config-dir=${dataDir}`],
      spellcheck: false
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
  // 站点地址等外链交给系统浏览器，不在面板窗口里打开陌生网页。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    } catch { /* 非法 URL 直接忽略 */ }
    return { action: "deny" };
  });
  trace("window-created", "窗口已创建（尚未加载页面）");
}

// 窗口建好后才知道端口，这里把加载和「画好了再显示」串起来。
// ready-to-show 只在这一刻挂：空窗口不导航不会触发它，但先挂上就得多一层
// 「是不是 about:blank 的首帧」判断，没必要。
function loadPanel(port) {
  mainWindow.webContents.once("dom-ready", () => trace("dom-ready", "文档 DOM 已就绪"));
  mainWindow.webContents.once("did-stop-loading", () => trace("did-stop-loading", "页面停止加载"));
  mainWindow.webContents.once("did-finish-load", () => {
    trace("page-loaded", "页面加载完成");
    void mainWindow.webContents.executeJavaScript(`
      (() => {
        const timing = performance.getEntriesByType("navigation")[0];
        return timing ? {
          responseEnd: timing.responseEnd,
          domContentLoaded: timing.domContentLoadedEventEnd,
          loadEventEnd: timing.loadEventEnd,
          fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null
        } : null;
      })()
    `, true).then(timing => trace("page-timing", JSON.stringify(timing || {}))).catch(() => {});
  });
  mainWindow.once("ready-to-show", () => {
    trace("ready-to-show", "首帧画好");
    if (STARTUP_PROBE) {
      trace("window-shown", "启动探针完成");
      app.quit();
      return;
    }
    mainWindow.show();
    trace("window-shown", "首帧画好，显示窗口");
  });
  void mainWindow.loadURL(`http://127.0.0.1:${port}`);
  trace("navigation-started", "loadURL 已发出");
}

// 单实例锁：两个实例会同时读写同一份配置文件，后写的会覆盖前写的。
configureRuntimePaths();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // server.mjs 只依赖 Node 内置模块，可以在 Electron 完成 ready 前就开始监听；
  // 这样服务模块加载与 Chromium 初始化并行，拿到真实端口后直接导航。
  const serverPromise = startServer();
  // 启动失败会在 app.whenReady 的 await 处统一展示错误；提前挂一个 rejection
  // 处理器，避免服务失败早于 Electron ready 时触发未处理 Promise 警告。
  serverPromise.catch(() => {});
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    trace("app-ready", "app.whenReady");
    Menu.setApplicationMenu(null);
    try {
      // 窗口创建和服务启动互不依赖，原来串着做等于白等一段。
      // createWindow 同步返回，渲染进程和 GPU 通道的拉起在后台进行，
      // 正好和 server.mjs 加载重叠；拿到端口再导航。
      createWindow();
      loadPanel(await serverPromise);
    } catch (error) {
      dialog.showErrorBox("AIHubPanel 启动失败", `本地服务没能启动。\n\n${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
    }
  });

  app.on("window-all-closed", () => app.quit());
}
