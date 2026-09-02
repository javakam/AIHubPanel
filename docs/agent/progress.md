# 进度记录

## 已完成
- 网页版面板：站点管理、连通性与延迟、余额、模型列表、单测/批量模型测试、JSON 备份导入导出、主题
- 本地转发：受限同源转发，SSRF 防护（说明见 README.md 安全设计一节）
- 网关 UA 白名单自动治愈：网关按客户端指纹拦截时自动补 UA 走本地转发（git 82e4ba7）
- 桌面 exe 化：选型定稿为 Electron（见 decisions.md）；此前 Go + WebView2 方案已否决
- 开工准备：prompt.md 施工手册已就绪，含架构、里程碑、坑与红线
- 协作工作流文件搭建（AGENTS.md 和 docs/agent/）
- 桌面 exe 化里程碑 0/1/2：Electron 最小可跑 → 明文 config.json 存储 → Windows 便携 exe（打包细节见 techContext.md）

## 待办
- [x] 确认 exe 化方案（2026-09-02 用户拍板 Electron）
- [x] 里程碑 0：Electron 最小可跑（主进程内 import server.mjs + 窗口加载，SSE 流式已验证）
- [x] 里程碑 1：preload 存储桥 + config.json 明文读写 + 前端存储切换
- [x] 里程碑 2：electron-builder 打包 exe（asarUnpack、图标、单实例锁）
- [ ] 里程碑 3：数据迁移（浏览器导出→桌面导入）+ mock 桩双跑回归
- [ ] （可选后续）SmartScreen 签名、WebView2 缺失引导等打磨

## 已知问题
- Electron 安装包约 100MB 是既定代价；运行时内存与 Tauri/Wails 相当（大头都是 Chromium）。
- 打包后的 exe 首次运行会弹 SmartScreen「未知发布者」，自用点继续即可；要发给别人才需要买代码签名证书。
- config.json 含 API Key，必须 gitignore，绝不提交进仓库。
- Node 版保留作参照实现：桌面版复用它同一个 server.mjs，转发行为天然一致，但改动转发逻辑时仍需双跑对比。
- 装依赖时 electron 的二进制要另外拉约 150MB，默认源国内基本拉不动；镜像已固定在 .npmrc，换机器装不上先查这里。
- 桌面版的 User-Agent 里带 `aihubpanel-desktop/0.1.0` 和 `Electron/44.1.1`，和浏览器不同。按 UA 白名单放行的网关可能因此变脸，里程碑 3 双跑时要专门核对。
- 桌面版和网页版的数据是两份：桌面读写 config.json，浏览器读写 localStorage，同一台机器上互不同步。要搬数据只能走导出/导入（里程碑 3）。
- portable 包运行时会把自己解压到临时目录，所以配置目录取的是 `PORTABLE_EXECUTABLE_DIR`（electron/main.js:57）。已实测确认：进程跑在 `%TEMP%\<随机名>\AIHubPanel.exe`，而 config.json 落在用户双击的那个 exe 旁边。
