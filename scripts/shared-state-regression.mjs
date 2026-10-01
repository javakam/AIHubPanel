import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_BIN = process.execPath;
const PASSWORD = "test-password-only";
const SESSION_SECRET = "test-session-secret-only";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => resolve(address.port));
    });
  });
}

function startServer(port, dataDir, extraEnv = {}) {
  const child = spawn(NODE_BIN, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AI_HUB_HOST: "127.0.0.1",
      AI_HUB_PORT: String(port),
      AI_HUB_SHARED_STATE: "1",
      AI_HUB_DATA_DIR: dataDir,
      AI_HUB_ADMIN_PASSWORD: PASSWORD,
      AI_HUB_SESSION_SECRET: SESSION_SECRET,
      ...extraEnv
    },
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
    if (child.exitCode !== null) throw new Error(`server exited early:\n${child.output}`);
    try {
      const response = await fetch(`${baseUrl}/api/proxy/health`, { method: "HEAD" });
      if (response.status === 200) return;
    } catch {
      // The server may still be binding the port.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready:\n${child.output}`);
}

function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("close", resolve);
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 1500).unref();
  });
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie") || "";
  return value.split(";", 1)[0];
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, got ${text.slice(0, 200)}`);
  }
}

async function expectStatus(label, response, expected) {
  if (response.status !== expected) {
    const text = await response.text();
    throw new Error(`${label}: expected ${expected}, got ${response.status}: ${text.slice(0, 200)}`);
  }
}

function station(name, order = 0) {
  return {
    id: `test-${order + 1}`,
    name,
    baseurl: "https://example.com/v1",
    apikey: "sk-test-key",
    group: "",
    note: "",
    balancePath: "",
    headers: {},
    order,
    status: { connectivity: "unknown", logs: [] },
    models: []
  };
}

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aihubpanel-shared-state-"));
  let child;
  try {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = startServer(port, dataDir);
    await waitForServer(baseUrl, child);

    const unauthorized = await fetch(`${baseUrl}/api/state`);
    await expectStatus("unauthorized state", unauthorized, 401);

    const badLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" })
    });
    await expectStatus("wrong password", badLogin, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD })
    });
    await expectStatus("login", login, 200);
    const cookie = cookieFrom(login);
    const loginBody = await json(login);
    const setCookie = login.headers.get("set-cookie") || "";
    if (!cookie || !setCookie.includes("HttpOnly") || !setCookie.includes("SameSite=Strict") ||
      typeof loginBody.csrfToken !== "string" || !loginBody.csrfToken) {
      throw new Error("login did not return a session cookie and csrf token");
    }

    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie }
    });
    await expectStatus("session", session, 200);
    const sessionBody = await json(session);
    if (sessionBody.authenticated !== true || sessionBody.csrfToken !== loginBody.csrfToken) {
      throw new Error("session response did not preserve authentication state");
    }
    if (sessionBody.shared !== true) {
      throw new Error("shared-mode session response must declare shared:true");
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: `wrong-${attempt}` })
      });
      await expectStatus(`failed login ${attempt + 1}`, failedLogin, 401);
    }
    const rateLimited = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-final" })
    });
    await expectStatus("login rate limit", rateLimited, 429);

    const initial = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
    await expectStatus("initial state", initial, 200);
    const initialBody = await json(initial);
    if (initialBody.revision !== 0 || !Array.isArray(initialBody.stations) || initialBody.stations.length !== 0) {
      throw new Error("initial state was not empty revision zero");
    }

    const badCsrf = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-aihub-csrf": "wrong-csrf"
      },
      body: JSON.stringify({ revision: initialBody.revision, stations: [] })
    });
    await expectStatus("bad csrf", badCsrf, 403);

    const stationOne = station("first");
    const saveOne = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-aihub-csrf": loginBody.csrfToken
      },
      body: JSON.stringify({ revision: initialBody.revision, stations: [stationOne] })
    });
    await expectStatus("first state save", saveOne, 200);
    const saveOneBody = await json(saveOne);
    if (saveOneBody.revision !== 1) throw new Error("first state save did not advance revision");

    const stale = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-aihub-csrf": loginBody.csrfToken
      },
      body: JSON.stringify({ revision: 0, stations: [station("stale")] })
    });
    await expectStatus("stale state save", stale, 409);

    const stationTwo = station("second");
    const saveTwo = await fetch(`${baseUrl}/api/state`, {
      method: "PUT",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-aihub-csrf": loginBody.csrfToken
      },
      body: JSON.stringify({ revision: saveOneBody.revision, stations: [stationOne, stationTwo] })
    });
    await expectStatus("second state save", saveTwo, 200);

    await stopServer(child);
    child = null;
    fs.writeFileSync(path.join(dataDir, "state.json"), "{broken", "utf8");

    const recoveryPort = await getFreePort();
    child = startServer(recoveryPort, dataDir);
    const recoveryUrl = `http://127.0.0.1:${recoveryPort}`;
    await waitForServer(recoveryUrl, child);
    const recoveryLogin = await fetch(`${recoveryUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD })
    });
    await expectStatus("recovery login", recoveryLogin, 200);
    const recoveryCookie = cookieFrom(recoveryLogin);
    const recoveryBody = await json(recoveryLogin);
    const recovered = await fetch(`${recoveryUrl}/api/state`, {
      headers: { cookie: recoveryCookie }
    });
    await expectStatus("recovered state", recovered, 200);
    const recoveredBody = await json(recovered);
    if (recoveredBody.revision !== 1 || recoveredBody.stations[0]?.name !== "first") {
      throw new Error("state backup recovery did not restore the previous valid revision");
    }
    if (!recoveryBody.csrfToken) throw new Error("recovery login did not return csrf token");

    await stopServer(child);
    child = null;
    fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({
      schemaVersion: 1,
      revision: 999,
      updatedAt: null,
      stations: "broken"
    }), "utf8");

    const structuralRecoveryPort = await getFreePort();
    child = startServer(structuralRecoveryPort, dataDir);
    const structuralRecoveryUrl = `http://127.0.0.1:${structuralRecoveryPort}`;
    await waitForServer(structuralRecoveryUrl, child);
    const structuralLogin = await fetch(`${structuralRecoveryUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD })
    });
    await expectStatus("structural recovery login", structuralLogin, 200);
    const structuralCookie = cookieFrom(structuralLogin);
    const structuralRecovered = await fetch(`${structuralRecoveryUrl}/api/state`, {
      headers: { cookie: structuralCookie }
    });
    await expectStatus("structurally recovered state", structuralRecovered, 200);
    const structuralRecoveredBody = await json(structuralRecovered);
    if (structuralRecoveredBody.revision !== 1 || structuralRecoveredBody.stations[0]?.name !== "first") {
      throw new Error("state backup recovery did not restore a structurally invalid main file");
    }

    const logout = await fetch(`${structuralRecoveryUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: structuralCookie }
    });
    await expectStatus("logout", logout, 200);
    const afterLogout = await fetch(`${structuralRecoveryUrl}/api/state`, {
      headers: { cookie: structuralCookie }
    });
    await expectStatus("state after logout", afterLogout, 401);

    // 可信反代模式：登录限流按 X-Forwarded-For 最左项分桶，不同客户端互不挤占。
    await stopServer(child);
    child = null;
    const proxiedPort = await getFreePort();
    child = startServer(proxiedPort, dataDir, { AI_HUB_TRUSTED_PROXY: "1" });
    const proxiedUrl = `http://127.0.0.1:${proxiedPort}`;
    await waitForServer(proxiedUrl, child);
    const proxiedLogin = await fetch(`${proxiedUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD })
    });
    await expectStatus("trusted proxy login", proxiedLogin, 200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const bucketA = await fetch(`${proxiedUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify({ password: `wrong-${attempt}` })
      });
      await expectStatus(`trusted proxy bucket A failure ${attempt + 1}`, bucketA, 401);
    }
    const limitedA = await fetch(`${proxiedUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: JSON.stringify({ password: "wrong-final" })
    });
    await expectStatus("trusted proxy bucket A rate limited", limitedA, 429);
    const bucketB = await fetch(`${proxiedUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify({ password: "wrong-other-bucket" })
    });
    await expectStatus("trusted proxy bucket B isolated", bucketB, 401);

    console.log("shared state regression: expected routes are present and behavior passed");
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
