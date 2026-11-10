// The cmux.focus primitive — switch to a cmux tab (surface) via the bridge.
// Harmless: available to third-party plugins too (the core's effects ceiling is open.* and cmux.focus), level "immediate".
// The tab must be known to the core: from the session registry or from ~/.cmuxterm/claude-hook-sessions.json.

import { t } from "../i18n.mjs";
import { UUID_SRC, bridgeOf, cfgOf, findSurface } from "./_actions-support.mjs";

export const name = "cmux.focus";
export const level = "immediate";
// Switching to a tab on the Mac from afar makes no sense.
export const remoteAllowed = false;

export const argsSchema = {
  surfaceId: { type: "string", required: true, positional: true, pattern: UUID_SRC },
  workspaceId: { type: "string", pattern: UUID_SRC },
};

function target(args, facts) {
  const cfg = cfgOf(facts);
  if (!cfg) return { ok: false, reason: "actions-off" };
  const ch = bridgeOf(facts);
  if (!ch?.online()) return { ok: false, reason: "bridge-offline" };
  const t = findSurface(args.surfaceId, facts, cfg);
  if (!t) return { ok: false, reason: "unknown-surface" };
  if (args.workspaceId && args.workspaceId.toLowerCase() !== t.workspaceId.toLowerCase()) return { ok: false, reason: "workspace-mismatch" };
  return { ok: true, ch, t };
}

export function verifyFacts(args, facts) {
  const r = target(args, facts);
  return r.ok ? { ok: true } : r;
}

// The tab — by the session name from the facts (the cmux tab name, -n at launch), otherwise by the start of the id.
export function describe(args, facts, lang = "ru") {
  let name = null;
  try {
    name = facts?.sessions?.().find((s) => s.surfaceId === args.surfaceId)?.name || null;
  } catch {}
  return { text: t(lang, "prim.cmux.focus", { name, id: args.surfaceId.slice(0, 8) }), cost: null };
}

export async function run(args, ctx) {
  const r = target(args, ctx.facts);
  if (!r.ok) return { ok: false, error: r.reason };
  const res = await r.ch.call({ op: "surface.focus", surfaceId: r.t.surfaceId, workspaceId: r.t.workspaceId });
  return { ok: res.ok, code: res.code ?? null, error: res.error ?? null };
}
