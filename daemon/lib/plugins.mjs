// Plugin manager (stage 8): catalog from a signed index.json, archive install by sha256,
// plugins.lock with granted permissions, re-consent when permissions grow, removal, blocklist,
// Plugins/local as "unverified".
//
// This file holds the PluginManager class itself: its fields and start, the busy marks, the journal and events,
// plugins.lock and the options from config.json, and the manager-per-state-directory table. The rest of its methods live
// in lib/plugins/, one file per area, and are installed on PluginManager.prototype at the end of this file (lib/parts.mjs):
//   plugins/sources.mjs   — the configured registries (G19)
//   plugins/keys.mjs      — accepted registry keys
//   plugins/catalog.mjs   — the catalog: verifying, caching and downloading signed indexes and archives
//   plugins/blocklist.mjs — the registry blocklist
//   plugins/trust.mjs     — the policy for the core, the tier of an installed plugin, Plugins/ against plugins.lock
//   plugins/consent.mjs   — the consent window token, the record of approved own entries
//   plugins/install.mjs   — install from the registry, commit, removal
//   plugins/own.mjs       — own plugins: folder check, requests, approval
//   plugins/own-watch.mjs — watching own plugin folders
//   plugins/views.mjs     — available updates and the lists for the shell
// Without a manager (constants and pure functions): plugins/common.mjs, plugins/index-format.mjs, plugins/perm-i18n.mjs.
// The public names of all of them are re-exported here: `import { PluginManager, parseIndex, … } from "./plugins.mjs"` works
// as before.
//
// Who calls what:
//   lib/services/plugins.mjs — creates the manager, sets the core plugin policy (ctx.setPluginPolicy);
//   lib/routes/plugins.mjs   — HTTP: /registry/* (install and removal — app class only).
//
// Where things live (in the AgentHub state directory):
//   Plugins/<id>/            — an installed plugin (exactly what's in plugins.lock; written only by the manager)
//   Plugins/local/           — development: "unverified", effects only open.* (the core enforces the ceiling)
//   plugins.lock             — { version, plugins: { <id>: { version, sha256, granted, files, disabled } } }, 0600
//   Registry/index.json(.minisig) — the last verified catalog; Registry/state.json — rollback protection
//   Registry/staging|trash   — temporary during install; Registry/disabled/<id> — disabled by the blocklist;
//   Registry/quarantine/<id> — what landed in Plugins/ bypassing the manager (not in lock, files changed);
//   Registry/archives/<id>.tar.gz — archive of the installed version (sha256 from the signed index): the policy
//                              uses it to verify that the files on disk are exactly the official archive.
//   Registry/attest/<id>.json(.minisig) — the signed index in which the installed version was official
//                              (kept when a new catalog replaces it): through it an official plugin stays
//                              official until the user updates it to the released version.
//
// The policy takes the tier of an installed plugin from the verified catalog at check time, not from
// plugins.lock: official only if the signed index currently names this id official, the archive sha256 in lock
// is signed as official (by the current catalog or the saved Registry/attest/<id> — the index where this version was
// the latest) and the files on disk match the contents of the saved archive. A new release of an official plugin
// doesn't change the tier of the installed one: until updated it works as before (actions, its own push rules, service
// variables). If the registry owner lowered the tier or lock was written bypassing the manager, the plugin runs as community
// (without actions and its own push rules).
//
// "Official" is only what the signed catalog lists as official right now (decision 2026-11-11): a plugin installed as official
// whose id the current verified index no longer lists (or lists as community — official.json in the registry) is community
// from the next policy check on — permission ceiling, effects, actions and consent rules as for community, and the UI simply
// shows the tier it has now. The transition is journaled once (plugin-tier-lowered, and plugin-tier-restored if the catalog
// lists it as official again); Registry/tiers.json remembers the lowered ids across restarts. Only a verified catalog moves the
// tier: a failed download or a rejected signature keeps the last verified index on disk and in memory (fetchCatalog throws before
// replacing anything), so a network error never demotes a plugin.
//
// Own sources (decision 2026-11-09, lib/registry/own-source.mjs): a plugin from a local folder (convention — agenthub/<id>/ in
// the repository). An install request (POST /registry/own/request, `agenthub plugins install --from <folder>`) can be
// created by any local process, but only a human in the pinned app can install it (POST /registry/own/approve
// → 428 with the consent window → token). The copy goes to Plugins/<id> (the copy runs, not the repository folder), lock entry:
// tier "own", sha256 — content fingerprint, own.path — the folder's realpath. Tier own: trusted like official.
// The manager watches the folder (fs.watch + reconciliation once a minute): content changed, same permissions — the new copy
// is installed automatically without a window (log plugin-own-updated, event plugins.own-updated → the push service's "Plugin
// updated" banner, kind "updates", decision 2026-11-11); permissions grew — "Update
// available" and the consent window; folder gone or broken — the plugin runs on the last copy, the UI shows
// a warning. An own plugin never becomes official: it has no archive or registry attestation, and switching from
// an installed registry plugin to an own one with the same id goes only through the consent window marked as a switch.
//
// Tier own is not taken from the tier field in plugins.lock (any user process can write it): an own entry
// is trusted only if the manager itself made it — after the consent window (approveOwn, /registry/install with a token) or
// by a quiet update from the same folder. The manager remembers a fingerprint of every such entry (path, content fingerprint,
// files, permissions) in daemon memory and in Registry/own-approvals.json; an entry in the file the daemon didn't make while
// running grants no trust (the file can only revoke consent — CLI `plugins remove`). On mismatch the plugin
// runs as community, the blocklist doesn't let it through, log plugin-own-unexpected, event plugins.own-unexpected
// (push service — security exception notification) and a request for re-approval in the app. The limit is the
// same as for app pinning (app-pin.mjs): forging both files while the daemon is down can't be detected.
//
// Network: on explicit command (POST /registry/fetch, install) and by the background update check (lib/registry/updates.mjs:
// ~1 min after start and every 6 h, same fetchCatalog and same signature check; disabled by
// services.plugins.checkUpdates = false or the "Check for plugin updates" setting), https:// only; a file
// path or file:// — for tests and a local mirror. The background check installs nothing: only the catalog and the update list.

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { currentLang, pickLang } from "./i18n.mjs";
import { fileSig, readJsonFile } from "./config.mjs";
import { myUid } from "./platform.mjs";
import { refreshLocalWritePlaces } from "./registry/local-places.mjs";

