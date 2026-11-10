// The sessions service: metadata of live Claude Code sessions for trusted plugins (contract 3).
//
// The source is the core session registry (ctx.sessions): only trusted plugins (session=… pid=… lines
// with a signature verified by the core) and the hook write there. What the registry knows about the model and effort the core takes from
// the plugin's line parameters (sessionModel=, sessionEffort=, sessionModelSource=, sessionEffortSource=, sessionAt=, sessionUltracode=):
// that is how the builtin sessions plugin reports them, reading the transcript tail itself. The service knows nothing about specific plugins —
// it only moves the registry into a file.
//
// The file is <home>/Cache/claude-sessions.json (0600, atomic: a temporary file in the same directory and rename), its path is
// the AGENTHUB_CLAUDE_SESSIONS_FILE variable (ctx.providePluginEnv: the core gives it only to builtin, official and own;
// it can also be used in <agenthub.watch> and <agenthub.fsRead>). It is rewritten on the bus's sessions event, but no
// more often than once per minIntervalMs (2 s) and only if the content changed (except updatedAt):
//   { version: 1, updatedAt, sessions: [{ sessionId, pid, verified, status, model, modelId, modelSource, effort,
//     effortSource, ultracode, surfaceId, workspaceId, name, at }] }
// model — as Claude Code knows it: an id from a turn (modelSource turn, "claude-opus-5-5") or a name from /model output
// (modelSource command, "Opus 5.5 (default)"). modelId is always an id: from a turn — the id itself, from a name — by normalization
// (modelIdOf: "<Family> <version> (…)" → claude-<family>-<version with hyphens>); not recognized — null.
// Metadata only: no conversation text, no cwd, no waitingFor (what exactly the session is waiting for), no automatic session title
// (name with nameSource=auto — Claude Code builds it from the conversation; then name: null) gets into the file.
// verified — the requirements.claudeCode signature is verified by the core right now (the peer.verifySigned cache by pid and start time);
// the process has exited or been replaced — false, and the plugin does not type into such a session.
//
// Settings (config.json → services.sessions): enabled (false — no service, no variable), minIntervalMs
// (2000; can be lower in test mode, but no lower than 20).

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "sessions";
export const ENV_NAME = "AGENTHUB_CLAUDE_SESSIONS_FILE";
export const FILE_NAME = "claude-sessions.json";
export const FILE_VERSION = 1;
const MIN_INTERVAL_MS = 2000;
const MAX_SESSIONS = 200;
const STATUSES = new Set(["idle", "busy", "waiting"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SOURCES = new Set(["turn", "command"]);
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
// session or tab name — on one line, without control and format characters, up to 120 chars
const cleanName = (v) => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  return s ? Array.from(s).slice(0, 120).join("") : null;
};
const MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);
// A model name from /model output → id. "Opus 5.5 (default)" → claude-opus-5-5, "Sonnet 4.5 (1M context)" →
// claude-sonnet-4-5 (parentheses are menu notes, not part of the id), "claude-opus-5-5" as is; anything else ("Default", "opus") — null.
export function modelIdOf(name) {
  if (typeof name !== "string") return null;
  const n = name.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (/^claude-[a-z]+-\d+(?:-\d+)*(?:-\d{8})?$/.test(n)) return n;
  const m = /^(?:claude )?([a-z]+) (\d{1,3}(?:\.\d{1,3})*)$/.exec(n);
  if (!m || !MODEL_FAMILIES.has(m[1])) return null;
  return `claude-${m[1]}-${m[2].replaceAll(".", "-")}`;
}
const surface = (v) => (typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(v) ? v : null);

const running = new Map(); // ctx → SessionsFileService

