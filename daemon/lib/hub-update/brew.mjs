// A hub installed with Homebrew (docs/hub-updates.md §8b). The formula (KenseiTheOne/tap/agent-hub) puts the release
// source tree into <prefix>/Cellar/agent-hub/<version>/libexec and builds nothing; `agenthub setup` builds the hub from that
// tree with the usual builder (source kind "brew") into Versions/<version> — the same pinning, launchd job and trial run.
//
// Such a hub does not look at git tags: new versions come with `brew upgrade agent-hub`. The source is recorded in
// config.json → services.hubUpdate.brew = <prefix>/opt/agent-hub/libexec (the opt link survives upgrades); the update
// check reads VERSION (and the optional COMMIT the formula writes) from there — a local file, no network. If brew has a
// newer version than Versions/current, the hub offers "Update", which builds it from the brew tree with the normal trial
// run and rollback.

import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parseVersionFile } from "../version.mjs";

// The formula name and the full name for `brew install` (the tap is KenseiTheOne/homebrew-tap).
export const BREW_FORMULA = "agent-hub";
export const BREW_TAP_FORMULA = "KenseiTheOne/tap/agent-hub";
// The commit the formula built from (40 hex), written by the formula next to VERSION; optional.
export const BREW_COMMIT_FILE = "COMMIT";

const HEX40 = /^[0-9a-f]{40}$/;

// A path the hub may take as a brew source: absolute, no "..", a directory with VERSION, the CLI and the build script.
export function brewDirProblem(dir) {
  if (typeof dir !== "string" || !dir || !isAbsolute(dir) || dir.split(sep).includes("..")) return "not-absolute";
  try {
    if (!statSync(dir).isDirectory()) return "not-a-directory";
  } catch {
    return "missing";
  }
  for (const f of ["VERSION", join("daemon", "bin", "agenthub"), join("scripts", "build-release.sh")]) {
    if (!existsSync(join(dir, f))) return `no ${f}`;
  }
  return null;
}

// The source tree in brew: → { ok: true, dir, version, commit|null } | { ok: false, why }.
export function readBrewSource(dir) {
  const why = brewDirProblem(dir);
  if (why) return { ok: false, why };
  let version = null;
  try {
    version = parseVersionFile(readFileSync(join(dir, "VERSION"), "utf8"));
  } catch {}
  if (!version) return { ok: false, why: "no VERSION" };
  let commit = null;
  try {
    const c = readFileSync(join(dir, BREW_COMMIT_FILE), "utf8").trim().toLowerCase();
    if (HEX40.test(c)) commit = c;
  } catch {}
  return { ok: true, dir, version, commit };
}

// This CLI runs from a brew keg (<prefix>/Cellar/agent-hub/<version>/libexec — node resolves the bin symlink to the real path):
// → the stable <prefix>/opt/agent-hub/libexec, or null (not from brew, or the opt link leads elsewhere).
export function brewDirOf(repoDir, { exists = existsSync, real = realpathSync } = {}) {
  const m = /^(.+)\/Cellar\/agent-hub\/[^/]+\/libexec\/?$/.exec(String(repoDir || ""));
  if (!m) return null;
  const opt = join(m[1], "opt", BREW_FORMULA, "libexec");
  if (!exists(opt)) return null;
  try {
    return real(opt) === real(repoDir) ? opt : null;
  } catch {
    return null;
  }
}

// services.hubUpdate.brew from a loaded config: the brew source directory or null (git mode).
export function brewSetting(cfg) {
  const v = cfg?.services?.hubUpdate?.brew;
  return typeof v === "string" && v && isAbsolute(v) ? v : null;
}

// The daemon reads the setting fresh from config.json (setup and uninstall write it while the daemon runs), with a cache
// by mtime: info() is called on many events. → (configPath) => dir | null
export function brewSettingReader() {
  let cache = { key: null, value: null };
  return (configPath) => {
    let key = null;
    try {
      const st = statSync(configPath);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      cache = { key: null, value: null };
      return null;
    }
    if (key === cache.key) return cache.value;
    let value = null;
    try {
      value = brewSetting(JSON.parse(readFileSync(configPath, "utf8")));
    } catch {}
    cache = { key, value };
    return value;
  };
}

// Write services.hubUpdate.brew (dir) or remove it (null); the rest of config.json stays. tmp 0600 + rename.
// → true if the file changed.
export function writeBrewSetting(configPath, dir) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
  const cur = brewSetting(cfg);
  const want = dir ? resolve(dir) : null;
  if (cur === want) return false;
  const services = cfg.services && typeof cfg.services === "object" ? cfg.services : (cfg.services = {});
  const hu = services.hubUpdate && typeof services.hubUpdate === "object" ? services.hubUpdate : (services.hubUpdate = {});
  if (want) hu.brew = want;
  else {
    delete hu.brew;
    if (!Object.keys(hu).length) delete services.hubUpdate;
    if (!Object.keys(services).length) delete cfg.services;
  }
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, configPath);
  return true;
}

// Paths not taken from the brew tree into Versions/<label>/src: VCS data, Finder litter and build products (the builder
// makes them again from these sources).
const SKIP_PATHS = new Set([join("app", ".build"), join("app", "build"), join("daemon", "native", "peercred", "build")]);
const SKIP_NAMES = new Set([".git", ".DS_Store", "node_modules"]);
export function brewCopyFilter(root) {
  const base = resolve(root);
  return (src) => {
    const rel = resolve(src).slice(base.length + 1);
    if (!rel) return true;
    if (SKIP_PATHS.has(rel)) return false;
    return !rel.split(sep).some((p) => SKIP_NAMES.has(p));
  };
}
