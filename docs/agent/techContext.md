# 技术说明

## 构建 / 运行命令
- 网页版运行：`node server.mjs`（默认端口 4179，注意这个默认值在本机不可用，见下面「Windows 保留端口段」）
- 网页版日常启动：双击 start-aihubpanel.bat（首选 4398，被占或被系统保留时自动退到 4700/5100/7788/9345/18080，就绪后自动开浏览器）
- 桌面版开发运行：`npm start`（等同 `electron .`，自己选空闲端口，不和网页版抢 4398）
- 桌面版首次装依赖：`npm install`。electron 的二进制不在 npm 包里，装完会另拉约 150MB 的 zip；镜像已固定在仓库根的 .npmrc（`electron_mirror=https://cdn.npmmirror.com/binaries/electron/`）
- 桌面版打包：`npm run dist`（等同 `electron-builder --win`），一次出两个产物：electron/release/AIHubPanel-0.1.0-portable.exe（单文件约 101MB，每次启动要自解压，慢约 6 秒）和 electron/release/AIHubPanel-0.1.0-win.zip（约 141MB，解开就是免解压直跑的目录版，启动约 0.6 秒）。win-unpacked/ 目录（约 321MB）也一并留在 release 下，本机自用可以直接跑它。整个 release 目录已 gitignore
- Git Bash 里 npm 不在 PATH，要写 `npm.cmd`

## 启动耗时（实测，不是估算）
- 量法：设环境变量 `AIHUB_BOOT_TRACE=<日志路径>` 再启动，主进程会逐段写「绝对时间戳 + 阶段名」（electron/main.js:22）。不设这个变量时探针第一行就返回，正常使用零开销。便携 exe 的自解压发生在进程存在之前，进程内的相对计时看不见它，所以外部脚本要记下双击的那一刻，用绝对时间相减
- 便携 exe：双击到窗口显示 6.7 / 7.0 秒，其中约 6.0 秒花在进程还没起来之前——即 NSIS 自解压。这一段调不动：portable.nsi 每次启动都 `RMDir /r $INSTDIR` 再重新解压（node_modules/app-builder-lib/templates/nsis/portable.nsi:38），`unpackDirName` 也救不了，因为目录先被删掉；NsisTarget.js 又写死了压缩器，且 portable 只读内置模板、不接受自定义 script
- 目录版 win-unpacked：双击到窗口显示 0.82 / 0.58 / 0.58 秒。想要快就用它或 zip 版，这是唯一能绕开自解压的办法
- 应用自身耗时（main.js 开始执行 → 窗口显示）：目录版 0.44-0.62 秒。原来是 1.19 秒，两处改动砍掉一半多：一是窗口创建不再等服务启动（原来 `createWindow(await startServer())` 白等端口探测和 server.mjs 加载，现在先建窗口、拿到端口再 loadURL，见 electron/main.js:164），二是健康检查轮询从 80ms 降到 20ms
- 前端不是瓶颈：网页版实测 responseEnd 23ms、DOMContentLoaded 87ms、首次内容绘制 76ms


