// Layout of the standalone hub installation (docs/hub-updates.md §1): <home>/Versions/<label>/{src, AgentHub.app,
// build.json}, the pointer is the Versions/current symlink (plus the informational Versions/previous), update state —
// <home>/HubUpdate/{check.json, install.json}.
//
// Switching the pointer is atomic: symlink(<label>, current.tmp-…) + rename(current.tmp-…, current). A version
// directory appears whole: the build goes into Versions/.staging-<label>-<rnd>, the finished result is moved with rename.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, isLabel } from "../version.mjs";
import { msg } from "../i18n.mjs";

export function hubPaths(home) {
  const versions = join(home, "Versions");
  const dir = join(home, "HubUpdate");
  return {
    home,
    versions,
    current: join(versions, "current"),
    previous: join(versions, "previous"),
    dir,
    check: join(dir, "check.json"),
    install: join(dir, "install.json"),
    lock: join(dir, "install.lock"),
    history: join(dir, "history.json"),
    logs: join(home, "logs"),
    config: join(home, "config.json"),
  };
}

export const versionDir = (home, label) => join(hubPaths(home).versions, label);
export const versionSrc = (home, label) => join(versionDir(home, label), "src");
export const versionApp = (home, label) => join(versionDir(home, label), "AgentHub.app");
export const versionPlugins = (home, label) => join(versionSrc(home, label), "plugins");
// The daemon via the pointer: these paths are written into the plist (launchd resolves the symlink on every start).
export const stableDaemon = (home) => join(hubPaths(home).current, "src", "daemon", "bin", "agenthubd");
export const stableRepo = (home) => join(hubPaths(home).current, "src");

export function ensureDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    chmodSync(p, 0o700);
  } catch {}
  return p;
}

export function readJson(path) {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// A 0600 temp file alongside + rename.
export function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {}
  renameSync(tmp, path);
}

// Pointer symlink target → a label or null (no link, not a label, no version directory).
export function readLink(link) {
  let t;
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    t = readlinkSync(link);
  } catch {
    return null;
  }
  if (!isLabel(t)) return null;
  try {
    if (!lstatSync(join(link, "..", t)).isDirectory()) return null;
  } catch {
    return null;
  }
  return t;
}

