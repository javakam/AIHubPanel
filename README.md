# AIHubPanel

中转站管理 · 轻量面板。把一堆 API 中转站的余额、连通性、模型列表和模型测试收拢到一个本地面板里，不用再挨个开后台查。

## 这是什么

同时用好几个 API 中转站（New API、Sub2API 这类 OpenAI 兼容网关）的时候，想看余额、测哪些模型能用、确认 key 还没过期，得分别登录各家后台，来回切很烦。AIHubPanel 就是干这个的：填好 Base URL 和 API Key，连通性、余额、模型目录、单模型和批量模型测试都能在页面上直接点，结果汇总在一起看。

网页版数据全存在浏览器本地（localStorage），不经过任何第三方服务器。Windows 桌面版把普通配置和测试记录写在 exe 同级的 `config.json`，API Key 单独写在同级 `apikey.json`。请求默认走浏览器自己的网络通道；碰到站点没开 CORS 的情况，可以启动自带的本地服务做同源转发。

也提供了 Windows 桌面版（双击 exe 打开，不开浏览器、不依赖系统 Node）。开发和打包命令见下文，详见 `electron/` 目录和 `prompt.md` 施工手册。

## 运行

需要 Node.js（建议 18+），没有其它依赖，clone 下来直接跑：

```bash
node server.mjs
```

默认监听 `http://127.0.0.1:4179`。Windows 下也可以双击 `start-aihubpanel.bat`，它会挑一个真正能用的端口并启动服务；脚本默认不会自动打开浏览器，按提示手动访问输出的地址即可。确实需要自动打开时，可在运行前设置 `AI_HUB_OPEN_BROWSER=1`。

如果启动报 `listen EACCES: permission denied`，说明这个端口被 Windows 整段预留了（Hyper-V / WSL / Docker 开机时申请，`netsh int ipv4 show excludedportrange protocol=tcp` 可以看到有哪些段）。换一个 `AI_HUB_PORT` 就行，bat 已经会自动换。注意面板数据存在浏览器 localStorage 里、按端口隔离，换端口后面板是空的——原有站点没丢，用面板的导出/导入搬过去即可。

几个环境变量可以调：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `AI_HUB_PORT` | 监听端口 | `4179` |
| `AI_HUB_HOST` | 监听地址，改成局域网 IP 可在手机/其它设备访问 | `127.0.0.1` |
| `AI_HUB_ALLOWED_ORIGIN` | 非回环监听时必须设置，指定允许调用转发的来源 | 无 |
| `AI_HUB_PROXY_TIMEOUT_MS` | 转发请求超时 | `120000` |

> 如果只把 `public/` 当静态文件托管，面板本身也能用，直连支持 CORS 的站点没问题；启动 `server.mjs` 主要是为了在 CORS 失败时自动接管转发。

## 飞牛 NAS Docker 版

Docker 版适合把面板部署在飞牛 NAS 上，让家里和公司的多台主机访问同一套站点配置。它使用一个 Node 容器，不安装 npm 依赖，不包含 Electron；站点、API Key、模型列表和测试结果保存在容器挂载的 `data/` 目录，主题、视图、代理和选择状态仍保存在各自浏览器。

部署时请使用一个固定访问地址。优先通过 Tailscale / WireGuard 等私网访问，或者通过飞牛 NAS 的 HTTPS 反向代理访问；不要把容器端口直接暴露到公网。Compose 默认把端口绑定到 NAS 的所有网卡，便于三台主机通过 NAS 地址访问；只使用 NAS 反向代理时，可在 `.env` 中把 `AI_HUB_BIND` 改为 `127.0.0.1`。

首次部署前，在项目目录准备未纳入 Git 的 `.env`，填写准确的 `AI_HUB_ALLOWED_ORIGIN`、面板登录密码和随机的 `AI_HUB_SESSION_SECRET`。直接用 HTTP 访问 NAS 时保持 `AI_HUB_COOKIE_SECURE=0`；使用 HTTPS 反向代理时改为 `1`。然后执行 `docker compose up -d --build`。

`.env` 示例（只放在 NAS，不要提交到 Git）：

```dotenv
AI_HUB_ALLOWED_ORIGIN=http://aihub-nas.example:4179
AI_HUB_ADMIN_PASSWORD=请替换成面板密码
AI_HUB_SESSION_SECRET=请替换成至少16个字符的随机字符串
AI_HUB_COOKIE_SECURE=0
AI_HUB_TRUSTED_PROXY=0
```

