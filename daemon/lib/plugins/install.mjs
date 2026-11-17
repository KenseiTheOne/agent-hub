// PluginManager part: installing from the registry — preparing the archive (prepare), POST /registry/install (install,
// installNow), writing the prepared plugin to Plugins/ and plugins.lock (commit — shared with own plugins) and removal.
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFileName, parseMetaText } from "../meta.mjs";
import { errText, msg } from "../i18n.mjs";
import { scanDir } from "../host.mjs";
import { readTarGz, LIMITS as TAR_LIMITS } from "../registry/tarball.mjs";
import { ID_RE, RESERVED_IDS, lintPlugin, permissionGrowth, permissionList, permissionsFingerprint, permissionsFromMeta } from "../registry/perms.mjs";
import { atomicWrite, RegistryError, sha256 } from "./common.mjs";
import { contractTooNew, entryContractTooNew, PLATFORM } from "./index-format.mjs";
import { ownRisk } from "./own.mjs";
import { mergeI18n, permI18nFromMeta } from "./perm-i18n.mjs";

export class ManagerInstall {
  // ---------- install preparation ----------
  async prepare(id) {
    if (typeof id !== "string" || !ID_RE.test(id) || RESERVED_IDS.has(id)) throw new RegistryError(400, "registry:id");
    if (!this.catalog) throw new RegistryError(409, "registry:no-catalog", this.catalogError ? { detail: this.catalogError } : {});
    // an installed registry plugin updates only from the registry it came from (G19); a new one — from the first registry listing it
    const entry = this.catalogEntry(id);
    if (!entry) throw new RegistryError(404, "not-found");
    const blocked = this.blockReason(id, { version: entry.version, sha256: entry.sha256, registry: entry.registry });
    if (blocked) throw new RegistryError(409, "registry:blocklist", { reason: blocked });
    this.requireFresh(entry.registry);
    if (entry.platforms.length && !entry.platforms.includes(PLATFORM)) throw new RegistryError(409, "registry:platform");
    if (this.builtinIds().has(id)) throw new RegistryError(409, "registry:id-taken", { by: "builtin" });
    const maxBytes = Math.min(this.opts.maxArchiveBytes || 5 * 1024 * 1024, TAR_LIMITS.maxTotalBytes);
    if (entry.size > maxBytes) throw new RegistryError(413, "registry:too-large");
    const bytes = await this.fetchBytes(this.archiveUrl(entry), maxBytes);
    const got = sha256(bytes);
    if (got !== entry.sha256) {
      this.log({ type: "registry-rejected", plugin: id, error: "registry:sha256" });
      throw new RegistryError(422, "registry:sha256");
    }
    let files;
    try {
      files = readTarGz(bytes, { root: id });
    } catch (e) {
      throw new RegistryError(422, "registry:archive", { detail: errText(e).slice(0, 160) });
    }
    // dot files and paths differing only in case wouldn't match lock on disk (case-insensitive APFS)
    const lower = new Set();
    for (const f of files) {
      if (f.path.split("/").some((seg) => seg.startsWith("."))) throw new RegistryError(422, "registry:archive", { detail: msg("err.archive.dotFile", { path: f.path.slice(0, 120) }) });
      const k = f.path.toLowerCase();
      if (lower.has(k)) throw new RegistryError(422, "registry:archive", { detail: msg("err.archive.caseDup", { path: f.path.slice(0, 120) }) });
      lower.add(k);
    }
    const mains = files.filter((f) => {
      const rest = f.path.slice(id.length + 1);
      if (rest.includes("/")) return false;
      const fn = parseFileName(rest);
      return fn && fn.id === id;
    });
    if (mains.length !== 1) throw new RegistryError(422, "registry:archive-main", { found: mains.length });
    const main = mains[0];
    const text = main.data.subarray(0, 64 * 1024).toString("utf8");
    const { meta } = parseMetaText(text);
    const perms = permissionsFromMeta(meta);
    if (meta.version !== entry.version) throw new RegistryError(422, "registry:archive-version");
    // the plugin needs a newer hub: a clear refusal before the permission check (new tags may be unknown to an old core)
    const tooNew = contractTooNew(meta.contract) || entryContractTooNew(entry);
    if (tooNew) {
      this.log({ type: "registry-rejected", plugin: id, error: "registry:hub-too-old", need: tooNew.need, have: tooNew.have });
      throw new RegistryError(409, "registry:hub-too-old", { id, ...tooNew });
    }
    if (permissionsFingerprint(perms) !== permissionsFingerprint(entry.permissions)) throw new RegistryError(422, "registry:archive-permissions");
    // The same linter as in registry CI. Officialness comes from the signed index (entry.official), not from
    // metadata: official plugins may declare actions, third-party ones may not.
    const lint = lintPlugin({ id, meta, source: main.data.toString("utf8"), official: entry.tier === "official", lang: this.langNow() });
    if (lint.errors.length) {
      this.log({ type: "registry-rejected", plugin: id, error: "registry:lint", count: lint.errors.length });
      throw new RegistryError(422, "registry:lint", { errors: lint.errors.slice(0, 20) });
    }
    // what comes from the archive, why — from the index (if present there).
    const whyByKey = new Map(permissionList(entry.permissions).map((p) => [p.key, p.why]));
    const list = permissionList(perms, { pluginId: id }).map((p) => ({ ...p, why: p.why ?? whyByKey.get(p.key) ?? null }));
    const prev = this.lockEntry(id);
    const growth = prev ? permissionGrowth(prev.granted, perms, { pluginId: id }) : permissionList(perms, { pluginId: id });
    const addedKeys = new Set(growth.map((p) => p.key));
    return {
      kind: "registry",
      icon: meta.icon || entry.icon || null,
      id,
      entry,
      archive: bytes,
      files,
      perms,
      list: list.map(({ key, ...p }) => ({ ...p, added: addedKeys.has(key) })),
      growth: growth.map(({ key, ...p }) => p),
      // translations of "why" from the archive itself (lang variants of tags, title-xx of actions); fallback — from the index
      i18n: mergeI18n(entry.i18n, permI18nFromMeta(meta)),
      update: Boolean(prev),
      fromVersion: prev?.version || null,
      // A new install always shows the permissions window; an update only when permissions grow. Switching from an own plugin (same
      // id from an own folder) to a registry plugin always shows the window, marked as a switch.
      needsConsent: !prev || growth.length > 0 || Boolean(prev.disabled) || prev.tier === "own",
      migrate: prev?.tier === "own" ? { from: "own", version: prev.version, path: prev.own?.path || null } : null,
    };
  }

