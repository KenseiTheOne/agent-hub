// The plugin manager service (stage 8): registry catalog, plugins.lock, the core plugin policy.
//
// At startup: verifies the saved catalog with the public key from the config (services.plugins.publicKey),
// applies the blocklist, sets the policy (ctx.setPluginPolicy) and quarantines whatever is in
// Plugins/ bypassing the manager. The catalog comes via POST /registry/fetch from the app and the background update check
// (lib/registry/updates.mjs: ~1 min after start, then every 6 h; installs nothing). The update list is in
// /state.pluginUpdates (fact plugins.updates) and the plugins.updates event; a new version is announced once
// with the plugins.update-available event (push service → "Update available: <title> <version>").
// A new version in the catalog doesn't change the tier of the installed one (Registry/attest attestation, see plugins.mjs).
//
// Config (config.json → services.plugins):
//   indexUrl       — https://…/index.json (or a path / file:// for a mirror); null — the catalog isn't configured
//   publicKey      — the registry's minisign public key (contents of the .pub file or a base64 string)
//   registries     — more registries (G19): [{ name, indexUrl, publicKey, trust: "official" | "community" }] after the scalar pair
//                    (= the registry "default", trust official); lib/plugins.mjs registrySources
//   allowNetwork   — false forbids https:// entirely
//   maxArchiveBytes — plugin archive size limit (5 MB by default)
//   checkUpdates   — false disables the background update check (on by default; there's also the shell
//                    setting "Check for plugin updates" — settings.json → checkPluginUpdates)
//   updateCheck    — { firstDelayMs, intervalMs, jitterMs, backoffMs } (lib/registry/updates.mjs)
//   ownCheck       — { checkMs (60000), debounceMs (1500) }: own sources — folder reconciliation and watcher debounce
//
// Own sources (decision 2026-11-09): POST /registry/own/request requests, install from the app, watching the folders
// of installed own plugins (PluginManager.startOwn). /state.ownPlugins — requests and folders with a problem.

import { PluginManager, registerManager, unregisterManager } from "../plugins.mjs";
import { UpdateChecker } from "../registry/updates.mjs";

export const name = "plugins";
let mgr = null;
let home = null;
let checker = null;
let unsubscribe = null;

export async function start(ctx) {
  mgr = new PluginManager({
    config: ctx.config,
    journal: ctx.journal,
    emit: (ev) => ctx.emit(ev),
    estop: () => ctx.estop(),
    lang: () => ctx.lang(),
    // Rescan right away (fs.watch loses events) and re-evaluate the policy of already running plugins.
    onChange: () => ctx.rescanPlugins?.(),
    // nobody can approve an own plugin request until the app build is pinned (requirements.app)
    pinned: () => {
      const r = ctx.config.requirements?.app;
      return typeof r === "string" && r.trim().length > 0;
    },
  });
  await mgr.init();
  ctx.setPluginPolicy((pl, defaults) => mgr.policy(pl, defaults));
  home = ctx.paths.home;
  registerManager(home, mgr);
  // Services start before plugins, but whatever is in Plugins/ bypassing the manager is still moved to quarantine:
  // this way no unaccounted code stays on disk.
  mgr.reconcile();

  const c = new UpdateChecker({
    mgr,
    home,
    journal: ctx.journal,
    emit: (ev) => ctx.emit(ev),
    setting: () => ctx.settings.get("checkPluginUpdates"),
    testMode: Boolean(ctx.config.testMode),
  });
  checker = c;
  mgr.onUpdates = () => c.changed();
  try {
    ctx.facts.provide("plugins.updates", () => (checker === c ? c.info() : null));
  } catch {}
  // Plugin installs and updates in progress right now (the "safe to shut down" verdict, idle service).
  try {
    ctx.facts.provide("plugins.busy", () => (mgr ? mgr.busyList() : []));
  } catch {}
  // Own sources: requests awaiting approval in the app, and own plugin folders with a problem (/state.ownPlugins).
  const m = mgr;
  try {
    ctx.facts.provide("plugins.own", () => (mgr === m ? m.ownInfo() : null));
  } catch {}
  const oc = ctx.config.services?.plugins?.ownCheck || {};
  const num = (v, d, min) => (Number.isFinite(v) && v >= 0 ? Math.max(ctx.config.testMode ? 0 : min, v) : d);
  m.startOwn({ checkMs: num(oc.checkMs, 60_000, 10_000), debounceMs: num(oc.debounceMs, 1500, 200) });
  const onSettings = (ev) => {
    if (ev && "checkPluginUpdates" in ev) c.settingChanged();
    // the hub language changed: titles and permissions in the update list are in it (an event if the list changed)
    else if (ev && "lang" in ev) c.changed();
  };
  ctx.on("settings.changed", onSettings);
  unsubscribe = () => ctx.off("settings.changed", onSettings);
  c.start();
}

export async function stop() {
  unsubscribe?.();
  unsubscribe = null;
  checker?.stop();
  checker = null;
  mgr?.stopOwn();
  if (mgr) mgr.onUpdates = null;
  if (mgr && home) unregisterManager(home, mgr);
  mgr = null;
}

// For tests: this service's update check.
export function _checker() {
  return checker;
}
