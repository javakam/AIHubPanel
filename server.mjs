// AIHubPanel · 本地/局域网静态服务 + 受限同源 API 转发
// 纯静态部署仍可直连支持 CORS 的站点；运行本服务可在浏览器 CORS 失败时自动恢复请求。
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const PUBLIC_REAL_DIR = fs.realpathSync(PUBLIC_DIR);
const PORT = Number(process.env.AI_HUB_PORT) || 4179;
const HOST = process.env.AI_HUB_HOST || "127.0.0.1";
const PROXY_PATH = "/api/proxy";
const PROXY_HEALTH_PATH = "/api/proxy/health";
const PROXY_TIMEOUT_MS = Math.min(Math.max(Number(process.env.AI_HUB_PROXY_TIMEOUT_MS) || 120000, 1000), 120000);
const PROXY_MAX_BODY_BYTES = 10 * 1024 * 1024;
// 模型目录与诊断响应通常很小；为异常公网目标设置硬上限，避免 relay 长时间转发无限响应。
const PROXY_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const RAW_ALLOWED_PROXY_ORIGIN = String(process.env.AI_HUB_ALLOWED_ORIGIN || "").trim();
const ALLOWED_PROXY_ORIGIN = normaliseConfiguredOrigin(RAW_ALLOWED_PROXY_ORIGIN);
const LOOPBACK_PROXY_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);
const IS_LOOPBACK_BIND = isLoopbackBindHost(HOST);
if (RAW_ALLOWED_PROXY_ORIGIN && !ALLOWED_PROXY_ORIGIN) {
  throw new Error("AI_HUB_ALLOWED_ORIGIN 必须是有效的 http(s) origin，例如 http://192.168.1.20:4179");
}
if (!IS_LOOPBACK_BIND && !ALLOWED_PROXY_ORIGIN) {
  throw new Error("非回环监听必须显式设置 AI_HUB_ALLOWED_ORIGIN，避免同源转发被伪造成开放代理");
}
const PROXY_ORIGINS = new Set(ALLOWED_PROXY_ORIGIN ? [ALLOWED_PROXY_ORIGIN] : LOOPBACK_PROXY_ORIGINS);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin"
};

function sendText(res, method, status, message, extraHeaders = {}) {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extraHeaders });
  if (method !== "HEAD") res.end(message);
  else res.end();
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normaliseConfiguredOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

function isLoopbackBindHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function sendProxyError(res, method, status, code, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    ...BASE_HEADERS,
    "X-AIHub-Proxy": "1",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (method !== "HEAD") res.end(JSON.stringify({ error: { code, message } }));
  else res.end();
}

function sendProxyHealth(res, method) {
  res.writeHead(200, {
    ...BASE_HEADERS,
    "X-AIHub-Proxy": "1",
    "Content-Type": "application/json; charset=utf-8"
  });
  if (method !== "HEAD") res.end(JSON.stringify({ proxy: true, version: 1 }));
  else res.end();
}

function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// 只信任固定配置的 origin；绝不根据客户端可控的 Host 头动态推断允许源。
// Sec-Fetch-Site 仅作为浏览器 CSRF 信号，不承担 LAN 身份认证职责。
function isSameOriginProxyRequest(req) {
  const origin = originOf(req.headers.origin);
  const referer = originOf(req.headers.referer);
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") return false;
  if (origin && !PROXY_ORIGINS.has(origin)) return false;
  if (referer && !PROXY_ORIGINS.has(referer)) return false;
  if (origin || referer) return PROXY_ORIGINS.has(origin || referer);
  // Chromium 同源 GET 可能只带 Fetch Metadata；仅在服务绑定回环时接受该情况。
  return IS_LOOPBACK_BIND && fetchSite === "same-origin";
}

function ipv4Number(address) {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value << 8) + Number(part), 0);
}

