# 当前状态

## 正在做什么
- 桌面 exe 化：方案已定（Go 单文件 exe + WebView2 壳 + 明文 config.json，理由见 decisions.md，尚未确认）。确认后从里程碑 0 开工。

## 最近完成
- 2026-09-02：exe 化调研完成：GitHub 上没有现成轮子，Electron/Tauri/Wails 均有硬伤，最终选 Go + WebView2。
- 2026-09-02：搭好这套协作工作流（AGENTS.md 和 docs/agent/）。

## 下一步
- [ ] 确认方案：用户把 decisions.md 里的【待确认】删掉
- [ ] 里程碑 0：Go 起 SSE echo 服务 + WebView2 窗口，验证 exe 里流式转发可行。成败在此一举：go-webview2 不行就换 Wails 壳，业务代码不受影响
- [ ] 里程碑 1：静态资源嵌入 exe，config.json 明文读写，前端存储从 localStorage 换成文件接口
- [ ] 里程碑 2：server.mjs 的转发逻辑移植成 Go，用 mock 桩做双跑对比
- [ ] 里程碑 3：图标、单实例锁、打包单 exe
- [ ] 数据迁移：浏览器版导出 JSON，桌面版导入一次

## 备注
- 桌面版做出来之前，日常仍然用 start-aihubpanel.bat 启动网页版，一切照旧。
