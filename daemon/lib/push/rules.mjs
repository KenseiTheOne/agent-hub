// Push event table (section 6 of the design).
//
// A plugin writes `event=<key>` to its output; the core sends `event.raised` / `event.cleared` to the bus with the key
// `<pluginId>:<key>`. The rule is chosen by the key itself (without the plugin id): an exact match of the name or
// an alias, or the name + an instance suffix after `:`, `.`, `/` or `-` (`session-waiting:<sessionId>`).
//
// Only the core's generic rules live here (a waiting session, plugin failures, the hub's own events). Plugins — builtin ones
// too (agents, claude-sessions, quota) — describe their events themselves with the tag
// `<agenthub.push key=… hold=… quiet=… macOnly=… cooldown=… away=… kind=…>Label`
// (lib/meta.mjs, parsePushRule); the push service takes these rules only from builtin, official and own plugins
// (tier from the signed index) and puts them ahead of the table (pluginRules).
//
// Rule fields:
//   label          — the event text (written by the hub or a trusted plugin, not shown for untrusted ones);
//   hold           — "evening": during the day hold until the evening window (21:00), repeat once per "day";
//   awayDelayMs    — macOS right away if the human is at the Mac; Telegram if they stepped away and the event has been up longer;
//   quietException — goes to Telegram during quiet hours too;
//   macOnly        — only a macOS notification, never Telegram;
//   cooldownMs     — a repeated raise of the same key within the window is not sent (flapping, "once a week");
//                    null — the default from settings (flapCooldownMs);
//   kind           — the notification kind for "Settings → Notifications" (KINDS, "plugin" — the plugin's own switch,
//                    only for plugin rules); "security" cannot be turned off by the
//                    "Settings" switches. Set by the core table and a trusted plugin (<agenthub.push kind=…>); config.json does not
//                    change the kind, and does not override core rules of kind "security" at all (neither hold, nor awayDelayMs, nor
//                    cooldownMs, nor label). What remains is the service's master switch services.push.enabled = false — it is
//                    visible in "Settings". A plugin event with such a core rule's key does not become an exception.

import { MESSAGES } from "../i18n.mjs";
import { KINDS, PLUGIN_KIND, SECURITY } from "./prefs.mjs";

// Notification kinds with switches in "Settings" (settings.json → notifications.kinds) — lib/push/prefs.mjs.
// Security exceptions (SECURITY) arrive whatever the switches (master and per-kind) say. Such an event can be declared
// only by the core and a trusted plugin (builtin or official — the push service does not take the others' rules).
export { KINDS, PLUGIN_KIND, SECURITY };
const KIND_SET = new Set([...KINDS, SECURITY, PLUGIN_KIND]);
export function validKind(k) {
  return typeof k === "string" && KIND_SET.has(k);
}

// A rule label is Russian text from the core table; for another language the engine takes the translation (engine.compose).
const L = (name) => MESSAGES.ru[`push.rule.${name}`];
const MIN = 60_000;

