# 技术参考

## 构建 / 运行命令
- 网页版：`node server.mjs`（默认端口 4179，本机可能落在 Windows 保留段里，bat 会自动退备用）
- 网页版日常：双击 `start-aihubpanel.bat`，首选 4398，备选 4700/5100/7788/9345/18080
- 桌面版开发：`npm start`（等同 `electron .`，空闲端口，不抢 4398）
- 桌面版首次装：`npm install`。electron 二进制另拉约 150MB，镜像固定在 .npmrc
- 桌面版打包：`npm run dist` → `electron/release/AIHubPanel-1.0.0-portable.exe`（单文件 101MB，启动 7s 含 6s 自解压）和 `AIHubPanel-1.0.0-win.zip`（141MB，目录版 0.6s）
- Git Bash 里 `npm` 不在 PATH，用 `"/c/Program Files/AutoClaw/resources/node/node_modules/npm/bin/npm"`

## 启动耗时（实测，2026-09-03）
- 量法：设 `AIHUB_BOOT_TRACE=<路径>` 再启动，主进程逐段写「绝对时间戳 + 阶段名」（electron/main.js:22）。不设时探针第一行返回，零开销
- 便携 exe：双击到窗口 6.7-7.0s，其中 6.0s 是 NSIS 自解压
- 目录版（win-unpacked/ 或 zip 解压）：双击到窗口 0.58s
- 应用自身耗时（main.js → 窗口显示）：目录版 0.44-0.62s（优化前 1.19s）
- 前端：responseEnd 23ms，DOMContentLoaded 87ms，FCP 76ms
- 优化点：窗口创建与 `await startServer()` 并行（electron/main.js:164）+ 健康检查轮询 20ms

## 打包配置要点（package.json build 字段）
- `electronDist: node_modules/electron/dist`：复用已下载的 electron 二进制
- `asarUnpack` 必须包含 server.mjs 和 public/**/*：`import()` 读不了 asar 里的 .mjs
- `electronLanguages` 只留 en-US 和 zh-CN
- Windows 权限级别键名是 `requestedExecutionLevel`（不是 requestExecutionLevel）
- `win.target` 写 `["zip","portable"]`，artifactName 写在对应 target 的顶层字段

## Windows 保留端口段
- `netsh int ipv4 show excludedportrange protocol=tcp` 查看被系统预留的段
- 4398/4179 经常落在本机预留段里，bind 直接 EACCES
- 想长期占住：`netsh int ipv4 add excludedportrange protocol=tcp startport=4398 numberofports=1 store=persistent`（管理员）

## 编码坑
- `.bat` 正文必须纯 ASCII + CRLF。cmd 按 GBK 解析，UTF-8 中文会被吃掉。`bat` 开头 `chcp 65001` 把控制台切到 UTF-8
- `.ps1` 同样保持纯 ASCII；读 UTF-8 文件用 `Get-Content -Encoding UTF8`

## 关键依赖
- 网页版无第三方依赖，Node 18+
- 桌面版：electron 44.1.1、electron-builder 26.16.0（devDependency 固定）
- Electron 自带 Chromium 和 Node，用户无需 Node/WebView2

## 环境变量
- `AI_HUB_PORT` 监听端口（默认 4179）
- `AI_HUB_HOST` 监听地址（默认 127.0.0.1）
- `AI_HUB_ALLOWED_ORIGIN` 非回环监听时必须设置
- `AI_HUB_PROXY_TIMEOUT_MS` 转发超时（默认 120000）
- `AIHUB_BOOT_TRACE` 启动耗时诊断日志文件路径（设了就开探针）
- `PORTABLE_EXECUTABLE_DIR` 便携 exe 用，决定 configDir() 位置

## 关键外部路径（不在仓库内）
- 本地测试桩：`E:\goodwork\ZCodeData\aihub-probe\mock-upstream.mjs`
- 桌面版验收工具：`E:\goodwork\ZCodeData\aihub-probe\inproc-server-check.mjs`、`cdp-*.mjs`、`m3-*.mjs`
- 启动耗时脚本：`E:\goodwork\ZCodeData\aihub-perf\measure-boot.ps1`

## 代码结构
- `server.mjs` — 静态托管 + /api/proxy 同源转发，SSRF 防护
- `public/index.html` — 页面骨架
- `public/app.js` — 前端全部逻辑（4421 行原生 JS，无框架无构建）
- `public/app.css` — 样式
- `start-aihubpanel.bat` — Windows 一键启动（网页版）
- `electron/main.js` — 桌面版主进程
- `electron/preload.js` — 存储桥，contextBridge 暴露 window.aihubStore
- `electron/icon.png/.ico` — 应用图标
- `package.json` / `.npmrc` — 桌面版依赖与打包配置

## 决策记录
历史决策见 `decisions.md`（已合并到此处的关键决策）：
- 桌面壳选 Electron（推翻 Go+WebView2，2026-09-02）
- 存储用 exe 同目录明文 config.json（替代 localStorage）
- SSE 流式只能走「本地 HTTP 服务 + 浏览器加载 URL」路线
- server.mjs 在主进程内 import，不另起子进程
- 排序五档稳定增量：键不变不移动，键变了单独插
- 打包双产物（zip + portable）共存，让用户自选快或单文件

## 关键内部约束（来自历史审计）
- `modelDisplayTier`（public/app.js:2616）是判断口径的单一来源，「复制可用模型」和排序都靠它
- 测试中卡片保留上次快照排序键，插入比较必须用同一份 `keys`（public/app.js:2668），不能用实时 latency
- `modelListEmpty` 仅在 HTTP 200 + 空数组时为真，任何错误/非空都清
- Electron 错误路径用 `dialog.showErrorBox` + `app.exit(1)`，用户行为不变
- API 请求链固定发起时的 `stationRevision`；自动客户端修复不得在站点编辑/删除后写回旧配置，过期响应体要取消以释放连接。
- 删除或编辑保存失败回滚时要恢复站点、模型勾选、Key 显示和排序快照；站点请求已失效时保留新 revision，避免模型卡永久停在“测试中”。
