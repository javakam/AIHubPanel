# AIHubPanel 当前状态

## 正在做什么
1.1.1 已发布：本轮审计修复与 `apikey.json` 拆分、Electron 运行目录搬移一并进包，便携 exe 打包完成并已用打包态启动回归验证（见 `v1.1.1` tag）。当前在做第三方站点 `api.b.ai` 的测试表现分析，代码未改动。

## 最近完成（近三日）
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
- [ ] 复核性能回归 `repeat-view-cycles` 的 4500ms 预算（scripts/perf-regression.cjs:27）。本轮实测 4293.6ms，余量不足 5%；并发跑其它 Electron 套件时曾出现 4595.5ms 的超限。要么把预算调到与实测量级相符，要么让该套件独占运行。

## 已知问题（长期）
- portable 单文件 exe 启动会包含自解压耗时；1.1.0 实测三轮总耗时约 6.6/8.0/8.2 秒，中位数约 8.0 秒，应用自身页面到首帧约 0.52 秒
- 某些站点模型列表为空是站点分组没绑渠道，非面板问题
- `config.json` 和 `apikey.json` 已 gitignore，前者不含 API Key，后者单独保存 API Key，两个文件都绝不提交
- 桌面版和浏览器版数据互不同步，靠导出/导入迁移
- `npm run test:perf` 使用合成数据和离屏 Electron 窗口，能发现前端渲染/内存退化，但不替代真实上游网络、长时间批量测试和不同机器的运行验证。

## 关键路径（只读）
- 启动入口：electron/main.js → startServer() → import server.mjs
- 前端入口：public/app.js → IIFE 末尾 init
- 存储：桌面版 electron/preload.js → configDir()/config.json + apikey.json；运行数据 → configDir()/.aihubpanel-data；浏览器版 localStorage
- 打包：npm run dist，产物在 electron/release/（gitignore）

## 备注
- portable exe 的 configDir() 取启动器提供的实际 exe 目录，不使用临时解压目录；首次运行不植入任何预置站点
- 17 个 mock 模型分级零差异，UA 自动治愈两侧都成功
- 启动阶段诊断开关：环境变量 `AIHUB_BOOT_TRACE=<绝对文件路径>`，阶段日志追加写入，外部脚本读到 window-shown 即认为首帧完成
