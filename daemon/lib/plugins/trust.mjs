// PluginManager part: what an installed plugin is trusted with — the policy the core asks for (policy), official only
// while the signed catalog says so (lowering to community and back, Registry/tiers.json), the saved attestations and
// archives that prove a version official, and reconciling Plugins/ with plugins.lock (checkInstalled, reconcile).
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { msg } from "../i18n.mjs";
import { scanDir } from "../host.mjs";
import { readTarGz } from "../registry/tarball.mjs";
import { ID_RE, permissionGrowth, permissionsFromMeta } from "../registry/perms.mjs";
import { atomicWrite, hashTree, readJsonOr, sameFiles, sha256 } from "./common.mjs";
import { entryTier, MAX_INDEX_BYTES } from "./index-format.mjs";
import { registryLabel } from "./sources.mjs";

export class ManagerTrust {
  // ---------- policy for the core ----------
  // fn(plugin, defaults) from ctx.setPluginPolicy. The core still clamps effects to the ceiling.
  policy(pl, defaults) {
    if (pl.source === "builtin") return null;
    if (pl.source === "local") {
      const reason = this.blockReason(pl.id, { any: true });
      return reason ? { allowed: false, reason: "blocklist" } : null;
    }
    const v = this.checkInstalled(pl);
    if (!v.ok) return { allowed: false, reason: v.reason };
    const granted = new Set(v.entry.granted?.effects || []);
    // tier comes from the verified catalog right now (not from lock and not from plugin metadata), see officialNow; own —
    // only a lock entry the manager made itself after human consent in the app (approveOwn / update
    // from the same folder): ownTrusted checks it against the consent fingerprint. A tier: "own" field written bypassing the manager
    // gives community (and the plugin-own-unexpected signal); files on disk are exactly the lock entry (checkInstalled).
    let tier;
    if (v.entry.tier === "own") {
      tier = this.ownTrusted(pl.id, v.entry) ? "own" : "community";
      if (tier !== "own") this.noteUnexpectedOwn(pl.id, v.entry);
    } else {
      tier = this.officialNow(pl.id, v.entry) ? "official" : "community";
      this.noteTier(pl.id, v.entry, tier === "official");
    }
    // registry (G19): where a registry plugin came from — the core shows it in /state.plugins[].registry(Label)
    const reg = v.entry.tier === "own" ? null : this.registryOf(v.entry);
    return { allowed: true, effects: (defaults?.effects || []).filter((e) => granted.has(e)), tier, official: tier === "official", ...(reg ? { registry: reg, registryLabel: registryLabel(reg, this.sources()) } : {}) };
  }

  // Is the installed plugin official right now: the signed catalog names the id official (tier not lowered),
  // the archive sha256 from lock is signed as official — by the current catalog or the saved attestation
  // (Registry/attest/<id>: the previous index where this version was the latest; verified with the same public key),
  // and the lock files (also on disk — checkInstalled) are exactly the contents of the saved archive with that sha256.
  // A lock entry with tier official made bypassing the manager grants no officialness: no signed index
  // names its archive official.
  officialNow(id, e) {
    // an own plugin is never official, even if the catalog has a plugin with the same id and the same content
    if (e?.tier === "own") return false;
    this.refreshCatalog();
    const ce = e ? this.catalogEntry(id, e) : null;
    if (!ce || ce.tier !== "official" || !e) return false;
    if (ce.sha256 !== e.sha256 && !this.attestedOfficial(id, e)) return false;
    const files = this.archiveFiles(id, e.sha256);
    return Boolean(files) && sameFiles(files, e.files);
  }

