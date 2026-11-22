// Core: state, worst status, primitive registry, confirmation levels, checking arguments against facts,
// effects allowlist for third-party plugins, ESTOP (file), journal (metadata only), event bus.
//
// This file holds the Core class itself: its fields, start and stop (primitives, services, plugins), the app's
// connections and shutdown, hub update flags, ESTOP, app pinning and the hook entry. The rest of its methods live in
// lib/core/, one file per area, and are installed on Core.prototype at the end of this file (lib/parts.mjs):
//   core/settings.mjs      — the hub language and the settings the app changes
//   core/bus.mjs           — events for GET /events, journal warnings, plugin event subscriptions
//   core/sessions.mjs      — facts, the Claude Code session registry, non-Claude agent sessions
//   core/plugin-policy.mjs — a plugin's policy, service variables and secrets
//   core/state.mjs         — GET /state: the snapshot and the sections services supply
//   core/plugin-state.mjs  — the state of each plugin as the host reports it
//   core/frames.mjs        — plugin output → state, events, offers
//   core/jobs.mjs          — background jobs and streamable processes across daemon lives
//   core/invoke.mjs        — running an action
// Rules without a Core (constants and pure functions): core/tiers.mjs, core/action-rules.mjs.
// The public names of all of them are re-exported here: `import { Core, actionLevel, … } from "./core.mjs"` works as before.

import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, chmodSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR } from "./config.mjs";
import { AppPinWatcher } from "./app-pin.mjs";
import { Journal } from "./journal.mjs";
import { LEVELS } from "./meta.mjs";
import { listModuleNames, loadModules } from "./loader.mjs";
import { Extensions } from "./extensions.mjs";
import { makeCtx, makeExec } from "./ctx.mjs";
import { PluginHost } from "./host.mjs";
import { ADAPTERS as TERMINAL_ADAPTERS } from "./terminals/index.mjs";
import { realExec, refuseExec } from "./terminals/_exec.mjs";
import { msg, releaseLangSource, setLangSource } from "./i18n.mjs";
import { Settings } from "./settings.mjs";
import { HOOK_SEEN_FILE, HookSeen } from "./hook/seen.mjs";
import { pidFields } from "./hook/agents.mjs";
import { loadStateJson } from "./statefile.mjs";

// Hub version is the VERSION file at the repository root (lib/version.mjs), not a string in code.
export { VERSION } from "./version.mjs";
import { VERSION } from "./version.mjs";

// The parts of Core (see the header).
import { installParts } from "./parts.mjs";
import { APP_ONLY } from "./core/tiers.mjs";
import { CoreSettings } from "./core/settings.mjs";
import { CoreBus } from "./core/bus.mjs";
import { CoreSessions } from "./core/sessions.mjs";
import { CorePluginPolicy } from "./core/plugin-policy.mjs";
import { CoreState } from "./core/state.mjs";
import { CorePluginState } from "./core/plugin-state.mjs";
import { CoreFrames } from "./core/frames.mjs";
import { CoreJobs, JOB_KILL_GRACE_MS } from "./core/jobs.mjs";
import { CoreInvoke } from "./core/invoke.mjs";

// Names other modules and tests take from here; they live in the parts (lib/core/).
export { THIRD_PARTY_EFFECTS, PRIMITIVE_ALIASES, LOCAL_EFFECTS, APP_ONLY, TIERS, trustedPlugin, testTierPlugin, pluginConnections, effectAllowed, communityPlugin, communityPushRules } from "./core/tiers.mjs";
export { checkActionArg, actionFingerprint, actionLevel, inputDecls, actionHasCost, actionAppOnly, shownCommand } from "./core/action-rules.mjs";
export { EFFORT_LEVELS, SESSION_MODEL_RE, SESSION_META_SOURCES, EXTERNAL_SESSION_ID_RE, sessionLabel } from "./core/sessions.mjs";
export { SERVICE_STATE_SLOTS } from "./core/state.mjs";

