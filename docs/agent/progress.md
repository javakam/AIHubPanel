# 进度记录

## 已完成
- 网页版面板：站点管理、连通性与延迟、余额、模型列表、单测/批量模型测试、JSON 备份导入导出、主题
- 本地转发：受限同源转发，SSRF 防护（说明见 README.md 安全设计一节）
- 网关 UA 白名单自动治愈：网关按客户端指纹拦截时自动补 UA 走本地转发（git 82e4ba7）
- 桌面 exe 化：选型定稿为 Electron（见 decisions.md）；此前 Go + WebView2 方案已否决
- 开工准备：prompt.md 施工手册已就绪，含架构、里程碑、坑与红线
- 协作工作流文件搭建（AGENTS.md 和 docs/agent/）
- 桌面 exe 化里程碑 0/1/2：Electron 最小可跑 → 明文 config.json 存储 → Windows 便携 exe（打包细节见 techContext.md）
- 桌面 exe 化里程碑 3：网页版导出 JSON 导入桌面版，站点/设置/模型记录全在；mock 桩下 17 个模型两侧分级完全一致；UA 白名单自动治愈两侧行为一致
- 修复 start-aihubpanel.bat：4398 落在 Windows 保留端口段导致启动静默失败，改为启动前试绑 + 自动退备用端口（细节见 techContext.md）
- 模型排序五档稳定增量排序：不可用不再压在可用之上，且一张卡片只在自己的判定或延迟变化时移动一次（git da7f959）
- 空模型列表说清原因：站点返回 HTTP 200 + 空数组时给出「分组后面没绑渠道」的判断和处理办法（git f0e34d5）
- 启动性能：窗口创建与服务启动并行 + 健康检查轮询 80ms→20ms，应用首帧 1186ms→约 440ms；打包新增 zip 目录版绕开便携 exe 每次 6 秒的自解压（git a340299，实测数据见 techContext.md）
- 全量审计（无上下文审查代理 + 人工核实）：排序/空列表/启动三处改动共核出 1 个真实 bug，即「测试中卡片停原位用旧键、插入比较用实时状态」口径不一致导致的固化错位，已修复并浏览器复验（git f6cae8b）；其余怀疑点（快照泄漏、modelListEmpty 状态机、main.js 错误路径、网页版回归）逐一核实无问题

## 待办
- [x] 确认 exe 化方案（2026-09-02 用户拍板 Electron）
- [x] 里程碑 0：Electron 最小可跑（主进程内 import server.mjs + 窗口加载，SSE 流式已验证）
- [x] 里程碑 1：preload 存储桥 + config.json 明文读写 + 前端存储切换
- [x] 里程碑 2：electron-builder 打包 exe（asarUnpack、图标、单实例锁）
- [x] 里程碑 3：数据迁移（浏览器导出→桌面导入）+ mock 桩双跑回归
- [ ] （可选后续）SmartScreen 签名、WebView2 缺失引导等打磨
- [x] 启动性能优化（窗口/服务并行 + zip 目录版）
- [x] 模型排序重做（五档 + 稳定增量）
- [x] 空模型列表原因说明

## 已知问题
- 便携单文件 exe 每次启动都要把约 100MB 自解压到 %TEMP%，实测双击到窗口 6.7-7.0 秒，其中 6 秒是自解压。这一段在 electron-builder 配置层调不动（依据见 techContext.md），要快就用 zip 解出来的目录版（0.58 秒）。
- 「小学生」测试站点（xxs.l.cd）的模型列表拿不到，不是面板的问题：这把 Key 所在的 Free-3 分组后面没有绑定任何渠道，`/v1/models` 返回空数组，直接发对话也一律 503 `No available channel`。面板现在会把这个判断和处理办法显示出来。
- Electron 安装包约 100MB 是既定代价；运行时内存与 Tauri/Wails 相当（大头都是 Chromium）。
- 打包后的 exe 首次运行会弹 SmartScreen「未知发布者」，自用点继续即可；要发给别人才需要买代码签名证书。
- config.json 含 API Key，必须 gitignore，绝不提交进仓库。
- Node 版保留作参照实现：桌面版复用它同一个 server.mjs，转发行为天然一致，但改动转发逻辑时仍需双跑对比。
- 装依赖时 electron 的二进制要另外拉约 150MB，默认源国内基本拉不动；镜像已固定在 .npmrc，换机器装不上先查这里。
- 桌面版的 User-Agent 里带 `aihubpanel-desktop/0.1.0` 和 `Electron/44.1.1`，和浏览器不同。里程碑 3 已双跑核对：17 个 mock 模型分级零差异，UA 自动治愈两侧都成功并写入同样的站点头，所以 UA 差异目前没有造成行为分叉；但改动转发或探测逻辑时仍要重跑这套对比
- 桌面版和网页版的数据是两份：桌面读写 config.json，浏览器读写 localStorage，同一台机器上互不同步。要搬数据只能走导出/导入（已在里程碑 3 实测走通）
- portable 包运行时会把自己解压到临时目录，所以配置目录取的是 `PORTABLE_EXECUTABLE_DIR`（electron/main.js:73）。已实测确认：进程跑在 `%TEMP%\<随机名>\AIHubPanel.exe`，而 config.json 落在用户双击的那个 exe 旁边。
- 网页版数据按「协议+地址+端口」隔离在浏览器 localStorage 里。start-aihubpanel.bat 退到备用端口时，面板会是空的——老数据没丢，只是在新地址看不到，要搬得走导出/导入。想固定住 4398 见 techContext.md 的 netsh 办法