  // ---------- official → community and back (decision 2026-11-11) ----------
  loweredMap() {
    if (this.lowered) return this.lowered;
    const j = readJsonOr(this.files.tiers, null);
    const out = new Map();
    if (j && j.version === 1 && j.lowered && typeof j.lowered === "object" && !Array.isArray(j.lowered)) {
      for (const [id, v] of Object.entries(j.lowered).slice(0, 500)) if (ID_RE.test(id) && v && typeof v === "object") out.set(id, v);
    }
    this.lowered = out;
    return out;
  }
  saveLowered() {
    try {
      atomicWrite(this.files.tiers, JSON.stringify({ version: 1, lowered: Object.fromEntries(this.loweredMap()) }, null, 2) + "\n");
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.fileNotWritten", { file: "tiers.json", why: e.code || e.message }) });
    }
  }
  // Why an installed official plugin is not official now: the id is gone from the catalog, the catalog lists it as community,
  // or the installed archive is not the signed one (no attestation, files differ from the saved archive).
  lowerReason(id, e) {
    const ce = this.catalogEntry(id, e);
    if (!ce) return "not-in-catalog";
    if (ce.tier !== "official") return "community";
    return "archive";
  }
  // Called by the policy for every installed registry plugin: a plugin installed as official (lock tier) that the verified
  // catalog doesn't call official now is journaled once; back to official — once more. Without a verified catalog (never
  // fetched, the cache on disk failed its signature) nothing is journaled: there is nothing to compare with.
  noteTier(id, e, official) {
    const cat = this.cats.get(this.registryOf(e))?.catalog || null;
    if (entryTier(e) !== "official" || !cat) return;
    const map = this.loweredMap();
    const mark = map.get(id);
    const same = mark && mark.sha256 === e.sha256;
    if (!official && !same) {
      const reason = this.lowerReason(id, e);
      map.set(id, { version: e.version, sha256: e.sha256, reason, at: new Date().toISOString() });
      this.saveLowered();
      this.log({ type: "plugin-tier-lowered", plugin: id, version: e.version, from: "official", to: "community", reason, generatedAt: cat.generatedAt, registry: this.registryOf(e) });
    } else if (official && mark) {
      map.delete(id);
      this.saveLowered();
      if (same) this.log({ type: "plugin-tier-restored", plugin: id, version: e.version, from: "community", to: "official", generatedAt: cat.generatedAt, registry: this.registryOf(e) });
    }
  }
  // The plugin was installed again or removed: the previous mark is about another install.
  clearLowered(id) {
    if (!this.loweredMap().has(id)) return;
    this.lowered.delete(id);
    this.saveLowered();
  }

  // Attestations of id in every configured registry (and the one the lock entry names): removed on update and removal.
  dropAttest(id, e = null) {
    const regs = new Set(["default", ...this.sources().map((r) => r.name), ...(e ? [this.registryOf(e)] : [])]);
    for (const r of regs) for (const f of Object.values(this.attestFiles(id, r))) rmSync(f, { force: true });
  }
  attestFiles(id, registry = "default") {
    const dir = this.srcFiles(registry).attest;
    return { index: join(dir, `${id}.json`), sig: join(dir, `${id}.json.minisig`) };
  }

  // Does the saved signed index name the installed version (id, version, archive sha256) official?
  attestedOfficial(id, e) {
    const reg = this.registryOf(e);
    const f = this.attestFiles(id, reg);
    let stamp;
    try {
      const a = lstatSync(f.index);
      const b = lstatSync(f.sig);
      if (!a.isFile() || !b.isFile()) return false;
      stamp = `${a.size}:${a.mtimeMs}:${a.ctimeMs}:${a.ino}|${b.size}:${b.mtimeMs}:${b.ctimeMs}:${b.ino}`;
    } catch {
      return false;
    }
    const key = `${stamp}|${this.source(reg)?.publicKey || ""}`;
    let hit = this.attestCache.get(`${reg}|${id}`);
    if (!hit || hit.key !== key) {
      let entry = null;
      try {
        if (this.source(reg) && statSync(f.index).size <= MAX_INDEX_BYTES) entry = this.verifyIndex(readFileSync(f.index), readFileSync(f.sig, "utf8"), reg).plugins.get(id) || null;
      } catch {
        entry = null;
      }
      hit = { key, entry };
      this.attestCache.set(`${reg}|${id}`, hit);
    }
    const ae = hit.entry;
    return Boolean(ae && ae.tier === "official" && ae.sha256 === e.sha256 && ae.version === e.version);
  }

