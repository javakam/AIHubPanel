# 当前状态

## 正在做什么
- 桌面 exe 化：方案定稿为 Electron（2026-09-02 用户拍板），开工准备已完成，即将从里程碑 0 开工。

## 最近完成
- 2026-09-02：exe 化选型定稿 Electron（推翻此前的 go-webview2，见 decisions.md）。
- 2026-09-02：写好了 prompt.md 施工手册（架构、里程碑、坑、红线），并同步了 docs/agent 工作流文件。

## 下一步
- [ ] 里程碑 0：Electron 最小可跑（spawn server.mjs + BrowserWindow 加载 127.0.0.1，SSE 流式验证）
- [ ] 里程碑 1：preload 存储桥 + config.json 明文读写 + 前端 5 个存储函数切换
- [ ] 里程碑 2：electron-builder 打包 exe（asarUnpack、图标、单实例锁）
- [ ] 里程碑 3：数据迁移 + mock 桩双跑回归
- 详细施工说明、坑和红线都在 prompt.md。

## 备注
- 桌面版做出来之前，日常仍然用 start-aihubpanel.bat 启动网页版，一切照旧。
