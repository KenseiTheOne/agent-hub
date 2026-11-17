// Core part: what a plugin is allowed and given — its policy (tier, effects ceiling, the right to actions) on top of
// the plugin manager's verdict (ctx.setPluginPolicy), the environment variables services give to trusted plugins
// (ctx.providePluginEnv) and its secrets (ctx.setSecretsProvider).
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { splitWhy } from "../meta.mjs";
import { msg } from "../i18n.mjs";
import { effectAllowed, LOCAL_EFFECTS, THIRD_PARTY_EFFECTS, trustedPlugin } from "./tiers.mjs";

// Variables that services give to trusted plugins (ctx.providePluginEnv): AGENTHUB_<NAME>, not among those reserved by the core.
const PLUGIN_ENV_RE = /^AGENTHUB_[A-Z][A-Z0-9_]{0,40}$/;
const RESERVED_PLUGIN_ENV = new Set(["AGENTHUB_PLUGIN_ID", "AGENTHUB_PLUGIN_DATA_PATH", "AGENTHUB_PLUGIN_CACHE_PATH", "AGENTHUB_REFRESH_REASON", "AGENTHUB_LANG", "AGENTHUB_LOCALE", "AGENTHUB_PAUSED"]);

export class CorePluginPolicy {
  // ---------- plugin policy ----------
  setPluginPolicy(fn) {
    this.pluginPolicy = fn;
  }
  setSecretsProvider(fn) {
    this.secretsProvider = fn;
  }
  // → { allowed, effects: [...], actions: bool, official: bool, tier, reason? }
  // tier: builtin — the app's directory; local — Plugins/local; installed — official or community, and
  // official only if the manager's policy said so (a plugins.lock entry from the signed registry index).
  // Plugin metadata does not affect the tier. Actions (<agenthub.action>) — only builtin, official and own (own is
  // a plugins.lock entry the manager made after a human's consent; see plugins.mjs ownTrusted).
  async policyFor(pl) {
    const declared = pl.meta.effects;
    // a test hub with AGENTHUB_TEST_TIER=own (G15): a local plugin gets the own tier and its ceiling
    const testOwn = pl.source === "local" && this.config.testTier === "own";
    const ceiling = pl.source === "builtin" ? null : pl.source === "local" && !testOwn ? LOCAL_EFFECTS : THIRD_PARTY_EFFECTS;
    const under = (e) => !ceiling || ceiling.includes(e) || effectAllowed(e.replace(/\.\*$/, ".x"), ceiling);
    const baseTier = pl.source === "builtin" ? "builtin" : pl.source === "local" ? "local" : "community";
    // Actions (G3): builtin, and every installed plugin — official and own as declared, community with the confirm floor
    // (actionLevel); local — none (except the test tier).
    const hasActions = (pl.meta.actions || []).length > 0;
    let res = { allowed: true, effects: declared.filter(under), actions: pl.source === "builtin" || (pl.source === "installed" && hasActions), official: false, tier: baseTier };
    // Installed plugins are admitted only by the manager (plugins.lock, sha256, consent, quarantine). No policy —
    // the plugins service is off, not started due to the AGENTHUB_SERVICES filter, or crashed at startup — closed, not open:
    // otherwise any Plugins/<id> directory would pass as community without checks and get <id>.* keys from the keychain.
    if (!this.pluginPolicy && pl.source === "installed") return { allowed: false, reason: "policy:no-manager" };
    if (this.pluginPolicy) {
      try {
        const over = await this.pluginPolicy(pl, res);
        if (over) {
          res = { ...res, ...over };
          // the policy cannot raise the ceiling for third-party plugins
          res.effects = (res.effects || []).filter(under);
          if (pl.source !== "builtin") {
            const official = pl.source === "installed" && (over.tier === "official" || (over.tier === undefined && over.official === true));
            // own — only installed by the manager (Plugins/<id>, plugins.lock); Plugins/local is never own
            const own = pl.source === "installed" && !official && over.tier === "own";
            res.tier = pl.source === "local" ? "local" : official ? "official" : own ? "own" : "community";
            res.official = official;
            res.actions = pl.source === "installed" && hasActions;
          } else {
            res.tier = "builtin";
            res.official = false;
          }
        }
      } catch (e) {
        res = { allowed: false, reason: `policy: ${e.message}` };
      }
    }
    if (testOwn && res.allowed) res = { ...res, tier: "own", official: false, actions: hasActions, testTier: true };
    return res;
  }
  // A core service gives trusted plugins an environment variable (a path to its cache). value null — remove.
  // Name is AGENTHUB_<NAME>, not among those reserved by the core (buildEnv). Already running plugins see it from their next run.
  setPluginEnv(name, value) {
    if (!PLUGIN_ENV_RE.test(String(name)) || RESERVED_PLUGIN_ENV.has(name)) throw new Error(msg("err.pluginEnv.name", { name }));
    if (value === null || value === undefined) this.pluginEnvExtra.delete(name);
    else this.pluginEnvExtra.set(name, String(value));
  }
  // → { NAME: value } for this plugin: only builtin, official and own (per policy, not per metadata).
  // A trusted plugin always gets AGENTHUB_HUB_SOCKET (the hub socket path, not a secret) (contract 3): through the socket it
  // calls both /connections/:id/mcp (oauth service) and /terminal/* (terminal service) — the variable does not depend on
  // which of the services is enabled.
  pluginEnvFor(pl) {
    if (!trustedPlugin(pl)) return {};
    return { ...(this.config.paths?.socket ? { AGENTHUB_HUB_SOCKET: this.config.paths.socket } : {}), ...Object.fromEntries(this.pluginEnvExtra) };
  }
  async secretsFor(pl) {
    if (!pl.meta.secrets.length || !this.secretsProvider) return {};
    const out = {};
    for (const entry of pl.meta.secrets) {
      const key = splitWhy(entry).what;
      try {
        const v = await this.secretsProvider(pl.id, key, pl);
        if (typeof v === "string") out[key] = v;
      } catch {}
    }
    return out;
  }
}
