import fs from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BIN = process.execPath;
const CHECK_FILES = [
  "public/app.js",
  "server.mjs",
  "server/auth.mjs",
  "server/state-store.mjs",
  "electron/main.js",
  "electron/preload.js",
  "scripts/clean-release.mjs",
  "scripts/layout-regression.cjs",
  "scripts/perf-regression.cjs",
  "scripts/storage-regression.cjs",
  "scripts/startup-regression.cjs",
  "scripts/shared-state-regression.mjs"
];

// 子进程卡住（git 等锁、node --check 被杀软拦住）不能让 npm test 一直挂着。
const RUN_TIMEOUT_MS = Number(process.env.AIHUB_RUN_TIMEOUT_MS) || 120000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(" ")} timed out after ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);
    const settle = callback => value => {
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", settle(reject));
    child.on("close", settle(code => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`${command} ${args.join(" ")} failed with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    }));
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function startPanelServer(port) {
  const child = spawn(NODE_BIN, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, AI_HUB_HOST: "127.0.0.1", AI_HUB_PORT: String(port) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.output = "";
  child.stdout.on("data", chunk => { child.output += chunk; });
  child.stderr.on("data", chunk => { child.output += chunk; });
  return child;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server.mjs exited early:\n${child.output}`);
    try {
      const response = await fetch(`${baseUrl}/api/proxy/health`, { method: "HEAD" });
      if (response.status === 200 && response.headers.get("x-aihub-proxy") === "1") return;
    } catch {
      // The server may still be binding the port.
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`server.mjs did not become ready:\n${child.output}`);
}

async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function expectFetch(label, url, options, expectation) {
  const response = await fetch(url, options);
  if (Array.isArray(expectation.status)) {
    if (!expectation.status.includes(response.status)) {
      throw new Error(`${label}: expected status ${expectation.status.join("/")} but got ${response.status}`);
    }
  } else if (response.status !== expectation.status) {
    throw new Error(`${label}: expected status ${expectation.status} but got ${response.status}`);
  }

  if (expectation.header) {
    const [name, value] = expectation.header;
    if (response.headers.get(name) !== value) {
      throw new Error(`${label}: expected header ${name}=${value}`);
    }
  }
  if (expectation.headerIncludes) {
    const [name, fragment] = expectation.headerIncludes;
    const actual = response.headers.get(name) || "";
    if (!actual.includes(fragment)) {
      throw new Error(`${label}: expected header ${name} to include "${fragment}", got "${actual}"`);
    }
  }

  const body = options && options.method === "HEAD" ? "" : await readBody(response);
  if (expectation.includes && !body.includes(expectation.includes)) {
    throw new Error(`${label}: response body did not include ${expectation.includes}`);
  }
  if (expectation.jsonCode) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`${label}: response body was not JSON`);
    }
    const code = parsed && parsed.error && parsed.error.code;
    if (code !== expectation.jsonCode) throw new Error(`${label}: expected code ${expectation.jsonCode} but got ${code}`);
  }
}

async function runSyntaxChecks() {
  for (const file of CHECK_FILES) {
    await run(NODE_BIN, ["--check", file]);
  }
  await run("git", ["diff", "--check", "--", "public/app.js", "public/app.css", "server.mjs", "server/auth.mjs", "server/state-store.mjs", "electron/main.js", "electron/preload.js", "package.json", "scripts/regression.mjs", "scripts/shared-state-regression.mjs", "scripts/layout-regression.cjs", "scripts/perf-regression.cjs", "scripts/storage-regression.cjs", "scripts/startup-regression.cjs"]);
}

