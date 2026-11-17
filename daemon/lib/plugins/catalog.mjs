// PluginManager part: the catalog — per-registry state and the merged view, verifying a signed index (verifyIndex),
// the copy on disk with rollback protection and freshness, downloading the index and archives (fetchCatalog, fetchBytes).
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verify as verifySignature } from "../registry/minisign.mjs";
import { atomicWrite, isStr, readJsonOr, RegistryError } from "./common.mjs";
import { MAX_INDEX_BYTES, MAX_SIG_BYTES, parseIndex } from "./index-format.mjs";
import { registryLabel, tierLabel } from "./sources.mjs";

export class ManagerCatalog {
  catState(name) {
    let c = this.cats.get(name);
    if (!c) this.cats.set(name, (c = { catalog: null, error: null, stamp: null }));
    return c;
  }
  setCat(name, catalog, error = undefined) {
    const c = this.catState(name);
    c.catalog = catalog;
    if (error !== undefined) c.error = error;
    this.catsVer++;
  }
  // The merged catalog: every registry's plugins in config order; the same id in a later registry is shadowed by the
  // earlier one (journaled once, registry-shadowed) — except for an installed plugin, which always follows the registry it was
  // installed from (catalogEntry). Blocklists: tagged with their registry (blockReason). null — no verified catalog at all.
  get catalog() {
    const key = `${this.catsVer}|${this.sources().map((r) => r.name).join(",")}`;
    if (this.merged?.key === key) return this.merged.value;
    const plugins = new Map();
    const blocklist = [];
    let generatedAt = null;
    let fetchedAt = null;
    let any = false;
    const shadowed = [];
    for (const src of this.sources()) {
      const cat = this.cats.get(src.name)?.catalog;
      if (!cat) continue;
      any = true;
      if (!generatedAt || Date.parse(cat.generatedAt) > Date.parse(generatedAt)) generatedAt = cat.generatedAt;
      if (cat.fetchedAt && (!fetchedAt || Date.parse(cat.fetchedAt) > Date.parse(fetchedAt))) fetchedAt = cat.fetchedAt;
      for (const [id, e] of cat.plugins) {
        if (plugins.has(id)) shadowed.push({ id, registry: src.name, by: plugins.get(id).registry });
        else plugins.set(id, e);
      }
      for (const b of cat.blocklist) blocklist.push(b);
    }
    for (const x of shadowed) {
      const k = `${x.id}|${x.registry}|${x.by}`;
      if (this.shadowNoted.has(k)) continue;
      this.shadowNoted.add(k);
      this.log({ type: "registry-shadowed", plugin: x.id, registry: x.registry, by: x.by });
    }
    const value = any ? { generatedAt, fetchedAt, plugins, blocklist, shadowed } : null;
    this.merged = { key, value };
    return value;
  }
  // The first registry's error (the old single-registry field), or null.
  get catalogError() {
    for (const src of this.sources()) {
      const e = this.cats.get(src.name)?.error;
      if (e) return e;
    }
    return null;
  }
  // The catalog entry for id: an installed registry plugin — from the registry it was installed from (an earlier registry
  // listing the same id never takes it over); otherwise — the first registry listing it.
  catalogEntry(id, inst = this.lockEntry(id)) {
    if (inst && inst.tier !== "own") return this.cats.get(this.registryOf(inst))?.catalog?.plugins.get(id) || null;
    return this.catalog?.plugins.get(id) || null;
  }
  // Registries for the shell (GET /registry/catalog → registries): name, trust, state of its catalog.
  registriesView() {
    return this.sources().map((r) => {
      const c = this.cats.get(r.name) || {};
      return {
        name: r.name,
        trust: r.trust,
        // the tier label suffix: null for the single default registry (the UI stays as before)
        label: registryLabel(r.name, this.sources()),
        configured: Boolean(r.indexUrl && r.publicKey),
        missing: [!r.indexUrl && "index-url", !r.publicKey && "public-key"].filter(Boolean),
        generatedAt: c.catalog?.generatedAt || null,
        fetchedAt: c.catalog?.fetchedAt || null,
        // the signed "valid until" of the catalog (null — the index carries none) and whether it has passed: an expired
        // catalog still gives tiers and the blocklist but nothing is installed from it (registry:expired)
        expiresAt: c.catalog?.expiresAt || null,
        expired: this.catalogExpired(r.name),
        plugins: c.catalog ? c.catalog.plugins.size : 0,
        error: c.error || null,
        // the accepted key the catalog is verified with ({keyId, fingerprint}) and, when config.json names another one,
        // keyChanged: {was, now, since} — the new key waits for the human (POST /registry/key/accept)
        key: r.keyInfo ? { ...r.keyInfo } : null,
        keyChanged: r.keyChanged ? { was: { ...r.keyChanged.was }, now: r.keyChanged.now ? { ...r.keyChanged.now } : null, since: r.keyChanged.since } : null,
        // "official plugin · <name>" in the hub language (the suffix only when there is more than the default registry)
        tierLabel: tierLabel(r.trust, r.name, this.sources()),
      };
    });
  }

