# 进度记录

## 已完成
- 网页版面板：站点管理、连通性与延迟、余额、模型列表、单测/批量模型测试、JSON 备份导入导出、主题
- 本地转发：受限同源转发，SSRF 防护（说明见 README.md 安全设计一节）
- 网关 UA 白名单自动治愈：网关按客户端指纹拦截时自动补 UA 走本地转发（git 82e4ba7）
- 桌面 exe 化：选型定稿为 Electron（见 decisions.md）；此前 Go + WebView2 方案已否决
- 开工准备：prompt.md 施工手册已就绪，含架构、里程碑、坑与红线
- 协作工作流文件搭建（AGENTS.md 和 docs/agent/）

## 待办
- [x] 确认 exe 化方案（2026-09-02 用户拍板 Electron）
- [ ] 里程碑 0：Electron 最小可跑（spawn server.mjs + 窗口加载，SSE 流式验证）
- [ ] 里程碑 1：preload 存储桥 + config.json 明文读写 + 前端存储切换
- [ ] 里程碑 2：electron-builder 打包 exe（asarUnpack、图标、单实例锁）
- [ ] 里程碑 3：数据迁移（浏览器导出→桌面导入）+ mock 桩双跑回归
- [ ] （可选后续）SmartScreen 签名、WebView2 缺失引导等打磨

## 已知问题
- Electron 安装包约 100MB 是既定代价；运行时内存与 Tauri/Wails 相当（大头都是 Chromium）。
- 打包后的 exe 首次运行会弹 SmartScreen「未知发布者」，自用点继续即可；要发给别人才需要买代码签名证书。
- config.json 含 API Key，必须 gitignore，绝不提交进仓库。
- Node 版保留作参照实现：桌面版复用它同一个 server.mjs，转发行为天然一致，但改动转发逻辑时仍需双跑对比。
