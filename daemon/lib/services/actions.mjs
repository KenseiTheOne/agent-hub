// actions service (stage 5): the channel to the cmux bridge (the cmux terminal adapter's internal detail, lib/terminals/cmux.mjs),
// tracking of launched sessions (session.launch, any terminal) and facts for action primitives.
//
// Facts:
//   actions.config  — merged config.actions settings (cmux file, session launch) — needed by primitives' verifyFacts;
//   bridge.channel  — the channel to the bridge (call/online/status); bridge routes are in lib/routes/bridge.mjs;
//   bridge.online   — whether the bridge is connected right now.
//
// The bridge protocol is long polling: the bridge (bridge class) sends POST /bridge/hello, then GET /bridge/next?wait=…,
// runs an allowlisted operation and replies POST /bridge/result/:id. An operation the bridge didn't pick up
// within pickupMs is dropped and won't run later (an Esc pressed a minute later would interrupt a different turn).
// Every operation goes to the core journal (bridge-op): metadata only.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { actionsConfig, readCmuxSessions, UUID_RE } from "../primitives/_actions-support.mjs";

export const name = "actions";

// read-screen and send-text (contract 3) are for the terminal layer (lib/terminals/cmux.mjs): /terminal/* routes of trusted
// plugins. For read-screen the bridge returns only input-field indicators; the screen text never reaches the daemon.
export const BRIDGE_OPS = ["surface.focus", "send-key", "new-workspace", "read-screen", "send-text"];

const channels = new Set();
// Margin before the daemon's wait ends after which the bridge no longer presses Enter for send-text: one cmux call (10 s) plus a second.
const ENTER_MARGIN_MS = 11_000;

