// session.interrupt primitive: interrupts the session's current turn by pressing Esc in its terminal tab (the terminal layer,
// lib/terminals/: cmux — through the bridge, tmux — send-keys Escape). Only for a session in the core registry (Claude Code
// signature verified), whose terminal supports Esc (send-esc), and only while a turn is running — according to the terminal
// if it knows (cmux: agentLifecycle=running in ~/.cmuxterm/claude-hook-sessions.json), otherwise the registry status (busy);
// otherwise Esc would close someone else's dialog or hit an empty prompt.
// The check is repeated right before the key press: the turn may have ended in between.
// Level "immediate" (the same as pressing Esc in the tab), from app only (the core enforces this for session.*).
//
// Refusals (facts:<code>): actions-off, unknown-session, external-session (a non-Claude agent session, G13), no-terminal (no adapter knows the tab), pid-mismatch, esc-unsupported
// (the session's terminal cannot press Esc), the adapter's code when it is unavailable (bridge-offline), not-running.

import { availability, locate, supports } from "../terminals/index.mjs";
import { EXTERNAL_SESSION_SRC, cfgOf } from "./_actions-support.mjs";

export const name = "session.interrupt";
export const level = "immediate";
// A "stop" direction only reduces spend, so remote channels (once they exist) may use it.
export const remoteAllowed = true;
export const appOnly = true;

export const argsSchema = {
  // a UUID (Claude Code) or an external agent session id (G13; UUIDs match this pattern too): a non-Claude session must get its
  // documented refusal facts:external-session, not a pattern error (B8); any other non-UUID id is facts:unknown-session
  sessionId: { type: "string", required: true, positional: true, pattern: EXTERNAL_SESSION_SRC },
};

function check(args, facts) {
  // a non-Claude agent session (G13): only session.focus works for it — refused before anything else
  if (!facts.session(args.sessionId) && facts.externalSession?.(args.sessionId)) return { ok: false, reason: "external-session" };
  const cfg = cfgOf(facts);
  if (!cfg) return { ok: false, reason: "actions-off" };
  const s = facts.session(args.sessionId);
  if (!s || !Number.isInteger(s.pid)) return { ok: false, reason: "unknown-session" };
  const loc = locate(s, facts);
  if (loc.error) return { ok: false, reason: loc.error === "no-tab" ? "no-terminal" : loc.error };
  if (!supports(loc.adapter, "send-esc")) return { ok: false, reason: "esc-unsupported", terminal: loc.adapter.id };
  const av = availability(loc.adapter, facts);
  if (av.error) return { ok: false, reason: av.error };
  const running = typeof loc.adapter.running === "function" ? loc.adapter.running(loc.target) : s.status === "busy";
  if (!running) return { ok: false, reason: "not-running" };
  return { ok: true, s, adapter: loc.adapter, target: loc.target };
}

export function verifyFacts(args, facts) {
  const r = check(args, facts);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

export async function run(args, ctx) {
  const r = check(args, ctx.facts);
  if (!r.ok) return { ok: false, error: r.reason };
  let res;
  try {
    res = await r.adapter.sendKey(r.target, "escape", ctx.facts, { sessionId: args.sessionId });
  } catch {
    res = { ok: false, error: "terminal-failed" };
  }
  return { ok: Boolean(res?.ok), code: res?.code ?? null, error: res?.ok ? null : res?.error || "terminal-failed", pid: r.s.pid, terminal: r.target.terminal };
}
