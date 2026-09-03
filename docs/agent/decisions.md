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
- 关键决策：数据从 localStorage 迁到 config.json 时，不在 server.mjs 加读写接口，改由 preload 同步桥直接读写文件。因为前端 load()（app.js:4357）是同步调用，改成 fetch 会牵动启动流程和几十处 save()/saveSettings() 返回值检查；同步桥让 5 个存储函数保持同步、调用点零改动，网页版留 localStorage 兜底不回归。

## 2026-09-02 server.mjs 在主进程内 import，不另起子进程【待确认】
- 原来的打算是用 `ELECTRON_RUN_AS_NODE=1` spawn 一个子进程跑 server.mjs。改成在主进程里 `import()` 它。
- 原因：Electron 主进程本身就是完整的 Node 环境，server.mjs 只用内置模块，直接 import 就能跑；少一份 Node 运行时内存，也不会在主进程异常退出时留下占着端口的孤儿进程。它在模块顶层读 `AI_HUB_PORT` 并 listen，所以只要先把端口写进 `process.env` 再 import，效果和子进程完全一样。配置不合法时它直接抛错，在主进程里能原样拿到错误信息，比从子进程 stderr 里捞更准。
- 代价：server.mjs 崩了会连带主进程；但它只用内置模块、逻辑冻结不动，风险可接受。打包时仍必须 `asarUnpack` server.mjs，因为 `import()` 读不了 asar 里的 .mjs。
- 附带发现：拼接子进程命令行的写法会被安全扫描判为命令注入，import 方案顺带绕开了这个问题。

## 2026-09-02 存储桥的三处施工细节（原方案没写）【待确认】
- 原子写：先写 `config.json.tmp` 再改名，避免写一半断电留下半截 JSON；改名被杀软或正打开该文件的编辑器挡住时退回直接覆写，保证「宁可覆写也不能不保存」。
- 缓存失效用文件戳：用户随时可能自己打开 config.json 改内容，所以每次读写前先比对 `mtimeMs:size`，只有确认文件没变才用内存缓存，否则重新读盘。已实测：手工改过的备注不会被应用的下一次写入吃掉。
- key 白名单：桥只认那 3 个存储 key（electron/preload.js:11），其余一概拒绝，防止这座桥变成任意文件的读写通道。
- 附带的措辞调整：几处面向用户的提示从「浏览器存储」改成「本地存储」，桌面版写的是文件，原措辞会误导。

## 2026-09-02 打包只出便携单文件 exe，不做安装包【待确认】
- 决定：electron-builder 的 target 只留 `portable`，产出一个 AIHubPanel-0.1.0-portable.exe，不做 NSIS 安装包。
- 原因：这是自用的本地工具，用户要的是「拷到哪儿都能跑、数据就在 exe 旁边」。安装包会把程序装进 Program Files，那是只读目录，config.json 反而写不进去，等于把里程碑 1 的明文文件存储又搞复杂了。便携版天然满足「随时打开 config.json 手工编辑」。
- 代价：便携 exe 每次启动都要自解压到临时目录，冷启动比目录版慢一点；进程路径看着在 %TEMP%，容易让人误以为数据也在临时目录。真要免解压可以直接用 electron/release/win-unpacked/ 那个目录版。

## 2026-09-02 electronDist 复用本地已下载的 electron【待确认】
- 决定：build 配置里加 `electronDist: node_modules/electron/dist`。
- 原因：electron-builder 默认会自己去下载对应版本的 electron zip（约 150MB），国内源基本拉不动，而 `npm install` 时那份二进制已经躺在 node_modules 里了。指过去直接拷，打包从「大概率失败」变成稳定几十秒完成。
- 代价：打包机器必须先 `npm install` 成功；node_modules 里的 electron 版本和 package.json 里的 devDependency 版本必须一致，换版本时别只改 package.json 不重装。

