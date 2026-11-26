// The awake service: "keep the Mac awake with the lid closed" — /state.awake, the `awake` event on every change of the
// section, the switch itself (the awake.api fact behind POST /awake) and the battery guard.
//
// The switch is the system flag `pmset -a disablesleep` (lib/platform.mjs awakeControl). It is machine-wide and survives
// a reboot, so the flag is the only truth: the service keeps no "what the human wanted" of its own, and a flag set by hand
// in a terminal shows as on. Switching needs the sudoers rule (`agenthub awake grant`); without it the section says
// granted: false and the switch is refused. granted means: the rule file is in place, sudo would run the switch without
// a password, and sudo has not refused a switch since (lib/platform.mjs awakeControl.granted) — without the file no sudo
// is run at all.
//
// The guard: while the flag is on, the service looks at the power source and the charge every minute; on the battery and
// below the threshold (BATTERY_THRESHOLD — one fixed value, not a setting) it turns the flag off, writes awake-low-battery to the
// journal and emits awake.low-battery (the push service turns it into a notification). It never turns the flag back on.
// While the flag is off — a rare check, to notice a flag set outside the hub and a rule that was granted or removed.
// What cannot be read is "unknown", never "off": a failed read of the lid or of the flag keeps the last answer, and a
// power source or a charge that cannot be read while the flag is on is one journal warning per run of such reads — the
// guard is not watching then, and that must be visible.
//
// Stopping: a final exit — one after which nothing brings the daemon back — returns sleep, because nobody is left to
// guard the battery. Two exits are final: the app quitting (POST /shutdown → hub.stopping, reason "shutdown"; this is
// also what a logout, a restart and a power-off of the Mac look like) and "login-off" (launch at login is off and the
// app never showed up → hub.stopping, reason "login-off"). Any other stop (a hub update, `agenthub restart`, a bare
// SIGTERM) leaves the flag alone: the Mac must not fall asleep with the lid closed in the middle of an update, and the
// next daemon picks the flag up at start.
// What is not covered: the daemon has to be alive and still listening to hear the app. At a logout launchd's SIGTERM can
// come before the app's POST /shutdown; a request already being handled then still returns sleep (the core announces it
// even when the stop has begun), but once the server is closed the app gets no connection, and after a SIGKILL or a
// crash nobody is asked. In those cases the flag stays on until the next daemon starts (it guards the battery again
// from its first check) or a human runs `sudo pmset -a disablesleep 0`.
// The quit must fit into the daemon's exit: it does not wait long for a check in flight, its commands get short
// timeouts (QUIT below — 4.5 s at worst against the 5 s limit of bin/agenthubd), and the "exit.hold" fact lets that
// limit wait a little for a quit that started late.
//
// A test directory runs no system commands: the double AGENTHUB_TEST_AWAKE_FILE, or nothing (supported: false).
// services.awake.enabled = false — no service, no /state.awake section. services.awake.pollMs / idlePollMs — the two
// check intervals (60 s and 5 min).

import { join } from "node:path";
import { AWAKE_SUDOERS, awakeControl } from "../platform.mjs";

export const name = "awake";

// On the battery below this charge (percent) the hub returns sleep. One fixed value by the owner's decision: there is
// nothing to choose here — low enough to use the battery, high enough not to run it flat with the lid closed. It is not
// in settings.json or config.json; /state.awake carries it as `threshold` so that the app and the CLI print the number
// from one place.
export const BATTERY_THRESHOLD = 10;

const POLL_MS = 60_000;
const IDLE_POLL_MS = 5 * 60_000;
// While the flag is on the rights are re-checked this often, not on every poll: each check is a sudo run.
const RIGHTS_MS = 5 * 60_000;
// The quit path, ms: how long to wait for a check in flight, for one read of the flag, for the switch.
const QUIT = Object.freeze({ queue: 1000, read: 1000, set: 1500 });
const delay = (ms) =>
  new Promise((done) => {
    setTimeout(done, ms).unref?.();
  });

const interval = (v, def) => (Number.isFinite(v) && v >= 10 ? v : def);

class Awake {
  constructor(ctx, ctl) {
    this.ctx = ctx;
    this.ctl = ctl;
    const cfg = ctx.config.services?.awake || {};
    this.pollMs = interval(cfg.pollMs, POLL_MS);
    this.idlePollMs = interval(cfg.idlePollMs, IDLE_POLL_MS);
    this.cur = { supported: false, granted: false, on: false, onBattery: null, charge: null };
    this.sig = null;
    // the lid as last read: null — never read yet
    this.hasLid = null;
    this.rightsAt = 0;
    this.timer = null;
    this.stopped = false;
    // reads and switches go one at a time: a poll must not land between a switch and the read that confirms it
    this.queue = Promise.resolve();
    this.quitting = null;
    // one journal line per run of failures, not one per minute
    this.guardFailed = false;
    this.guardBlind = false;
  }

  // /state.awake
  state() {
    const c = this.cur;
    return { supported: c.supported, granted: c.granted, on: c.on, onBattery: c.onBattery, charge: c.charge, threshold: BATTERY_THRESHOLD };
  }

