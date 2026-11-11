// The terminal layer: everything the hub does with the terminal tab of a Claude Code session goes through here — switch to the
// tab, read the end of the screen, type a line, press Esc, open a new tab with a session. The core, the primitives
// (session.focus, terminal.focus, session.interrupt, session.launch) and the /terminal/* routes know only this interface; each
// terminal is a built-in adapter file next to it (a separate kind of extension, not a plugin: it ships with the hub).
//
// An adapter exports:
//   id, label                                — "tmux", "tmux"; label is what the shell shows;
//   capabilities                             — the operations it supports, from CAPABILITIES; the hub refuses the rest
//                                              (terminal:unsupported, <capability>-unsupported) and the shell disables their buttons;
//   via?                                     — "bridge": operations run through the cmux bridge (the shell shows its state);
//   locate(session, facts)                   → { target } | { error } | null (the session is not in this terminal); session —
//                                              a registry entry with the pid and startSec of the verified process: the tab must
//                                              belong to the same process (pid-mismatch). Cheap: called for every /state;
//     target: { terminal, tab, … }           — tab is a stable key of the tab for rates and the journal; the rest is the adapter's;
//   idle(target)                             → the session is free according to the terminal — a hint when the registry has no
//                                              Claude Code status of its own;
//   running?(target)                         → a turn is running according to the terminal (no such method: the registry status);
//   available?(facts)                        → { ok } | { error }: whether operations can run right now (cmux: bridge-offline);
//   installed?({exists})                     → the terminal is on this Mac (Settings → Terminal, picking where to launch);
//   findTab?({surfaceId, workspaceId}, facts) → { target } | { error } | null — a tab by its id (terminal.focus);
// and one function per declared capability:
//   focus           focus(target, facts)                              → { ok, error? }
//   read-screen     readScreen(target, facts, {sessionId, lines})     → { ok, error?, promptFound, promptEmpty, busy } — flags only;
//   send-text       sendText(target, text, facts, {sessionId})        → { ok, error? } — only into an empty field with no turn running
//                                                                        (the adapter checks before typing and before Enter);
//   send-esc        sendKey(target, "escape", facts, {sessionId})     → { ok, error? };
//   launch          launch({cwd, name, sessionId, promptFile}, facts) → { ok, error?, workspaceId? }; registered?(sessionId, facts,
//                                                                        {workspaceId}) — the launched session has appeared (default:
//                                                                        it is in the core registry).
// A new terminal is a new file and a line in ADAPTERS: the plugin contract (routes, the <agenthub.terminal> permission, error codes)
// does not change.

import { existsSync } from "node:fs";
import * as cmux from "./cmux.mjs";
import * as tmux from "./tmux.mjs";
import * as iterm2 from "./iterm2.mjs";
import * as terminalApp from "./terminal-app.mjs";

// Order matters only for a session two adapters could claim: cmux knows its tabs from its own file; the others go by the
// nearest terminal among the process's ancestors, so at most one of them matches.
export const ADAPTERS = Object.freeze([cmux, tmux, iterm2, terminalApp]);

export const CAPABILITIES = Object.freeze(["focus", "read-screen", "send-text", "send-esc", "launch"]);
const METHOD = Object.freeze({ focus: "focus", "read-screen": "readScreen", "send-text": "sendText", "send-esc": "sendKey", launch: "launch" });

// The adapter declares the capability and has the function for it.
export function supports(adapter, cap) {
  return Boolean(adapter) && Array.isArray(adapter.capabilities) && adapter.capabilities.includes(cap) && typeof adapter[METHOD[cap]] === "function";
}

// Whether the adapter can switch to the tab.
export const canFocus = (adapter) => supports(adapter, "focus");

export function capabilitiesOf(adapter) {
  return CAPABILITIES.filter((c) => supports(adapter, c));
}

export function byId(id, adapters = ADAPTERS) {
  return adapters.find((a) => a.id === id) || null;
}

// The first adapter that knows the session's tab. → { adapter, target } | { error }
export function locate(session, facts, adapters = ADAPTERS) {
  let err = null;
  for (const a of adapters) {
    let r = null;
    try {
      r = a.locate(session, facts);
    } catch {
      r = { error: "terminal-failed" };
    }
    if (r?.target) return { adapter: a, target: r.target };
    if (r?.error && !err) err = r.error;
  }
  return { error: err || "no-tab" };
}