  // ---------- catalog ----------
  // The first registry's index URL and key (single-registry fields of /registry/catalog: configured, missing).
  publicKey(name = null) {
    const src = name ? this.source(name) : this.sources()[0];
    const k = src?.publicKey;
    return typeof k === "string" && k.trim() ? k : null;
  }

  // Verify an index with the key of registry name and parse it. A registry with trust "community" never makes a plugin
  // official (its entries are capped to community); every entry carries the registry name.
  verifyIndex(indexBytes, sigText, name = this.sources()[0]?.name || "default") {
    const src = this.source(name);
    const key = src?.publicKey || null;
    if (!key) throw new RegistryError(409, "registry:no-public-key", { registry: name });
    const v = verifySignature(indexBytes, String(sigText), key);
    // config.json names another key than the accepted one and this catalog is not signed with the accepted one: it is the
    // new key's catalog (or anybody's) — not trusted until the human accepts the key
    if (!v.ok && src.keyChanged && (v.reason === "key-mismatch" || v.reason === "signature")) {
      throw new RegistryError(409, "registry:key-changed", { registry: name, was: src.keyChanged.was.fingerprint, now: src.keyChanged.now?.fingerprint ?? null });
    }
    if (!v.ok) throw new RegistryError(422, `registry:${v.reason === "key-mismatch" ? "foreign-key" : v.reason}`, { registry: name });
    const idx = parseIndex(Buffer.from(indexBytes).toString("utf8"));
    for (const e of idx.plugins.values()) {
      e.registry = name;
      if (src.trust !== "official" && e.tier === "official") {
        e.tier = "community";
        e.official = false;
        e.capped = true;
      }
    }
    for (const b of idx.blocklist) b.registry = name;
    return idx;
  }

  // Fingerprint of a registry's index.json and signature on disk: another process may have updated it (`agenthub plugins install`).
  diskStamp(name = "default") {
    const f = this.srcFiles(name);
    try {
      const a = statSync(f.index);
      const b = statSync(f.sig);
      return `${a.size}:${a.mtimeMs}:${a.ctimeMs}|${b.size}:${b.mtimeMs}:${b.ctimeMs}`;
    } catch {
      return null;
    }
  }

  // Re-read the catalogs from disk if they were changed outside this process. An older index (rollback) is not taken. Files that
  // don't verify (a half-written pair from another process — index.json is replaced before its signature — or a damaged file) don't
  // replace the last verified catalog in memory: tiers keep following it until a pair on disk verifies again.
  refreshCatalog() {
    let changed = false;
    for (const src of this.sources()) {
      const st = this.catState(src.name);
      const stamp = this.diskStamp(src.name);
      if (stamp === st.stamp && st.key === src.publicKey) continue;
      const prev = st.catalog;
      this.loadSource(src);
      if (prev && st.catalog && Date.parse(st.catalog.generatedAt) < Date.parse(prev.generatedAt)) {
        this.log({ type: "registry-rejected", registry: src.name, error: "registry:rollback" });
        this.setCat(src.name, prev);
      }
      if (prev && !st.catalog && st.error && st.key === src.publicKey) this.setCat(src.name, prev);
      changed = true;
    }
    if (changed) this.noteUpdates();
  }

