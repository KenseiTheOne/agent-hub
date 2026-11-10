// The terminal layer (contract 3): "read a tab's screen" and "type a line into a tab" of a Claude Code session.
//
// The core and the /terminal/* route know only this interface; each terminal is its own adapter file next to it:
//   id                                       — the terminal name ("cmux"), goes into the journal and the response to the plugin;
//   locate(session, facts)                   → { target } | { error } | null (the session is not in this terminal); session —
//                                              a registry entry with the pid and startSec of the verified process: the tab must
//                                              belong to the same process (pid-mismatch);
//     target: { terminal, surfaceId, workspaceId?, lifecycle? } — what the adapter needs for the operation;
//   idle(target)                             → the session is free according to the terminal (no turn running, no question) —
//                                              a hint for when the registry has no Claude Code status of its own;
//   readScreen(target, facts, {sessionId, lines}) → { ok, error?, promptFound, promptEmpty, busy } — only input field
//                                              flags, without the screen text;
//   sendText(target, text, facts, {sessionId})    → { ok, error? } — type a line and Enter, only if the field is empty and
//                                              no turn is running (the adapter itself checks before typing and before Enter);
//   focus(target, facts)                     → { ok, error? } — switch to the session's tab (the session.focus primitive).
//                                              Optional: an adapter that cannot focus does not declare it —
//                                              the primitive then answers focus-unsupported, the shell does not draw the button;
//   available(facts)                         → { ok } | { error } — optional: whether operations can be run right now
//                                              (cmux: the bridge is connected, otherwise bridge-offline).
// There is one adapter for now — cmux (via the bridge). tmux, kitty, WezTerm and iTerm2 are added with an adapter file and a line in
// ADAPTERS: the plugin contract (routes, the <agenthub.terminal> permission, error codes) does not change.

import * as cmux from "./cmux.mjs";

export const ADAPTERS = Object.freeze([cmux]);

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

// The session's tab for display (/state.sessions): { terminal, focusable } — the adapter found the tab and can switch to it.
// Adapter availability (the bridge) is not taken into account: the shell sees it separately (/state.bridge).
export function tabOf(session, facts, adapters = ADAPTERS) {
  if (!session || !Number.isInteger(session.pid)) return { terminal: null, focusable: false };
  const loc = locate(session, facts, adapters);
  if (loc.error) return { terminal: null, focusable: false };
  return { terminal: loc.adapter.id, focusable: canFocus(loc.adapter) };
}

// Whether the adapter can switch to the tab.
export const canFocus = (adapter) => typeof adapter?.focus === "function";