export const DEFAULT_RULES = Object.freeze([
  { name: "session-waiting", aliases: ["waiting"], label: L("session-waiting"), awayDelayMs: 5 * MIN, cooldownMs: 0, kind: "sessions" },
  { name: "source-broken", label: L("source-broken"), kind: "problems" },
  { name: "auth-failed", label: L("auth-failed"), kind: "problems" },
  { name: "plugin-error", label: L("plugin-error"), kind: "problems" },
  // The hub's own event (push service, source @hub): the approval limit — answers to sessions while paused.
  { name: "approvals-paused", label: L("approvals-paused"), kind: "sessions" },
  // Hub event: requirements.app changed (another app build was pinned or the requirement was rewritten).
  // Right away, without a flapping window and during quiet hours: if it was not a human who re-pinned, they must see it.
  // bannerAlways: the banner always goes through osascript, bypassing the shell and /push/ack. Acknowledgement is accepted from class
  // app — and right after re-pinning, class app belongs to the very build this notification is about:
  // it must not be able to dismiss it. The field is not in FIELDS — neither config.json nor a plugin can remove it.
  { name: "app-pin-changed", label: L("app-pin-changed"), quietException: true, cooldownMs: 0, bannerAlways: true, kind: "security" },
  // Hub event: appPin.path changed — the bundle the daemon launches at startup and after a crash (app service).
  // Like a pin change: right away, during quiet hours, a banner bypassing the shell.
  { name: "app-pin-path-changed", label: L("app-pin-path-changed"), quietException: true, cooldownMs: 0, bannerAlways: true, kind: "security" },
  // Hub event: the signed registry catalog has a new version of an installed plugin (lib/registry/updates.mjs).
  // The key is plugin-update:<id>:<version>; one notification per version is decided by the check itself (Registry/updates.json),
  // so there is no flapping window. macOS only: an update is not urgent, it is not sent to Telegram.
  { name: "plugin-update", label: L("plugin-update"), macOnly: true, cooldownMs: 0, kind: "updates" },
  // Hub event: the app keeps crashing, the daemon's supervision (app service) used up the restart limit (3 per 10 min).
  // bannerAlways: there is no app — the banner goes right away through osascript, without waiting for /push/ack.
  { name: "app-restart-stopped", label: L("app-restart-stopped"), cooldownMs: 0, bannerAlways: true, kind: "security" },
  // Hub events: an update of the hub itself (hub-update service, docs/hub-updates.md). A new version is available — key
  // hub-update:<version>, one notification per version is decided by the check (HubUpdate/check.json), macOS only.
  { name: "hub-update", label: L("hub-update"), macOnly: true, cooldownMs: 0, kind: "updates" },
  // A new version is built, but the restart is waiting: there are PermissionRequest cards or waiting sessions (phase ready,
  // "Restart now (N waiting)") — key hub-update-ready:<label>, one notification per version is decided by the install
  // (HubUpdate/check.json → readyNotified). macOS only: the restart is a button in the app.
  { name: "hub-update-ready", label: L("hub-update-ready"), macOnly: true, cooldownMs: 0, kind: "updates" },
  // Installed (or rolled back) and confirmed by the new app — key hub-update-installed:<label>.
  { name: "hub-update-installed", label: L("hub-update-installed"), cooldownMs: 0, kind: "updates" },
  // Failed (build, check, trial run) — right away, during quiet hours too; a banner bypassing the shell: there may be
  // no app (rollback), and a build that did not come up must not be able to dismiss a notification about itself.
  { name: "hub-update-failed", label: L("hub-update-failed"), quietException: true, cooldownMs: 0, bannerAlways: true, kind: "updates" },
  // The tag of a version the hub has seen was moved to another commit (a release may have been tampered with): right away, during quiet hours too,
  // a banner bypassing the shell — key hub-update-tag-moved:<version>.
  { name: "hub-update-tag-moved", label: L("hub-update-tag-moved"), quietException: true, cooldownMs: 0, bannerAlways: true, kind: "security" },
  // The update was stopped due to a sign of tampering (commit-mismatch, not-on-main, untrusted-build, verify-failed,
  // tag-moved — push service, SUSPECT_ERRORS): not "update failed" from the switchable "Updates", but a security
  // exception — key hub-update-suspect:<label>. Right away, during quiet hours too, a banner bypassing the shell.
  { name: "hub-update-suspect", label: L("hub-update-suspect"), quietException: true, cooldownMs: 0, bannerAlways: true, kind: "security" },
  // Hub event: plugins.lock has an own plugin entry (tier own) that the manager did not make (not after a consent window):
  // the plugin runs as community, the app shows a request for re-approval. Key —
  // plugin-own-unexpected:<id>. Like a pin change: right away, during quiet hours, a banner bypassing the shell.
  { name: "plugin-own-unexpected", label: L("plugin-own-unexpected"), quietException: true, cooldownMs: 0, bannerAlways: true, kind: "security" },
]);

const FIELDS = {
  label: "string",
  hold: "string",
  awayDelayMs: "number",
  quietException: "boolean",
  macOnly: "boolean",
  cooldownMs: "number",
};

function cleanRule(name, raw) {
  const out = { name };
  for (const [k, t] of Object.entries(FIELDS)) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (typeof raw[k] !== t) continue;
    if (t === "number" && (!Number.isFinite(raw[k]) || raw[k] < 0)) continue;
    if (k === "hold" && raw[k] !== "evening") continue;
    out[k] = k === "label" ? raw[k].slice(0, 80) : raw[k];
  }
  if (Array.isArray(raw.aliases)) out.aliases = raw.aliases.filter((a) => typeof a === "string" && a).slice(0, 10);
  return out;
}