通过 HTTPS 反向代理访问时，可以把 `AI_HUB_TRUSTED_PROXY` 设为 `1`：登录失败限流会按 `X-Forwarded-For` 里的真实客户端 IP 分桶，避免几台主机共用同一个失败配额。直连访问时保持 `0`（该头字段可伪造，只有确认前面有自己的反代时才开启）。

直接通过 NAS 地址访问时，把 `AI_HUB_ALLOWED_ORIGIN` 写成浏览器地址栏中的完整来源，例如 `http://192.168.1.20:4179`；通过 HTTPS 反向代理访问时写成 `https://aihub.example.com`，并把 `AI_HUB_COOKIE_SECURE` 改为 `1`。三台主机必须使用同一个固定来源，不要一台用 IP、另一台用不同域名。

在飞牛 Docker 管理器中构建并启动后，检查容器健康状态和 `http://NAS地址:4179/`。升级时执行 `docker compose up -d --build`，不要删除 `data/`；这个目录里的 `state.json` 和 `state.json.bak` 是共享配置及恢复备份。建议在升级前复制一份 `data/` 到 NAS 的备份目录。

容器只需要持久化 `data/`。升级镜像前备份这个目录；容器重建不会影响里面的共享配置。三台主机同时修改时，面板按版本号拒绝旧数据覆盖，并提示重新加载或导出本机数据。

## 功能

- **站点管理**：多个中转站集中管理，支持分组、搜索、拖拽排序。快速导入能直接粘贴 NewAPI 的连接导出文本，自动识别 Base URL 和 Key。
- **连通性 + 延迟**：一键探测站点是否可达，显示 RTT。先试带凭据的接口，被 CORS 拦了再用 no-cors 探测网络层可达性，不会把无效 key 误判成已验证。
- **余额**：兼容 New API、Sub2API 等几套余额接口路径，自动按顺序探测，不用手动指定。
- **模型列表**：拉取 `/v1/models`，支持按名称、状态排序。
- **模型测试**：单个点闪电图标测，也能勾选一批批量测。批量有并发上限和进度节流，上百个模型也不会卡页面。
- **认证兼容**：Bearer 失败（401/403）后自动换 x-api-key 重试一次，适配只认其中一种的网关。GET/HEAD 才会自动重试，POST 这类有副作用的不会。
- **两种视图**：网格视图点开进专注页；列表视图左边列表右边详情常驻。
- **导入导出**：导出 JSON 备份（含 API Key，注意保管），换浏览器或迁移时用。
- **主题**：浅色 / 深色 / 跟随系统。

## 本地转发的安全设计

`server.mjs` 里那个转发接口容易被当成 SSRF 入口，所以做了几层限制：

- 只允许 `http`/`https`，拒绝带账号密码的 URL；
- 发请求前解析域名，拒绝 `localhost`、环回、私有、链路本地和保留地址段（覆盖 IPv4 和 IPv6，含 IPv4-mapped 地址）；
- 锁定已校验过的 IP，防止 DNS rebinding；
- 拒绝上游重定向，避免 key 被转发到别的域名；
- 默认只绑 `127.0.0.1`；要局域网访问必须显式设置 `AI_HUB_ALLOWED_ORIGIN`，防止变成开放代理；
- 同源校验，只接受面板页面发出的请求。

## 项目结构

```
server.mjs              本地服务 + 受限同源转发
start-aihubpanel.bat     Windows 一键启动
public/
  index.html
  app.js                 前端逻辑（原生 JS，无框架无构建）
  app.css
electron/                Windows 桌面版（Electron）
  main.js                主进程：选端口、起 server.mjs、开窗口
  preload.js             存储桥：config.json / apikey.json ↔ 渲染进程
  icon.png / icon.ico    应用图标
```

前端是原生 JavaScript，没有框架、没有构建步骤，改完刷新就能看效果。

## Windows 桌面版

开发运行：

```bash
npm start
```

生成单文件非安装版：

```bash
npm run dist
```

产物在 `electron/release/`：

- `AIHubPanel-1.2.0.exe`：单文件非安装版，直接双击运行。

打包脚本会先清空旧产物，构建完成后只保留这一个 exe。程序数据保存在运行时 exe 同级目录：普通配置和测试记录在 `config.json`，API Key 单独在 `apikey.json`。Electron 的缓存、日志和临时运行数据也尽量写入同级隐藏目录 `.aihubpanel-data`。便携版启动时虽然会在系统临时目录自解压，但业务数据仍写回用户实际双击的 exe 所在目录。两个 JSON 文件都请妥善保存，其中 `apikey.json` 尤其重要。
