// Core: state, worst status, primitive registry, confirmation levels, checking arguments against facts,
// effects allowlist for third-party plugins, ESTOP (file), journal (metadata only), event bus.

import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, chmodSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR, REPO_DIR } from "./config.mjs";
import { AppPinWatcher } from "./app-pin.mjs";
import { Journal } from "./journal.mjs";
import { connectionIdOf, CONTRACT_VERSION, LEVELS, readPluginMeta } from "./meta.mjs";
import { cleanAuthor } from "./author.mjs";
import { parseEffectSpec, parseOutput, worstStatus, SEVERITY } from "./output.mjs";
import { loadModules } from "./loader.mjs";
import { argsFromTokens, validateArgs } from "./schema.mjs";
import { makeCtx, makeExec } from "./ctx.mjs";
import { PluginHost } from "./host.mjs";
import { liveStateDir, samePath } from "./platform.mjs";
import { actionArgv } from "./runner.mjs";
import { tabOf, terminalsInfo } from "./terminals/index.mjs";
import { realExec, refuseExec } from "./terminals/_exec.mjs";
import { msg, pickLang, releaseLangSource, setLangSource, t } from "./i18n.mjs";
import { Settings } from "./settings.mjs";
import { applyPatch, effectiveQuiet, legacyMuted, pluginToggle, PLUGIN_KIND } from "./push/prefs.mjs";
import { resolvePushConfig } from "./push/config.mjs";
import { DEFAULT_RULES, SECURITY } from "./push/rules.mjs";

// Hub version is the VERSION file at the repository root (lib/version.mjs), not a string in code.
export { VERSION } from "./version.mjs";
import { VERSION } from "./version.mjs";

// What a third-party plugin may offer, whatever its metadata says.
export const THIRD_PARTY_EFFECTS = ["open.*", "terminal.focus", "cmux.focus", "session.focus"];
// Primitive aliases: the old name is still accepted until the next contract (docs mark it deprecated). A plugin that declared one
// name in <agenthub.effects> may offer the other.
export const PRIMITIVE_ALIASES = Object.freeze({ "cmux.focus": "terminal.focus" });
const canonical = (name) => PRIMITIVE_ALIASES[name] || name;
export const LOCAL_EFFECTS = ["open.*"];
// Primitives accepted only from app, regardless of what the module declared.
// Controlling external agents (launchers, schedulers) is not a core primitive but a declared plugin action.
export const APP_ONLY = /^(session\.(respond|launch|stop|interrupt)|process\.)/;
// Plugin tiers. Taken only from the install location and the signed registry index (plugins.lock),
// never from the plugin's own metadata.
// own — your own plugin from a local folder that a human approved in the app (manager, Plugins/<id>, a
// plugins.lock entry with tier own): trusted like an official one.
export const TIERS = ["builtin", "official", "own", "community", "local"];
// Trusted plugin: builtin, official (per the signed index) or own (approved by a human in the
// app). Only per the manager's policy (pl.granted), not per metadata. They get actions, their own push rules,
// service variables (AGENTHUB_USAGE_FILE etc., $VARIABLE in <agenthub.watch>), the session registry, MCP via the hub.
export function trustedPlugin(pl) {
  return pl?.source === "builtin" || pl?.granted?.official === true || (pl?.source === "installed" && pl?.granted?.tier === "own");
}

// Connections declared by a plugin (<agenthub.connection>, contract 2): only for a trusted plugin, only to hosts from
// its <agenthub.net> and only with its own id (the plugin id or "<id>.<name>", lib/meta.mjs connectionIdOf: a plugin
// id never contains a dot, so another plugin's connection cannot be declared this way; id starts with a letter, up to 64 — like a keychain entry name).
// tier — plugin tier (oauth service: a sign-in before contract 2 without a resource address is accepted only from builtin and
// official). → { list: [...], rejected: [{id, why}] }
export function pluginConnections(pl) {
  const out = { list: [], rejected: [] };
  if (!trustedPlugin(pl)) return out;
  const tier = pl.source === "builtin" ? "builtin" : pl.granted?.tier === "own" ? "own" : "official";
  const net = new Set((pl.meta?.net || []).map((e) => String(e).split(/\s+[—–-]{1,2}\s+/)[0].trim().toLowerCase()));
  for (const c of pl.meta?.connections || []) {
    const id = c.id || pl.id;
    if (!connectionIdOf(pl.id, id)) out.rejected.push({ id, why: "id" });
    else if (![c.host, ...(c.hosts || [])].every((h) => net.has(String(h).toLowerCase()))) out.rejected.push({ id, why: "net" });
    else if (out.list.some((x) => x.id === id)) out.rejected.push({ id, why: "duplicate" });
    else out.list.push({ ...c, id, plugin: pl.id, tier, tools: [...c.tools], hosts: [...(c.hosts || [])] });
  }
  return out;
}
// Action argument value: up to 256 characters, no control characters, must not look like a flag ("-…"), on top of the plugin's pattern.
const ARG_MAX = 256;
// Claude Code session effort levels (the sessionEffort= parameter in plugin output); anything else is dropped.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Session model (sessionModel=, contract 3): a model id from the turn record ("claude-opus-5-5") or a name from /model output
// ("Opus 5.5 (default)", "Sonnet 4.5 [1m]"). Only letters, digits, space and " ._:()[]/+-", up to 64 chars; anything else is dropped.
export const SESSION_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:()[\]/+-]{0,63}$/;
// Where model/effort came from: the last turn (turn) or a /model, /effort command after it (command).
export const SESSION_META_SOURCES = ["turn", "command"];
// Variables that services give to trusted plugins (ctx.providePluginEnv): AGENTHUB_<NAME>, not among those reserved by the core.
const PLUGIN_ENV_RE = /^AGENTHUB_[A-Z][A-Z0-9_]{0,40}$/;
const RESERVED_PLUGIN_ENV = new Set(["AGENTHUB_PLUGIN_ID", "AGENTHUB_PLUGIN_DATA_PATH", "AGENTHUB_PLUGIN_CACHE_PATH", "AGENTHUB_REFRESH_REASON", "AGENTHUB_LANG", "AGENTHUB_PAUSED"]);

const CONFIRM_TTL_MS = 120_000;
// Warnings from a single plugin to the journal per minute (Core.warn).
const WARN_PER_MIN = 20;
// Hook events without a decision (only the interactive session registry and dismissing cards) — called even while the hub is paused.
const HOOK_LIFECYCLE = new Set(["SessionStart", "SessionEnd", "Stop"]);