function runReleaseAndDefaultChecks() {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (packageInfo.version !== "1.2.0") throw new Error(`package version must be 1.2.0, got ${packageInfo.version}`);
  const targets = packageInfo.build?.win?.target;
  if (!Array.isArray(targets) || targets.length !== 1 || targets[0] !== "portable") {
    throw new Error(`Windows build must have only the portable target, got ${JSON.stringify(targets)}`);
  }
  if (packageInfo.scripts?.dist !== "node scripts/clean-release.mjs && electron-builder --win portable && node scripts/clean-release.mjs --keep-portable") {
    throw new Error("dist script must clean the release directory and build one portable exe");
  }
  const sourceFiles = ["public/app.js", "public/index.html"];
  const forbidden = ["DEFAULT_STATION", "seedDefault"];
  for (const file of sourceFiles) {
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const value of forbidden) {
      if (content.includes(value)) throw new Error(`${file} contains forbidden hard-coded default: ${value}`);
    }
  }
  const appSource = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
  if (!/async function saveSettingsModal\(\)/.test(appSource) ||
      !/await persistStationsNow\("保存设置"/.test(appSource)) {
    throw new Error("shared settings changes must await NAS station persistence");
  }
  if (!/async function reorder\(/.test(appSource) ||
      !/await reorder\(drag\.fromId,latestDrop\.toId,latestDrop\.after\)/.test(appSource)) {
    throw new Error("station reorder must await NAS persistence before reporting success");
  }
  if (!/let remoteStartPending = false;/.test(appSource) ||
      !/if\(remoteAuthSubmit\) remoteAuthSubmit\(password\);\s*else void startApp\(\);/.test(appSource)) {
    throw new Error("auth gate must retry startApp when bootstrap fails");
  }
  if (!/async function fetchSameOrigin\(/.test(appSource) ||
      !/无法连接共享服务（网络不通或服务正在重启）/.test(appSource) ||
      /await fetch\(REMOTE_/.test(appSource)) {
    throw new Error("shared-service fetches must go through fetchSameOrigin for unified network errors");
  }
  if (!/openModal\.dataset\.backdropClose==="false"\) e\.preventDefault\(\)/.test(appSource)) {
    throw new Error("mandatory modals (form/conflict) must not be dismissed via Escape");
  }
  if (!/else if\(action==="logout"\) void logoutRemote\(\);/.test(appSource)) {
    throw new Error("more-menu logout action must be wired to logoutRemote");
  }
  const cssSource = fs.readFileSync(path.join(ROOT, "public/app.css"), "utf8");
  if (!/\.panel footer\{[^}]*flex-wrap:wrap/.test(cssSource)) {
    throw new Error("modal footers must wrap on narrow screens (conflict modal has 3 buttons)");
  }
}

async function runServerSmoke() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const origin = new URL(baseUrl).origin;
  const child = startPanelServer(port);
  try {
    await waitForServer(baseUrl, child);
    await expectFetch("static index", `${baseUrl}/`, {}, { status: 200, includes: "AIHubPanel", headerIncludes: ["content-security-policy", "script-src 'self'"] });
    await expectFetch("proxy health", `${baseUrl}/api/proxy/health`, { method: "HEAD" }, { status: 200, header: ["x-aihub-proxy", "1"] });
    await expectFetch("local session contract", `${baseUrl}/api/auth/session`, {}, { status: 200, includes: '"shared":false' });
    await expectFetch("static method guard", `${baseUrl}/`, { method: "POST" }, { status: 405 });
    await expectFetch("static path guard", `${baseUrl}/%2e%2e/server.mjs`, {}, { status: [403, 404] });
    await expectFetch("proxy same-origin guard", `${baseUrl}/api/proxy?url=${encodeURIComponent("https://example.com")}`, {}, { status: 403, jsonCode: "same_origin_required" });
    await expectFetch("proxy malformed target", `${baseUrl}/api/proxy?url=not-a-url`, { headers: { origin, "sec-fetch-site": "same-origin" } }, { status: 400, jsonCode: "invalid_target" });
    await expectFetch("proxy private target guard", `${baseUrl}/api/proxy?url=${encodeURIComponent(baseUrl)}`, { headers: { origin, "sec-fetch-site": "same-origin" } }, { status: 403, jsonCode: "blocked_target" });
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function main() {
  await runSyntaxChecks();
  runReleaseAndDefaultChecks();
  await runServerSmoke();
  console.log("check passed: syntax, diff whitespace, server smoke");
}

main().catch(error => {
  console.error(error.message);
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
});
