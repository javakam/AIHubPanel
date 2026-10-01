# 技术参考

## 构建 / 运行命令
- 网页版：`node server.mjs`（默认端口 4179，本机可能落在 Windows 保留段里，bat 会自动退备用）
- 网页版日常：双击 `start-aihubpanel.bat`，首选 4398，备选 4700/5100/7788/9345/18080；默认只启动服务并打印地址，不自动打开浏览器，设置 `AI_HUB_OPEN_BROWSER=1` 才会自动打开
- 基础回归：`npm run check`，会执行 JS 语法检查、`git diff --check` 和 `server.mjs` 本地接口烟测
- 完整回归：`npm test`，依次执行基础接口、长文本布局、性能 / 内存、存储和启动回归
- 性能 / 内存回归：`npm run test:perf`，使用隔离 Electron profile 和合成站点数据，复验渲染耗时、DOM 数量、横向溢出和 renderer 内存变化
- 桌面版开发：`npm start`（等同 `electron .`，空闲端口，不抢 4398）
- 桌面版首次装：`npm install`。electron 二进制另拉约 150MB，镜像固定在 .npmrc
- 桌面版打包：`npm run dist` → `electron/release/AIHubPanel-1.2.0.exe`（单文件非安装版）；脚本会清理旧的 `electron/release/` 内容，完成后只保留这一个 exe
- 桌面版数据：exe 同级 `config.json` 保存普通配置和测试记录，`apikey.json` 单独保存 API Key；Electron 缓存、日志和临时运行数据在同级 `.aihubpanel-data/`
- Git Bash 里 `npm` 不在 PATH，用 `"/c/Program Files/AutoClaw/resources/node/node_modules/npm/bin/npm"`。必须写绝对路径调用：把该 `bin` 目录塞进 PATH 再让 shell 自己解析，shim 会按 `$0` 推出双份路径并报 `Cannot find module ...\npm\bin\node_modules\npm\bin\npm-cli.js`
- `npm test` 会嵌套调用 `npm run check` 等子命令，子进程内 `npm` 仍需在 PATH 上，本机因此跑不了完整 `npm test`；按 package.json 里的定义逐条串起来等价（`node scripts/regression.mjs && node node_modules/electron/cli.js scripts/layout-regression.cjs && …`）
- 若 `npm` 完全不可用，可直接跑底层脚本，等价于对应 npm script：基础回归 `node scripts/regression.mjs`，其余四个套件 `node node_modules/electron/cli.js scripts/<名字>.cjs`

## 启动耗时（实测，2026-09-11 ~ 2026-09-13）
- 量法：设 `AIHUB_BOOT_TRACE=<路径>` 再启动，主进程逐段写「绝对时间戳 + 阶段名」（electron/main.js:22）；不设置时不写诊断日志，正常启动无额外开销
- 合成负载：60 个站点、2190 个模型、335901 字节配置；启动回归使用隔离 Electron profile，不读取根目录 `config.json`
- 1.1.0 单文件非安装版：启动回归会复制 exe 到临时测试目录，验证 portable 启动器实际把配置目录和运行目录指向 exe 同级目录；本轮三次总耗时约 6.6/8.0/8.2 秒，中位数约 8.0 秒
- 1.1.1 单文件非安装版（打包态实测，`AIHUB_STARTUP_EXECUTABLE` 指向真实 exe）：中位数总耗时 5635ms，browserWindowCreate 42ms、serverStartup 41ms、pageToReady 360ms、domToReady 23ms；同时校验 `config.json`/`apikey.json` 分文件落盘与 `.aihubpanel-data` 运行目录都在 exe 同级
- 1.2.0 单文件非安装版（打包态实测，同上量法）：中位数总耗时 5326ms，browserWindowCreate 37ms、serverStartup 37ms、pageToReady 326ms、domToReady 19ms
- 1.2.0 清理死代码后重新打包的产物（同一版本号，sha256 `c649abaf…`）：中位数总耗时 5551ms，browserWindowCreate 41ms、serverStartup 40ms、pageToReady 371ms、domToReady 22ms。与应用自身耗时的差异同上一轮一样来自机器负载，不要当成清理带来的退化。
- 比较 1.1.0 与 1.1.1 的便携启动耗时要先排除机器负载：同日的性能回归重复切换耗时在 3.0–4.6s 之间波动，上面几组数字只在各自当次环境下可比
- 应用自身耗时（main.js → 窗口显示）：源码回归中位数约 0.638s；服务启动约 39-40ms，页面导航到首帧约 0.38-0.41s
- 前端：合成负载下 responseEnd 47-67ms，DOMContentLoaded 308-330ms（首次载入还会受 Electron 冷启动影响）
- 优化点：窗口创建与 `await serverPromise` 并行（electron/main.js:216，等待在 :234）+ 由 `serverReady` 直接返回监听状态
- 产物回归：给 `AIHUB_STARTUP_EXECUTABLE` 设置打包后的 exe 绝对路径即可复用同一脚本；便携版测量时必须抬高 `AIHUB_STARTUP_MAX_TOTAL_MS`（默认 5000 卡在自解压耗时上，1.2.0 实测用 15000）；每次均验证 `configDir` 等于实际 exe 同级目录

