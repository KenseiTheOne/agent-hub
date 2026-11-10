// A trial run of the new version and the verdict on it (docs/hub-updates.md §3, steps 9–13).
//
// After switching, install.json has phase: trial with deadlineAt. The new daemon writes phase: done when its
// (new) app has opened an event stream. Not reached by deadlineAt — the files are rolled back (restoreFiles from prev),
// the new app's processes are killed, the daemon restarts and the previous version comes up; it closes the install
// as failed (journal and push).
//
// The judge is the watchdog — a separate process of the previous version (`agenthub hub watch`, runWatch below), and if there is none (sleep,
// reboot) — the new daemon's update service at startup (startupVerdict). Confirmation and rollback resolve the race
// via transitionInstall (compare-and-write under HubUpdate/install.lock): trial → done or trial → rolling-back →
// rolled-back, the second transition will not happen. The rollback writes restorePin (the fingerprint of the pin being restored) before rolling back
// the files — by it any daemon accepts the pin returning as expected.

import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { pinFingerprint } from "../app-pin.mjs";
import { msg } from "../i18n.mjs";
import { ensureDir, hubPaths, readJson, versionApp, writeJsonAtomic } from "./layout.mjs";
import { isSnapshot, restoreFiles } from "./switch.mjs";

export const TRIAL_DEFAULTS = Object.freeze({ deadlineMs: 5 * 60_000, pollMs: 2000, restartAfterMs: 20_000 });

export function readInstall(home) {
  const s = readJson(hubPaths(home).install);
  return s && s.v === 1 ? s : null;
}
export function writeInstall(home, s) {
  ensureDir(hubPaths(home).dir);
  writeJsonAtomic(hubPaths(home).install, { v: 1, ...s });
}

// A phase transition between processes (the new daemon, the watchdog, the previous daemon): compare-and-write under the file
// lock HubUpdate/install.lock (O_EXCL). expect: { phase, startedAt } — the transition happens only if install.json
// is still in this phase and it is the same install. patch — an object or a function (st) → object. → the new state or
// null (no longer that phase / another install / the lock could not be taken). A lock older than staleMs is abandoned (the process
// died midway), we remove it.
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
export function transitionInstall(home, expect, patch, { staleMs = 10_000, tries = 50 } = {}) {
  const p = hubPaths(home);
  ensureDir(p.dir);
  let fd = null;
  for (let i = 0; i < tries && fd === null; i++) {
    try {
      fd = openSync(p.lock, "wx", 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(p.lock).mtimeMs > staleMs) rmSync(p.lock, { force: true });
      } catch {}
      Atomics.wait(SLEEP, 0, 0, 20); // a short wait: the lock is held for milliseconds
    }
  }
  if (fd === null) return null;
  try {
    try {
      writeSync(fd, String(process.pid));
    } catch {}
    const st = readInstall(home);
    if (!st || st.phase !== expect.phase || (expect.startedAt !== undefined && st.startedAt !== expect.startedAt)) return null;
    const { v: _v, ...rest } = st;
    const next = { ...rest, ...(typeof patch === "function" ? patch(st) : patch) };
    writeInstall(home, next);
    return next;
  } finally {
    try {
      closeSync(fd);
    } catch {}
    rmSync(p.lock, { force: true });
  }
}

// The fingerprint of the pin the rollback will restore (a "pinned again" push is not needed for it: a "failed" one will come).
export const restorePinOf = (prev) => (isSnapshot(prev) ? pinFingerprint(prev.requirement).label : null);

// What the update service should do when the daemon starts with label self (null — the daemon is not from Versions).
// → "confirm-wait" | "finalize-failed" | "interrupted" | "restore" | null
export function startupVerdict(st, self) {
  if (!st) return null;
  if (st.phase === "trial") {
    if (self && st.label === self) return "confirm-wait";
    return "finalize-failed"; // the previous version came up: the watchdog (or a human) rolled back
  }
  if (st.phase === "rolled-back") return "finalize-failed";
  // built and was waiting for the second click (cards waiting) — again after a daemon restart
  if (st.phase === "building" || st.phase === "ready") return "interrupted";
  // switching or rollback was cut off midway — restore the files from the snapshot (no snapshot — touch nothing)
  if (st.phase === "switching" || st.phase === "rolling-back") return "restore";
  return null;
}

