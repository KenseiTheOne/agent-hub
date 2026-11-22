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
// A plugin without a translation is shown as is. The hub UI has two languages only; plugin content may be in any language:
// the system preferred languages (systemLocales) go to plugins in AGENTHUB_LOCALE and pick plugin metadata translations
// (lib/i18n.mjs contentLang). A non-Russian system gets the en UI (product decision, detectSystemLang).

import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { systemLangOverride } from "./config.mjs";
import { loadStateJson, writeJsonAtomic } from "./statefile.mjs";
import { systemLanguagesCommand } from "./platform.mjs";
import { normLang, normLocales } from "./i18n.mjs";
import { normPrefs, prefsFromFile, prefsToFile } from "./push/prefs.mjs";

export const LANG_SETTINGS = ["system", "ru", "en"];
// A plugin id as the scanner accepts it (lib/host.mjs PLUGIN_ID_RE); builtinOff keeps only such strings, at most MAX_OFF of them.
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_OFF = 64;
const normIds = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && PLUGIN_ID_RE.test(x)))].sort().slice(0, MAX_OFF) : []);
const SYSTEM_TTL_MS = 60_000;
const SYSTEM_STALE_MS = 5 * SYSTEM_TTL_MS;

// The raw OS language list (macOS: `defaults read -g AppleLanguages`, a synchronous call ≤ 2 s). → text | "" (none, failed)
// Synchronous: the very first read of a daemon (its messages need a language at once) and the CLI. A running daemon re-reads
// with readSystemLanguagesAsync (Settings.refreshSystem), off the event loop.
export function readSystemLanguages({ platform = process.platform } = {}) {
  const cmd = systemLanguagesCommand({ platform });
  if (!cmd) return "";
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

// The same read without blocking the event loop. → Promise<text | ""> (never rejects)
export function readSystemLanguagesAsync({ platform = process.platform } = {}) {
  const cmd = systemLanguagesCommand({ platform });
  if (!cmd) return Promise.resolve("");
  return new Promise((resolve) => {
    try {
      execFile(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 2000 }, (e, out) => resolve(e ? "" : String(out || "")));
    } catch {
      resolve("");
    }
  });
}

const intlLocale = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "";
  } catch {
    return "";
  }
};

