// Daemon supervision of the app (the app service, lib/services/app.mjs) — the portable part, platform-free.
//
// The user's logic (decision 2026-11-06): "If the hub is dead but the daemon is alive, the daemon restores the hub. Closing the hub closes
// the daemon too."
//   - The app quit normally: it asks the daemon to exit itself (POST /shutdown) — supervision does not interfere
//     (stopping() = true, the service stops together with the daemon).
//   - The last connection of the pinned app is gone and its process no longer exists → after restartDelayMs
//     (a couple of seconds: do not race a rebuild or a manual restart) we look again: there is an app connection or a
//     process at the pinned build's path — do nothing; there is not — launch the app.
//   - The daemon started (login, kickstart) → after restartDelayMs: no app — launch it. Started
//     at the app's own request — the process is already there, do nothing.
//   - After every launch, after verifyMs we check that the app is alive (a connection or a process). If not, that is
//     the same crash: the next restart.
//   - The connection closed but the process is alive (stream dropped, re-pin) — wait for a reconnect, but after
//     verifyMs look again ("lost-later"): the process disappeared without ever connecting — that is a crash. While the process
//     exists without a connection, the check repeats every verifyMs: otherwise nobody would learn of its death.
//   - Restarts after a crash — no more than maxRestarts per windowMs (3 per 10 min); after that — stop, the
//     app-restart-stopped record (also in the audit journal) and the app.restart-stopped event → a push "Agent Hub keeps crashing —
//     restart stopped". If a human launched the app and it opened an event stream (/events), supervision
//     is in force again with a clean window. Short connections (`--probe-peer`: a request and exit) do not lift the stop.
//   - "Launch at login" is off (settings.json → launchAtLogin, decision 2026-11-07): a daemon started at login
//     (launchd RunAtLoad) does not launch the app. How to tell a login from a kickstart requested by
//     the app: after restartDelayMs we check whether the app is there (an app-class connection, a process at the
//     pinned build's path, any open event stream — an unpinned copy holds one too). If so, the daemon was
//     started for it, we stay. If not, we wait up to loginGraceMs from start (the app waits for the socket up to 10 s after
//     kickstart) and look again; still nothing — the app-login-gate decision=exit record and a normal exit with code 0
//     (launchd with KeepAlive.SuccessfulExit=false does not restart it). Exception — a daemon start awaited by
//     a hub update (a trial run of the new version, a rollback to the previous one: expectApp()): the app is launched as
//     if the setting were on. Restoring a crashed app works with any setting.
//     ps did not answer (unknown) — we will not exit blindly: retry after verifyMs, but no later than loginGraceMs from start;
//     if it still has not answered by the deadline — decide by connections and event streams (none — exit).
//     The LaunchAgent is old (launchAgent() = "outdated": KeepAlive true, a plist from before 2026-11-06) — we do not exit: launchd would bring
//     the daemon back after 10 s, and so on for the whole session. The app-login-gate decision=stay why=launch-agent-outdated record and
//     the warning "reinstall the LaunchAgent: agenthub install --apply"; the shell disables the toggle.
//   - A skip for a reason that may clear on its own (ps did not answer — unknown; the bundle is being rebuilt — pin-mismatch,
//     path-missing; codesign did not finish in time — verify-error) is retried after verifyMs, no more than maxRestarts times
//     per windowMs; after that — the same stop (app-restart-stopped with why).
//
// The platform (finding the process, launching, checking the bundle signature) — the appControl adapter from lib/platform.mjs.
// Time and timers are replaced in tests.

import { msg } from "./i18n.mjs";

export const SUPERVISE_DEFAULTS = Object.freeze({
  supervise: true,
  restartDelayMs: 2000,
  verifyMs: 15_000,
  maxRestarts: 3,
  windowMs: 10 * 60_000,
  // "Launch at login" is off: how long after the daemon start to wait for the app before exiting
  loginGraceMs: 30_000,
});

