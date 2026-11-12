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
//   order?                                   — a number: the place in the adapter list (lower first; default 100, ties — by id);
//   autoLaunch?                              — false: "auto" never picks it for session.launch by "installed" (only by the setting
//                                              or by its sessions — tmux: a new window would land in a detached server);
//   messages?                                — { ru: {code: text}, en: {code: text} }: human texts for the adapter's own error
//                                              codes (from available() and the operations); /state.terminals shows them in the hub
//                                              language. available() → { error, setup: true } means "needs setup" (a human must
//                                              install or allow something) — the shell shows the adapter's text with that mark;
// and one function per declared capability:
//   focus           focus(target, facts)                              → { ok, error? }
//   read-screen     readScreen(target, facts, {sessionId, lines})     → { ok, error?, promptFound, promptEmpty, busy } — flags only;
//   send-text       sendText(target, text, facts, {sessionId})        → { ok, error? } — only into an empty field with no turn running
//                                                                        (the adapter checks before typing and before Enter);
//   send-esc        sendKey(target, "escape", facts, {sessionId})     → { ok, error? };
//   launch          launch({cwd, name, sessionId, promptFile}, facts) → { ok, error?, workspaceId? }; registered?(sessionId, facts,
//                                                                        {workspaceId}) — the launched session has appeared (default:
//                                                                        it is in the core registry).
// A new terminal is a new file in this directory (or, on one Mac, an approved file in <home>/Extensions/terminals — lib/extensions.mjs):
// the adapters are found by a directory scan, the plugin contract (routes, the <agenthub.terminal> permission, error codes) does
// not change.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CAPABILITIES = Object.freeze(["focus", "read-screen", "send-text", "send-esc", "launch"]);
const METHOD = Object.freeze({ focus: "focus", "read-screen": "readScreen", "send-text": "sendText", "send-esc": "sendKey", launch: "launch" });
export const ADAPTER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

// What makes a module an adapter. → null | an error code (the extension loader journals it).
export function adapterProblem(mod) {
  if (!mod || typeof mod !== "object") return "not-a-module";
  if (typeof mod.id !== "string" || !ADAPTER_ID_RE.test(mod.id)) return "bad-id";
  if (typeof mod.locate !== "function") return "no-locate";
  if (mod.capabilities !== undefined && (!Array.isArray(mod.capabilities) || mod.capabilities.some((c) => !CAPABILITIES.includes(c)))) return "bad-capabilities";
  if (mod.label !== undefined && (typeof mod.label !== "string" || !mod.label.trim() || mod.label.length > 40)) return "bad-label";
  return null;
}

const orderOf = (a) => (Number.isFinite(a?.order) ? a.order : 100);
export function sortAdapters(list) {
  return [...list].sort((a, b) => orderOf(a) - orderOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The built-in adapters: every <id>.mjs next to this file (not index.mjs, not _helpers). A broken file is skipped (a test
// catches it; the daemon must still start).
async function scanBuiltin(dir) {
  const out = [];
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && f !== "index.mjs" && !f.startsWith("_") && !f.startsWith("."));
  } catch {}
  for (const f of files.sort()) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      if (!adapterProblem(mod) && !out.some((a) => a.id === mod.id)) out.push(mod);
    } catch {}
  }
  return sortAdapters(out);
}

// Order matters only for a session two adapters could claim: cmux knows its tabs from its own file (order 10); the others go
// by the nearest terminal among the process's ancestors, so at most one of them matches.
export const ADAPTERS = Object.freeze(await scanBuiltin(dirname(fileURLToPath(import.meta.url))));

