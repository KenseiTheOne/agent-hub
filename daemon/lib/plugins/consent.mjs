// PluginManager part: consent — the one-time token of the permissions window (askConsent → 428) and the record of the
// own-plugin entries the manager itself approved (Registry/own-approvals.json: ownTrusted, noteUnexpectedOwn).
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { msg, pickLang } from "../i18n.mjs";
import { fileSig } from "../config.mjs";
import { ID_RE, permissionsFingerprint } from "../registry/perms.mjs";
import { shortPath } from "../registry/own-source.mjs";
import { atomicWrite, CONSENT_TTL_MS, readJsonOr, RegistryError, sha256 } from "./common.mjs";
import { ownSourceView } from "./own.mjs";
import { localizePerms } from "./perm-i18n.mjs";
import { registryLabel, tierLabel } from "./sources.mjs";

export class ManagerConsent {
  // ---------- consents for own plugins ----------
  approvalsPath() {
    return join(this.dirs.registry, "own-approvals.json");
  }

  // Fingerprint of an own plugin's lock entry: folder path, content fingerprint, copy files and granted permissions.
  approvalDigest(id, e) {
    const files = Object.entries(e?.files || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return sha256(JSON.stringify([id, e?.own?.path || null, e?.sha256 || null, files, permissionsFingerprint(e?.granted)]));
  }

  // Consents file: id → fingerprint (cached by file signature).
  readApprovalsDisk() {
    const path = this.approvalsPath();
    const sig = fileSig(path);
    if (this.approvalsDisk?.sig === sig) return this.approvalsDisk.map;
    const map = new Map();
    const j = readJsonOr(path, null);
    if (j?.version === 1 && j.plugins && typeof j.plugins === "object") {
      for (const [id, r] of Object.entries(j.plugins)) if (ID_RE.test(id) && typeof r?.digest === "string") map.set(id, r.digest);
    }
    this.approvalsDisk = { sig, map };
    return map;
  }

  // Writing consents: only what's both in memory and in the file (a revocation from the file stands, a foreign entry doesn't), plus
  // change (id → fingerprint | null — remove).
  writeApprovals(change = {}) {
    const disk = this.readApprovalsDisk();
    const next = new Map();
    for (const [id, d] of this.ownApproved) if (disk.get(id) === d) next.set(id, d);
    for (const [id, d] of Object.entries(change)) {
      if (d) next.set(id, d);
      else next.delete(id);
    }
    this.ownApproved = next;
    const plugins = {};
    for (const [id, digest] of next) plugins[id] = { digest };
    try {
      atomicWrite(this.approvalsPath(), JSON.stringify({ version: 1, plugins }, null, 2) + "\n");
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.own.consentsNotSaved", { why: e.code || e.message }) });
    }
    this.approvalsDisk = null;
  }

  // Was the own entry in lock made by the manager itself after human consent (or by a quiet update from the same folder)?
  ownTrusted(id, e) {
    if (e?.tier !== "own") return false;
    const mem = this.ownApproved.get(id);
    if (!mem || mem !== this.approvalDigest(id, e)) return false;
    return this.readApprovalsDisk().get(id) === mem;
  }

  // An own entry the manager didn't make: report once per its fingerprint — log, event (push service — security
  // exception) and a re-approval request from the entry's folder (if it passes the check).
  noteUnexpectedOwn(id, e) {
    const digest = this.approvalDigest(id, e);
    if (this.ownUnexpected.get(id) === digest) return;
    this.ownUnexpected.set(id, digest);
    this.log({ type: "plugin-own-unexpected", plugin: id, version: e.version || null, path: e.own?.path || null, sha256: e.sha256 || null });
    this.emit({ type: "plugins.own-unexpected", plugin: id, version: e.version || null });
    const path = e.own?.path;
    if (!path) return;
    setImmediate(() => {
      try {
        this.requestOwn(path, { peer: { class: "hub" }, reason: "unexpected" });
      } catch (err) {
        this.log({ type: "plugin-own-rejected", plugin: id, error: err?.code || "own:error", reason: "unexpected" });
      }
    });
  }

  // Consent window: a one-time token for 120 s bound to the id, the prepared bytes and the app pid → 428.
  // extra — goes into the token record (requestId of the request), body — extra window fields.
  askConsent(prep, peer, extra = {}, body = {}) {
    const id = prep.id;
    const token = randomBytes(18).toString("base64url");
    // a new window for the same id cancels the previous one; a snapshot (preview) window doesn't: it installs nothing
    for (const [t, p] of this.pending) if (p.expires < Date.now() || (p.id === id && !extra.preview)) this.pending.delete(t);
    if (this.pending.size > 20) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(token, { id, pid: peer?.pid ?? null, expires: Date.now() + CONSENT_TTL_MS, prep, ...extra });
    this.log({ type: "plugin-consent-requested", plugin: id, version: prep.entry.version, added: prep.growth.length, pid: peer?.pid, ...(prep.kind === "own" ? { source: "own" } : {}), ...(prep.migrate ? { migrate: prep.migrate.from } : {}) });
    const lang = this.langNow();
    throw new RegistryError(428, "consent-required", {
      needsConsent: true,
      token,
      expiresInMs: CONSENT_TTL_MS,
      id,
      title: pickLang(prep.entry.title, prep.entry.i18n, "title", lang),
      tier: prep.entry.tier,
      ...(prep.kind === "own" ? {} : { registry: prep.entry.registry || null, registryLabel: registryLabel(prep.entry.registry, this.sources()), tierLabel: tierLabel(prep.entry.tier, prep.entry.registry, this.sources()) }),
      version: prep.entry.version,
      fromVersion: prep.fromVersion,
      update: prep.update,
      sha256: prep.entry.sha256,
      permissions: localizePerms(prep.list, prep.i18n, lang),
      added: localizePerms(prep.growth, prep.i18n, lang),
      // own source: folder path (realpath and, for display, with "~"), content fingerprint, who can write to the folder
      source: prep.kind === "own" ? ownSourceView(prep.source) : { kind: "registry" },
      // switch: the same id is already installed from the registry (official/community) or from another own folder — or vice versa
      migrate: prep.migrate ? { ...prep.migrate, ...(prep.migrate.path ? { pathShort: shortPath(prep.migrate.path) } : {}) } : null,
      // plugin icon (<agenthub.icon>): the consent window tile is drawn from the declaration, not by id
      icon: prep.icon || null,
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      ...body,
    });
  }
}