  builtinIds() {
    const out = new Set();
    try {
      for (const pl of scanDir(this.config.builtinPluginsDir, "builtin").plugins) out.add(pl.id);
    } catch {}
    return out;
  }

  // POST /registry/install: without a token — 428 with the permissions window (or an immediate update install if permissions don't grow).
  async install(id, opts = {}) {
    if (this.estop()) throw new RegistryError(423, "estop");
    let info = null;
    try {
      if (typeof id === "string" && ID_RE.test(id)) info = this.busyInfo(id);
    } catch {}
    if (info) this.setBusy(id, info);
    try {
      return await this.installNow(id, opts);
    } finally {
      if (info) this.setBusy(id, null);
    }
  }

  // source: "registry" — install from the registry catalog even if an own plugin with this id is installed now (switch, consent
  // window always). Without it an installed own plugin is updated from its own folder.
  // preview: true — window only (diagnostic snapshot of the shell, peer.diagnostic): nothing is ever installed —
  // 428 with the window even if permissions don't grow; nothing to consent to — 409 consent:nothing. Pending windows for the same id
  // (shown to the human) are not reset.
  async installNow(id, { consentToken = null, peer = null, source = null, preview = false } = {}) {
    let prep;
    if (consentToken && preview) throw new RegistryError(403, "peer:diagnostic");
    if (consentToken) {
      const p = this.pending.get(consentToken);
      this.pending.delete(consentToken);
      if (!p || p.preview || p.id !== id || p.expires < Date.now() || p.pid !== (peer?.pid ?? null)) throw new RegistryError(403, "consent:invalid");
      prep = p.prep;
      if (prep.kind === "own") return this.commitOwnConsented(p, peer);
      // a new catalog may have arrived while the window was open
      // (same archive, but a different tier — the linter in prepare judged by the old tier)
      this.refreshCatalog();
      const cur = this.catalogEntry(id);
      if (!cur || cur.sha256 !== prep.entry.sha256 || cur.tier !== prep.entry.tier || cur.registry !== prep.entry.registry) throw new RegistryError(409, "registry:catalog-changed");
      if (this.blockReason(id, { version: cur.version, sha256: cur.sha256, registry: cur.registry })) throw new RegistryError(409, "registry:blocklist");
      this.requireFresh(cur.registry);
    } else {
      const inst = this.lockEntry(id);
      if (inst?.tier === "own" && source !== "registry") {
        // an own plugin comes from its own folder: without permission growth it's installed right away (like a registry update), otherwise the window
        prep = this.prepareOwn(inst.own?.path, { expectId: id });
      } else prep = await this.prepare(id);
      if (preview) {
        if (!prep.needsConsent) throw new RegistryError(409, "consent:nothing");
        this.askConsent(prep, peer, { preview: true });
      }
      if (prep.needsConsent) this.askConsent(prep, peer);
    }
    if (prep.kind === "own") return this.commitOwn(prep, peer);
    return this.commit(prep, peer);
  }