  // The new catalog next replaces the current one (verified, on disk): for installed plugins whose version is official
  // in the current catalog and no longer the latest in the new one, save the current index with its signature to Registry/attest/<id>.
  keepAttestations(next, registry = "default") {
    this.refreshCatalog(); // memory is exactly what's on disk (another process may have updated the catalog)
    const cur = this.cats.get(registry)?.catalog;
    const files = this.srcFiles(registry);
    if (!cur) return;
    let bytes = null;
    let sig = null;
    for (const [id, e] of Object.entries(this.lock().plugins)) {
      if (e.tier === "own" || this.registryOf(e) !== registry) continue;
      const ce = cur.plugins.get(id);
      if (!ce || ce.tier !== "official" || ce.sha256 !== e.sha256) continue;
      if (next.plugins.get(id)?.sha256 === e.sha256) continue; // the new catalog signs it itself
      if (this.attestedOfficial(id, e)) continue;
      try {
        if (!bytes) {
          bytes = readFileSync(files.index);
          sig = readFileSync(files.sig);
          this.verifyIndex(bytes, sig.toString("utf8"), registry); // on disk — exactly the verified catalog
        }
        const f = this.attestFiles(id, registry);
        mkdirSync(files.attest, { recursive: true, mode: 0o700 });
        atomicWrite(f.index, bytes);
        atomicWrite(f.sig, sig);
        this.log({ type: "registry-attest-kept", plugin: id, version: e.version });
      } catch (err) {
        this.log({ type: "warning", plugin: id, detail: msg("warn.officialProof", { why: err.code || err.message }) });
        if (!sig) return;
      }
    }
  }

  // File hashes of the saved archive Registry/archives/<id>.tar.gz, if its sha256 is sum. → { rel: sha256 } | null
  archiveFiles(id, sum) {
    const path = join(this.dirs.archives, `${id}.tar.gz`);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const key = `${id}|${sum}|${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    if (this.archiveCache.has(key)) return this.archiveCache.get(key);
    let out = null;
    try {
      const bytes = readFileSync(path);
      if (sha256(bytes) === sum) {
        out = {};
        for (const f of readTarGz(bytes, { root: id })) out[f.path.slice(id.length + 1)] = sha256(f.data);
      }
    } catch {
      out = null;
    }
    for (const k of this.archiveCache.keys()) if (k.startsWith(`${id}|`)) this.archiveCache.delete(k);
    this.archiveCache.set(key, out);
    return out;
  }

  // Does the installed plugin match lock? → { ok, entry } | { ok: false, reason }
  checkInstalled(pl) {
    const e = this.lockEntry(pl.id);
    if (!e) return { ok: false, reason: "not-in-lock" };
    if (e.disabled) return { ok: false, reason: e.disabled.reason || "disabled" };
    if (!this.ownTrusted(pl.id, e) && this.blockReason(pl.id, { version: e.version, sha256: e.sha256, registry: this.registryOf(e) })) return { ok: false, reason: "blocklist" };
    const dir = join(this.paths.plugins, pl.id);
    if (resolve(pl.dir) !== resolve(dir)) return { ok: false, reason: "layout" };
    let files;
    try {
      files = hashTree(dir);
    } catch {
      return { ok: false, reason: "tampered" };
    }
    if (!sameFiles(files, e.files)) return { ok: false, reason: "tampered" };
    const grew = permissionGrowth(e.granted, permissionsFromMeta(pl.meta));
    if (grew.length) return { ok: false, reason: "consent-required" };
    return { ok: true, entry: e };
  }

  // Whatever is in Plugins/ bypassing the manager (not in lock, files changed, not a folder) is moved to
  // Registry/quarantine/: no unaccounted code stays on disk (services start before plugins, and the policy
  // wouldn't let it run anyway).
  reconcile() {
    const moved = [];
    if (!existsSync(this.paths.plugins)) return moved;
    const { plugins } = scanDir(this.paths.plugins, "installed");
    const seen = new Set();
    for (const pl of plugins) {
      seen.add(pl.dir === this.paths.plugins ? pl.file : pl.dir);
      const v = this.checkInstalled(pl);
      if (v.ok || v.reason === "blocklist" || v.reason === "disabled") continue;
      const victim = pl.dir === this.paths.plugins ? pl.file : pl.dir;
      const dest = join(this.dirs.quarantine, `${pl.id}-${Date.now()}-${randomBytes(3).toString("hex")}`);
      try {
        renameSync(victim, dest);
        moved.push(pl.id);
        this.log({ type: "plugin-quarantined", plugin: pl.id, reason: v.reason });
        this.emit({ type: "plugins.quarantined", plugin: pl.id, reason: v.reason });
      } catch (err) {
        this.log({ type: "warning", plugin: pl.id, detail: msg("warn.quarantine", { why: err.code || err.message }) });
      }
    }
    if (moved.length) this.changed();
    return moved;
  }
}
