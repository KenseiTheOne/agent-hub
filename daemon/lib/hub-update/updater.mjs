// Hub install and rollback inside the running daemon (docs/hub-updates.md §3–5). Platform and core go through deps so that
// tests can substitute the builder, watchdogs, restart and processes.
//
// deps:
//   home, configPath, self (label of the version the daemon runs from, or null), version (VERSION of the code)
//   journal(entry), emit(event), estop() → bool
//   life: { begin(), abort(), restart(), checkPin(), appConnections() → [{pid}], updating(), shuttingDown() }
//   spawnBuilder({label, version, tag, commit, remote, branch, log, onStep}) → { pid, done: Promise<{code, out}> }
//     (onStep(step) — the builder reports a step: clone → build → verify → selftest → promote)
//   spawnWatchdog() → pid | null
//   codeOf(app) → Promise<{identifier, cdhash}>; terminate(pid); launchApp(path) → Promise; processAlive(pid) → bool
//   killApp(appPath) → Promise — kill the bundle's processes by path (a new app that didn't connect)
//   relaunchApp() — bring back the previous app after a failed switch (supervision or launching appPin.path)
//   waiting() → {cards, sessions}: PermissionRequest cards (a daemon restart removes them — they go to the terminal) and
//     sessions awaiting a reply; a number works too (old form — counted as cards)
//   hasSupervisor() → bool (the app service will launch the app itself)
//   checker — HubUpdateChecker; opts: { deadlineMs, appQuitMs, keepVersions, launchDelayMs, branch }

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cdhashRequirement, pinFingerprint } from "../app-pin.mjs";
import { compareVersions, isLabel } from "../version.mjs";
import { msg } from "../i18n.mjs";
import { HubUpdateError, verifyApp } from "./build.mjs";
import { currentLabel, ensureDir, hubPaths, listVersions, pinnedCdhash, previousLabel, prune, readBuild, rememberPin, rememberPrevious, versionApp } from "./layout.mjs";
import { validRelease } from "./checker.mjs";
import { applySwitch, capturePrev, isSnapshot, restoreFiles } from "./switch.mjs";
import { TRIAL_DEFAULTS, readInstall, restorePinOf, startupVerdict, transitionInstall, writeInstall } from "./trial.mjs";

export const UPDATER_DEFAULTS = Object.freeze({ deadlineMs: TRIAL_DEFAULTS.deadlineMs, appQuitMs: 5000, keepVersions: 3, launchDelayMs: 4000, branch: "main" });
const PHASES_BUSY = new Set(["building", "switching", "trial", "rolling-back"]);
// Phases in which restoring the previous pin is the install's own job (no "re-pinned" push needed).
const RESTORE_PHASES = new Set(["switching", "trial", "rolling-back", "rolled-back"]);
const EXPECT_TTL_MS = 2 * 60_000;
const HEX40 = /^[0-9a-f]{40}$/;

// Builder steps it reports in stdout (`{"step": …}`) — stored in install.json.step as is.
const BUILDER_STEPS = new Set(["clone", "build", "verify", "selftest", "promote"]);
const notesOfBuild = (b) => {
  const n = b?.tagInfo?.notes;
  return n && typeof n.subject === "string" && n.subject ? { subject: n.subject, body: typeof n.body === "string" && n.body ? n.body : null } : null;
};
const summary = (b, notes = null) => (b ? { label: b.label, version: b.version, tag: b.tag ?? null, commit: b.commit ?? null, builtAt: b.builtAt ?? null, dirty: Boolean(b.dirty), cdhash: b.cdhash ?? null, notes: notesOfBuild(b) ?? notes } : null);
// Time in the log name is local (the UI shows local time; a UTC log is hard to match with an event).
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