// The parts of PluginManager (see the header).
import { installParts } from "./parts.mjs";
import { atomicWrite, readJsonOr } from "./plugins/common.mjs";
import { ManagerSources, registrySources, withDefaultRegistry } from "./plugins/sources.mjs";
import { ManagerKeys } from "./plugins/keys.mjs";
import { ManagerCatalog } from "./plugins/catalog.mjs";
import { ManagerBlocklist } from "./plugins/blocklist.mjs";
import { ManagerTrust } from "./plugins/trust.mjs";
import { ManagerConsent } from "./plugins/consent.mjs";
import { ManagerInstall } from "./plugins/install.mjs";
import { ManagerOwn } from "./plugins/own.mjs";
import { ManagerOwnWatch, OWN_DEFAULTS } from "./plugins/own-watch.mjs";
import { ManagerViews } from "./plugins/views.mjs";

// Names other modules and tests take from here; they live in the parts (lib/plugins/).
export { RegistryError, atomicWrite, hashTree } from "./plugins/common.mjs";
export { INDEX_VERSION, compareVersions, contractTooNew, entryContractTooNew, parseIndex, INDEX_TIERS, entryTier } from "./plugins/index-format.mjs";
export { localizePerms } from "./plugins/perm-i18n.mjs";
export { REGISTRY_NAME_RE, REGISTRY_TRUST, MAX_REGISTRIES, registrySources, registryLabel, tierLabel, withDefaultRegistry } from "./plugins/sources.mjs";
export { acceptedRegistryKey, registryKeyIdentity } from "./plugins/keys.mjs";
export { ownRisk } from "./plugins/own.mjs";
export { OWN_DEFAULTS } from "./plugins/own-watch.mjs";
export { unverifiedLabel } from "./plugins/views.mjs";

