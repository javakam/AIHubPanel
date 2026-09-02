# 技术说明

## 构建 / 运行命令
- 网页版运行：`node server.mjs`（默认端口 4179）
- 网页版日常启动：双击 start-aihubpanel.bat（端口 4398，就绪后自动开浏览器）
- 桌面版开发运行：`npm start`（等同 `electron .`，自己选空闲端口，不和网页版抢 4398）
- 桌面版首次装依赖：`npm install`。electron 的二进制不在 npm 包里，装完会另拉约 150MB 的 zip；镜像已固定在仓库根的 .npmrc（`electron_mirror=https://cdn.npmmirror.com/binaries/electron/`）
- 桌面版打包：`npm run dist`（等同 `electron-builder --win portable`），产出 electron/release/AIHubPanel-0.1.0-portable.exe（单文件约 101MB）和 electron/release/win-unpacked/（免解压直跑的目录版，约 321MB）。整个 release 目录已 gitignore
- Git Bash 里 npm 不在 PATH，要写 `npm.cmd`

## 打包配置要点（package.json 的 build 字段）
- `electronDist` 指向 node_modules/electron/dist：让 electron-builder 直接拷已下载好的 electron，不再重新拉那 150MB 的 zip。构建日志出现「using custom unpacked Electron distribution」才算生效
- `asarUnpack` 必须包含 server.mjs 和 public/**/*：`import()` 读不了 asar 里的 .mjs，且 server.mjs 用自身路径推算静态目录（server.mjs:12），文件必须真实存在于磁盘
- `electronLanguages` 只留 en-US 和 zh-CN，砍掉其余 locales/*.pak
- Windows 权限级别的键名是 `requestedExecutionLevel`（不是 requestExecutionLevel），写错会报「configuration.win should be one of these: null」这种看不出原因的错
- package.json 缺 `author` 会有警告，顺手补上
- 图标 electron/icon.ico 由 electron/icon.png 生成，图形和页面 favicon（public/index.html:7 的内联 SVG）一致

## 关键依赖
- 网页版无第三方依赖：前端原生 JS，服务端只用 Node 内置模块，Node.js 18+
- 桌面版：electron 44.1.1、electron-builder 26.16.0（均为 devDependency，版本已固定）
- Electron 自带 Chromium 和 Node，用户不需要装 Node，也不需要系统 WebView2 Runtime

## 环境配置
- 环境变量含义见 README.md 运行一节：AI_HUB_PORT / AI_HUB_HOST / AI_HUB_ALLOWED_ORIGIN / AI_HUB_PROXY_TIMEOUT_MS
- 启动面板一律用 start-aihubpanel.bat（可见窗口、4398 端口），不后台起服务
- 桌面版数据文件：exe 同目录的 config.json，明文，结构是 stations / settings / uiState 三个字段。开发态（`npm start`）落在仓库根目录，已 gitignore。便携 exe 下这个「同目录」指用户双击 exe 所在的目录，不是运行时的临时解压目录
- 本地测试桩（不在仓库内）：E:\goodwork\ZCodeData\aihub-probe\mock-upstream.mjs，端口作为第一个参数传入（8899 已被别的程序占用时改用 8901），可模拟 UA 白名单锁等网关行为；同目录有 stations-backup.json 可恢复数据
- 桌面版验收工具（同目录，不在仓库内）：inproc-server-check.mjs 验证主进程内起服务；cdp-eval.mjs / cdp-shot.mjs 通过 `--remote-debugging-port=9223` 在窗口里执行表达式和截图

## 代码结构
- server.mjs：静态托管 + /api/proxy 同源转发，SSRF 防护逻辑都集中在这个文件（桌面版原样复用，不改）
- public/index.html：页面骨架
- public/app.js：前端全部逻辑；探测、测试、渲染都在这里，存储读写集中在 load/save 开头的 5 个函数（具体行号见 prompt.md）
- public/app.css：样式
- start-aihubpanel.bat：Windows 一键启动（网页版）
- prompt.md：桌面版施工手册（架构、里程碑、坑、红线）
- electron/main.js：桌面版主进程（选端口、起服务、开窗口、单实例锁、算配置目录）
- electron/preload.js：存储桥，contextBridge 暴露 window.aihubStore，内部用 fs 同步读写 config.json
- electron/icon.png、electron/icon.ico：应用图标（打包和窗口都用它）
- package.json / .npmrc：桌面版依赖、打包配置与 electron 二进制镜像
