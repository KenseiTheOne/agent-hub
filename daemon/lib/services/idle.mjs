// The idle service: the "can the computer be shut down" verdict (lib/idle.mjs) — /state.idle and the idle.verdict event on change.
//
// Recomputed on any bus event (except its own idle.*), coalesced to one per tick (setImmediate): plugin frames
// (activity= / needsOn=), sessions, hook cards, hub update progress, plugin installs (plugins.busy), plugin
// actions (action.started / action), language change. A single timer — for the nextAt deadline from the computation: the end of "checking" after
// start (verdict null until every plugin has sent its first frame, no longer than WARMUP_MS) and the moment a verdict
// participant went silent (stale) — no event fires for that.
// services.idle.enabled = false — no service, /state.idle = null.

import { computeIdle } from "../idle.mjs";

export const name = "idle";

// The idle.state fact — one per core (facts): survives a service restart in the same core.
const byFacts = new WeakMap();

function signature(v) {
  return JSON.stringify([v.verdict, v.items, v.checked]);
}

// The recompute timer is never further than this (setTimeout overflows on long delays, and the clock can shift).
const MAX_WAKE_MS = 10 * 60_000;

class IdleState {
  constructor(ctx) {
    this.ctx = ctx;
    this.cur = null;
    this.sig = null;
    this.hubInstall = undefined; // undefined — the hub.update fact has not been read yet; null — no service
    this.pending = null;
    this.stopped = false;
    this.startedAt = Date.now();
    this.wakeTimer = null;
  }

  inputs() {
    const { ctx } = this;
    if (this.hubInstall === undefined) {
      const hu = ctx.facts.get("hub.update");
      this.hubInstall = hu && typeof hu === "object" ? hu.install || { phase: "idle" } : null;
    }
    const cards = ctx.facts.get("hook.pending");
    const busy = ctx.facts.get("plugins.busy");
    const actions = ctx.facts.runningActions ? ctx.facts.runningActions() : [];
    return {
      lang: ctx.lang(),
      sessions: ctx.sessions.list(),
      cards: Array.isArray(cards) ? cards : null,
      plugins: ctx.state.pluginSignals(),
      hubInstall: this.hubInstall,
      pluginsBusy: Array.isArray(busy) ? busy : null,
      actions: Array.isArray(actions) ? actions : [],
      now: Date.now(),
      startedAt: this.startedAt,
    };
  }

  // Recompute; emit — broadcast idle.verdict if the verdict, the lines or "checked" changed.
  refresh({ emit = true } = {}) {
    let v;
    try {
      v = computeIdle(this.inputs());
    } catch (e) {
      this.ctx.journal.write({ type: "warning", detail: `idle: ${String(e?.message || e).slice(0, 160)}` });
      return this.cur;
    }
    const { nextAt, ...out } = v;
    this.wake(nextAt);
    const sig = signature(out);
    if (sig === this.sig) return this.cur;
    const since = !this.cur || this.cur.verdict !== out.verdict ? new Date().toISOString() : this.cur.since;
    this.cur = { ...out, since };
    this.sig = sig;
    if (emit) this.ctx.emit({ type: "idle.verdict", idle: this.state() });
    return this.cur;
  }

  state() {
    const v = this.cur || this.refresh({ emit: false });
    return v ? structuredClone(v) : null;
  }

  // Recompute at the nextAt deadline (end of "checking", a plugin went silent); null — no deadline.
  wake(at) {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.stopped || !Number.isFinite(at)) return;
    const ms = Math.min(MAX_WAKE_MS, Math.max(0, at - Date.now()) + 50);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.schedule();
    }, ms);
    this.wakeTimer.unref?.();
  }

  schedule() {
    if (this.pending || this.stopped) return;
    this.pending = setImmediate(() => {
      this.pending = null;
      if (!this.stopped) this.refresh();
    });
  }
}

const running = new Map(); // ctx → { st, off }

export async function start(ctx) {
  const st = new IdleState(ctx);
  const onEvent = (ev) => {
    const type = String(ev?.type || "");
    if (type.startsWith("idle.")) return;
    if (type === "hub-update.status") st.hubInstall = ev.hubUpdate && typeof ev.hubUpdate === "object" ? ev.hubUpdate.install || { phase: "idle" } : null;
    st.schedule();
  };
  ctx.on("event", onEvent);
  // services after this one (plugins) publish their facts later: recompute once all have started
  const onStarted = () => st.schedule();
  ctx.on("services.started", onStarted);
  byFacts.set(ctx.facts, st);
  try {
    ctx.facts.provide("idle.state", () => byFacts.get(ctx.facts)?.state() ?? null);
  } catch {} // already exists from a previous start in this core
  running.set(ctx, {
    st,
    off: () => {
      ctx.off("event", onEvent);
      ctx.off("services.started", onStarted);
    },
  });
  st.refresh({ emit: false });
}

export async function stop(ctx) {
  for (const [c, inst] of [...running]) {
    if (ctx && c !== ctx) continue;
    inst.st.stopped = true;
    if (inst.st.pending) clearImmediate(inst.st.pending);
    if (inst.st.wakeTimer) clearTimeout(inst.st.wakeTimer);
    inst.off();
    if (byFacts.get(c.facts) === inst.st) byFacts.delete(c.facts);
    running.delete(c);
  }
}