  // (Re)load every registry's catalog from disk; registries no longer configured are forgotten.
  loadCached() {
    const names = new Set(this.sources().map((r) => r.name));
    for (const n of [...this.cats.keys()]) if (!names.has(n)) this.cats.delete(n);
    for (const src of this.sources()) this.loadSource(src);
    this.catsVer++;
  }
  loadSource(src) {
    const st = this.catState(src.name);
    const f = this.srcFiles(src.name);
    this.setCat(src.name, null);
    st.stamp = this.diskStamp(src.name);
    st.key = src.publicKey;
    if (!existsSync(f.index) || !existsSync(f.sig)) return;
    try {
      const idx = this.verifyIndex(readFileSync(f.index), readFileSync(f.sig, "utf8"), src.name);
      // never older than the last catalog this hub accepted (state.json is written on every accepted fetch): an older
      // signed pair put back on disk would bring back a removed blocklist entry's plugin or hide an update
      const saved = readJsonOr(f.state, {});
      const floor = isStr(saved.generatedAt, 64) && !Number.isNaN(Date.parse(saved.generatedAt)) ? saved.generatedAt : null;
      if (floor && Date.parse(idx.generatedAt) < Date.parse(floor)) throw new RegistryError(409, "registry:rollback", { have: floor, got: idx.generatedAt, registry: src.name });
      this.setCat(src.name, { ...idx, fetchedAt: saved.fetchedAt || null }, null);
      this.noteFreshness(src.name, idx);
    } catch (e) {
      this.setCat(src.name, null, e.code || e.message);
      this.log({ type: "registry-cache-rejected", registry: src.name, error: e.code || e.message });
    }
  }

  // Whether registry name's catalog is past its signed expiresAt (false — no catalog or the index carries no such field).
  catalogExpired(name, now = Date.now()) {
    const x = this.cats.get(name)?.catalog?.expiresAt;
    return Boolean(x) && Date.parse(x) < now;
  }
  // Nothing is installed or updated from a catalog past its signed date: the registry owner no longer vouches that this is
  // the current list (a frozen copy hides a newer release or a blocklist entry).
  requireFresh(name) {
    if (!this.catalogExpired(name)) return;
    const cat = this.cats.get(name).catalog;
    this.noteFreshness(name, cat);
    throw new RegistryError(409, "registry:expired", { registry: name, expiresAt: cat.expiresAt });
  }
  // The journal about a catalog's freshness, once per registry and catalog: registry-no-expiry — the index carries no
  // expiresAt, so the hub cannot tell a frozen copy from a quiet registry (only "not older than the last one");
  // registry-expired — the signed date has passed.
  noteFreshness(name, idx) {
    const expired = Boolean(idx.expiresAt) && Date.parse(idx.expiresAt) < Date.now();
    const k = idx.expiresAt ? `${idx.generatedAt}|${idx.expiresAt}|${expired}` : "none";
    if (this.freshNoted.get(name) === k) return;
    this.freshNoted.set(name, k);
    if (!idx.expiresAt) this.log({ type: "registry-no-expiry", registry: name, generatedAt: idx.generatedAt });
    else if (expired) this.log({ type: "registry-expired", registry: name, generatedAt: idx.generatedAt, expiresAt: idx.expiresAt });
  }

  indexUrl(name = null) {
    const src = name ? this.source(name) : this.sources()[0];
    const u = src?.indexUrl;
    return typeof u === "string" && u.trim() ? u.trim() : null;
  }