export const LOCK_VERSION = 1;

export class PluginManager {
  // fetcher(url, maxBytes) → Promise<Buffer> — network stub for tests.
  // onChange() — after the manager changed Plugins/ (install, removal, blocklist, quarantine): the service
  // asks the core to rescan plugins without waiting for fs.watch (FSEvents events can be lost).
  // onUpdates(items) — the list of available updates (pluginUpdates) changed: the service sends an event and a notification.
  // pinned() — whether the app build is pinned (requirements.app): without it nobody can approve an own plugin request.
  constructor({ config, journal = null, emit = null, estop = () => false, fetcher = null, onChange = null, onUpdates = null, lang = currentLang, pinned = () => true } = {}) {
    this.config = config;
    this.pinned = pinned;
    this.lang = lang;
    this.paths = config.paths;
    // services.plugins is re-read from config.json when it changes (getter opts): the registry can be connected
    // without restarting the daemon, and a key removed from the file really disappears (a file that names no registry at all
    // gets the built-in one: withDefaultRegistry). baseOpts — what didn't come from
    // the file (test overrides; services.plugins has no defaults): it overrides the file, as in loadConfig.
    const startFile = readPluginOpts(config.paths.config) || {};
    const startOpts = config.services?.plugins || {};
    this.baseOpts = Object.fromEntries(Object.entries(startOpts).filter(([k, v]) => !(k in startFile) || JSON.stringify(startFile[k]) !== JSON.stringify(v)));
    this.optsNow = withDefaultRegistry(startOpts, { testMode: Boolean(config.testMode) });
    this.optsSig = config.configLoadedSig ?? null;
    this.journal = journal;
    this.emitFn = emit;
    this.estop = estop;
    this.fetcher = fetcher;
    this.onChange = onChange;
    this.onUpdates = onUpdates;
    this.updatesFp = null; // fingerprint of the last update list (noteUpdates)
    this.dirs = {
      registry: join(this.paths.home, "Registry"),
      staging: join(this.paths.home, "Registry", "staging"),
      trash: join(this.paths.home, "Registry", "trash"),
      disabled: join(this.paths.home, "Registry", "disabled"),
      quarantine: join(this.paths.home, "Registry", "quarantine"),
      archives: join(this.paths.home, "Registry", "archives"),
      attest: join(this.paths.home, "Registry", "attest"),
    };
    this.files = {
      index: join(this.dirs.registry, "index.json"),
      sig: join(this.dirs.registry, "index.json.minisig"),
      state: join(this.dirs.registry, "state.json"),
      tiers: join(this.dirs.registry, "tiers.json"),
    };
    this.lowered = null; // id → {version, sha256, reason, at}: installed as official, the catalog no longer says so (tiers.json)
    // Registry sources (G19, registrySources): name → { catalog: { generatedAt, plugins: Map, blocklist, fetchedAt } | null,
    // error, stamp (size and mtime of its index.json/.minisig on disk the catalog was loaded from), key (the public key it was
    // verified with) }. this.catalog — the merged view (catalogView).
    this.cats = new Map();
    this.catsVer = 0;
    this.merged = null;
    this.sourcesMemo = null;
    this.shadowNoted = new Set();
    this.archiveCache = new Map(); // `${id}|${sha256}|${stat}` → { rel: sha256 } | null
    this.attestCache = new Map(); // `${registry}|${id}` → { key: `${stat}|${publicKey}`, entry: index entry | null }
    this.pending = new Map(); // consent token → { id, pid, expires, prep }
    // Accepted registry keys (Registry/registry-keys.json, withKeyPins): the file cached by its signature, the tokens of the
    // "accept the new key" window (token → { registry, fingerprint, pid, expires }) and what was last announced to the shell.
    this.keyPinsDisk = null;
    this.keyPending = new Map();
    this.keyAlertSig = "";
    this.freshNoted = new Map(); // registry → what noteFreshness last journaled about its catalog
    this.lockCache = null;
    // Installs and updates in progress (id → {id, op, title, version, since}): downloading and verifying
    // the archive, writing files. The "safe to shut down" verdict (idle service) — fact plugins.busy, event plugins.busy.
    // Reference-counted (busyRefs): two concurrent installs of the same id (two windows, a repeated click) — the mark
    // is cleared only when the last one finishes.
    this.busyOps = new Map();
    this.busyRefs = new Map();
    // Own sources: install requests (requestId → request), folder state of installed own plugins
    // (id → {status, …}), folder watchers and timers (startOwn/stopOwn — the plugins service).
    this.ownRequests = new Map();
    this.ownState = new Map();
    this.ownWatchers = new Map(); // id → { path, watcher }
    this.ownDebounce = new Map(); // id → timeout
    this.ownTimer = null;
    this.ownOpts = { ...OWN_DEFAULTS };
    this.ownStarted = false;
    this.uid = myUid() ?? -1;
    // Consents for own plugins: id → fingerprint of the lock entry the manager itself made (approvalDigest). Memory
    // is filled at startup from Registry/own-approvals.json and afterwards only by the manager; approvalsDisk — cache
    // of the file by signature (ino, size, mtime): only revocation is taken from the file.
    this.ownApproved = new Map();
    this.approvalsDisk = null;
    this.ownUnexpected = new Map(); // id → fingerprint of an entry already reported (log, push, request)
  }

