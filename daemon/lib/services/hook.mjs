// Stage 6 service: answering Claude Code sessions through the agenthub-hook hook.
//
// Registers the POST /hook handler (ctx.onHook): SessionStart/SessionEnd/Stop — the registry of interactive
// sessions and card removal; PermissionRequest — a card and waiting for a decision from the app
// (the session.respond primitive). Logic — lib/hook/cards.mjs; routes for the app — routes/hook.mjs.
//
// Settings — config.services.hook.* on top of HOOK_DEFAULTS (waitMs, maxApprovalsPerMinute, pauseMs,
// maxRequestsPerMinute, maxPending, interactiveKinds, interactiveEntrypoints, skipTools, sweepMs).

import { HOOK_DEFAULTS, HookState, hookStateFor } from "../hook/cards.mjs";

export const name = "hook";

// Instances per core (tests sometimes run several daemons in one process).
const running = new Set();

export async function start(ctx) {
  const cfg = ctx.config.services?.hook || {};
  const opts = {};
  for (const k of Object.keys(HOOK_DEFAULTS)) if (cfg[k] !== undefined) opts[k] = cfg[k];
  const st = new HookState(ctx, opts);
  const inst = { st, offs: [], timer: null, ctx };

  // The core's second argument: { peer } (and signal, if the core passes it — then a dropped
  // agenthub-hook connection removes the card immediately).
  inst.offs.push(ctx.onHook((body, extra) => st.onHook(body, extra || {})));

  const onSessions = (ev) => st.onSessions(ev.sessions);
  ctx.on("sessions", onSessions);
  inst.offs.push(() => ctx.off("sessions", onSessions));

  const onEstop = (ev) => {
    if (ev.on) st.cancelAll("estop");
  };
  ctx.on("estop", onEstop);
  inst.offs.push(() => ctx.off("estop", onEstop));

  // Facts for other extensions (metadata only). Via hookStateFor — they survive a service restart.
  const facts = ctx.facts;
  for (const [fact, fn] of [
    ["hook.pending", (requestId) => hookStateFor(facts)?.pendingFact(requestId) ?? null],
    ["hook.interactive", (sessionId) => {
      const s = hookStateFor(facts);
      if (!s) return sessionId === undefined ? [] : false;
      return sessionId === undefined ? [...s.interactive.keys()] : s.interactive.has(sessionId);
    }],
  ]) {
    try {
      facts.provide(fact, fn);
    } catch {} // already exists from a previous start in this core
  }

  inst.timer = setInterval(() => st.sweep().catch(() => {}), st.opts.sweepMs);
  inst.timer.unref();
  running.add(inst);
}

// ctx — the one start received: the core passes it, and only that core's service stops.
// Without ctx (legacy call) — every instance in the process.
export async function stop(ctx) {
  for (const inst of [...running]) {
    if (ctx && inst.ctx !== ctx) continue;
    clearInterval(inst.timer);
    for (const off of inst.offs.splice(0)) {
      try {
        off();
      } catch {}
    }
    inst.st.detach();
    running.delete(inst);
  }
}