export function effectAllowed(name, patterns) {
  return patterns.some((p) => (p.endsWith(".*") ? name.startsWith(p.slice(0, -1)) : name === p || canonical(name) === canonical(p)));
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

// The first top-level line by which a plugin explains a fault (status=unknown|error or
// event=source-broken), otherwise the first header line; null — nothing to say.
function pluginWhy(st) {
  const top = (list) => (Array.isArray(list) ? list.filter((i) => i && !i.level && !i.separator && typeof i.title === "string" && i.title.trim()) : []);
  const all = [...top(st.header), ...top(st.body)];
  const hit = all.find((i) => i.status === "unknown" || i.status === "error" || i.event === "source-broken") ?? top(st.header)[0];
  return hit ? hit.title.trim().slice(0, 160) : null;
}

export class Core {
  constructor({ config, peer, journal = null, terminalExec = null }) {
    this.config = config;
    this.peer = peer;
    // Runner of terminal tools (tmux, osascript) for the terminal layer (lib/terminals/_exec.mjs): AGENTHUB_TEST_EXEC_LOG — only
    // written to the file; a test hub without a double — refused (no real terminal is touched from a test copy).
    this.terminalExec =
      terminalExec ||
      (config.testExecLog
        ? async (file, args) => {
            appendFileSync(config.testExecLog, JSON.stringify({ file, args }) + "\n");
            return { code: 0, stdout: "", timedOut: false };
          }
        : config.testMode
          ? refuseExec
          : realExec);
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
    // SSE event ids start from the startup timestamp (ms × 1000): a Last-Event-ID from a previous
    // daemon instance is always less than the new seqBase — the client gets a snapshot instead of someone else's tail.
    this.seqBase = Date.now() * 1000;
    this.seq = this.seqBase;
    this.recent = []; // recent events for Last-Event-ID
    this.journal = journal || new Journal(config.paths.journal, { maxBytes: config.journal?.maxBytes });
    this.exec = makeExec(config);
    this.primitives = new Map();
    this.plugins = new Map(); // id → state
    this.offers = new Map(); // offerId → { pluginId, kind, primitive, args, action }
    this.pluginOffers = new Map(); // pluginId → Set(offerId)
    this.activeEvents = new Map(); // pluginId → Set(key)
    this.carriedEvents = new Map(); // pluginId → Set(key): plugin events kept while the host restarts it
    this.restarting = new Set(); // pluginId: removed for a restart, not yet added back (finishCarried)
    this.warned = new Map(); // `${plugin}|${msg}` → ts
    this.warnRate = new Map(); // plugin → { since, n, dropped } — warnings per minute
    this.confirmTokens = new Map();
    // Plugin actions running right now (offerId → {action, plugin, title, since}) — the verdict
    // "is it safe to shut down" (idle service); action.started event at the start, action on completion.
    this.runningActions = new Map();
    this.hookHandlers = [];
    this.secretsProvider = null;
    this.pluginPolicy = null;
    // Environment variables from core services for trusted plugins (builtin, official and own): AGENTHUB_USAGE_FILE etc.
    this.pluginEnvExtra = new Map();
    this.services = [];
    this.routes = [];
    this.startedAt = Date.now();
    this.factProviders = new Map();
    this.sessionMap = new Map();
    this.pluginMeta = new Map();
    this.host = new PluginHost(this);
    this.facts = this.makeFacts();
    this.sessions = this.makeSessions();
    this.estopState = false;
    this.appPin = null;
    this.settings = new Settings(config.paths.settings || join(config.paths.home, "settings.json"), config.systemLang ? { detect: () => config.systemLang } : {});
    // errors and warnings rendered deep in the libraries (msg, lib/i18n.mjs) follow this hub's language
    this.langSource = () => this.lang();
    setLangSource(this.langSource);
    this.langNow = null;
    // Connections of class app (socket → {pid, startSec, path}) — supervision of the app (app service).
    this.appConns = new Map();
    // Event streams (GET /events) currently open — counted by the server (lib/server.mjs sse).
    this.sseStreams = 0;
    // The daemon is stopping (POST /shutdown or a signal): app supervision no longer intervenes.
    this.stopping = false;
    // What to do on POST /shutdown — set by bin/agenthubd (lib/lifecycle.mjs); tests set their own.
    this.shutdownHandler = null;
    // Switching to another hub version is in progress (hub-update service): the daemon restarts itself with code 75, so
    // POST /shutdown from the departing app does not stop it.
    this.updating = false;
    // A regular shutdown is in progress (SIGTERM, /shutdown — bin/agenthubd, lib/lifecycle.mjs): the hub-update service does not
    // start switching if the shutdown arrived while the app was leaving.
    this.shuttingDown = false;
  }

  // ---------- hub update (lib/services/hub-update.mjs) ----------
  beginUpdate() {
    this.updating = true;
    this.stopping = true;
  }
  abortUpdate() {
    this.updating = false;
    this.stopping = false;
  }

  // ---------- daemon and app lifecycle ----------
  // The server reports connections that got class app, and their closing. Internal bus event app.peer
  // (core.bus, not core.emit: it does not go to SSE) — for the app service: {connected, pid, startSec, path, alive?, count}.
  appPeerUp(socket, peerInfo) {
    if (!socket || this.appConns.has(socket)) return;
    const c = { pid: peerInfo?.pid ?? null, startSec: peerInfo?.startSec ?? null, path: peerInfo?.path ?? null };
    this.appConns.set(socket, c);
    this.bus.emit("app.peer", { type: "app.peer", connected: true, ...c, count: this.appConns.size });
  }
  // A class app connection opened an event stream (GET /events): that is how the real app keeps in touch. Only such a
  // connection clears the supervision stop and sets the fallback restart path (a one-off request does not).
  appPeerStream(socket) {
    const c = this.appConns.get(socket);
    if (!c || c.stream) return;
    c.stream = true;
    this.bus.emit("app.peer", { type: "app.peer", connected: true, ...c, count: this.appConns.size });
  }
  appPeerDown(socket) {
    const c = this.appConns.get(socket);
    if (!c) return;
    this.appConns.delete(socket);
    this.bus.emit("app.peer", { type: "app.peer", connected: false, ...c, alive: this.processAlive(c.pid, c.startSec), count: this.appConns.size });
  }
  appConnections() {
    return [...this.appConns.values()].map((c) => ({ ...c }));
  }
  // Whether the process is alive (with the same start time, if known — the pid may have been reused).
  processAlive(pid, startSec = null) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const sys = this.peer?.sys;
    if (sys?.available && typeof sys.pidInfo === "function") {
      const info = sys.pidInfo(pid);
      return Boolean(info) && (startSec === null || startSec === undefined || info.startSec === startSec);
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e?.code === "EPERM";
    }
  }
  // POST /shutdown (app only): the app quits and asks the daemon to exit cleanly (code 0 — launchd with
  // KeepAlive.SuccessfulExit=false will not restart it). Also recorded in the audit journal.
  markShutdown(peerInfo) {
    const first = !this.stopping;
    this.stopping = true;
    if (first) {
      this.journal.write({ type: "shutdown-requested", peer: peerInfo?.class ?? null, pid: peerInfo?.pid ?? null });
      this.emit({ type: "hub.stopping", reason: "shutdown" });
    }
    return first;
  }
  runShutdown(reason = "shutdown") {
    // the app is leaving for a hub update and asks for /shutdown out of habit: the daemon will restart itself
    if (reason === "shutdown" && this.updating) return;
    const h = this.shutdownHandler;
    if (typeof h === "function") Promise.resolve().then(() => h(reason)).catch(() => {});
  }

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
  // Effective language changed (setting or system language) → plugin labels, event, frame restarts.
  langChanged({ force = false } = {}) {
    const now = this.lang();
    const changed = now !== this.langNow;
    this.langNow = now;
    if (!changed && !force) return;
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
      if (st.trusted !== true || !Array.isArray(st.pushRules)) continue;
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
  // launchAgent — KeepAlive of the daemon job (app service, fact app.launchAgent): "outdated" — a plist from before 2026-11-06 (KeepAlive
  // true), the off setting does not work under it — the shell locks the switch with a hint "agenthub install
  // --apply". No key — not checked (app service off, test directory without test.launchAgent).
  launchAtLoginSetting() {
    let agent = null;
    try {
      agent = this.facts.get("app.launchAgent") ?? null;
    } catch {}
    return agent ? { setting: this.settings.launchAtLogin, launchAgent: agent } : { setting: this.settings.launchAtLogin };
  }
  setLaunchAtLogin(v, peerInfo) {
    this.settings.setLaunchAtLogin(v);
    this.journal.write({ type: "settings-changed", key: "launchAtLogin", value: v, peer: peerInfo?.class, pid: peerInfo?.pid });
    this.emit({ type: "settings.changed", launchAtLogin: v });
    return this.launchAtLoginSetting();
  }
  watchLang() {
    this.langNow = this.lang();
    this.langPoll = setInterval(() => {
      if (this.settings.langSetting === "system") this.langChanged();
    }, 60_000);
    this.langPoll.unref?.();
  }

  // ---------- bus ----------
  emit(event) {
    if (typeof event?.type !== "string" || !/^[\w.:-]{1,64}$/.test(event.type)) return null;
    const ev = { ...event, id: ++this.seq, ts: new Date().toISOString() };
    // For Last-Event-ID replay a plugin event is stored without a state snapshot (it can be large — a frame up to
    // 1 MB, with 500 events): on replay the current plugin state is substituted (eventsSince).
    this.recent.push(ev.type === "plugin" && ev.plugin && typeof ev.plugin.id === "string" ? { ...ev, plugin: undefined, pluginRef: ev.plugin.id } : ev);
    if (this.recent.length > 500) this.recent.shift();
    this.bus.emit("event", ev);
    this.bus.emit(ev.type, ev);
    return ev;
  }
  on(type, fn) {
    this.bus.on(type, fn);
  }
  off(type, fn) {
    this.bus.off(type, fn);
  }
  eventsSince(id) {
    if (!Number.isSafeInteger(id) || id < this.seqBase || id > this.seq) return null;
    const i = this.recent.findIndex((e) => e.id === id + 1);
    if (i < 0) return null;
    const tail = this.recent.slice(i);
    // Each plugin event in a replay already carries the current state, so of several with the same id only
    // the last one is needed: otherwise replay would send N identical full copies (memory and socket write volume).
    const lastFor = new Map();
    tail.forEach((e, k) => e.pluginRef !== undefined && lastFor.set(e.pluginRef, k));
    const out = [];
    for (const [k, e] of tail.entries()) {
      if (e.pluginRef === undefined) {
        out.push(e);
        continue;
      }
      if (lastFor.get(e.pluginRef) !== k) continue;
      const st = this.pluginState(e.pluginRef);
      // the plugin is gone — its plugin.removed comes later in this same tail
      if (!st) continue;
      const { pluginRef, ...rest } = e;
      out.push({ ...rest, plugin: st });
    }
    return out;
  }

  // Warning to the journal: an exact repeat at most once per 10 min; from a single plugin at most
  // WARN_PER_MIN per minute, beyond that a single "suppressed: N" entry when the minute changes (a stream of unique
  // warnings would otherwise push the whole history out of the journal).
  warn(pluginId, text) {
    const key = `${pluginId}|${text}`;
    const now = Date.now();
    if (now - (this.warned.get(key) || 0) < 10 * 60_000) return;
    let r = this.warnRate.get(pluginId);
    if (!r || now - r.since >= 60_000) {
      if (r?.dropped) this.journal.write({ type: "warning", plugin: pluginId, detail: msg("warn.suppressed", { n: r.dropped }), suppressed: r.dropped });
      r = { since: now, n: 0, dropped: 0 };
      this.warnRate.set(pluginId, r);
      if (this.warnRate.size > 1000) this.warnRate.clear();
    }
    if (r.n >= WARN_PER_MIN) {
      r.dropped++;
      return;
    }
    r.n++;
    this.warned.set(key, now);
    if (this.warned.size > 2000) this.warned.clear();
    this.journal.write({ type: "warning", plugin: pluginId, detail: text });
  }

  // ---------- initialization ----------
  async init({ startPlugins = true, startServices = true } = {}) {
    const p = this.config.paths;
    mkdirSync(p.home, { recursive: true, mode: 0o700 });
    chmodSync(p.home, 0o700);
    for (const d of [p.plugins, p.pluginData, p.pluginCache, p.logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
    await this.loadPrimitives(join(DAEMON_DIR, "lib", "primitives"));
    this.watchEstop();
    this.watchAppPin();
    this.watchLang();
    this.journal.write({ type: "start", version: VERSION, pid: process.pid, testMode: this.config.testMode });
    // Services before plugins: the plugin policy (ctx.setPluginPolicy) and the secrets provider must
    // be in effect on the very first scan, not after it.
    if (startServices) await this.startServices(join(DAEMON_DIR, "lib", "services"));
    // all services are subscribed (push is listening): only now does the hub-update service finish an interrupted install
    this.bus.emit("services.started", { type: "services.started" });
    // A change of the app requirement while the daemon was down — after services start: push must hear the event.
    this.appPin.reconcile("start");
    if (startPlugins) await this.host.start();
  }

  async loadPrimitives(dir) {
    const mods = await loadModules(dir, { onError: (f, e) => this.journal.write({ type: "load-error", kind: "primitive", file: f, detail: e.message }) });
    for (const { file, mod } of mods) {
      const err = this.registerPrimitive(mod);
      if (err) this.journal.write({ type: "load-error", kind: "primitive", file, detail: err });
    }
  }

  registerPrimitive(mod) {
    const name = mod?.name;
    if (typeof name !== "string" || !/^[a-z][\w]*(\.[a-zA-Z][\w]*)+$/.test(name)) return msg("err.primitive.name");
    if (!LEVELS.includes(mod.level)) return `${name}: level`;
    if (typeof mod.run !== "function") return `${name}: run`;
    if (this.primitives.has(name)) return msg("err.primitive.dup", { name });
    const appOnly = Boolean(mod.appOnly) || APP_ONLY.test(name);
    this.primitives.set(name, {
      name,
      level: mod.level,
      remoteAllowed: Boolean(mod.remoteAllowed),
      appOnly,
      safeUnderEstop: Boolean(mod.safeUnderEstop) && !appOnly,
      // a deprecated alias of another primitive (cmux.focus → terminal.focus): accepted, marked in /state.primitives
      aliasOf: typeof mod.aliasOf === "string" ? mod.aliasOf : null,
      argsSchema: mod.argsSchema || {},
      verifyFacts: typeof mod.verifyFacts === "function" ? mod.verifyFacts : () => ({ ok: true }),
      describe: typeof mod.describe === "function" ? mod.describe : null,
      run: mod.run,
    });
    return null;
  }

  async startServices(dir) {
    const filter = this.config.servicesFilter;
    if (filter === "none") return;
    const only = filter ? new Set(filter.split(",").map((s) => s.trim())) : null;
    const mods = await loadModules(dir, { onError: (f, e) => this.journal.write({ type: "load-error", kind: "service", file: f, detail: e.message }) });
    for (const { name: fileName, mod } of mods) {
      const name = mod.name || fileName;
      if (only && !only.has(name)) continue;
      if (this.config.services?.[name]?.enabled === false) continue;
      if (typeof mod.start !== "function") continue;
      try {
        const ctx = makeCtx(this, `service:${name}`);
        await mod.start(ctx);
        this.services.push({ name, mod, ctx });
        this.journal.write({ type: "service-start", service: name });
      } catch (e) {
        this.journal.write({ type: "service-error", service: name, detail: e.message });
      }
    }
  }

  async stop({ reason = null } = {}) {
    this.stopping = true;
    releaseLangSource(this.langSource);
    await this.host.stop();
    for (const s of this.services.reverse()) {
      try {
        await s.mod.stop?.(s.ctx);
      } catch {}
    }
    this.services = [];
    this.estopWatcher?.close();
    clearInterval(this.estopPoll);
    clearInterval(this.langPoll);
    this.appPin?.stop();
    this.journal.write({ type: "stop", pid: process.pid, ...(reason ? { reason } : {}) });
  }

  // ---------- ESTOP ----------
  estop() {
    return existsSync(this.config.paths.estop);
  }
  watchEstop() {
    this.estopState = this.estop();
    const check = () => {
      const now = this.estop();
      if (now !== this.estopState) {
        this.estopState = now;
        this.journal.write({ type: "estop", on: now });
        this.emit({ type: "estop", on: now });
        this.estopChanged(now);
      }
    };
    try {
      this.estopWatcher = watch(this.config.paths.home, { persistent: false }, (_e, name) => {
        if (!name || String(name) === "ESTOP") check();
      });
    } catch {}
    this.estopPoll = setInterval(check, 5000);
    this.estopPoll.unref();
  }
  // ---------- pinning the app build (requirements.app) ----------
  // Re-read without a restart; every change goes to the journal, app-pin.changed event, push (lib/app-pin.mjs).
  watchAppPin() {
    this.appPin = new AppPinWatcher({ config: this.config, peer: this.peer, journal: this.journal, emit: (ev) => this.emit(ev) });
    this.appPin.start();
    this.peer?.setBeforeAppCheck?.(() => this.appPin.check("check"));
  }

  // on=true is allowed for any class except foreign/hook/bridge; off — app only (checked by the server).
  setEstop(on, peerInfo) {
    if (on) writeFileSync(this.config.paths.estop, `${new Date().toISOString()} ${peerInfo?.class || "?"}\n`, { mode: 0o600 });
    else rmSync(this.config.paths.estop, { force: true });
    this.journal.write({ type: "estop-set", on, peer: peerInfo?.class, pid: peerInfo?.pid });
    if (this.estopState !== on) {
      this.estopState = on;
      this.emit({ type: "estop", on });
      this.estopChanged(on);
    }
    return on;
  }
  // Hub pause set or cleared (contract 3): plugins get AGENTHUB_PAUSED=0|1 on every run, so
  // they are restarted the same way as on a language change — streamable from scratch, interval ones out of turn — with
  // AGENTHUB_REFRESH_REASON=Paused|Resumed. That way a plugin with deferred background work holds it back while paused.
  estopChanged(on) {
    this.host.restartAll?.(on ? "Paused" : "Resumed");
  }

  // ---------- facts and sessions ----------
  makeFacts() {
    const core = this;
    return Object.freeze({
      estop: () => core.estop(),
      lang: () => core.lang(),
      plugin: (id) => core.plugins.get(id) || null,
      offer: (id) => core.offers.get(id) || null,
      session: (id) => core.sessionMap.get(id) || null,
      sessionByPid: (pid) => [...core.sessionMap.values()].find((s) => s.pid === pid) || null,
      sessions: () => [...core.sessionMap.values()],
      // The Claude process was started by a human (controlling terminal, argv without -p/--print) — see peer.interactiveProcess.
      claudeProcess: (pid) => (core.peer.interactiveProcess ? core.peer.interactiveProcess(pid) : { ok: false, reason: "no-check" }),
      // Live class app connections ([{pid, startSec, path}]) and "the daemon is stopping" — for the app service.
      appConnections: () => core.appConnections(),
      // Open event streams (GET /events) of any class: someone is using the hub (an unpinned copy of the
      // app is class cli). The app service does not exit with "Launch at login" off while there are any.
      eventStreams: () => core.sseStreams,
      stopping: () => core.stopping,
      // Plugin actions running now: [{action, plugin, title, since}] (idle service).
      runningActions: () => core.runningActionList(),
      // Executable path of our own process (proc_pidpath) — the app service uses it to confirm candidates from ps.
      processPath: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.pidPath?.(pid) ?? null) : null),
      // The terminal layer (lib/terminals/_proc.mjs): parent and start time, argv (the tmux server's socket flags) and the
      // controlling terminal of a process — to find which terminal a session runs in and its tab.
      processInfo: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.pidInfo?.(pid) ?? null) : null),
      processArgv: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.procArgv?.(pid) ?? null) : null),
      processTty: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.ttyName?.(pid) ?? null) : null),
      // Runs a terminal's tool for an adapter (tmux, osascript): → Promise<{code, stdout, timedOut}>.
      terminalExec: (file, args, opts) => core.terminalExec(file, args, opts),
      // Whose process has this pid: a running plugin run (standard) or its streamable process. → {id, source, tier,
      // trusted, net} or null. The route that serves plugins (POST /connections/:id/mcp) uses this to identify the
      // plugin by the peer pid on the socket: a plugin's child process is not included, a plugin action only with
      // opts.actions (/terminal/* routes, contract 3: typing into a tab on a human's button press).
      pluginByPid: (pid, opts = {}) => {
        const pl = core.host?.pluginByPid?.(pid, opts);
        if (!pl) return null;
        const trusted = trustedPlugin(pl);
        // terminal — <agenthub.terminal> entries (contract 3): /terminal/* routes check the operation and string against them
        return { id: pl.id, source: pl.source, tier: pl.granted?.tier || null, trusted, net: [...(pl.meta?.net || [])], terminal: [...(pl.meta?.terminal || [])] };
      },
      // Extensions add their own facts: provide("bridge.online", () => ...)
      provide(name, fn) {
        if (core.factProviders.has(name)) throw new Error(msg("err.fact.dup", { name }));
        core.factProviders.set(name, fn);
      },
      get(name, ...args) {
        const fn = core.factProviders.get(name);
        return fn ? fn(...args) : undefined;
      },
    });
  }

  // Session registry: only processes that passed requirements.claudeCode.
  makeSessions() {
    const core = this;
    return Object.freeze({
      get: (id) => core.sessionMap.get(id) || null,
      list: () => [...core.sessionMap.values()],
      // → Promise<{ verified, reason? }>. source — where the info came from ("plugin:<id>", "hook").
      async register(sessionId, { pid, source, ...info } = {}) {
        if (typeof sessionId !== "string" || !sessionId || !Number.isInteger(pid)) return { verified: false, reason: "bad-args" };
        const r = await core.peer.verifySigned(pid, "claudeCode");
        if (!r.ok) {
          core.dropSessionSource(sessionId, source);
          return { verified: false, reason: r.reason };
        }
        const prev = core.sessionMap.get(sessionId);
        if (prev && prev.pid !== pid) {
          // session_id is already held by another process: move it only if that one has exited (or the pid was reused).
          // Otherwise an agent of another session could write this id into its ~/.claude/sessions/<pid>.json and take the session.
          if (await core.boundElsewhere(sessionId, pid)) {
            core.journal.write({ type: "session-rebind-denied", sessionId, pid, boundPid: prev.pid, source: source || null });
            return { verified: false, reason: "bound-elsewhere" };
          }
          core.sessionMap.delete(sessionId);
        }
        const cur = core.sessionMap.get(sessionId) || { sessionId, pid, sources: [], interactive: false };
        const next = { ...cur, ...pick(info), pid, startSec: r.startSec, sources: [...new Set([...cur.sources, source || "unknown"])], updatedAt: Date.now() };
        const changed = JSON.stringify({ ...cur, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 });
        core.sessionMap.set(sessionId, next);
        if (changed) core.emit({ type: "sessions", sessions: core.sessionList() });
        return { verified: true };
      },
      unregister(sessionId, source) {
        core.dropSessionSource(sessionId, source);
      },
      waitingCount: () => core.waitingCount(),
    });
  }
  // session_id in the registry is held by another live process (the same one that registered: start time matches).
  async boundElsewhere(sessionId, pid) {
    const prev = this.sessionMap.get(sessionId);
    if (!prev || prev.pid === pid) return false;
    const was = await this.peer.verifySigned(prev.pid, "claudeCode");
    return !!(was.ok && (prev.startSec == null || was.startSec === prev.startSec));
  }
  dropSessionSource(sessionId, source) {
    const s = this.sessionMap.get(sessionId);
    if (!s) return;
    const sources = s.sources.filter((x) => x !== source);
    if (sources.length) this.sessionMap.set(sessionId, { ...s, sources });
    else this.sessionMap.delete(sessionId);
    this.emit({ type: "sessions", sessions: this.sessionList() });
  }
  // Registry entries for display and plugins; terminal, focusable and terminalInfo — the tab found by the terminal layer
  // (focusable: the adapter can switch to it — the "Go to" button via session.focus; terminalInfo: the adapter, its label and
  // capabilities). Computed on every call, not written to the registry.
  sessionList() {
    return [...this.sessionMap.values()].map((s) => {
      let tab = { terminal: null, focusable: false, terminalInfo: null };
      try {
        if (this.facts) tab = tabOf(s, this.facts);
      } catch {}
      return { ...s, ...tab };
    });
  }
  waitingCount() {
    let n = 0;
    for (const s of this.sessionMap.values()) if (s.status === "waiting") n++;
    return n;
  }

  // ---------- plugin policy ----------
  setPluginPolicy(fn) {
    this.pluginPolicy = fn;
  }
  setSecretsProvider(fn) {
    this.secretsProvider = fn;
  }
  // → { allowed, effects: [...], actions: bool, official: bool, tier, reason? }
  // tier: builtin — the app's directory; local — Plugins/local; installed — official or community, and
  // official only if the manager's policy said so (a plugins.lock entry from the signed registry index).
  // Plugin metadata does not affect the tier. Actions (<agenthub.action>) — only builtin, official and own (own is
  // a plugins.lock entry the manager made after a human's consent; see plugins.mjs ownTrusted).
  async policyFor(pl) {
    const declared = pl.meta.effects;
    const ceiling = pl.source === "builtin" ? null : pl.source === "local" ? LOCAL_EFFECTS : THIRD_PARTY_EFFECTS;
    const under = (e) => !ceiling || ceiling.includes(e) || effectAllowed(e.replace(/\.\*$/, ".x"), ceiling);
    const baseTier = pl.source === "builtin" ? "builtin" : pl.source === "local" ? "local" : "community";
    let res = { allowed: true, effects: declared.filter(under), actions: pl.source === "builtin", official: false, tier: baseTier };
    // Installed plugins are admitted only by the manager (plugins.lock, sha256, consent, quarantine). No policy —
    // the plugins service is off, not started due to the AGENTHUB_SERVICES filter, or crashed at startup — closed, not open:
    // otherwise any Plugins/<id> directory would pass as community without checks and get <id>.* keys from the keychain.
    if (!this.pluginPolicy && pl.source === "installed") return { allowed: false, reason: "policy:no-manager" };
    if (this.pluginPolicy) {
      try {
        const over = await this.pluginPolicy(pl, res);
        if (over) {
          res = { ...res, ...over };
          // the policy cannot raise the ceiling for third-party plugins
          res.effects = (res.effects || []).filter(under);
          if (pl.source !== "builtin") {
            const official = pl.source === "installed" && (over.tier === "official" || (over.tier === undefined && over.official === true));
            // own — only installed by the manager (Plugins/<id>, plugins.lock); Plugins/local is never own
            const own = pl.source === "installed" && !official && over.tier === "own";
            res.tier = pl.source === "local" ? "local" : official ? "official" : own ? "own" : "community";
            res.official = official;
            res.actions = (official || own) && (pl.meta.actions || []).length > 0;
          } else {
            res.tier = "builtin";
            res.official = false;
          }
        }
      } catch (e) {
        res = { allowed: false, reason: `policy: ${e.message}` };
      }
    }
    return res;
  }
  // A core service gives trusted plugins an environment variable (a path to its cache). value null — remove.
  // Name is AGENTHUB_<NAME>, not among those reserved by the core (buildEnv). Already running plugins see it from their next run.
  setPluginEnv(name, value) {
    if (!PLUGIN_ENV_RE.test(String(name)) || RESERVED_PLUGIN_ENV.has(name)) throw new Error(msg("err.pluginEnv.name", { name }));
    if (value === null || value === undefined) this.pluginEnvExtra.delete(name);
    else this.pluginEnvExtra.set(name, String(value));
  }
  // → { NAME: value } for this plugin: only builtin, official and own (per policy, not per metadata).
  // A trusted plugin always gets AGENTHUB_HUB_SOCKET (the hub socket path, not a secret) (contract 3): through the socket it
  // calls both /connections/:id/mcp (oauth service) and /terminal/* (terminal service) — the variable does not depend on
  // which of the services is enabled.
  pluginEnvFor(pl) {
    if (!trustedPlugin(pl)) return {};
    return { ...(this.config.paths?.socket ? { AGENTHUB_HUB_SOCKET: this.config.paths.socket } : {}), ...Object.fromEntries(this.pluginEnvExtra) };
  }
  async secretsFor(pl) {
    if (!pl.meta.secrets.length || !this.secretsProvider) return {};
    const out = {};
    for (const entry of pl.meta.secrets) {
      const key = entry.split(/\s+[—–-]{1,2}\s+/)[0].trim();
      try {
        const v = await this.secretsProvider(pl.id, key, pl);
        if (typeof v === "string") out[key] = v;
      } catch {}
    }
    return out;
  }

  // ---------- plugin state ----------
  pluginAdded(pl) {
    this.plugins.set(pl.id, {
      id: pl.id,
      source: pl.source,
      tier: pl.granted?.tier || (pl.source === "builtin" ? "builtin" : pl.source === "local" ? "local" : "community"),
      trusted: trustedPlugin(pl),
      official: pl.granted?.official === true,
      file: pl.file,
      type: pl.meta.type,
      title: pl.meta.title || pl.id,
      desc: pl.meta.desc || null,
      version: pl.meta.version,
      // author from metadata (<agenthub.author.name>, <agenthub.author.github>): the name is shown first
      author: cleanAuthor(pl.meta.author),
      interval: pl.interval,
      schedule: pl.meta.schedule,
      effects: pl.granted.effects,
      actions: pl.granted.actions ? pl.meta.actions.map((a) => ({ id: a.id, level: actionLevel(pl, a), title: a.title, arg: a.arg ? { ...a.arg } : null })) : [],
      // Push rules from <agenthub.push> — only for trusted plugins (builtin, official and own).
      pushRules: trustedPlugin(pl) ? (pl.meta.push || []).map(({ wasDeclared, ...r }) => ({ ...r })) : [],
      // Contract 2: icon (<agenthub.icon>; none — the shell draws a neutral one), minimum contract version
      // (1 — not declared), connections (<agenthub.connection>, trusted only; the oauth service handles sign-in).
      icon: pl.meta.icon ? { ...pl.meta.icon } : null,
      contract: pl.meta.contract || 1,
      connections: [],
      status: "unknown",
      header: [],
      body: [],
      events: [],
      // activity= / needsOn= of the header (the "is it safe to shut down" verdict, lib/idle.mjs): null — the plugin does not report,
      // [] — reports that all is quiet, otherwise phrases
      activity: null,
      needsOn: null,
      lastRunAt: null,
      durationMs: null,
      error: null,
      pid: null,
    });
    this.pluginMeta.set(pl.id, pl);
    this.restarting.delete(pl.id);
    const carried = this.carriedEvents.get(pl.id);
    if (carried) {
      this.carriedEvents.delete(pl.id);
      this.activeEvents.set(pl.id, carried);
      this.plugins.get(pl.id).events = [...carried];
    }
    const conns = pluginConnections(pl);
    for (const r of conns.rejected) this.journal.write({ type: "connection-rejected", plugin: pl.id, connection: r.id, why: r.why });
    this.plugins.get(pl.id).connections = conns.list.map((c) => ({ id: c.id, title: c.title || null, note: c.note || null, url: c.url, host: c.host, hosts: c.hosts, scope: c.scope, tools: c.tools, intervalMs: c.intervalMs, budget: c.budget, tier: c.tier }));
    if (pl.meta.contract && pl.meta.contract > CONTRACT_VERSION) this.journal.write({ type: "plugin-contract-newer", plugin: pl.id, need: pl.meta.contract, have: CONTRACT_VERSION });
    this.localizePlugin(pl.id, { emit: false });
    this.journal.write({ type: "plugin-add", plugin: pl.id, source: pl.source });
    this.emitPlugin(pl.id);
    this.pinLegacyToggles(pl.id);
  }
  // Plugin labels from metadata — in the effective language (the lang="xx" variant or as is).
  localizePlugin(id, { emit = true } = {}) {
    const st = this.plugins.get(id);
    const pl = this.pluginMeta.get(id);
    if (!st || !pl) return;
    const lang = this.lang();
    const i18n = pl.meta.i18n || {};
    st.title = pickLang(pl.meta.title || pl.id, i18n, "title", lang);
    st.desc = pickLang(pl.meta.desc || null, i18n, "desc", lang);
    st.lang = lang;
    const labels = {};
    for (const [k, v] of Object.entries(pl.meta.statuses || {})) labels[k] = { ...v, ...(i18n[lang]?.statuses?.[k] || {}) };
    for (const [k, v] of Object.entries(i18n[lang]?.statuses || {})) labels[k] ||= v;
    st.statusLabels = labels;
    for (const a of st.actions) {
      const src = pl.meta.actions.find((x) => x.id === a.id);
      if (src) a.title = pickLang(src.title, src.i18n, "title", lang);
    }
    st.pushRules = st.pushRules.map((r) => ({ ...r, label: r.labels?.[lang] || (pl.meta.push || []).find((x) => x.key === r.key)?.label || r.label }));
    // connection name and description — in the hub language (a tag with lang="xx" and the same id)
    for (const c of st.connections || []) {
      const src = (pl.meta.connections || []).find((x) => (x.id || pl.id) === c.id);
      const tr = i18n[lang]?.connections?.[src?.id || ""] || {};
      c.title = tr.title || src?.title || null;
      c.note = tr.note || src?.note || null;
    }
    if (emit) this.emitPlugin(id);
  }
  // keepEvents — the host restarts the plugin with the same id (the file or the policy changed): raised events are not
  // cleared but carried over to the new instance (pluginAdded), and its first frame reconciles them as usual. Otherwise every
  // restart would clear and re-raise "session is waiting" and the like — and push would be sent again. If it is not added
  // back (the policy rejected it), finishCarried clears them.
  pluginRemoved(id, { keepEvents = false } = {}) {
    this.clearOffers(id);
    // restart (the same id is still on disk): services must not treat it as removal (the oauth service does not abort
    // an ongoing sign-in and does not reset its cache); if it is not added back, finishCarried reports plugin.removed without restart
    if (keepEvents) this.restarting.add(id);
    else this.restarting.delete(id);
    if (keepEvents && this.activeEvents.has(id)) {
      this.carriedEvents.set(id, this.activeEvents.get(id));
      this.activeEvents.delete(id);
    } else this.setEvents(id, []);
    this.plugins.delete(id);
    this.pluginMeta?.delete(id);
    for (const s of [...this.sessionMap.values()]) if (s.sources.includes(`plugin:${id}`)) this.dropSessionSource(s.sessionId, `plugin:${id}`);
    this.journal.write({ type: "plugin-remove", plugin: id });
    this.emit({ type: "plugin.removed", plugin: id, ...(keepEvents ? { restart: true } : {}) });
  }
  // Events of restarted plugins that the host never added back — clear them.
  finishCarried() {
    for (const [id, keys] of [...this.carriedEvents]) {
      this.carriedEvents.delete(id);
      this.activeEvents.set(id, keys);
      this.setEvents(id, []);
    }
    // the restart did not happen (the policy rejected it, the file disappeared) — now this is a removal
    for (const id of [...this.restarting]) {
      this.restarting.delete(id);
      if (!this.plugins.has(id)) this.emit({ type: "plugin.removed", plugin: id });
    }
  }
  pluginStarted(id, pid) {
    const st = this.plugins.get(id);
    if (st) st.pid = pid;
  }
  pluginExited(id, { code, signal, error }) {
    const st = this.plugins.get(id);
    if (!st) return;
    st.pid = null;
    this.journal.write({ type: "plugin-exit", plugin: id, code, signal, error });
    this.pluginFailed(id, error || `exit ${code ?? signal}`);
  }
  pluginFailed(id, reason) {
    const st = this.plugins.get(id);
    if (!st) return;
    st.status = "error";
    st.error = String(reason).slice(0, 200);
    st.lastRunAt = new Date().toISOString();
    // Known plugin events are not cleared: a process failure is not a new state of the source. Otherwise every
    // streamable restart or timeout would clear and re-raise, for example, "session is waiting" and "spoofing
    // marker", and push would be sent again. The next successful frame clears them.
    this.setEvents(id, [...(this.activeEvents.get(id) || []), "plugin-error"], { status: "error" });
    this.emitPlugin(id);
  }
  pluginState(id) {
    const st = this.plugins.get(id);
    return st ? structuredClone(st) : null;
  }
  pluginStates() {
    return [...this.plugins.values()].map((s) => structuredClone(s));
  }
  // Info for the event text (push service) — without a copy of the whole state: title, trust, error, own
  // push rules and the title of the row with event=<key>. → null if there is no such plugin.
  pluginEventInfo(id, key) {
    const st = this.plugins.get(id);
    if (!st) return null;
    let itemTitle = null;
    for (const list of [st.header, st.body]) {
      const it = (list || []).find((i) => i && i.event === key);
      if (it) {
        itemTitle = it.title || null;
        break;
      }
    }
    return {
      id: st.id,
      title: st.title,
      trusted: st.trusted === true,
      error: st.error,
      itemTitle,
      pushRules: st.trusted === true && Array.isArray(st.pushRules) ? st.pushRules.map((r) => ({ ...r })) : null,
    };
  }
  worstStatus() {
    return worstStatus([...this.plugins.values()].map((s) => s.status));
  }
  // What plugins report for the "is it safe to shut down" verdict (lib/idle.mjs) — without copying frames.
  // trusted — phrases of a builtin or official plugin (without the name prefix, fit for a card title);
  // type, intervalMs, lastRunAt, signalsAt — to notice a plugin that went silent (lib/idle.mjs, stale).
  pluginSignals() {
    return [...this.plugins.values()].map((s) => {
      const meta = this.pluginMeta?.get(s.id);
      return {
        id: s.id,
        title: s.title,
        tier: s.tier,
        trusted: s.trusted === true,
        status: s.status,
        type: s.type || "standard",
        intervalMs: meta && !meta.meta?.schedule && Number.isFinite(meta.intervalMs) ? Math.max(meta.intervalMs, this.config.plugins?.minIntervalMs || 0) : null,
        lastRunAt: s.lastRunAt ? Date.parse(s.lastRunAt) : null,
        signalsAt: s._signalsAt ?? null,
        activity: s.activity ? [...s.activity] : null,
        needsOn: s.needsOn ? [...s.needsOn] : null,
        // failure of the plugin itself (exit ≠ 0, timeout, empty output); null — the plugin ran, even if status=error
        // (that is a domain error like "a task failed", not "the plugin is broken")
        error: s.error ?? null,
        // what the plugin itself says about its fault: a top-level line with status=unknown/error or
        // event=source-broken, otherwise the first header line (for "Don't know about sessions: …")
        why: pluginWhy(s),
      };
    });
  }
  // Plugin actions running now (POST /actions/:id → runAction): [{action, plugin, title, since}].
  runningActionList() {
    return [...this.runningActions.values()].map((a) => ({ ...a }));
  }
  emitPlugin(id) {
    const st = this.plugins.get(id);
    if (!st) return;
    const sig = sha(JSON.stringify({ ...st, lastRunAt: null, durationMs: null }));
    if (st._sig === sig) return;
    Object.defineProperty(st, "_sig", { value: sig, enumerable: false, writable: true, configurable: true });
    this.emit({ type: "plugin", plugin: this.pluginState(id), status: this.worstStatus() });
  }

  // Result of a standard run.
  applyRun(id, r) {
    if (r.timedOut) return this.pluginFailed(id, "timeout");
    if (r.overflow) return this.pluginFailed(id, "output-too-large");
    if (r.error) return this.pluginFailed(id, r.error);
    // killed by a signal (SIGSEGV, SIGABRT, SIGKILL from the system): a fragment of output is not a state of the source
    if (r.code === null && r.signal) return this.pluginFailed(id, `signal ${r.signal}`);
    this.applyFrame(id, r.stdout, { exitCode: r.code, durationMs: r.durationMs });
  }

  // Plugin output frame → state.
  applyFrame(id, text, { exitCode = 0, durationMs = null, overflow = false } = {}) {
    const st = this.plugins.get(id);
    const pl = this.pluginMeta?.get(id);
    if (!st || !pl) return;
    const parsed = parseOutput(text);
    for (const w of parsed.warnings) this.warn(id, w);
    if (overflow) this.warn(id, msg("warn.frame.cut"));
    this.clearOffers(id);
    const offers = new Set();
    const sessionsSeen = new Set();
    const mapItem = (item) => {
      const out = { title: item.title, level: item.level, params: item.params };
      if (item.separator) out.separator = true;
      if (item.status) out.status = item.status;
      if (item.event) out.event = item.event;
      const offer = this.makeOffer(pl, st, item);
      if (offer) {
        offers.add(offer.id);
        out.offer = { id: offer.id, kind: offer.kind, primitive: offer.primitive || null, action: offer.action?.id || null, level: offer.level, label: offer.label, ...(offer.appOnly ? { appOnly: true } : {}) };
      }
      if (item.params.session && item.params.pid) {
        const pid = Number(item.params.pid);
        const sid = String(item.params.session);
        sessionsSeen.add(sid);
        const known = this.sessionMap.get(sid);
        out.session = { id: sid, pid, verified: known && known.pid === pid ? true : null };
        // Only trusted plugins write to the shared session registry (status, tab, name — what cards are dismissed by and where "Go to
        // tab" leads): builtin, official and own. A session line from community and local is
        // only a signature check mark in their own frame.
        if (st.trusted) this.noteSession(id, sid, pid, item.params);
        else this.markSession(id, sid, pid);
      }
      return out;
    };
    st.header = parsed.header.map(mapItem);
    st.body = parsed.body.map(mapItem);
    // activity= / needsOn=: an empty frame with an error (exit ≠ 0 with no output) is not a new state of the source: the last
    // known phrases stay (as with pluginFailed), and the verdict shows them as "failure — last: …" (lib/idle.mjs).
    // Otherwise a plugin that reported "run at 04:30" would silently drop out of the check and the card would turn green.
    if (!(parsed.empty && exitCode !== 0 && exitCode !== null)) {
      st.activity = parsed.activity ?? null;
      st.needsOn = parsed.needsOn ?? null;
      // when the phrases last arrived — "(HH:MM)" in the "not responding — last: …" line; not in the plugin state
      // (otherwise every frame would change the label and broadcast plugin)
      Object.defineProperty(st, "_signalsAt", { value: Date.now(), enumerable: false, writable: true, configurable: true });
    }
    let status = parsed.status;
    if (exitCode !== 0 && exitCode !== null) status = "error";
    st.status = status;
    st.error = exitCode !== 0 && exitCode !== null ? `exit ${exitCode}` : parsed.empty ? "empty-output" : null;
    st.lastRunAt = new Date().toISOString();
    st.durationMs = durationMs;
    this.pluginOffers.set(id, offers);
    // sessions that disappeared from the plugin output
    for (const s of [...this.sessionMap.values()]) {
      if (s.sources.includes(`plugin:${id}`) && !sessionsSeen.has(s.sessionId)) this.dropSessionSource(s.sessionId, `plugin:${id}`);
    }
    const events = exitCode !== 0 && exitCode !== null ? [...parsed.events, "plugin-error"] : parsed.events;
    this.setEvents(id, events, { status });
    this.emitPlugin(id);
  }

  noteSession(pluginId, sessionId, pid, params) {
    // All fields always (null = no value in this frame), see pick().
    const info = {
      status: params.sessionStatus || null,
      waitingFor: params.waitingFor || null,
      name: params.sessionName || null,
      // where the name came from (sessionNameSource=, contract 3): auto — a title from the conversation, it is not in the session metadata file
      nameSource: /^[a-z][a-z-]{0,19}$/.test(params.sessionNameSource || "") ? params.sessionNameSource : null,
      cwd: params.sessionCwd || null,
      surfaceId: params.surfaceId || null,
      workspaceId: params.workspaceId || null,
      kind: params.sessionKind || null,
      // effort of the last turn (from the transcript, claude-sessions plugin): only known levels
      effort: EFFORT_LEVELS.includes(params.sessionEffort) ? params.sessionEffort : null,
      ultracode: params.sessionUltracode === "true" ? true : params.sessionUltracode === "false" ? false : null,
      // contract 3: model, where model and effort came from (a turn or a /model, /effort command after it) and the time of the transcript
      // record they came from — for the session metadata file (sessions service, AGENTHUB_CLAUDE_SESSIONS_FILE)
      model: SESSION_MODEL_RE.test(params.sessionModel || "") ? params.sessionModel : null,
      modelSource: SESSION_META_SOURCES.includes(params.sessionModelSource) ? params.sessionModelSource : null,
      effortSource: SESSION_META_SOURCES.includes(params.sessionEffortSource) ? params.sessionEffortSource : null,
      metaAt: isoTime(params.sessionAt),
      source: `plugin:${pluginId}`,
    };
    this.sessions
      .register(sessionId, { pid, ...info })
      .then((r) => this.applySessionMark(pluginId, sessionId, pid, r))
      .catch(() => {});
  }

  // Checking the session pid signature without writing to the registry (session lines of untrusted plugins). Same rejections as
  // register: the pid signature and "id already held by another live process" — the line cannot pass itself off as another session. Not
  // written to the journal (this is not a move attempt but a mark in a frame that repeats on every run).
  markSession(pluginId, sessionId, pid) {
    const check = async () => {
      if (!Number.isInteger(pid)) return { verified: false, reason: "bad-args" };
      const v = await this.peer.verifySigned(pid, "claudeCode");
      if (!v.ok) return { verified: false, reason: v.reason };
      if (await this.boundElsewhere(sessionId, pid)) return { verified: false, reason: "bound-elsewhere" };
      return { verified: true };
    };
    check()
      .then((r) => this.applySessionMark(pluginId, sessionId, pid, r))
      .catch(() => {});
  }
  applySessionMark(pluginId, sessionId, pid, r) {
    const st = this.plugins.get(pluginId);
    if (!st) return;
    let changed = false;
    for (const it of [...st.header, ...st.body]) {
      if (it.session && it.session.id === sessionId && it.session.pid === pid && it.session.verified !== r.verified) {
        it.session.verified = r.verified;
        if (!r.verified) it.session.label = sessionLabel(r.reason, this.lang());
        changed = true;
      }
    }
    if (changed) this.emitPlugin(pluginId);
  }

  setEvents(pluginId, keys, { status } = {}) {
    const prev = this.activeEvents.get(pluginId) || new Set();
    const next = new Set(keys);
    for (const k of next) if (!prev.has(k)) this.emit({ type: "event.raised", plugin: pluginId, key: `${pluginId}:${k}`, status: status || null });
    for (const k of prev) if (!next.has(k)) this.emit({ type: "event.cleared", plugin: pluginId, key: `${pluginId}:${k}` });
    if (next.size) this.activeEvents.set(pluginId, next);
    else this.activeEvents.delete(pluginId);
    const st = this.plugins.get(pluginId);
    if (st) st.events = [...next];
  }

  clearOffers(pluginId) {
    for (const oid of this.pluginOffers.get(pluginId) || []) this.offers.delete(oid);
    this.pluginOffers.delete(pluginId);
  }

  // Plugin offer (effect=, action=, href=) → an entry in the offer registry or null.
  makeOffer(pl, st, item) {
    let spec = null;
    if (item.action) {
      if (!st.actions.length) {
        this.warn(pl.id, msg("warn.action.unavailable", { action: item.action, source: pl.source }));
        return null;
      }
      const action = pl.meta.actions.find((a) => a.id === item.action);
      if (!action) {
        this.warn(pl.id, msg("warn.action.undeclared", { action: item.action }));
        return null;
      }
      const raw = item.params.arg;
      let args;
      if (action.arg) {
        const v = checkActionArg(action.arg, raw);
        if (v.error) {
          this.warn(pl.id, `action=${item.action}: arg ${v.error}`);
          return null;
        }
        args = { [action.arg.name]: v.value };
      } else if (raw !== undefined) {
        this.warn(pl.id, msg("warn.action.argUndeclared", { action: item.action }));
        return null;
      }
      const shown = args ? ` ${Object.values(args)[0]}` : "";
      const title = pickLang(action.title, action.i18n, "title", this.lang());
      spec = { kind: "action", action, args, level: actionLevel(pl, action), appOnly: actionAppOnly(pl), fp: actionFingerprint(pl, st.tier, action), label: title ? `${title}${shown}` : `${t(this.lang(), "action.label", { command: action.command })}${shown}` };
    } else {
      let primitive;
      let tokens;
      if (item.effect) {
        const e = parseEffectSpec(item.effect);
        if (!e) {
          this.warn(pl.id, msg("warn.effect.parse", { effect: item.effect.slice(0, 60) }));
          return null;
        }
        ({ primitive, tokens } = e);
        if (!effectAllowed(primitive, st.effects)) {
          this.warn(pl.id, msg("warn.effect.denied", { primitive }));
          return null;
        }
      } else if (item.href) {
        primitive = "open.url";
        tokens = [item.href];
      } else return null;
      const prim = this.primitives.get(primitive);
      if (!prim) {
        this.warn(pl.id, msg("warn.effect.noPrimitive", { primitive }));
        return null;
      }
      const t = argsFromTokens(prim.argsSchema, tokens);
      if (t.error) {
        this.warn(pl.id, `${primitive}: ${t.error}`);
        return null;
      }
      const v = validateArgs(prim.argsSchema, t.args, { coerce: true });
      if (v.error) {
        this.warn(pl.id, `${primitive}: ${v.error}`);
        return null;
      }
      let label = primitive;
      try {
        label = prim.describe?.(v.args, this.facts, this.lang())?.text || primitive;
      } catch {}
      spec = { kind: "effect", primitive, args: v.args, level: prim.level, label };
    }
    const id = sha(`${pl.id}|${spec.kind}|${spec.primitive || spec.action.id}|${JSON.stringify(spec.args || {})}`).slice(0, 16);
    const offer = { id, pluginId: pl.id, ...spec };
    this.offers.set(id, offer);
    return offer;
  }

  // ---------- running an action ----------
  // req: { id, args?, confirmToken?, peer } → { status, body }
  async invoke({ id, args = undefined, confirmToken = null, peer: peerInfo }) {
    const started = Date.now();
    const cls = peerInfo?.class || "cli";
    const deny = (status, error, extra = {}) => {
      this.journal.write({ type: "action-denied", action: id, peer: cls, pid: peerInfo?.pid, error });
      return { status, body: { error, ...extra } };
    };
    // 1. target
    let target = null;
    const offer = this.offers.get(id);
    if (offer) {
      // an action of a non-builtin plugin — only from the app, even immediate (official without a confirmation window):
      // it can be pressed by a human in the shell, not by cli and not by an agent
      if (offer.kind === "action") target = { kind: "action", offer, args: offer.args, level: offer.level, appOnly: offer.appOnly === true, safeUnderEstop: false, label: offer.label };
      else {
        const prim = this.primitives.get(offer.primitive);
        if (!prim) return deny(404, "not-found");
        target = { kind: "effect", offer, prim, args: offer.args, level: prim.level, appOnly: prim.appOnly, safeUnderEstop: prim.safeUnderEstop };
      }
    } else if (this.primitives.has(id)) {
      // arguments are checked after the peer class and the hub pause (order per docs/api.md): cli with an empty body
      // on an app-only primitive gets 403 peer:cli, not 400 args:…
      const prim = this.primitives.get(id);
      target = { kind: "primitive", prim, args: null, rawArgs: args ?? {}, level: prim.level, appOnly: prim.appOnly, safeUnderEstop: prim.safeUnderEstop };
    } else return deny(404, "not-found");

    // 2. peer
    if (cls === "foreign") return deny(403, "peer:uid");
    if (cls !== "app" && cls !== "cli") return deny(403, `peer:${cls}`);
    const needApp = target.appOnly || target.level !== "immediate";
    if (needApp && cls !== "app") return deny(403, peerInfo?.reason && peerInfo.reason !== "peer:no-claude-ancestor" ? peerInfo.reason : `peer:${cls}`, { peer: cls });
    if (target.kind === "effect" && offer && !this.plugins.has(offer.pluginId)) return deny(404, "not-found");

    // 3. ESTOP
    if (this.estop() && !target.safeUnderEstop) return deny(423, "estop");

    // 3a. arguments of a direct primitive call
    if (target.kind === "primitive") {
      const v = validateArgs(target.prim.argsSchema, target.rawArgs);
      if (v.error) return deny(400, v.error);
      target.args = v.args;
      delete target.rawArgs;
    }

    // 4. checking against facts
    // A plugin action is checked against the current metadata of its file on disk (not a snapshot from the offer): the file may have been
    // replaced or updated while the offer and the confirmation window were alive. Argument pattern fails —
    // facts:bad-arg; command, level, pattern, version or plugin tier changed — facts:action-changed.
    if (target.kind === "action") {
      const cur = this.currentAction(offer);
      if (!cur) return deny(409, "facts:action-changed");
      if (cur.action.arg) {
        const v = checkActionArg(cur.action.arg, target.args?.[cur.action.arg.name]);
        if (v.error) return deny(409, "facts:bad-arg");
        target.argValue = v.value;
      } else if (target.args && Object.keys(target.args).length) return deny(409, "facts:bad-arg");
      if (cur.fp !== offer.fp) return deny(409, "facts:action-changed");
      target.action = cur.action;
      target.level = cur.level;
      target.fp = cur.fp;
    }
    if (target.prim) {
      let f;
      try {
        f = await target.prim.verifyFacts(target.args, this.facts, { peer: peerInfo, plugin: offer?.pluginId ?? null, config: this.config });
      } catch (e) {
        f = { ok: false, reason: "verify-error" };
      }
      if (!f?.ok) return deny(409, `facts:${f?.reason || "rejected"}`);
    }

    // 5. confirmation (the core decides; the core writes the text). The token key includes the action fingerprint: a token issued
    // for the text of one version of a command will not execute another.
    const key = sha(`${id}|${target.fp || ""}|${JSON.stringify(target.args || {})}`);
    if (target.level !== "immediate") {
      if (!confirmToken) {
        const token = randomBytes(16).toString("hex");
        const d = this.describeTarget(target);
        this.confirmTokens.set(token, { key, expires: Date.now() + CONFIRM_TTL_MS, pid: peerInfo?.pid ?? null });
        for (const [t, v] of this.confirmTokens) if (v.expires < Date.now()) this.confirmTokens.delete(t);
        // what exactly was asked: plugin and action (the offer id is a hash, a human learns nothing from it)
        const askedTitle = target.kind === "action" ? pickLang((target.action || target.offer?.action)?.title, (target.action || target.offer?.action)?.i18n, "title", this.lang()) : null;
        this.journal.write({ type: "action-confirm-requested", action: id, plugin: offer?.pluginId ?? null, actionId: target.offer?.action?.id ?? null, primitive: target.prim?.name ?? null, title: askedTitle ? String(askedTitle).slice(0, 80) : null, peer: cls, pid: peerInfo?.pid });
        return { status: 428, body: { error: "confirm-required", needsConfirm: true, token, level: target.level, text: d.text, cost: d.cost ?? null, expiresInMs: CONFIRM_TTL_MS } };
      }
      const t = this.confirmTokens.get(confirmToken);
      this.confirmTokens.delete(confirmToken);
      if (!t || t.key !== key || t.expires < Date.now() || (t.pid !== null && t.pid !== (peerInfo?.pid ?? null))) return deny(403, "confirm:invalid");
    }

    // 6. execution. Hub pause — once more: there were waits between step 3 and here (verifyFacts, the
    // confirmation window is already behind, but the fact check is asynchronous).
    if (this.estop() && !target.safeUnderEstop) return deny(423, "estop");
    let result;
    try {
      if (target.kind === "action") {
        const inst = this.host.get(target.offer.pluginId);
        if (!inst) return deny(404, "not-found");
        const runKey = `${id}:${started}`;
        const title = this.plugins.get(target.offer.pluginId)?.actions?.find((a) => a.id === target.action.id)?.title || target.action.id;
        this.runningActions.set(runKey, { action: target.action.id, plugin: target.offer.pluginId, title: String(title).slice(0, 200), since: new Date(started).toISOString() });
        this.emit({ type: "action.started", action: id, plugin: target.offer.pluginId, actionId: target.action.id });
        // action and argument — already checked against the current metadata (step 4)
        try {
          result = await inst.runAction(target.action, target.action.arg ? target.argValue : null);
        } finally {
          this.runningActions.delete(runKey);
        }
      } else {
        const ctx = { ...makeCtx(this, `primitive:${target.prim.name}`), requester: { ...peerInfo }, plugin: offer?.pluginId || null };
        result = (await target.prim.run(target.args, ctx)) || { ok: true };
      }
    } catch (e) {
      result = { ok: false, error: "run-error" };
    }
    const safe = {};
    for (const [k, v] of Object.entries(result || {})) if (v === null || ["string", "number", "boolean"].includes(typeof v)) safe[k] = typeof v === "string" ? v.slice(0, 200) : v;
    this.journal.write({
      type: "action",
      action: id,
      kind: target.kind,
      primitive: target.prim?.name,
      actionId: target.offer?.action?.id,
      plugin: offer?.pluginId,
      peer: cls,
      pid: peerInfo?.pid,
      ok: Boolean(safe.ok),
      code: safe.code,
      ms: Date.now() - started,
    });
    this.emit({ type: "action", action: id, ok: Boolean(safe.ok), plugin: offer?.pluginId || null, primitive: target.prim?.name || null });
    if (offer) {
      const pst = this.plugins.get(offer.pluginId);
      if (pst?.type === "streamable") this.host.send(offer.pluginId, { type: "actionResult", id, actionId: offer.action?.id || null, primitive: offer.primitive || null, ok: Boolean(safe.ok), code: safe.code ?? null });
      else this.host.refresh(offer.pluginId, "MenuAction");
    }
    return { status: 200, body: { ok: Boolean(safe.ok), result: safe } };
  }

  // The offer's action per the current plugin file. → { action, level, fp } | null (the plugin, the action or the right
  // to actions is gone, the file cannot be read).
  currentAction(offer) {
    const pl = this.pluginMeta.get(offer.pluginId);
    const st = this.plugins.get(offer.pluginId);
    if (!pl || !st || !st.actions.length) return null;
    let fresh;
    try {
      fresh = readPluginMeta(pl.file);
    } catch {
      return null;
    }
    if (!fresh) return null;
    const now = { ...pl, meta: fresh.meta };
    const action = fresh.meta.actions.find((a) => a.id === offer.action.id);
    if (!action) return null;
    return { action, level: actionLevel(now, action), fp: actionFingerprint(now, st.tier, action) };
  }

  // The core builds the confirmation text in the effective language; the plugin author's words are quoted and marked.
  describeTarget(target) {
    const lang = this.lang();
    if (target.kind === "action") {
      const a = target.action || target.offer.action;
      const pl = this.pluginMeta.get(target.offer.pluginId);
      const parts = [];
      if (target.level === "confirm-cost") {
        const net = (pl?.meta?.net || []).map((n) => String(n).split(/\s+[—–-]{1,2}\s+/)[0].trim()).filter(Boolean);
        parts.push(net.length ? t(lang, "cost.net", { hosts: net.slice(0, 3).join(", ") }) : t(lang, "cost.generic"));
      }
      // builtin plugin — our code, its words about cost are shown as is
      const cost = pickLang(a.cost, a.i18n, "cost", lang);
      if (cost) parts.push(pl?.source === "builtin" ? String(cost).slice(0, 200) : t(lang, "cost.pluginSays", { text: String(cost).slice(0, 200) }));
      const st = this.plugins.get(target.offer.pluginId);
      const tier = st?.tier ? t(lang, `tier.${st.tier}`) : "?";
      const arg = a.arg ? String(target.args?.[a.arg.name] ?? "") : "";
      const title = pickLang(a.title, a.i18n, "title", lang);
      const plugin = st?.title || target.offer.pluginId;
      const p = { plugin, tier, command: shownCommand(a.command, a.arg, arg), arg, title: title ? String(title).slice(0, 80) : "" };
      return { text: t(lang, title ? "action.text" : "action.textNoTitle", p), cost: parts.length ? parts.join("; ") : null };
    }
    try {
      const d = target.prim.describe?.(target.args, this.facts, lang);
      if (d?.text) return d;
    } catch {}
    return { text: `${target.prim.name} ${JSON.stringify(target.args)}`, cost: null };
  }

  // ---------- hook ----------
  onHook(handler) {
    this.hookHandlers.push(handler);
    return () => {
      this.hookHandlers = this.hookHandlers.filter((h) => h !== handler);
    };
  }
  // The body is already checked by the server: peer hook, session_id matched. → hook response object.
  // signal — an AbortSignal that fires if agenthub-hook closed the connection before the response (Claude killed the hook:
  // answered in the terminal, etc.); the handler dismisses the card right away.
  async handleHook(body, peerInfo, { signal = null } = {}) {
    const event = typeof body?.hook_event_name === "string" ? body.hook_event_name.slice(0, 64) : null;
    let answer = {};
    let handled = false;
    // While the hub is paused, only requests the hub answers go without handlers (PermissionRequest and others):
    // the session asks in the terminal. Lifecycle events (SessionStart, SessionEnd, Stop) go as usual,
    // otherwise the interactive session registry would diverge from Claude (after /clear while paused — the old id of the same pid).
    const estop = this.estop();
    if (!estop || HOOK_LIFECYCLE.has(event)) {
      for (const h of this.hookHandlers) {
        try {
          const r = await h(body, { peer: { ...peerInfo }, signal });
          if (r !== undefined && r !== null) {
            // while paused the hook response is always {}: no decisions from the hub
            answer = estop ? {} : r;
            handled = true;
            break;
          }
        } catch {}
      }
    }
    this.journal.write({ type: "hook", event, claudePid: peerInfo?.claudePid, sessionId: body?.session_id, handled, estop });
    return answer;
  }

  // ---------- snapshot ----------
  // Where the hub lives: the state directory, whether it is a test one (not the default directory — AGENTHUB_HOME or --home
  // in the shell) and where builtin plugins come from: a copy in <home>/Builtin (agenthub install --apply / builtin update),
  // the repository working tree or a custom path. The shell draws a "TEST" badge based on testMode.
  hubInfo() {
    const home = this.config.paths?.home || null;
    const dir = this.config.builtinPluginsDir || null;
    const builtin = !dir ? null : samePath(dir, home && join(home, "Builtin")) ? "copy" : samePath(dir, join(REPO_DIR, "plugins")) ? "repo" : "custom";
    // cli — full path to this daemon's CLI: the shell shows commands with it (agenthub pin-app — the "build path
    // not recorded" banner)
    return { home, testMode: Boolean(home) && !samePath(home, liveStateDir()), builtinDir: dir, builtin, cli: join(DAEMON_DIR, "bin", "agenthub") };
  }
  // cmux bridge (actions service): whether it is connected and how to start it. null — no actions service.
  // command — path to the bridge script (the first of peer.bridgePaths), home/defaultHome — for AGENTHUB_HOME in the command.
  bridgeInfo() {
    const ch = this.facts.get("bridge.channel");
    if (!ch) return null;
    const st = ch.status();
    const home = this.config.paths?.home || null;
    const paths = this.config.peer?.bridgePaths || [];
    return {
      online: Boolean(st.online),
      since: st.online && st.since ? new Date(st.since).toISOString() : null,
      version: st.online ? st.version || null : null,
      command: paths[0] || null,
      home,
      defaultHome: samePath(home, liveStateDir()),
    };
  }
  // Settings → Terminal: the terminal adapters, what each supports, whether it can run now, where a new session opens
  // (lib/terminals/index.mjs terminalsInfo). services.terminal.launch — an adapter id or "auto".
  terminalsInfo(sessions = this.sessionList()) {
    try {
      const prefer = this.config.services?.terminal?.launch;
      return terminalsInfo(this.facts, { prefer: typeof prefer === "string" && prefer ? prefer : "auto", sessions });
    } catch {
      return null;
    }
  }
  snapshot(peerInfo = null) {
    const sessions = this.sessionList();
    return {
      version: VERSION,
      // plugin contract version this core understands (lib/meta.mjs CONTRACT_VERSION)
      contract: CONTRACT_VERSION,
      now: new Date().toISOString(),
      pid: process.pid,
      estop: this.estop(),
      status: this.worstStatus(),
      waitingSessions: this.waitingCount(),
      severity: SEVERITY,
      plugins: this.pluginStates(),
      sessions,
      primitives: [...this.primitives.values()].map((p) => ({ name: p.name, level: p.level, remoteAllowed: p.remoteAllowed, appOnly: p.appOnly, safeUnderEstop: p.safeUnderEstop, ...(p.aliasOf ? { aliasOf: p.aliasOf, deprecated: true } : {}) })),
      appPin: this.appPin ? this.appPin.info() : null,
      lang: this.langInfo(),
      // Available updates of registry plugins (plugins service, lib/registry/updates.mjs); null — no service.
      pluginUpdates: this.facts.get("plugins.updates") ?? null,
      // Own plugins from local folders (plugins service): install requests waiting for a human in the app,
      // and own plugins whose folder disappeared or is broken. null — no service.
      ownPlugins: this.facts.get("plugins.own") ?? null,
      // Update of the hub itself (hub-update service, docs/hub-updates.md); null — no service.
      hubUpdate: this.facts.get("hub.update") ?? null,
      launchAtLogin: this.launchAtLoginSetting(),
      // "Settings → Notifications": switches, quiet hours, security exceptions (notificationsSetting).
      notifications: this.notificationsSetting(),
      // Whether the computer can be shut down (idle service, lib/idle.mjs): {verdict, items, checked, since}; null — no service.
      idle: this.facts.get("idle.state") ?? null,
      // Connections to external services over OAuth (oauth service, docs/api.md "Connections"): state without tokens;
      // null — no service.
      connections: this.facts.get("oauth.connections") ?? null,
      hub: this.hubInfo(),
      bridge: this.bridgeInfo(),
      terminals: this.terminalsInfo(sessions),
      ...(peerInfo ? { peer: { class: peerInfo.class, reason: peerInfo.reason || null } } : {}),
      seq: this.seq,
    };
  }
}

