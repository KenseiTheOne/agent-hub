// Notification switches — "Settings → Notifications" (settings.json → notifications, written only by app via
// PUT /settings/notifications): master switch, switches per core kind, plugins' own switches and quiet hours.
//
// Contract 2 (2026-11-09): the core has only the generic kinds (KINDS) and "security". Everything a plugin declared with kind "plugin"
// (<agenthub.push kind="plugin">) is silenced by its own switch — plugins.<id> (in settings.json — pluginNotifications.plugins); the row in
// "Settings" is built by the hub from installed trusted plugins with such rules (no plugin — no row).
//
// Migrating contract 1 settings. The core no longer knows the old kinds "runs" and "night", but values the user turned off
// are not lost: normPrefs sees kinds.runs/kinds.night = false as legacy ({runs: false}). A plugin's switch
// without an explicit value is off if at least one of its rules declared a turned-off old kind (kind="runs"|
// "night" — a deprecated synonym of "plugin", or kind="plugin" was="…"). The core pins that conclusion with an explicit
// plugins.<id> = false as soon as it sees the plugin (core.pinLegacyToggles) — after that the plugin may change the deprecated
// kind to kind="plugin" without losing the choice. legacy does not touch a human's explicit choice.
//
// The migration is one-off: after the first full plugin scan (core.pluginsScanned) the core remembers which plugins
// it applies to (legacyFor — ids of the plugins installed then); a plugin installed later is not turned off by the old setting,
// even if it declared was=.
//
// Rolling the hub back to a contract 1 version (agenthub hub rollback) does not lose the choice (prefsToFile / prefsFromFile): in
// settings.json the turned-off runs/night stay in notifications.kinds — the old core reads them as before — while the plugins'
// own switches and migration marks live under a separate top-level key pluginNotifications, which
// the old core does not normalize and keeps as is when it writes. If a human turned an old kind back on in the old hub, after
// updating the migration clears the "off" values derived from it (migrated), an explicit choice stays.
//
// A turned-off kind is not shown in any way — neither as a shell banner, nor via the fallback osascript, nor in the morning
// digest; the event stays in the popover (plugin state) and in the journal (`push-muted`). Security exceptions
// (kind "security") arrive whatever the switches say. The module does not depend on i18n (lib/i18n.mjs imports it).

import { parseHM } from "./clock.mjs";

// Order — as in the settings.
export const KINDS = Object.freeze(["sessions", "updates", "problems", "other"]);
export const SECURITY = "security";
// The plugin rule kind "the plugin's own switch" (plugins.<id>, in settings.json — pluginNotifications.plugins).
export const PLUGIN_KIND = "plugin";
// Contract 1 kinds that are migrated into plugin switches (lib/meta.mjs LEGACY_PUSH_KINDS).
export const LEGACY_KINDS = Object.freeze(["runs", "night"]);
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PLUGIN_TOGGLES = 200;

export const QUIET_DEFAULT = Object.freeze({ start: "23:00", end: "08:00" });

export function defaultPrefs() {
  return { enabled: true, kinds: Object.fromEntries(KINDS.map((k) => [k, true])), plugins: {}, legacy: {}, migrated: {}, legacyFor: null, quiet: null };
}