// Hook events without a decision (only the interactive session registry and dismissing cards) — called even while the hub is paused.
const HOOK_LIFECYCLE = new Set(["SessionStart", "UserPromptSubmit", "SessionEnd", "Stop"]);

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
    // Background jobs (<agenthub.action background="true">, G6): jobId → {id, plugin, actionId, title, startedAt, pid, kill, offer}.
    this.jobs = new Map();
    // Jobs being started (pluginId → count): the per-plugin limit counts them before the first await (B5).
    this.jobsStarting = new Map();
    // jobExit messages a streamable plugin could not get (no process: a restart) — delivered when it starts again (B1).
    this.pendingJobExits = new Map();
    this.jobKillGraceMs = JOB_KILL_GRACE_MS;
    // Live processes of streamable plugins: pid → {plugin, pid, startSec}; mirrored in <home>/streams.json so that the next
    // daemon can stop the ones this one left behind (reapOrphanStreams).
    this.streams = new Map();
    this.streamReap = null;
    // Frame-rate limit of streamable plugins (streamFrame): plugin → { tokens, at, pending, timer, dropped, notedAt }
    this.frameRate = new Map();
    // State files found damaged at load (config.json, settings.json, jobs.json, …): [{file, backup, detail, at}] — /state.damagedFiles.
    this.damagedFiles = [];
    // stdin backlog of streamable plugins (B6): pluginId → when it was last journaled.
    this.backlogNoted = new Map();
    // Coalescing `plugin` events (G9, emitPlugin): when the last one went out, the trailing timers, and "the next change goes out at
    // once" deadlines set after an action (pluginId → ms).
    this.emitAt = new Map();
    this.emitTimers = new Map();
    this.snappy = new Map();
    this.hookHandlers = [];
    // When a hook event last reached this hub (/state.hook, lib/hook/seen.mjs) — kept across restarts in <home>/hook-seen.json.
    this.hookSeen = new HookSeen(join(config.paths.home, HOOK_SEEN_FILE));
    this.secretsProvider = null;
    this.pluginPolicy = null;
    // Environment variables from core services for trusted plugins (builtin, official and own): AGENTHUB_USAGE_FILE etc.
    this.pluginEnvExtra = new Map();
    // Services' own parts of GET /state (ctx.provideState): section → { fn, owner }.
    this.stateProviders = new Map();
    this.services = [];
    this.routes = [];
    this.startedAt = Date.now();
    this.factProviders = new Map();
    this.sessionMap = new Map();
    // Non-Claude agent sessions (G13): sessionId → {sessionId, pid, startSec, kind: "external", agent, name, owner, updatedAt}.
    // Written only by trusted plugins' agentSession= lines; kept apart from the Claude registry (sessionMap) — only focus works.
    this.externalMap = new Map();
    this.externalSweep = null;
    // Event subscriptions (G11): subscriber plugin id → [{plugin, prefix}] (trusted streamable only); delivery budget per minute.
    this.subscriptions = new Map();
    this.subscribeRate = new Map();
    this.pluginMeta = new Map();
    this.host = new PluginHost(this);
    this.facts = this.makeFacts();
    this.sessions = this.makeSessions();
    this.estopState = false;
    this.appPin = null;
    // keepBad: a settings.json this daemon cannot read is copied to settings.json.bad before the defaults replace it (init
    // journals it — noteDamaged)
    this.settings = new Settings(config.paths.settings || join(config.paths.home, "settings.json"), { ...(config.systemLang ? { detect: () => config.systemLang } : {}), keepBad: true });
    // errors and warnings rendered deep in the libraries (msg, lib/i18n.mjs) follow this hub's language
    this.langSource = () => this.lang();
    // plugin content languages (G14): the system preferred languages pick metadata translations (lib/i18n.mjs contentLang)
    this.langSource.locales = () => this.settings.systemLocales();
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

  // ---------- initialization ----------
  async init({ startPlugins = true, startServices = true } = {}) {
    const p = this.config.paths;
    mkdirSync(p.home, { recursive: true, mode: 0o700 });
    chmodSync(p.home, 0o700);
    for (const d of [p.plugins, p.pluginData, p.pluginCache, p.logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
    this.hookSeen.load();
    await this.loadPrimitives(join(DAEMON_DIR, "lib", "primitives"));
    // External extensions (G4, lib/extensions.mjs): <home>/Extensions/* approved by a human in the app — primitives and terminal
    // adapters right after the built-in primitives (services may use both), services after the built-in ones, routes when the
    // server attaches. The terminal layer takes the core's adapter list from the "terminal.adapters" fact.
    this.extensions = new Extensions(this);
    // the extension manager for its routes (lib/routes/extensions.mjs)
    this.facts.provide("extensions.api", () => this.extensions);
    this.facts.provide("terminal.adapters", () => (this.extensions?.adapters.length ? [...TERMINAL_ADAPTERS, ...this.extensions.adapters] : TERMINAL_ADAPTERS));
    await this.extensions.loadKind("primitive");
    await this.extensions.loadKind("terminal");
    this.watchEstop();
    this.watchAppPin();
    this.watchLang();
    this.journal.write({ type: "start", version: VERSION, pid: process.pid, testMode: this.config.testMode });
    // state files this daemon could not read (found before the journal was up: config.json, settings.json)
    for (const d of [...(this.config.damagedFiles || []), ...(this.settings.damaged ? [this.settings.damaged] : [])]) this.noteDamaged(d);
    // jobs of a daemon that crashed (B3): their groups still run detached — kill the ones that are provably the same processes
    this.reapOrphanJobs();
    // and its streamable plugin processes: they would otherwise run next to the copies this daemon starts
    this.streamReap = this.reapOrphanStreams();
    // Services before plugins: the plugin policy (ctx.setPluginPolicy) and the secrets provider must
    // be in effect on the very first scan, not after it.
    if (startServices) await this.startServices(join(DAEMON_DIR, "lib", "services"));
    if (startServices) await this.extensions.loadKind("service");
    this.extensions.start();
    // all services are subscribed (push is listening): only now does the hub-update service finish an interrupted install
    this.bus.emit("services.started", { type: "services.started" });
    // A change of the app requirement while the daemon was down — after services start: push must hear the event.
    this.appPin.reconcile("start");
    // the previous daemon's streamable processes are gone (or killed) before their plugins start again: at most ~1 s
    await this.streamReap;
    if (startPlugins) await this.host.start();
  }

  // A state file could not be read and the daemon went on without it (lib/statefile.mjs loadStateJson): one journal line, and
  // the fact stays in /state.damagedFiles until the daemon restarts — the shell can tell the human which file to look at.
  noteDamaged(d) {
    if (!d || typeof d.file !== "string") return;
    if (this.damagedFiles.some((x) => x.file === d.file)) return;
    this.damagedFiles.push({ file: d.file, backup: d.backup ?? null, detail: String(d.detail ?? "").slice(0, 200), at: d.at ?? new Date().toISOString() });
    this.journal.write({ type: "state-file-damaged", file: d.file, backup: d.backup ?? null, detail: String(d.detail ?? "").slice(0, 200) });
  }
  // A state file of this daemon, read tolerantly: → the object | undefined (no file, or damaged — noted).
  readState(path) {
    const r = loadStateJson(path);
    if (r.damaged) this.noteDamaged(r.damaged);
    return r.value;
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
      // pluginOf(rawArgs, facts) → the plugin id the call concerns (the test-hub cli exception, task 75); checkOffer(args) → the
      // part of verifyFacts that needs no facts, run when a plugin's frame offers the primitive (task 71): a refusal there is a
      // warning and no button, not a button that can only fail
      pluginOf: typeof mod.pluginOf === "function" ? mod.pluginOf : null,
      checkOffer: typeof mod.checkOffer === "function" ? mod.checkOffer : null,
      run: mod.run,
    });
    return null;
  }

  async startServices(dir) {
    // built-in service names (by file name and module name below): an extension service may not take one (lib/extensions.mjs)
    this.builtinServiceNames = new Set(listModuleNames(dir));
    const filter = this.config.servicesFilter;
    if (filter === "none") return;
    const only = filter ? new Set(filter.split(",").map((s) => s.trim())) : null;
    const mods = await loadModules(dir, { onError: (f, e) => this.journal.write({ type: "load-error", kind: "service", file: f, detail: e.message }) });
    for (const { name: fileName, mod } of mods) {
      const name = mod.name || fileName;
      this.builtinServiceNames.add(name);
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
    await this.stopAllJobs();
    for (const timer of this.emitTimers.values()) clearTimeout(timer);
    this.emitTimers.clear();
    await this.host.stop();
    for (const f of this.frameRate.values()) clearTimeout(f.timer);
    this.frameRate.clear();
    for (const s of this.services.reverse()) {
      try {
        await s.mod.stop?.(s.ctx);
      } catch {}
    }
    this.services = [];
    this.extensions?.stop();
    this.estopWatcher?.close();
    clearInterval(this.estopPoll);
    clearInterval(this.langPoll);
    clearInterval(this.externalSweep);
    this.externalSweep = null;
    this.appPin?.stop();
    this.hookSeen.flush();
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
    this.appPin = new AppPinWatcher({ config: this.config, peer: this.peer, journal: this.journal, emit: (ev) => this.emit(ev), onDamaged: (d) => this.noteDamaged(d) });
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
  // Background jobs (G6) are an emergency-stop target: setting the pause stops them all (journaled as cancelled: "paused").
  estopChanged(on) {
    if (on) for (const job of [...this.jobs.values()]) this.stopJob(job, "paused");
    this.host.restartAll?.(on ? "Paused" : "Resumed");
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
    this.hookSeen.note();
    let answer = {};
    let handled = false;
    // While the hub is paused, only requests the hub answers go without handlers (PermissionRequest and others):
    // the session asks in the terminal. Lifecycle events (SessionStart, UserPromptSubmit, SessionEnd, Stop) go as usual,
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
    this.journal.write({ type: "hook", event, ...pidFields(peerInfo?.agent, peerInfo?.agentPid ?? peerInfo?.claudePid), sessionId: body?.session_id, handled, estop });
    return answer;
  }
}

// The rest of Core's methods: lib/core/*.mjs, one file per area (see the header).
installParts(Core, [CoreSettings, CoreBus, CoreSessions, CorePluginPolicy, CoreState, CorePluginState, CoreFrames, CoreJobs, CoreInvoke]);
