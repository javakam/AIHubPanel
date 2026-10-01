# AIHubPanel 当前状态

## 正在做什么
本轮完成上轮建议清单中的 4 项实用改进（b0df279、a8c4af8、d02e34e、8b01117）：repeat 门禁预算对齐实测量级、共享服务网络错误统一中文（fetchSameOrigin 收口 + 门禁）、登录限流支持可信反代按真实 IP 分桶（含反向验证过的双桶测试）、严格 CSP 安全头（唯一内联样式搬入 CSS）。六步审计方案全部执行：最终代码六套回归全绿、浏览器双模式零 CSP 违规、diff 自查与敏感扫描干净。桌面版维持冻结现状；P3×6 与 NAS 真机验收仍留待办。

## 最近完成（近三日）
- **2026-10-01**：4 项实用改进入库并审计。①`repeat-view-cycles` 预算 4500→5200ms（实测长期 3.0-4.5s，消除贴线假失败）；②新增 `fetchSameOrigin` 收口共享模式全部 fetch，网络错误统一中文（开发中门禁真实抓到 logoutRemote 漏网一处，已修）；③`AI_HUB_TRUSTED_PROXY=1` 时限流按 XFF 最左项分桶（限长+格式校验），compose 透传、README 说明、双桶隔离测试并反向验证；④严格 CSP 写入 BASE_HEADERS（script/style-src 'self'，connect-src 放行 http(s)，img data: 覆盖 favicon），空态内联样式搬入 `.empty` 类，烟测新增 headerIncludes 断言，浏览器双模式零违规。
- **2026-09-30**：修复审计 P1/P2 全部 6 项并复审入库。P1：登录门启动失败后提交即重试（`remoteStartPending` 守卫 + 中文提示 + 会话有效自动收门）；冲突弹窗 footer 允许换行，375px 实测三按钮不再溢出，且 Esc 不再关闭 `data-backdrop-close="false"` 的弹窗。P2：未开启共享模式时 `/api/auth/session` 返回 200 `{shared:false}`（本地模式控制台不再有 404）；更多菜单新增「退出登录」（仅共享模式显示，走 logout 后整页重载）；桌面版 startServer 清理共享模式继承环境变量。回归同步加固：本地会话契约烟测、`shared:true` 断言、4 条源码结构门禁。复审时浏览器抓到自查引入的 remoteMode 置位顺序 bug 并当场修复。清理：删除已完工的 prompt.md 施工手册（内容在 git 历史）。
- **2026-09-29**：共享状态改造入库（d617e23）。收尾审计 4 项：`public/app.css` 共享块缩进归位两空格；`.dockerignore` 补 `*.bat`；`compose.yaml` 加 `mem_limit: 512m`（`NODE_OPTIONS` 只限 V8 堆，容器级护栏防泄漏拖垮 NAS，原子写保证 OOM 不损坏 `state.json`）；删除 `docs/superpowers/` 施工手册（内容已全部落地）。刻意不改三项：不加 gzip（LAN 下 260KB 静态资源收益太小）、不加 SIGTERM 处理（compose 有 `init: true`，直连 docker run 超时后 SIGKILL 在原子写下安全）、不固定 node 镜像 digest。六套回归串行全绿：基础+共享、布局、性能（repeat 4025.1ms、renderer 增量 −9.6MiB、DOM 7113）、存储、启动（源码态中位数 855ms）。
- **2026-09-18**：完成飞牛 NAS Docker 共享状态改造。新增 `server/auth.mjs`、`server/state-store.mjs`、`scripts/shared-state-regression.mjs`、`Dockerfile`、`compose.yaml` 和 `.dockerignore`；服务端增加 HttpOnly 会话、CSRF、失败限流、原子状态写入、`.bak` 恢复和版本冲突；前端在共享模式下把站点、API Key、模型列表和测试结果放到 NAS，浏览器只保留界面状态。
- **2026-09-18**：修复共享状态收尾问题：首次本机配置迁移返回空站点、保存失败后待保存标记残留、会话过期保存不重试、冲突重新加载仍保留旧表单、强制覆盖丢失冲突前本机修改；同时补上共享模式错误配置快速失败、密码长度限制、Docker 默认 NAS 直连和 Node 堆上限。
- **2026-09-18**：本机验证 `npm test` 全部通过；共享模式浏览器实测登录、添加站点、服务重启恢复、双页面冲突、重新加载、强制覆盖和控制台错误检查通过。最终性能回归重复视图操作 3695.6ms，renderer 工作集增量 -2.5MiB，DOM 7113。
- **2026-09-19**：继续审计共享状态恢复链路，复现并修复 `state.json` 为合法 JSON 但结构损坏时不读取 `state.json.bak` 的问题；新增共享回归用例。修复后完整 `npm test` 通过：性能重复视图 3038.8ms、renderer 工作集增量 -3.3MiB、DOM 7113。静态 Docker 安全检查通过，但本机没有 Docker 工具，真实容器和 NAS 验收仍未完成。
- **2026-09-19**：继续审计共享模式保存链路，修复设置中的代理变化未把重置后的站点状态提交到 NAS、拖拽排序未等待远程保存的问题；新增基础回归断言。修复后完整 `npm test` 再次通过：性能重复视图 3855.5ms、renderer 工作集增量 -2.7MiB、DOM 7113。
- **2026-09-13**：体积审计与瘦身实测（本轮）。先拆体积：仓库 574MB = `node_modules` 463MB（devDependency，不随产物分发）+ `electron/release` 107MB（exe 101MB + 用户数据）+ 源码 352KB，确认「太大」只可能指前两项。两次受控构建验证 exe 能不能小：只加 `--config.compression=maximum` 产出 101224169 字节，与默认压缩的 101221724 字节无差别（包内主体已是压缩格式）；再加 afterPack 删 7 个 Electron 运行时文件（dxcompiler.dll 24.6MB、dxil.dll 1.4MB、vk_swiftshader.dll 5.3MB、vk_swiftshader_icd.json、vulkan-1.dll 0.9MB、LICENSES.chromium.html 19.5MB、ffmpeg.dll 3.0MB）产出 92051519 字节（−9%），打包态启动回归 EXIT=0 能到首帧，但代价是失去无 GPU 时的软件渲染回退和系统 ffmpeg，属未在真实机器验证的运行时改动，未采纳。结论与数据已写入 reference.md「体积构成与瘦身实测」。
- **2026-09-13**：死代码清理并重新打包。逐条自己 grep 复核后共 39 删 4 增：清掉详情页已废弃的整套 `overview-*` 样式及配套的 `.col-right`、`.kbd`、`overview-grid + .sec` 规则，清掉无引用的 `MODEL_STATES` 常量，清掉 `main#app` 和 `#formSave` 两个死 id。app.css 81163→77975 字节（980→946 行，括号 694/694 平衡），app.js 260694→260632 字节（4716→4715 行），index.html 15831→15808 字节。清理后布局回归与基础回归通过，并从清理后的源码重新打包：`electron/release/AIHubPanel-1.2.0.exe`（101224172 字节，sha256 `c649abaf…de1a`），打包态启动回归中位数 5551ms（browserWindowCreate 41ms、serverStartup 40ms、pageToReady 371ms、domToReady 22ms），性能回归 renderer 增量 −3MiB、存储回归均退出码 0。打包前备份、打包后逐字节还原了用户真实 `config.json`/`apikey.json`。
- **2026-09-13**：文档行号纠偏。一次清理让 `public/app.js` 行号整体前移，逐条核实后发现文档里一批 `文件:行号` 已指向错误内容（例如 `app.js:1308` 实际是 `try{`、`main.js:180` 实际是 `did-finish-load`），全部按真实符号定义重钉；同时修掉一处自查发现的重复条目。
- **2026-09-13**：全量审计并发布 1.2.0。逐条读源码核实三份审计报告后，用 8 个提交修掉全部已确认缺陷，其中 4 个会造成数据丢失或显示错乱：拖拽排序保存失败回滚时整体重建站点对象却没让在途请求失效（模型卡和连通状态会永久停在「测试中/检测中」）；设置面板清空数字输入框被 `clampInt` 夹成最小值（并发静默变 1、超时静默变 3 秒，用户以为留空就是用默认值）；存储桥读取时按长度和控制字符重筛 Key、且没有字符串 id 的站点在迁移时被摘掉 Key（等于静默删 Key）；`config.json` 被截断时界面按「零站点」显示，用户随手保存一次就把磁盘数据彻底覆盖。其余修复：原地覆写前先留 `.bak`、主进程补 `will-navigate`/`will-redirect` 同源拦截、转发同源校验改按 URL 规范化（`AI_HUB_PORT=80` 时整站转发会被自己的校验拒掉）、发布目录清理加真实路径校验并改为先验产物再删、回归门禁里 1 条永假的布局断言和 `asMiB` 的单位错误。
- **2026-09-13**：打包并验证 1.2.0 产物。`electron/release/AIHubPanel-1.2.0.exe`（101221724 字节，sha256 `8ce58e03…9348`），目录内只保留这一个文件。打包态启动回归以真实 exe 通过：中位数总耗时 5326ms（browserWindowCreate 37ms、serverStartup 37ms、pageToReady 326ms、domToReady 19ms），并校验 `config.json`/`apikey.json` 分文件与 `.aihubpanel-data` 都落在 exe 同级。打包前把用户真实 `config.json`/`apikey.json` 备份到 `E:\goodwork\ZCodeData\aihubpanel-release-data-backup\`，打包后还原并逐字节核对——`npm run dist` 会先清空 `electron/release/`，不备份就会连真实数据一起删掉。
- **2026-09-13**：本轮全套回归实测通过（基础检查、布局、性能、存储、启动退出码均为 0）。性能加载 375.3ms、搜索 73.5ms、420 模型详情 116.3ms、网格切换 94.1ms、8 轮重复视图切换 2964.6ms、DOM 7095、renderer 工作集增量 0.8MiB；存储回归 60 站 2190 模型、306808 字节配置。
- **2026-09-13**：实测第三方站点 `api.b.ai` 在面板里的测试表现（Key 有效）。连通性、模型列表、模型测试都能正常跑通；47 个模型里只有 `mimo-v2.5` 和 `qwen3.8-flash` 可用（深档 7 项探针全过），其余 30 个被 403「Deposit required to unlock premium models」拦下、12 个报 400「credit insufficient balance: balance=0」、1 个 429 限流，判定均不可用且原因会原样显示给用户。余额查询 5 个候选全部失败（网关只放行推理路径）。同时纠正了一个验证方法上的错误结论：该网关实际支持 CORS（带 `Origin` 才回 `ACAO`），已写入 reference.md 的「网关诊断坑」。
- **2026-09-13**：发布 1.1.1。核对发现 `v1.1.0` 的代码和 exe 都不含 `apikey.json` 拆分（tag 里的 preload.js 没有该文件），而文档已按拆分描述，所以本轮把拆分与 Electron 运行目录搬移一并进包；`package.json`、`package-lock.json` 两处版本与回归里钉死的版本断言同步升到 1.1.1。
- **2026-09-13**：打包并验证产物。`electron/release/AIHubPanel-1.1.1.exe`（101222711 字节，sha256 `28ddadd6…8cbc6`），目录内只保留这一个文件。用启动回归以打包态跑真实 exe 通过：中位数总耗时 5635ms（browserWindowCreate 42ms、serverStartup 41ms、pageToReady 360ms、domToReady 23ms），并校验 `config.json`、`apikey.json`、`.aihubpanel-data` 都落在用户实际双击的 exe 同级目录，配置与 Key 分文件、启动阶段顺序均无异常。发版前全套回归（基础/布局/性能/存储/启动）退出码均为 0。
- **2026-09-13**：全量审计并逐项修复，共 6 个提交。前端修掉 API Key 掩码首尾切片重叠（11-14 位会拼回完整原值）、载入/请求失效后残留的「检测中」连通状态、回滚整体换掉站点对象导致模型卡锁死、脱敏先截断后替换造成的明文漏网、内置转发错误码表缺项、自定义请求头超限、heal 分支的 401 响应未释放、窄屏隐藏详情容器残留过期内容；转发层补拦 240.0.0.0/4 保留网段；启动脚本异常退出时给出退出码和提示；回归门禁补上布局重载等待与超时、性能结果内容断言、启动阶段顺序断言，并让内存测不到时判失败。
- **2026-09-13**：本轮全套回归实测通过。基础检查、长文本布局、存储、启动均通过；性能回归加载 464.7ms、搜索 78.1ms、420 模型详情 159ms、8 轮视图重复切换 4293.6ms、DOM 7095、renderer 增量 0.3MiB；启动回归源码态中位数 685ms（其中页面到首帧 439ms）。
- **2026-09-13**：定位并修复窄屏横向溢出的真实原因。`.search input` 的 `transition` 简写不带属性名等于 `transition-property: all`，把 ≤640px 断点上的宽度变化也做成了动画；隐藏窗口的动画时间轴不前进，输入框永久停在 250px，在 320px 视口下溢出 43px。三处声明改为只列举颜色类属性后，布局回归既有的窄屏断言恢复通过。
- **2026-09-11**：移除生产代码中写死的默认站点和错误的版本标识；首次运行改为空站点状态，站点名称示例改为通用提示。
- **2026-09-11**：桌面数据拆分为同级 `config.json` 与 `apikey.json`；旧版把 API Key 写在 `config.json` 的数据会在首次读取时自动迁移，普通配置不再保存 API Key。
- **2026-09-11**：Electron 的用户数据、会话数据、缓存、日志和临时运行目录改到 exe 同级 `.aihubpanel-data`，减少 C 盘占用；portable 启动前的单文件自解压仍由启动器使用系统临时目录。
- **2026-09-11**：打包目标改为只保留 portable 单文件 exe，增加发布目录清理脚本，保证 `npm run dist` 完成后不残留安装版、zip 或旧版本文件。
- **2026-09-11**：启动回归增加实际数据目录校验，要求 portable 启动器最终使用用户实际 exe 同级的 `config.json`，源码和打包测试均避免读写项目根目录。
- **2026-09-11**：重新生成 `AIHubPanel-1.1.0.exe`，发布目录最终只保留这一个文件；portable 实际启动三轮耗时约 6.6/8.0/8.2 秒，中位数约 8.0 秒，应用自身页面到首帧约 0.52 秒，三轮配置目录都指向 exe 同级目录。
- **2026-09-11**：完成性能与内存审计。新增 `npm run test:perf`，用 Electron 离屏窗口和隔离假数据复验 60 个站点、2190 个模型、长文本和 8 轮视图切换；最后一次完整回归加载约 374ms，搜索约 74ms，420 模型详情约 118ms，重复切换后 renderer 工作集增加约 1.9MiB，未发现持续增长。
- **2026-09-11**：重新完成全量 `npm test`，基础检查、长文本布局、性能 / 内存、存储和启动回归全部通过；本轮性能加载约 353ms、搜索约 78ms、420 个模型详情约 126ms，重复视图操作约 3.44s，renderer 工作集增量约 14.4MiB。
- **2026-09-11**：启动回归脚本支持 `AIHUB_STARTUP_EXECUTABLE` 和 `AIHUB_STARTUP_MAX_TOTAL_MS`，可用同一套合成配置分别验证源码、安装版、目录版和便携版。
- **2026-09-11**：修复视图 DOM 常驻问题。切换列表、网格和专注详情时清理非当前视图的内容，避免隐藏的站点卡片和详情模型继续占用 DOM 与内存；站点配置失效时同步清理旧请求锁和批测锁。
- **2026-09-11**：完善回归工作流。新增 `npm run check` 和 `npm test`；基础回归覆盖 JS 语法、diff 空白和 `server.mjs` 本地接口烟测；布局回归用 Electron 隐藏窗口复验长标题、长余额、长备注和 320px 小屏横向溢出。
- **2026-09-11**：修复本轮审计发现的问题。详情标题状态徽标不再被长站点名挤成竖排；列表余额长文本会在自己的指标格内省略；详情备注改为最多 4 行展示并保留完整悬浮提示；请求快照会保留 `x-api-key` 认证模式，避免已识别站点重复走 Bearer。
- **2026-09-09**：修复请求竞态与失败回滚。自动 User-Agent 修复、余额/模型/模型探针请求均固定站点 revision，迟到响应不会写回旧配置；删除/编辑保存失败时恢复站点、模型勾选、Key 显示和排序锚点，删除弹窗可继续重试；过期响应体会主动取消，降低高频操作的内存与连接占用。
- **2026-09-03**：性能排查。`AIHUB_BOOT_TRACE` 实测开发态启动：main-start→app-ready 95ms、window-created 4571ms（与 server-imported 并行重叠）、server-ready 7633ms、navigation-started 8078ms、window-shown 14670ms、page-loaded 14940ms。结论：render 已用 rAF 批量（`scheduleRender`），启动序列 load→applyTheme→bindGlobal→render→syncDetailOffset 全是同步轻量；模型卡用稳定增量排序，DOM 移动只发生在排序键变化的卡片，列表/网格不整列重排；详情重绘保留滚动+焦点锚点。无新的同步阻塞点，无需进一步改动。
- **2026-09-03**：模型排序五档稳定增量排序。测试结果落地时那张卡片单独滑动一次，不再整列重排，消除了「方块跳来跳去」的现象；同一张卡片的排序键不变就不移动，不会出现一张 400ms 卡片固化在 150ms 卡片前的问题。
- **2026-09-03**：空模型列表显示原因。`/v1/models` 返回 HTTP 200 + 空数组时说明「该 Key 所在的分组未绑定任何渠道」，不再只说「暂无模型」。
- **2026-09-03**：启动性能优化（历史对比）。窗口创建与服务启动并行，健康检查轮询 80ms→20ms，应用自身首帧 1186ms→约 440ms；当时曾用 zip 目录版对比便携版自解压耗时，当前 1.1.0 发布只保留 portable 单文件。
- **2026-09-03**：全量审计修复了排序边界 bug：插入时比较必须用有效排序键，不能拿测试中卡片的实时状态（latency=null）去比较；已浏览器复验。
- **2026-09-03**：项目清理。删 `.playwright-cli/`、`.playwright-mcp/`、`design/`、`session-out.json`、electron/release/ 下的 0.1.0 旧产物和 builder-debug.yml；合并 docs/agent 四文件为 status.md + reference.md；AGENTS.md 和 README.md 同步指向新文件名。
- **2026-09-03**：桌面 exe 1.0.0 打包完成（v1.0.0 tag）。本轮所有改动已 commit 到 master。
- **2026-09-02**：桌面版里程碑 0-3 全部完成。Electron 壳复用 server.mjs，明文 config.json 存储，数据迁移走导出/导入。
- **2026-09-02**：UA 白名单自动治愈：网关按客户端指纹拦截时自动补 claude-cli UA 走本地转发，两侧行为一致。
- **2026-09-02**：修复 start-aihubpanel.bat：4398/4179 落在 Windows 保留端口段导致静默启动失败，改为启动前试绑 + 自动退备用端口。

## 待办（当前轮）
- [x] 修复审计 3 处问题：healClientBlockedStation 缺 revision 竞态守卫（app.js:1493）；doDelete 失败回滚丢选择集且 deletingId 置 null 造成弹窗按钮失灵（app.js:3975）；saveForm 失败回滚丢勾选状态（app.js:3900）
- [x] 修复本轮审计 4 处问题：详情状态徽标长文本挤压、列表余额长文本跨格、请求快照丢 `x-api-key`、详情备注长文本不可读。
- [x] 完善回归工作流：新增基础回归和 Electron 布局回归，统一由 `npm test` 串联执行。
- [x] 完成性能与内存审计：新增性能基准、清理非当前视图 DOM、合并搜索输入渲染、清理失效请求状态。
- [x] 按 1.1.0 重新发布：清理旧发布提交和 `v1.0.1` tag，生成单文件 portable exe，创建并推送 `v1.1.0` tag。
- [x] 复核并单独提交在途的 `apikey.json` 拆分改动（`electron/main.js`、`electron/preload.js`、`README.md`、`prompt.md`、`scripts/storage-regression.cjs`、`scripts/startup-regression.cjs` 的其余部分、`docs/agent/*`）。该改动当前通过全套回归，但不由本轮审计代为提交。→ 已复核并随 1.1.1 发布进包。
- [x] 复核性能回归 `repeat-view-cycles` 的 4500ms 预算（scripts/perf-regression.cjs:27）。本轮实测 4293.6ms，余量不足 5%；并发跑其它 Electron 套件时曾出现 4595.5ms 的超限。要么把预算调到与实测量级相符，要么让该套件独占运行。→ 2026-10-01 已调至 5200ms（b0df279），实测区间 3.0-4.5s，余量充足。
- [ ] 决定 1.2.0 是否发版：打 `v1.2.0` tag 并推远端。本次请求只要求打包，未打 tag、未推。
- [ ] 三条本轮刻意未改、留给用户拍板的项：`configureRuntimePaths()` 目录创建失败返回 `null` 时不降级也不弹窗（electron/main.js:70）；`TEMP`/`TMP`/`TMPDIR` 的赋值顺序；`buildUrl` 里用 `_` 前缀区分请求参数的约定。都已逐条核实，改动收益小于风险，故记录不改。
- [ ] 基础回归的语法检查只覆盖仓库内的 JS/MJS/CJS，不含 `public/index.html` 的内联部分；如需覆盖要另加 HTML 校验。
- [ ] 决定 exe 是否继续瘦身：删 7 个 Electron 运行时文件可省 9%（101221724→92051519 字节），代价是失去无 GPU 软件渲染回退与系统 ffmpeg。本轮实测能启动但未在真实机器验证，默认不采纳。
- [ ] 根目录 `config.json`（非打包态 `npm start` 写入，已 gitignore）里存有 2 个明文 `sk-` Key，本轮未改动；`apikey.json` 拆分只覆盖桌面版 exe 的存储路径，是否要把 `npm start` 也切到分离存储需用户决定。
- [x] 完成飞牛 NAS Docker 共享状态改造：单容器、无运行时 npm 依赖、`/data` 持久化、登录、CSRF、限流、原子写入、备份恢复和版本冲突。
- [x] 完成共享模式浏览器审计：登录、添加、重启恢复、双页面冲突、重新加载、强制覆盖和控制台错误。
- [ ] 在飞牛 NAS 或有 Docker Daemon 的主机上执行镜像构建、健康检查、`/data` 写权限、容器重启恢复和反向代理 HTTPS 验收。
- [x] 复核共享状态备份恢复边界：主文件语法损坏和结构损坏都覆盖回归，恢复失败时不返回敏感路径信息。
- [x] 复核共享模式结构性保存：设置代理变化和拖拽排序都会等待 NAS 写入，失败或冲突会回滚并提示。
- [x] 【2026-09-30 审计·待拍板】P1×2：①登录门启动失败死锁（startApp catch 后 remoteAuthSubmit 为 null，表单提交无响应，错误显示英文原文 "Failed to fetch"，仅能手动刷新，浏览器实测复现）→ 已修复（899a4b8），死门三阶段浏览器实测通过；②冲突弹窗窄屏溢出（.btn white-space:nowrap + .panel footer 无 flex-wrap，375px 实测「导出本机数据」按钮左溢屏幕外 61px）→ 已修复（899a4b8），375px 换行实测通过。
- [x] 【2026-09-30 审计·待拍板】P2×4：①共享模式无登出入口（REMOTE_LOGOUT_PATH 死常量，服务端 /api/auth/logout 已实现但前端无按钮）→ 已修复（899a4b8）；②本地模式每次加载控制台必现 GET /api/auth/session 404 → 已修复（899a4b8，会话契约改 200 {shared:false}）；③冲突弹窗 data-backdrop-close="false" 但 Esc 仍可关 → 已修复（899a4b8，Esc 统一按该属性判断）；④electron/main.js startServer 只清 AI_HUB_ALLOWED_ORIGIN → 已修复（1549e37，清五个共享变量）。
- [ ] 【2026-09-30 审计·待拍板】P3×6：①reloadRemoteConflict/overwriteRemoteConflict 直接重建 stations 未逐站 invalidateStation（在途结果静默丢弃、请求 Map 残留）；②refreshRemoteRevision 无 try/catch，NAS 不可达时每次切标签页产生 unhandled rejection；③首次迁移成功后不清 localStorage 旧站点，NAS 清空后会提示复活已删站点；④登录限流按 socket.remoteAddress，反代后所有用户共享 5 次/5 分钟一个桶；⑤容器重启会话丢失需重登录，README 未说明；⑥打包态 server/*.mjs 的 asarUnpack 链路未实测（模式与 public/** 一致，下次 npm run dist 时验证）。

## 已知问题（长期）
- portable 单文件 exe 启动会包含自解压耗时；1.2.0 打包态实测总耗时中位数 5326ms（清理后重新打包的同版本产物为 5551ms；同法 1.1.1 为 5635ms、1.1.0 约 8.0 秒，差异主要来自机器负载），应用自身页面到首帧约 0.33-0.37 秒
- 某些站点模型列表为空是站点分组没绑渠道，非面板问题
- `config.json` 和 `apikey.json` 已 gitignore，前者不含 API Key，后者单独保存 API Key，两个文件都绝不提交
- 桌面版和浏览器版数据互不同步，靠导出/导入迁移
- `npm run test:perf` 使用合成数据和离屏 Electron 窗口，能发现前端渲染/内存退化，但不替代真实上游网络、长时间批量测试和不同机器的运行验证。
- Docker 镜像本机未构建：当前环境没有 `docker` 命令；飞牛 NAS 上首次启动要重点确认宿主机 `data/` 目录允许容器内 `node` 用户写入。

## 关键路径（只读）
- 启动入口：electron/main.js → startServer() → import server.mjs
- 前端入口：public/app.js → IIFE 末尾 init
- 存储：桌面版 electron/preload.js → configDir()/config.json + apikey.json；运行数据 → configDir()/.aihubpanel-data；浏览器版 localStorage
- 打包：npm run dist，产物在 electron/release/（gitignore）
- NAS 部署：`compose.yaml` 构建 Node 运行时镜像；共享状态在 `/data/state.json`，备份在 `/data/state.json.bak`

## 备注
- portable exe 的 configDir() 取启动器提供的实际 exe 目录，不使用临时解压目录；首次运行不植入任何预置站点
- 17 个 mock 模型分级零差异，UA 自动治愈两侧都成功
- 启动阶段诊断开关：环境变量 `AIHUB_BOOT_TRACE=<绝对文件路径>`，阶段日志追加写入，外部脚本读到 window-shown 即认为首帧完成