export class HubUpdater {
  constructor(deps) {
    this.d = deps;
    this.home = deps.home;
    this.paths = hubPaths(deps.home);
    this.configPath = deps.configPath || this.paths.config;
    this.self = deps.self ?? null;
    this.version = deps.version;
    this.opts = { ...UPDATER_DEFAULTS, ...(deps.opts || {}) };
    this.checker = deps.checker;
    this.state = readInstall(this.home) || { phase: "idle" };
    this.expectedPins = new Map(); // fingerprint → until what time (ms) a change to it is expected
    this.trialTimer = null;
    this.launchTimer = null;
    this.lastFp = null;
    this.stopped = false;
    this.ready = null; // { job, build } — built and verified, waiting for the second click (cards are waiting)
    this.running = null; // Promise of the current install (tests await it)
  }

  log(e) {
    try {
      this.d.journal?.(e);
    } catch {}
  }
  emit(ev) {
    try {
      this.d.emit?.(ev);
    } catch {}
  }
  now() {
    return this.d.now ? this.d.now() : new Date();
  }

  // Write install.json. strict — a write error is thrown (we don't start a switch without a written snapshot);
  // otherwise — a warning in the log.
  setState(patch, { strict = false } = {}) {
    this.state = { ...this.state, ...patch };
    try {
      ensureDir(this.paths.dir);
      writeInstall(this.home, this.state);
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.fileNotWritten", { file: "HubUpdate/install.json", why: e.code || e.message }) });
      if (strict) throw new HubUpdateError("hub-update:state-write", e.code || e.message);
    }
    this.changed();
  }

  // ---------- what the shell sees ----------
  blocked() {
    if (!this.self) return "not-installed";
    if (PHASES_BUSY.has(this.state.phase)) return "busy";
    if (this.d.estop?.()) return "estop";
    return null;
  }
  // → {cards, sessions, total}: total — how many await a reply (the larger of the two: a session with a card counts as one pair)
  waitingParts() {
    const num = (v) => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    try {
      const w = this.d.waiting?.();
      const cards = w && typeof w === "object" ? num(w.cards) : num(w);
      const sessions = w && typeof w === "object" ? num(w.sessions) : 0;
      return { cards, sessions, total: Math.max(cards, sessions) };
    } catch {
      return { cards: 0, sessions: 0, total: 0 };
    }
  }
  waitingNow() {
    return this.waitingParts().total;
  }
  publicInstall() {
    const s = this.state;
    return {
      phase: s.phase || "idle",
      op: s.op ?? null,
      label: s.label ?? null,
      step: s.step ?? null,
      error: s.error ?? null,
      detail: s.detail ?? null,
      log: s.log ?? null,
      from: s.from ?? null,
      startedAt: s.startedAt ?? null,
      finishedAt: s.finishedAt ?? null,
      // ready: how many await a reply now; of them hub cards (a restart removes them) and waiting sessions
      ...(() => {
        if (s.phase !== "ready") return { waiting: null, waitingCards: null, waitingSessions: null };
        const w = this.waitingParts();
        return { waiting: w.total, waitingCards: w.cards, waitingSessions: w.sessions };
      })(),
      commit: s.commit ?? null,
    };
  }
  info() {
    const cur = this.self ? readBuild(this.home, this.self) : null;
    const prevLabel = previousLabel(this.home);
    const prev = prevLabel && prevLabel !== this.self ? readBuild(this.home, prevLabel) : null;
    return {
      installed: Boolean(this.self),
      running: this.version,
      label: this.self,
      current: summary(cur, this.self ? this.checkerNotes(this.self) : null) ?? (this.self ? { label: this.self, version: this.version, tag: null, commit: null, builtAt: null, dirty: false, cdhash: null, notes: this.checkerNotes(this.self) } : null),
      previous: summary(prev),
      versions: listVersions(this.home),
      ...this.checker.info(),
      install: this.publicInstall(),
      blocked: this.blocked(),
    };
  }
  checkerNotes(label) {
    try {
      return this.checker?.notesOf?.(label) ?? null;
    } catch {
      return null;
    }
  }
  changed() {
    const info = this.info();
    const fp = JSON.stringify(info);
    if (fp === this.lastFp) return;
    this.lastFp = fp;
    this.emit({ type: "hub-update.status", hubUpdate: info });
  }

