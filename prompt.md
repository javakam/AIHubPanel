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
| `load()` | app.js:269 | 启动读站点(271)、设置(286) |
| `save()` | app.js:405 | 写站点(406) |
| `saveSettings()` | app.js:409 | 写设置(410) |
| `loadUIState()` | app.js:415 | 读界面状态(418) |
| `saveUIState()` | app.js:432 | 写界面状态(440) |

3 个 key：`aihub.stations.v2`（站点数组，含 API Key）、`aihub.settings.v2`（设置）、`aihub.ui.v1`（非敏感界面状态）。

**重要**：调用这 5 个函数的地方有几十处，但改造时只改函数内部实现，调用点一个都不用动。

### 网络层（一行不动）

`fetchWithTimeout`、`readSseStream`（app.js:1304）、`checkLocalProxy`（app.js:1161）全部走 server.mjs 的相对路径 `/api/proxy`、`/api/proxy/health`。Electron 的渲染进程里这些照常工作，SSE 逐块读取 `response.body.getReader()`（app.js:1307）天然正常。

### server.mjs（一行不动）

它只干两件事：静态托管 public/、受限同源转发（含整套 SSRF 防护）。桌面版用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 的可执行文件以 Node 模式把它当子进程跑起来，代码零改动。

## 四、最终架构

```
Electron 主进程（main.js）
 ├─ 单实例锁：防止开两个实例抢 config.json
 ├─ 选一个空闲端口（避免和正在跑的网页版冲突）
 ├─ spawn server.mjs 子进程（ELECTRON_RUN_AS_NODE，AI_HUB_PORT=选好的端口）
 ├─ 等端口就绪 → 创建 BrowserWindow 加载 http://127.0.0.1:<端口>
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

### 里程碑 0：Electron 最小可跑（路线验证）

只验证「这条路整体通不通」，不做存储改造。

- 建 `electron/` 目录，写 main.js + preload.js + package.json。
- main.js：单实例锁 → 选空闲端口 → spawn server.mjs → 窗口加载 127.0.0.1。
- 窗口安全配置：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`（sandbox 关掉才能让 preload 用 fs）。
- 用 `ELECTRON_RUN_AS_NODE=1` 跑 server.mjs，`AI_HUB_PORT` 传选好的端口。

**验收**：`npm run start` 能打开窗口，页面正常显示；点一次模型测试，SSE 流式能逐字出来，首字延迟正常。

### 里程碑 1：存储切换

- preload.js 里用 Node fs 同步读写 config.json，`contextBridge.exposeInMainWorld` 暴露 `getItem(key)` / `setItem(key, value)`。
- config.json 路径从主进程传进来（用 `webPreferences.additionalArguments` 传目录，preload 里从 `process.argv` 读）。
- 前端 5 个存储函数加环境判断：有 `window.aihubStore` 走文件，没有走 localStorage。

**验收**：桌面版添加一个站点，关闭重开数据还在；打开 exe 同目录的 config.json 能看到明文站点和设置；用浏览器打开同一份网页版，数据互不影响。

### 里程碑 2：打包

- 用 electron-builder 打成 Windows 便携 exe（portable）或安装包。
- `asarUnpack` 把 server.mjs 和 public/ 解出 asar，确保子进程能读、能 spawn。
- 图标、单实例锁、应用名。

**验收**：拿到一个独立 exe，拷到没装 Node 的机器（或换个目录）双击能开、能测、能存。

### 里程碑 3：迁移与回归

- 数据迁移：复用现有「导出 / 导入」功能，浏览器版导出 JSON → 桌面版导入一次。
- 回归：用本地 mock 桩（8899，见 techContext.md）双跑对比，确认转发行为一致、SSE 一致、UA 白名单自动治愈仍生效。

**验收**：迁移后站点、设置、模型测试记录都在；mock 桩下网页版和桌面版行为一致。

## 六、必须避开的坑

1. **preload 用不了 fs 的根因是 sandbox**：Electron 20+ 默认 `sandbox: true`，preload 只能 require 少量模块。要 `sandbox: false` 才能在 preload 里 `require('fs')`。
2. **preload 拿不到 app 对象**：`app.getPath` 只在主进程可用。config.json 的目录要用 `additionalArguments` 从主进程传给 preload，别在 preload 里直接 require('electron').app。
3. **asar 里的 .mjs 和 public 目录**：子进程 spawn server.mjs、读 public 静态文件，都在 asar 里容易出路径问题。打包时用 `asarUnpack` 解出来，路径最稳。
4. **端口冲突**：用户可能同时开着网页版（bat 用 4398）。桌面版自己选空闲端口，别写死。
5. **config.json 写不进去**：exe 若装在 Program Files 等只读目录，exe 同目录写文件会失败。写入失败要给出提示，别静默丢数据。
6. **同步写文件别卡界面**：`saveUIState()` 高频触发（选中、切视图都写），stations 可能含大量模型测试记录。同步 `writeFileSync` 写大 JSON 会卡几十毫秒，可接受但要留意，必要时对 saveUIState 做去抖。

## 七、红线（不要动的东西）

- server.mjs 的转发和 SSRF 防护逻辑：一行不改，它是全项目最不能出错的部分。
- 前端网络层、SSE 解析、探测逻辑：不改。
- 前端 5 个存储函数的**调用点**：不改，只改函数内部实现。
- 网页版（start-aihubpanel.bat + 浏览器）不能回归：存储改造必须保留 localStorage 兜底路径。
