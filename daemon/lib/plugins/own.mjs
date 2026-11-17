// PluginManager part: own plugins (from a local folder) — checking and preparing the folder, install requests
// (Registry/own-requests.json: request, list, decline) and their approval through the consent window.
// Watching the folders of installed own plugins: lib/plugins/own-watch.mjs.
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { contentLang, msg, pickLang } from "../i18n.mjs";
import { isAbsolutePath } from "../platform.mjs";
import { ID_RE, permissionGrowth, permissionList, permissionsFingerprint } from "../registry/perms.mjs";
import { inspectSource, OwnSourceError, shortPath } from "../registry/own-source.mjs";
import { atomicWrite, isStr, readJsonOr, RegistryError } from "./common.mjs";
import { compareVersions, contractTooNew, entryIcon, PLATFORM } from "./index-format.mjs";
import { cleanI18n, mergeI18n, permI18nFromMeta } from "./perm-i18n.mjs";

// An install request from an own folder lives for a day (the human may have stepped away from the Mac); at most 10 requests.
const OWN_REQUEST_TTL_MS = 24 * 3_600_000;
const OWN_REQUESTS_MAX = 10;

export class ManagerOwn {
  // ---------- own sources ----------

  // Folder check (lib/registry/own-source.mjs) with path errors as RegistryError.
  inspectOwn(path) {
    try {
      return inspectSource(path, { uid: this.uid, lang: this.langNow() });
    } catch (e) {
      if (e instanceof OwnSourceError) throw new RegistryError(e.status, e.code, e.extra);
      throw e;
    }
  }

  // Preparing an install from an own folder — like the registry's prepare, but bytes are read from the folder (in memory: exactly
  // what the human saw in the consent window gets installed), tier own, sha256 — content fingerprint. src — an already
  // checked folder (watching), otherwise it's checked again.
  prepareOwn(path, { expectId = null, src = null } = {}) {
    if (!path) throw new RegistryError(409, "own:no-source");
    src ||= this.inspectOwn(path);
    // contract before the linter: the linter treats contract tags newer than this core as errors, while the human needs
    // "needs a newer hub", not a list of cryptic errors (same as the registry, prepare)
    const tooNew = contractTooNew(src.meta?.contract);
    if (tooNew) throw new RegistryError(409, "own:hub-too-old", { id: src.id, path: src.dir, ...tooNew });
    if (src.errors.length || !src.meta) throw new RegistryError(422, "own:lint", { id: src.id, path: src.dir, errors: src.errors.slice(0, 20) });
    if (expectId && src.id !== expectId) throw new RegistryError(409, "own:id-changed", { id: src.id, expected: expectId });
    if (this.builtinIds().has(src.id)) throw new RegistryError(409, "registry:id-taken", { by: "builtin" });
    const meta = src.meta;
    if (meta.platforms.length && !meta.platforms.includes(PLATFORM)) throw new RegistryError(409, "registry:platform");
    const id = src.id;
    const perms = src.perms;
    const prev = this.lockEntry(id);
    // an own entry the manager didn't make (ownTrusted) doesn't count as consent: permissions as for a new install
    const unverified = Boolean(prev && prev.tier === "own" && !this.ownTrusted(id, prev));
    const base = prev && !unverified ? prev.granted : null;
    const growth = base ? permissionGrowth(base, perms, { pluginId: id }) : permissionList(perms, { pluginId: id });
    const addedKeys = new Set(growth.map((p) => p.key));
    const titles = {};
    for (const [lang, v] of Object.entries(meta.i18n || {})) if (v?.title) titles[lang] = { title: v.title };
    const i18n = mergeI18n(cleanI18n(titles), permI18nFromMeta(meta));
    const migrate = this.ownMigrate(id, prev, src.dir);
    // quietly (no window) — only the same permission set (including loud push rules) and no version rollback.
    // This is the consent rule of own plugins, on purpose (decisions 2026-11-09 and 2026-11-11, docs/plugins-registry.md
    // "Own plugins"): the human consented to a FOLDER and to a PERMISSION SET, not to bytes — an own plugin is the human's own
    // working copy and changes with every save. samePerms compares the full key set (permissionsFingerprint: every path,
    // host, command, secret, effect, connection, terminal word, subscription, action with its level, command and flags, loud
    // push rule), so a reinstall can never add a key without the window: one added key makes growth non-empty and
    // needsConsent true. What does change without a window is the code itself and what is not a key: the "why" texts,
    // titles, the run interval, an action's cost and input pattern, ordinary push rules. The residual risk is the folder:
    // whoever can write it runs code as this plugin with the permissions already granted (a folder writable by others is
    // refused or marked loudly at the request — lib/registry/own-source.mjs).
    const samePerms = Boolean(base) && permissionsFingerprint(base) === permissionsFingerprint(perms);
    const downgrade = Boolean(prev?.version && meta.version && compareVersions(meta.version, prev.version) < 0);
    return {
      kind: "own",
      icon: meta.icon || null,
      id,
      entry: { id, version: meta.version, title: meta.title || id, i18n, tier: "own", sha256: src.fingerprint, archive: null },
      archive: null,
      files: src.files.map((f) => ({ path: `${id}/${f.rel}`, data: f.data, mode: 0o644 })),
      perms,
      list: permissionList(perms, { pluginId: id }).map(({ key, ...p }) => ({ ...p, added: addedKeys.has(key) })),
      growth: growth.map(({ key, ...p }) => p),
      i18n,
      update: Boolean(prev),
      fromVersion: prev?.version || null,
      source: { path: src.dir, fingerprint: src.fingerprint, writable: src.writable, warnings: src.warnings.slice(0, 10) },
      migrate,
      unverified,
      downgrade,
      samePerms,
      needsConsent: !prev || unverified || growth.length > 0 || Boolean(prev.disabled) || Boolean(migrate),
    };
  }

