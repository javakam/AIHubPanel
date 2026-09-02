# 当前状态

## 正在做什么
- 桌面 exe 化（Electron）。里程碑 2「打便携 exe」已验收通过，下一步是里程碑 3：数据迁移 + mock 桩双跑回归。

## 最近完成
- 2026-09-02：里程碑 2 完成。`npm run dist` 打出单文件便携 exe（约 101MB），换到干净目录双击能开、能测、能存；顺带确认了配置落盘位置（见下）。
- 2026-09-02：里程碑 1 完成。桌面版数据落在 exe 同目录的明文 config.json，网页版仍走 localStorage，互不影响。
- 2026-09-02：里程碑 0 完成。`npm start` 打开窗口、页面正常渲染；mock 桩单测通过且 SSE 逐块返回（11 个分块、间隔约 62ms、首字 63ms）；本地转发和自定义请求头合并在桌面窗口里同样生效。
- 2026-09-02：改用「主进程内 import server.mjs」替代原计划的 spawn 子进程，理由记在 decisions.md。
- 2026-09-02：exe 化选型定稿 Electron（推翻此前的 go-webview2，见 decisions.md）。
- 2026-09-02：写好了 prompt.md 施工手册（架构、里程碑、坑、红线），并同步了 docs/agent 工作流文件。

## 下一步
- 里程碑 3：数据迁移（浏览器导出 JSON → 桌面导入）+ mock 桩双跑回归；重点核对按 UA 白名单放行的网关，桌面版 UA 已确认带 `aihubpanel-desktop/0.1.0` 和 `Electron/44.1.1`。
- 各里程碑的施工步骤、验收标准、坑和红线都在 prompt.md；待办勾选进度在 progress.md。

## 备注
- 配置落盘位置已实测：便携 exe 运行时把自己解压到 `%TEMP%\<随机名>\AIHubPanel.exe`，而 config.json 落在用户双击的那个 exe 旁边，取的是 `PORTABLE_EXECUTABLE_DIR`（electron/main.js:57）而不是 `app.getPath("exe")`。之前只是推断，现在是量出来的。
- 打包命令 `npm run dist`，产物在 electron/release/（已 gitignore）；细节记在 techContext.md。
- 桌面版可以直接双击便携 exe 用；网页版仍然用 start-aihubpanel.bat 启动，一切照旧。
- 桌面版开发运行是 `npm start`，端口每次随机，和网页版的 4398 互不影响。
- 开发态（`npm start`）的 config.json 落在仓库根目录，已在 .gitignore 里，不会被提交。