// "8:00" → "08:00"; invalid — null.
export function normHM(v) {
  const m = parseHM(v);
  if (m == null) return null;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Raw value from settings.json → normalized form. quiet: null — not set in the settings (config.json or
// the default applies, see effectiveQuiet).
export function normPrefs(raw) {
  const d = defaultPrefs();
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = { enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled, kinds: { ...d.kinds }, plugins: {}, legacy: {}, migrated: {}, legacyFor: null, quiet: null };
  if (r.kinds && typeof r.kinds === "object") for (const k of KINDS) if (typeof r.kinds[k] === "boolean") out.kinds[k] = r.kinds[k];
  // turned-off contract 1 kinds: kinds.<kind> = false (that is how the old core writes them, and so does prefsToFile); legacy.<kind>
  // is the in-memory form (and in settings.json of pre-release builds), only if kinds.<kind> does not say otherwise
  for (const k of LEGACY_KINDS) {
    const v = r.kinds?.[k];
    if (v === false || (v === undefined && r.legacy?.[k] === false)) out.legacy[k] = false;
  }
  if (r.plugins && typeof r.plugins === "object" && !Array.isArray(r.plugins)) {
    for (const [id, v] of Object.entries(r.plugins).slice(0, MAX_PLUGIN_TOGGLES)) if (PLUGIN_ID_RE.test(id) && typeof v === "boolean") out.plugins[id] = v;
  }
  // switches turned off by migration (not by a human): { <id>: ["night"] } — until the human touches them
  if (r.migrated && typeof r.migrated === "object" && !Array.isArray(r.migrated)) {
    for (const [id, v] of Object.entries(r.migrated).slice(0, MAX_PLUGIN_TOGGLES)) {
      const kinds = Array.isArray(v) ? v.filter((k) => LEGACY_KINDS.includes(k)) : [];
      if (!PLUGIN_ID_RE.test(id) || !kinds.length || out.plugins[id] !== false) continue;
      // the old kind is on again (the human turned it on in the old hub after a rollback) — the migration result is cleared
      const still = kinds.filter((k) => out.legacy[k] === false);
      if (still.length) out.migrated[id] = still;
      else delete out.plugins[id];
    }
  }
  // which plugins the migration applies to (one-off, see above); all old kinds are on — no migration
  if (Object.keys(out.legacy).length && Array.isArray(r.legacyFor)) {
    out.legacyFor = [...new Set(r.legacyFor.filter((id) => typeof id === "string" && PLUGIN_ID_RE.test(id)))].slice(0, MAX_PLUGIN_TOGGLES);
  }
  const q = r.quiet;
  if (q && typeof q === "object") {
    const start = normHM(q.start);
    const end = normHM(q.end);
    if (start && end && typeof q.enabled === "boolean") out.quiet = { enabled: q.enabled, start, end };
  }
  return out;
}

// settings.json ↔ in-memory settings (compatible with a rollback to a contract 1 core, see above).
// File → raw value for normPrefs: notifications + pluginNotifications (own switches, migration).
export function prefsFromFile(data) {
  const n = data?.notifications && typeof data.notifications === "object" && !Array.isArray(data.notifications) ? data.notifications : {};
  const p = data?.pluginNotifications && typeof data.pluginNotifications === "object" && !Array.isArray(data.pluginNotifications) ? data.pluginNotifications : {};
  return { ...n, ...(p.plugins ? { plugins: p.plugins } : {}), ...(p.migrated ? { migrated: p.migrated } : {}), ...(p.legacyFor ? { legacyFor: p.legacyFor } : {}) };
}
// Settings → { notifications, pluginNotifications } for settings.json: turned-off old kinds go into kinds (the old core
// reads them), our own data under a separate top-level key.
export function prefsToFile(prefs) {
  const p = normPrefs(prefs);
  const kinds = { ...p.kinds };
  for (const k of LEGACY_KINDS) if (p.legacy[k] === false) kinds[k] = false;
  return {
    notifications: { enabled: p.enabled, kinds, quiet: p.quiet },
    pluginNotifications: { plugins: p.plugins, migrated: p.migrated, ...(p.legacyFor ? { legacyFor: p.legacyFor } : {}) },
  };
}

// Effective quiet hours: from the settings; if not set — services.push.quietStart/quietEnd from config.json (as
// before 2026-11-09); not there either — 23:00–08:00. from — where it came from (the shell hints that the value is from config.json).
export function effectiveQuiet(prefs, pushConfig = {}) {
  if (prefs?.quiet) return { ...prefs.quiet, from: "settings" };
  const c = pushConfig && typeof pushConfig === "object" ? pushConfig : {};
  const start = normHM(c.quietStart);
  const end = normHM(c.quietEnd);
  if (start || end) {
    const out = { enabled: true, start: start || QUIET_DEFAULT.start, end: end || QUIET_DEFAULT.end, from: "config" };
    // equal start and end in config.json meant "no quiet hours" (an empty window) — show it that way: off,
    // with the default bounds (turned on — it will be 23:00–08:00, not an empty window or a 23-hour window)
    if (out.start === out.end) return { enabled: false, ...QUIET_DEFAULT, from: "config" };
    return out;
  }
  return { enabled: true, ...QUIET_DEFAULT, from: "default" };
}

// A partial edit from PUT /settings/notifications on top of the current settings. → {prefs} | {error}
// {enabled?: bool, kinds?: {<kind>: bool}, quiet?: {enabled?: bool, start?: "HH:MM", end?: "HH:MM"}}
export function applyPatch(prefs, patch, pushConfig = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "args:body:type" };
  const known = new Set(["enabled", "kinds", "plugins", "quiet"]);
  if (!Object.keys(patch).length || Object.keys(patch).some((k) => !known.has(k))) return { error: "args:body:keys" };
  const next = normPrefs(prefs);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { error: "args:enabled:type" };
    next.enabled = patch.enabled;
  }
  if (patch.kinds !== undefined) {
    if (!patch.kinds || typeof patch.kinds !== "object" || Array.isArray(patch.kinds)) return { error: "args:kinds:type" };
    for (const [k, v] of Object.entries(patch.kinds)) {
      // "security" is not included here: security exceptions cannot be turned off
      if (!KINDS.includes(k)) return { error: "args:kinds:enum" };
      if (typeof v !== "boolean") return { error: "args:kinds:type" };
      next.kinds[k] = v;
    }
  }
  if (patch.plugins !== undefined) {
    if (!patch.plugins || typeof patch.plugins !== "object" || Array.isArray(patch.plugins)) return { error: "args:plugins:type" };
    for (const [id, v] of Object.entries(patch.plugins)) {
      if (!PLUGIN_ID_RE.test(id)) return { error: "args:plugins:id" };
      if (typeof v !== "boolean") return { error: "args:plugins:type" };
      next.plugins[id] = v;
      delete next.migrated[id]; // the human chose themselves — the migration mark is no longer needed
    }
    if (Object.keys(next.plugins).length > MAX_PLUGIN_TOGGLES) return { error: "args:plugins:too-many" };
  }
  if (patch.quiet !== undefined) {
    const q = patch.quiet;
    if (!q || typeof q !== "object" || Array.isArray(q)) return { error: "args:quiet:type" };
    for (const k of Object.keys(q)) if (!["enabled", "start", "end"].includes(k)) return { error: "args:quiet:keys" };
    // the first quiet hours edit goes on top of the ones in effect (from config.json), not on top of 23:00–08:00
    const cur = effectiveQuiet(next, pushConfig);
    const out = { enabled: cur.enabled, start: cur.start, end: cur.end };
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== "boolean") return { error: "args:quiet:type" };
      out.enabled = q.enabled;
    }
    for (const k of ["start", "end"]) {
      if (q[k] === undefined) continue;
      const v = normHM(q[k]);
      if (!v) return { error: "args:quiet:time" };
      out[k] = v;
    }
    // an empty window with quiet hours on is an input error; bounds do not matter when they are off
    if (out.enabled && out.start === out.end) return { error: "args:quiet:empty" };
    next.quiet = out;
  }
  return { prefs: next };
}

