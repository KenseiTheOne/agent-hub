// The cmux terminal adapter (contract 3) — the first in the terminal layer (lib/terminals/index.mjs).
//
// Where the session is: cmux knows the tab and workspace of a Claude Code session — the ~/.cmuxterm/claude-hook-sessions.json file (written
// by cmux hooks). Only the binding fields are taken from it (sessionId, pid, surfaceId, workspaceId, agentLifecycle),
// not lastBody. The entry must belong to the same pid as in the core session registry (the Claude Code signature is verified by the core).
//
// How to execute: the daemon has no access to the cmux socket (by design) — read-screen and send-text are executed by the bridge
// in a pinned cmux tab (bridge/agenthub-bridge.mjs, an allowlist). For read-screen the bridge returns only the input field
// flags {promptFound, promptEmpty, busy}; send-text checks the field itself before typing and before Enter; focus is the bridge's
// surface.focus operation (the same as for the cmux.focus primitive).

import { bridgeOf, cfgOf, readCmuxSessions, UUID_RE } from "../primitives/_actions-support.mjs";

export const id = "cmux";

// → { target: {terminal, surfaceId, workspaceId, lifecycle} } | { error } | null (the session is not in this terminal)
export function locate(session, facts) {
  const cfg = cfgOf(facts);
  if (!cfg) return null; // the actions service is off — cmux is unavailable
  const e = readCmuxSessions(cfg)?.get(String(session.sessionId).toLowerCase());
  if (!e) return null;
  if (e.pid !== session.pid) return { error: "pid-mismatch" };
  // the process start time from the cmux entry is the same as that of the process verified by the core (the pid is not reused, the entry
  // is not from a previous process with the same pid); a one-second difference is rounding
  if (Number.isFinite(e.pidStartSeconds) && Number.isFinite(session.startSec) && Math.abs(e.pidStartSeconds - session.startSec) > 1) return { error: "pid-mismatch" };
  if (!e.surfaceId || !e.workspaceId || !UUID_RE.test(e.surfaceId) || !UUID_RE.test(e.workspaceId)) return { error: "no-tab" };
  return { target: { terminal: id, surfaceId: e.surfaceId, workspaceId: e.workspaceId, lifecycle: e.agentLifecycle } };
}

// The session is free according to cmux (agentLifecycle — idle). Only a hint: the terminal service asks for it only when
// the registry has no Claude Code status of its own (after Esc mid-turn cmux stays in "running").
export function idle(target) {
  return target?.lifecycle === "idle";
}

function online(facts) {
  const ch = bridgeOf(facts);
  return ch?.online() ? ch : null;
}

// Bridge errors → the terminal layer's common codes. An older bridge (does not know the operation) — bridge-outdated.
function mapError(e) {
  if (e === "not-allowed") return "bridge-outdated";
  return e || "bridge-failed";
}

// → { ok, error?, promptFound?, promptEmpty?, busy? }
export async function readScreen(target, facts, { sessionId, lines } = {}) {
  const ch = online(facts);
  if (!ch) return { ok: false, error: "bridge-offline" };
  const r = await ch.call({ op: "read-screen", surfaceId: target.surfaceId, workspaceId: target.workspaceId, ...(sessionId ? { sessionId } : {}), ...(lines ? { lines } : {}) });
  if (!r.ok) return { ok: false, error: mapError(r.error) };
  return { ok: true, promptFound: r.promptFound === true, promptEmpty: typeof r.promptEmpty === "boolean" ? r.promptEmpty : null, busy: r.busy === true };
}

// → { ok, error? }
export async function sendText(target, text, facts, { sessionId } = {}) {
  const ch = online(facts);
  if (!ch) return { ok: false, error: "bridge-offline" };
  const r = await ch.call({ op: "send-text", surfaceId: target.surfaceId, workspaceId: target.workspaceId, ...(sessionId ? { sessionId } : {}), text });
  return r.ok ? { ok: true } : { ok: false, error: mapError(r.error) };
}

// Whether the terminal is available right now (before confirmation and switching): the bridge is connected. → { ok } | { error }
export function available(facts) {
  return online(facts) ? { ok: true } : { error: "bridge-offline" };
}

// Switch to the session's tab. → { ok, error? }
export async function focus(target, facts) {
  const ch = online(facts);
  if (!ch) return { ok: false, error: "bridge-offline" };
  const r = await ch.call({ op: "surface.focus", surfaceId: target.surfaceId, workspaceId: target.workspaceId });
  return r.ok ? { ok: true } : { ok: false, error: mapError(r.error) };
}
