# 技术说明

## 构建 / 运行命令
- 网页版运行：`node server.mjs`（默认端口 4179）
- 网页版日常启动：双击 start-aihubpanel.bat（端口 4398，就绪后自动开浏览器）
- 桌面版开发运行：`npm start`（等同 `electron .`，自己选空闲端口，不和网页版抢 4398）
- 桌面版首次装依赖：`npm install`。electron 的二进制不在 npm 包里，装完会另拉约 150MB 的 zip；镜像已固定在仓库根的 .npmrc（`electron_mirror=https://cdn.npmmirror.com/binaries/electron/`）
- electron-builder 打包命令在里程碑 2 补充到这里

## 关键依赖
- 网页版无第三方依赖：前端原生 JS，服务端只用 Node 内置模块，Node.js 18+
- 桌面版：electron 44.1.1（devDependency）；打包用的 electron-builder 在里程碑 2 引入
- Electron 自带 Chromium 和 Node，用户不需要装 Node，也不需要系统 WebView2 Runtime

## 环境配置
- 环境变量含义见 README.md 运行一节：AI_HUB_PORT / AI_HUB_HOST / AI_HUB_ALLOWED_ORIGIN / AI_HUB_PROXY_TIMEOUT_MS
- 启动面板一律用 start-aihubpanel.bat（可见窗口、4398 端口），不后台起服务
- 桌面版数据文件：exe 同目录的 config.json，明文，结构是 stations / settings / uiState 三个字段。开发态（`npm start`）落在仓库根目录，已 gitignore
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
- package.json / .npmrc：桌面版依赖与 electron 二进制镜像