  async fetchBytes(url, maxBytes) {
    if (this.fetcher) {
      const b = Buffer.from(await this.fetcher(url, maxBytes));
      if (b.length > maxBytes) throw new RegistryError(413, "registry:too-large");
      return b;
    }
    if (url.startsWith("/") || url.startsWith("file:")) {
      const path = url.startsWith("file:") ? fileURLToPath(url) : url;
      let st;
      try {
        st = statSync(path);
      } catch {
        throw new RegistryError(404, "registry:not-found");
      }
      if (st.size > maxBytes) throw new RegistryError(413, "registry:too-large");
      return readFileSync(path);
    }
    if (!url.startsWith("https://")) throw new RegistryError(400, "registry:url-scheme");
    if (this.opts.allowNetwork === false) throw new RegistryError(409, "registry:network-disabled");
    let res;
    try {
      res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new RegistryError(502, "registry:fetch");
    }
    if (!res.url.startsWith("https://")) throw new RegistryError(502, "registry:redirect");
    if (!res.ok) throw new RegistryError(502, "registry:http", { http: res.status });
    const chunks = [];
    let n = 0;
    for await (const c of res.body) {
      n += c.length;
      if (n > maxBytes) throw new RegistryError(413, "registry:too-large");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // Archive URL relative to the index.json of the entry's registry; locally — not above the index directory.
  archiveUrl(entry) {
    const base = this.indexUrl(entry.registry || this.sources()[0]?.name || "default");
    if (!base) throw new RegistryError(409, "registry:no-index-url");
    if (/^https:\/\//.test(entry.archive)) return entry.archive;
    if (/^[a-z]+:/i.test(entry.archive) || entry.archive.startsWith("/")) throw new RegistryError(422, "registry:archive-url");
    if (base.startsWith("https://")) {
      const u = new URL(entry.archive, base);
      if (u.protocol !== "https:") throw new RegistryError(422, "registry:archive-url");
      return u.href;
    }
    const baseDir = dirname(base.startsWith("file:") ? fileURLToPath(base) : base);
    const p = resolve(baseDir, entry.archive);
    if (!p.startsWith(baseDir + sep)) throw new RegistryError(422, "registry:archive-url");
    return p;
  }

  // Download and verify every configured registry (G19). One registry — as before: its error is thrown. Several — each on its own;
  // throws only if none succeeded (the first error). → { generatedAt, plugins, blocklist, registries: [{name, ok, error?, …}] }
  async fetchCatalog() {
    const list = this.sources();
    if (!list.length || !list.some((r) => r.indexUrl)) throw new RegistryError(409, "registry:no-index-url");
    if (!list.some((r) => r.indexUrl && r.publicKey)) throw new RegistryError(409, "registry:no-public-key");
    const results = [];
    let firstError = null;
    for (const src of list) {
      if (!src.indexUrl || !src.publicKey) {
        results.push({ name: src.name, ok: false, error: src.indexUrl ? "registry:no-public-key" : "registry:no-index-url" });
        continue;
      }
      try {
        results.push({ name: src.name, ok: true, ...(await this.fetchSource(src)) });
      } catch (e) {
        firstError ||= e;
        results.push({ name: src.name, ok: false, error: e.code || e.message });
      }
    }
    if (list.length === 1 && firstError) throw firstError;
    if (!results.some((r) => r.ok)) throw firstError || new RegistryError(502, "registry:fetch");
    this.applyBlocklist();
    // New catalogs may have changed the tier of installed plugins (official → community): the core re-evaluates the policy.
    this.changed();
    const cat = this.catalog;
    this.emit({ type: "plugins.catalog", generatedAt: cat?.generatedAt || null, plugins: cat?.plugins.size || 0 });
    this.noteUpdates();
    return { generatedAt: cat?.generatedAt || null, plugins: cat?.plugins.size || 0, blocklist: cat?.blocklist.length || 0, registries: results };
  }

  async fetchSource(src) {
    const url = src.indexUrl;
    const f = this.srcFiles(src.name);
    const sigUrl = url.startsWith("https://") ? new URL(url).href + ".minisig" : url + ".minisig";
    const [indexBytes, sigBytes] = await Promise.all([this.fetchBytes(url, MAX_INDEX_BYTES), this.fetchBytes(sigUrl, MAX_SIG_BYTES)]);
    let idx;
    try {
      idx = this.verifyIndex(indexBytes, sigBytes.toString("utf8"), src.name);
    } catch (e) {
      this.log({ type: "registry-rejected", registry: src.name, error: e.code || e.message });
      throw e;
    }
    const st = this.catState(src.name);
    const prev = readJsonOr(f.state, {}).generatedAt || st.catalog?.generatedAt || null;
    if (prev && Date.parse(idx.generatedAt) < Date.parse(prev)) {
      this.log({ type: "registry-rejected", registry: src.name, error: "registry:rollback" });
      throw new RegistryError(409, "registry:rollback", { have: prev, got: idx.generatedAt, registry: src.name });
    }
    // The previous catalog is being replaced: save the signed attestation of officialness for installed versions that are
    // the latest in it (otherwise a new release by itself, without an update, would demote the installed one to community).
    this.keepAttestations(idx, src.name);
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    atomicWrite(f.index, indexBytes);
    atomicWrite(f.sig, sigBytes);
    const fetchedAt = new Date().toISOString();
    atomicWrite(f.state, JSON.stringify({ generatedAt: idx.generatedAt, fetchedAt }) + "\n");
    this.setCat(src.name, { ...idx, fetchedAt }, null);
    st.stamp = this.diskStamp(src.name);
    st.key = src.publicKey;
    this.log({ type: "registry-fetched", registry: src.name, generatedAt: idx.generatedAt, plugins: idx.plugins.size, blocked: idx.blocklist.length });
    // A catalog past its signed expiresAt is still taken when it is not older than the one in hand — its blocklist and tiers
    // are the newest the hub can get — but it is marked expired and nothing is installed from it (prepare: registry:expired).
    this.noteFreshness(src.name, idx);
    return { generatedAt: idx.generatedAt, expiresAt: idx.expiresAt, expired: this.catalogExpired(src.name), plugins: idx.plugins.size, blocklist: idx.blocklist.length };
  }
}
