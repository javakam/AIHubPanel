# AIHubPanel 当前状态

## 正在做什么
项目清理和性能排查都收尾了，等用户下一步指令。

## 最近完成（近三日）
- **2026-09-03**：性能排查。`AIHUB_BOOT_TRACE` 实测开发态启动：main-start→app-ready 95ms、window-created 4571ms（与 server-imported 并行重叠）、server-ready 7633ms、navigation-started 8078ms、window-shown 14670ms、page-loaded 14940ms。结论：render 已用 rAF 批量（`scheduleRender`），启动序列 load→applyTheme→bindGlobal→render→syncDetailOffset 全是同步轻量；模型卡用稳定增量排序，DOM 移动只发生在排序键变化的卡片，列表/网格不整列重排；详情重绘保留滚动+焦点锚点。无新的同步阻塞点，无需进一步改动。
- **2026-09-03**：模型排序五档稳定增量排序。测试结果落地时那张卡片单独滑动一次，不再整列重排，消除了「方块跳来跳去」的现象；同一张卡片的排序键不变就不移动，不会出现一张 400ms 卡片固化在 150ms 卡片前的问题。
- **2026-09-03**：空模型列表显示原因。`/v1/models` 返回 HTTP 200 + 空数组时说明「该 Key 所在的分组未绑定任何渠道」，不再只说「暂无模型」。
- **2026-09-03**：启动性能优化。窗口创建与服务启动并行，健康检查轮询 80ms→20ms，应用自身首帧 1186ms→约 440ms；打包新增 zip 目录版（双击到窗口 0.58 秒，绕过便携 exe 每次 6 秒 NSIS 自解压）。
- **2026-09-03**：全量审计修复了排序边界 bug：插入时比较必须用有效排序键，不能拿测试中卡片的实时状态（latency=null）去比较；已浏览器复验。
- **2026-09-03**：项目清理。删 `.playwright-cli/`、`.playwright-mcp/`、`design/`、`session-out.json`、electron/release/ 下的 0.1.0 旧产物和 builder-debug.yml；合并 docs/agent 四文件为 status.md + reference.md；AGENTS.md 和 README.md 同步指向新文件名。
- **2026-09-03**：桌面 exe 1.0.0 打包完成（v1.0.0 tag）。本轮所有改动已 commit 到 master。
- **2026-09-02**：桌面版里程碑 0-3 全部完成。Electron 壳复用 server.mjs，明文 config.json 存储，数据迁移走导出/导入。
- **2026-09-02**：UA 白名单自动治愈：网关按客户端指纹拦截时自动补 claude-cli UA 走本地转发，两侧行为一致。
- **2026-09-02**：修复 start-aihubpanel.bat：4398/4179 落在 Windows 保留端口段导致静默启动失败，改为启动前试绑 + 自动退备用端口。

## 待办（当前轮）
（无）

## 已知问题（长期）
- 便携 exe 每次启动 NSIS 自解压，实测 6 秒，要快用 zip 目录版（0.58 秒）
- 「小学生」站点模型列表为空是站点分组没绑渠道，非面板问题
- config.json 含 API Key，已 gitignore，绝不提交
- 桌面版和浏览器版数据互不同步，靠导出/导入迁移

## 关键路径（只读）
- 启动入口：electron/main.js → startServer() → import server.mjs
- 前端入口：public/app.js → IIFE 末尾 init
- 存储：桌面版 electron/preload.js → configDir()/config.json；浏览器版 localStorage
- 打包：npm run dist，产物在 electron/release/（gitignore）

## 备注
- 便携 exe 的 configDir() 取 PORTABLE_EXECUTABLE_DIR（用户双击的 exe 所在目录），不是临时解压目录
- 桌面版 User-Agent 含 aihubpanel-desktop/1.0.0；17 个 mock 模型分级零差异，UA 自动治愈两侧都成功
- 启动阶段诊断开关：环境变量 `AIHUB_BOOT_TRACE=<绝对文件路径>`，阶段日志追加写入，外部脚本读到 window-shown 即认为首帧完成