  commit(prep, peer, { auto = false } = {}) {
    // The hub pause may have been turned on while the human was reading permissions (consent window, typing the id in the terminal).
    if (this.estop()) throw new RegistryError(423, "estop");
    const own = prep.kind === "own";
    const { id, entry, files, perms, archive } = prep;
    const stage = join(this.dirs.staging, `${id}-${randomBytes(4).toString("hex")}`);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const hashes = {};
    try {
      for (const f of files) {
        const rel = f.path.slice(id.length + 1);
        const dest = join(stage, ...rel.split("/"));
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        const mode = f.mode & 0o111 ? 0o700 : 0o600;
        writeFileSync(dest, f.data, { mode });
        chmodSync(dest, mode);
        hashes[rel] = sha256(f.data);
      }
    } catch (e) {
      rmSync(stage, { recursive: true, force: true });
      throw new RegistryError(500, "registry:write", { detail: e.code || "write" });
    }
    const lock = this.lock();
    const before = lock.plugins[id] ? structuredClone(lock.plugins[id]) : null;
    const now = new Date().toISOString();
    lock.plugins[id] = {
      id,
      version: entry.version,
      sha256: entry.sha256,
      archive: entry.archive,
      tier: entry.tier,
      official: entry.tier === "official",
      // the registry it came from (G19): updates and officialness follow this registry only
      ...(!own && entry.registry ? { registry: entry.registry } : {}),
      installedAt: before?.installedAt || now,
      updatedAt: now,
      granted: perms,
      files: hashes,
      disabled: null,
      // own source: real folder path, title and translations (it has no registry catalog)
      ...(own ? { own: { path: prep.source.path }, title: entry.title, i18n: entry.i18n || {} } : {}),
    };
    // Lock first (and the consent for an own plugin — the fingerprint of exactly this entry), then files: the core policy checks new
    // files against the new lock.
    const approvalBefore = this.ownApproved.get(id) ?? null;
    this.saveLock(lock);
    this.writeApprovals({ [id]: own ? this.approvalDigest(id, lock.plugins[id]) : null });
    this.ownUnexpected.delete(id);
    const live = join(this.paths.plugins, id);
    const old = join(this.dirs.trash, `${id}-${randomBytes(4).toString("hex")}`);
    let movedOld = false;
    try {
      mkdirSync(this.paths.plugins, { recursive: true, mode: 0o700 });
      rmSync(join(this.dirs.disabled, id), { recursive: true, force: true });
      if (existsSync(live)) {
        renameSync(live, old);
        movedOld = true;
      }
      renameSync(stage, live);
      chmodSync(live, 0o700);
    } catch (e) {
      try {
        if (movedOld && !existsSync(live)) renameSync(old, live);
      } catch {}
      const l2 = this.lock();
      if (before) l2.plugins[id] = before;
      else delete l2.plugins[id];
      this.saveLock(l2);
      this.writeApprovals({ [id]: approvalBefore });
      rmSync(stage, { recursive: true, force: true });
      throw new RegistryError(500, "registry:install", { detail: e.code || "rename" });
    }
    rmSync(old, { recursive: true, force: true });
    this.clearLowered(id);
    // the previous version's attestation is no longer needed: the current catalog signs the new one
    this.dropAttest(id, before);
    // Archive of this version — for the officialness check (officialNow). If it fails to write, the plugin runs as community.
    // An own plugin has no archive: the previous registry archive (switch) is deleted — the copy won't become official.
    try {
      if (archive) atomicWrite(join(this.dirs.archives, `${id}.tar.gz`), archive);
      else rmSync(join(this.dirs.archives, `${id}.tar.gz`), { force: true });
    } catch (e) {
      this.log({ type: "warning", plugin: id, detail: msg("warn.archiveNotSaved", { why: e.code || e.message }) });
    }
    if (auto) {
      // automatic update of the own copy: same permissions, the human already consented to them; which files changed goes to the
      // log, the event becomes a "Plugin updated" notification (push service)
      const prevFiles = before?.files || {};
      const changedFiles = [...new Set([...Object.keys(prevFiles), ...Object.keys(hashes)])].filter((f) => prevFiles[f] !== hashes[f]).sort().slice(0, 20);
      this.log({ type: "plugin-own-updated", plugin: id, from: before?.version || null, version: entry.version, sha256: entry.sha256, files: changedFiles });
      this.emit({ type: "plugins.own-updated", plugin: id, version: entry.version, from: before?.version || null, files: changedFiles });
    } else {
      this.log({ type: "plugin-installed", plugin: id, version: entry.version, sha256: entry.sha256, update: Boolean(before), pid: peer?.pid, ...(own ? { source: "own" } : {}), ...(prep.migrate ? { migrate: prep.migrate.from } : {}) });
      this.emit({ type: "plugins.installed", plugin: id, version: entry.version, update: Boolean(before), ...(own ? { source: "own" } : {}) });
    }
    // the source folder is writable by the group (allowed with a warning, decision 2026-11-11): a separate journal line on every
    // install from such a folder, including automatic updates
    const risk = own ? ownRisk(prep.source?.writable) : null;
    if (risk) this.log({ type: "plugin-own-risk", plugin: id, version: entry.version, risk, path: prep.source.path, files: prep.source.writable.group.slice(0, 10), auto: Boolean(auto) });
    if (own) this.ownState.set(id, { status: "ok", checkedAt: now, version: entry.version, fingerprint: entry.sha256 });
    else this.ownState.delete(id);
    this.syncOwnWatch();
    this.changed();
    this.noteUpdates();
    return { ok: true, id, version: entry.version, update: Boolean(before), fromVersion: before?.version || null };
  }