// Mark of a session that failed the signature check. Claude's auto-update deleted the version file, while the process
// is still alive (proc_pidpath gives no path for such a process — no-path, or the file at the path is gone — no-file):
// it is not spoofing, but there is nothing to check either — such a session does not get into the registry.
export function sessionLabel(reason, lang = "ru") {
  if (reason === "no-file" || reason === "no-path") return t(lang, "session.label.no-file");
  if (reason === "no-process") return t(lang, "session.label.no-process");
  return t(lang, "session.label.other");
}

// Session info fields. A key passed explicitly with null means "there is no value any more" (the plugin stopped
// printing the status): we copy it, otherwise the previous frame's status would stay in the registry forever. A missing
// key (undefined) means "the source does not know about it", the previous value stays (that is how the hook registers).
// Action argument value against the declared pattern. → { value } | { error }
// The plugin's pattern is wrapped in ^(?:…)$: "^a|b$" would otherwise let "…b" through. On top of the pattern the core rejects
// control (Cc: C0, DEL, C1) and format characters (Cf: bidi overrides, zero width, soft
// hyphen), line and paragraph separators (U+2028/2029), values that look like a flag ("-…"), and longer than ARG_MAX —
// whatever the author allows: the value ends up in the core's confirmation text and in the button label.
export function checkActionArg(spec, value) {
  if (typeof value !== "string" || value === "") return { error: "required" };
  if (value.length > ARG_MAX) return { error: "too-long" };
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return { error: "control" };
  if (value.startsWith("-")) return { error: "option-like" };
  let re;
  try {
    re = new RegExp(`^(?:${spec.pattern})$`, "u");
  } catch {
    return { error: "pattern" };
  }
  return re.test(value) ? { value } : { error: "pattern" };
}