function num(v, d, min = 0) {
  return Number.isFinite(v) && v >= min ? v : d;
}

export function superviseOptions(raw = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    supervise: o.supervise !== false,
    restartDelayMs: num(o.restartDelayMs, SUPERVISE_DEFAULTS.restartDelayMs),
    verifyMs: num(o.verifyMs, SUPERVISE_DEFAULTS.verifyMs, 1),
    maxRestarts: Math.floor(num(o.maxRestarts, SUPERVISE_DEFAULTS.maxRestarts, 1)),
    windowMs: num(o.windowMs, SUPERVISE_DEFAULTS.windowMs, 1),
    loginGraceMs: num(o.loginGraceMs, SUPERVISE_DEFAULTS.loginGraceMs, 1),
  };
}

// Skip reasons after which the check is retried (they may clear on their own).
export const RETRY_WHY = new Set(["unknown", "pin-mismatch", "verify-error", "path-missing", "path-unsafe"]);

export class AppSupervisor {
  // adapter: { processes(path) → Promise<pid[] | null>, launch(path) → Promise<{ok, code?, skipped?}>,
  //            verify(path, requirement) → Promise<true | false | null> }
  // pinned(): { path, requirement } | { why } — the pinned build's path and the effective requirement.
  // connections(): live app-class connections ([{pid, startSec, path}]).
  // launchAtLogin() → bool — the "Launch at login" setting; streams() → number of open event streams (any class);
  // expectApp() → bool — a daemon start awaited by a hub update (launch the app regardless of the setting);
  // exit(reason) — stop the daemon normally (code 0); launchAgent() → "ok" | "outdated" | "missing" | "unknown" | null —
  // the daemon job's KeepAlive (lib/launchd.mjs launchAgentState).
  constructor({ adapter, pinned, connections, stopping = () => false, journal = () => {}, emit = () => {}, options = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, launchAtLogin = () => true, streams = () => 0, expectApp = () => false, exit = () => {}, launchAgent = () => null }) {
    this.adapter = adapter;
    this.launchAgent = launchAgent;
    this.pinned = pinned;
    this.connections = connections;
    this.launchAtLogin = launchAtLogin;
    this.streams = streams;
    this.expectApp = expectApp;
    this.exit = exit;
    this.stopping = stopping;
    this.journal = journal;
    this.emit = emit;
    this.opts = superviseOptions(options);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.pendingReason = null;
    this.restarts = []; // timestamps of restarts after a crash (within windowMs)
    this.retries = []; // check retries after a temporary skip (within windowMs)
    this.limited = false; // limit exhausted — do not launch until the app connects
    this.limitedWhy = null; // a stop caused by a recurring skip (why), not by crashes
    this.closed = false;
    this.skippedWhy = null; // last skip reason — so the same thing is not written on every check
    this.checking = null; // Promise of the current check (tests await it)
    this.startedAt = null; // service start — loginGraceMs is counted from it
  }

  start() {
    this.startedAt = this.now();
    // without supervision the app is not launched, but "Launch at login" being off still applies
    if (!this.opts.supervise && this.launchAtLoginOn()) return;
    this.schedule("start", this.opts.restartDelayMs);
  }

  launchAtLoginOn() {
    try {
      return this.launchAtLogin() !== false;
    } catch {
      return true;
    }
  }
  appExpected() {
    try {
      return this.expectApp() === true;
    } catch {
      return false;
    }
  }

