# 当前状态

## 正在做什么
- 桌面 exe 化（Electron）。里程碑 3「数据迁移 + 双跑回归」已验收通过，四个里程碑全部完成，桌面版可用。剩下的都是可选打磨。

## 最近完成
- 2026-09-02：里程碑 3 完成。网页版点真实导出按钮拿到备份，喂给桌面版真实导入入口，站点/密钥/自定义头/18 个模型缓存/连通结果全部还原；mock 桩下 17 个模型两侧分级零差异；UA 白名单自动治愈两侧都成功。
- 2026-09-02：修掉 start-aihubpanel.bat 的启动静默失败（4398 落在 Windows 保留端口段，见备注）。
- 2026-09-02：里程碑 2 完成。`npm run dist` 打出单文件便携 exe（约 101MB），换到干净目录双击能开、能测、能存；顺带确认了配置落盘位置（见下）。
- 2026-09-02：里程碑 1 完成。桌面版数据落在 exe 同目录的明文 config.json，网页版仍走 localStorage，互不影响。
- 2026-09-02：里程碑 0 完成。`npm start` 打开窗口、页面正常渲染；mock 桩单测通过且 SSE 逐块返回（11 个分块、间隔约 62ms、首字 63ms）；本地转发和自定义请求头合并在桌面窗口里同样生效。
- 2026-09-02：改用「主进程内 import server.mjs」替代原计划的 spawn 子进程，理由记在 decisions.md。
- 2026-09-02：exe 化选型定稿 Electron（推翻此前的 go-webview2，见 decisions.md）。
- 2026-09-02：写好了 prompt.md 施工手册（架构、里程碑、坑、红线），并同步了 docs/agent 工作流文件。

## 下一步
- 桌面化主线已完结，没有必须做的下一步。剩下两项可选打磨在 progress.md：SmartScreen 代码签名、WebView2 缺失引导。
- 各里程碑的施工步骤、验收标准、坑和红线都在 prompt.md；待办勾选进度在 progress.md。

## 备注
- start-aihubpanel.bat 原本硬编码 4398，而本机 Windows 把 4311-4410 整段预留了（`netsh int ipv4 show excludedportrange protocol=tcp`），bind 直接 EACCES，双击后窗口一闪就没，看起来像「点了没反应」。server.mjs 的默认端口 4179 同样落在预留段里。现在 bat 会先试绑再启动，4398 不可用就退到 4700/5100/7788/9345/18080。换端口意味着浏览器 localStorage 换了一份，面板会是空的，bat 里已经把这点和补救办法打在屏幕上。
- 配置落盘位置已实测：便携 exe 运行时把自己解压到 `%TEMP%\<随机名>\AIHubPanel.exe`，而 config.json 落在用户双击的那个 exe 旁边，取的是 `PORTABLE_EXECUTABLE_DIR`（electron/main.js:57）而不是 `app.getPath("exe")`。之前只是推断，现在是量出来的。
- 打包命令 `npm run dist`，产物在 electron/release/（已 gitignore）；细节记在 techContext.md。
- 桌面版可以直接双击便携 exe 用；网页版仍然用 start-aihubpanel.bat 启动，端口见上。
- 桌面版开发运行是 `npm start`，端口每次随机，和网页版的 4398 互不影响。
- 开发态（`npm start`）的 config.json 落在仓库根目录，已在 .gitignore 里，不会被提交。
