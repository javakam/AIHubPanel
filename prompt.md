# AIHubPanel 桌面版（Electron）开工说明

这份文件是给负责编码的人看的施工手册。开工前通读一遍，按里程碑顺序做，每完成一个里程碑停下来验收，验收过了再进下一个。

## 一、目标

把现在的网页版包成 Windows 桌面 exe，做到三件事：

1. 双击 exe 就打开面板，不用装 Node、不用开浏览器。
2. 数据从浏览器 localStorage 挪到 **exe 同目录的明文 config.json**，用户随时能打开看、手工改。
3. 前端界面和转发逻辑尽量不动，SSE 流式照常逐字返回。

## 二、为什么是 Electron（已定，别再纠结选型）

- 复用现有 server.mjs 和前端，改动最小，风险最低。
- SSE 流式天然正常：Electron 不拦在 HTTP 链路上，前端照常用 `fetch` + `response.body.getReader()`。
- Node 语料最丰富，AI 写起来最不容易翻车。
- 代价只有安装包体积约 100MB；运行时内存和 Tauri/Wails 差不多（大头都是 Chromium/WebView2 引擎）。

## 三、现有代码的关键事实（动手前必须知道）

### 前端存储（改动的唯一重点）

前端只用了 3 个 localStorage key，真正的读写只有 6 处，全部集中在 5 个函数里：

| 函数 | 位置 | 干什么 |
| --- | --- | --- |
| `load()` | app.js:270 | 启动读站点(272)、设置(287) |
| `save()` | app.js:414 | 写站点(415) |
| `saveSettings()` | app.js:418 | 写设置(419) |
| `loadUIState()` | app.js:424 | 读界面状态(427) |
| `saveUIState()` | app.js:441 | 写界面状态(449) |

3 个 key：`aihub.stations.v2`（站点数组，含 API Key）、`aihub.settings.v2`（设置）、`aihub.ui.v1`（非敏感界面状态）。

**重要**：调用这 5 个函数的地方有几十处，但改造时只改函数内部实现，调用点一个都不用动。

实际改法（里程碑 1 已落地）：新增 `storage()`（app.js:408）挑后端——有 `window.aihubStore` 就用它，否则用 localStorage；`readStored` / `writeStored` 是两个薄封装。5 个函数只是把 `localStorage.getItem/setItem` 换成这两个封装，逻辑一行没变。


### 网络层（一行不动）

`fetchWithTimeout`、`readSseStream`（app.js:1313）、`checkLocalProxy`（app.js:1170）全部走 server.mjs 的相对路径 `/api/proxy`、`/api/proxy/health`。Electron 的渲染进程里这些照常工作，SSE 逐块读取 `response.body.getReader()`（app.js:1316）天然正常。

### server.mjs（一行不动）

它只干两件事：静态托管 public/、受限同源转发（含整套 SSRF 防护）。它在模块顶层就读 `AI_HUB_PORT` / `AI_HUB_HOST` 并 `listen`，所以桌面版只要先把端口写进 `process.env`、再 `import()` 它，服务就在主进程里跑起来了，代码零改动。

## 四、最终架构

```
Electron 主进程（main.js）
 ├─ 单实例锁：防止开两个实例抢 config.json
 ├─ 选一个空闲端口（避免和正在跑的网页版冲突）
 ├─ 把端口写进 process.env，再 import server.mjs（主进程本身就是 Node，不必另起子进程）
 ├─ 轮询 /api/proxy/health 确认就绪 → 创建 BrowserWindow 加载 http://127.0.0.1:<端口>
 └─ preload.js 通过 contextBridge 暴露一个同步存储桥 window.aihubStore
        └─ 内部用 Node 的 fs 同步读写 exe 同目录的 config.json
```

前端 app.js 的 5 个存储函数改成：检测到 `window.aihubStore` 就用它（桌面版），否则继续用 localStorage（网页版不回归）。

config.json 结构（明文，对应 3 个 key）：

```json
{
  "stations": [...],
  "settings": {...},
  "uiState": {...}
}
```

## 五、里程碑（按顺序，逐段验收）

### 里程碑 0：Electron 最小可跑（路线验证）【已完成 2026-09-02】

只验证「这条路整体通不通」，不做存储改造。

- 建 `electron/` 目录，写 main.js + preload.js + package.json。
- main.js：单实例锁 → 选空闲端口 → 写 `process.env.AI_HUB_PORT` → `import` server.mjs → 轮询健康检查 → 窗口加载 127.0.0.1。
- 窗口安全配置：`contextIsolation: true`、`nodeIntegration: false`；里程碑 1 加 preload 时还要 `sandbox: false`（sandbox 关掉才能让 preload 用 fs）。

