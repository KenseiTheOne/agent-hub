// Core part: the hub language and the settings the app changes (settings.json through lib/settings.mjs) — language,
// update checks, notifications, launch at login — and the minute poll of the system language.
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { t } from "../i18n.mjs";
import { applyPatch, effectiveQuiet, legacyMuted, pluginToggle, PLUGIN_KIND } from "../push/prefs.mjs";
import { resolvePushConfig } from "../push/config.mjs";
import { DEFAULT_RULES, SECURITY } from "../push/rules.mjs";

export class CoreSettings {
  // ---------- language (lib/i18n.mjs, lib/settings.mjs) ----------
  lang() {
    return this.settings.effectiveLang();
  }
  langInfo() {
    return this.settings.langInfo();
  }
  // App only (checked by the route). → langInfo
  setLang(v, peerInfo) {
    this.settings.setLang(v);
    this.journal.write({ type: "settings-changed", key: "lang", value: v, peer: peerInfo?.class, pid: peerInfo?.pid });
    this.langChanged({ force: true });
    return this.langInfo();
  }
  // Effective language changed (setting or system language) → plugin labels, event, frame restarts. The system preferred
  // languages changed alone (they pick plugin metadata translations, G14) → plugin labels and the event only: running
  // plugins get the new AGENTHUB_LOCALE at their next start or run (no restart of every plugin for it).
  langChanged({ force = false } = {}) {
    const now = this.lang();
    const changed = now !== this.langNow;
    this.langNow = now;
    const locales = this.settings.systemLocales().join(",");
    const localesChanged = this.localesNow !== undefined && locales !== this.localesNow;
    this.localesNow = locales;
    if (!changed && !localesChanged && !force) return;
    for (const id of this.plugins.keys()) this.localizePlugin(id);
    this.emit({ type: "settings.changed", lang: this.langInfo() });
    if (changed) this.host.relang?.();
  }
  // "Check for plugin updates" (settings.json → checkPluginUpdates). App only (checked by the route).
  pluginUpdatesSetting() {
    return { setting: this.settings.checkPluginUpdates };
  }
  setCheckPluginUpdates(v, peerInfo) {
    this.settings.setCheckPluginUpdates(v);
    this.journal.write({ type: "settings-changed", key: "checkPluginUpdates", value: v, peer: peerInfo?.class, pid: peerInfo?.pid });
    this.emit({ type: "settings.changed", checkPluginUpdates: v });
    return this.pluginUpdatesSetting();
  }
  // "Check for hub updates" (settings.json → checkHubUpdates). App only (checked by the route).
  hubUpdatesSetting() {
    return { setting: this.settings.checkHubUpdates };
  }
  setCheckHubUpdates(v, peerInfo) {
    this.settings.setCheckHubUpdates(v);
    this.journal.write({ type: "settings-changed", key: "checkHubUpdates", value: v, peer: peerInfo?.class, pid: peerInfo?.pid });
    this.emit({ type: "settings.changed", checkHubUpdates: v });
    return this.hubUpdatesSetting();
  }
  // "Notifications" (settings.json → notifications, lib/push/prefs.mjs): master switch, kinds, quiet hours.
  // quiet.from — where quiet hours come from: settings | config (services.push.quietStart/quietEnd, as before 2026-11-09) | default.
  // security — security exceptions that cannot be turned off: core events and trusted plugins' rules with
  // kind="security" (metadata only: key, plugin, label in the hub language). service — the push service is running
  // (services.push.enabled = false in config.json — nothing goes out except journal entries). quiet.timezone — the zone in
  // which the engine computes quiet hours (services.push.timezone or the system one: the push service checks the system zone on
  // each tick); awayAfterMs — idle threshold after which the human counts as away from the Mac (idleThresholdMs).
  notificationsSetting() {
    const prefs = this.settings.notifications;
    const pushCfg = this.config.services?.push;
    const resolved = resolvePushConfig(pushCfg);
    const lang = this.lang();
    const security = DEFAULT_RULES.filter((r) => r.kind === SECURITY).map((r) => ({ key: r.name, plugin: "@hub", label: t(lang, `push.rule.${r.name}`) }));
    for (const st of this.plugins.values()) {
      if (st.trusted !== true || !Array.isArray(st.pushRules)) continue;
      for (const r of st.pushRules) {
        if (r.kind === SECURITY) security.push({ key: r.key, plugin: st.id, pluginTitle: st.title || st.id, label: r.label || r.key });
      }
    }
    // plugins' own switches (contract 2): trusted plugins with kind="plugin" rules — a row with the plugin
    // name in the hub language and the labels of its rules; no plugin — no row
    const plugins = [];
    for (const st of this.plugins.values()) {
      // community plugins (G3) have only kind="plugin" rules — they get their own switch too
      if ((st.trusted !== true && st.tier !== "community") || !Array.isArray(st.pushRules)) continue;
      const own = st.pushRules.filter((r) => r.kind === PLUGIN_KIND);
      if (!own.length) continue;
      const labels = [...new Set(own.map((r) => r.label || r.key).filter(Boolean))].slice(0, 8);
      // legacy — turned off by migrating an old setting, not by a human (a mark in "Settings" until it is touched)
      const legacy = (typeof prefs.plugins?.[st.id] !== "boolean" && legacyMuted(prefs, st.pushRules, st.id)) || Boolean(prefs.migrated?.[st.id]);
      plugins.push({ id: st.id, title: st.title || st.id, on: pluginToggle(prefs, st.id, st.pushRules), labels, ...(legacy ? { legacy: true } : {}) });
    }
    plugins.sort((a, b) => a.title.localeCompare(b.title, lang) || (a.id < b.id ? -1 : 1));
    return {
      enabled: prefs.enabled,
      kinds: prefs.kinds,
      plugins,
      quiet: { ...effectiveQuiet(prefs, pushCfg), timezone: resolved.timezone },
      awayAfterMs: resolved.idleThresholdMs,
      security,
      service: pushCfg?.enabled !== false,
      // delivery channels (re-review 70): mac plus services.push.channels and channels services registered — id, type, label,
      // security, events; never a URL or token. The service that delivers adds the list (ctx.provideState "notifications");
      // empty while it is off.
      channels: [],
      ...this.stateFields("notifications"),
    };
  }
  // Migrating contract 1 settings (lib/push/prefs.mjs): a plugin declared an old kind (LEGACY_KINDS) that a human
  // turned off, and it has no switch of its own yet — pin "off" explicitly. Later the plugin may change its kind to
  // kind="plugin" without was= — the human's choice is kept. An explicit choice is left alone.
  pinLegacyToggles(id) {
    const st = this.plugins.get(id);
    if (!st || st.trusted !== true || !Array.isArray(st.pushRules)) return;
    const prefs = this.settings.notifications;
    if (typeof prefs.plugins?.[id] === "boolean" || !legacyMuted(prefs, st.pushRules, id)) return;
    const kinds = [...new Set(st.pushRules.map((r) => r.legacyKind).filter((k) => k && prefs.legacy?.[k] === false))];
    try {
      this.settings.setNotifications({ ...prefs, plugins: { ...(prefs.plugins || {}), [id]: false }, migrated: { ...(prefs.migrated || {}), [id]: kinds } });
    } catch {
      return;
    }
    this.journal.write({ type: "settings-migrated", key: "notifications", plugin: id, from: kinds });
    this.emit({ type: "settings.changed", notifications: this.notificationsSetting() });
  }
  // The first full plugin scan has finished (host.start): migrating old kinds is one-off, from now on it applies
  // only to plugins installed now (legacyFor; a plugin installed later is not turned off by the old setting).
  pluginsScanned(ids = [...this.plugins.keys()]) {
    const prefs = this.settings.notifications;
    if (!Object.keys(prefs.legacy || {}).length || Array.isArray(prefs.legacyFor)) return;
    try {
      this.settings.setNotifications({ ...prefs, legacyFor: [...new Set(ids)].slice(0, 200) });
    } catch {
      return;
    }
    this.journal.write({ type: "settings-migrated", key: "notifications", legacyFor: ids.length });
    // the push service keeps its own copy of the settings — let it know whom the migration no longer applies to
    this.emit({ type: "settings.changed", notifications: this.notificationsSetting() });
  }
  // App only (checked by the route). patch — {enabled?, kinds?, plugins?, quiet?}. → {notifications} | {error}
  setNotifications(patch, peerInfo) {
    const r = applyPatch(this.settings.notifications, patch, this.config.services?.push);
    if (r.error) return { error: r.error };
    this.settings.setNotifications(r.prefs);
    // to the journal — what was changed (switches and times), no texts
    this.journal.write({ type: "settings-changed", key: "notifications", value: patch, peer: peerInfo?.class, pid: peerInfo?.pid });
    const info = this.notificationsSetting();
    this.emit({ type: "settings.changed", notifications: info });
    return { notifications: info };
  }
  // "Launch at login" (settings.json → launchAtLogin, decision 2026-11-07): the daemon + app pair. App only
  // (checked by the route). Takes effect on the next daemon start: when off, a daemon started at login
  // waits for the app and exits cleanly (app service).
  // launchAgent — KeepAlive of the daemon job, added by the service that watches it (ctx.provideState "launchAtLogin"):
  // "outdated" — a plist from before 2026-11-06 (KeepAlive true), the off setting does not work under it — the shell locks the
  // switch with a hint "agenthub install --apply". No key — not checked (no such service, test directory without
  // test.launchAgent).
  launchAtLoginSetting() {
    return { setting: this.settings.launchAtLogin, ...this.stateFields("launchAtLogin") };
  }
  setLaunchAtLogin(v, peerInfo) {
    this.settings.setLaunchAtLogin(v);
    this.journal.write({ type: "settings-changed", key: "launchAtLogin", value: v, peer: peerInfo?.class, pid: peerInfo?.pid });
    this.emit({ type: "settings.changed", launchAtLogin: v });
    return this.launchAtLoginSetting();
  }
  // One step of the minute poll. → Promise (never rejects)
  pollLang() {
    return this.settings.refreshSystem().then(() => {
      if (!this.stopping) this.langChanged();
    });
  }
  watchLang() {
    this.langNow = this.lang();
    this.localesNow = this.settings.systemLocales().join(",");
    // every minute: the system language (when the setting is "system") and the system preferred languages — one OS read
    // for both, off the event loop (lib/settings.mjs refreshSystem; a fixed test language has nothing to read)
    this.langPoll = setInterval(() => this.pollLang(), 60_000);
    this.langPoll.unref?.();
  }
}