// A tab by its id (terminal.focus, cmux.focus): the first adapter that knows it. → { adapter, target } | { error }
export function findTab(args, facts, adapters = ADAPTERS) {
  for (const a of adapters) {
    if (typeof a.findTab !== "function") continue;
    let r = null;
    try {
      r = a.findTab(args, facts);
    } catch {
      r = { error: "terminal-failed" };
    }
    if (r?.target) return { adapter: a, target: r.target };
    if (r?.error) return { error: r.error };
  }
  return { error: "unknown-surface" };
}

// The adapter's availability right now. → { ok } | { error }
export function availability(adapter, facts) {
  if (typeof adapter?.available !== "function") return { ok: true };
  try {
    return adapter.available(facts) || { ok: true };
  } catch {
    return { error: "terminal-failed" };
  }
}

// The session's tab for display (/state.sessions): terminal — the adapter id (contract 3, a string), focusable — the adapter
// can switch to it, terminalInfo — {adapter, label, capabilities, focusable, via} or null (no adapter knows the tab).
// Availability (the cmux bridge) is not included: the shell sees it in /state.terminals and /state.bridge.
export function tabOf(session, facts, adapters = ADAPTERS) {
  const none = { terminal: null, focusable: false, terminalInfo: null };
  if (!session || !Number.isInteger(session.pid)) return none;
  const loc = locate(session, facts, adapters);
  if (loc.error) return none;
  const a = loc.adapter;
  const focusable = canFocus(a);
  return { terminal: a.id, focusable, terminalInfo: { adapter: a.id, label: a.label || a.id, capabilities: capabilitiesOf(a), focusable, via: a.via || null } };
}

const installedCache = new Map(); // id → { at, value }
function installedOf(a, exists, now) {
  if (typeof a.installed !== "function") return null;
  const hit = exists === existsSync ? installedCache.get(a.id) : null;
  if (hit && now - hit.at < 60_000) return hit.value;
  let value = null;
  try {
    value = Boolean(a.installed({ exists }));
  } catch {}
  if (exists === existsSync) installedCache.set(a.id, { at: now, value });
  return value;
}

// Where session.launch opens a new tab. prefer — services.terminal.launch: an adapter id or "auto". Auto: the terminal most live
// sessions run in (ties — ADAPTERS order); no sessions — the first installed of cmux, iTerm2, Terminal (tmux only by the setting
// or by its sessions: a new window would open in a detached server). → { adapter, why: "setting"|"sessions"|"installed" } | null
export function launchAdapter(facts, { prefer = "auto", sessions = null, adapters = ADAPTERS, exists = existsSync, now = Date.now() } = {}) {
  if (prefer && prefer !== "auto") {
    const a = byId(prefer, adapters);
    return a && supports(a, "launch") ? { adapter: a, why: "setting" } : null;
  }
  const counts = new Map();
  for (const s of sessions || []) {
    const id = s?.terminal;
    if (typeof id === "string") counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = null;
  for (const a of adapters) {
    if (!supports(a, "launch")) continue;
    const n = counts.get(a.id) || 0;
    if (n > 0 && (!best || n > best.n)) best = { a, n };
  }
  if (best) return { adapter: best.a, why: "sessions" };
  for (const a of adapters) {
    if (a.id === tmux.id || !supports(a, "launch")) continue;
    if (installedOf(a, exists, now)) return { adapter: a, why: "installed" };
  }
  return null;
}

// launchAdapter from the facts: the setting from actions.config (launchTerminal), the sessions of the core registry.
export function launchFor(facts, adapters = ADAPTERS) {
  const prefer = facts?.get?.("actions.config")?.launchTerminal || "auto";
  let sessions = [];
  try {
    sessions = (facts?.sessions?.() || []).map((s) => ({ terminal: tabOf(s, facts, adapters).terminal }));
  } catch {}
  return launchAdapter(facts, { prefer, sessions, adapters });
}

// Settings → Terminal (/state.terminals): every adapter with what it supports and whether it can run now, plus where a new
// session opens. sessions — /state.sessions (with terminal) for the per-adapter count and the launch choice.
export function terminalsInfo(facts, { prefer = "auto", sessions = [], adapters = ADAPTERS, exists = existsSync, now = Date.now() } = {}) {
  const list = adapters.map((a) => {
    const av = availability(a, facts);
    return {
      id: a.id,
      label: a.label || a.id,
      capabilities: capabilitiesOf(a),
      via: a.via || null,
      installed: installedOf(a, exists, now),
      available: !av.error,
      reason: av.error || null,
      sessions: sessions.filter((s) => s?.terminal === a.id).length,
    };
  });
  const l = launchAdapter(facts, { prefer, sessions, adapters, exists, now });
  return { adapters: list, launch: l ? { adapter: l.adapter.id, why: l.why } : null, prefer: prefer || "auto" };
}