**验收**：`npm start` 能打开窗口，页面正常显示；点一次模型测试，SSE 流式能逐字出来，首字延迟正常。

实测结果：窗口 1386×864 正常渲染，服务在随机端口（如 8836）起来用了 19ms；mock 桩 `good-model` 单测通过，SSE 读到 11 个分块、每块间隔约 62ms（桩的发送节奏就是 60ms），首字 63ms；本地转发 + 自定义请求头合并对 api.github.com 返回 200。

### 里程碑 1：存储切换【已完成 2026-09-02】

- preload.js 里用 Node fs 同步读写 config.json，`contextBridge.exposeInMainWorld` 暴露 `getItem(key)` / `setItem(key, value)`。
- config.json 路径从主进程传进来（用 `webPreferences.additionalArguments` 传目录，preload 里从 `process.argv` 读）。
- 前端 5 个存储函数加环境判断：有 `window.aihubStore` 走文件，没有走 localStorage。

**验收**：桌面版添加一个站点，关闭重开数据还在；打开 exe 同目录的 config.json 能看到明文站点和设置；用浏览器打开同一份网页版，数据互不影响。

实测结果：桥挂上后 `window.aihubStore` 只有 getItem / setItem 两个方法。用界面表单加一个站，关掉重开，站名、密钥、分组、自定义请求头全在；config.json 明文可读，stations / settings / uiState 三个字段齐全。手工改文件里的备注、再让程序写一次设置，手工改动没被覆盖。浏览器打开 4398 的网页版仍走 localStorage，操作前后 config.json 的 sha256 一字未变。写入耗时：uiState 约 0.9ms，站点数据约 3.4ms；造 10 站 × 40 模型带完整报告和日志（约 504KB）后单次 save 约 18ms。把 config.json 设成只读再存，`save()` 返回 false 并弹红字提示，文件没被改坏，也没留下 .tmp 残渣。

三处比原计划多做的事，都是实测暴露出来的：写入用「临时文件 + 改名」，避免写一半断电留下半截 JSON（改名被占用时退回直接覆写）；每次读取先比 mtime 和大小，用户手工改过就重读，不拿旧缓存去覆盖；界面提示里的「浏览器存储」全改成「本地存储」，桌面版没有浏览器存储可言。

### 里程碑 2：打包【已完成 2026-09-02】

- 用 electron-builder 打成 Windows 便携 exe（portable）或安装包。
- `asarUnpack` 把 server.mjs 和 public/ 解出 asar：`import()` 一个 asar 里的 .mjs 会失败，静态文件也要真实存在。
- 图标、单实例锁、应用名。

**验收**：拿到一个独立 exe，拷到没装 Node 的机器（或换个目录）双击能开、能测、能存。

实测结果：`npm run dist` 产出单文件便携 exe 约 101MB（另有免解压直跑的 win-unpacked 目录约 321MB）。把这个 exe 单独拷进一个干净空目录运行：窗口正常打开（随机端口 7757），存储桥在位，用界面表单加了一个指向 mock 桩的站——明文密钥、自定义请求头、分组全部写进 config.json；连通性 11.7ms、拉到 18 个模型、`good-model` 单测判为可用且 SSE 指标齐全（首字 74.3ms、总耗时 698.8ms、14.31 tok/s）；`/api/proxy/health` 返回 200 带 `X-AIHub-Proxy: 1`，说明 server.mjs 从 asar.unpacked 里跑起来了。

配置落盘位置这次是量出来的，不再是推断：进程实际跑在 `%TEMP%\<随机名>\AIHubPanel.exe`（portable 包自解压的位置，退出即删），而 config.json 生成在用户双击的那个 exe 旁边。也就是 `app.getPath("exe")` 指向临时副本，只有 `PORTABLE_EXECUTABLE_DIR` 才是用户看得见的目录。

打包踩的两个坑：Windows 权限级别的键名是 `requestedExecutionLevel`（少个 ed 就报「configuration.win should be one of these: null」，完全看不出错在哪）；`electronDist` 指到 node_modules/electron/dist 才不会重新下那 150MB 的 electron。都记在 techContext.md。

### 里程碑 3：迁移与回归【已完成 2026-09-02】

- 数据迁移：复用现有「导出 / 导入」功能，浏览器版导出 JSON → 桌面版导入一次。
- 回归：用本地 mock 桩（8899，见 techContext.md）双跑对比，确认转发行为一致、SSE 一致、UA 白名单自动治愈仍生效。

**验收**：迁移后站点、设置、模型测试记录都在；mock 桩下网页版和桌面版行为一致。

