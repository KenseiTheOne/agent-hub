// Plugin tiers and what each tier may do: the effects ceiling of third-party plugins, primitives accepted only from
// the app, who counts as trusted, the connections a trusted plugin may declare, what is left of a community plugin's
// push rules. Constants and pure functions over a plugin's state ({source, granted, meta}) — no Core here.
// lib/core.mjs re-exports the public names.

import { connectionIdOf, splitWhy } from "../meta.mjs";
import { PLUGIN_KIND } from "../push/prefs.mjs";

// What a third-party plugin may offer, whatever its metadata says.
export const THIRD_PARTY_EFFECTS = ["open.*", "terminal.focus", "cmux.focus", "session.focus"];
// Primitive aliases: the old name is still accepted until the next contract (docs mark it deprecated). A plugin that declared one
// name in <agenthub.effects> may offer the other.
export const PRIMITIVE_ALIASES = Object.freeze({ "cmux.focus": "terminal.focus" });
const canonical = (name) => PRIMITIVE_ALIASES[name] || name;
export const LOCAL_EFFECTS = ["open.*"];
// Primitives accepted only from app, regardless of what the module declared.
// Controlling external agents (launchers, schedulers) is not a core primitive but a declared plugin action.
export const APP_ONLY = /^(session\.(respond|launch|stop|interrupt)|process\.)/;
// Plugin tiers. Taken only from the install location and the signed registry index (plugins.lock),
// never from the plugin's own metadata.
// own — your own plugin from a local folder that a human approved in the app (manager, Plugins/<id>, a
// plugins.lock entry with tier own): trusted like an official one.
export const TIERS = ["builtin", "official", "own", "community", "local"];
// Trusted plugin: builtin, official (per the signed index) or own (approved by a human in the
// app). Only per the manager's policy (pl.granted), not per metadata. They get actions, their own push rules,
// service variables (AGENTHUB_USAGE_FILE etc., $VARIABLE in <agenthub.watch>), the session registry, MCP via the hub.
// A local plugin of a test hub with AGENTHUB_TEST_TIER=own (G15, config.testTier) is own too: the core marks its policy testTier.
export function trustedPlugin(pl) {
  return pl?.source === "builtin" || pl?.granted?.official === true || (pl?.source === "installed" && pl?.granted?.tier === "own") || testTierPlugin(pl);
}
// A Plugins/local plugin given the own tier by AGENTHUB_TEST_TIER=own on a test hub (never on the live one: config.testTierOf).
export function testTierPlugin(pl) {
  return pl?.source === "local" && pl?.granted?.tier === "own" && pl?.granted?.testTier === true;
}

// Connections declared by a plugin (<agenthub.connection>, contract 2): only for a trusted plugin, only to hosts from
// its <agenthub.net> and only with its own id (the plugin id or "<id>.<name>", lib/meta.mjs connectionIdOf: a plugin
// id never contains a dot, so another plugin's connection cannot be declared this way; id starts with a letter, up to 64 — like a keychain entry name).
// tier — plugin tier (oauth service: a sign-in before contract 2 without a resource address is accepted only from builtin and
// official). → { list: [...], rejected: [{id, why}] }
export function pluginConnections(pl) {
  const out = { list: [], rejected: [] };
  if (!trustedPlugin(pl)) return out;
  const tier = pl.source === "builtin" ? "builtin" : pl.granted?.tier === "own" ? "own" : "official";
  const net = new Set((pl.meta?.net || []).map((e) => splitWhy(e).what.toLowerCase()));
  for (const c of pl.meta?.connections || []) {
    const id = c.id || pl.id;
    if (!connectionIdOf(pl.id, id)) out.rejected.push({ id, why: "id" });
    else if (![c.host, ...(c.hosts || [])].every((h) => net.has(String(h).toLowerCase()))) out.rejected.push({ id, why: "net" });
    else if (out.list.some((x) => x.id === id)) out.rejected.push({ id, why: "duplicate" });
    else out.list.push({ ...c, id, plugin: pl.id, tier, tools: [...c.tools], hosts: [...(c.hosts || [])] });
  }
  return out;
}

export function effectAllowed(name, patterns) {
  return patterns.some((p) => (p.endsWith(".*") ? name.startsWith(p.slice(0, -1)) : name === p || canonical(name) === canonical(p)));
}

// An installed plugin of the community tier (from the signed registry, not official, not own).
export function communityPlugin(pl) {
  return pl?.source === "installed" && !trustedPlugin(pl);
}

// Push rules of a community plugin (G3): only kind="plugin" (including the legacy kinds mapped to it) — its own switch in
// Settings → Notifications; no escalation: quiet hours, away, the evening hold, a shorter cooldown and the security kind are
// dropped (the engine applies the untrusted limits and the shared flap window). Labels (and their lang variants) stay: the
// registry reviewer has read them.
export function communityPushRules(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || r.kind !== PLUGIN_KIND || typeof r.key !== "string") continue;
    out.push({ key: r.key, label: r.label ?? null, kind: PLUGIN_KIND, ...(r.labels ? { labels: { ...r.labels } } : {}), ...(r.legacyKind ? { legacyKind: r.legacyKind } : {}), ...(r.macOnly === true ? { macOnly: true } : {}), community: true });
  }
  return out;
}
