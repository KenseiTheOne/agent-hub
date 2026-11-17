// PluginManager part: the configured registries (G19) — the list from services.plugins (registrySources), the registry of an
// installed plugin, the files of a registry in Registry/, the labels of a registry and a tier.
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { join } from "node:path";
import { msg } from "../i18n.mjs";
import { fileSig } from "../config.mjs";
import { DEFAULT_REGISTRY } from "../registry/default-registry.mjs";

// ---------- several registries (G19) ----------
// services.plugins.registries: [{ name, indexUrl, publicKey, trust }] next to the old scalar indexUrl/publicKey pair, which keeps
// working as the registry "default" with trust "official" (and comes first). name — a-z, 0-9, "-" (starting with a letter, up to 32);
// trust — "official" (the index may name plugins official) or "community" (default: every entry is community, whatever the index
// says). Order matters: the same id in two registries — the earlier registry wins in the catalog (registry-shadowed is journaled),
// while an installed plugin always follows the registry it was installed from (lock entry registry). Each registry's signature is
// verified with its own key; a registry's blocklist applies to its own plugins, an official registry's blocklist — to all.
export const REGISTRY_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const REGISTRY_TRUST = ["official", "community"];
export const MAX_REGISTRIES = 8;
const strOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
// services.plugins → { list: [{name, indexUrl, publicKey, trust}], errors: [{index, name, error}] }
export function registrySources(opts = {}) {
  const list = [];
  const errors = [];
  const url0 = strOrNull(opts?.indexUrl);
  const key0 = typeof opts?.publicKey === "string" && opts.publicKey.trim() ? opts.publicKey : null;
  if (url0 || key0) list.push({ name: "default", indexUrl: url0, publicKey: key0, trust: "official" });
  const arr = Array.isArray(opts?.registries) ? opts.registries : [];
  arr.forEach((r, index) => {
    const name = typeof r?.name === "string" ? r.name : null;
    let error = null;
    if (!r || typeof r !== "object") error = "type";
    else if (!name || !REGISTRY_NAME_RE.test(name)) error = "name";
    else if (list.some((x) => x.name === name)) error = "duplicate";
    else if (!strOrNull(r.indexUrl)) error = "indexUrl";
    else if (typeof r.publicKey !== "string" || !r.publicKey.trim()) error = "publicKey";
    else if (r.trust !== undefined && !REGISTRY_TRUST.includes(r.trust)) error = "trust";
    else if (list.length >= MAX_REGISTRIES) error = "too-many";
    if (error) errors.push({ index, name: name && name.length <= 64 ? name : null, error });
    else list.push({ name, indexUrl: strOrNull(r.indexUrl), publicKey: r.publicKey, trust: r.trust || "community" });
  });
  return { list, errors };
}
// services.plugins with the built-in registry filled in (lib/registry/default-registry.mjs) when the human named none of their
// own: neither indexUrl nor publicKey is present (a key that is present — even null or "" — is the human's word and stays),
// and no entry of registries[] is called "default". services.plugins.defaultRegistry = false — never; a test hub
// (AGENTHUB_HOME) gets it only with defaultRegistry = true, so tests never reach for the network by themselves.
// → the same object, or a copy with indexUrl and publicKey.
export function withDefaultRegistry(opts, { testMode = false } = {}) {
  const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
  if (o.defaultRegistry === false || (testMode && o.defaultRegistry !== true)) return o;
  if (o.indexUrl !== undefined || o.publicKey !== undefined) return o;
  if (Array.isArray(o.registries) && o.registries.some((r) => r?.name === "default")) return o;
  return { ...o, indexUrl: DEFAULT_REGISTRY.indexUrl, publicKey: DEFAULT_REGISTRY.publicKey };
}
// The label suffix of a registry: null when only the default registry is configured (single-registry UI unchanged), else the name.
export function registryLabel(name, sources) {
  if (!name) return null;
  return sources.length === 1 && sources[0].name === "default" && name === "default" ? null : name;
}
// "official plugin · <name>" in the hub language.
export function tierLabel(tier, name, sources) {
  const base = msg(`tier.${tier === "official" ? "official" : "community"}`);
  const l = registryLabel(name, sources);
  return l ? `${base} · ${l}` : base;
}

export class ManagerSources {
  // ---------- registry sources (G19) ----------
  // The configured registries in order (registrySources): the scalar indexUrl/publicKey pair is the registry "default"
  // (trust official), then services.plugins.registries[].
  // publicKey of every source here is the key the hub verifies with — the accepted one (withKeyPins), which is the key from
  // config.json until somebody changes it there.
  sources() {
    const o = this.opts;
    const m = this.sourcesMemo;
    if (m?.opts === o && m.pinSig === fileSig(this.keyPinsPath())) return m.list;
    const list = this.withKeyPins(registrySources(o).list);
    this.sourcesMemo = { opts: o, pinSig: fileSig(this.keyPinsPath()), list };
    // the set of registries waiting for the human changed: the shell re-reads /state.registryKeys
    const sig = JSON.stringify(list.filter((r) => r.keyChanged).map((r) => [r.name, r.keyChanged.now?.fingerprint ?? null]));
    if (sig !== this.keyAlertSig) {
      this.keyAlertSig = sig;
      this.emit({ type: "plugins.registry-keys", changed: this.registryKeyAlerts() });
    }
    return list;
  }
  source(name) {
    return this.sources().find((r) => r.name === name) || null;
  }
  // The registry an installed (lock) entry came from: its registry field; an entry from before G19 — "default", or the first
  // configured registry when there is no default.
  registryOf(e) {
    if (typeof e?.registry === "string" && REGISTRY_NAME_RE.test(e.registry)) return e.registry;
    const list = this.sources();
    return list.some((r) => r.name === "default") || !list.length ? "default" : list[0].name;
  }
  // Files of a registry: "default" keeps the historical Registry/index.json…, Registry/attest/; others — Registry/sources/<name>/.
  srcFiles(name) {
    const dir = name === "default" ? this.dirs.registry : join(this.dirs.registry, "sources", name);
    return { dir, index: join(dir, "index.json"), sig: join(dir, "index.json.minisig"), state: join(dir, "state.json"), attest: name === "default" ? this.dirs.attest : join(dir, "attest") };
  }

  configured() {
    return this.sources().some((r) => r.indexUrl && r.publicKey);
  }
}