// Action fingerprint: what a human agrees to in the confirmation text (command, level, argument pattern)
// and whose version it is (plugin version and tier). The confirmation token key and the pre-run check use it.
export function actionFingerprint(pl, tier, action) {
  const arg = action.arg ? { name: action.arg.name, pattern: action.arg.pattern } : null;
  return sha(JSON.stringify([pl?.id ?? null, pl?.meta?.version ?? null, tier ?? null, action.id, action.command, actionLevel(pl, action), arg, action.cost ?? null, action.title ?? null, action.i18n ?? null])).slice(0, 32);
}

// Plugin action level. Builtin — as declared. With a declared network or a declared cost (`cost=` in any
// language) — no lower than confirm-cost: a human sees the cost in the window before the run, the author cannot declare it and skip the window.
// Official and own (own) without network and without cost — as declared, including immediate (decision 2026-11-09: a plugin mode switch
// without a window; the action is still app-only — actionAppOnly — journaled, and lowering the level in an update is
// an escalation of rights, a consent window). "No network and no cost=" does not yet mean "free" (running an agent spends quota even without
// network): that an immediate action spends nothing beyond what its title says is checked by the registry reviewer
// (docs/plugins-registry.md; the linter flags every such action with a warning). Everyone else — no lower than confirm
// (they have no actions anyway: trusted only).
export function actionLevel(pl, action) {
  if (pl?.source === "builtin") return action.level;
  const priced = (pl?.meta?.net || []).length || actionHasCost(action);
  const floor = priced ? "confirm-cost" : trustedPlugin(pl) ? "immediate" : "confirm";
  return LEVELS.indexOf(action.level) >= LEVELS.indexOf(floor) ? action.level : floor;
}

