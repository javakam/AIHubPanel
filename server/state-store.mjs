import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA_VERSION = 1;
const MAX_STATIONS = 2000;
const MAX_STATE_BYTES = 20 * 1024 * 1024;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeStations(value) {
  if (!Array.isArray(value) || value.length > MAX_STATIONS) {
    throw stateError("INVALID_STATE", "站点数据格式不合法或数量超出限制");
  }
  const stations = value.map(station => {
    if (!station || typeof station !== "object" || Array.isArray(station)) {
      throw stateError("INVALID_STATE", "站点数据格式不合法");
    }
    const id = typeof station.id === "string" ? station.id.trim() : "";
    const baseurl = typeof station.baseurl === "string" ? station.baseurl : "";
    const apikey = typeof station.apikey === "string" ? station.apikey : "";
    if (!id || id.length > 160 || baseurl.length > 4096 || apikey.length > 4096) {
      throw stateError("INVALID_STATE", "站点字段超出允许范围");
    }
    return clone(station);
  });
  const serialized = JSON.stringify(stations);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw stateError("STATE_TOO_LARGE", "站点数据不能超过 20 MiB");
  }
  return stations;
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stateError("INVALID_STATE", "共享状态格式不合法");
  }
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw stateError("INVALID_STATE", "共享状态版本号不合法");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    stations: normalizeStations(value.stations)
  };
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function writeAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const content = JSON.stringify(value);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function createStateStore(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || path.join(process.cwd(), "data")));
  const statePath = path.join(dataDir, "state.json");
  const backupPath = path.join(dataDir, "state.json.bak");
  let cachedState = null;
  let loadPromise = null;
  let writeQueue = Promise.resolve();

  async function ensureDataDir() {
    await fs.mkdir(dataDir, { recursive: true });
  }

  async function loadFromDisk() {
    await ensureDataDir();
    try {
      const normalized = normalizeState(await readJson(statePath));
      cachedState = normalized;
      return clone(normalized);
    } catch (mainError) {
      if (mainError?.code === "ENOENT") {
        const empty = { schemaVersion: SCHEMA_VERSION, revision: 0, updatedAt: null, stations: [] };
        cachedState = empty;
        return clone(empty);
      }
      try {
        const recovered = normalizeState(await readJson(backupPath));
        await writeAtomic(statePath, recovered);
        cachedState = recovered;
        return clone(recovered);
      } catch {
        throw stateError("STATE_UNRECOVERABLE", "共享状态文件损坏且备份无法恢复");
      }
    }
  }

  async function load() {
    if (!loadPromise) {
      loadPromise = loadFromDisk().catch(error => {
        loadPromise = null;
        throw error;
      });
    }
    return clone(await loadPromise);
  }

  async function read() {
    return clone(cachedState || await load());
  }

  function replace(expectedRevision, stations) {
    const operation = writeQueue.then(async () => {
      const current = await read();
      if (current.revision !== expectedRevision) {
        throw stateError("REVISION_CONFLICT", "共享状态已被其他设备更新");
      }
      const normalizedStations = normalizeStations(stations);
      const next = {
        schemaVersion: SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        stations: normalizedStations
      };
      await ensureDataDir();
      try {
        await fs.copyFile(statePath, backupPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await writeAtomic(statePath, next);
      cachedState = next;
      return clone(next);
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return {
    load,
    read,
    replace,
    getRevision: async () => (await read()).revision
  };
}
