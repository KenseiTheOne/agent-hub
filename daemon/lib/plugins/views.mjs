// PluginManager part: what the shell and the CLI see — available updates (pluginUpdates), the catalog list
// (GET /registry/catalog) and the installed list (GET /registry/installed).
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentOf, msg, pickLang } from "../i18n.mjs";
import { liveStateDir, samePath } from "../platform.mjs";
import { scanDir } from "../host.mjs";
import { permissionGrowth, permissionList, permissionsFromMeta } from "../registry/perms.mjs";
import { expandPath, shortPath } from "../registry/own-source.mjs";
import { compareVersions, entryContractTooNew, PLATFORM } from "./index-format.mjs";
import { localizePerms } from "./perm-i18n.mjs";
import { registryLabel, tierLabel } from "./sources.mjs";

// CLI next to the daemon: the shell shows the registry connection command with the full path (agenthub isn't in PATH).
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agenthub");
// The label of a Plugins/local plugin in /registry/installed, in the hub language.
export const unverifiedLabel = () => msg("plugins.unverified");

export class ManagerViews {
  // ---------- available updates ----------
  // Installed plugins whose version in the verified catalog is newer: { id, title, installed, version, sha256,
  // tier, permissionsGrow, added } — added: permissions of the new version beyond the granted ones (in the hub language). A rollback (older
  // in the catalog) and a rebuilt archive of the same version aren't included: only the manager reports those. A new version blocked
  // by the registry and a foreign platform — also not.
  pluginUpdates() {
    const lock = this.lock();
    const lang = this.langNow();
    const out = [];
    for (const [id, inst] of Object.entries(lock.plugins)) {
      if (inst.tier === "own") {
        // own plugin: the update comes from its own folder, only what awaits consent (permissions grew) goes into the list;
        // without permission growth the copy installs itself (checkOwn)
        const st = this.ownState.get(id);
        if (st?.status !== "update") continue;
        const growth = st.growth || [];
        out.push({
          id,
          title: pickLang(inst.title, inst.i18n, "title", lang) || id,
          installed: inst.version,
          version: st.version,
          sha256: st.fingerprint,
          tier: "own",
          source: "own",
          path: inst.own?.path || null,
          permissionsGrow: growth.length > 0,
          added: localizePerms(growth, st.i18n || inst.i18n, lang),
          downgrade: Boolean(st.downgrade),
          // one notification per new content (the own folder's version may not change)
          notifyKey: `${id}@${st.version}#${String(st.fingerprint || "").slice(0, 12)}`,
        });
        continue;
      }
      const ce = this.catalogEntry(id, inst);
      if (!ce || ce.sha256 === inst.sha256) continue;
      if (compareVersions(ce.version, inst.version) <= 0) continue;
      if (this.blockReason(id, { version: ce.version, sha256: ce.sha256, registry: ce.registry })) continue;
      if (ce.platforms.length && !ce.platforms.includes(PLATFORM)) continue;
      // a version that needs a newer hub is not "update available": this hub wouldn't let it be installed anyway
      // (registry:hub-too-old); the catalog shows it with "Needs a newer hub" (listCatalog → needsHub)
      if (entryContractTooNew(ce)) continue;
      const growth = permissionGrowth(inst.granted, ce.permissions, { pluginId: ce.id }).map(({ key, ...p }) => p);
      out.push({
        id,
        title: pickLang(ce.title, ce.i18n, "title", lang),
        installed: inst.version,
        version: ce.version,
        sha256: ce.sha256,
        tier: ce.tier,
        registry: ce.registry || null,
        registryLabel: registryLabel(ce.registry, this.sources()),
        permissionsGrow: growth.length > 0,
        added: localizePerms(growth, ce.i18n, lang),
      });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // ---------- lists for the shell ----------
  listCatalog() {
    const lock = this.lock();
    const builtin = this.builtinIds();
    const plugins = [];
    const srcs = this.sources();
    for (const first of this.catalog?.plugins.values() || []) {
      const inst = lock.plugins[first.id] || null;
      // an own plugin with this id is installed: the catalog doesn't update it (switching to the catalog only explicitly, with a window)
      const own = inst?.tier === "own";
      // an installed registry plugin is shown from the registry it came from (G19); gone from there — the first listing, no update
      const pinned = inst && !own ? this.catalogEntry(first.id, inst) : null;
      const e = pinned || first;
      const elsewhere = Boolean(inst && !own && !pinned);
      const growth = inst && !own ? permissionGrowth(inst.granted, e.permissions, { pluginId: e.id }).map(({ key, ...p }) => p) : null;
      const lang = this.langNow();
      plugins.push({
        id: e.id,
        version: e.version,
        title: pickLang(e.title, e.i18n, "title", lang),
        desc: pickLang(e.desc, e.i18n, "desc", lang),
        author: e.author,
        platforms: e.platforms,
        type: e.type,
        interval: e.interval,
        tier: e.tier,
        official: e.tier === "official",
        label: e.tier === "official" ? "official" : null,
        // G19: the registry listing it, the label suffix (null with only the default registry) and the full tier label
        registry: e.registry || null,
        registryLabel: registryLabel(e.registry, srcs),
        tierLabel: tierLabel(e.tier, e.registry, srcs),
        ...(e.capped ? { capped: true } : {}),
        sha256: e.sha256,
        size: e.size,
        permissions: localizePerms(permissionList(e.permissions, { pluginId: e.id }).map(({ key, ...p }) => p), e.i18n, lang),
        installed: inst ? inst.version : null,
        installedOwn: own ? { path: inst.own?.path || null, pathShort: shortPath(inst.own?.path || "") } : null,
        updateAvailable: Boolean(inst && !own && !elsewhere && inst.sha256 !== e.sha256),
        growth,
        // "Requires <program>": the dependency and whether it's installed (whether the check path exists in the plugins' HOME)
        requires: (e.requires || []).map((r) => {
          const tr = contentOf(e.i18n, lang, { field: "requires" }).requires?.[r.name] || {};
          return { name: tr.name || r.name, url: r.url, note: tr.note || r.note || null, check: r.check, present: existsSync(expandPath(r.check, this.homeDir())) };
        }),
        blocked: this.blockReason(e.id, { version: e.version, sha256: e.sha256, registry: e.registry }),
        builtin: builtin.has(e.id),
        platformOk: !e.platforms.length || e.platforms.includes(PLATFORM),
        // contract 2: icon from the index and "needs a newer hub" (the plugin needs a newer contract than this core)
        icon: e.icon || null,
        contract: e.contract || 1,
        ...(entryContractTooNew(e) ? { needsHub: entryContractTooNew(e) } : {}),
      });
    }
    return {
      configured: this.configured(),
      // what's missing to connect the (first) registry: the index URL, the public key, or both
      missing: [!this.indexUrl() && "index-url", !this.publicKey() && "public-key"].filter(Boolean),
      generatedAt: this.catalog?.generatedAt || null,
      fetchedAt: this.catalog?.fetchedAt || null,
      // G19: every configured registry ({name, trust, label, configured, missing, generatedAt, fetchedAt, plugins, error,
      // tierLabel}) and the ids a later registry also lists (hidden: the earlier registry wins)
      registries: this.registriesView(),
      shadowed: (this.catalog?.shadowed || []).map((x) => ({ ...x })),
      error: this.catalogError,
      // for the "how to connect" hint: CLI with the full path and the hub directory (non-default — AGENTHUB_HOME=…)
      connect: { cli: CLI_PATH, home: this.paths.home, defaultHome: samePath(this.paths.home, liveStateDir()) },
      plugins,
    };
  }

  listInstalled() {
    const lock = this.lock();
    const installed = Object.values(lock.plugins).map((e) => {
      if (e.tier === "own") return this.ownInstalledView(e);
      // tier — as in the policy: by the verified catalog right now, not by the lock entry
      const official = this.officialNow(e.id, e);
      const ce = this.catalogEntry(e.id, e);
      const lang = this.langNow();
      const reg = this.registryOf(e);
      return {
        id: e.id,
        title: ce ? pickLang(ce.title, ce.i18n, "title", lang) : e.id,
        // official in the catalog, but the archive is of another version: until updated it runs as a community plugin
        officialPending: !official && ce?.tier === "official" && ce.sha256 !== e.sha256,
        updateAvailable: Boolean(ce && ce.sha256 !== e.sha256),
        version: e.version,
        sha256: e.sha256,
        tier: official ? "official" : "community",
        official,
        // G19: the registry it was installed from; registryLabel — null with only the default registry
        registry: reg,
        registryLabel: registryLabel(reg, this.sources()),
        tierLabel: tierLabel(official ? "official" : "community", reg, this.sources()),
        source: "installed",
        // official and third-party plugins are removed by the manager; built-ins (app directory) are not
        removable: true,
        label: null,
        disabled: e.disabled ? e.disabled.reason : null,
        installedAt: e.installedAt,
        updatedAt: e.updatedAt,
        permissions: localizePerms(permissionList(e.granted, { pluginId: e.id }).map(({ key, ...p }) => p), ce?.i18n, lang),
      };
    });
    const local = [];
    try {
      for (const pl of scanDir(this.paths.pluginsLocal, "local").plugins) {
        local.push({
          id: pl.id,
          version: pl.meta.version,
          source: "local",
          tier: "local",
          label: unverifiedLabel(),
          effectsCeiling: ["open.*"],
          blocked: this.blockReason(pl.id, { any: true }),
          permissions: permissionList(permissionsFromMeta(pl.meta), { pluginId: pl.id }).map(({ key, ...p }) => p),
        });
      }
    } catch {}
    return { installed, local, requests: this.ownRequestList() };
  }

  // "Installed" row for an own plugin: folder path, its state, update with permission growth.
  ownInstalledView(e) {
    const lang = this.langNow();
    const st = this.ownState.get(e.id) || null;
    return {
      id: e.id,
      title: pickLang(e.title, e.i18n, "title", lang) || e.id,
      officialPending: false,
      updateAvailable: st?.status === "update",
      version: e.version,
      sha256: e.sha256,
      tier: "own",
      official: false,
      source: "installed",
      removable: true,
      label: null,
      disabled: e.disabled ? e.disabled.reason : null,
      installedAt: e.installedAt,
      updatedAt: e.updatedAt,
      permissions: localizePerms(permissionList(e.granted, { pluginId: e.id }).map(({ key, ...p }) => p), e.i18n, lang),
      own: {
        path: e.own?.path || null,
        pathShort: shortPath(e.own?.path || ""),
        // ok | update (permissions grew — consent window; narrowed or version rollback — one click) | paused (waiting for the hub
        // pause to lift) | unverified (lock entry not confirmed — runs as community, awaits a request) | missing |
        // broken | unknown
        status: st?.status || "unknown",
        downgrade: Boolean(st?.downgrade),
        error: st?.error || null,
        errors: st?.errors || [],
        // own:hub-too-old: the plugin in the folder requires a newer contract (need) than the hub understands (have)
        ...(Number.isInteger(st?.need) ? { need: st.need, have: st.have } : {}),
        checkedAt: st?.checkedAt || null,
        fingerprint: e.sha256,
        next: st && st.fingerprint && st.fingerprint !== e.sha256 ? { version: st.version || null, fingerprint: st.fingerprint } : null,
        growth: st?.status === "update" ? localizePerms(st.growth || [], st.i18n || e.i18n, lang) : [],
      },
    };
  }
}
