// Stage 6 routes for the app: cards of pending Claude Code session requests.
//
//   GET /hook/cards       — app: all pending cards (tool, safe summary, AskUserQuestion questions and
//                           options). Question contents go only to the app, not cli.
//   GET /hook/cards/:id   — app: one card or 404.
//   GET /hook/status      — app, cli: metadata only (how many are waiting, which sessions are interactive, pause);
//                           requestIds of pending cards — app only (it's the reply key), cli sees counters.
//
// The hook request itself goes through the built-in POST /hook (core → ctx.onHook → services/hook.mjs).
// A card reply is POST /actions/session.respond (app only). Live changes are SSE events
// hook.card / hook.card.removed / hook.paused (only requestId, sessionId, kind, tool) — app only.

import { hookStateFor } from "../hook/cards.mjs";

function stateOr503(ctx) {
  const st = hookStateFor(ctx.facts);
  return st ? { st } : { res: { status: 503, body: { error: "no-hook-service" } } };
}

export const routes = [
  {
    method: "GET",
    path: "/hook/cards",
    peers: ["app"],
    handler: ({ ctx }) => {
      const { st, res } = stateOr503(ctx);
      if (res) return res;
      // pausedUntil — when the reply pause ends (approval limit): the shell removes the banner by this time
      const paused = st.paused();
      return { status: 200, body: { cards: st.cardsView(), paused, pausedUntil: paused ? new Date(st.pausedUntil).toISOString() : null, estop: ctx.estop() } };
    },
  },
  {
    method: "GET",
    path: "/hook/cards/:id",
    peers: ["app"],
    handler: ({ ctx, params }) => {
      const { st, res } = stateOr503(ctx);
      if (res) return res;
      const c = st.cards.get(params.id);
      return c ? { status: 200, body: st.cardView(c) } : { status: 404, body: { error: "not-found" } };
    },
  },
  {
    method: "GET",
    path: "/hook/status",
    peers: ["app", "cli"],
    handler: ({ ctx, peer }) => {
      const { st, res } = stateOr503(ctx);
      if (res) return res;
      return { status: 200, body: { ...st.statusView({ full: peer?.class === "app" }), estop: ctx.estop() } };
    },
  },
];
