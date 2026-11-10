// Hub settings (<home>/settings.json): the language setting and the "system" language (the message table — lib/i18n.mjs).
// Also the "Check for plugin updates" switch (checkPluginUpdates, true by default; PUT
// /settings/plugin-updates, app only): the background check of the registry index (lib/registry/updates.mjs).
//
// Setting — "system" | "ru" | "en". Effective language — ru | en: "system" means ru if the first macOS language
// (defaults read -g AppleLanguages) is Russian, otherwise en; on Windows/Linux — Intl.DateTimeFormat().resolvedOptions().locale.
// Only the app class writes the setting (PUT /settings/lang); cli reads it in /state.
// A separate file rather than config.json: AppPinWatcher watches config.json (build pin changes), and writing
// the language there would look like an edit of the app requirement.
//
// Plugins get the effective language in AGENTHUB_LANG=ru|en (lib/runner.mjs buildEnv) and are restarted when it changes.
// A plugin without a translation is shown as is.

import { execFileSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, systemLangOverride } from "./config.mjs";
import { systemLanguagesCommand } from "./platform.mjs";
import { normLang } from "./i18n.mjs";
import { normPrefs, prefsFromFile, prefsToFile } from "./push/prefs.mjs";

export const LANG_SETTINGS = ["system", "ru", "en"];
const SYSTEM_TTL_MS = 60_000;

// OS language → ru | en (override for checks — config.systemLang from AGENTHUB_SYSTEM_LANG, lib/config.mjs).
export function detectSystemLang({ platform = process.platform } = {}) {
  let first = "";
  const cmd = systemLanguagesCommand({ platform });
  if (cmd) {
    try {
      const out = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      first = (/([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]+)*/.exec(out) || [])[1] || "";
    } catch {}
  }
  if (!first) {
    try {
      first = Intl.DateTimeFormat().resolvedOptions().locale || "";
    } catch {}
  }
  return /^ru(?:$|[-_])/i.test(first) ? "ru" : "en";
}

export class Settings {
  constructor(path, { detect = detectSystemLang, now = () => Date.now() } = {}) {
    this.path = path;
    this.detect = detect;
    this.now = now;
    // launchAtLogin — "Launch at login" (decision 2026-11-07): the daemon + app pair. Off — a daemon started
    // at login (launchd RunAtLoad) waits for the app and exits normally (the app service, lib/app-supervisor.mjs).
    // notifications — "Settings → Notifications" (lib/push/prefs.mjs): the master switch, kinds, quiet hours.
    this.data = { lang: "system", checkPluginUpdates: true, checkHubUpdates: true, launchAtLogin: true, notifications: normPrefs(null) };
    this.sys = null;
    this.sysAt = 0;
    this.load();
  }
  load() {
    try {
      if (existsSync(this.path)) {
        const d = readJsonFile(this.path);
        if (d && typeof d === "object") this.data = { ...this.data, ...d, notifications: prefsFromFile(d) };
      }
    } catch {}
    if (!LANG_SETTINGS.includes(this.data.lang)) this.data.lang = "system";
    if (typeof this.data.checkPluginUpdates !== "boolean") this.data.checkPluginUpdates = true;
    if (typeof this.data.checkHubUpdates !== "boolean") this.data.checkHubUpdates = true;
    if (typeof this.data.launchAtLogin !== "boolean") this.data.launchAtLogin = true;
    this.data.notifications = normPrefs(this.data.notifications);
  }
  // Known keys only (ctx.settings.get).
  get(key) {
    if (key === "lang") return this.data.lang;
    if (key === "checkPluginUpdates") return this.data.checkPluginUpdates;
    if (key === "checkHubUpdates") return this.data.checkHubUpdates;
    if (key === "launchAtLogin") return this.data.launchAtLogin;
    if (key === "notifications") return structuredClone(this.data.notifications);
    return undefined;
  }
  get notifications() {
    return structuredClone(this.data.notifications);
  }
  // Already validated settings (lib/push/prefs.mjs applyPatch).
  setNotifications(v) {
    this.data = { ...this.data, notifications: normPrefs(v) };
    this.save();
  }
  get launchAtLogin() {
    return this.data.launchAtLogin;
  }
  setLaunchAtLogin(v) {
    if (typeof v !== "boolean") throw Object.assign(new Error("enabled"), { code: "args:enabled:type" });
    this.data = { ...this.data, launchAtLogin: v };
    this.save();
  }
  get checkHubUpdates() {
    return this.data.checkHubUpdates;
  }
  setCheckHubUpdates(v) {
    if (typeof v !== "boolean") throw Object.assign(new Error("enabled"), { code: "args:enabled:type" });
    this.data = { ...this.data, checkHubUpdates: v };
    this.save();
  }
  get checkPluginUpdates() {
    return this.data.checkPluginUpdates;
  }
  setCheckPluginUpdates(v) {
    if (typeof v !== "boolean") throw Object.assign(new Error("enabled"), { code: "args:enabled:type" });
    this.data = { ...this.data, checkPluginUpdates: v };
    this.save();
  }
  save() {
    const tmp = `${this.path}.tmp-${process.pid}`;
    // notifications — in a form that a contract 1 core will also understand after a rollback (lib/push/prefs.mjs prefsToFile)
    const out = { ...this.data, ...prefsToFile(this.data.notifications) };
    writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  get langSetting() {
    return this.data.lang;
  }
  systemLang({ fresh = false } = {}) {
    if (fresh || !this.sys || this.now() - this.sysAt > SYSTEM_TTL_MS) {
      try {
        this.sys = normLang(this.detect());
      } catch {
        this.sys = this.sys || "ru";
      }
      this.sysAt = this.now();
    }
    return this.sys;
  }
  effectiveLang() {
    return this.data.lang === "system" ? this.systemLang() : this.data.lang;
  }
  setLang(v) {
    if (!LANG_SETTINGS.includes(v)) throw Object.assign(new Error("lang"), { code: "args:lang:enum" });
    this.data = { ...this.data, lang: v };
    this.save();
  }
  langInfo() {
    return { setting: this.data.lang, effective: this.effectiveLang(), system: this.systemLang() };
  }
}

// The effective hub language for a process outside the daemon (CLI, the hub-update builder and watchdog): the same
// settings.json and the same "system" rule as the daemon's core (AGENTHUB_SYSTEM_LANG, test mode — lib/config.mjs).
// Never throws: an unreadable settings file means the "system" setting.
export function langForHome(home, env = process.env) {
  try {
    const sys = systemLangOverride(env);
    return new Settings(join(home, "settings.json"), sys ? { detect: () => sys } : {}).effectiveLang();
  } catch {
    return "en";
  }
}