// The action declared a cost: cost= or cost-<lang>=.
export function actionHasCost(action) {
  if (action?.cost) return true;
  return Object.values(action?.i18n || {}).some((x) => Boolean(x?.cost));
}

// An action of a non-builtin plugin — only from the app (class app), at any level.
export function actionAppOnly(pl) {
  return pl?.source !== "builtin";
}

function pick(info) {
  const out = {};
  for (const k of SESSION_FIELDS) if (k in info && info[k] !== undefined) out[k] = info[k];
  return out;
}
const SESSION_FIELDS = ["status", "waitingFor", "name", "nameSource", "cwd", "interactive", "surfaceId", "workspaceId", "kind", "effort", "ultracode", "model", "modelSource", "effortSource", "metaAt"];

// ISO 8601 time from plugin output (sessionAt=): parsed with Date.parse, up to 40 chars; otherwise null.
function isoTime(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s && s.length <= 40 && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
}

// The action command as it will be run: the same argv as PluginInstance.runAction (runner.mjs actionArgv:
// quotes and "\" per splitCommand rules, the value replaces the word `{name}` or goes at the end). Elements with spaces,
// quotes or "\" and empty ones — in single quotes so argument boundaries are visible. Display only.
export function shownCommand(command, argDecl, value) {
  let argv;
  try {
    argv = actionArgv(command, argDecl, value);
  } catch {
    // unclosed quote: such an action will not run anyway (runAction throws) — shown as written
    return argDecl ? `${String(command || "")} ${value}` : String(command || "");
  }
  return argv.map(quoteArg).join(" ");
}

function quoteArg(a) {
  const s = String(a ?? "");
  return s !== "" && !/[\s"'\\]/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