  // ---------- expected pin changes ----------
  expectPin(fingerprint) {
    if (fingerprint) this.expectedPins.set(fingerprint, Date.now() + EXPECT_TTL_MS);
  }
  // A pin change written by the install itself or its rollback (no "re-pinned" push needed — "updated" or "failed"
  // will come). Besides this process's changes — restoring the previous pin written to
  // install.json (restorePin) by another process (watchdog, new daemon): only while the install is in the rollback phase and only
  // if the hub itself set this pin for the previous version (HubUpdate/history.json).
  expectsPin(fingerprint) {
    if (!fingerprint) return false;
    const until = this.expectedPins.get(fingerprint);
    if (until !== undefined) {
      if (Date.now() <= until) return true;
      this.expectedPins.delete(fingerprint);
    }
    const st = readInstall(this.home);
    if (!st || !RESTORE_PHASES.has(st.phase) || st.restorePin !== fingerprint || !isSnapshot(st.prev)) return false;
    const known = st.prev.current ? pinnedCdhash(this.home, st.prev.current) : null;
    return Boolean(known) && fingerprint === `cdhash:${known}`;
  }

  // ---------- permission and state checks ----------
  guard() {
    if (!this.self) throw new HubUpdateError("hub-update:not-installed");
    if (PHASES_BUSY.has(this.state.phase) || this.running) throw new HubUpdateError("hub-update:busy");
    if (this.d.estop?.()) throw new HubUpdateError("hub-update:estop");
  }

  // POST /hub-update/install {version, acceptCommit?}: only an available (found by the check) release newer than the current one.
  // If the tag was moved to another commit (available.moved) — only with acceptCommit = the new commit (the human saw both).
  install(version, peer = null, { acceptCommit = null } = {}) {
    this.guard();
    // this same version is already built and waiting for a restart — no reason to rebuild it (we'd throw away a verified build)
    if (this.state.phase === "ready" && this.state.label === version) throw new HubUpdateError("hub-update:ready", version);
    const a = this.checker.available();
    if (!a || a.version !== version) throw new HubUpdateError("hub-update:unknown-version", String(version ?? ""));
    // Homebrew-managed hub (§8b): the version is in the brew tree, built from there — no tag, no origin
    if (a.brew) {
      const dir = this.checker.brewDir?.();
      if (!dir || !isLabel(a.version) || (a.commit !== null && !HEX40.test(String(a.commit)))) throw new HubUpdateError("hub-update:unknown-version", msg("hub.detail.releaseEntry"));
      if (compareVersions(a.version, this.self) <= 0) throw new HubUpdateError("hub-update:not-newer");
      this.ready = null;
      this.start({ op: "install", label: a.version, version: a.version, tag: null, commit: a.commit ?? null, remote: null, brew: dir, peer });
      return this.info();
    }
    const rel = validRelease(a);
    if (!rel) throw new HubUpdateError("hub-update:unknown-version", msg("hub.detail.releaseEntry"));
    if (compareVersions(rel.version, this.self) <= 0) throw new HubUpdateError("hub-update:not-newer");
    if (a.moved) {
      if (acceptCommit !== rel.commit) throw new HubUpdateError("hub-update:tag-moved", `${a.moved.old.slice(0, 12)} → ${a.moved.new.slice(0, 12)}`);
      this.checker.acceptMoved?.(rel.version, rel.commit);
    }
    const remote = this.checker.remote();
    this.ready = null;
    this.start({ op: "install", label: rel.version, version: rel.version, tag: rel.tag, commit: rel.commit, remote, peer });
    return this.info();
  }