  // Plugins' HOME (synthetic on the test bench — AGENTHUB_PLUGIN_HOME): used to expand "~" in dependency
  // checks and to shorten the own folder path for display.
  homeDir() {
    return this.config.pluginHome || homedir();
  }

  busyList() {
    return [...this.busyOps.values()].map((b) => ({ ...b }));
  }
  // info — start (one more reference), null — finish one.
  setBusy(id, info) {
    const n = this.busyRefs.get(id) || 0;
    if (info) {
      this.busyRefs.set(id, n + 1);
      this.busyOps.set(id, { id, since: this.busyOps.get(id)?.since || new Date().toISOString(), ...info });
    } else {
      if (n <= 0) return;
      if (n > 1) return void this.busyRefs.set(id, n - 1);
      this.busyRefs.delete(id);
      this.busyOps.delete(id);
    }
    this.emit({ type: "plugins.busy", busy: this.busyList() });
  }
  // Title and version for the "Installing plugin: …" line — from the verified catalog in the hub language.
  busyInfo(id, entry = null) {
    const installed = this.lock().plugins[id] || null;
    const e = entry || (installed?.tier === "own" ? installed : null) || this.catalogEntry(id, installed) || null;
    return { op: installed ? "update" : "install", title: (e && pickLang(e.title, e.i18n, "title", this.langNow())) || id, version: e?.version || null };
  }

  log(entry) {
    try {
      this.journal?.write(entry);
    } catch {}
  }
  emit(ev) {
    try {
      this.emitFn?.(ev);
    } catch {}
  }
  changed() {
    try {
      this.onChange?.();
    } catch {}
  }
  // The update list may have changed (new catalog, install, removal, blocklist): report if it changed.
  noteUpdates() {
    let items;
    try {
      items = this.pluginUpdates();
    } catch {
      return;
    }
    const fp = JSON.stringify(items.map((u) => [u.id, u.installed, u.version, u.sha256, u.permissionsGrow]));
    if (fp === this.updatesFp) return;
    this.updatesFp = fp;
    try {
      this.onUpdates?.(items);
    } catch {}
  }

