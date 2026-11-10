// The push service (stage 4): plugin `event=` events → a macOS or Telegram notification.
// Logic — lib/push/engine.mjs, event table — lib/push/rules.mjs, contract — lib/push/README.md.
//
// Settings — services.push in <home>/config.json (lib/push/config.mjs). Telegram is off until
// the user enables services.push.telegram.enabled and creates entries in the keychain.
// In test mode (AGENTHUB_HOME) Telegram is always off: nothing leaves the machine from tests.
//
// Switches and quiet hours — "Settings → Notifications" (settings.json → notifications, written only by app;
// lib/push/prefs.mjs). Quiet hours from config.json (quietStart/quietEnd) apply until they're set in "Settings".

import { join } from "node:path";
import { versionApp } from "../hub-update/layout.mjs";
import { readInstall } from "../hub-update/trial.mjs";
import { t } from "../i18n.mjs";
import { managerFor } from "../plugins.mjs";
import { clearAcks, waitAck } from "../push/acks.mjs";
import { resolvePushConfig } from "../push/config.mjs";
import { systemTimeZone, validTimeZone } from "../push/clock.mjs";
import { effectiveQuiet } from "../push/prefs.mjs";
import { PushEngine } from "../push/engine.mjs";
import { createPresence } from "../push/idle.mjs";
import { createMacNotifier } from "../push/macos.mjs";
import { createStore } from "../push/store.mjs";
import { createTelegram } from "../push/telegram.mjs";
import { samePath } from "../platform.mjs";
import { isLabel } from "../version.mjs";

export const name = "push";

let engine = null;
let timer = null;
let unsubscribe = null;

// Plugin state → what's needed for the event text (only metadata from the header/body).
// Events of the hub itself (not plugins) go under this id. "@" in a plugin id is impossible: registry — ID_RE, built-in and
// local — the host's PLUGIN_ID_RE (lib/host.mjs scanDir), so it can't be faked.
export const HUB_SOURCE = "@hub";
// Hub update failure reasons that look like a release or build substitution (lib/hub-update/build.mjs, updater.mjs).
export const SUSPECT_ERRORS = new Set(["commit-mismatch", "not-on-main", "untrusted-build", "verify-failed", "tag-moved"]);