  // Switch marker for own plugin id from folder dir: the same id is installed from the registry (official/community) or from
  // another own folder; not installed but present in the registry catalog — "catalog" (the own plugin gets everything bound to
  // the id: agent-hub.<id> secrets in the keychain, PluginData/<id>, notification rules "<id>:<key>"). Window — always.
  ownMigrate(id, prev, dir) {
    if (prev && prev.tier !== "own") return { from: this.officialNow(id, prev) ? "official" : "community", version: prev.version };
    if (prev && prev.own?.path !== dir) return { from: "own", version: prev.version, path: prev.own?.path || null };
    if (prev) return null;
    this.refreshCatalog();
    const ce = this.catalog?.plugins.get(id);
    if (!ce) return null;
    const lang = this.langNow();
    return { from: "catalog", tier: ce.tier, version: ce.version, title: pickLang(ce.title, ce.i18n, "title", lang) || id };
  }

  commitOwn(prep, peer, opts = {}) {
    const r = this.commit(prep, peer, opts);
    return { ...r, source: "own", path: prep.source.path };
  }

  // Install via the consent window token: the request (if any) is removed.
  commitOwnConsented(p, peer) {
    const r = this.commitOwn(p.prep, peer);
    if (p.requestId) this.dropRequest(p.requestId, "installed");
    return r;
  }

  pruneRequests() {
    const now = Date.now();
    let changed = false;
    for (const [k, r] of this.ownRequests) {
      if (Date.parse(r.expiresAt) < now) {
        this.ownRequests.delete(k);
        changed = true;
      }
    }
    if (changed) this.saveRequests();
  }

  // Requests survive a daemon restart (the CLI promises "valid for a day"): Registry/own-requests.json, 0600, without
  // bytes — only what's visible in the list; on approval the folder is checked again anyway.
  requestsPath() {
    return join(this.dirs.registry, "own-requests.json");
  }
  loadRequests() {
    const j = readJsonOr(this.requestsPath(), null);
    this.ownRequests = new Map();
    const now = Date.now();
    for (const r of Array.isArray(j?.requests) ? j.requests.slice(-OWN_REQUESTS_MAX) : []) {
      if (!r || typeof r.requestId !== "string" || !/^[\w-]{8,64}$/.test(r.requestId)) continue;
      if (typeof r.id !== "string" || !ID_RE.test(r.id) || !isAbsolutePath(r.path)) continue;
      if (!(Date.parse(r.expiresAt) > now)) continue;
      const titles = r.titles && typeof r.titles === "object" && !Array.isArray(r.titles) ? Object.fromEntries(Object.entries(r.titles).filter(([k, v]) => isStr(k, 8) && isStr(v, 200))) : {};
      this.ownRequests.set(r.requestId, {
        requestId: r.requestId,
        id: r.id,
        titles: Object.keys(titles).length ? titles : { "": r.id },
        version: isStr(r.version, 64) ? r.version : null,
        path: r.path,
        fingerprint: typeof r.fingerprint === "string" && /^[0-9a-f]{64}$/.test(r.fingerprint) ? r.fingerprint : null,
        permissions: Number.isInteger(r.permissions) ? r.permissions : 0,
        update: r.update === true,
        migrate: r.migrate && typeof r.migrate === "object" && isStr(r.migrate.from, 16) ? r.migrate : null,
        icon: entryIcon(r.icon),
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        by: isStr(r.by, 16) ? r.by : null,
        ...(r.reason === "unexpected" ? { reason: "unexpected" } : {}),
        ...(r.risk === "group-writable" ? { risk: r.risk } : {}),
      });
    }
  }
  saveRequests() {
    try {
      atomicWrite(this.requestsPath(), JSON.stringify({ version: 1, requests: [...this.ownRequests.values()] }, null, 2) + "\n");
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.own.requestsNotSaved", { why: e.code || e.message }) });
    }
  }

