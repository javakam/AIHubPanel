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
}

function removeReleaseDirectory() {
  assertReleasePath();
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  console.log(`release cleaned: ${RELEASE_DIR}`);
}

function pruneReleaseDirectory() {
  assertReleasePath();
  const packageInfo = JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8"));
  const artifactName = `AIHubPanel-${packageInfo.version}.exe`;
  if (!fs.existsSync(RELEASE_DIR)) throw new Error(`release directory missing: ${RELEASE_DIR}`);
  const entries = fs.readdirSync(RELEASE_DIR);
  for (const entry of entries) {
    if (entry === artifactName) continue;
    fs.rmSync(path.join(RELEASE_DIR, entry), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(RELEASE_DIR, artifactName))) {
    throw new Error(`portable artifact missing: ${path.join(RELEASE_DIR, artifactName)}`);
  }
  console.log(`release kept: ${artifactName}`);
}

if (KEEP_PORTABLE) pruneReleaseDirectory();
else removeReleaseDirectory();