// Rolling back a trial run: files, the new app's processes, a daemon restart. First the transition
// trial → rolling-back (with restorePin) under the lock: confirmation by the new daemon and rollback cannot both happen.
// Then restoreFiles and rolling-back → rolled-back. No prev snapshot — the files are not touched (failed: interrupted).
// killApp(appPath) and restart() are the platform (or doubles). → { ok, errors, skipped? } | null (already confirmed
// or another install).
export async function rollbackTrial({ home, st, why = "trial-timeout", killApp = async () => {}, restart = async () => {}, now = () => new Date(), log = () => {}, configPath } = {}) {
  const snap = isSnapshot(st.prev);
  const claimed = transitionInstall(home, { phase: "trial", startedAt: st.startedAt }, snap ? { phase: "rolling-back", restorePin: restorePinOf(st.prev) } : { phase: "failed", error: "hub-update:interrupted", finishedAt: now().toISOString() });
  if (!claimed) {
    log(msg("hub.watch.noRollback"));
    return null;
  }
  if (!snap) {
    log(msg("hub.watch.noSnapshot"));
    return { ok: false, skipped: true, errors: [{ step: "snapshot", message: msg("hub.detail.snapshot") }] };
  }
  const r = restoreFiles({ home, prev: st.prev, ...(configPath ? { configPath } : {}) });
  transitionInstall(home, { phase: "rolling-back", startedAt: st.startedAt }, { phase: "rolled-back", error: `hub-update:${why}`, restoreErrors: r.errors, finishedAt: now().toISOString() });
  log(msg("hub.watch.rolledBack", { to: st.prev?.current ?? "?", ok: r.ok, errors: JSON.stringify(r.errors) }));
  try {
    await killApp(versionApp(home, st.label));
  } catch (e) {
    log(msg("hub.watch.appProcesses", { why: e.message }));
  }
  try {
    await restart("restart");
  } catch (e) {
    log(msg("hub.watch.restart", { why: e.message }));
  }
  return r;
}

// Watchdog. health() → true if the daemon responds; restart(kind) — "kickstart" (the daemon did not come up by itself) or "restart"
// (after a rollback, kickstart -k). The deadline is taken from install.json on every round: a new daemon that came up after
// the deadline extends it (deadlineExtended). → { result: confirmed | rolled-back | superseded | <phase> | nothing }
export async function runWatch({ home, pollMs = TRIAL_DEFAULTS.pollMs, restartAfterMs = TRIAL_DEFAULTS.restartAfterMs, health = async () => true, restart = async () => {}, killApp = async () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const first = readInstall(home);
  if (!first || first.phase !== "trial") return { result: "nothing" };
  if (!Number.isFinite(Date.parse(first.deadlineAt || ""))) return { result: "nothing" };
  let downSince = null;
  let kicked = false;
  log(msg("hub.watch.waiting", { label: first.label, deadline: first.deadlineAt }));
  for (;;) {
    const st = readInstall(home);
    // another install started or the record disappeared — none of our business
    if (!st || st.label !== first.label || st.startedAt !== first.startedAt) return { result: "superseded" };
    if (st.phase === "done") {
      log(msg("hub.watch.confirmed", { label: st.label }));
      return { result: "confirmed" };
    }
    if (st.phase !== "trial") return { result: st.phase };
    const deadline = Date.parse(st.deadlineAt || "");
    const t = now();
    if (Number.isFinite(deadline) && t >= deadline) {
      log(msg("hub.watch.expired", { label: st.label }));
      const r = await rollbackTrial({ home, st, why: "trial-timeout", killApp, restart, now: () => new Date(now()), log });
      if (r === null) {
        const again = readInstall(home);
        return { result: again?.phase === "done" ? "confirmed" : again?.phase || "superseded" };
      }
      return { result: "rolled-back" };
    }
    let up = false;
    try {
      up = await health();
    } catch {}
    if (up) downSince = null;
    else {
      downSince ??= t;
      // launchd did not bring the daemon up after it exited with code 75 — bring it up ourselves (without -k: a live one is left alone)
      if (!kicked && t - downSince >= restartAfterMs) {
        kicked = true;
        log(msg("hub.watch.kickstart"));
        try {
          await restart("kickstart");
        } catch (e) {
          log(`kickstart: ${e.message}`);
        }
      }
    }
    await sleep(pollMs);
  }
}
