# 当前状态

## 正在做什么
- 桌面 exe 化（Electron）。里程碑 1「存储切换」已验收通过，下一步是里程碑 2：用 electron-builder 打成便携 exe。

## 最近完成
- 2026-09-02：里程碑 1 完成。桌面版数据落在 exe 同目录的明文 config.json，网页版仍走 localStorage，互不影响。
- 2026-09-02：里程碑 0 完成。`npm start` 打开窗口、页面正常渲染；mock 桩单测通过且 SSE 逐块返回（11 个分块、间隔约 62ms、首字 63ms）；本地转发和自定义请求头合并在桌面窗口里同样生效。
- 2026-09-02：改用「主进程内 import server.mjs」替代原计划的 spawn 子进程，理由记在 decisions.md。
- 2026-09-02：exe 化选型定稿 Electron（推翻此前的 go-webview2，见 decisions.md）。
- 2026-09-02：写好了 prompt.md 施工手册（架构、里程碑、坑、红线），并同步了 docs/agent 工作流文件。

## 下一步
- 里程碑 2：electron-builder 打 Windows 便携 exe；`asarUnpack` 要把 server.mjs 和 public/ 解出来；补图标和应用名。
- 打包后要专门验一次配置目录：portable 包运行时会解压到临时目录，配置目录取的是 `PORTABLE_EXECUTABLE_DIR`（electron/main.js:57），不是 `app.getPath("exe")`，这条只有在真打出 exe 后才能确认。
- 各里程碑的施工步骤、验收标准、坑和红线都在 prompt.md；待办勾选进度在 progress.md。

## 备注
- 桌面版还没打包成 exe 之前，日常仍然用 start-aihubpanel.bat 启动网页版，一切照旧。
- 桌面版开发运行是 `npm start`，端口每次随机，和网页版的 4398 互不影响。
- 开发态（`npm start`）的 config.json 落在仓库根目录，已在 .gitignore 里，不会被提交。