// overrides — services.push.rules from config.json: { "<name>": {fields} }; an existing rule is extended,
// a new one is added. Core security exceptions are not overridden: any of the user's processes can rewrite config.json,
// and such an event must arrive.
export function buildRules(overrides = {}) {
  const rules = DEFAULT_RULES.map((r) => ({ ...r, aliases: [...(r.aliases || [])] }));
  if (overrides && typeof overrides === "object") {
    for (const [name, raw] of Object.entries(overrides)) {
      if (!/^[\w.-]{1,64}$/.test(name) || !raw || typeof raw !== "object") continue;
      const clean = cleanRule(name, raw);
      const i = rules.findIndex((r) => r.name === name);
      if (i >= 0 && rules[i].kind === SECURITY) continue;
      if (i >= 0) rules[i] = { ...rules[i], ...clean, aliases: clean.aliases || rules[i].aliases };
      else rules.push({ aliases: [], ...clean });
    }
  }
  return rules;
}

// A user override (services.push.rules) on top of a plugin rule: the key "<plugin>:<name>" is more specific
// than just "<name>". Rules from <agenthub.push> go ahead of the shared table, but the config has the last word.
export function applyOverride(rule, overrides, plugin = null) {
  if (!rule || !overrides || typeof overrides !== "object" || !rule.name || rule.name === "default") return rule;
  // a security exception (core or declared by a trusted plugin) is not overridden by config.json
  if (rule.kind === SECURITY) return rule;
  const raw = (plugin && overrides[`${plugin}:${rule.name}`]) || overrides[rule.name];
  if (!raw || typeof raw !== "object") return rule;
  const { aliases, ...c } = cleanRule(rule.name, raw);
  return { ...rule, ...c, name: rule.name };
}

// The instance suffix comes after `:`, `.`, `/` or `-` (`wf-failed-<runId>` in agents).
function matches(bare, n) {
  return bare === n || bare.startsWith(`${n}:`) || bare.startsWith(`${n}.`) || bare.startsWith(`${n}/`) || bare.startsWith(`${n}-`);
}

// Rules from a trusted plugin's <agenthub.push> (meta.push) → in table format. The key is the rule name.
export function pluginRules(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list.slice(0, 32)) {
    if (!r || typeof r.key !== "string" || !/^[\w.-]{1,64}$/.test(r.key)) continue;
    // the kind only comes from the plugin's tag (cleanRule does not let it through: the kind cannot be set via config.json); legacyKind —
    // the old contract 1 kind for migrating a turned-off switch (prefs.pluginToggle)
    out.push({ ...cleanRule(r.key, r), aliases: [], ...(validKind(r.kind) ? { kind: r.kind } : {}), ...(r.kind === PLUGIN_KIND && typeof r.legacyKind === "string" ? { legacyKind: r.legacyKind } : {}) });
  }
  return out;
}

// Event kind: the rule's kind; for a plugin rule without a kind — the kind of the shared-table rule with the same key
// (`auth-failed` of a plugin without its own kind — "failures and warnings"); nothing — "other". An untrusted plugin is always "other":
// it cannot declare a security exception. The "security" kind from the core table goes only to hub events
// (hub: true): a plugin that raised a core key (app-restart-stopped etc.) does not become an exception — a trusted
// plugin can declare an exception only with its own <agenthub.push kind="security"> tag.
export function kindOf(rule, { trusted = true, table = DEFAULT_RULES, bare = null, hub = true } = {}) {
  if (!trusted) return "other";
  if (validKind(rule?.kind)) return rule.kind;
  if (bare != null) {
    const base = matchRule(table, bare);
    if (validKind(base?.kind) && (hub || base.kind !== SECURITY)) return base.kind;
  }
  return "other";
}

// bare — the event key without the plugin id. No rule → the default rule (right away, by route).
export function matchRule(rules, bare) {
  let best = null;
  let bestLen = -1;
  for (const r of rules) {
    for (const n of [r.name, ...(r.aliases || [])]) {
      if (n.length > bestLen && matches(bare, n)) {
        best = r;
        bestLen = n.length;
      }
    }
  }
  return best || { name: "default", label: null };
}
