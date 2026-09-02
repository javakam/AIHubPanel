# 技术说明

## 构建 / 运行命令
- 网页版运行：`node server.mjs`（默认端口 4179）
- 网页版日常启动：双击 start-aihubpanel.bat（端口 4398，就绪后自动开浏览器）
- 桌面版（Electron）尚未开工，npm 初始化、electron 启动、electron-builder 打包命令在里程碑 0 之后补充到这里

## 关键依赖
- 网页版无第三方依赖：前端原生 JS，服务端只用 Node 内置模块，Node.js 18+
- 桌面版将引入：electron（运行时）+ electron-builder（打包），均为 devDependency
- Electron 自带 Chromium，不需要系统 WebView2 Runtime

## 环境配置
- 环境变量含义见 README.md 运行一节：AI_HUB_PORT / AI_HUB_HOST / AI_HUB_ALLOWED_ORIGIN / AI_HUB_PROXY_TIMEOUT_MS
- 启动面板一律用 start-aihubpanel.bat（可见窗口、4398 端口），不后台起服务
- 本地测试桩（不在仓库内）：E:\goodwork\ZCodeData\aihub-probe\mock-upstream.mjs，端口 8899，可模拟 UA 白名单锁等网关行为；同目录有 stations-backup.json 可恢复数据

## 代码结构
- server.mjs：静态托管 + /api/proxy 同源转发，SSRF 防护逻辑都集中在这个文件（桌面版原样复用，不改）
- public/index.html：页面骨架
- public/app.js：前端全部逻辑；探测、测试、渲染都在这里，存储读写集中在 load/save 开头的 5 个函数（具体行号见 prompt.md）
- public/app.css：样式
- start-aihubpanel.bat：Windows 一键启动（网页版）
- prompt.md：桌面版施工手册（架构、里程碑、坑、红线）
- electron/：桌面版代码（尚未创建，里程碑 0 建立）