  serial(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // Broadcast the section if it changed.
  publish({ emit = true } = {}) {
    const st = this.state();
    const sig = JSON.stringify(st);
    if (sig === this.sig) return;
    this.sig = sig;
    if (emit) this.ctx.emit({ type: "awake", awake: st });
  }

  // Read the system. rights: false — keep the last answer about the rule. assume — what the flag is taken to be when it
  // cannot be read (after a switch command that succeeded); without it an unreadable flag keeps the last answer.
  async read({ rights = true, emit = true, assume = undefined } = {}) {
    const { ctl } = this;
    // a failed read of the lid is "unknown": the last answer stays
    const lid = await ctl.lid();
    if (lid !== null) this.hasLid = lid;
    let next;
    if (this.hasLid !== true) {
      next = { supported: false, granted: false, on: false, onBattery: null, charge: null };
    } else {
      const [flag, granted, battery] = await Promise.all([ctl.flag(), rights ? ctl.granted() : this.cur.granted, ctl.battery()]);
      if (rights) this.rightsAt = Date.now();
      next = { supported: true, granted, on: flag ?? assume ?? this.cur.on, onBattery: battery.onBattery, charge: battery.charge };
    }
    if (this.stopped) return;
    this.cur = next;
    this.publish({ emit });
  }

  // After a switch command: read the flag back. Success is the flag reading as asked; a flag that cannot be read right
  // now is believed to be what a command that succeeded made it. A refusal by sudo is "not granted" from this moment,
  // whatever the probe says. → whether the flag is now `on`
  async settle(on, r, { emit = true } = {}) {
    await this.read({ rights: !r.ok, emit, assume: r.ok ? on : undefined });
    if (r.refused && this.cur.granted && !this.stopped) {
      this.cur = { ...this.cur, granted: false };
      this.publish({ emit });
    }
    return this.cur.supported && this.cur.on === on;
  }

  // On the battery and below the threshold — return sleep. Only what is certain counts: an unknown source or charge
  // (a UPS, a failed read) never trips it — but it is said once, because the guard is not watching then.
  async guard() {
    const c = this.cur;
    const threshold = BATTERY_THRESHOLD;
    const watching = c.supported && c.on;
    const blind = watching && (c.onBattery === null || (c.onBattery === true && !Number.isInteger(c.charge)));
    if (blind && !this.guardBlind) this.ctx.journal.write({ type: "warning", detail: "awake: the power source or the charge cannot be read — the low-battery guard is not watching while the Mac is kept awake" });
    this.guardBlind = blind;
    if (!watching || c.onBattery !== true || !Number.isInteger(c.charge) || c.charge >= threshold) {
      this.guardFailed = false;
      return;
    }
    const charge = c.charge;
    // no rule — no sudo: the flag was set by hand, or the rule was removed
    const r = c.granted ? await this.ctl.set(false) : { ok: false, code: null };
    if (!(await this.settle(false, r))) {
      // the hub cannot return sleep — say so once
      if (!this.guardFailed) this.ctx.journal.write({ type: "awake-failed", on: false, reason: "low-battery", charge, threshold, granted: this.cur.granted, code: r.code ?? null });
      this.guardFailed = true;
      return;
    }
    this.guardFailed = false;
    this.ctx.journal.write({ type: "awake-low-battery", charge, threshold });
    this.ctx.emit({ type: "awake.low-battery", charge, threshold });
  }

  // One check: read, guard, plan the next one. guard: false — only look (the first look at start).
  check({ rights = null, emit = true, guard = true } = {}) {
    return this.serial(async () => {
      if (this.stopped) return;
      const needRights = rights ?? (!this.cur.on || Date.now() - this.rightsAt >= RIGHTS_MS);
      await this.read({ rights: needRights, emit });
      if (guard && !this.stopped) await this.guard();
    })
      .catch((e) => this.ctx.journal.write({ type: "warning", detail: `awake: ${String(e?.message || e).slice(0, 160)}` }))
      .finally(() => this.schedule());
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // nothing to watch: no lid here, or a test directory without a double
    if (this.stopped || this.ctl.mode === "off") return;
    // a lid that could not be read yet is asked again soon: the flag may be on, and nobody is guarding it
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, this.cur.on || this.hasLid === null ? this.pollMs : this.idlePollMs);
    this.timer.unref?.();
  }

