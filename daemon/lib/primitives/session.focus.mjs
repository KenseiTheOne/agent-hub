// The session.focus primitive — switch to a Claude Code session's tab (contract 3).
// The plugin does not need to know the terminal: the terminals layer (lib/terminals/, locate) finds the tab from the core's session registry,
// and the adapter switches to it (focus; for cmux — the bridge operation surface.focus). Harmless, like cmux.focus: level "immediate",
// available to cli and third-party plugins (the core effects ceiling — open.*, cmux.focus, session.focus).
//
// Refusals (facts:<code>, 409): unknown-session — the session is not in the registry; no-terminal — no adapter knows its tab;
// pid-mismatch — the terminal tab belongs to another process; focus-unsupported — the adapter cannot switch; the adapter's
// code if it is currently unavailable (cmux: bridge-offline). A failure of the switch itself — ok: false with the adapter's code.

import { t } from "../i18n.mjs";
import { canFocus, locate } from "../terminals/index.mjs";
import { UUID_SRC } from "./_actions-support.mjs";

export const name = "session.focus";
export const level = "immediate";
// Switching tabs on the Mac remotely makes no sense.
export const remoteAllowed = false;

export const argsSchema = {
  sessionId: { type: "string", required: true, positional: true, pattern: UUID_SRC },
};

// Registry entry (id is case-insensitive).
function sessionOf(id, facts) {
  const want = String(id).toLowerCase();
  return facts?.session?.(id) || facts?.sessions?.().find((s) => typeof s.sessionId === "string" && s.sessionId.toLowerCase() === want) || null;
}

// → { ok, adapter, target, s } | { ok: false, reason }
function target(args, facts) {
  const s = sessionOf(args.sessionId, facts);
  if (!s || !Number.isInteger(s.pid)) return { ok: false, reason: "unknown-session" };
  const loc = locate(s, facts);
  if (loc.error) return { ok: false, reason: loc.error === "no-tab" ? "no-terminal" : loc.error };
  if (!canFocus(loc.adapter)) return { ok: false, reason: "focus-unsupported" };
  const avail = typeof loc.adapter.available === "function" ? loc.adapter.available(facts) : null;
  if (avail?.error) return { ok: false, reason: avail.error };
  return { ok: true, s, adapter: loc.adapter, target: loc.target };
}

export function verifyFacts(args, facts) {
  const r = target(args, facts);
  return r.ok ? { ok: true } : r;
}

// Session name from the registry (not the auto-title from the conversation), otherwise the start of the id.
export function describe(args, facts, lang = "ru") {
  let s = null;
  try {
    s = sessionOf(args.sessionId, facts);
  } catch {}
  const name = s && s.nameSource !== "auto" && typeof s.name === "string" && s.name ? s.name : null;
  return { text: t(lang, "prim.session.focus", { name, id: args.sessionId.slice(0, 8) }), cost: null };
}

export async function run(args, ctx) {
  const r = target(args, ctx.facts);
  if (!r.ok) return { ok: false, error: r.reason };
  let res;
  try {
    res = await r.adapter.focus(r.target, ctx.facts);
  } catch {
    res = { ok: false, error: "terminal-failed" };
  }
  return { ok: Boolean(res?.ok), error: res?.ok ? null : res?.error || "terminal-failed", terminal: r.target.terminal };
}