// The plugin's own switch: a human's explicit choice; without it — off if a plugin rule declared a turned-off
// contract 1 kind (legacyKind), otherwise on. rules — the plugin's push rules (<agenthub.push>, with legacyKind).
export function pluginToggle(prefs, pluginId, rules = null) {
  const p = prefs || defaultPrefs();
  const v = p.plugins?.[pluginId];
  if (typeof v === "boolean") return v;
  return !legacyMuted(p, rules, pluginId);
}

// The plugin's rules declared a contract 1 kind that the human turned off — and the migration applies to this plugin
// (legacyFor: null — the first scan has not finished yet, applies to all; otherwise only to the plugins installed then).
export function legacyMuted(prefs, rules, pluginId = null) {
  const legacy = prefs?.legacy || {};
  if (Array.isArray(prefs?.legacyFor) && !prefs.legacyFor.includes(pluginId)) return false;
  return Array.isArray(rules) && rules.some((r) => r && r.kind === PLUGIN_KIND && LEGACY_KINDS.includes(r.legacyKind) && legacy[r.legacyKind] === false);
}

// Whether a notification of this kind may be shown with these settings. Kind "plugin" — by the plugin's switch
// (plugin — id, rules — its push rules for migrating old kinds).
export function kindAllowed(prefs, kind, { plugin = null, rules = null } = {}) {
  if (kind === SECURITY) return true;
  const p = prefs || defaultPrefs();
  if (!p.enabled) return false;
  if (kind === PLUGIN_KIND) return plugin ? pluginToggle(p, plugin, rules) : true;
  return p.kinds?.[KINDS.includes(kind) ? kind : "other"] !== false;
}