## 打包配置要点（package.json build 字段）
- `electronDist: node_modules/electron/dist`：复用已下载的 electron 二进制
- `asarUnpack` 必须包含 server.mjs 和 public/**/*：`import()` 读不了 asar 里的 .mjs
- `electronLanguages` 只留 en-US 和 zh-CN
- Windows 权限级别键名是 `requestedExecutionLevel`（不是 requestExecutionLevel）
- `win.target` 只保留 `["portable"]`，artifactName 为 `AIHubPanel-${version}.exe`
- 发版改版本号要同步四处，漏改会让门禁或产物名对不上：`package.json`、`package-lock.json` 的根包（两处，第 3 行和第 9 行）、README 里的产物名、以及 `scripts/regression.mjs:147` 钉死的版本断言（不改这一处 `npm run check` 会直接失败）
- `electron-builder` 的 nsis / 7zip / nsis-resources 已在 `%LOCALAPPDATA%\electron-builder\Cache`，打包不必联网下载这些；本机没有 npm 时直接跑 `node scripts/clean-release.mjs && node node_modules/electron-builder/cli.js --win portable && node scripts/clean-release.mjs --keep-portable`，与 `npm run dist` 等价

## 产物清理坑
- `npm run dist` 会先清空 `electron/release/`，而用户平时就是双击这个目录里的 exe：目录里的 `config.json`、`apikey.json` 是真实数据，会被一起删掉。打包前先备份这两个文件，打包后还原（1.2.0 用的是 `E:\goodwork\ZCodeData\aihubpanel-release-data-backup\`，还原后按 sha256 核对）。`.aihubpanel-data/` 是可再生的 Chromium 缓存和会话，删掉不影响数据。
- 清理脚本报 `EPERM: Permission denied` 删不掉 `electron/release` 时，先看是不是某个 shell/资源管理器把「当前工作目录」留在了里面：Windows 不允许删除任何进程的 CWD，这种占用重试也不会好。把 CWD 换出去再删即可（本次实测换到 `E:\` 后逐个条目都删得掉）。
- 杀软扫描 100MB 的 exe 也会造成瞬时 `EPERM/EBUSY`，这类可恢复占用由 `scripts/clean-release.mjs:11` 的 `maxRetries` 退避重试覆盖；真正的占用仍然让脚本失败退出，不静默放过。

## 体积构成与瘦身实测（2026-09-13）
- 仓库 574MB 的构成：`node_modules` 463MB（只有 devDependency，不随产物分发）、`electron/release` 107MB（产物 exe 101MB + 用户数据）、全部源码合计约 352KB（app.js 261KB、app.css 78KB、index.html 15.8KB）。所以「项目太大」永远指前两项，改源码省不出可感知的体积。
- Electron 运行时（367MB 解包后）本身是 exe 的主体：electron.exe 233.9MB、dxcompiler.dll 24.6MB、LICENSES.chromium.html 19.5MB、resources.pak 11.9MB、icudtl.dat 10.4MB、locales 49MB。
- 实测 `--config.compression=maximum` 单加压缩：产物 101224169 字节，与默认压缩的 101221724 字节没有区别。便携包内部主体是已压缩的 exe/dll/pak，二次压缩挤不出空间，不要再试这条。
- 实测 afterPack 删 7 个运行时文件（dxcompiler.dll、dxil.dll、vk_swiftshader.dll、vk_swiftshader_icd.json、vulkan-1.dll、LICENSES.chromium.html、ffmpeg.dll）：产物 101221724 → 92051519 字节（87.8MiB，−9%），打包态启动回归 EXIT=0 且能到 window-shown。收益不到 10%，代价是拿掉软件渲染/无 GPU 回退与系统 ffmpeg，属未经真实机器验证的运行时改动，因此未采纳。
- 已生效的常规瘦身只有 `electronLanguages` 只留 en-US / zh-CN（locales 49MB 里砍掉其余语言）。要继续变小只能动 Electron 运行时二进制，不建议；想「启动更快」应该走 zip 目录版而不是 portable，portable 的自解压开销（约 5 秒）在配置层调不动。
- 临时构建验证放在仓库外（`E:\goodwork\ZCodeData\` 下的探测目录），不要往 `electron/release/` 里塞对比产物——那里是用户双击运行的真实目录。

## Windows 保留端口段
- `netsh int ipv4 show excludedportrange protocol=tcp` 查看被系统预留的段
- 4398/4179 经常落在本机预留段里，bind 直接 EACCES
- 想长期占住：`netsh int ipv4 add excludedportrange protocol=tcp startport=4398 numberofports=1 store=persistent`（管理员）

## 编码坑
- `.bat` 正文必须纯 ASCII + CRLF。cmd 按 GBK 解析，UTF-8 中文会被吃掉。`bat` 开头 `chcp 65001` 把控制台切到 UTF-8
- `.ps1` 同样保持纯 ASCII；读 UTF-8 文件用 `Get-Content -Encoding UTF8`

## CSS 响应式坑
- `transition` 简写不写属性名等于 `transition-property: all`，会把断点上的尺寸变化也做成动画。凡是 `@media` 断点会改变同一属性值的规则，都必须显式列出属性名。当前全文件已无省略属性名的 `transition`；两个参照点：`.search input` 的过渡只列颜色属性（public/app.css:132），而 640px 断点恰好要改它的 `width`/`max-width`（public/app.css:730），这正是当初踩坑的组合；`.status-refresh` 同理（public/app.css:829，尺寸在 :901 被断点改写）。
- 后果的严重程度取决于窗口可见性：隐藏/后台窗口的动画时间轴不前进，元素会永久停在断点前的尺寸上。实测 `.search input` 卡在 250px，在 320px 视口下溢出 43px，且用行内样式也无法覆盖（行内样式被动画中的计算值挡住，只有 `!important` 能压过）。
- 判断手法：同一个节点在别处克隆并挂到同一父级下测量。克隆体走默认尺寸、原节点却停在旧尺寸，即可确认是动画而非级联或布局问题。
- 因此布局回归的窄屏断言不依赖 `setContentSize` 立即生效，改为轮询 `innerWidth` 达标（scripts/layout-regression.cjs:41）。

## 网关诊断坑
- 验证网关的 CORS 支持必须带 `Origin` 请求头。实测 `api.b.ai` 只在请求带 `Origin` 时回 `Access-Control-Allow-Origin`，不带就完全没有该头；预检 `OPTIONS` 则返回 204 加 `ACAO: *`。用 curl 不带 Origin 去测会得出「网关没有 CORS、必然回退内置转发」的反向结论，而这个判断直接决定面板走直连还是转发（public/app.js:1310、1342）。
- 内置转发是 Node 进程，不使用系统代理；`settings.proxy` 非空时还会直接禁用转发（public/app.js:1310）。所以「系统代理开着」不等于「转发兜底可用」：本机实测 `api.b.ai` 直连在 TCP 层就不通（25s 无握手，且 DNS 结果在 Facebook 网段与 74.86.12.172 之间跳），经 `127.0.0.1:7890` 正常。这类域名一旦走到转发，会一直等到 `AI_HUB_PROXY_TIMEOUT_MS`（默认 120000，server.mjs:21）才回 504；面板侧 15s 的 AbortController 先断开，用户看到的是「请求超时」。
- `settings.proxy`（public/app.js:771 的 `buildUrl`）是 URL 前缀型转发（`?u=` 或 `{url}` 占位符），不是标准 HTTP 代理，不能把 `127.0.0.1:7890` 当系统代理填进去。
- 只放行推理路径的网关（报错形如 `HTTP node only allows access to inference API paths`）会让余额查询的 5 个默认候选全部失败（public/app.js:88-92），其中 `/api/usage/token` 还会先返回 301。这类站点的余额在面板里取不到，属网关侧限制，调 `balancePath` 也无解。

## 关键依赖
- 网页版无第三方依赖，Node 18+
- 桌面版：electron 44.1.1、electron-builder 26.16.0（devDependency 固定）
- Electron 自带 Chromium 和 Node，用户无需 Node/WebView2

## 环境变量
- `AI_HUB_PORT` 监听端口（默认 4179）
- `AI_HUB_HOST` 监听地址（默认 127.0.0.1）
- `AI_HUB_ALLOWED_ORIGIN` 非回环监听时必须设置
- `AI_HUB_PROXY_TIMEOUT_MS` 转发超时（默认 120000）
- `AI_HUB_SHARED_STATE=1` 开启 NAS 共享状态；未开启时继续使用原有浏览器本地存储
- `AI_HUB_DATA_DIR` 共享状态目录（Docker 默认 `/data`）
- `AI_HUB_ADMIN_PASSWORD` 共享模式登录密码
- `AI_HUB_SESSION_SECRET` 共享模式会话密钥，至少 16 个字符
- `AI_HUB_COOKIE_SECURE` HTTPS 访问时设为 `1`，直接 HTTP 内网访问时设为 `0`
- `AI_HUB_TRUSTED_PROXY` 设为 `1` 时登录限流按 `X-Forwarded-For` 最左项分桶（限长 64 + 格式校验，非法回退 socket 地址）；仅在确认前面有自己的反代时开启，直连保持 `0` 防头字段伪造
- `AIHUB_BOOT_TRACE` 启动耗时诊断日志文件路径（设了就开探针）
- `PORTABLE_EXECUTABLE_DIR` / `PORTABLE_EXECUTABLE_FILE` 由便携启动器提供，用来确定用户实际 exe 的同级配置目录

## 飞牛 NAS / Docker
- 部署名统一 `gateway-aihubpanel`（compose 服务/镜像/容器名，2026-10-01 起）；compose 结构可用仓库内 js-yaml 做解析器级断言（node -e 脚本，2026-10-01 曾验证 12 项）
- Docker 运行时只复制 `server.mjs`、`server/` 和 `public/`，不复制 Electron、`node_modules`、桌面配置、`data/` 或文档；容器使用 Node 非 root 用户、只读根文件系统、临时 `/tmp`、丢弃 Linux capabilities 和 `no-new-privileges`
- 健康检查用 busybox `wget -qO /dev/null`（alpine 自带）：曾用 `node -e fetch` 方案，每 30s 拉起一个约 40MB 的 Node 进程；改 wget 后该开销归零。首次 NAS 部署时需实际确认 wget 探测正常（healthy 状态）
- 内存配置维持：V8 堆上限 256MB（NODE_OPTIONS）+ 容器 mem_limit 512m。上限不是预留，实际空载几十 MB；不要再往下调 256MB——20MiB 状态的 JSON 克隆瞬时堆就可能触顶 OOM
- `compose.yaml` 默认把 NAS 的 4179 端口绑定到所有网卡，适合三台主机通过固定 NAS 地址访问；只走飞牛 HTTPS 反向代理时把 `AI_HUB_BIND` 改为 `127.0.0.1`
- `AI_HUB_ALLOWED_ORIGIN` 必须填写三台主机共同使用的完整来源，不能把 NAS IP、域名和端口混着用；HTTPS 反向代理下同时把 `AI_HUB_COOKIE_SECURE=1`
- 共享数据只在 `/data/state.json` 和 `/data/state.json.bak`，写入经过临时文件、`sync`、备份轮换和串行队列；三台主机同时保存时按 revision 返回 409，不静默覆盖
- 会话契约（2026-09-30 起）：`/api/auth/session` 永远回 200——共享模式带 `{shared:true,authenticated,...}`，未开启时回 `{shared:false,authenticated:false}`；前端以 `shared===false` 判定本地模式。纯静态部署（无 /api 路由）仍靠 404 分支回退，两分支都要保留
- 更多菜单的「退出登录」仅共享模式显示（startApp 里按 remoteMode 切 hidden），点击后调 `/api/auth/logout` 并整页重载回登录门
- Dockerfile 设置 `NODE_OPTIONS=--max-old-space-size=256` 作为内存上限；这限制 V8 堆，不等于容器完整 RSS 上限
- `compose.yaml` 另设 `mem_limit: 512m` 容器级护栏：V8 之外的 RSS 增长由 cgroup 拦截；写盘走临时文件+rename，OOM 强杀不会损坏 `state.json`，`restart: unless-stopped` 自动拉起
- 2026-09-29 审计后刻意不改三项：不加 gzip（LAN 下 app.js 261KB 传输收益太小，不值复杂度）；不加 SIGTERM 处理（compose `init: true` 负责信号转发与收尸；直连 `docker run` 无 init 时 `docker stop` 最多等 10s 后 SIGKILL，原子写下安全）；不固定 `node:24-alpine` digest（家用 NAS 浮动 major tag 可接受）
- 主状态文件读取时，语法错误、JSON 结构错误或字段超限都会尝试从 `.bak` 恢复；主文件不存在仍按首次启动返回空状态。该边界由 `scripts/shared-state-regression.mjs` 覆盖
- 本机 2026-09-19 已完成源码、Node 回归和浏览器双页面审计；静态 Docker 检查通过，但没有 Docker CLI，飞牛 NAS 上仍需实测镜像构建、宿主机 `data/` 写权限、健康检查、重启恢复和 HTTPS 反向代理

## 关键外部路径（不在仓库内）
- 本地测试桩：`E:\goodwork\ZCodeData\aihub-probe\mock-upstream.mjs`
- 桌面版验收工具：`E:\goodwork\ZCodeData\aihub-probe\inproc-server-check.mjs`、`cdp-*.mjs`、`m3-*.mjs`
- 启动耗时脚本：`E:\goodwork\ZCodeData\aihub-perf\measure-boot.ps1`

## 代码结构
- `server.mjs` — 静态托管 + /api/proxy 同源转发，SSRF 防护
- `scripts/clean-release.mjs` — 打包前清理旧产物、打包后只保留当前版本 portable exe
- `scripts/regression.mjs` — Node 级回归：语法、diff 空白、默认配置约束、静态服务和同源转发基础接口
- `scripts/layout-regression.cjs` — Electron 隐藏窗口布局回归：长标题、长余额、长备注和 320px 小屏溢出
- `scripts/perf-regression.cjs` — Electron 离屏性能 / 内存回归：60 个站点、2190 个模型、长日志、长文本、视图切换、搜索和专注详情
- `scripts/storage-regression.cjs` — Electron 配置桥回归：批量写入、外部修改检测和大配置落盘
- `scripts/startup-regression.cjs` — Electron 启动回归：合成配置、阶段耗时和打包产物启动
- `public/index.html` — 页面骨架
- `public/app.js` — 前端全部逻辑（4715 行原生 JS，无框架无构建）
- `public/app.css` — 样式
- `start-aihubpanel.bat` — Windows 手动启动（网页版，默认不自动打开浏览器）
- `electron/main.js` — 桌面版主进程
- `electron/preload.js` — 存储桥，contextBridge 暴露 window.aihubStore
- `electron/icon.png/.ico` — 应用图标
- `package.json` / `.npmrc` — 桌面版依赖与打包配置

## 决策记录
历史决策见 `decisions.md`（已合并到此处的关键决策）：
- 桌面壳选 Electron（推翻 Go+WebView2，2026-09-02）
- 2026-09-30 方向收口：主力部署形态确认为飞牛 NAS Docker（共享模式），桌面 exe 产品线（1.0→1.2.0 已交付）**冻结保留**——用户明确选择维持现状，不删代码、不删产物、不跟进新特性；新功能只针对浏览器/Docker 路径，涉及桌面版的改动仍须保持其行为不变（共享模式在桌面版关闭属预期）
- 普通配置用 exe 同目录的 config.json，API Key 单独用 apikey.json（替代浏览器版 localStorage）
- SSE 流式只能走「本地 HTTP 服务 + 浏览器加载 URL」路线
- server.mjs 在主进程内 import，不另起子进程
- 排序五档稳定增量：键不变不移动，键变了单独插
- 默认发布为单文件 portable exe；启动时会有自解压开销，配置文件仍位于用户实际 exe 同级目录

## 关键内部约束（来自历史审计）
- 服务端 `BASE_HEADERS` 带严格 CSP（script-src/style-src 'self'、connect-src 'self' http: https:）：给页面加内联脚本、内联 style 属性、eval 或新外部源都会被浏览器拦截；`app.js` 模板里的 `style="..."` 一律走 CSS 类（先例：空态 height:100% 移入 `.empty`，2026-10-01）
- 共享模式前端对 `/api/auth|/api/state` 的请求必须走 `fetchSameOrigin`（网络层失败统一译成中文，HTTP 状态语义不变）；源码门禁禁止 `await fetch(REMOTE_*` 绕过。写新的远端调用时沿用
- `modelDisplayTier`（public/app.js:2788）是判断口径的单一来源，「复制可用模型」和排序都靠它
- 测试中卡片保留上次快照排序键，插入比较必须用同一份 `keys`（public/app.js:2823），不能用实时 latency
- `modelListEmpty` 仅在 HTTP 200 + 空数组时为真，任何错误/非空都清
- Electron 错误路径用 `dialog.showErrorBox` + `app.exit(1)`，用户行为不变
- API 请求链固定发起时的 `stationRevision`；自动客户端修复不得在站点编辑/删除后写回旧配置，过期响应体要取消以释放连接。
- 删除或编辑保存失败回滚时要恢复站点、模型勾选、Key 显示和排序快照；站点请求已失效时保留新 revision，避免模型卡永久停在“测试中”。
- 共享模式下结构性站点修改必须等待 `persistStationsNow()` 完成；设置里的代理变化会重置连通状态并提交站点状态，拖拽排序也必须等待 NAS 写入后才提示成功。失败或 revision 冲突要恢复内存快照。
- API Key 掩码的首尾保留量固定（列表 8+6，详情 6+4）。长度不足 15 位时两段会重叠、把整个 Key 拼回来（11-14 位即全部字符可见），这种长度必须退回短掩码（public/app.js:516）。掩码长度不随 Key 真实长度伸缩，否则等于把「Key 有多长」也一并泄露。
- 数值归一化统一走 `optionalNumber`（public/app.js:166）：`Number(null)` 和 `Number("")` 都是 0，会把「没测到」写成「首字 0ms」「HTTP 0」。
- 脱敏必须先替换再截断（public/app.js:1141）。反过来会把跨越截断边界的完整 Key 切成两段，替换匹配不到，明文片段就留在日志和错误提示里。
- 回滚时若整体重建 stations，一律走 `restoreStationsFromSnapshot`（public/app.js:1033）：请求版本绑在站点对象标识上，重建后旧对象上的版本判断全部失效，不清算会让模型卡和连通状态永久停在「测试中/检测中」。
- 自定义请求头在写入前按编码后 3000 字节设限（public/app.js:1496），给 server.mjs 的 `x-aihub-extra-headers` 控制头上限（4096 字符）留 base64 的 4/3 膨胀余量，避免收下一份每个请求都必然被转发层拒绝的配置。
- 内置转发的公网校验在 `isPublicIPv4`（server.mjs:153）分段列出保留网段，本轮补上 240.0.0.0/4（server.mjs:161）。判断 SSRF 覆盖是否完整时逐个核对这些网段，不要凭函数名判断。
- 同源校验只在没有 `AI_HUB_ALLOWED_ORIGIN` 时才枚举回环主机，两侧都要按 URL 规范化后再比（server.mjs:117）。手工拼 `:${port}` 在默认端口上永远比不上：`http://127.0.0.1:80` 的 origin 会被序列化成 `http://127.0.0.1`，`AI_HUB_PORT=80` 时整站转发会被自己的校验拒掉。
- 存储桥的读取路径只做类型校验，不做长度和控制字符过滤（electron/preload.js）。前端 `normalizeApiKey`（public/app.js:153）已在写入前应用同一条规则，读取时再筛一次等于把「暂时不合法」的 Key 直接从磁盘上抹掉；判断该不该在读取侧拦脏数据，以写入侧是否已收敛为准。
- 迁移 Key 时站点没有可用的字符串 id 就不能把 Key 摘下来（electron/preload.js）。摘下来的 Key 既进不了 `keys` 表也没有站点可挂，等于静默销毁；这类站点保持原样，等前端补齐 id 后再迁。
- `config.json` 被写坏（断电、被外部编辑器截断）时从 `config.json.bak` 恢复并重新落盘（electron/preload.js）；主文件不存在时不看备份——删掉 `config.json` 是明确的「重置」，不该被备份复活。
- 走「改名失败退回原地覆写」之前先留一份 `.bak`（electron/preload.js）。覆写是原地截断，写到一半失败就没有第二份数据，而这个 `.bak` 正是上面那条恢复逻辑的唯一来源。
- 主进程只允许主框架导航到「origin 完全等于本地面板」的地址（electron/main.js）。不能用前缀匹配：`http://127.0.0.1:1234@evil.com` 的 origin 是 evil.com，前缀却对得上，而 preload 存储桥跟着主框架文档走，放行导航等于把配置读写暴露给外部页面。
- 设置面板的数字输入留空时按默认值处理，不按 0 处理（public/app.js:158 的 `clampInt`）。清空输入框得到空串，`Number("")` 是 0，会被夹到最小值：并发数静默变 1、超时静默变 3 秒，用户以为留空就是「用默认值」。
- `configureRuntimePaths()`（electron/main.js:70，调用点在 :210）返回 `null` 表示目录创建失败。此处刻意不降级也不弹窗：同一个原因会让随后每个 `app.setPath` 一起失败，而 TEMP/TMP 赋值只影响应用自身子进程，不该因此打断启动。

## 回归门禁约定
- 跑任何 Electron 套件前先杀掉残留进程（`taskkill //F //IM electron.exe`）：旧实例占着单实例锁会拖慢启动，多个套件并发会让耗时门禁出现假失败。
- 布局回归：重载前必须先注册 `did-finish-load` 并带超时（scripts/layout-regression.cjs:22），否则监听器注册在 `reload()` 之后且无超时会永久挂住；窗口尺寸用 `resizeTo` 轮询 `innerWidth` 达标（:41）；整轮有 `WATCHDOG_MS` 兜底（:37）。
- 布局回归的余额断言比的是「四格指标区的格子是否都在容器内」（scripts/layout-regression.cjs:223，断言在 :298 和 :304），不是「值盒子是否越过格子边界」。后者永远为假：`.m-val` 是 `display:block` + `overflow:hidden`，宽度恒等于父级内容盒（public/app.css:821），这种断言抓不到任何回归，写门禁时要先确认断言真的可能失败。
- 性能回归：耗时达标之外还要断言结果内容（scripts/perf-regression.cjs:397 的 `assertTimings`），只看耗时会把「渲染很快但结果错了」放行——「快了」完全可能是少渲染了内容；内存测不到时直接判失败而不是跳过（:423）。`repeat-view-cycles` 预算 2026-10-01 起为 5200ms（:27），实测长期在 3.0–4.5s 区间，预算已对齐量级；该门禁仍对机器负载敏感，结论以独占运行为准。
- 性能回归的内存单位只能按 KB→MiB 固定换算（scripts/perf-regression.cjs:326 的 `asMiB`）。曾在读数大于 1 MiB 时改按字节理解、除以 `1024*1024`，结果把一个 1.2GiB 的渲染进程读成 1.2MiB，120MiB 的泄漏门禁变成永不可能失败。
- 视图切换类断言必须同时断「数量」（scripts/perf-regression.cjs:411-414）。只断「上一屏的 DOM 没了」的话，整屏都没渲染也照样满足那一条，而那一刻当然是最快的。
- 三个 Electron 套件都能用环境变量兜底超时，别把机器负载当成功能失败：性能 `AIHUB_PERF_WATCHDOG_MS`（scripts/perf-regression.cjs:33，默认 180000）、存储 `AIHUB_STORAGE_WATCHDOG_MS`（scripts/storage-regression.cjs:9，默认 120000）、基础回归 `AIHUB_RUN_TIMEOUT_MS`（scripts/regression.mjs:22，默认 120000）。
- 启动回归：除耗时外还断言启动阶段顺序无异常（scripts/startup-regression.cjs:258），阶段次序变了即便耗时达标也不该放过。
- 诊断用的临时脚本用完即删，不要留在 `scripts/` 下（会混进 diff 和 `npm test` 的目录约定）；也别写进 `/tmp`（Git Bash 的 `/tmp` 就是 C 盘用户临时目录），放 `E:\goodwork\ZCodeData\zcode-probe\`。

## 性能 / 内存审计记录
- **2026-10-01 交付收口**：HEAD d046c98 六套回归 5/6 绿；性能套件两次失败（repeat 5274.8ms 超 5200、search-clear 1129.3ms 超 700），同时 desktopScenario 2361ms（基线约 1105ms）——全套系统性变慢且 CPU 负载 61%（java/豆包等用户应用），b8867c7 后零生产代码变更、同日早些同代码实测 3176/3627ms 全绿，判定为负载窗口非退化；独占复跑留待机器空闲，勿据这两次读数调预算。
- **2026-09-30**：P1/P2 修复后在最终代码上串行重跑六套全绿：seeded load 245.6ms、搜索 79.1ms、420 模型详情 171.4ms、网格切换 113.4ms、8 轮重复视图 4488.6ms（预算 4500ms，余量仅 11ms，属机器负载敏感项，独占运行才作准）、renderer 增量 5.6MiB、DOM 7118；启动中位数 1153ms（同日此前一次为 401ms，波动来自机器负载）。
- **2026-09-29**：共享状态改造入库前全量复测（串行，先清 electron 残留）：seeded load 377.4ms、搜索 117.8ms、420 模型详情 181.8ms、网格切换 111.5ms、8 轮重复视图 4025.1ms、renderer 工作集增量 −9.6MiB、DOM 7113；启动回归源码态中位数 855ms（pageToReady 639ms）；基础、共享状态、布局、存储、启动五套退出码均为 0。
- **2026-09-19**：修复共享状态备份恢复边界后串行执行 `npm test` 全部通过；性能 seeded load 220.3ms、搜索 75.0ms、420 模型详情 130.2ms、网格切换 99.9ms、8 轮重复视图操作 3038.8ms、renderer 工作集增量 −3.3MiB、DOM 7113。此前一次独占回归受 Windows/Electron 调度影响，`search-clear` 短暂达到 835.4ms，紧接着单独重跑为 190.2ms；性能门禁仍保持原阈值，执行时必须清理残留 Electron 并串行运行
- **2026-09-13**：死代码清理后复测（清理只删样式与常量，不动逻辑）：布局、基础、打包态启动、性能、存储五套退出码均为 0；性能回归 renderer 工作集增量为 −3MiB，即清理后比清理前更省；打包态启动中位数 5551ms（明细见上节）。
- **2026-09-13**：审计后全套复测（串行执行，跑前清掉残留 electron）：seeded load 464.7ms、搜索过滤 78.1ms、420 模型详情 159ms、网格切换 122.5ms、8 轮重复视图操作 4293.6ms、DOM 7095、renderer 工作集增量 0.3MiB；启动回归源码态中位数 685ms（browserWindowCreate 39ms、serverStartup 41ms、pageToReady 439ms、domToReady 26ms）。同一轮布局、存储、启动套件退出码均为 0。
- **2026-09-13**：并发跑多个 Electron 套件时 `repeat-view-cycles` 曾实测 4595.5ms 超出 4500ms 预算，改为串行后回到 4293.6ms。该门禁对机器负载敏感，结论要以独占运行为准。
- **2026-09-11**：合成负载为 60 个站点、2190 个模型、每站 16 条日志，存储数据约 1.6 MB；420 个模型的详情页作为最重单站场景。
- **2026-09-11**：最后一次完整回归实测 seeded load 约 392ms、搜索过滤约 79ms、420 模型详情约 152ms、网格切换约 113ms；重复 8 轮列表/网格/搜索/详情操作约 3.24s。
- **2026-09-11**：重复操作前后 renderer 工作集约 170.4MiB→160.8MiB，JS heap 约 5.1MiB→5.3MiB；当前基准阈值为单次交互 0.7–1.6s、DOM 不超过 18000、重复操作 renderer 工作集增长不超过 120MiB，均已通过。
- `public/app.js` 的搜索输入使用 `scheduleRender` 合并同一帧内的连续输入；列表、网格和专注视图只保留当前视图 DOM，切换时清理非当前视图；`invalidateStation` 会清理已失效的请求 Map 和批测锁。
- 基准数据全部为假数据，不读取桌面版 `config.json` 或 `apikey.json`，也不访问真实上游；结果用于防退化，不代表所有真实机器和网络环境的绝对耗时。