  dropRequest(requestId, done) {
    const r = this.ownRequests.get(requestId);
    if (!r) return false;
    this.ownRequests.delete(requestId);
    this.saveRequests();
    this.emit({ type: "plugins.own-request", requestId, plugin: r.id, done });
    return true;
  }

  // POST /registry/own/request (`agenthub plugins install --from <folder>`, the "Add from folder…" button): a request.
  // Any local process can create it; only a human in the pinned app can install it (approveOwn).
  // The folder is checked right away (same linter as the registry): with errors there's no request. → { ok, pending, requestId, … }
  // | { ok, already } (the same folder with the same content is already installed).
  // A request for the same id from another folder doesn't displace a pending one: 409 own:request-conflict (the human
  // would approve a folder other than the one requested from the terminal) — decline the previous one first. reason: "unexpected" —
  // the manager created the request itself (own entry in lock not confirmed, noteUnexpectedOwn).
  requestOwn(path, { peer = null, reason = null } = {}) {
    if (!this.pinned()) throw new RegistryError(409, "own:no-app");
    const src = this.inspectOwn(path);
    // contract before the linter (see prepareOwn)
    const tooNew = contractTooNew(src.meta?.contract);
    if (tooNew) {
      this.log({ type: "plugin-own-rejected", plugin: src.id, error: "own:hub-too-old", need: tooNew.need, have: tooNew.have });
      throw new RegistryError(409, "own:hub-too-old", { id: src.id, path: src.dir, ...tooNew });
    }
    if (src.errors.length || !src.meta) {
      this.log({ type: "plugin-own-rejected", plugin: src.id, error: "own:lint", count: src.errors.length });
      throw new RegistryError(422, "own:lint", { id: src.id, path: src.dir, errors: src.errors.slice(0, 20) });
    }
    if (this.builtinIds().has(src.id)) throw new RegistryError(409, "registry:id-taken", { by: "builtin" });
    if (src.meta.platforms.length && !src.meta.platforms.includes(PLATFORM)) throw new RegistryError(409, "registry:platform");
    const inst = this.lockEntry(src.id);
    if (inst?.tier === "own" && inst.own?.path === src.dir && inst.sha256 === src.fingerprint && !inst.disabled && this.ownTrusted(src.id, inst)) {
      return { ok: true, already: true, id: src.id, version: src.version, path: src.dir };
    }
    this.pruneRequests();
    const other = [...this.ownRequests.values()].find((r) => r.id === src.id && r.path !== src.dir);
    if (other) {
      if (reason === "unexpected") return { ok: true, pending: true, ...this.requestView(other) };
      this.log({ type: "plugin-own-rejected", plugin: src.id, error: "own:request-conflict", pid: peer?.pid });
      throw new RegistryError(409, "own:request-conflict", { id: src.id, path: src.dir, pending: { requestId: other.requestId, path: other.path, pathShort: shortPath(other.path) } });
    }
    for (const [rid, r] of this.ownRequests) if (r.path === src.dir || r.id === src.id) this.ownRequests.delete(rid);
    if (this.ownRequests.size >= OWN_REQUESTS_MAX) throw new RegistryError(429, "own:too-many-requests", { max: OWN_REQUESTS_MAX });
    const migrate = this.ownMigrate(src.id, inst, src.dir);
    const titles = { "": src.meta.title || src.id };
    for (const [lang, v] of Object.entries(src.meta.i18n || {})) if (v?.title) titles[lang] = v.title;
    const now = Date.now();
    const rq = {
      requestId: randomBytes(12).toString("base64url"),
      id: src.id,
      titles,
      version: src.version,
      path: src.dir,
      fingerprint: src.fingerprint,
      permissions: permissionList(src.perms).length,
      update: Boolean(inst),
      migrate,
      icon: src.meta.icon || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + OWN_REQUEST_TTL_MS).toISOString(),
      by: peer?.class || null,
      ...(reason === "unexpected" ? { reason } : {}),
      ...(ownRisk(src.writable) ? { risk: ownRisk(src.writable) } : {}),
    };
    this.ownRequests.set(rq.requestId, rq);
    this.saveRequests();
    this.log({ type: "plugin-own-requested", plugin: src.id, version: src.version, by: rq.by, pid: peer?.pid, ...(migrate ? { migrate: migrate.from } : {}), ...(reason ? { reason } : {}), ...(rq.risk ? { risk: rq.risk } : {}) });
    this.emit({ type: "plugins.own-request", requestId: rq.requestId, plugin: src.id, version: src.version });
    return { ok: true, pending: true, ...this.requestView(rq) };
  }

  requestView(r, lang = this.langNow()) {
    return {
      requestId: r.requestId,
      id: r.id,
      title: (r.titles[contentLang(Object.fromEntries(Object.entries(r.titles).filter(([k]) => k).map(([k, v]) => [k, { title: v }])), lang, { field: "title" })] ?? null) || r.titles[""] || r.id,
      version: r.version,
      path: r.path,
      pathShort: shortPath(r.path),
      fingerprint: r.fingerprint,
      permissions: r.permissions,
      update: r.update,
      migrate: r.migrate ? { ...r.migrate, ...(r.migrate.path ? { pathShort: shortPath(r.migrate.path) } : {}), ...(r.migrate.from === "catalog" ? { title: this.catalogTitle(r.id, lang) || r.migrate.title } : {}) } : null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      by: r.by,
      reason: r.reason || null,
      icon: r.icon || null,
      // the folder is writable by the group (allowed with a warning): the CLI prints the loud line, the window shows it again
      risk: r.risk || null,
    };
  }

  // Catalog plugin title in language lang (the "catalog" marker in a request is in the display language, not the request's).
  catalogTitle(id, lang = this.langNow()) {
    const ce = this.catalog?.plugins.get(id);
    return ce ? pickLang(ce.title, ce.i18n, "title", lang) || null : null;
  }

  ownRequestList() {
    this.pruneRequests();
    return [...this.ownRequests.values()].map((r) => this.requestView(r));
  }

  // POST /registry/own/decline — the human declined the request.
  declineOwn(requestId, { peer = null } = {}) {
    const r = this.ownRequests.get(requestId);
    if (!r) throw new RegistryError(404, "own:no-request");
    this.dropRequest(requestId, "declined");
    this.log({ type: "plugin-own-declined", plugin: r.id, version: r.version, pid: peer?.pid });
    return { ok: true, id: r.id };
  }

  // POST /registry/own/approve: without a token — the folder is checked again and always 428 with the consent window (path,
  // id, version, fingerprint, permissions; a marker if the content changed after the request); with a token — install exactly
  // the bytes that were in the window.
  // A request is bound to its folder: if the request folder was replaced (by a symlink or another folder) — refusal own:path-changed, a new
  // request. preview — a window for a diagnostic snapshot: installs nothing and doesn't reset other windows.
  approveOwn(requestId, { consentToken = null, peer = null, preview = false } = {}) {
    if (this.estop()) throw new RegistryError(423, "estop");
    this.pruneRequests();
    const rq = this.ownRequests.get(requestId);
    if (!rq) throw new RegistryError(404, "own:no-request");
    if (consentToken && preview) throw new RegistryError(403, "peer:diagnostic");
    if (consentToken) {
      const p = this.pending.get(consentToken);
      this.pending.delete(consentToken);
      if (!p || p.preview || p.requestId !== requestId || p.id !== rq.id || p.expires < Date.now() || p.pid !== (peer?.pid ?? null)) throw new RegistryError(403, "consent:invalid");
      if (p.prep.source?.path !== rq.path) throw new RegistryError(409, "own:path-changed", { path: rq.path, now: p.prep.source?.path || null });
      return this.commitOwnConsented(p, peer);
    }
    const src = this.inspectOwn(rq.path);
    if (src.dir !== rq.path) {
      this.log({ type: "plugin-own-rejected", plugin: rq.id, error: "own:path-changed", pid: peer?.pid });
      throw new RegistryError(409, "own:path-changed", { path: rq.path, now: src.dir });
    }
    const prep = this.prepareOwn(rq.path, { expectId: rq.id, src });
    this.askConsent(prep, peer, { requestId, ...(preview ? { preview: true } : {}) }, { changedSinceRequest: prep.source.fingerprint !== rq.fingerprint });
  }
}

// Source in the consent window: real folder path and the same for display (with "~"), content fingerprint, who can write
// to the folder (only you; your group too — accepted with the "group-writable" risk line; anyone else — the request can't be
// accepted), linter warnings (immediate actions) and push rule
// warnings (kind="security", core keys) — for an own plugin the reviewer is the human themselves.
export function ownSourceView(src) {
  return {
    kind: "own",
    path: src.path,
    pathShort: shortPath(src.path),
    fingerprint: src.fingerprint,
    writable: { mine: src.writable?.mine !== false, others: src.writable?.others || [], group: src.writable?.group || [], parentOpen: Boolean(src.writable?.parentOpen), acl: src.writable?.acl || [] },
    // a loud line in the window (the WRITE_RISK_TEXT kind): the folder is writable by the group — allowed, but the human must see it
    risk: ownRisk(src.writable),
    warnings: src.warnings || [],
  };
}

// The risk of an own plugin folder that is still accepted: writable by the group (umask 002), not by everyone. → "group-writable" | null
export function ownRisk(writable) {
  return Array.isArray(writable?.group) && writable.group.length > 0 ? "group-writable" : null;
}
