# 决策记录

## 2026-09-02 桌面 exe 方案：Go 单文件 exe + WebView2 壳【已否决】
- 原因：要轻量单文件（约 10MB），前端一行不改；转发层用 Go 标准库 net/http，AI 语料熟、go build 秒级反馈，改起来快；WebView2 是系统自带组件，SSE 流式行为和浏览器一致。
- 代价：转发逻辑要从 JS 移植成 Go，需拿 Node 版当参照做回归验证；窗口壳库 go-webview2 只有约 325 星、偏小众，但查证它是 Wails 在 Windows 的底层绑定、2026-02 仍在更新，README 并未声明不面向独立使用，写对一次后冻结不动。
- 备选方案：Electron（约 100MB，不满足轻量，但零移植、改动最小）；Tauri v2（自定义协议 register_uri_scheme_protocol 的响应体是整体缓冲，SSE 必断流，必须走 sidecar+加载外部 URL，引入 Rust 后变两套语言）；Wails v2（asset server 不支持 http.Flusher，issue 2847 查实未修复，需另起独立 HTTP 服务绕开）。

## 2026-09-02 数据从 localStorage 改为 exe 同目录明文 config.json【已确认】
- 原因：用户要求数据不放浏览器里，要随时能直接打开查看和手工编辑；桌面应用也顺手。
- 代价：前端几个读写函数改成接口调用，服务端加两个接口；浏览器版要导出 JSON 再导入一次做迁移。
- 备选方案：保留 localStorage（不行，桌面版的内嵌浏览器存储和系统浏览器本来就是两套，数据必然搬家）；SQLite（用户不要数据库）。

## 2026-09-02 SSE 流式命门查证结论【已确认】
- 结论：SSE 流式只有一条路能走通——独立本地 HTTP 服务 + WebView 直接加载 http://127.0.0.1，此时 SSE 是标准浏览器行为，逐块读取天然正常。
- 三条「内嵌转发」路线全部整体缓冲、SSE 必断流：Tauri 自定义协议（响应体是 Cow<'static,[u8]>，整块 buffer，必须一次把响应全给完、没法边生成边发）、Wails asset server（ResponseWriter 不支持 http.Flusher，缓冲刷不出去）、WebView2 WebResourceRequested 拦截（原生 IStream 被缓冲）。
- 来源互相印证：Tauri #12557、Wails #2847、WebView2Feedback #3519。因此选型核心不是「哪个框架能流式」，而是「哪个框架做『纯壳 + 加载外部 URL』最干净」。
- 现有 Node 版本身就是「本地 HTTP 服务 + response.body.getReader() 逐块转发」，与这条唯一可行路线完全吻合，壳只负责开窗加载即可。

## 2026-09-02 桌面壳二次评估：推翻 go-webview2，改为 Electron【已确认】
- 推翻理由：go-webview2 仅约 325 星、单点维护，属野库，不满足「主流、官方维护」的硬要求；上一轮为追「磁盘轻量」选了它，是捡芝麻丢西瓜。
- 关键新事实：所有 WebView 壳方案（Electron/Tauri/Wails）运行时内存都在约 300MB（都跑 Chromium/WebView2），「轻量」只体现在磁盘体积（Tauri 约 3MB vs Electron 约 100MB 安装包），不体现在内存。
- 两个真正主流候选：Electron（122k 星、OpenJS 官方、零改动、Node 语料最丰富、磁盘约 100MB）；Tauri + Go sidecar（110k 星、官方、磁盘约 15MB、但转发层要移植成 Go，有同场景先例 oyg123less/sub2api-desktop）。
- 用户拍板（2026-09-02）：选 Electron。前端和转发逻辑一行不动，SSE 天然正常，对 AI 写代码风险最低；代价只有磁盘体积。

## 2026-09-02 Electron 定稿 + 存储桥设计【已确认】
- 定稿：Electron 主进程 spawn 现有 server.mjs 当子进程，BrowserWindow 加载 127.0.0.1；preload 用 contextBridge 暴露同步存储桥 window.aihubStore。施工细节见 prompt.md。
- 关键决策：数据从 localStorage 迁到 config.json 时，不在 server.mjs 加读写接口，改由 preload 同步桥直接读写文件。因为前端 load()（app.js:4348）是同步调用，改成 fetch 会牵动启动流程和几十处 save()/saveSettings() 返回值检查；同步桥让 5 个存储函数保持同步、调用点零改动，网页版留 localStorage 兜底不回归。

新条目往下追加，旧条目不改。经确认后删除【待确认】标记。