  // cleanTemp: "all" — at startup the daemon clears everything from Registry/staging and trash (leftovers of interrupted installs);
  // "stale" — the CLI (agenthub plugins install/remove) clears only what's older than 10 min: something fresh may be
  // an install the daemon is running right now.
  async init({ cleanTemp = "all" } = {}) {
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const d of [this.dirs.staging, this.dirs.trash]) {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (cleanTemp !== "all") {
          try {
            if (Date.now() - lstatSync(p).mtimeMs < 10 * 60_000) continue;
          } catch {
            continue;
          }
        }
        rmSync(p, { recursive: true, force: true });
      }
    }
    // interception points by the real paths on this machine (symlinks in dotfiles) — for the loud line in the consent window
    refreshLocalWritePlaces();
    this.ownApproved = new Map(this.readApprovalsDisk());
    this.loadRequests();
    this.loadCached();
    this.applyBlocklist();
    this.noteUpdates();
  }

  // ---------- plugins.lock ----------
  lock() {
    const path = this.paths.pluginsLock;
    let mtime = null;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {}
    if (this.lockCache && this.lockCache.mtime === mtime) return this.lockCache.data;
    const data = readJsonOr(path, null);
    const lock = data && data.version === LOCK_VERSION && data.plugins && typeof data.plugins === "object" ? data : { version: LOCK_VERSION, plugins: {} };
    this.lockCache = { mtime, data: lock };
    return lock;
  }
  saveLock(lock) {
    atomicWrite(this.paths.pluginsLock, JSON.stringify(lock, null, 2) + "\n");
    this.lockCache = null;
  }
  lockEntry(id) {
    return this.lock().plugins[id] || null;
  }

  get opts() {
    const sig = fileSig(this.paths.config);
    if (sig === this.optsSig) return this.optsNow;
    const file = sig === "absent" ? {} : readPluginOpts(this.paths.config);
    if (!file) return this.optsNow; // the file is being written right now — read it next time
    this.optsSig = sig;
    const prev = this.optsNow;
    this.optsNow = withDefaultRegistry({ ...file, ...this.baseOpts }, { testMode: Boolean(this.config.testMode) });
    const regSig = (o) => JSON.stringify(registrySources(o).list);
    if (regSig(prev) !== regSig(this.optsNow)) {
      const now = registrySources(this.optsNow);
      this.log({ type: "registry-config-changed", indexUrl: Boolean(this.indexUrl()), publicKey: Boolean(this.publicKey()), registries: now.list.map((r) => r.name), ...(now.errors.length ? { invalid: now.errors } : {}) });
      // a catalog on disk was verified with the previous key — re-verify with the new one (or reset); a removed registry's
      // catalog is dropped (its installed plugins become community until it is back)
      this.loadCached();
      this.noteUpdates();
    }
    return this.optsNow;
  }

  langNow() {
    try {
      return this.lang() || currentLang();
    } catch {
      return currentLang();
    }
  }
}

// The rest of PluginManager's methods: lib/plugins/*.mjs, one file per area (see the header).
installParts(PluginManager, [ManagerSources, ManagerKeys, ManagerCatalog, ManagerBlocklist, ManagerTrust, ManagerConsent, ManagerInstall, ManagerOwn, ManagerOwnWatch, ManagerViews]);

// services.plugins from config.json: {} — no file or section, null — the file couldn't be parsed.
function readPluginOpts(path) {
  try {
    if (!existsSync(path)) return {};
    const cfg = readJsonFile(path);
    const o = cfg?.services?.plugins;
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return null;
  }
}

// Manager per state directory: the core loads the service and routes separately.
const managers = new Map();
export function registerManager(home, mgr) {
  managers.set(resolve(home), mgr);
}
export function unregisterManager(home, mgr) {
  if (managers.get(resolve(home)) === mgr) managers.delete(resolve(home));
}
export function managerFor(home) {
  return managers.get(resolve(home)) || null;
}