迁移是走真实界面做的，两侧都没有绕过 UI：网页版（Chrome，临时实例 8123）用站点表单加了两个指向 mock 桩的站，跑完连通诊断和模型测试，然后点真实的导出按钮，拿到一份 9,935 字节的备份（format `aihubpanel.stations`、schemaVersion 1、version 3、18 个模型、7 项设置、密钥明文）。把这个文件原样喂给已打包桌面 exe 的真实导入入口，结果 3 个站全部还原，包括密钥、分组、备注、自定义头 `{"User-Agent":"claude-cli/2.0.0 (external, cli)"}`、18 个模型缓存，连之前测出的连通结果（在线、9.6ms）都在。exe 同目录的 config.json 从 948 字节长到 9,925 字节，三个顶层字段 stations / uiState / settings 齐全。

回归对比跑的是同一套 17 个 mock 模型（覆盖空回复、模型名不符、不支持流式、丢上下文、报错、UA 锁、只输出思考、o1 形状、不返 token、偶发失败、只吃 x-api-key、legacy 文本补全等形状），两侧各跑一遍完整 testModel，逐模型比对 ok / grade / depth / 四个探针状态 / 是否有指标：**17 个模型零差异**。分级结果：可用 11 个（good、notool、nojson、truncctx、reason-budget、reason-only、o1-shape、notoken、flaky、xkey，加 good 本身）、受限 4 个（swap 判身份不符、nostream 和 legacy-text 判流式失败、noctx 判上下文丢失）、不可用 3 个（empty、err、ua-lock）。桌面版这些结果也确认原样落进了 config.json，17 个模型的分级和运行时一致。

UA 白名单自动治愈单独验了一次，因为本地 mock 测不到它：mock 在回环地址上，而转发只放行公网目标，回环会被判 blocked_target，重试必然走不通。改用公网回显服务后两侧结果完全一致——入站那个 401「unauthorized client」是脚本合成的（真实网关无法复现），其余每一步都是真的：正则命中、代理健康检查通过、经本地转发补 UA 重试拿到 200、UA 固化进站点头、`transport` 记为 builtin、日志写下一条「自动修复」。上游回显确认收到的正是 `claude-cli/2.0.0 (external, cli)`，且控制头 `x-aihub-extra-headers` 没有泄漏给目标站点。

顺带修掉一个一直存在但没被发现的启动故障：start-aihubpanel.bat 硬编码的 4398 落在 Windows 的保留端口段里，bind 直接 EACCES，双击后窗口一闪就没。详情和 .bat 的两个编码坑记在 techContext.md。

## 六、必须避开的坑

1. **preload 用不了 fs 的根因是 sandbox**：Electron 20+ 默认 `sandbox: true`，preload 只能 require 少量模块。要 `sandbox: false` 才能在 preload 里 `require('fs')`。
2. **preload 拿不到 app 对象**：`app.getPath` 只在主进程可用。config.json 的目录要用 `additionalArguments` 从主进程传给 preload，别在 preload 里直接 require('electron').app。
3. **asar 里的 .mjs 和 public 目录**：`import()` 读不了 asar 里的 .mjs，server.mjs 又要按自身位置去找 public/。打包时用 `asarUnpack` 把这两样解出来，路径最稳。
4. **端口冲突**：用户可能同时开着网页版（bat 首选 4398）。桌面版自己选空闲端口，别写死。另外 Windows 会成片保留 TCP 端口，写死的端口可能根本绑不上（见 techContext.md 的「Windows 保留端口段」）。
5. **config.json 写不进去**：exe 若装在 Program Files 等只读目录，exe 同目录写文件会失败。写入失败要给出提示，别静默丢数据。
6. **同步写文件别卡界面**：`saveUIState()` 高频触发（选中、切视图都写），stations 可能含大量模型测试记录。同步 `writeFileSync` 写大 JSON 会卡几十毫秒，可接受但要留意，必要时对 saveUIState 做去抖。
7. **别继承外部的 AI_HUB_ALLOWED_ORIGIN**：用户环境里若设过它，server.mjs 的同源校验就只认那个 origin，窗口自己的请求会被一律拒掉。启动前删掉这个变量。
8. **Electron 二进制要单独下**：npm 包里只有壳，装完还要拉约 150MB 的 zip，默认源国内基本拉不动。仓库根的 `.npmrc` 已把镜像固定到 npmmirror。

## 七、红线（不要动的东西）

- server.mjs 的转发和 SSRF 防护逻辑：一行不改，它是全项目最不能出错的部分。
- 前端网络层、SSE 解析、探测逻辑：不改。
- 前端 5 个存储函数的**调用点**：不改，只改函数内部实现。
- 网页版（start-aihubpanel.bat + 浏览器）不能回归：存储改造必须保留 localStorage 兜底路径。