// The adapter list of a core: built-in plus approved extension adapters (the core provides the "terminal.adapters" fact);
// without it (tests, helpers) — the built-in ones.
export function adaptersOf(facts) {
  let list = null;
  try {
    list = facts?.get?.("terminal.adapters");
  } catch {}
  return Array.isArray(list) && list.length ? list : ADAPTERS;
}

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
export function locate(session, facts, adapters = adaptersOf(facts)) {
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
export function findTab(args, facts, adapters = adaptersOf(facts)) {
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

// The adapter's availability right now. → { ok } | { error, setup? }
export function availability(adapter, facts) {
  if (typeof adapter?.available !== "function") return { ok: true };
  try {
    const r = adapter.available(facts) || { ok: true };
    if (r.error === undefined || r.error === null) return { ok: true };
    const error = typeof r.error === "string" && /^[a-z0-9][a-z0-9-]{0,47}$/.test(r.error) ? r.error : "terminal-failed";
    return r.setup === true ? { error, setup: true } : { error };
  } catch {
    return { error: "terminal-failed" };
  }
}

// Adapters that came from <home>/Extensions/terminals (the extension loader marks them; the module object itself is frozen).
export const EXTENSION_ADAPTERS = new WeakSet();

// The adapter's own human texts for its error codes (the messages export) in the hub language, the other language as a
// fallback: { code: text }, at most 40 codes, texts one line ≤ 200 characters. Bad entries are dropped.
const MESSAGE_CODE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export function adapterMessages(adapter, lang = "ru") {
  const m = adapter?.messages;
  if (!m || typeof m !== "object") return {};
  const out = {};
  for (const l of [lang, lang === "en" ? "ru" : "en"]) {
    const table = m[l];
    if (!table || typeof table !== "object") continue;
    for (const [code, text] of Object.entries(table)) {
      if (Object.keys(out).length >= 40) break;
      if (out[code] !== undefined || !MESSAGE_CODE_RE.test(code) || typeof text !== "string") continue;
      const clean = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      if (clean) out[code] = clean;
    }
  }
  return out;
}

// The session's tab for display (/state.sessions): terminal — the adapter id (contract 3, a string), focusable — the adapter
// can switch to it, terminalInfo — {adapter, label, capabilities, focusable, via} or null (no adapter knows the tab).
// Availability (the cmux bridge) is not included: the shell sees it in /state.terminals and /state.bridge.
export function tabOf(session, facts, adapters = adaptersOf(facts)) {
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
export function launchAdapter(facts, { prefer = "auto", sessions = null, adapters = adaptersOf(facts), exists = existsSync, now = Date.now() } = {}) {
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
    if (a.autoLaunch === false || !supports(a, "launch")) continue;
    if (installedOf(a, exists, now)) return { adapter: a, why: "installed" };
  }
  return null;
}

// launchAdapter from the facts: the setting from actions.config (launchTerminal), the sessions of the core registry.
export function launchFor(facts, adapters = adaptersOf(facts)) {
  const prefer = facts?.get?.("actions.config")?.launchTerminal || "auto";
  let sessions = [];
  try {
    sessions = (facts?.sessions?.() || []).map((s) => ({ terminal: tabOf(s, facts, adapters).terminal }));
  } catch {}
  return launchAdapter(facts, { prefer, sessions, adapters });
}

// Settings → Terminal (/state.terminals): every adapter with what it supports and whether it can run now, plus where a new
// session opens. sessions — /state.sessions (with terminal) for the per-adapter count and the launch choice.
export function terminalsInfo(facts, { prefer = "auto", sessions = [], adapters = adaptersOf(facts), exists = existsSync, now = Date.now() } = {}) {
  let lang = "ru";
  try {
    lang = facts?.lang?.() === "en" ? "en" : "ru";
  } catch {}
  const list = adapters.map((a) => {
    const av = availability(a, facts);
    const texts = adapterMessages(a, lang);
    const reason = av.error || null;
    return {
      id: a.id,
      label: a.label || a.id,
      capabilities: capabilitiesOf(a),
      via: a.via || null,
      installed: installedOf(a, exists, now),
      available: !av.error,
      reason,
      // the adapter's own text for the reason (its messages export), in the hub language; null — the shell's own text for the code
      reasonText: reason ? texts[reason] || null : null,
      // available() said a human must set something up (install a helper, grant a permission): the shell shows reasonText as a setup hint
      needsSetup: Boolean(av.error) && av.setup === true,
      // all of the adapter's texts {code: text} — for refusals of its operations (409 facts:<code>, terminal:<code>)
      messages: texts,
      // where the adapter comes from: "builtin" (lib/terminals) | "extension" (<home>/Extensions/terminals, lib/extensions.mjs)
      source: EXTENSION_ADAPTERS.has(a) ? "extension" : "builtin",
      sessions: sessions.filter((s) => s?.terminal === a.id).length,
    };
  });
  const l = launchAdapter(facts, { prefer, sessions, adapters, exists, now });
  return { adapters: list, launch: l ? { adapter: l.adapter.id, why: l.why } : null, prefer: prefer || "auto" };
}