// One registry entry → a file line (without verified: the service sets it).
export function sessionRecord(s) {
  const effort = EFFORTS.has(s.effort) ? s.effort : null;
  const model = typeof s.model === "string" && s.model ? s.model : null;
  return {
    sessionId: s.sessionId,
    pid: s.pid,
    status: STATUSES.has(s.status) ? s.status : null,
    model,
    // from a turn it is already an id; from /model (or an unknown source) — by name
    modelId: !model ? null : s.modelSource === "turn" ? model : modelIdOf(model),
    modelSource: model && SOURCES.has(s.modelSource) ? s.modelSource : null,
    effort,
    effortSource: effort && SOURCES.has(s.effortSource) ? s.effortSource : null,
    ultracode: s.ultracode === true,
    surfaceId: surface(s.surfaceId),
    workspaceId: surface(s.workspaceId),
    // a title Claude Code built from the conversation (nameSource auto) is derived from the text: we do not store it
    name: s.nameSource === "auto" ? null : cleanName(s.name),
    at: typeof s.metaAt === "string" ? s.metaAt : null,
  };
}

// Atomic 0600 write in the same directory.
export function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

export class SessionsFileService {
  constructor(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config.services?.sessions || {};
    const floor = ctx.config.testMode ? 20 : MIN_INTERVAL_MS;
    this.minIntervalMs = Math.max(floor, Number(cfg.minIntervalMs) || MIN_INTERVAL_MS);
    this.dir = ctx.config.paths.pluginCache;
    this.file = join(this.dir, FILE_NAME);
    this.timer = null;
    this.lastWriteAt = 0;
    this.lastKey = null;
    this.stopped = false;
    this.flushing = null;
    this.dirty = false;
    this.onSessions = () => this.schedule();
  }

  start() {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {}
    this.ctx.on("sessions", this.onSessions);
    this.ctx.providePluginEnv(ENV_NAME, this.file);
    // the file exists from the first plugin run (an empty list), so that <agenthub.watch> can attach to it right away
    this.schedule();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.ctx.off("sessions", this.onSessions);
    this.ctx.providePluginEnv(ENV_NAME, null);
  }

  // No more often than once per minIntervalMs: an event during the wait only marks that a write is needed.
  schedule() {
    if (this.stopped) return;
    this.dirty = true;
    if (this.timer || this.flushing) return;
    const wait = Math.max(0, this.lastWriteAt + this.minIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushing = this.flush()
        .catch((e) => this.ctx.journal.write({ type: "sessions-file-error", code: e?.code || "internal" }))
        .finally(() => {
          this.flushing = null;
          if (this.dirty) this.schedule();
        });
    }, wait);
    this.timer.unref?.();
  }

  async build() {
    const list = this.ctx.sessions.list().filter((s) => typeof s.sessionId === "string" && UUID_RE.test(s.sessionId) && Number.isInteger(s.pid) && s.pid > 0);
    list.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const out = [];
    for (const s of list.slice(0, MAX_SESSIONS)) {
      let verified = false;
      try {
        const v = await this.ctx.peer.verifySigned(s.pid, "claudeCode");
        verified = Boolean(v?.ok) && (s.startSec == null || v.startSec == null || v.startSec === s.startSec);
      } catch {}
      const r = sessionRecord(s);
      out.push({ sessionId: r.sessionId, pid: r.pid, verified, ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "sessionId" && k !== "pid")) });
    }
    return out;
  }

  async flush() {
    this.dirty = false;
    // the rate window counts from the attempt, not from the write: building also calls the signature check
    this.lastWriteAt = Date.now();
    const sessions = await this.build();
    if (this.stopped) return false;
    const key = JSON.stringify(sessions);
    if (key === this.lastKey) return false;
    writeAtomic(this.file, { version: FILE_VERSION, updatedAt: new Date().toISOString(), sessions });
    this.lastKey = key;
    return true;
  }
}

export async function start(ctx) {
  const svc = new SessionsFileService(ctx);
  running.set(ctx, svc);
  svc.start();
}

export async function stop(ctx) {
  for (const [c, svc] of [...running]) {
    if (ctx && c !== ctx) continue;
    svc.stop();
    running.delete(c);
  }
}