function isPublicIPv4(address) {
  const value = ipv4Number(address);
  if (value === null) return false;
  const inRange = (base, bits) => (value >>> (32 - bits)) === (base >>> (32 - bits));
  return !(
    inRange(0x00000000, 8) || inRange(0x0a000000, 8) || inRange(0x64400000, 10) ||
    inRange(0x7f000000, 8) || inRange(0xa9fe0000, 16) || inRange(0xac100000, 12) ||
    inRange(0xc0000000, 24) || inRange(0xc0a80000, 16) || inRange(0xc6120000, 15) ||
    inRange(0xcb007100, 24) || inRange(0xe0000000, 4)
  );
}

function ipv6Number(address) {
  let input = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (input.includes("%")) return null;
  const last = input.lastIndexOf(":");
  if (input.includes(".")) {
    const v4 = ipv4Number(input.slice(last + 1));
    if (v4 === null) return null;
    input = `${input.slice(0, last + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const pieces = input.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  if (left.length + right.length > 8 || (pieces.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (value === null) return false;
  const isPrefix = (prefix, bits) => (value >> BigInt(128 - bits)) === BigInt(prefix);
  // IPv4-compatible / IPv4-mapped IPv6 必须按其 IPv4 地址再次校验。
  if ((value >> 32n) === 0n || (value >> 32n) === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    return isPublicIPv4(`${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`);
  }
  // Compare prefixes at their declared bit width. 0xfc/0xfe80 are byte/word
  // notation; the values shifted to 7/10 bits are 0x7e and 0x3fa.
  return !(value === 0n || value === 1n || isPrefix(0x7e, 7) || isPrefix(0x3fa, 10) ||
    isPrefix(0xff, 8) || isPrefix(0x20010db8, 32));
}

async function resolvePublicTarget(hostname) {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) {
    if (!isPublicAddress(literal)) throw new Error("blocked-address");
    return { address: literal, family: net.isIP(literal) };
  }
  if (literal === "localhost" || literal.endsWith(".localhost") || literal.endsWith(".local")) {
    throw new Error("blocked-address");
  }
  const records = await dns.lookup(literal, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) throw new Error("blocked-address");
  // 很多公网 CDN 同时发布 AAAA/A；优先 IPv4，兼容未部署 IPv6 出口的家庭/局域网环境。
  return records.find(record => record.family === 4) || records[0];
}

function proxyRequestHeaders(req) {
  const result = {};
  for (const name of ["accept", "content-type", "authorization", "x-api-key", "api-key", "anthropic-version", "openai-organization", "openrouter-title", "openrouter-http-referer"]) {
    const value = req.headers[name];
    if (typeof value === "string") result[name] = value;
  }
  const length = req.headers["content-length"];
  if (typeof length === "string") result["content-length"] = length;
  return result;
}

function proxyResponseHeaders(headers) {
  const result = {};
  const skipped = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie"]);
  const protectedHeaders = new Set([...Object.keys(BASE_HEADERS).map(name => name.toLowerCase()), "x-aihub-proxy"]);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!skipped.has(lower) && !protectedHeaders.has(lower) && value !== undefined) result[name] = value;
  }
  return result;
}

async function handleProxy(req, res, requestUrl) {
  const method = req.method || "GET";
  if (!["GET", "POST", "HEAD"].includes(method)) {
    sendProxyError(res, method, 405, "method_not_allowed", "仅支持 GET、POST 和 HEAD 请求");
    return;
  }
  // GET/HEAD 通常没有请求体，但仍排空客户端可能附带的 chunked body，避免 keep-alive 连接残留。
  if (method !== "POST") req.resume();
  if (!isSameOriginProxyRequest(req)) {
    sendProxyError(res, method, 403, "same_origin_required", "仅允许来自本面板同源页面的请求");
    return;
  }

  const targetText = requestUrl.searchParams.get("url") || requestUrl.searchParams.get("u");
  if (!targetText || targetText.length > 8192) {
    sendProxyError(res, method, 400, "invalid_target", "请通过 url 参数提供有效的公网 HTTP(S) 地址");
    return;
  }
  let target;
  try {
    target = new URL(targetText);
  } catch {
    sendProxyError(res, method, 400, "invalid_target", "请通过 url 参数提供有效的公网 HTTP(S) 地址");
    return;
  }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) {
    sendProxyError(res, method, 400, "invalid_target", "仅允许不含账号信息的公网 HTTP(S) 地址");
    return;
  }
  const contentLength = Number(req.headers["content-length"] || 0);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > PROXY_MAX_BODY_BYTES) {
    sendProxyError(res, method, 413, "body_too_large", "请求体不能超过 10 MiB");
    return;
  }

  let destination;
  try {
    destination = await resolvePublicTarget(target.hostname);
  } catch (error) {
    const isBlocked = error instanceof Error && error.message === "blocked-address";
    sendProxyError(res, method, isBlocked ? 403 : 502, isBlocked ? "blocked_target" : "dns_failed", isBlocked ? "目标地址不允许访问" : "无法解析目标域名");
    return;
  }

  const transport = target.protocol === "https:" ? https : http;
  let finished = false;
  let timeout;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  };
  const fail = (status, code, message) => {
    if (finished) return;
    finished = true;
    cleanup();
    sendProxyError(res, method, status, code, message);
  };
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    path: `${target.pathname}${target.search}`,
    method,
    headers: proxyRequestHeaders(req),
    // 强制使用已审核的 IP，避免 DNS rebinding；hostname 仍保留用于 HTTPS SNI/Host。
    lookup: (_hostname, options, callback) => {
      // Node 20+ 的 Agent 可能以 all:true 调用自定义 lookup，回调形状随之变为地址数组。
      if (options?.all) callback(null, [destination]);
      else callback(null, destination.address, destination.family);
    }
  }, upstreamResponse => {
    if (finished) {
      upstreamResponse.resume();
      return;
    }
    const upstreamStatus = upstreamResponse.statusCode || 502;
    const upstreamHeaders = proxyResponseHeaders(upstreamResponse.headers);
    if ([301, 302, 303, 307, 308].includes(upstreamStatus)) {
      upstreamResponse.resume();
      fail(502, "upstream_redirect_not_supported", "目标服务返回了重定向，请将 Base URL 改为最终的 HTTPS API 地址");
      return;
    }
    const declaredLength = Number(upstreamResponse.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > PROXY_MAX_RESPONSE_BYTES) {
      upstreamResponse.resume();
      fail(502, "upstream_response_too_large", "上游响应超过 50 MiB 限制");
      return;
    }
    res.writeHead(upstreamStatus, { ...upstreamHeaders, ...BASE_HEADERS, "X-AIHub-Proxy": "1" });
    if (method === "HEAD") {
      upstreamResponse.resume();
      res.end();
      finished = true;
      cleanup();
      return;
    }
    const responseLimit = new Transform({
      transform(chunk, _encoding, callback) {
        this.bytes = (this.bytes || 0) + chunk.length;
        if (this.bytes > PROXY_MAX_RESPONSE_BYTES) {
          callback(Object.assign(new Error("response-too-large"), { code: "RESPONSE_TOO_LARGE" }));
        } else callback(null, chunk);
      }
    });
    responseLimit.on("error", error => {
      upstreamResponse.destroy(error);
      if (!res.destroyed) res.destroy();
    });
    upstreamResponse.on("error", () => res.destroy());
    upstreamResponse.pipe(responseLimit).pipe(res);
    res.on("finish", () => {
      finished = true;
      cleanup();
    });
  });
  upstream.on("error", error => {
    if (finished) return;
    const timedOut = error instanceof Error && error.message === "proxy-timeout";
    fail(timedOut ? 504 : 502, timedOut ? "upstream_timeout" : "upstream_unavailable", timedOut ? "上游响应超时" : "无法连接目标服务");
  });
  timeout = setTimeout(() => upstream.destroy(new Error("proxy-timeout")), PROXY_TIMEOUT_MS);
  res.on("close", () => {
    if (!finished) upstream.destroy();
    cleanup();
  });

  if (method !== "POST") {
    upstream.end();
    return;
  }
  let received = 0;
  const bodyLimit = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > PROXY_MAX_BODY_BYTES) callback(Object.assign(new Error("body-too-large"), { code: "BODY_TOO_LARGE" }));
      else callback(null, chunk);
    }
  });
  bodyLimit.on("error", error => {
    upstream.destroy(error);
    if (!res.headersSent) fail(413, "body_too_large", "请求体不能超过 10 MiB");
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(bodyLimit).pipe(upstream);
}

const server = http.createServer((req, res) => {
  const method = req.method || "GET";
  if (!req.url) {
    sendText(res, method, 400, "Bad Request");
    return;
  }
  let pathname;
  let requestUrl;
  try {
    // 基准固定为 localhost，不信任客户端可控的 Host 请求头。
    requestUrl = new URL(req.url, "http://localhost");
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch (error) {
    sendText(res, method, 400, "Bad Request");
    return;
  }
  if (pathname === PROXY_HEALTH_PATH) {
    if (method !== "GET" && method !== "HEAD") {
      sendProxyError(res, method, 405, "method_not_allowed", "仅支持 GET 和 HEAD 请求");
      return;
    }
    sendProxyHealth(res, method);
    return;
  }
  if (pathname === PROXY_PATH) {
    void handleProxy(req, res, requestUrl).catch(error => {
      console.error(`本地转发内部错误：${error instanceof Error ? error.message : String(error)}`);
      sendProxyError(res, method, 500, "proxy_internal_error", "本地转发内部错误，请稍后重试");
    });
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    sendText(res, method, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    return;
  }

  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) {
    sendText(res, method, 400, "Bad Request");
    return;
  }

  // resolve + relative 双重判断，避免 Windows 同前缀目录和 ../ 穿越；随后 realpath 防符号链接逃逸。
  const requestPath = pathname.replace(/^[/\\]+/, "");
  const filePath = path.resolve(PUBLIC_REAL_DIR, requestPath);
  if (!isWithin(PUBLIC_REAL_DIR, filePath)) {
    sendText(res, method, 403, "Forbidden");
    return;
  }

  fs.realpath(filePath, (realpathError, realFilePath) => {
    if (realpathError) {
      sendText(res, method, 404, "404 Not Found");
      return;
    }
    if (!isWithin(PUBLIC_REAL_DIR, realFilePath)) {
      sendText(res, method, 403, "Forbidden");
      return;
    }
    fs.readFile(realFilePath, (readError, data) => {
      if (readError) {
        sendText(res, method, 404, "404 Not Found");
        return;
      }
      const ext = path.extname(realFilePath).toLowerCase();
      res.writeHead(200, { ...BASE_HEADERS, "Content-Type": TYPES[ext] || "application/octet-stream" });
      if (method !== "HEAD") res.end(data);
      else res.end();
    });
  });
});

server.on("error", error => {
  console.error(`静态服务启动失败：${error.message}`);
  process.exitCode = 1;
  if (!server.listening) server.close(() => process.exit(1));
});

server.listen(PORT, HOST, () => {
  console.log(`中转站管理面板已启动：`);
  console.log(`  监听：${HOST}:${PORT}`);
  console.log(`  本机：http://127.0.0.1:${PORT}`);
  if (IS_LOOPBACK_BIND) console.log(`  同源转发允许：http://127.0.0.1:${PORT}、http://localhost:${PORT}、http://[::1]:${PORT}`);
  else console.log(`  同源转发允许：${ALLOWED_PROXY_ORIGIN}`);
  console.log(`  本服务会在浏览器跨域请求失败时提供受限同源转发；静态部署仅支持目标站已开启 CORS 的直连请求。`);
});