export class BridgeChannel {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.pickupMs = opts.pickupMs ?? 5_000;
    this.resultMs = opts.resultMs ?? 15_000;
    this.staleMs = opts.staleMs ?? 40_000;
    this.maxWaitMs = opts.maxWaitMs ?? 25_000;
    this.queue = []; // operations not yet handed to the bridge
    this.waiters = []; // pending GET /bridge/next
    this.pending = new Map(); // id → {op, resolve, started, timers}
    this.late = new Map(); // id → {op, sessionId, surfaceId, at}: handed to the bridge but no reply arrived in time (bridge-op-late)
    this.active = null; // {pid, startSec, version, since, lastSeen}
    this.timers = new Set();
    this.closed = false;
  }

  timer(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }
  clear(t) {
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(t);
  }

  online() {
    return Boolean(this.active) && !this.closed && Date.now() - this.active.lastSeen < this.staleMs;
  }
  status() {
    return this.online() ? { online: true, pid: this.active.pid, version: this.active.version, since: this.active.since } : { online: false };
  }

  isActive(peer) {
    return Boolean(this.active) && this.active.pid === peer?.pid && this.active.startSec === (peer?.startSec ?? null);
  }

  // POST /bridge/hello
  hello(peer, body) {
    if (this.online() && !this.isActive(peer)) {
      this.ctx.journal.write({ type: "bridge-busy", bridgePid: peer?.pid, activePid: this.active.pid });
      return { status: 409, body: { error: "bridge:busy" } };
    }
    const version = typeof body?.version === "string" ? body.version.slice(0, 32) : null;
    const now = Date.now();
    const fresh = !this.isActive(peer);
    this.active = { pid: peer?.pid ?? null, startSec: peer?.startSec ?? null, version, since: fresh ? now : this.active.since, lastSeen: now };
    this.wasOnline = true;
    if (fresh) {
      this.ctx.journal.write({ type: "bridge-hello", bridgePid: peer?.pid, version });
      this.ctx.emit({ type: "bridge.connected", pid: peer?.pid ?? null });
    }
    return { status: 200, body: { ok: true, ops: BRIDGE_OPS, maxWaitMs: this.maxWaitMs } };
  }

  // POST /bridge/bye
  bye(peer) {
    if (!this.isActive(peer)) return { status: 409, body: { error: "bridge:not-registered" } };
    this.active = null;
    this.wasOnline = false;
    this.ctx.journal.write({ type: "bridge-bye", bridgePid: peer?.pid });
    this.ctx.emit({ type: "bridge.disconnected", pid: peer?.pid ?? null });
    for (const w of this.waiters.splice(0)) w.done(null);
    return { status: 200, body: { ok: true } };
  }

  // GET /bridge/next — the next operation, or null once wait expires.
  next(peer, waitMs, onClose) {
    if (!this.isActive(peer)) return Promise.resolve({ status: 409, body: { error: "bridge:not-registered" } });
    this.active.lastSeen = Date.now();
    if (this.wasOnline === false) {
      // the bridge polls again after a pause longer than staleMs — online again
      this.wasOnline = true;
      this.ctx.emit({ type: "bridge.connected", pid: peer?.pid ?? null, reason: "resumed" });
    }
    // while the hub is paused handOut drops operations and hands out nothing — take the next one
    while (this.queue.length) {
      const out = this.handOut(this.queue.shift());
      if (out) return Promise.resolve(out);
    }
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), this.maxWaitMs);
    if (!wait) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = {
        done: (op) => {
          this.clear(w.t);
          this.waiters = this.waiters.filter((x) => x !== w);
          if (this.active && this.isActive(peer)) this.active.lastSeen = Date.now();
          resolve(op ? this.handOut(op) : null);
        },
      };
      w.t = this.timer(() => w.done(null), wait);
      this.waiters.push(w);
      onClose?.(() => {
        // the bridge dropped off before replying: don't hand it the operation
        if (this.waiters.includes(w)) {
          this.clear(w.t);
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(null);
        }
      });
    });
  }

  handOut(op) {
    const p = this.pending.get(op.id);
    if (!p) return null;
    // The hub pause was turned on while the operation waited for the bridge: don't hand it out (launch, Esc, switching to a tab — 423 per
    // the pause contract); the operation fails with estop.
    if (this.ctx.estop?.()) {
      p.finish?.({ ok: false, error: "estop" });
      return null;
    }
    p.delivered = true;
    this.clear(p.pickupTimer);
    return { status: 200, body: { op } };
  }

  // An operation for the bridge → Promise<{ok, code?, error?, workspaceId?}>. Never throws.
  call(op, { pickupMs = this.pickupMs, resultMs = this.resultMs } = {}) {
    if (this.closed || !this.online()) {
      this.ctx.journal.write({ type: "bridge-op", op: op?.op, ok: false, error: "bridge-offline" });
      return Promise.resolve({ ok: false, error: "bridge-offline" });
    }
    if (!BRIDGE_OPS.includes(op?.op)) return Promise.resolve({ ok: false, error: "bridge-op-unknown" });
    if (this.ctx.estop?.()) {
      this.ctx.journal.write({ type: "bridge-op", op: op.op, ok: false, error: "estop" });
      return Promise.resolve({ ok: false, error: "estop" });
    }
    const id = randomBytes(8).toString("hex");
    const full = { ...op, id, expiresAt: Date.now() + pickupMs };
    // send-text: Enter no later than enterBy, so the line isn't sent after the daemon told the plugin "not sent"
    // (the margin is the time of one cmux call, no more than half of the wait)
    if (op.op === "send-text") full.enterBy = Date.now() + pickupMs + resultMs - Math.min(ENTER_MARGIN_MS, Math.floor((pickupMs + resultMs) / 2));
    const started = Date.now();
    return new Promise((resolve) => {
      const p = { op: full, started, delivered: false };
      const finish = (res) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.clear(p.pickupTimer);
        this.clear(p.resultTimer);
        this.queue = this.queue.filter((q) => q.id !== id);
        this.ctx.journal.write({
          type: "bridge-op",
          op: full.op,
          opId: id,
          surfaceId: full.surfaceId,
          workspaceId: full.workspaceId || res.workspaceId,
          sessionId: full.sessionId,
          bridgePid: this.active?.pid ?? null,
          ok: Boolean(res.ok),
          code: res.code ?? null,
          error: res.error ?? null,
          ms: Date.now() - started,
        });
        this.ctx.emit({ type: "bridge.op", op: full.op, ok: Boolean(res.ok), error: res.error ?? null });
        resolve(res);
      };
      p.finish = finish;
      p.pickupTimer = this.timer(() => {
        if (!p.delivered) finish({ ok: false, error: "bridge-pickup-timeout" });
      }, pickupMs);
      p.resultTimer = this.timer(() => {
        // the bridge picked up the operation and may still complete it: its late reply goes to the journal (bridge-op-late)
        if (p.delivered) {
          this.late.set(id, { op: full.op, sessionId: full.sessionId, surfaceId: full.surfaceId, at: Date.now() });
          if (this.late.size > 50) this.late.delete(this.late.keys().next().value);
        }
        finish({ ok: false, error: "bridge-timeout" });
      }, pickupMs + resultMs);
      this.pending.set(id, p);
      const w = this.waiters[0];
      if (w) {
        this.queue.push(full);
        w.done(this.queue.shift());
      } else this.queue.push(full);
    });
  }

  // POST /bridge/result/:id
  result(peer, id, body) {
    if (!this.isActive(peer)) return { status: 409, body: { error: "bridge:not-registered" } };
    const p = this.pending.get(id);
    if (!p && this.late.has(id)) {
      const l = this.late.get(id);
      this.late.delete(id);
      this.active.lastSeen = Date.now();
      const b = body && typeof body === "object" ? body : {};
      this.ctx.journal.write({ type: "bridge-op-late", op: l.op, opId: id, sessionId: l.sessionId, surfaceId: l.surfaceId, ok: b.ok === true, error: typeof b.error === "string" ? b.error.slice(0, 64) : null, lateMs: Date.now() - l.at });
      return { status: 200, body: { ok: true } };
    }
    if (!p || !p.delivered) return { status: 404, body: { error: "not-found" } };
    this.active.lastSeen = Date.now();
    const b = body && typeof body === "object" ? body : {};
    const res = { ok: b.ok === true, code: Number.isInteger(b.code) ? b.code : null };
    if (typeof b.error === "string") res.error = b.error.slice(0, 64);
    if (typeof b.workspaceId === "string" && (UUID_RE.test(b.workspaceId) || /^workspace:\d{1,6}$/.test(b.workspaceId))) res.workspaceId = b.workspaceId;
    // input-field indicators (read-screen, send-text) — booleans only; promptEmpty without a field — null
    if (p.op.op === "read-screen" || p.op.op === "send-text") {
      for (const k of ["promptFound", "busy"]) if (typeof b[k] === "boolean") res[k] = b[k];
      if (typeof b.promptEmpty === "boolean" || b.promptEmpty === null) res.promptEmpty = b.promptEmpty;
    }
    p.finish(res);
    return { status: 200, body: { ok: true } };
  }

  // After session.launch: wait until the launched session appears — registered() from the terminal adapter (cmux: its entry
  // with the tab in claude-hook-sessions.json; other terminals: the core session registry); a prompt file launch.sh never
  // read gets deleted. Without registered() — the cmux file (callers before the terminal layer).
  trackLaunch({ sessionId, promptFile, workspaceId = null, registered = null, terminal = null }) {
    const cfg = actionsConfig(this.ctx.config);
    const until = Date.now() + (cfg.launch.registerTimeoutMs || 60_000);
    const step = cfg.launch.pollMs || 500;
    const fromCmux = () => {
      const e = readCmuxSessions(cfg)?.get(String(sessionId).toLowerCase());
      if (!e?.surfaceId) return null;
      if (workspaceId && UUID_RE.test(workspaceId) && e.workspaceId && e.workspaceId.toLowerCase() !== workspaceId.toLowerCase()) return null;
      return e;
    };
    const tick = () => {
      if (this.closed) return;
      let e = null;
      try {
        e = typeof registered === "function" ? registered() : fromCmux();
      } catch {}
      if (e) {
        const surfaceId = e.surfaceId ?? null;
        const ws = e.workspaceId ?? null;
        this.ctx.journal.write({ type: "launch-registered", sessionId, surfaceId, workspaceId: ws, pid: e.pid ?? null, terminal });
        this.ctx.emit({ type: "bridge.launch.registered", sessionId, surfaceId, workspaceId: ws, terminal });
        removePrompt(this.ctx, promptFile, "after-register");
        return;
      }
      if (Date.now() >= until) {
        this.ctx.journal.write({ type: "launch-timeout", sessionId, terminal });
        this.ctx.emit({ type: "bridge.launch.timeout", sessionId, terminal });
        removePrompt(this.ctx, promptFile, "timeout");
        return;
      }
      this.timer(tick, step);
    };
    this.timer(tick, step);
  }

  // The hub pause is on: operations the bridge hasn't picked up are dropped (handed-out ones are already running — they can't be cancelled).
  dropQueued(error = "estop") {
    for (const p of [...this.pending.values()]) if (!p.delivered) p.finish?.({ ok: false, error });
    this.queue = [];
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const w of this.waiters.splice(0)) w.done(null);
    for (const p of [...this.pending.values()]) p.finish?.({ ok: false, error: "bridge-offline" });
    this.queue = [];
  }
}

