// State files of the hub (<home>/*.json): one place for reading, writing and locking them.
//
//  - readJsonFile: JSON a human may edit (BOM-aware).
//  - writeFileAtomic / writeJsonAtomic: a temp file in the same directory + rename; the file's mode is preserved (a new file is
//    0600) unless the caller names one. A reader never sees a half-written file.
//  - withFileLock: a cross-process lock (a lock file created exclusively, holding the owner's pid). Synchronous: held for
//    milliseconds around a read-modify-write.
//  - updateConfig: read-modify-write of config.json under that lock. Several processes write this file (the daemon, the CLI,
//    the hub-update builder and watchdog); without the lock two of them would each write back what they read and one change
//    would be lost.
//  - loadStateJson: a tolerant read for the daemon — a broken or empty file is not silently replaced by defaults: a copy is
//    kept next to it (<file>.bad) and the caller gets a "damaged" record to journal and to show in /state.

import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { msg } from "./i18n.mjs";

// JSON that a human edits by hand (config.json, settings.json). Editors also write UTF-8 with a BOM (VS Code "UTF-8
// with BOM", PowerShell 5.1 Set-Content): the BOM is stripped. UTF-16 (BOM FF FE / FE FF) is not parsed, but we say so plainly.
export function readJsonFile(path) {
  const buf = readFileSync(path);
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) throw new Error(msg("err.json.utf16"));
  const text = buf.toString("utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

// ---------- atomic write ----------

// The temp name next to the file: `<file>.tmp-<pid>`. One process writes one file at a time (the write is synchronous), and
// other processes have other pids. AppPinWatcher (lib/app-pin.mjs) and `agenthub uninstall --purge` know this name pattern.
export const tempPathFor = (path) => `${path}.tmp-${process.pid}`;

// Write a whole file atomically. mode: a number — set exactly; not given — the existing file's mode is kept, a new file gets
// 0600. mkdir: create the directory (0700) first. The temp file is removed if anything fails; the error is thrown.
export function writeFileAtomic(path, data, { mode = null, mkdir = false } = {}) {
  if (mkdir) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let finalMode = mode;
  if (finalMode === null) {
    try {
      finalMode = statSync(path).mode & 0o777;
    } catch {
      finalMode = 0o600;
    }
  }
  const tmp = tempPathFor(path);
  try {
    writeFileSync(tmp, data, { mode: finalMode });
    // writeFileSync applies the mode only when it creates the file, and through the umask
    chmodSync(tmp, finalMode);
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

// The same for a JSON value. space — JSON.stringify indentation (2 for files a human reads).
export function writeJsonAtomic(path, value, { mode = null, mkdir = false, space = 0 } = {}) {
  writeFileAtomic(path, JSON.stringify(value, null, space || undefined) + "\n", { mode, mkdir });
}

// ---------- cross-process lock ----------

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SLEEP, 0, 0, ms);

// Is the process alive? EPERM — it exists under another user.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// Create the lock file with its content in one step: a hard link to a finished temp file either appears whole or fails with
// EEXIST. Where hard links are not available — O_EXCL and a write (a reader may see it empty for a moment; readLock treats an
// empty lock as "just taken"). → true | false (someone holds it); other errors are thrown.
export function createLockFile(lockPath, text) {
  const tmp = `${lockPath}.new-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    try {
      linkSync(tmp, lockPath);
      return true;
    } catch (e) {
      if (e.code === "EEXIST") return false;
    }
  } catch {
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

// → { text, ageMs } | null (no lock file)
export function readLock(lockPath) {
  try {
    const st = statSync(lockPath);
    return { text: readFileSync(lockPath, "utf8"), ageMs: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}

// Remove a lock its owner abandoned. Two processes may both decide "stale" at once, and the slower one would then delete the
// lock the faster one has just taken — so the removal goes through a short mutex (mkdir is atomic) and the lock is read again
// inside it. A mutex directory left by a process that died right here is removed after BREAK_STALE_MS. → true if removed.
const BREAK_STALE_MS = 5000;
export function breakStaleLock(lockPath, isStale) {
  const guard = `${lockPath}.break`;
  try {
    mkdirSync(guard, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST") {
      try {
        if (Date.now() - statSync(guard).mtimeMs > BREAK_STALE_MS) rmdirSync(guard);
      } catch {}
    }
    return false;
  }
  try {
    const cur = readLock(lockPath);
    if (!cur) return true;
    if (!isStale(cur)) return false;
    rmSync(lockPath, { force: true });
    return true;
  } finally {
    try {
      rmdirSync(guard);
    } catch {}
  }
}

// Release: only our own lock (the content is still what we wrote).
export function releaseLockFile(lockPath, text) {
  try {
    if (readFileSync(lockPath, "utf8") === text) rmSync(lockPath, { force: true });
  } catch {}
}

// Run fn() holding <lockPath>. The owner's pid is in the file: a lock whose owner is gone, or one older than staleMs (these
// locks are held for milliseconds), is abandoned and removed. Waits up to waitMs, then throws (code "ELOCKED").
export function withFileLock(lockPath, fn, { waitMs = 5000, staleMs = 30_000, stepMs = 10 } = {}) {
  const text = `${process.pid}\n`;
  const isStale = (cur) => {
    const pid = Number.parseInt(cur.text, 10);
    if (cur.ageMs > staleMs) return true;
    // an empty file: being written right now (the O_EXCL fallback)
    if (!Number.isInteger(pid)) return false;
    return !pidAlive(pid);
  };
  const until = Date.now() + waitMs;
  for (;;) {
    if (createLockFile(lockPath, text)) break;
    const cur = readLock(lockPath);
    if (cur && isStale(cur) && breakStaleLock(lockPath, isStale)) continue;
    if (Date.now() >= until) throw Object.assign(new Error(msg("err.file.locked", { file: basename(lockPath) })), { code: "ELOCKED" });
    sleepSync(stepMs);
  }
  try {
    return fn();
  } finally {
    releaseLockFile(lockPath, text);
  }
}

// ---------- config.json ----------

export const configLockPath = (configPath) => `${configPath}.lock`;

// Read-modify-write of config.json under the cross-process lock. fn(cfg) changes the object in place or returns a new one;
// returning false means "nothing to write" (the file is left untouched). A missing file is an empty config (missing: "throw" —
// the caller needs the file to exist). A config.json that cannot be parsed is never overwritten: err.config.parseKeep.
// → { written, cfg } (cfg — what is in the file now).
export function updateConfig(configPath, fn, { missing = "empty", lock = {} } = {}) {
  // missing: "throw" on a file that is not there creates nothing (no directory, no lock)
  if (missing === "throw" && !existsSync(configPath)) {
    try {
      readJsonFile(configPath);
    } catch (e) {
      throw new Error(msg("err.config.parseKeep", { why: e.message }));
    }
  }
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  return withFileLock(
    configLockPath(configPath),
    () => {
      let cfg = {};
      if (existsSync(configPath) || missing === "throw") {
        try {
          cfg = readJsonFile(configPath);
        } catch (e) {
          throw new Error(msg("err.config.parseKeep", { why: e.message }));
        }
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(msg("err.config.parseKeep", { why: msg("err.json.notObject") }));
      }
      const r = fn(cfg);
      if (r === false) return { written: false, cfg };
      const next = r && typeof r === "object" ? r : cfg;
      writeJsonAtomic(configPath, next, { mode: 0o600, space: 2 });
      return { written: true, cfg: next };
    },
    lock,
  );
}

// ---------- tolerant load ----------

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// Read a state file the daemon can live without. → { value, damaged }:
//   no file            → { value: undefined, damaged: null }
//   parsed, an object  → { value, damaged: null }
//   broken / empty / not an object → { value: undefined, damaged: { file, backup, detail, at } }; with keepBad the file's bytes
//   are copied to <file>.bad (0600, the previous copy is replaced) — the file itself stays where it is: its owner decides
//   whether to rewrite it (settings, jobs) or to leave it for a human to fix (config.json).
// Never throws.
export function loadStateJson(path, { keepBad = true, now = () => new Date() } = {}) {
  let value;
  try {
    if (!existsSync(path)) return { value: undefined, damaged: null };
    value = readJsonFile(path);
    if (!isObj(value)) throw new Error(msg("err.json.notObject"));
    return { value, damaged: null };
  } catch (e) {
    if (e?.code === "ENOENT") return { value: undefined, damaged: null };
    let backup = null;
    if (keepBad) {
      try {
        copyFileSync(path, `${path}.bad`);
        chmodSync(`${path}.bad`, 0o600);
        backup = `${basename(path)}.bad`;
      } catch {}
    }
    return { value: undefined, damaged: { file: basename(path), backup, detail: String(e?.message || e).slice(0, 200), at: now().toISOString() } };
  }
}
