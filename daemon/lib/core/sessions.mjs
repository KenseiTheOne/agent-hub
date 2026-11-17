// Core part: facts (what primitives and extensions ask the core about) and the session registries — Claude Code
// sessions (makeSessions; the session lines of plugin frames: noteSession, markSession) and non-Claude agent sessions
// (G13, agentSession= lines).
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { cleanPhrase } from "../output.mjs";
import { sysAsync } from "../peer.mjs";
import { tabOf } from "../terminals/index.mjs";
import { msg, t } from "../i18n.mjs";
import { trustedPlugin } from "./tiers.mjs";

// Claude Code session effort levels (the sessionEffort= parameter in plugin output); anything else is dropped.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Session model (sessionModel=, contract 3): a model id from the turn record ("claude-opus-5-5") or a name from /model output
// ("Opus 5.5 (default)", "Sonnet 4.5 [1m]"). Only letters, digits, space and " ._:()[]/+-", up to 64 chars; anything else is dropped.
export const SESSION_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:()[\]/+-]{0,63}$/;
// Where model/effort came from: the last turn (turn) or a /model, /effort command after it (command).
export const SESSION_META_SOURCES = ["turn", "command"];
// Non-Claude agent sessions (G13): the id (agentSession=), the agent kind (agent=), entries per plugin and in total, how often
// entries whose process ended are swept while any exist.
export const EXTERNAL_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTERNAL_AGENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const EXTERNAL_PER_PLUGIN = 64;
const EXTERNAL_MAX = 200;
const EXTERNAL_SWEEP_MS = 30_000;

