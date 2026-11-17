// One daemon per state directory.
//
// A second daemon started on a home that already has one must not run core.init(): init reaps "orphan" jobs (they are the
// live daemon's jobs), rewrites jobs.json and finishes "interrupted" hub updates (a build that is running right now). So the
// daemon claims the home BEFORE it loads or writes anything (bin/agenthubd):
//
//   1. <home>/daemon.lock — created exclusively, holds {pid, startSec, lstart}. The holder is alive when that pid exists with
//      the same start time (a pid reused by another process after a crash or a reboot is not the daemon). A lock whose
//      holder is gone is removed and taken (lib/statefile.mjs breakStaleLock: two starters cannot both take it).
//   2. the transport — a daemon that does not write the lock (an older version) may still be listening: a live socket is
//      also a refusal.
//
// The lock is released on a regular exit; after SIGKILL the file stays and the next start finds its holder gone.
// With the home claimed, lib/server.mjs prepareSocket may remove a dead socket file safely: nobody else is between its
// "is it alive" probe and the unlink.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { loadNative } from "./native.mjs";
import { processStartCommand, transportPath } from "./platform.mjs";
import { breakStaleLock, createLockFile, pidAlive, readLock, releaseLockFile } from "./statefile.mjs";

export const instanceLockPath = (home) => join(home, "daemon.lock");

// When a process started, from two independent sources: the peercred addon (seconds) and the system process list (text).
// → { startSec: number | null, lstart: string | null }
export function processStartKey(pid, { native = loadNative(), exec = execFileSync, platform = process.platform } = {}) {
  let startSec = null;
  let lstart = null;
  try {
    const info = native?.pidInfo?.(pid);
    if (Number.isFinite(info?.startSec)) startSec = info.startSec;
  } catch {}
  try {
    const opts = { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } };
    const [file, ...args] = processStartCommand(pid, { platform });
    const out = exec(file, args, opts);
    lstart = String(out).trim().replace(/\s+/g, " ") || null;
  } catch {}
  return { startSec, lstart };
}

function parseRecord(text) {
  try {
    const r = JSON.parse(text);
    return r && Number.isInteger(r.pid) && r.pid > 0 ? r : null;
  } catch {
    return null;
  }
}

// Is the process that wrote the lock still there? Unknown start times on either side — yes while the pid is alive (refusing
// to start is the safe side).
function holderGone(rec, { alive, startKey }) {
  if (!alive(rec.pid)) return true;
  const now = startKey(rec.pid);
  if (Number.isFinite(rec.startSec) && Number.isFinite(now.startSec)) return rec.startSec !== now.startSec;
  if (typeof rec.lstart === "string" && rec.lstart && now.lstart) return rec.lstart !== now.lstart;
  return false;
}

// Take <home>/daemon.lock. → { ok: true, release() } | { ok: false, pid } (a live daemon holds it; pid — its pid or null).
// Synchronous. tries — how many times to retry after removing a dead holder's lock or meeting a half-written one.
export function acquireInstanceLock(home, { pid = process.pid, alive = pidAlive, startKey = processStartKey, tries = 20 } = {}) {
  const lockPath = instanceLockPath(home);
  const text = JSON.stringify({ pid, ...startKey(pid), at: new Date().toISOString() }) + "\n";
  // a lock without a readable record is being written right now; one that stays unreadable was abandoned
  const isStale = (cur) => {
    const rec = parseRecord(cur.text);
    return rec ? holderGone(rec, { alive, startKey }) : cur.ageMs > 2000;
  };
  let holder = null;
  for (let i = 0; i < tries; i++) {
    if (createLockFile(lockPath, text)) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseLockFile(lockPath, text);
      };
      return { ok: true, release, path: lockPath };
    }
    const cur = readLock(lockPath);
    if (!cur) continue;
    const rec = parseRecord(cur.text);
    holder = rec?.pid ?? null;
    if (isStale(cur)) {
      if (breakStaleLock(lockPath, isStale)) continue;
    } else if (rec) break; // a live daemon
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return { ok: false, pid: holder };
}

// Does anything accept connections on the transport address (a Unix socket or a named pipe)?
export function transportAlive(path, { timeoutMs = 2000 } = {}) {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c.destroy();
      res(v);
    };
    const c = connect(path);
    const timer = setTimeout(() => finish(false), timeoutMs);
    c.once("connect", () => finish(true));
    c.once("error", () => finish(false));
  });
}

// Claim the state directory for this daemon process (see the top of the file). Creates the directory (0700) if needed and
// touches nothing else in it. → { ok: true, release() } | { ok: false, reason: "lock" | "socket", pid }
export async function claimHome(home, { socket = transportPath(home), lock = {} } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const l = acquireInstanceLock(home, lock);
  if (!l.ok) return { ok: false, reason: "lock", pid: l.pid };
  if (await transportAlive(socket)) {
    l.release();
    return { ok: false, reason: "socket", pid: null };
  }
  return l;
}