## 打包配置要点（package.json 的 build 字段）
- `electronDist` 指向 node_modules/electron/dist：让 electron-builder 直接拷已下载好的 electron，不再重新拉那 150MB 的 zip。构建日志出现「using custom unpacked Electron distribution」才算生效
- `asarUnpack` 必须包含 server.mjs 和 public/**/*：`import()` 读不了 asar 里的 .mjs，且 server.mjs 用自身路径推算静态目录（server.mjs:12），文件必须真实存在于磁盘
- `electronLanguages` 只留 en-US 和 zh-CN，砍掉其余 locales/*.pak
- Windows 权限级别的键名是 `requestedExecutionLevel`（不是 requestExecutionLevel），写错会报「configuration.win should be one of these: null」这种看不出原因的错
- `win.target` 同时列 `zip` 和 `portable`。artifactName 要写在对应 target 的同名顶层字段里（`"portable": {...}`），凭空加一个根级 `"zip": {...}` 会被判「unknown property」
- package.json 缺 `author` 会有警告，顺手补上
- 图标 electron/icon.ico 由 electron/icon.png 生成，图形和页面 favicon（public/index.html:7 的内联 SVG）一致

## Windows 保留端口段（会让启动脚本静默失败）
- `netsh int ipv4 show excludedportrange protocol=tcp` 列出被系统预留的 TCP 段。Hyper-V / WSL / Docker 在开机时申请，段的位置每次重启都可能变
- 本机当前预留段包含 4311-4410 和 4103-4202，于是 **4398（bat 原本硬编码的端口）和 4179（server.mjs 的默认端口）都 bind 失败**，报 `listen EACCES: permission denied`
- 症状很误导人：双击 bat 后 node 报错、窗口一闪就没，看起来像「点了没反应」。用 `AI_HUB_PORT=4398 node server.mjs` 直接跑才能看到真正的错误
- 现在 bat 启动前会用 PowerShell 的 TcpListener 逐个试绑候选端口，选中第一个真能绑的；退到备用端口时会明确提示「浏览器数据按端口隔离，这个地址是空的，老数据没丢」
- 想长期保住 4398，管理员执行一次：`netsh int ipv4 add excludedportrange protocol=tcp startport=4398 numberofports=1 store=persistent`（自己先占住，Hyper-V 就抢不走）

## .bat 文件的两个编码坑
- **bat 正文必须纯 ASCII**。cmd.exe 按系统代码页（本机 GBK）读取 .bat，UTF-8 的中文注释会被拆成乱码并吃掉后续行——实测表现为 `'1' 不是内部或外部命令`、变量整段变空。中文说明写在本文件里，bat 里只留英文注释
- **换行必须 CRLF**。LF 结尾的 bat 在 `for /f ... do set` 这类复合语句上会解析错乱。仓库根的 .gitattributes 已用 `*.bat text eol=crlf` 固定住，不再依赖各人的 core.autocrlf
- server.mjs 的启动横幅是 UTF-8，所以 bat 开头 `chcp 65001` 把控制台切到 UTF-8，否则中文输出是乱码

## 关键依赖
- 网页版无第三方依赖：前端原生 JS，服务端只用 Node 内置模块，Node.js 18+
- 桌面版：electron 44.1.1、electron-builder 26.16.0（均为 devDependency，版本已固定）
- Electron 自带 Chromium 和 Node，用户不需要装 Node，也不需要系统 WebView2 Runtime

## 环境配置
- 环境变量含义见 README.md 运行一节：AI_HUB_PORT / AI_HUB_HOST / AI_HUB_ALLOWED_ORIGIN / AI_HUB_PROXY_TIMEOUT_MS
- 启动面板一律用 start-aihubpanel.bat（可见窗口、4398 端口），不后台起服务
- 桌面版数据文件：exe 同目录的 config.json，明文，结构是 stations / settings / uiState 三个字段。开发态（`npm start`）落在仓库根目录，已 gitignore。便携 exe 下这个「同目录」指用户双击 exe 所在的目录，不是运行时的临时解压目录
- 本地测试桩（不在仓库内）：E:\goodwork\ZCodeData\aihub-probe\mock-upstream.mjs，端口作为第一个参数传入（8899 已被别的程序占用时改用 8901），可模拟 UA 白名单锁等网关行为；同目录有 stations-backup.json 可恢复数据
- 本地 mock 测不了 UA 自动治愈：它是回环地址，而 server.mjs 的转发只放行公网目标，回环会被判 blocked_target。要验证 UA 真的写到了上游，得用公网回显服务（httpbin.org/headers、postman-echo.com/headers 会把收到的头回显；api.github.com/rate_limit 没有 UA 直接 403，补了就 200）
- 桌面版验收工具（同目录，不在仓库内）：inproc-server-check.mjs 验证主进程内起服务；cdp-eval.mjs / cdp-shot.mjs 通过 `--remote-debugging-port=9223` 在窗口里执行表达式和截图；cdp-download.mjs 触发下载并等落盘（`Browser.setDownloadBehavior` 的 allowAndName 会把文件存成 GUID 名）；cdp-setfile.mjs 给 `<input type=file>` 塞文件（`DOM.setFileInputFiles` 不会触发 change，要手工补派发一个冒泡的 change 事件）；m3-dual.mjs 对 17 个 mock 模型跑同一套 testModel 并输出分级；m3-heal.mjs 验证 UA 白名单自动治愈
- 启动耗时测量脚本（E:\goodwork\ZCodeData\aihub-perf\，不在仓库内）：measure-boot.ps1 先杀干净残留进程（单实例锁会让新实例直接 `app.quit()`，看着像崩了），记下启动时刻，等应用把 `window-shown` 写进 trace，再按阶段打印「距双击多少毫秒」。.ps1 和 .bat 一样有编码坑：PowerShell 5.1 无 BOM 时按 GBK 读脚本，UTF-8 中文注释会串行并把变量吃空，所以脚本正文保持纯 ASCII；读应用写的 trace 要显式 `-Encoding UTF8`，否则中文尾字节会吞掉换行、两行并成一行

## 代码结构
- server.mjs：静态托管 + /api/proxy 同源转发，SSRF 防护逻辑都集中在这个文件（桌面版原样复用，不改）
- public/index.html：页面骨架
- public/app.js：前端全部逻辑；探测、测试、渲染都在这里，存储读写集中在 load/save 开头的 5 个函数（具体行号见 prompt.md）
- public/app.css：样式
- start-aihubpanel.bat：Windows 一键启动（网页版）
- prompt.md：桌面版施工手册（架构、里程碑、坑、红线）
- electron/main.js：桌面版主进程（选端口、起服务、开窗口、单实例锁、算配置目录、启动耗时探针）
- electron/preload.js：存储桥，contextBridge 暴露 window.aihubStore，内部用 fs 同步读写 config.json
- electron/icon.png、electron/icon.ico：应用图标（打包和窗口都用它）
- package.json / .npmrc：桌面版依赖、打包配置与 electron 二进制镜像