// Both answers from one OS read (review 2026-11-12: the daemon used to run the command twice a minute). text — the output of
// readSystemLanguages; env — AGENTHUB_SYSTEM_LOCALES overrides the list. → { lang: "ru" | "en", locales: [...] }
export function systemLanguagesFrom(text, { env = process.env } = {}) {
  const first = (/([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]+)*/.exec(text || "") || [])[1] || intlLocale();
  let locales = env.AGENTHUB_SYSTEM_LOCALES ? normLocales(env.AGENTHUB_SYSTEM_LOCALES) : normLocales(String(text || "").split(/[\s(),"]+/).filter(Boolean));
  if (!locales.length && !env.AGENTHUB_SYSTEM_LOCALES) locales = normLocales([intlLocale()]);
  return { lang: /^ru(?:$|[-_])/i.test(first) ? "ru" : "en", locales };
}

// OS language → ru | en (override for checks — config.systemLang from AGENTHUB_SYSTEM_LANG, lib/config.mjs).
export function detectSystemLang({ platform = process.platform } = {}) {
  return systemLanguagesFrom(readSystemLanguages({ platform }), { env: {} }).lang;
}

// The OS preferred languages, in order, as canonical BCP-47 tags (plugin content, lib/i18n.mjs contentLang; AGENTHUB_LOCALE
// for plugins). AGENTHUB_SYSTEM_LOCALES="de-DE,en-US" overrides it (checks and test hubs); macOS — AppleLanguages; elsewhere —
// the Intl locale. → ["de-DE", "en-US", …] (at most 8; may be empty)
export function detectSystemLocales({ platform = process.platform, env = process.env } = {}) {
  if (env.AGENTHUB_SYSTEM_LOCALES) return normLocales(env.AGENTHUB_SYSTEM_LOCALES);
  return systemLanguagesFrom(readSystemLanguages({ platform }), { env }).locales;
}

export class Settings {
  // detectLocales — the system language list (detectSystemLocales). With only detect overridden (a test hub's fixed
  // language), the list is that one language — unless AGENTHUB_SYSTEM_LOCALES sets it explicitly.
  // Neither overridden (the live daemon): both come from ONE OS read per SYSTEM_TTL_MS (readLanguages — readSystemLanguages;
  // a check may pass its own, with env for AGENTHUB_SYSTEM_LOCALES). The first read is synchronous; once refreshSystem()
  // has run (the daemon calls it every minute — readLanguagesAsync, readSystemLanguagesAsync), the getters stop reading the
  // OS themselves and serve what the last refresh brought.
  // keepBad (the daemon only): a file that cannot be parsed is copied to <path>.bad before anything overwrites it; either
  // way this.damaged says so ({file, backup, detail, at} | null) and the defaults apply.
  constructor(path, { detect = null, detectLocales = null, readLanguages = null, readLanguagesAsync = null, env = process.env, now = () => Date.now(), keepBad = false } = {}) {
    this.path = path;
    this.keepBad = keepBad;
    this.damaged = null;
    // readAsync: a check that passes only the synchronous reader is refreshed through it
    const readAsync = readLanguagesAsync || (readLanguages ? async () => readLanguages() : () => readSystemLanguagesAsync());
    this.shared = !detect && !detectLocales ? { read: readLanguages || (() => readSystemLanguages()), readAsync, env, at: 0, value: null, background: false, pending: null } : null;
    this.detect = detect || (() => this.sharedLanguages().lang);
    this.detectLocales = detectLocales || (this.shared ? () => this.sharedLanguages().locales : () => (process.env.AGENTHUB_SYSTEM_LOCALES ? detectSystemLocales() : [this.detect()]));
    this.locs = null;
    this.locsAt = 0;
    this.now = now;
    // launchAtLogin — "Launch at login" (decision 2026-11-07): the daemon + app pair. Off — a daemon started
    // at login (launchd RunAtLoad) waits for the app and exits normally (the app service, lib/app-supervisor.mjs).
    // notifications — "Settings → Notifications" (lib/push/prefs.mjs): the master switch, kinds, quiet hours.
    // builtinOff — ids of built-in plugins the person turned off (PUT /settings/builtin-plugins): the host does not start them.
    // Kept here rather than next to the plugins: a hub update and `agenthub builtin update` re-copy <home>/Builtin, not this file.
    this.data = { lang: "system", checkPluginUpdates: true, checkHubUpdates: true, launchAtLogin: true, notifications: normPrefs(null), builtinOff: [] };
    this.sys = null;
    this.sysAt = 0;
    this.load();
  }
  load() {
    const r = loadStateJson(this.path, { keepBad: this.keepBad });
    this.damaged = r.damaged;
    try {
      const d = r.value;
      if (d) this.data = { ...this.data, ...d, notifications: prefsFromFile(d) };
    } catch {}
    if (!LANG_SETTINGS.includes(this.data.lang)) this.data.lang = "system";
    if (typeof this.data.checkPluginUpdates !== "boolean") this.data.checkPluginUpdates = true;
    if (typeof this.data.checkHubUpdates !== "boolean") this.data.checkHubUpdates = true;
    if (typeof this.data.launchAtLogin !== "boolean") this.data.launchAtLogin = true;
    this.data.notifications = normPrefs(this.data.notifications);
    this.data.builtinOff = normIds(this.data.builtinOff);
  }
  // Known keys only (ctx.settings.get).
  get(key) {
    if (key === "lang") return this.data.lang;
    if (key === "checkPluginUpdates") return this.data.checkPluginUpdates;
    if (key === "checkHubUpdates") return this.data.checkHubUpdates;
    if (key === "launchAtLogin") return this.data.launchAtLogin;
    if (key === "notifications") return structuredClone(this.data.notifications);
    if (key === "builtinOff") return [...this.data.builtinOff];
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
  // Whether a built-in plugin is on (not in builtinOff).
  builtinEnabled(id) {
    return !this.data.builtinOff.includes(id);
  }
  setBuiltinEnabled(id, enabled) {
    if (typeof id !== "string" || !PLUGIN_ID_RE.test(id)) throw Object.assign(new Error("id"), { code: "args:id:type" });
    if (typeof enabled !== "boolean") throw Object.assign(new Error("enabled"), { code: "args:enabled:type" });
    const rest = this.data.builtinOff.filter((x) => x !== id);
    this.data = { ...this.data, builtinOff: enabled ? rest : [...rest, id].sort() };
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
    // notifications — in a form that a contract 1 core will also understand after a rollback (lib/push/prefs.mjs prefsToFile)
    const out = { ...this.data, ...prefsToFile(this.data.notifications) };
    writeJsonAtomic(this.path, out, { mode: 0o600, space: 2 });
  }
  get langSetting() {
    return this.data.lang;
  }
  // One OS read for systemLang and systemLocales (their own caches expire together, so a minute costs one read).
  // With a background refresh running (refreshSystem) the value is only served: a synchronous read happens for the first
  // value, for an explicit { fresh: true }, and when no refresh has landed for SYSTEM_STALE_MS (the refresher is gone).
  sharedLanguages() {
    const sh = this.shared;
    const age = this.now() - sh.at;
    if (!sh.value || age > (sh.background ? SYSTEM_STALE_MS : SYSTEM_TTL_MS)) {
      try {
        sh.value = systemLanguagesFrom(sh.read(), { env: sh.env });
      } catch {
        sh.value = sh.value || { lang: "en", locales: [] };
      }
      sh.at = this.now();
    }
    return sh.value;
  }
  // Re-read the system languages without blocking the event loop (the daemon's minute poll, core.watchLang). A fixed
  // language (detect / detectLocales given: test hubs, AGENTHUB_SYSTEM_LANG) has nothing to read. A failed read keeps the
  // previous value. → Promise<boolean> (a value was read); never rejects.
  refreshSystem() {
    const sh = this.shared;
    if (!sh) return Promise.resolve(false);
    if (sh.pending) return sh.pending;
    sh.pending = (async () => {
      try {
        const text = await sh.readAsync();
        sh.value = systemLanguagesFrom(text, { env: sh.env });
        sh.at = this.now();
        sh.background = true;
        // the getters' own caches: recomputed from the new value at the next call
        this.sysAt = -Infinity;
        this.locsAt = -Infinity;
        return true;
      } catch {
        return false;
      } finally {
        sh.pending = null;
      }
    })();
    return sh.pending;
  }
  systemLang({ fresh = false } = {}) {
    if (fresh || !this.sys || this.now() - this.sysAt > SYSTEM_TTL_MS) {
      if (fresh && this.shared) this.shared.at = -Infinity;
      try {
        this.sys = normLang(this.detect());
      } catch {
        this.sys = this.sys || "ru";
      }
      this.sysAt = this.now();
    }
    return this.sys;
  }
  // The system preferred languages (detectSystemLocales), cached like the system language.
  systemLocales({ fresh = false } = {}) {
    if (fresh || !this.locs || this.now() - this.locsAt > SYSTEM_TTL_MS) {
      if (fresh && this.shared) this.shared.at = -Infinity;
      try {
        this.locs = normLocales(this.detectLocales());
      } catch {
        this.locs = this.locs || [];
      }
      this.locsAt = this.now();
    }
    return [...this.locs];
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
    // locales — the system preferred languages (plugin content and AGENTHUB_LOCALE; the hub UI itself is ru | en)
    return { setting: this.data.lang, effective: this.effectiveLang(), system: this.systemLang(), locales: this.systemLocales() };
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
