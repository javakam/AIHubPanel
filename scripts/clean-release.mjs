import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = path.join(ROOT, "electron", "release");
const PACKAGE_FILE = path.join(ROOT, "package.json");
const KEEP_PORTABLE = process.argv.includes("--keep-portable");

function assertReleasePath() {
  const expectedParent = path.join(ROOT, "electron");
  if (path.dirname(RELEASE_DIR) !== expectedParent || path.basename(RELEASE_DIR) !== "release") {
    throw new Error(`refusing unsafe release path: ${RELEASE_DIR}`);
  }
  if (!fs.existsSync(RELEASE_DIR)) return null;
  // 词法路径对不代表真身在里面：electron/ 或 electron/release 只要有一层是指向仓库外的
  // 目录联接，rmSync -r 删掉的就是别人的目录。这里按真实路径再确认一次包含关系。
  if (fs.lstatSync(RELEASE_DIR).isSymbolicLink()) {
    throw new Error(`refusing symlinked release path: ${RELEASE_DIR}`);
  }
  const realRoot = fs.realpathSync(ROOT);
  const realRelease = fs.realpathSync(RELEASE_DIR);
  const relative = path.relative(realRoot, realRelease);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing release path outside the repository: ${realRelease}`);
  }
  return realRelease;
}

function removeReleaseDirectory() {
  assertReleasePath();
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  console.log(`release cleaned: ${RELEASE_DIR}`);
}

function pruneReleaseDirectory() {
  const realRelease = assertReleasePath();
  const packageInfo = JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8"));
  const artifactName = `AIHubPanel-${packageInfo.version}.exe`;
  const artifactPath = path.join(RELEASE_DIR, artifactName);
  if (!fs.existsSync(RELEASE_DIR)) throw new Error(`release directory missing: ${RELEASE_DIR}`);
  // 先确认目标产物真的在，再动别的条目。顺序反了就是「产物没那么回事，顺手把同目录的
  // 用户数据一起删了」。
  if (!fs.existsSync(artifactPath)) throw new Error(`portable artifact missing: ${artifactPath}`);
  const entries = fs.readdirSync(RELEASE_DIR);
  for (const entry of entries) {
    if (entry === artifactName) continue;
    const target = path.join(RELEASE_DIR, entry);
    const real = fs.realpathSync(target);
    const relative = path.relative(realRelease, real);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to delete ${target}: it resolves outside the release directory`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log(`release kept: ${artifactName}`);
}

if (KEEP_PORTABLE) pruneReleaseDirectory();
else removeReleaseDirectory();