// Atomically point the pointer (current / previous) at a label; null — remove the pointer.
export function setLink(link, label) {
  if (label === null || label === undefined) {
    rmSync(link, { force: true });
    return;
  }
  if (!isLabel(label)) throw new Error(msg("hub.detail.notLabel", { label }));
  const tmp = `${link}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  symlinkSync(label, tmp);
  try {
    renameSync(tmp, link);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export const currentLabel = (home) => readLink(hubPaths(home).current);
export const previousLabel = (home) => readLink(hubPaths(home).previous);

export function readBuild(home, label) {
  if (!isLabel(label)) return null;
  const b = readJson(join(versionDir(home, label), "build.json"));
  return b && b.label === label ? b : null;
}

// Built versions (directories with build.json), newest first.
export function listVersions(home) {
  let names = [];
  try {
    names = readdirSync(hubPaths(home).versions);
  } catch {
    return [];
  }
  return names
    .filter((n) => isLabel(n) && readBuild(home, n))
    .sort((a, b) => -(compareVersions(a, b) ?? 0) || (a < b ? 1 : -1));
}

// Remove extra versions: current, previous and the newest up to keep in total remain; drop — labels that didn't
// pass installation (didn't come up in the trial run, failed the check), we don't keep them for keep. staging/trash — if
// nothing is being built (busy = false). Build logs (logs/hub-update-<label>-<time>.log): besides the current and
// previous logs, the logKeep newest ones no older than logMaxAgeMs remain; the watchdog log is trimmed to the last
// watchLogMax bytes. → removed labels.
export const PRUNE_DEFAULTS = Object.freeze({ keep: 3, logKeep: 10, logMaxAgeMs: 30 * 24 * 3600_000, watchLogMax: 256 * 1024 });
export function prune(home, { keep = PRUNE_DEFAULTS.keep, busy = false, drop = [], logKeep = PRUNE_DEFAULTS.logKeep, logMaxAgeMs = PRUNE_DEFAULTS.logMaxAgeMs, watchLogMax = PRUNE_DEFAULTS.watchLogMax, now = Date.now() } = {}) {
  const p = hubPaths(home);
  const cur = currentLabel(home);
  const prev = previousLabel(home);
  const dropSet = new Set((drop || []).filter((l) => isLabel(l) && l !== cur && l !== prev));
  const all = listVersions(home);
  const stay = new Set([cur, prev].filter(Boolean));
  for (const l of all) if (stay.size < Math.max(2, keep) && !dropSet.has(l)) stay.add(l);
  const removed = [];
  for (const l of all) {
    if (stay.has(l)) continue;
    rmSync(versionDir(home, l), { recursive: true, force: true });
    removed.push(l);
  }
  // a directory without build.json (unfinished, broken) with a label from drop
  for (const l of dropSet) {
    if (removed.includes(l) || stay.has(l) || !existsSync(versionDir(home, l))) continue;
    rmSync(versionDir(home, l), { recursive: true, force: true });
    removed.push(l);
  }
  if (!busy) {
    let names = [];
    try {
      names = readdirSync(p.versions);
    } catch {}
    for (const n of names) if (n.startsWith(".staging-") || n.startsWith(".trash-")) rmSync(join(p.versions, n), { recursive: true, force: true });
  }
  pruneLogs(home, { keepLabels: [cur, prev].filter(Boolean), logKeep, logMaxAgeMs, watchLogMax, now, busy });
  return removed;
}

// Build and watchdog logs (see prune). The log of an ongoing build (busy) is left alone: it's the newest and not old.
export function pruneLogs(home, { keepLabels = [], logKeep = PRUNE_DEFAULTS.logKeep, logMaxAgeMs = PRUNE_DEFAULTS.logMaxAgeMs, watchLogMax = PRUNE_DEFAULTS.watchLogMax, now = Date.now() } = {}) {
  const logs = hubPaths(home).logs;
  const keepPaths = new Set();
  for (const l of keepLabels) {
    const b = readBuild(home, l);
    if (typeof b?.log === "string") keepPaths.add(b.log);
  }
  let names = [];
  try {
    names = readdirSync(logs);
  } catch {
    return [];
  }
  const builds = [];
  for (const n of names) {
    if (!/^hub-update-.+-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.log$/.test(n)) continue;
    const path = join(logs, n);
    try {
      builds.push({ path, mtime: statSync(path).mtimeMs });
    } catch {}
  }
  builds.sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  builds.forEach((f, i) => {
    if (keepPaths.has(f.path)) return;
    if (i < logKeep && now - f.mtime <= logMaxAgeMs) return;
    rmSync(f.path, { force: true });
    removed.push(f.path);
  });
  // the watchdog log is appended on every install — keep the tail
  const watch = join(logs, "hub-update-watch.log");
  try {
    const st = statSync(watch);
    if (st.size > watchLogMax) {
      const buf = readFileSync(watch);
      const tail = buf.subarray(buf.length - Math.floor(watchLogMax / 2));
      const nl = tail.indexOf(10);
      writeFileSync(watch, nl >= 0 ? tail.subarray(nl + 1) : tail, { mode: 0o600 });
    }
  } catch {}
  return removed;
}

// Free space on the directory's volume (bytes) or null — can't tell.
export function freeBytes(path) {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// History of pins the hub set itself (HubUpdate/history.json): label → {cdhash, commit, at, op}. Rollback
// pins only a build whose cdhash the hub recorded when it installed this label (or the one it left when switching).
// This is a tripwire, not a protection (the same UID can rewrite this file too): swapping the build in Versions/<label> and its
// build.json is no longer enough.
export function readHistory(home) {
  const h = readJson(hubPaths(home).history);
  return h && h.v === 1 && h.labels && typeof h.labels === "object" && !Array.isArray(h.labels) ? h : { v: 1, labels: {} };
}
export function rememberPin(home, label, { cdhash, commit = null, op = null } = {}) {
  if (!isLabel(label) || !/^[0-9a-f]{40}$/.test(String(cdhash || ""))) return false;
  const h = readHistory(home);
  const was = h.labels[label];
  if (was && was.cdhash === cdhash) return false;
  h.labels[label] = { cdhash, commit: /^[0-9a-f]{40}$/.test(String(commit || "")) ? commit : null, op, at: new Date().toISOString(), ...(was && was.cdhash !== cdhash ? { replaced: was.cdhash } : {}) };
  // at most 50 labels
  const keys = Object.keys(h.labels);
  if (keys.length > 50) {
    keys.sort((a, b) => String(h.labels[a].at).localeCompare(String(h.labels[b].at)));
    for (const k of keys.slice(0, keys.length - 50)) delete h.labels[k];
  }
  ensureDir(hubPaths(home).dir);
  writeJsonAtomic(hubPaths(home).history, h);
  return true;
}
// Snapshot before switching (switch.mjs capturePrev): the pin we're leaving is the build that ran at
// prev.current. Record it in the history if that label isn't there yet (installs predating history.json).
export function rememberPrevious(home, prev) {
  const m = /^identifier "com\.kensei\.agenthub" and cdhash H"([0-9a-f]{40})"$/.exec(String(prev?.requirement || ""));
  if (!m || !isLabel(prev?.current) || pinnedCdhash(home, prev.current)) return false;
  return rememberPin(home, prev.current, { cdhash: m[1], op: "previous" });
}
export const pinnedCdhash = (home, label) => {
  const e = readHistory(home).labels[label];
  return e && /^[0-9a-f]{40}$/.test(String(e.cdhash || "")) ? e.cdhash : null;
};

// Build directory of a new version (Versions/.staging-<label>-<rnd>).
export function stagingDir(home, label) {
  ensureDir(hubPaths(home).versions);
  const d = join(hubPaths(home).versions, `.staging-${label}-${randomBytes(4).toString("hex")}`);
  ensureDir(d);
  return d;
}

// Move the finished build into Versions/<label>. If a directory for that version already exists (an interrupted or old build),
// it goes to .trash-… and is deleted; the current version is never replaced.
export function promoteStaging(home, staging, label) {
  const dest = versionDir(home, label);
  if (currentLabel(home) === label) throw Object.assign(new Error(msg("hub.detail.isCurrent")), { code: "hub-update:is-current" });
  let trash = null;
  if (existsSync(dest)) {
    trash = join(hubPaths(home).versions, `.trash-${label}-${randomBytes(4).toString("hex")}`);
    renameSync(dest, trash);
  }
  renameSync(staging, dest);
  if (trash) rmSync(trash, { recursive: true, force: true });
  return dest;
}