  stop() {
    this.closed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  // Core event app.peer: {connected, stream?, pid, startSec?, alive?, count}. stream — the connection opened
  // an event stream (GET /events): that is how the real app keeps in touch, unlike a one-off request.
  onPeer(ev) {
    if (this.closed || !this.opts.supervise || !ev) return;
    if (ev.connected) {
      if (!ev.stream) return; // a one-off request (--probe-peer) — not "a human opened the app"
      this.retries = [];
      // a human (or we) launched the app and it holds a stream: supervision is in force again, the window starts clean
      // (otherwise the very first crash in the old window would stop immediately without a single restart)
      if (this.limited) {
        this.limited = false;
        this.limitedWhy = null;
        this.restarts = [];
        this.journal({ type: "app-supervise-resumed", pid: ev.pid ?? null });
      }
      return;
    }
    if (ev.count > 0) return; // another app connection remains (request pool, a second stream)
    if (this.stopping()) return;
    if (ev.alive) {
      // the process is alive: the connection will reconnect (re-pin, dropped stream). If it does not and the process
      // disappears — the deferred check will notice
      this.schedule("lost-later", this.opts.verifyMs);
      return;
    }
    this.journal({ type: "app-lost", pid: ev.pid ?? null });
    this.schedule("lost", this.opts.restartDelayMs);
  }

  schedule(reason, ms) {
    if (this.closed) return;
    // already waiting for a check: the "lost" reason outranks "start"/"verify" — it counts toward the limit
    if (this.timer) {
      if (reason !== "lost" || this.pendingReason === "lost") return;
      this.clearTimer(this.timer);
    }
    this.pendingReason = reason;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.pendingReason = null;
      // checks run one at a time: the second waits for the first to finish (otherwise two in parallel would launch the app twice)
      const prev = this.checking || Promise.resolve();
      this.checking = prev.then(() => this.check(reason)).catch((e) => this.journal({ type: "app-supervise-error", reason, detail: String(e?.message || e).slice(0, 200) }));
    }, ms);
    this.timer?.unref?.();
  }

  skip(reason, why, extra = {}) {
    if (this.skippedWhy === why && why !== "running" && why !== "connected") return;
    this.skippedWhy = why;
    this.journal({ type: "app-launch-skipped", reason, why, ...extra });
  }

  // Whether the app is there: an app-class connection or a process at the pinned build's path.
  async present(path) {
    if (this.connections().length > 0) return "connected";
    if (!path) return null;
    const pids = await this.adapter.processes(path);
    if (pids === null) return "unknown"; // could not read the process table — we will not launch blindly
    return pids.length ? "running" : null;
  }

  // A skip that may clear on its own: record it and retry the check after verifyMs (no more than maxRestarts times per
  // windowMs, after that — a stop with why). again — the reason to retry with.
  skipRetry(reason, why, extra = {}, again = reason) {
    this.skip(reason, why, extra);
    if (this.limited) return;
    const t = this.now();
    this.retries = this.retries.filter((x) => t - x < this.opts.windowMs);
    if (this.retries.length >= this.opts.maxRestarts) return this.giveUp(why);
    this.retries.push(t);
    this.schedule(again, this.opts.verifyMs);
  }

  // Daemon start with "Launch at login" off: started by the app — stay; at login —
  // wait for the app up to loginGraceMs and exit.
  async loginGate(reason, pin) {
    let here = await this.present(pin?.path);
    if (this.closed || this.stopping()) return;
    if ((!here || here === "unknown") && this.streams() > 0) here = "stream";
    const left = this.opts.loginGraceMs - (this.now() - (this.startedAt ?? this.now()));
    if (here === "unknown") {
      // ps did not answer — we will not exit blindly (the app may be there): retry until the deadline; at the deadline — decide by
      // connections and streams (none — exit below)
      if (left > 0) {
        this.journal({ type: "app-login-gate", decision: "retry", why: "unknown", ms: Math.min(this.opts.verifyMs, left) });
        return this.schedule("login-gate", Math.min(this.opts.verifyMs, left));
      }
      here = null;
    }
    if (here) {
      this.journal({ type: "app-login-gate", decision: "stay", why: here });
      if (here === "running" && this.opts.supervise) this.schedule("lost-later", this.opts.verifyMs);
      return;
    }
    // before the deadline — wait (also after a retry due to unknown: the app may still come)
    if (left > 0) {
      this.journal({ type: "app-login-gate", decision: "wait", ms: left });
      return this.schedule("login-gate", left);
    }
    let agent = null;
    try {
      agent = this.launchAgent();
    } catch {}
    if (agent === "outdated") {
      // KeepAlive true: launchd would bring the daemon back after 10 s — exiting would loop for the whole session
      this.journal({ type: "app-login-gate", decision: "stay", why: "launch-agent-outdated" });
      this.journal({ type: "warning", detail: msg("warn.launchAgentOutdated") });
      return;
    }
    this.journal({ type: "app-login-gate", decision: "exit", waitedMs: this.now() - (this.startedAt ?? this.now()) });
    this.closed = true;
    this.exit("login-off");
  }

  async check(reason) {
    if (this.closed || this.stopping()) return;
    const pin = this.pinned();
    if ((reason === "start" || reason === "login-gate") && !this.launchAtLoginOn() && !this.appExpected()) return this.loginGate(reason, pin);
    // the setting was turned on while the daemon was waiting; without supervision the app is not launched
    if (!this.opts.supervise) return;
    const here = await this.present(pin?.path);
    if (this.closed || this.stopping()) return;
    // could not read the process table — we will not launch blindly, but we do not give up either: retry
    if (here === "unknown") return this.skipRetry(reason, here);
    if (here) {
      // came back on its own within the delay window or started together with the daemon — do nothing
      if (reason === "lost") this.skip(reason, here);
      // there is a process but no connection (not connected yet or reconnecting): if it dies without ever connecting,
      // nobody would notice without this check
      if (here === "running") this.schedule("lost-later", this.opts.verifyMs);
      return;
    }
    // start — a daemon start; relaunch — bring back an app that quit for a version switch that did not happen
    // (the hub-update service): neither is a crash, and neither counts toward the restart limit
    const crashed = reason !== "start" && reason !== "relaunch";
    // the process disappeared without a connection (after a dropped stream or before the first connect) — that is a crash
    if (reason === "lost-later") this.journal({ type: "app-lost", pid: null, later: true });
    const again = reason === "lost-later" ? "lost" : reason;
    if (!pin?.path) {
      const why = pin?.why || "no-path";
      return RETRY_WHY.has(why) ? this.skipRetry(reason, why, {}, again) : this.skip(reason, why);
    }
    if (this.limited) return;
    if (crashed) {
      const t = this.now();
      this.restarts = this.restarts.filter((x) => t - x < this.opts.windowMs);
      if (this.restarts.length >= this.opts.maxRestarts) return this.giveUp();
    }
    // the signature is not confirmed (wrong build or codesign did not answer) — do not launch
    const ok = await this.adapter.verify(pin.path, pin.requirement);
    if (this.closed || this.stopping()) return;
    if (ok !== true) return this.skipRetry(reason, ok === false ? "pin-mismatch" : "verify-error", { path: pin.path }, again);
    const r = await this.adapter.launch(pin.path);
    if (r?.skipped) return this.skip(reason, r.skipped, { path: pin.path });
    if (crashed) this.restarts.push(this.now());
    this.retries = [];
    this.skippedWhy = null;
    this.journal({ type: "app-launch", reason, ok: Boolean(r?.ok), code: r?.code ?? null, path: pin.path, restarts: this.restarts.length });
    // also after a failed launch (open returned an error — e.g. login has not finished yet): it did not appear —
    // the next attempt counts toward the limit
    this.schedule("verify", this.opts.verifyMs);
  }

  // Stop: one record (also in the audit journal) and one event per episode — until the app connects with a stream.
  giveUp(why = null) {
    if (this.limited) return;
    this.limited = true;
    this.limitedWhy = why;
    const extra = why ? { why } : {};
    this.journal({ type: "app-restart-stopped", restarts: this.restarts.length, windowMs: this.opts.windowMs, ...extra });
    this.emit({ type: "app.restart-stopped", restarts: this.restarts.length, windowMs: this.opts.windowMs, ...extra });
  }

  info() {
    return { supervise: this.opts.supervise, limited: this.limited, restarts: this.restarts.length, why: this.limitedWhy };
  }
}