## 2026-09-02 start-aihubpanel.bat 改为启动前试绑端口并自动退备用【待确认】
- 决定：bat 不再硬编码 4398 直接启动，而是先用 PowerShell 的 TcpListener 依次试绑 4398 / 4700 / 5100 / 7788 / 9345 / 18080，选中第一个真能绑的传给 server.mjs；一个都绑不上就报错并提示怎么查保留段。
- 原因：4398 落在本机 Windows 的保留端口段 4311-4410 里（server.mjs 的默认 4179 也落在 4103-4202 里），bind 直接 EACCES。node 报完错就退出，窗口一闪而过，用户看到的是「双击了没反应」，完全无从下手。保留段由 Hyper-V/WSL/Docker 在开机时申请，位置每次重启都可能变，所以不能换一个固定端口了事——必须运行时探。
- 代价：换端口等于换一份浏览器 localStorage，面板会是空的。这一点没法在代码层面消除（同源策略如此），所以退备用时会在窗口里明确说明「老数据没丢，只是这个地址看不到，用导出/导入搬过去」，并给出用 netsh 长期占住 4398 的命令。另外 bat 正文必须保持纯 ASCII、CRLF 换行，否则 cmd 按 GBK 解析会错乱（细节在 techContext.md）。

## 2026-09-03 模型排序：五档 + 稳定增量排序【待确认】
- 决定：展示顺序分五档（可用 → 受限但核心项都通 → 受限且核心项有失败 → 未测试/测试中 → 不可用/失败），档内按响应速度从快到慢，没测出延迟的排本档末尾。每张卡片带一个排序键（档位:延迟）；键没变的卡片不许移动，键变了的（刚测完、刚加入）单独摘出来排序后插回队列。
- 原因：用户看到「未连通的排到了已连通前面」。旧实现是「整列重排 + 测试期间冻结顺序」：一轮批测没结束前，列表一直停在测试前的顺序，所以不可用的照样压在可用的上面；等批测结束又几十张卡片同时换位，就是「方块跳来跳去」。两个毛病同源——顺序要么全对要么全不动，没有中间态。
- 权衡：改成增量后，每个测试结果落地时对应的那一张卡片会滑动一次。这次移动有明确来由（它刚测出结果），比整列重排容易接受；而且保留列表本身有序、插入不破坏有序性，所以任何时刻看到的都是完整正确的顺序，不再有「先给你看个错的、等会儿再纠正」的阶段。
- 一个细节：测试中的模型延迟被清空、档位会掉回「未测试」，此时沿用它上一次的排序键，免得一次重测把卡片先甩到未测试区再弹回来（同一张卡片来回跳两次）。
- 判断口径收敛在 `modelDisplayTier`（public/app.js:2616），和「复制可用模型」用的是同一套判断，不会出现「排在可用区但复制不到」。

## 2026-09-03 打包同时出 zip 目录版，便携 exe 保留【待确认】
- 决定：`win.target` 从只有 `portable` 改成 `["zip","portable"]`，一次打包出两个产物。
- 原因：便携单文件 exe 每次启动都要把约 100MB 自解压到 %TEMP%，实测这一段就占 6 秒，占了「双击到看见窗口」7 秒里的 85%。查了 electron-builder 的实现，这 6 秒在配置层调不动：portable.nsi 启动时无条件 `RMDir /r $INSTDIR` 再重新解压（所以 `unpackDirName` 复用缓存的思路不成立，目录先被删了），NsisTarget.js 写死了压缩器选项，且 portable 只读内置模板、不接受自定义 script。既然改不动，就给用户一条没有这一步的路。
- 代价：多一个 141MB 的产物，用户要自己决定用哪个。取舍很清楚——要「单文件、拷走就能跑」就用 exe，要「开得快」就用 zip 解出来的目录版（实测 0.58 秒）。这条也部分推翻了上面「打包只出便携单文件 exe」那条：不是那条错了（安装包确实不合适），而是当时没量过自解压的代价。

## 2026-09-03 窗口创建与服务启动并行【待确认】
- 决定：`createWindow(await startServer())` 拆成 `createWindow(); loadPanel(await startServer())`；健康检查轮询间隔 80ms 降到 20ms。
- 原因：这两件事本来互不依赖，串着做等于让渲染进程和 GPU 通道的拉起干等端口探测和 server.mjs 加载。实测应用自身首帧从 1186ms 降到约 440ms。
- 代价：窗口对象在服务就绪前就存在了，所以 `ready-to-show` 必须挪到 `loadPanel` 里挂——空窗口不导航不会触发它，但要是提前挂上，就得多一层「这是不是 about:blank 的首帧」判断，没必要。服务启动失败时窗口已经建好但没导航，仍然走原来的错误弹窗 + `app.exit(1)`，用户看到的行为不变。
- 顺带加了默认关闭的启动耗时探针（`AIHUB_BOOT_TRACE`）。不设这个环境变量时第一行就返回，正常使用零开销；有了它才能分清「慢在自解压还是慢在应用」，否则只能猜。

新条目往下追加，旧条目不改。经确认后删除【待确认】标记。