export class CoreSessions {
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
      // Non-Claude agent sessions (G13, kind "external"): only session.focus takes them; the other session primitives refuse
      // them with facts:external-session. A dead process (pid gone or reused) is dropped on lookup.
      externalSession: (id) => core.externalSession(id),
      externalSessions: () => core.externalSessions(),
      // The Claude process was started by a human (controlling terminal, argv without -p/--print) — see peer.interactiveProcess.
      claudeProcess: (pid) => (core.peer.interactiveProcess ? core.peer.interactiveProcess(pid) : { ok: false, reason: "no-check" }),
      // Live class app connections ([{pid, startSec, path}]) and "the daemon is stopping" — for the app service.
      appConnections: () => core.appConnections(),
      // Open event streams (GET /events) of any class: someone is using the hub (an unpinned copy of the
      // app is class cli). The app service does not exit with "Launch at login" off while there are any.
      eventStreams: () => core.sseStreams,
      stopping: () => core.stopping,
      // Plugin actions running now: [{action, plugin, title, since}] and background jobs ({…, job, background: true}) (idle service).
      runningActions: () => core.runningActionList(),
      // Background jobs (G6): [{id, plugin, actionId, title, startedAt, pid}]; job(id) — one or null (the job.cancel primitive).
      jobs: () => core.jobList(),
      job: (id) => core.jobList().find((j) => j.id === id) || null,
      // Executable path of our own process (proc_pidpath) — the app service uses it to confirm candidates from ps.
      processPath: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.pidPath?.(pid) ?? null) : null),
      // The terminal layer (lib/terminals/_proc.mjs): parent and start time, argv (the tmux server's socket flags) and the
      // controlling terminal of a process — to find which terminal a session runs in and its tab.
      processInfo: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.pidInfo?.(pid) ?? null) : null),
      processArgv: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.procArgv?.(pid) ?? null) : null),
      processTty: (pid) => (Number.isInteger(pid) && pid > 0 ? (core.peer?.sys?.ttyName?.(pid) ?? null) : null),
      // the same answer as a Promise: ps runs off the event loop (the built-in adapters ask this one)
      processTtyAsync: (pid) => (Number.isInteger(pid) && pid > 0 ? sysAsync(core.peer?.sys, "ttyName", pid) : Promise.resolve(null)),
      // Runs a terminal's tool for an adapter (tmux, osascript): → Promise<{code, stdout, timedOut}>.
      terminalExec: (file, args, opts) => core.terminalExec(file, args, opts),
      // Whose process has this pid: a running plugin run (standard) or its streamable process. → {id, source, tier,
      // trusted, net} or null. The route that serves plugins (POST /connections/:id/mcp) uses this to identify the
      // plugin by the peer pid on the socket: a plugin's child process is not included, a plugin action (and a background
      // job, G6) only with opts.actions (/terminal/* routes, contract 3: typing into a tab on a human's button press; MCP calls of
      // connections, POST /connections/:id/mcp, G7).
      pluginByPid: (pid, opts = {}) => {
        const pl = core.host?.pluginByPid?.(pid, opts);
        if (!pl) return null;
        // a process of a stopped, removed or updated instance on its way out (task 80, host.pluginByPid): untrusted
        const trusted = pl.leaving === true ? false : trustedPlugin(pl);
        // terminal — <agenthub.terminal> entries (contract 3): /terminal/* routes check the operation and string against them
        // action — {id, net} when the pid is an action or job process (opts.actions): connection routes hold it to net="none"
        // action.job — the process is a background job's (G6), not a foreground action's (task 84: connection routes force
        // fresh calls only for the latter)
        const act = opts.actions ? core.host?.actionByPid?.(pid) : null;
        const job = act ? core.host?.jobPid?.(pid) === true : false;
        return { id: pl.id, source: pl.source, tier: pl.granted?.tier || null, trusted, net: [...(pl.meta?.net || [])], terminal: [...(pl.meta?.terminal || [])], ...(act ? { action: { id: act.id, net: act.net || null, ...(job ? { job: true } : {}) } } : {}) };
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
      // Non-Claude agent sessions (G13): a lookup, so that Claude-only operations refuse them with a clear code.
      external: (id) => core.externalSession(id),
      externalList: () => core.externalSessions(),
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

  // ---------- non-Claude agent sessions (G13) ----------
  // A trusted plugin's line `… | agentSession=<id> pid=<pid> [agent=<kind>] [agentName="<name>"]` registers a session of kind
  // "external" (another agent's CLI in a terminal tab). The process must exist; its start time is recorded, so a reused pid drops
  // the entry. There is no signature check — hence only session.focus works for it (the terminal layer finds the tab by the pid);
  // interrupt, stop, the /terminal/* routes refuse it (external-session). The id is held by the first plugin that registered it
  // while that process lives. Kept apart from the Claude registry: /state.externalSessions, the sessions.external event.
  // → { id, changed } (id null — the line was refused, a warning went to the journal)
  noteExternal(pl, params) {
    const id = String(params.agentSession ?? "");
    const no = (key, p = {}) => {
      this.warn(pl.id, msg(key, { id: id.slice(0, 64), ...p }));
      return { id: null, changed: false };
    };
    if (!trustedPlugin(pl)) return no("warn.agentSession.untrusted");
    if (!EXTERNAL_SESSION_ID_RE.test(id)) return no("warn.agentSession.id");
    const pid = /^\d{1,10}$/.test(String(params.pid ?? "")) ? Number(params.pid) : NaN;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return no("warn.agentSession.pid");
    const prev = this.externalMap.get(id);
    if (prev && prev.owner !== pl.id && this.processAlive(prev.pid, prev.startSec)) return no("warn.agentSession.taken", { owner: prev.owner });
    // the start time of the process now: the same pid with the same start — the same process (no re-reading of a known one)
    let startSec = prev && prev.owner === pl.id && prev.pid === pid ? prev.startSec : undefined;
    if (startSec === undefined) {
      const sys = this.peer?.sys;
      if (sys?.available && typeof sys.pidInfo === "function") {
        const info = sys.pidInfo(pid);
        if (!info) return no("warn.agentSession.noProcess", { pid });
        startSec = Number.isFinite(info.startSec) ? info.startSec : null;
      } else {
        if (!this.processAlive(pid)) return no("warn.agentSession.noProcess", { pid });
        startSec = null;
      }
    } else if (!this.processAlive(pid, startSec)) return no("warn.agentSession.noProcess", { pid });
    if (!prev || prev.owner !== pl.id) {
      let mine = 0;
      for (const e of this.externalMap.values()) if (e.owner === pl.id) mine++;
      if (mine >= EXTERNAL_PER_PLUGIN || this.externalMap.size >= EXTERNAL_MAX) return no("warn.agentSession.many", { n: EXTERNAL_PER_PLUGIN });
    }
    const agent = EXTERNAL_AGENT_RE.test(String(params.agent ?? "")) ? params.agent : null;
    const name = params.agentName !== undefined ? cleanPhrase(params.agentName) || null : null;
    const next = { sessionId: id, pid, startSec, kind: "external", agent, name, owner: pl.id };
    const changed = !prev || JSON.stringify({ ...prev, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 });
    if (changed) {
      if (!prev || prev.owner !== pl.id || prev.pid !== pid) this.journal.write({ type: "agent-session", plugin: pl.id, sessionId: id, pid, agent });
      this.externalMap.set(id, { ...next, updatedAt: Date.now() });
      this.armExternalSweep();
    }
    return { id, changed };
  }
  // Drop a plugin's agent sessions not in keep (a frame without them, the plugin removed). → whether anything went.
  dropExternal(pluginId, keep, { emit = true } = {}) {
    let gone = false;
    for (const [id, e] of [...this.externalMap]) {
      if (e.owner !== pluginId || keep.has(id)) continue;
      this.externalMap.delete(id);
      gone = true;
    }
    if (gone && emit) this.emitExternal();
    return gone;
  }
  // Entries whose process ended or whose pid now belongs to another process. → whether anything went.
  sweepExternal({ emit = true } = {}) {
    let gone = false;
    for (const [id, e] of [...this.externalMap]) {
      if (this.processAlive(e.pid, e.startSec)) continue;
      this.externalMap.delete(id);
      this.journal.write({ type: "agent-session-gone", plugin: e.owner, sessionId: id, pid: e.pid });
      gone = true;
    }
    if (!this.externalMap.size && this.externalSweep) {
      clearInterval(this.externalSweep);
      this.externalSweep = null;
    }
    if (gone && emit) this.emitExternal();
    return gone;
  }
  armExternalSweep() {
    if (this.externalSweep || this.stopping) return;
    this.externalSweep = setInterval(() => this.sweepExternal(), EXTERNAL_SWEEP_MS);
    this.externalSweep.unref?.();
  }
  emitExternal() {
    this.emit({ type: "sessions.external", sessions: this.externalSessionList() });
  }
  // One entry (case-insensitive id), alive right now. → a copy | null
  externalSession(id) {
    if (typeof id !== "string" || !id) return null;
    let e = this.externalMap.get(id);
    if (!e) {
      const want = id.toLowerCase();
      e = [...this.externalMap.values()].find((x) => x.sessionId.toLowerCase() === want) || null;
    }
    if (!e) return null;
    if (!this.processAlive(e.pid, e.startSec)) {
      this.sweepExternal();
      return null;
    }
    return { ...e };
  }
  externalSessions() {
    this.sweepExternal();
    return [...this.externalMap.values()].map((e) => ({ ...e }));
  }
  // For /state.externalSessions and the sessions.external event: the entry plus the tab found by the terminal layer (like
  // sessionList: terminal, focusable, terminalInfo).
  externalSessionList() {
    return [...this.externalMap.values()].map((s) => {
      let tab = { terminal: null, focusable: false, terminalInfo: null };
      try {
        if (this.facts) tab = tabOf(s, this.facts);
      } catch {}
      return { ...s, ...tab };
    });
  }

  // ---------- session lines of plugin frames (applyFrame, lib/core/frames.mjs) ----------
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
