import crypto from "node:crypto";

const SESSION_COOKIE = "aihub_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_SESSIONS = 16;
const PASSWORD_SALT = Buffer.from("aihubpanel-password-v1", "utf8");

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  const raw = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  for (const part of raw.split(";")) {
    const [key, ...values] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(values.join("="));
      } catch {
        return "";
      }
    }
  }
  return "";
}

function cookieHeader(value, maxAge, secure) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clientKey(req) {
  return req.socket?.remoteAddress || "unknown";
}

function derivePassword(password, salt = PASSWORD_SALT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function createAuth(options = {}) {
  let password = String(options.password || "");
  const sessionSecret = String(options.sessionSecret || "");
  const secureCookie = options.secureCookie === true;
  const authSalt = crypto.createHash("sha256").update(PASSWORD_SALT).update(sessionSecret).digest();
  const passwordDigestPromise = derivePassword(password, authSalt).finally(() => {
    password = "";
  });
  const sessions = new Map();
  const failures = new Map();

  function prune() {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
    while (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
    for (const [key, value] of failures) {
      if (value.resetAt <= now) failures.delete(key);
    }
  }

  function failureAllowed(req) {
    prune();
    const key = clientKey(req);
    const current = failures.get(key);
    if (!current || current.resetAt <= Date.now()) return true;
    return current.count < MAX_FAILURES;
  }

  function recordFailure(req) {
    const key = clientKey(req);
    const current = failures.get(key);
    const now = Date.now();
    if (!current || current.resetAt <= now) {
      failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    } else {
      current.count += 1;
    }
  }

  function clearFailures(req) {
    failures.delete(clientKey(req));
  }

  function authenticateRequest(req) {
    prune();
    const id = cookieValue(req, SESSION_COOKIE);
    if (!id || !sessionSecret) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    return session;
  }

  async function handleLogin(req, body) {
    if (!failureAllowed(req)) {
      return {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(FAILURE_WINDOW_MS / 1000)) },
        body: { error: { code: "login_rate_limited", message: "登录失败次数过多，请稍后重试" } }
      };
    }
    const supplied = body && typeof body.password === "string" ? body.password : "";
    if (supplied.length > 256) {
      recordFailure(req);
      return { status: 401, body: { error: { code: "invalid_credentials", message: "密码错误" } } };
    }
    const digest = await derivePassword(supplied, authSalt);
    const expected = await passwordDigestPromise;
    if (!safeEqual(digest, expected)) {
      recordFailure(req);
      return { status: 401, body: { error: { code: "invalid_credentials", message: "密码错误" } } };
    }
    clearFailures(req);
    const id = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    sessions.set(id, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
    prune();
    return {
      status: 200,
      headers: { "Set-Cookie": cookieHeader(id, Math.floor(SESSION_TTL_MS / 1000), secureCookie) },
      body: { authenticated: true, csrfToken }
    };
  }

  function handleLogout(req) {
    const id = cookieValue(req, SESSION_COOKIE);
    if (id) sessions.delete(id);
    return {
      status: 200,
      headers: { "Set-Cookie": cookieHeader("", 0, secureCookie) },
      body: { authenticated: false }
    };
  }

  function sessionInfo(req) {
    const session = authenticateRequest(req);
    return session
      ? { authenticated: true, csrfToken: session.csrfToken }
      : { authenticated: false };
  }

  function csrfValid(req) {
    const session = authenticateRequest(req);
    return !!session && typeof req.headers["x-aihub-csrf"] === "string" && safeEqual(req.headers["x-aihub-csrf"], session.csrfToken);
  }

  return {
    authenticateRequest,
    handleLogin,
    handleLogout,
    sessionInfo,
    csrfValid
  };
}