  // POST /hub-update/rollback {version?}: to previous (or the given built version), without building. Only to
  // a build the hub itself pinned for this label (history.json): a planted Versions/<label> won't get pinned.
  rollback(label = null, peer = null) {
    this.guard();
    // a built version is waiting for a restart: rollback would silently discard it — restart first (or a new install)
    if (this.state.phase === "ready") throw new HubUpdateError("hub-update:ready", this.state.label ?? "");
    const target = label ?? previousLabel(this.home);
    if (!target || !isLabel(target) || target === this.self) throw new HubUpdateError(label ? "hub-update:unknown-version" : "hub-update:no-previous");
    const b = readBuild(this.home, target);
    if (!b) throw new HubUpdateError("hub-update:unknown-version", target);
    if (!pinnedCdhash(this.home, target)) throw new HubUpdateError("hub-update:untrusted-build", target);
    this.ready = null;
    this.start({ op: "rollback", label: target, version: b.version, tag: b.tag ?? null, commit: b.commit ?? null, remote: null, peer });
    return this.info();
  }

  // POST /hub-update/switch: the built version was waiting for the second click (cards were waiting) — switch now.
  switchReady(peer = null) {
    if (!this.self) throw new HubUpdateError("hub-update:not-installed");
    if (this.state.phase !== "ready" || !this.ready || this.running) throw new HubUpdateError("hub-update:not-ready");
    if (this.d.estop?.()) throw new HubUpdateError("hub-update:estop");
    const { job, build } = this.ready;
    this.ready = null;
    this.log({ type: "hub-update-confirm", label: job.label, waiting: this.waitingNow(), peer: peer?.class ?? null, pid: peer?.pid ?? null });
    this.setState({ phase: "building", step: "verify" });
    this.running = (async () => {
      try {
        await this.verifyDisk(job, build);
        await this.switchNow(job, build);
      } catch (e) {
        this.fail(e, job);
      }
    })().finally(() => {
      this.running = null;
    });
    return this.info();
  }

