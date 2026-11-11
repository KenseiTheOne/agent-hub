// The terminal.focus primitive — switch to a terminal tab by its id (the surfaceId of a session from the registry or of a
// plugin's own source). The terminal layer (lib/terminals/, findTab) finds the adapter that knows the tab; for cmux it is a
// surface UUID, and the switch runs through the cmux bridge.
// Harmless: available to third-party plugins too (the core's effects ceiling is open.*, terminal.focus, cmux.focus, session.focus),
// level "immediate". Plugins that know the session id should prefer session.focus <sessionId>: the core finds the tab itself.
// cmux.focus is the former name of this primitive: an alias until the next contract (primitives/cmux.focus.mjs).
//
// Refusals (facts:<code>, 409): actions-off, bridge-offline (cmux), unknown-surface — no terminal knows the tab,
// workspace-mismatch — the tab is in another workspace, focus-unsupported, terminal-failed.

import { t } from "../i18n.mjs";
import { availability, canFocus, findTab } from "../terminals/index.mjs";
import { UUID_SRC } from "./_actions-support.mjs";

export const name = "terminal.focus";
export const level = "immediate";
// Switching to a tab on the Mac from afar makes no sense.
export const remoteAllowed = false;

export const argsSchema = {
  surfaceId: { type: "string", required: true, positional: true, pattern: UUID_SRC },
  workspaceId: { type: "string", pattern: UUID_SRC },
};

function target(args, facts) {
  const r = findTab({ surfaceId: args.surfaceId, workspaceId: args.workspaceId }, facts);
  if (r.error) return { ok: false, reason: r.error };
  if (!canFocus(r.adapter)) return { ok: false, reason: "focus-unsupported" };
  const av = availability(r.adapter, facts);
  if (av.error) return { ok: false, reason: av.error };
  return { ok: true, adapter: r.adapter, target: r.target };
}

export function verifyFacts(args, facts) {
  const r = target(args, facts);
  return r.ok ? { ok: true } : r;
}

// The tab — by the session name from the facts (the tab name, -n at launch), otherwise by the start of the id.
export function describe(args, facts, lang = "ru") {
  let name = null;
  try {
    name = facts?.sessions?.().find((s) => s.surfaceId === args.surfaceId)?.name || null;
  } catch {}
  return { text: t(lang, "prim.terminal.focus", { name, id: args.surfaceId.slice(0, 8) }), cost: null };
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
  return { ok: Boolean(res?.ok), code: res?.code ?? null, error: res?.ok ? null : res?.error || "terminal-failed", terminal: r.target.terminal };
}
