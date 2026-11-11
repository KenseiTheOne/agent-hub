// The cmux terminal adapter (lib/terminals/index.mjs describes the interface).
//
// Where the session is: cmux knows the tab and workspace of a Claude Code session — the ~/.cmuxterm/claude-hook-sessions.json file (written
// by cmux hooks). Only the binding fields are taken from it (sessionId, pid, surfaceId, workspaceId, agentLifecycle),
// not lastBody. The entry must belong to the same pid as in the core session registry (the Claude Code signature is verified by the core).
//
// How to execute: the daemon has no access to the cmux socket (by design) — every operation is executed by the cmux bridge
// in a pinned cmux tab (bridge/agenthub-bridge.mjs, an allowlist): surface.focus, send-key escape, new-workspace, read-screen
// (only the input field flags {promptFound, promptEmpty, busy} come back), send-text (the bridge checks the field itself before
// typing and before Enter). The bridge is this adapter's internal detail: without it every operation answers bridge-offline.

import { existsSync } from "node:fs";
import { bridgeOf, cfgOf, findSurface, readCmuxSessions, UUID_RE } from "../primitives/_actions-support.mjs";

export const id = "cmux";
export const label = "cmux";
// The adapter's operations run through the cmux bridge: the shell shows the bridge state and its start command for it.
export const via = "bridge";
export const capabilities = Object.freeze(["focus", "read-screen", "send-text", "send-esc", "launch"]);
export const APP_PATHS = Object.freeze(["/Applications/cmux.app"]);

// → { target: {terminal, tab, surfaceId, workspaceId, lifecycle} } | { error } | null (the session is not in this terminal)
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
  return { target: { terminal: id, tab: e.surfaceId, surfaceId: e.surfaceId, workspaceId: e.workspaceId, lifecycle: e.agentLifecycle } };
}

// A tab by its id (the terminal.focus primitive and its alias cmux.focus): the core session registry, then the cmux file.
// → { target } | { error } | null (not a cmux tab). The order of the refusals is that of the former cmux.focus.
export function findTab({ surfaceId, workspaceId }, facts) {
  const cfg = cfgOf(facts);
  if (!cfg) return { error: "actions-off" };
  if (!online(facts)) return { error: "bridge-offline" };
  const t = findSurface(surfaceId, facts, cfg);
  if (!t) return null;
  if (workspaceId && workspaceId.toLowerCase() !== t.workspaceId.toLowerCase()) return { error: "workspace-mismatch" };
  return { target: { terminal: id, tab: t.surfaceId, surfaceId: t.surfaceId, workspaceId: t.workspaceId } };
}

// The session is free according to cmux (agentLifecycle — idle). Only a hint: the terminal service asks for it only when
// the registry has no Claude Code status of its own (after Esc mid-turn cmux stays in "running").
export function idle(target) {
  return target?.lifecycle === "idle";
}

// A turn is running according to cmux (session.interrupt presses Esc only then: otherwise Esc would close someone else's
// dialog or hit an empty prompt).
export function running(target) {
  return target?.lifecycle === "running";
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

// Whether the terminal is available right now (before confirmation and switching): the bridge is connected. → { ok } | { error }
export function available(facts) {
  return online(facts) ? { ok: true } : { error: "bridge-offline" };
}

// Installed on this Mac (Settings → Terminal). exists — a double in tests.
export function installed({ exists = existsSync } = {}) {
  return APP_PATHS.some((p) => exists(p));
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

// Esc in the session's tab (session.interrupt). The bridge knows only escape. → { ok, error?, code? }
export async function sendKey(target, key, facts, { sessionId } = {}) {
  if (key !== "escape") return { ok: false, error: "bad-key" };
  const ch = online(facts);
  if (!ch) return { ok: false, error: "bridge-offline" };
  const r = await ch.call({ op: "send-key", key: "escape", surfaceId: target.surfaceId, workspaceId: target.workspaceId, ...(sessionId ? { sessionId } : {}) });
  return { ok: Boolean(r.ok), error: r.ok ? null : mapError(r.error), code: r.code ?? null };
}

// Switch to the session's tab. → { ok, error? }
export async function focus(target, facts) {
  const ch = online(facts);
  if (!ch) return { ok: false, error: "bridge-offline" };
  const r = await ch.call({ op: "surface.focus", surfaceId: target.surfaceId, workspaceId: target.workspaceId });
  return { ok: Boolean(r.ok), error: r.ok ? null : mapError(r.error), code: r.code ?? null };
}

// A new tab with a Claude Code session (session.launch): the bridge runs cmux new-workspace with bridge/launch.sh.
// → { ok, error?, code?, workspaceId? }
export async function launch({ cwd, name, sessionId, promptFile }, facts) {
  const ch = online(facts);
  if (!ch) return { ok: false, error: "bridge-offline" };
  const r = await ch.call({ op: "new-workspace", cwd, name, sessionId, promptFile }, { resultMs: 20_000 });
  if (!r.ok) return { ok: false, error: r.error ?? null, code: r.code ?? null };
  return { ok: true, workspaceId: r.workspaceId || null };
}

// The launched session has appeared: cmux wrote it with its tab to claude-hook-sessions.json (in the workspace the bridge
// reported, if any). → { surfaceId, workspaceId, pid } | null
export function registered(sessionId, facts, { workspaceId = null } = {}) {
  const cfg = cfgOf(facts);
  if (!cfg) return null;
  const e = readCmuxSessions(cfg)?.get(String(sessionId).toLowerCase());
  if (!e?.surfaceId) return null;
  if (workspaceId && UUID_RE.test(workspaceId) && e.workspaceId && e.workspaceId.toLowerCase() !== workspaceId.toLowerCase()) return null;
  return { surfaceId: e.surfaceId, workspaceId: e.workspaceId, pid: e.pid };
}