  start(job) {
    const log = join(this.paths.logs, `hub-update-${job.label}-${stamp(this.now())}.log`);
    this.setState({ phase: "building", op: job.op, label: job.label, version: job.version, tag: job.tag, commit: job.commit, from: this.self, step: job.op === "install" ? "clone" : "verify", error: null, detail: null, log: job.op === "install" ? log : null, startedAt: this.now().toISOString(), finishedAt: null, deadlineAt: null, deadlineExtended: null, builderPid: null, watchdogPid: null, prev: null, restorePin: null, restoreErrors: null });
    this.log({ type: "hub-update-start", op: job.op, label: job.label, from: this.self, peer: job.peer?.class ?? null, pid: job.peer?.pid ?? null });
    this.running = this.run(job, log).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  // Expected build: install — from the builder channel (the child process stdout), not from build.json in the same
  // directory being written; rollback — the cdhash the hub itself pinned for this label (history.json).
  async expectedBuild(job, logPath) {
    if (job.op === "install") {
      // the builder step goes to install.json (the shell shows "loading sources" → "build" → "verification")
      const onStep = (step) => {
        if (BUILDER_STEPS.has(step) && this.state.phase === "building" && this.state.label === job.label && this.state.step !== step && !this.stopped) this.setState({ step });
      };
      const child = this.d.spawnBuilder({ label: job.label, version: job.version, tag: job.tag, commit: job.commit, remote: job.remote, brew: job.brew ?? null, branch: this.opts.branch, log: logPath, onStep });
      this.setState({ builderPid: child.pid ?? null });
      const r = await child.done;
      let out = null;
      try {
        out = JSON.parse(String(r.out || "").trim().split("\n").filter(Boolean).pop() || "null");
      } catch {}
      if (this.stopped) throw new HubUpdateError("hub-update:interrupted");
      // the builder didn't start (node removed after `brew upgrade node`) or was killed by the overall timeout: the builder didn't write
      // a log — the daemon writes the reason line so that "Show log" leads to a file
      if (r.error || r.timedOut) {
        const code = r.timedOut ? "hub-update:build-timeout" : r.error === "node-missing" || r.error === "ENOENT" ? "hub-update:node-missing" : "hub-update:build-failed";
        const detail = r.timedOut ? msg("hub.detail.builderTimeout") : r.error === "node-missing" || r.error === "ENOENT" ? msg("hub.detail.builderNoNode") : msg("hub.detail.builderNotStarted", { why: r.error });
        try {
          ensureDir(this.paths.logs);
          appendFileSync(logPath, `${msg("hub.log.failed", { code, detail })}\n`, { mode: 0o600 });
        } catch {}
        throw new HubUpdateError(code, detail);
      }
      if (r.code !== 0 || !out?.ok) throw new HubUpdateError(out?.code || "hub-update:build-failed", out?.detail || msg("hub.detail.code", { code: r.code }));
      const ob = out.build || {};
      if (!HEX40.test(String(ob.cdhash || "")) || ob.label !== job.label || (ob.commit ?? null) !== (job.commit ?? null)) throw new HubUpdateError("hub-update:verify-failed", msg("hub.detail.builderWrongVersion"));
      this.log({ type: "hub-update-built", label: job.label, commit: ob.commit, cdhash: ob.cdhash });
      return { cdhash: ob.cdhash, commit: ob.commit };
    }
    const cd = pinnedCdhash(this.home, job.label);
    if (!cd) throw new HubUpdateError("hub-update:untrusted-build", job.label);
    return { cdhash: cd, commit: job.commit ?? null };
  }

  // Step 3: the bundle on disk and build.json are that very build (cdhash and commit from the expected one), not a planted one.
  async verifyDisk(job, expect) {
    const disk = readBuild(this.home, job.label);
    if (!disk) throw new HubUpdateError(job.op === "install" ? "hub-update:verify-failed" : "hub-update:unknown-version", msg("hub.detail.noBuildJson"));
    if (disk.cdhash !== expect.cdhash) throw new HubUpdateError("hub-update:verify-failed", msg("hub.detail.buildJsonOther"));
    if (job.op === "install" && (disk.commit ?? null) !== (expect.commit ?? null)) throw new HubUpdateError("hub-update:verify-failed", msg("hub.detail.buildJsonCommit"));
    this.setState({ step: "verify" });
    const code = await verifyApp(versionApp(this.home, job.label), this.d.codeOf);
    if (code.cdhash !== expect.cdhash) throw new HubUpdateError("hub-update:verify-failed", job.op === "install" ? msg("hub.detail.cdhashMismatch") : msg("hub.detail.notPinnedBuild"));
    return { ...disk, cdhash: expect.cdhash, requirement: cdhashRequirement(expect.cdhash) };
  }

  async run(job, logPath) {
    try {
      const expect = await this.expectedBuild(job, logPath);
      const build = await this.verifyDisk(job, expect);
      if (this.d.estop?.()) throw new HubUpdateError("hub-update:estop");
      // a daemon restart will remove PermissionRequest cards (they'll go to the terminal) — ask again
      const waiting = this.waitingNow();
      if (waiting > 0) {
        this.ready = { job, build };
        this.setState({ phase: "ready", step: "waiting" });
        // one "A new hub version is built — waiting for a restart" notification per version (only for installing a new version:
        // the human started a rollback themselves, with the button)
        let notify = false;
        if (job.op === "install") {
          try {
            notify = this.checker?.claimReadyNotice?.(job.label) === true;
          } catch {}
        }
        this.log({ type: "hub-update-ready", op: job.op, label: job.label, waiting, notify });
        this.emit({ type: "hub-update.ready", op: job.op, label: job.label, waiting, notify });
        return;
      }
      await this.switchNow(job, build);
    } catch (e) {
      this.fail(e, job);
    }
  }

  fail(e, job = this.state) {
    const code = e?.code && String(e.code).startsWith("hub-update:") ? e.code : "hub-update:failed";
    this.setState({ phase: "failed", error: code, detail: String(e?.detail || e?.message || "").slice(0, 300), finishedAt: this.now().toISOString() });
    this.log({ type: "hub-update-failed", op: job.op ?? null, label: job.label ?? null, error: code, detail: this.state.detail, log: this.state.log ?? null, step: this.state.step ?? null });
    this.emit({ type: "hub-update.failed", op: job.op ?? null, label: job.label ?? null, from: this.self, error: code, log: this.state.log ?? null });
    this.cleanup(job.op === "install" ? [job.label] : []);
  }

  // Cleaning up versions and logs; drop — labels that didn't take (we don't keep them for keepVersions).
  cleanup(drop = []) {
    try {
      const removed = prune(this.home, { keep: this.opts.keepVersions, drop, busy: false });
      if (removed.length) this.log({ type: "hub-update-pruned", removed });
    } catch (e) {
      this.log({ type: "warning", detail: msg("hub.warn.prune", { why: e.message }) });
    }
  }

  // Steps 4–10: snapshot, the app exits, files, watchdog, daemon restart.
  async switchNow(job, build) {
    // the snapshot comes before the app exits and as a single record with the phase: wherever it breaks later, there's something to roll back by
    const prev = capturePrev(this.home, this.configPath);
    this.setState({ phase: "switching", step: "switch", prev, restorePin: restorePinOf(prev) }, { strict: true });
    this.d.life.begin();
    this.emit({ type: "hub-update.restarting", label: job.label, op: job.op });
    await this.waitAppGone();
    // the daemon is stopping (SIGTERM, logout): don't switch — the previous version will come up as it was
    if (this.halted()) throw new HubUpdateError("hub-update:interrupted", msg("hub.detail.stopping"));
    // a pause set while the app was exiting
    if (this.d.estop?.()) {
      this.d.life.abort();
      this.d.relaunchApp?.();
      throw new HubUpdateError("hub-update:estop");
    }
    try {
      this.expectPin(pinFingerprint(build.requirement).label);
      applySwitch({ home: this.home, label: job.label, build, prev, configPath: this.configPath });
    } catch (e) {
      this.expectPin(restorePinOf(prev));
      this.d.life.abort();
      this.log({ type: "hub-update-restore", label: job.label, step: e.step ?? null, ok: e.restore?.ok ?? null, errors: e.restore?.errors ?? null });
      // the previous version's app has already exited — launch it again
      this.d.relaunchApp?.();
      throw e.code ? e : new HubUpdateError("hub-update:switch-failed", e.message);
    }
    // which builds the hub pinned itself — for rollback (the previous one is the one we left, if it's not in the history yet)
    try {
      rememberPin(this.home, job.label, { cdhash: build.cdhash, commit: build.commit ?? null, op: job.op });
      rememberPrevious(this.home, prev);
    } catch (e) {
      this.log({ type: "warning", detail: `HubUpdate/history.json: ${e.message}` });
    }
    // the daemon records the pin change itself right away (app-pin.json): the new daemon won't take it for tampering at startup
    try {
      this.d.life.checkPin();
    } catch {}
    const deadlineAt = new Date(this.now().getTime() + this.opts.deadlineMs).toISOString();
    this.setState({ phase: "trial", step: "restart", deadlineAt });
    let watchdogPid = null;
    try {
      watchdogPid = this.d.spawnWatchdog?.() ?? null;
    } catch (e) {
      this.log({ type: "warning", detail: msg("hub.warn.watchdogFailed", { why: e.message }) });
    }
    this.setState({ watchdogPid });
    this.log({ type: "hub-update-switch", op: job.op, label: job.label, from: prev.current ?? this.self, cdhash: build.cdhash, deadlineAt, watchdog: watchdogPid !== null });
    this.d.life.restart();
  }

  halted() {
    try {
      return this.stopped || this.d.life.shuttingDown?.() === true;
    } catch {
      return this.stopped;
    }
  }

  async waitAppGone() {
    const until = Date.now() + this.opts.appQuitMs;
    while (Date.now() < until && this.d.life.appConnections().length && !this.halted()) await new Promise((r) => setTimeout(r, 100));
    if (this.halted()) return;
    // didn't exit by itself (an old build without this event) — SIGTERM to the pinned app's process
    for (const c of this.d.life.appConnections()) {
      if (Number.isInteger(c.pid) && c.pid > 0) {
        try {
          this.d.terminate?.(c.pid);
          this.log({ type: "hub-update-app-terminated", pid: c.pid });
        } catch {}
      }
    }
  }

  // ---------- daemon startup ----------
  // Called after all services have started (push is already listening).
  resume() {
    const st = readInstall(this.home);
    const v = startupVerdict(st, this.self);
    if (!v) return null;
    if (v === "confirm-wait") {
      this.state = st;
      // the daemon came up after the deadline (sleep, logout, launchd took its time) — deadline from its start, once
      let deadline = Date.parse(st.deadlineAt || "");
      const now = this.now().getTime();
      const patch = { step: "confirm" };
      if ((!Number.isFinite(deadline) || deadline <= now) && !st.deadlineExtended) {
        deadline = now + this.opts.deadlineMs;
        patch.deadlineAt = new Date(deadline).toISOString();
        patch.deadlineExtended = true;
        this.log({ type: "hub-update-deadline-extended", label: st.label, was: st.deadlineAt ?? null, deadlineAt: patch.deadlineAt });
      }
      this.setState(patch);
      const left = Math.max(0, deadline - now);
      this.trialTimer = setTimeout(() => this.trialExpired().catch((e) => this.log({ type: "warning", detail: msg("hub.warn.trialRollback", { why: e.message }) })), Number.isFinite(left) ? left : this.opts.deadlineMs);
      this.trialTimer.unref?.();
      // no supervision — the update service launches the app
      if (!this.d.hasSupervisor?.()) {
        this.launchTimer = setTimeout(() => {
          if (this.state.phase === "trial" && !this.d.life.appConnections().length) this.d.launchApp?.(versionApp(this.home, this.self));
        }, this.opts.launchDelayMs);
        this.launchTimer.unref?.();
      }
      return v;
    }
    if (v === "finalize-failed") {
      this.state = st;
      // the rollback restored the previous pin; app-pin will see the change at this daemon's startup — it's expected
      if (st.restorePin) this.expectPin(st.restorePin);
      const error = st.error || "hub-update:trial-timeout";
      this.setState({ phase: "failed", error, finishedAt: st.finishedAt || this.now().toISOString() });
      this.log({ type: "hub-update-failed", op: st.op ?? null, label: st.label ?? null, error, step: "confirm", log: st.log ?? null, restoreErrors: st.restoreErrors ?? null });
      this.emit({ type: "hub-update.failed", op: st.op ?? null, label: st.label ?? null, from: this.self, error, log: st.log ?? null });
      this.cleanup(st.op === "install" && st.label !== this.self ? [st.label] : []);
      return v;
    }
    if (v === "interrupted") {
      this.state = st;
      this.fail(new HubUpdateError("hub-update:interrupted"), st);
      return v;
    }
    if (v === "restore") {
      this.state = st;
      const why = st.phase === "rolling-back" ? st.error || "hub-update:trial-timeout" : "hub-update:interrupted";
      if (!isSnapshot(st.prev)) {
        // no snapshot (old-format record or broken) — we don't touch the files: wiping the pin is worse
        this.log({ type: "hub-update-restore", label: st.label ?? null, step: "startup", ok: false, skipped: true });
        this.fail(new HubUpdateError("hub-update:interrupted", msg("hub.detail.noSnapshot")), st);
        return v;
      }
      if (st.restorePin) this.expectPin(st.restorePin);
      const r = restoreFiles({ home: this.home, prev: st.prev, configPath: this.configPath });
      this.log({ type: "hub-update-restore", label: st.label ?? null, step: "startup", ok: r.ok, errors: r.errors });
      if (st.prev.current && st.prev.current !== this.self) {
        // the daemon isn't running from the version the pointer was returned to: the outcome (log, push "failed · hub on
        // <previous>") will be written by the previous version after the restart — finalize-failed
        this.setState({ phase: "rolled-back", error: why, restoreErrors: r.errors, finishedAt: this.now().toISOString() });
        this.d.life.restart();
        return v;
      }
      this.fail(new HubUpdateError(why), st);
      return v;
    }
    return null;
  }

  // The pinned app opened the event stream (core event app.peer with stream). Confirmation — transition
  // trial → done under the lock and only for the same install: the watchdog may have started a rollback already.
  onAppStream() {
    if (this.state.phase !== "trial" || this.state.label !== this.self) return;
    const done = transitionInstall(this.home, { phase: "trial", startedAt: this.state.startedAt }, { phase: "done", step: null, finishedAt: this.now().toISOString() });
    if (!done) {
      this.state = readInstall(this.home) || { phase: "idle" };
      this.log({ type: "hub-update-confirm-skipped", label: this.self, phase: this.state.phase ?? null });
      this.changed();
      return;
    }
    clearTimeout(this.trialTimer);
    clearTimeout(this.launchTimer);
    const { v: _v, ...st } = done;
    this.state = st;
    const b = readBuild(this.home, this.self);
    this.log({ type: "hub-update-installed", op: this.state.op ?? null, label: this.self, from: this.state.from ?? null, cdhash: b?.cdhash ?? null });
    this.emit({ type: "hub-update.installed", op: this.state.op ?? null, label: this.self, from: this.state.from ?? null, cdhash: b?.cdhash ?? null });
    this.cleanup();
    this.changed();
  }

  // The confirmation deadline passed: if the watchdog is alive it's its job (we'll check again later); if not — roll back ourselves.
  async trialExpired() {
    if (this.stopped || this.state.phase !== "trial" || this.state.label !== this.self) return;
    const wd = this.state.watchdogPid;
    if (Number.isInteger(wd) && wd > 0 && this.d.processAlive?.(wd) && !this.graceUsed) {
      this.graceUsed = true;
      this.trialTimer = setTimeout(() => this.trialExpired().catch((e) => this.log({ type: "warning", detail: msg("hub.warn.trialRollback", { why: e.message }) })), 30_000);
      this.trialTimer.unref?.();
      return;
    }
    const st = this.state;
    if (!isSnapshot(st.prev)) {
      const f = transitionInstall(this.home, { phase: "trial", startedAt: st.startedAt }, { phase: "failed", error: "hub-update:interrupted", finishedAt: this.now().toISOString() });
      if (f) this.state = f;
      this.log({ type: "hub-update-restore", label: st.label, step: "trial", ok: false, skipped: true });
      this.changed();
      return;
    }
    const restorePin = restorePinOf(st.prev);
    const claimed = transitionInstall(this.home, { phase: "trial", startedAt: st.startedAt }, { phase: "rolling-back", restorePin });
    if (!claimed) {
      this.state = readInstall(this.home) || st;
      this.changed();
      return;
    }
    this.expectPin(restorePin);
    this.state = claimed;
    const r = restoreFiles({ home: this.home, prev: st.prev, configPath: this.configPath });
    this.setState({ phase: "rolled-back", error: "hub-update:trial-timeout", restoreErrors: r.errors, finishedAt: this.now().toISOString() });
    this.log({ type: "hub-update-restore", label: st.label, step: "trial", ok: r.ok, errors: r.errors });
    this.d.life.begin();
    for (const c of this.d.life.appConnections()) if (Number.isInteger(c.pid) && c.pid > 0) this.d.terminate?.(c.pid);
    // the new app that never connected (hung) — by the version's bundle path
    try {
      await this.d.killApp?.(versionApp(this.home, st.label));
    } catch (e) {
      this.log({ type: "warning", detail: msg("hub.warn.appProcesses", { label: st.label, why: e.message }) });
    }
    this.d.life.restart();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.trialTimer);
    clearTimeout(this.launchTimer);
  }

  // for tests
  currentLabel() {
    return currentLabel(this.home);
  }
}