  // POST /registry/remove: plugin files, lock entry, cache; PluginData only with purge.
  remove(id, { purge = false, peer = null } = {}) {
    if (typeof id !== "string" || !ID_RE.test(id) || RESERVED_IDS.has(id)) throw new RegistryError(400, "registry:id");
    const lock = this.lock();
    const live = join(this.paths.plugins, id);
    const off = join(this.dirs.disabled, id);
    if (!lock.plugins[id] && !existsSync(live) && !existsSync(off)) throw new RegistryError(404, "not-found");
    if (existsSync(live)) {
      const t = join(this.dirs.trash, `${id}-${randomBytes(4).toString("hex")}`);
      renameSync(live, t);
      rmSync(t, { recursive: true, force: true });
    }
    rmSync(off, { recursive: true, force: true });
    rmSync(join(this.dirs.archives, `${id}.tar.gz`), { force: true });
    this.dropAttest(id, lock.plugins[id]);
    rmSync(join(this.paths.pluginCache, id), { recursive: true, force: true });
    if (purge) rmSync(join(this.paths.pluginData, id), { recursive: true, force: true });
    const version = lock.plugins[id]?.version || null;
    const wasOwn = lock.plugins[id]?.tier === "own";
    delete lock.plugins[id];
    this.saveLock(lock);
    this.clearLowered(id);
    this.writeApprovals({ [id]: null });
    this.ownState.delete(id);
    this.ownUnexpected.delete(id);
    this.syncOwnWatch();
    this.log({ type: "plugin-removed-by-user", plugin: id, version, purge: Boolean(purge), pid: peer?.pid, ...(wasOwn ? { source: "own" } : {}) });
    this.emit({ type: "plugins.removed", plugin: id, ...(purge ? { purge: true } : {}) });
    this.changed();
    this.noteUpdates();
    return { ok: true, id };
  }
}