  // The switch (POST /awake). → { awake } | { error, awake }
  set(on, peerInfo) {
    return this.serial(async () => {
      // a final exit has returned sleep (or is doing it): nothing turns the flag back on behind it
      if (this.quitting && on) return { error: "awake:failed", awake: this.state() };
      // the rule may have been granted or removed since the last check
      await this.read({ rights: true });
      if (!this.cur.supported) return { error: "awake:unsupported", awake: this.state() };
      if (this.cur.on === on) return { awake: this.state() };
      if (!this.cur.granted) return { error: "awake:not-granted", awake: this.state() };
      const r = await this.ctl.set(on);
      if (!(await this.settle(on, r))) {
        this.ctx.journal.write({ type: "awake-failed", on, reason: "set", code: r.code ?? null, granted: this.cur.granted, ...(r.refused ? { refused: true } : {}), peer: peerInfo?.class, pid: peerInfo?.pid });
        // sudo wants a password — the rule does not work for this account: `agenthub awake grant`, not "try again"
        return { error: this.cur.granted ? "awake:failed" : "awake:not-granted", awake: this.state() };
      }
      this.ctx.journal.write({ type: "awake-set", on, peer: peerInfo?.class, pid: peerInfo?.pid });
      // turned on below the threshold on the battery: the guard answers right away, not a minute later
      await this.guard();
      return { awake: this.state() };
    }).finally(() => this.schedule());
  }

  // A fresh look (GET /awake; `agenthub awake grant|revoke` ask for it so the app sees the rule at once).
  async fresh() {
    await this.check({ rights: true });
    return this.state();
  }

  // A final exit (stop: "shutdown" | "login-off"): return sleep while the daemon is still here to do it. The daemon is on
  // its way out, so this does not queue behind a slow check and asks only what it needs: the flag, then the switch. The
  // rule is taken as last seen — without it no sudo is run. → Promise
  quit(stop = "shutdown") {
    this.quitting ??= (async () => {
      const waited = this.queue;
      // later requests wait for the quit
      const done = Promise.race([waited, delay(QUIT.queue)]).then(async () => {
        if (!this.cur.supported || this.stopped) return;
        const on = (await this.ctl.flag({ timeoutMs: QUIT.read })) ?? this.cur.on;
        if (!on) return;
        const r = this.cur.granted ? await this.ctl.set(false, { timeoutMs: QUIT.set }) : { ok: false, code: null };
        const seen = await this.ctl.flag({ timeoutMs: QUIT.read });
        const off = seen === false || (r.ok && seen === null);
        if (!this.stopped) {
          this.cur = { ...this.cur, on: !off, ...(r.refused ? { granted: false } : {}) };
          this.publish();
        }
        if (off) this.ctx.journal.write({ type: "awake-set", on: false, peer: "hub", reason: "quit", stop });
        else this.ctx.journal.write({ type: "awake-failed", on: false, reason: "quit", stop, code: r.code ?? null, granted: this.cur.granted });
      });
      this.queue = Promise.all([waited, done.catch(() => {})]);
      await done;
    })().catch((e) => this.ctx.journal.write({ type: "warning", detail: `awake: ${String(e?.message || e).slice(0, 160)}` }));
    return this.quitting;
  }
}

const running = new Map(); // ctx → { svc, off }
// The service behind /state.awake and the awake.api fact — one per core (keyed by its facts).
const byFacts = new WeakMap();

export async function start(ctx) {
  const cfg = ctx.config;
  // the sudoers double of a test directory stands in for /etc/sudoers.d here as it does in the CLI
  const ruleFile = cfg.testSudoersDir ? join(cfg.testSudoersDir, AWAKE_SUDOERS.name) : undefined;
  const svc = new Awake(ctx, awakeControl({ testMode: cfg.awakeTest, testFile: cfg.testAwakeFile, real: cfg.awakeReal, ruleFile }));
  // the two final exits (see the head of the file); "update", SIGTERM and SIGINT are not announced at all
  const onStopping = (ev) => {
    if (ev?.reason === "shutdown" || ev?.reason === "login-off") svc.quit(ev.reason);
  };
  // The flag may already be on (it survives a reboot and a daemon restart) with the charge already low: the guard runs
  // once every service is subscribed — the push service starts after this one and must hear awake.low-battery.
  const onStarted = () => svc.check({ rights: false });
  ctx.on("hub.stopping", onStopping);
  ctx.on("services.started", onStarted);
  byFacts.set(ctx.facts, svc);
  // /state.awake — {supported, granted, on, onBattery, charge, threshold}
  ctx.provideState("awake", () => byFacts.get(ctx.facts)?.state() ?? null);
  ctx.facts.provide("awake.api", () => byFacts.get(ctx.facts) ?? null);
  // bin/agenthubd: the hard exit waits (bounded) for a quit in progress
  ctx.facts.provide("exit.hold", () => svc.quitting);
  running.set(ctx, {
    svc,
    off: () => {
      ctx.off("hub.stopping", onStopping);
      ctx.off("services.started", onStarted);
    },
  });
  // the first look fills /state.awake before the server answers; the guard waits for services.started (above)
  await svc.check({ rights: true, emit: false, guard: false });
}

export async function stop(ctx) {
  for (const [c, inst] of [...running]) {
    if (ctx && c !== ctx) continue;
    // a quit in progress finishes first: the daemon exits right after the services stop
    await inst.svc.quitting;
    inst.svc.stopped = true;
    if (inst.svc.timer) clearTimeout(inst.svc.timer);
    inst.off();
    if (byFacts.get(c.facts) === inst.svc) byFacts.delete(c.facts);
    running.delete(c);
  }
}
