// session.interrupt primitive: interrupts the session's current turn by sending Esc to its cmux tab via the bridge.
// Only for a session in the core registry (Claude Code signature verified) and only when agentLifecycle=running
// in ~/.cmuxterm/claude-hook-sessions.json; otherwise Esc would close someone else's dialog or hit an empty prompt.
// The check is repeated right before the key press: the turn may have ended while awaiting confirmation.
// From app only (the core enforces this for session.*).

import { t } from "../i18n.mjs";
import { UUID_SRC, bridgeOf, cfgOf, readCmuxSessions } from "./_actions-support.mjs";

export const name = "session.interrupt";
export const level = "confirm";
// A "stop" direction only reduces spend, so remote channels (once they exist) may use it.
export const remoteAllowed = true;
export const appOnly = true;

export const argsSchema = {
  sessionId: { type: "string", required: true, positional: true, pattern: UUID_SRC },
};

function check(args, facts) {
  const cfg = cfgOf(facts);
  if (!cfg) return { ok: false, reason: "actions-off" };
  const s = facts.session(args.sessionId);
  if (!s) return { ok: false, reason: "unknown-session" };
  const ch = bridgeOf(facts);
  if (!ch?.online()) return { ok: false, reason: "bridge-offline" };
  const e = readCmuxSessions(cfg)?.get(args.sessionId.toLowerCase());
  if (!e) return { ok: false, reason: "no-cmux-session" };
  if (e.pid !== s.pid) return { ok: false, reason: "pid-mismatch" };
  if (e.agentLifecycle !== "running") return { ok: false, reason: "not-running" };
  if (!e.surfaceId || !e.workspaceId) return { ok: false, reason: "no-surface" };
  return { ok: true, s, e, ch };
}

export function verifyFacts(args, facts) {
  const r = check(args, facts);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

export function describe(args, facts, lang = "ru") {
  const s = facts?.session?.(args.sessionId);
  const who = s?.name || args.sessionId.slice(0, 8);
  return { text: t(lang, "prim.session.interrupt", { who }), cost: null };
}

export async function run(args, ctx) {
  const r = check(args, ctx.facts);
  if (!r.ok) return { ok: false, error: r.reason };
  const res = await r.ch.call({ op: "send-key", key: "escape", surfaceId: r.e.surfaceId, workspaceId: r.e.workspaceId, sessionId: args.sessionId });
  return { ok: res.ok, code: res.code ?? null, error: res.error ?? null, pid: r.s.pid };
}