// Hub event detail (metadata only): where it was pinned from and when — per the writer (pin-app writes
// under itself). The text is in the active language: "From a Claude Code session · 11:57. If this wasn't you, open the log".
export function hubDetail(ctx, bare) {
  // "Update available: Mail 0.4.0" — id and version from the key itself (plugin-update:<id>:<version>), the title is the
  // same as in the popover and manager (from the verified catalog, in the hub language); no catalog — the id.
  const up = /^plugin-update:([a-z0-9][a-z0-9-]{0,63}):(.{1,64})$/.exec(bare);
  if (up) return `${updateTitle(ctx, up[1])} ${up[2]}`;
  const ou = /^plugin-own-unexpected:([a-z0-9][a-z0-9-]{0,63})$/.exec(bare);
  if (ou) return t(ctx.lang?.() || "ru", "own.unexpected.detail", { title: ownTitle(ctx, ou[1]) });
  const hu = hubUpdateDetail(ctx, bare);
  if (hu !== undefined) return hu;
  if (bare === "app-restart-stopped") {
    const sup = ctx.facts?.get?.("app.supervisor");
    const info = sup?.info?.() ?? {};
    // stopped because of a recurring skip (the bundle fails the check, ps doesn't answer), not crashes
    if (info.why) return t(ctx.lang?.() || "ru", "app.restart-stopped.why", { why: info.why });
    return t(ctx.lang?.() || "ru", "app.restart-stopped", { restarts: info.restarts || 3, minutes: Math.round((sup?.opts?.windowMs ?? 600_000) / 60_000) });
  }
  if (bare === "app-pin-path-changed") {
    let path = null;
    try {
      path = ctx.state.snapshot()?.appPin?.path ?? null;
    } catch {}
    return t(ctx.lang?.() || "ru", "pin.path.detail", { path: path || "—" });
  }
  if (bare !== "app-pin-changed") return null;
  let pin = null;
  try {
    pin = ctx.state.snapshot()?.appPin;
  } catch {}
  if (!pin) return null;
  const lang = ctx.lang?.() || "ru";
  if (pin.fingerprint === "none" || pin.kind === "none") return t(lang, "pin.removed");
  const where = pin.by === "manual" ? t(lang, "pin.manual") : t(lang, ["claude-code", "terminal", "no-tty"].includes(pin.under) ? `pin.under.${pin.under}` : "pin.under.unknown");
  let time = "";
  try {
    const d = new Date(pin.changedAt || Date.now());
    time = d.toLocaleTimeString(lang === "en" ? "en-US" : "ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {}
  return t(lang, "pin.detail", { where, time });
}

// Release notes subject without repeating the version (like HubUpdateText.releaseNotes in the shell): "Agent Hub 0.3.0: a card…"
// → "a card…"; a subject that's only a version ("Agent Hub 0.3.0", "v0.3.0") — the first body line; none — null.
export function releaseSubject(n, version) {
  if (typeof n?.subject !== "string") return null;
  let s = n.subject.trim();
  if (typeof version === "string" && version) {
    const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^(?:agent\\s*hub\\s+)?v?${esc}(?:\\s*[:—–-]\\s*|\\s+|$)`, "i");
    // "Agent Hub 0.2.0: a card …" → "A card …": the subject now stands on its own
    if (re.test(s)) s = s.replace(re, "").trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }
  if (!s) s = String(n.body || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return s || null;
}

// Hub update: detail from the key (version/label) and /state.hubUpdate. undefined — not an update event.
const HU_RE = /^hub-update(?:-(installed|failed|suspect|tag-moved|ready))?:([0-9A-Za-z.+-]{1,80})$/;
function hubUpdateDetail(ctx, bare) {
  const m = HU_RE.exec(bare);
  if (!m) return undefined;
  const lang = ctx.lang?.() || "ru";
  const info = ctx.facts?.get?.("hub.update") ?? null;
  const current = info?.label || info?.running || "?";
  // release notes (the tag message subject) — data from origin: one line, short, without repeating the version
  const notes = (n) => {
    const s = releaseSubject(n, m[2])?.replace(/\s+/g, " ");
    if (!s) return null;
    if (s.length <= 100) return s.replace(/[.;,:!]+$/, "");
    // a long subject is cut at a word boundary with an ellipsis, not "…quota w."
    const cut = s.slice(0, 99);
    const sp = cut.lastIndexOf(" ");
    return `${(sp > 60 ? cut.slice(0, sp) : cut).replace(/[\s.;,:!—–-]+$/, "")}…`;
  };
  if (!m[1]) return t(lang, "hub-update.detail.available", { version: m[2], current, notes: info?.available?.version === m[2] ? notes(info.available.notes) : null });
  const inst = info?.install || {};
  if (m[1] === "ready") {
    const same = inst.phase === "ready" && inst.label === m[2];
    const num = (v) => (same && Number.isInteger(v) && v > 0 ? v : 0);
    // an older daemon (no breakdown) — we count the whole number as cards, as before
    const cards = Number.isInteger(inst.waitingCards) ? num(inst.waitingCards) : num(inst.waiting);
    return t(lang, "hub-update.detail.ready", { label: m[2], cards, sessions: cards > 0 ? 0 : num(inst.waitingSessions) });
  }
  if (m[1] === "tag-moved") {
    const mv = info?.available?.version === m[2] ? info.available.moved : null;
    return t(lang, "hub-update.detail.tag-moved", { version: m[2], old: mv?.old?.slice(0, 12) || "?", new: mv?.new?.slice(0, 12) || "?" });
  }
  if (m[1] === "installed") {
    const cdhash = info?.current?.label === m[2] && typeof info.current.cdhash === "string" ? info.current.cdhash.slice(0, 12) : null;
    return t(lang, "hub-update.detail.installed", { label: m[2], from: inst.from || null, cdhash });
  }
  const code = String(inst.error || "").replace(/^hub-update:/, "");
  const key = `hub-update.why.${code}`;
  const why = t(lang, key) === key ? t(lang, "hub-update.why.other") : t(lang, key);
  return t(lang, "hub-update.detail.failed", { label: m[2], why, current, log: inst.log || null });
}

// Hub event title instead of the rule label: the first pin isn't "again", a removal is "removed".
// null — the rule label as is.
export function hubLabel(ctx, bare) {
  if (/^hub-update-installed:/.test(bare) && ctx.facts?.get?.("hub.update")?.install?.op === "rollback") return t(ctx.lang?.() || "ru", "push.rule.hub-update-rolled-back");
  // path change: the title is the rule label ("The pinned build's path changed"), the path goes to the detail (hubDetail)
  if (bare !== "app-pin-changed") return null;
  let pin = null;
  try {
    pin = ctx.state.snapshot()?.appPin;
  } catch {}
  if (!pin) return null;
  const lang = ctx.lang?.() || "ru";
  if (pin.fingerprint === "none" || pin.kind === "none") return t(lang, "push.rule.app-pin-removed");
  if (pin.old === "none" || pin.old === "unknown") return t(lang, "push.rule.app-pin-first");
  return null;
}

// Own plugin title from the lock entry (an own plugin has no catalog); no entry — the id.
function ownTitle(ctx, id) {
  try {
    const e = managerFor(ctx.paths.home)?.lockEntry(id);
    const lang = ctx.lang?.() || "ru";
    const title = e?.i18n?.[lang]?.title || e?.title;
    if (typeof title === "string" && title.trim()) return title.trim().replace(/\s+/g, " ").slice(0, 80);
  } catch {}
  return id;
}

function updateTitle(ctx, id) {
  try {
    const ce = managerFor(ctx.paths.home)?.catalog?.plugins.get(id);
    const lang = ctx.lang?.() || "ru";
    const title = ce ? ce.i18n?.[lang]?.title || ce.title : null;
    if (typeof title === "string" && title.trim()) return title.trim().replace(/\s+/g, " ").slice(0, 80);
  } catch {}
  return id;
}

// The pinned build path leads into Versions/<label> of an ongoing (or just finished) hub install or rollback:
// the target label or the previous one (rollback after a failed trial run). install.json is read from disk: a new daemon
// may see the path change before the hub-update service comes up.
const INSTALL_PHASES = new Set(["switching", "trial", "rolling-back"]);
const INSTALL_TAIL_MS = 2 * 60_000;
export function installPath(home, path, now = Date.now()) {
  if (typeof home !== "string" || !home || typeof path !== "string" || !path) return false;
  const st = readInstall(home);
  if (!st || typeof st !== "object") return false;
  const fresh = INSTALL_PHASES.has(st.phase) || (["done", "failed"].includes(st.phase) && now - Date.parse(st.finishedAt || "") < INSTALL_TAIL_MS);
  if (!fresh) return false;
  return [st.label, st.from].some((l) => typeof l === "string" && isLabel(l) && samePath(path, versionApp(home, l)));
}

export function makeLookup(ctx) {
  return (pluginId, bare) => {
    if (pluginId === HUB_SOURCE) return { pluginTitle: "Agent Hub", hub: true, itemTitle: hubDetail(ctx, bare), label: hubLabel(ctx, bare), error: null, trusted: true };
    // Without copying the whole plugin state (ctx.state.plugin): lookup is called on every event and on every tick.
    const st = ctx.state.pluginEvent(pluginId, bare);
    if (!st) return { trusted: false, pluginTitle: pluginId };
    return {
      pluginTitle: st.title || st.id,
      itemTitle: st.itemTitle,
      error: bare === "plugin-error" ? st.error : null,
      trusted: st.trusted,
      // own push rules (<agenthub.push>) — the core gives them only to built-in and official plugins
      rules: st.pushRules,
    };
  };
}

// Switches from settings.json (ctx.settings) and the active quiet hours.
function readPrefs(ctx) {
  let prefs = null;
  try {
    prefs = ctx.settings?.get?.("notifications") ?? null;
  } catch {}
  return { prefs, quiet: effectiveQuiet(prefs, ctx.config.services?.push) };
}

export async function start(ctx) {
  const cfg = resolvePushConfig(ctx.config.services?.push);
  const initial = readPrefs(ctx);
  const journal = (entry) => ctx.journal.write(entry);
  const telegramEnabled = cfg.telegram.enabled && !ctx.config.testMode;
  const telegram = createTelegram({
    exec: ctx.exec,
    enabled: telegramEnabled,
    service: cfg.telegram.keychainService,
    timeoutMs: cfg.telegram.timeoutMs,
  });
  engine = new PushEngine({
    config: cfg,
    presence: createPresence({ exec: ctx.exec }),
    mac: createMacNotifier({ emit: (ev) => ctx.emit(ev), waitAck, exec: ctx.exec, ackTimeoutMs: cfg.ackTimeoutMs, journal }),
    telegram,
    lookup: makeLookup(ctx),
    store: createStore(join(ctx.paths.home, "push-state.json")),
    journal,
    lang: () => ctx.lang?.() || "ru",
    prefs: initial.prefs,
    quiet: initial.quiet,
  });
  engine.load();
  // "Settings → Notifications" changed (PUT /settings/notifications) — applied right away, without restarting the service
  const onSettings = (ev) => {
    if (!ev || ev.notifications === undefined) return;
    const { prefs, quiet } = readPrefs(ctx);
    engine?.setPrefs(prefs, quiet);
  };
  ctx.on("settings.changed", onSettings);

  const onRaised = (ev) => engine?.raised(ev);
  const onCleared = (ev) => engine?.cleared(ev);
  ctx.on("event.raised", onRaised);
  ctx.on("event.cleared", onCleared);
  // Session replies paused by the approval limit (design §3: "pause + push"): a hub event for the duration of the pause.
  let pauseTimer = null;
  const pausedKey = `${HUB_SOURCE}:approvals-paused`;
  const onPaused = (ev) => {
    const until = Date.parse(ev.until || "");
    clearTimeout(pauseTimer);
    engine?.raised({ plugin: HUB_SOURCE, key: pausedKey, status: "block" });
    const ms = Number.isFinite(until) ? Math.max(0, until - Date.now()) : 10 * 60_000;
    pauseTimer = setTimeout(() => engine?.cleared({ plugin: HUB_SOURCE, key: pausedKey }), ms);
    pauseTimer.unref?.();
  };
  ctx.on("hook.paused", onPaused);
  // requirements.app changed (the app build was re-pinned): one notification per change, including
  // during quiet hours — if an agent re-pinned it, the human must see it. The banner is always osascript, without /push/ack
  // (the bannerAlways rule in lib/push/rules.mjs): the pinned build can't suppress a notification about itself. Raise and clear right away: one key, the rule
  // has no debounce window, the next change notifies again.
  const pinKey = `${HUB_SOURCE}:app-pin-changed`;
  const onPin = (ev) => {
    // the pin change is written by an ongoing hub install (expected fingerprint): instead of "re-pinned" we get
    // "Agent Hub updated" after the new app confirms. A foreign change with the same by — notified as usual
    if (ctx.facts?.get?.("hub.update.expectsPin", ev?.appPin?.fingerprint)) return;
    engine?.raised({ plugin: HUB_SOURCE, key: pinKey, status: "block" });
    engine?.cleared({ plugin: HUB_SOURCE, key: pinKey });
  };
  ctx.on("app-pin.changed", onPin);
  // Hub update (hub-update service): a version is available (once per version), built and waiting for a restart (once
  // per version), installed, failed.
  const huKey = (kind, v) => `${HUB_SOURCE}:hub-update${kind ? `-${kind}` : ""}:${v}`;
  const okVer = (v) => typeof v === "string" && /^[0-9A-Za-z.+-]{1,80}$/.test(v);
  const onHubAvail = (ev) => {
    if (!okVer(ev?.version)) return;
    engine?.raised({ plugin: HUB_SOURCE, key: huKey(null, ev.version), status: "ok" });
    engine?.cleared({ plugin: HUB_SOURCE, key: huKey(null, ev.version) });
  };
  const onHubInstalled = (ev) => {
    if (!okVer(ev?.label)) return;
    engine?.raised({ plugin: HUB_SOURCE, key: huKey("installed", ev.label), status: "ok" });
    engine?.cleared({ plugin: HUB_SOURCE, key: huKey("installed", ev.label) });
  };
  // a tampering sign is a separate key with kind security: turned-off "Updates" don't silence it
  const onHubFailed = (ev) => {
    if (!okVer(ev?.label)) return;
    const kind = SUSPECT_ERRORS.has(String(ev.error || "").replace(/^hub-update:/, "")) ? "suspect" : "failed";
    engine?.raised({ plugin: HUB_SOURCE, key: huKey(kind, ev.label), status: "error" });
    engine?.cleared({ plugin: HUB_SOURCE, key: huKey(kind, ev.label) });
  };
  // built, the restart waits for cards — only if the install decided to notify (once per version)
  const onHubReady = (ev) => {
    if (ev?.notify !== true || !okVer(ev?.label)) return;
    engine?.raised({ plugin: HUB_SOURCE, key: huKey("ready", ev.label), status: "ok" });
    engine?.cleared({ plugin: HUB_SOURCE, key: huKey("ready", ev.label) });
  };
  const onHubMoved = (ev) => {
    if (!okVer(ev?.version)) return;
    engine?.raised({ plugin: HUB_SOURCE, key: huKey("tag-moved", ev.version), status: "block" });
    engine?.cleared({ plugin: HUB_SOURCE, key: huKey("tag-moved", ev.version) });
  };
  ctx.on("hub-update.tag-moved", onHubMoved);
  ctx.on("hub-update.ready", onHubReady);
  ctx.on("hub-update.available", onHubAvail);
  ctx.on("hub-update.installed", onHubInstalled);
  ctx.on("hub-update.failed", onHubFailed);
  // The pinned build path changed (appPin.path — where the daemon launches the app from): handled like a pin.
  // A path into Versions/<label> of an ongoing install or rollback is the install itself: instead of an alarm we get "Agent Hub
  // updated" (or "reverted", "failed"), docs/hub-updates.md §5. The expected fingerprint (expectsPin) doesn't count
  // here: with the same signature it equals the current one, and then a path change to anywhere would pass silently.
  const pinPathKey = `${HUB_SOURCE}:app-pin-path-changed`;
  const onPinPath = (ev) => {
    if (installPath(ctx.paths?.home, ev?.appPin?.path)) return;
    engine?.raised({ plugin: HUB_SOURCE, key: pinPathKey, status: "block" });
    engine?.cleared({ plugin: HUB_SOURCE, key: pinPathKey });
  };
  ctx.on("app-pin.path-changed", onPinPath);
  // A new version of an installed plugin in the registry (plugins service, once per version): raise and clear right away.
  const onUpdate = (ev) => {
    if (typeof ev?.plugin !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(ev.plugin) || typeof ev.version !== "string" || !ev.version || ev.version.length > 64) return;
    const key = `${HUB_SOURCE}:plugin-update:${ev.plugin}:${ev.version}`;
    engine?.raised({ plugin: HUB_SOURCE, key, status: "ok" });
    engine?.cleared({ plugin: HUB_SOURCE, key });
  };
  ctx.on("plugins.update-available", onUpdate);
  // An own plugin's entry in plugins.lock was made bypassing the manager (plugins service, once per entry): a security
  // exception — raise and clear right away, like a pin.
  const onOwnUnexpected = (ev) => {
    if (typeof ev?.plugin !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(ev.plugin)) return;
    const key = `${HUB_SOURCE}:plugin-own-unexpected:${ev.plugin}`;
    engine?.raised({ plugin: HUB_SOURCE, key, status: "block" });
    engine?.cleared({ plugin: HUB_SOURCE, key });
  };
  ctx.on("plugins.own-unexpected", onOwnUnexpected);
  // The app keeps crashing and supervision (app service) stopped restarting it: raise and clear right away, like a pin.
  const crashKey = `${HUB_SOURCE}:app-restart-stopped`;
  const onCrash = () => {
    engine?.raised({ plugin: HUB_SOURCE, key: crashKey, status: "error" });
    engine?.cleared({ plugin: HUB_SOURCE, key: crashKey });
  };
  ctx.on("app.restart-stopped", onCrash);
  unsubscribe = () => {
    ctx.off("settings.changed", onSettings);
    ctx.off("hub-update.tag-moved", onHubMoved);
    ctx.off("hub-update.ready", onHubReady);
    ctx.off("hub-update.available", onHubAvail);
    ctx.off("hub-update.installed", onHubInstalled);
    ctx.off("hub-update.failed", onHubFailed);
    ctx.off("app.restart-stopped", onCrash);
    ctx.off("plugins.update-available", onUpdate);
    ctx.off("plugins.own-unexpected", onOwnUnexpected);
    ctx.off("event.raised", onRaised);
    ctx.off("event.cleared", onCleared);
    ctx.off("hook.paused", onPaused);
    ctx.off("app-pin.changed", onPin);
    ctx.off("app-pin.path-changed", onPinPath);
    clearTimeout(pauseTimer);
  };

  // Services start after plugins: events raised before subscribing are taken from the state.
  for (const st of ctx.state.plugins()) {
    for (const k of st.events || []) engine.raised({ plugin: st.id, key: `${st.id}:${k}`, status: st.status });
  }

  // No time zone set in config.json — the system one: if the Mac changed zones (travel), quiet hours are computed in the new one, without a restart.
  const tzFixed = validTimeZone(ctx.config.services?.push?.timezone);
  timer = setInterval(() => {
    if (!tzFixed && engine) engine.setTimeZone(systemTimeZone());
    engine?.tick();
  }, cfg.tickMs);
  timer.unref();
  ctx.journal.write({ type: "push-start", telegram: telegramEnabled, timezone: cfg.timezone, enabled: engine.prefs.enabled, quiet: initial.quiet.enabled ? `${initial.quiet.start}-${initial.quiet.end}` : "off" });
}

export async function stop() {
  clearInterval(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
  const e = engine;
  engine = null;
  clearAcks();
  await e?.idle();
}

// For tests: the current engine.
export function _engine() {
  return engine;
}