function removePrompt(ctx, file, why) {
  if (!file) return;
  // the "no Remote Control" marker next to the prompt (session.launch remote:false) goes with it
  rmSync(file.replace(/\.prompt$/, ".local"), { force: true });
  try {
    statSync(file);
  } catch {
    return; // launch.sh has already read and deleted it
  }
  rmSync(file, { force: true });
  ctx.journal.write({ type: "launch-prompt-removed", sessionId: file.split("/").pop().replace(/\.prompt$/, ""), why });
}

// Abandoned prompt files (the daemon was restarted mid-launch) older than 10 minutes are deleted.
function sweepLaunchDir(ctx) {
  const dir = ctx.config?.paths?.home ? join(ctx.config.paths.home, "launch") : null;
  if (!dir) return;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.endsWith(".local")) {
      // a marker whose prompt is already gone: launch.sh never ran for it
      const p = join(dir, n);
      try {
        if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) rmSync(p, { force: true });
      } catch {}
      continue;
    }
    if (!n.endsWith(".prompt")) continue;
    const p = join(dir, n);
    try {
      if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) removePrompt(ctx, p, "stale");
    } catch {}
  }
}

export async function start(ctx) {
  const opts = ctx.config.services?.actions || {};
  const channel = new BridgeChannel(ctx, opts);
  channels.add(channel);
  const cfg = actionsConfig(ctx.config);
  ctx.facts.provide("actions.config", () => cfg);
  ctx.facts.provide("bridge.channel", () => channel);
  ctx.facts.provide("bridge.online", () => channel.online());
  sweepLaunchDir(ctx);
  // A bridge that stopped polling without bye (tab closed, process killed) goes offline after staleMs; the shell learns
  // about it via the bridge.disconnected event (reason: stale), to grey out "Go to tab" without polling /state.
  channel.wasOnline = channel.online();
  const watch = setInterval(() => {
    const now = channel.online();
    if (channel.wasOnline && !now && channel.active) {
      ctx.journal.write({ type: "bridge-stale", bridgePid: channel.active.pid });
      ctx.emit({ type: "bridge.disconnected", pid: channel.active.pid ?? null, reason: "stale" });
    }
    channel.wasOnline = now;
  }, opts.watchMs ?? 5_000);
  watch.unref?.();
  channel.watch = watch;
  const onEstop = (ev) => {
    if (ev?.on) channel.dropQueued("estop");
  };
  ctx.on("estop", onEstop);
  channel.offEstop = () => ctx.off("estop", onEstop);
}

// ctx is the one start received: only this core's channels are stopped (tests can have several cores).
export async function stop(ctx) {
  for (const ch of [...channels]) {
    if (ctx && ch.ctx !== ctx) continue;
    clearInterval(ch.watch);
    ch.offEstop?.();
    ch.close();
    channels.delete(ch);
  }
}
