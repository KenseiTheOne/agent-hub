#!/usr/bin/env node
// <agenthub.title>Claude Code Фоновые агенты</agenthub.title>
// <agenthub.title lang="en">Claude Code Background Agents</agenthub.title>
// <agenthub.version>1.2.1</agenthub.version>
// <agenthub.desc>Фоновые прогоны Workflow в Claude Code: что идёт, что упало, сколько потрачено</agenthub.desc>
// <agenthub.desc lang="en">Claude Code Workflow runs in the background: what's running, what failed, what it cost</agenthub.desc>
// <agenthub.status value="ok" label="Прогоны в порядке">Идущие и завершённые прогоны без сбоев</agenthub.status>
// <agenthub.status value="ok" lang="en" label="Runs OK">Running and finished runs, no failures</agenthub.status>
// <agenthub.status value="wait" label="Прогон требует внимания">Прогон упал, остановлен или остался без сессии — стоит посмотреть</agenthub.status>
// <agenthub.status value="wait" lang="en" label="A run needs a look">A run failed, was stopped or lost its session — take a look</agenthub.status>
// <agenthub.status value="unknown" label="Журналы не читаются">Журналы прогонов не разобраны</agenthub.status>
// <agenthub.status value="unknown" lang="en" label="Can't read logs">Run logs couldn't be read</agenthub.status>
// <agenthub.author.name>Kensei</agenthub.author.name>
// <agenthub.author.github>KenseiTheOne</agenthub.author.github>
// <agenthub.type>streamable</agenthub.type>
// <agenthub.platforms>macos,windows</agenthub.platforms>
// <agenthub.fsRead>~/.claude/projects/*/*/workflows/wf_*.json — итог прогона (статус, имя, длительность)</agenthub.fsRead>
// <agenthub.fsRead>~/.claude/projects/*/*/subagents/workflows/wf_*/journal.jsonl — старт/итог агентов (только тип, agentId, phase)</agenthub.fsRead>
// <agenthub.fsRead>~/.claude/projects/*/*/subagents/workflows/wf_*/agent-*.jsonl — только usage, requestId, message.id</agenthub.fsRead>
// <agenthub.fsRead>~/.claude/sessions/*.json — жива ли сессия, запустившая прогон: pid, procStart, sessionId, cwd, name (без *.key)</agenthub.fsRead>
// <agenthub.fsRead>~/.cmuxterm/claude-hook-sessions.json — вкладка cmux сессии (только sessionId, surfaceId, workspaceId)</agenthub.fsRead>
// <agenthub.exec>/bin/ps -o pid=,lstart= -p <pid,…> (TZ=UTC) — время старта процесса сессии: pid не занят другим процессом (только macOS)</agenthub.exec>
// <agenthub.effects>cmux.focus</agenthub.effects>
// <agenthub.contract>2</agenthub.contract>
// <agenthub.icon symbol="square.stack.3d.up" color="#BF5AF2"></agenthub.icon>
// <agenthub.push key="wf-failed" kind="plugin" was="runs">Фоновый прогон упал</agenthub.push>
// <agenthub.push key="wf-orphaned" kind="plugin" was="runs">Фоновый прогон остался без сессии</agenthub.push>
// <agenthub.push key="wf-failed" lang="en">Background run failed</agenthub.push>
// <agenthub.push key="wf-orphaned" lang="en">Background run lost its session</agenthub.push>
//
// Spend is the sum of usage over unique requests (requestId, otherwise message.id): in a transcript one request
// is repeated as a line for each response block with the same usage. The totalTokens field from wf_*.json is the sum
// of the agents' final contexts, not the spend; it is not used. output_tokens in transcripts are partial
// (a snapshot from the start of the stream), so output is shown as "at least".
//
// Message text is neither read nor printed: from transcript lines only usage numbers and
// identifiers are taken; from journal.jsonl — type, agentId, phase; from wf_*.json — status, workflowName,
// durationMs, startTime, agentCount (script, args, result, summary, logs, promptPreview, resultPreview,
// error are not used).
//
// Events: wf-failed-<runId> (the run ended killed/failed), wf-orphaned-<runId> (no result, the session
// is not alive and has been quiet for a while), source-broken.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const WINDOW_MS = 12 * 3600_000; // finished runs are shown for 12 h
export const ORPHAN_QUIET_MS = 5 * 60_000; // no session and no records for 5 min — orphaned
export const ACTIVE_QUIET_MS = 2 * 60_000; // fresh records — the run is alive even if the session was not found
const MAX_SHOWN = 8;
const READ_BUDGET = 32 * 1024 * 1024; // bytes per tick across all files
const CHUNK = 4 * 1024 * 1024;

// ---------- formatting ----------
export function clean(s) {
  return String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\|/g, "¦")
    .replace(/^[-\s]+/, "") // `--` at the start means nesting
    .replace(/^~~~$/, "~")
    .slice(0, 120);
}
function q(v) {
  return `"${String(v).replace(/[\\"]/g, "\\$&")}"`;
}
function line(title, params = {}) {
  const ps = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${/^[\w.:/+-]+$/.test(String(v)) ? v : q(v)}`);
  return ps.length ? `${title} | ${ps.join(" ")}` : title;
}
// Language is AGENTHUB_LANG (ru | en) from the core; without the variable — ru.
export function envLang() {
  return process.env.AGENTHUB_LANG === "en" ? "en" : "ru";
}
export function fmtTokens(n, lang = "ru") {
  if (lang === "en") {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
    return String(Math.round(n));
  }
  if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace(".", ",")} млрд`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(".", ",")} млн`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} тыс`;
  return String(Math.round(n));
}
function fmtDur(ms, lang = "ru") {
  const m = Math.round(ms / 60_000);
  const [s_, mn, h] = lang === "en" ? ["s", "min", "h"] : ["с", "мин", "ч"];
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} ${s_}`;
  if (m < 90) return `${m} ${mn}`;
  return `${Math.floor(m / 60)} ${h} ${m % 60} ${mn}`;
}
function fmtTime(ms, now, lang = "ru") {
  const d = new Date(ms);
  const loc = lang === "en" ? "en-US" : "ru-RU";
  const hm = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString(loc, lang === "en" ? { month: "short", day: "numeric" } : { day: "2-digit", month: "2-digit" })} ${hm}`;
}
const plEn = (n, one, other) => (n === 1 ? one : other);
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- file tail by offset ----------
// Reads new complete lines from offset; an unfinished last line is left for next time.
export class Tail {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.ino = null;
    this.skip = false;
  }
  // → { lines: string[], bytes, more } ; budget — how many bytes may be read
  read(budget = CHUNK) {
    let fd;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return { lines: [], bytes: 0, more: false };
    }
    try {
      const st = fstatSync(fd);
      if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) {
        this.offset = 0; // replaced/truncated
        this.skip = false;
      }
      this.ino = st.ino;
      if (st.size <= this.offset || budget <= 0) return { lines: [], bytes: 0, more: st.size > this.offset };
      const len = Math.min(st.size - this.offset, budget, CHUNK);
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, this.offset);
      const nl = buf.lastIndexOf(10, got - 1);
      if (nl < 0) {
        // The line did not fit into the rest of the tick budget — finish reading on the next tick (more: the file is not fully read);
        // read to the end of the file without a newline — an unfinished line, wait for its end (more: false).
        if (got < CHUNK) return { lines: [], bytes: 0, more: this.offset + got < st.size };
        // a line longer than the chunk (not a usage line) — skip it up to the newline
        this.offset += got;
        this.skip = true;
        return { lines: [], bytes: got, more: st.size > this.offset };
      }
      const lines = buf.subarray(0, nl).toString("utf8").split("\n");
      if (this.skip) {
        lines.shift(); // the tail of a skipped long line
        this.skip = false;
      }
      this.offset += nl + 1;
      return { lines, bytes: nl + 1, more: st.size > this.offset };
    } finally {
      closeSync(fd);
    }
  }
}

// ---------- spend ----------
const USAGE_FIELDS = [
  ["input", "input_tokens"],
  ["cacheWrite", "cache_creation_input_tokens"],
  ["cacheRead", "cache_read_input_tokens"],
  ["output", "output_tokens"],
];

export class Spend {
  constructor() {
    this.byReq = new Map();
    this.noKey = 0;
    this.total = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  }
  // an agent transcript line; only usage and identifiers are taken
  addLine(text) {
    if (!text.includes('"usage"')) return false;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return false;
    }
    if (!o || o.type !== "assistant" || !o.message || typeof o.message !== "object") return false;
    const u = o.message.usage;
    if (!u || typeof u !== "object") return false;
    const vals = {};
    for (const [k, f] of USAGE_FIELDS) vals[k] = Number.isFinite(u[f]) ? u[f] : 0;
    const key = typeof o.requestId === "string" && o.requestId ? `r:${o.requestId}` : typeof o.message.id === "string" && o.message.id ? `m:${o.message.id}` : null;
    if (!key) {
      this.noKey++;
      for (const [k] of USAGE_FIELDS) this.total[k] += vals[k];
      return true;
    }
    const prev = this.byReq.get(key);
    if (!prev) {
      this.byReq.set(key, vals);
      for (const [k] of USAGE_FIELDS) this.total[k] += vals[k];
      return true;
    }
    // the same request: take the maximum of each field (later stream lines are not smaller than earlier ones)
    let changed = false;
    for (const [k] of USAGE_FIELDS) {
      if (vals[k] > prev[k]) {
        this.total[k] += vals[k] - prev[k];
        prev[k] = vals[k];
        changed = true;
      }
    }
    return changed;
  }
  get requests() {
    return this.byReq.size + this.noKey;
  }
  get read() {
    return this.total.input + this.total.cacheWrite + this.total.cacheRead;
  }
  toJSON() {
    return { total: this.total, requests: this.requests };
  }
}

// ---------- run ----------
class Run {
  constructor({ key, runId, project, sessionId, sessionDir }) {
    Object.assign(this, { key, runId, project, sessionId, sessionDir });
    this.dir = join(sessionDir, "subagents", "workflows", runId);
    this.stateFile = join(sessionDir, "workflows", `${runId}.json`);
    this.journal = new Tail(join(this.dir, "journal.jsonl"));
    this.agentTails = new Map();
    this.agents = new Map(); // agentId → { phase, state }
    this.phases = [];
    this.spend = new Spend();
    this.final = null; // { status, name, durationMs, startTime, agentCount, hasError }
    this.finalSig = null;
    this.name = null;
    this.firstSeenMs = null;
    this.lastActivityMs = 0;
    this.broken = null;
    this.settled = false; // result read, files fully read — no more polling
    this.launchedMs = null;
    this.startedMs = null;
  }
}

function resetRun(r) {
  r.journal = new Tail(r.journal.path);
  r.agentTails = new Map();
  r.agents = new Map();
  r.spend = new Spend();
  r.fromCache = false;
}

function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

const RUN_RE = /^wf_[\w-]{1,64}$/;

export class Tracker {
  constructor({ home = homedir(), now = () => Date.now(), alive = pidsAlive, cachePath = null, lang = envLang(), readBudget = READ_BUDGET } = {}) {
    this.lang = lang === "en" ? "en" : "ru";
    this.readBudget = readBudget;
    this.home = home;
    this.claude = join(home, ".claude");
    this.projects = join(this.claude, "projects");
    this.now = now;
    this.alive = alive;
    this.runs = new Map();
    this.sessions = new Map(); // sessionId → { pid, cwd, name, alive }
    this.sessionsAt = 0;
    this.broken = [];
    this.cachePath = cachePath;
    this.cache = this.loadCache();
    this.cacheDirty = false;
  }

  loadCache() {
    if (!this.cachePath) return {};
    try {
      const c = JSON.parse(readFileSync(this.cachePath, "utf8"));
      return c && c.v === 1 && c.runs && typeof c.runs === "object" ? c.runs : {};
    } catch {
      return {};
    }
  }
  saveCache() {
    if (!this.cachePath || !this.cacheDirty) return;
    this.cacheDirty = false;
    const runs = {};
    for (const r of this.runs.values()) if (r.settled && r.final) runs[r.key] = { sig: r.finalSig, spend: r.spend.toJSON(), agents: [...r.agents.entries()], phases: r.phases };
    try {
      mkdirSync(join(this.cachePath, ".."), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify({ v: 1, runs }), { mode: 0o600 });
    } catch {}
  }

  // Finding runs: subagents/workflows/wf_* directories and workflows/wf_*.json results within the window.
  discover() {
    const now = this.now();
    const seen = new Set();
    if (!existsSync(this.projects)) return seen;
    for (const p of safeReaddir(this.projects)) {
      if (p.startsWith(".")) continue;
      const pdir = join(this.projects, p);
      for (const s of safeReaddir(pdir)) {
        if (s.startsWith(".") || s.endsWith(".jsonl")) continue;
        const sdir = join(pdir, s);
        const found = new Map();
        for (const name of safeReaddir(join(sdir, "subagents", "workflows"))) {
          if (!RUN_RE.test(name)) continue;
          const st = safeStat(join(sdir, "subagents", "workflows", name, "journal.jsonl")) || safeStat(join(sdir, "subagents", "workflows", name));
          if (st) found.set(name, Math.max(found.get(name) || 0, st.mtimeMs));
        }
        for (const f of safeReaddir(join(sdir, "workflows"))) {
          if (!f.endsWith(".json")) continue;
          const name = f.slice(0, -5);
          if (!RUN_RE.test(name)) continue;
          const st = safeStat(join(sdir, "workflows", f));
          if (st) found.set(name, Math.max(found.get(name) || 0, st.mtimeMs));
        }
        for (const [runId, mtime] of found) {
          const key = `${p}/${s}/${runId}`;
          const known = this.runs.get(key);
          const finishedFile = existsSync(join(sdir, "workflows", `${runId}.json`));
          if (!known && now - mtime > WINDOW_MS) continue; // old — leave alone
          seen.add(key);
          if (!known) {
            const r = new Run({ key, runId, project: p, sessionId: s, sessionDir: sdir });
            r.lastActivityMs = mtime;
            r.firstSeenMs = now;
            // run start while there is no result: the run directory is created at start (birthtime; absent — ctime)
            const dst = safeStat(join(sdir, "subagents", "workflows", runId));
            r.startedMs = dst ? dst.birthtimeMs || dst.ctimeMs || null : null;
            r.name = scriptName(join(sdir, "workflows", "scripts"), runId);
            const c = this.cache[key];
            if (c && finishedFile) r.cached = c;
            this.runs.set(key, r);
          }
        }
      }
    }
    // files disappeared or the run is older than the window — forget it
    for (const [key, r] of this.runs) if (!seen.has(key) || now - r.lastActivityMs > WINDOW_MS) this.runs.delete(key);
    return seen;
  }

  refreshSessions(force = false) {
    const now = this.now();
    if (!force && now - this.sessionsAt < 10_000) return;
    this.sessionsAt = now;
    const map = new Map();
    const dir = join(this.claude, "sessions");
    for (const f of safeReaddir(dir)) {
      if (!/^\d+\.json$/.test(f)) continue; // *.key and the rest — not read
      try {
        const o = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (o && typeof o.sessionId === "string" && Number.isInteger(o.pid)) map.set(o.sessionId, { pid: o.pid, procStart: typeof o.procStart === "string" ? o.procStart : null, cwd: typeof o.cwd === "string" ? o.cwd : null, name: typeof o.name === "string" && o.name ? clean(o.name).slice(0, 60) : null, alive: false });
      } catch {}
    }
    // pid + the recorded start time: after a session crashes the file stays, and its pid may be taken by another process
    const alive = this.alive([...map.values()].map((s) => s.pid), new Map([...map.values()].filter((s) => s.procStart).map((s) => [s.pid, s.procStart])));
    for (const s of map.values()) s.alive = alive.has(s.pid);
    this.sessions = map;
    this.surfaces = readSurfaces(this.home);
  }

  // One tick: read the rest of the logs, agent transcripts, results.
  update() {
    let budget = this.readBudget;
    let changed = false;
    for (const r of this.runs.values()) {
      if (r.settled) {
        // the result may have been rewritten (resume) — compare the signature
        const st = safeStat(r.stateFile);
        if (st && `${st.mtimeMs}:${st.size}` === r.finalSig) continue;
        r.settled = false;
        if (r.fromCache) resetRun(r); // numbers from the cache — reread from scratch, otherwise they would be counted twice
      }
      changed = this.updateRun(r, () => budget, (n) => (budget -= n)) || changed;
    }
    return changed;
  }

  updateRun(r, getBudget, spendBudget) {
    let changed = false;
    // run result
    const st = safeStat(r.stateFile);
    if (st) {
      const sig = `${st.mtimeMs}:${st.size}`;
      if (sig !== r.finalSig) {
        try {
          let text;
          try {
            text = readFileSync(r.stateFile, "utf8");
          } catch {
            throw new Error("unreadable");
          }
          let o;
          try {
            o = JSON.parse(text);
          } catch {
            throw new Error("bad-json");
          }
          if (!o || typeof o !== "object" || typeof o.status !== "string") throw new Error("no-status");
          r.final = {
            status: o.status,
            name: typeof o.workflowName === "string" ? o.workflowName : null,
            durationMs: Number.isFinite(o.durationMs) ? o.durationMs : null,
            startTime: Number.isFinite(o.startTime) ? o.startTime : null,
            agentCount: Number.isFinite(o.agentCount) ? o.agentCount : null,
            hasError: o.error != null,
          };
          if (Array.isArray(o.phases)) {
            for (const ph of o.phases) if (ph && typeof ph.title === "string" && !r.phases.includes(ph.title)) r.phases.push(ph.title);
          }
          if (r.final.startTime && r.final.durationMs) r.lastActivityMs = Math.max(r.lastActivityMs, r.final.startTime + r.final.durationMs);
          r.broken = null;
        } catch (e) {
          r.broken = { file: `${r.runId}.json`, code: e.message === "no-status" ? "no-status" : e.message === "bad-json" ? "bad-json" : "unreadable" };
        }
        r.finalSig = sig;
        changed = true;
      }
    }
    // cache of a finished run: transcripts are not reread
    if (r.cached && r.final && r.cached.sig === r.finalSig) {
      r.spend.total = { ...r.cached.spend.total };
      r.spend.noKey = r.cached.spend.requests;
      r.agents = new Map(r.cached.agents);
      r.phases = r.cached.phases || r.phases;
      r.cached = null;
      r.settled = true;
      r.fromCache = true;
      return true;
    }
    r.cached = null;
    // Agent journal. pending — something is not fully read (the tick budget ran out, including mid-line):
    // a run with a result is then not settled, otherwise the unread part would be lost forever (including in the runs.json cache).
    let pending = false;
    for (;;) {
      const { lines, bytes, more } = r.journal.read(getBudget());
      spendBudget(bytes);
      for (const l of lines) changed = this.journalLine(r, l) || changed;
      if (more && (!bytes || getBudget() <= 0)) pending = true;
      if (!more || !bytes) break;
    }
    // agent transcripts
    for (const f of safeReaddir(r.dir)) {
      if (!/^agent-[\w-]+\.jsonl$/.test(f)) continue;
      let t = r.agentTails.get(f);
      if (!t) r.agentTails.set(f, (t = new Tail(join(r.dir, f))));
      for (;;) {
        const { lines, bytes, more } = t.read(getBudget());
        spendBudget(bytes);
        for (const l of lines) if (r.spend.addLine(l)) changed = true;
        if (more && (!bytes || getBudget() <= 0)) {
          pending = true;
          break;
        }
        if (!more) break;
      }
      const fst = safeStat(join(r.dir, f));
      if (fst && fst.mtimeMs > r.lastActivityMs) r.lastActivityMs = fst.mtimeMs;
    }
    const jst = safeStat(r.journal.path);
    if (jst && jst.mtimeMs > r.lastActivityMs) r.lastActivityMs = jst.mtimeMs;
    if (r.final && !pending) {
      r.settled = true;
      this.cacheDirty = true;
    }
    return changed;
  }

  journalLine(r, l) {
    if (!l.trim()) return false;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      return false;
    }
    if (!o || typeof o.type !== "string") return false;
    if (o.type === "launched") return false;
    const id = typeof o.agentId === "string" ? o.agentId : typeof o.key === "string" ? o.key : null;
    if (!id) return false;
    const a = r.agents.get(id) || { phase: null, state: "started" };
    if (o.type === "started") {
      a.state = "started";
      if (typeof o.phase === "string") {
        a.phase = o.phase.slice(0, 60);
        if (!r.phases.includes(a.phase)) r.phases.push(a.phase);
      }
    } else if (o.type === "result") a.state = "done";
    else if (o.type === "failed") a.state = "failed";
    else return false;
    r.agents.set(id, a);
    return true;
  }

  // Run state for output.
  view(r) {
    const now = this.now();
    const counts = { started: 0, done: 0, failed: 0 };
    let curPhase = null;
    for (const a of r.agents.values()) {
      counts[a.state]++;
      if (a.state === "started" && a.phase) curPhase = a.phase;
    }
    if (!curPhase) for (const a of r.agents.values()) if (a.phase) curPhase = a.phase;
    const sess = this.sessions.get(r.sessionId) || null;
    let state;
    if (r.final) state = /^(completed|done|success)$/i.test(r.final.status) ? "completed" : /^(running|in_progress)$/i.test(r.final.status) ? "running" : "failed";
    else if (sess?.alive || now - r.lastActivityMs < ACTIVE_QUIET_MS) state = "running";
    else if (now - r.lastActivityMs > ORPHAN_QUIET_MS) state = "orphaned";
    else state = "running";
    return { r, state, counts, curPhase, sess, name: r.final?.name || r.name || r.runId };
  }

  frame() {
    const now = this.now();
    const views = [...this.runs.values()].map((r) => this.view(r));
    const order = { running: 0, orphaned: 1, failed: 2, completed: 3 };
    views.sort((a, b) => order[a.state] - order[b.state] || b.r.lastActivityMs - a.r.lastActivityMs);
    const running = views.filter((v) => v.state === "running");
    const bad = views.filter((v) => v.state === "failed" || v.state === "orphaned");
    const en = this.lang === "en";
    const BROKEN = en ? { "no-status": "no status", "bad-json": "not JSON", unreadable: "can't be read" } : { "no-status": "нет status", "bad-json": "не JSON", unreadable: "не читается" };
    const broken = views.filter((v) => v.r.broken).map((v) => `${v.r.broken.file}: ${BROKEN[v.r.broken.code] || BROKEN.unreadable}`);
    let status = "ok";
    let title;
    let tile;
    // Header: failed and orphaned runs first (they need a look), then running ones, then "none".
    if (bad.length) {
      status = "wait";
      const b = bad[0];
      const nm = clean(b.name);
      // killed — the run was stopped (via /workflows): "stopped", not "failed"; wait and wf-failed stay
      const killed = (x) => x.state === "failed" && /kill/i.test(x.r.final?.status || "");
      if (b.state === "orphaned") title = en ? `Run "${nm}" lost its session` : `Прогон «${nm}» остался без сессии`;
      else if (killed(b)) title = en ? `Run "${nm}" was stopped` : `Прогон «${nm}» остановлен`;
      else title = en ? `Run "${nm}" failed — take a look` : `Прогон «${nm}» упал — посмотрите`;
      tile = en ? `${bad.length} failed` : `${bad.length} ${plural(bad.length, "упал", "упали", "упали")}`;
      if (bad.every((x) => x.state === "orphaned")) tile = en ? `${bad.length} lost` : `${bad.length} без сессии`;
      // the tile is short: the sidebar badge holds 6 chars (SidebarBadgeText), it truncated the Russian "1 stopped" to "1 st…"
      else if (bad.every(killed)) tile = en ? `${bad.length} stop` : `${bad.length} стоп`;
    } else if (running.length) {
      const ph = running[0].curPhase ? clean(running[0].curPhase) : null;
      const n = running.length;
      title = en ? `${n} ${plEn(n, "run", "runs")} in progress${ph && n === 1 ? ` · ${ph} phase` : ""}` : `${n} ${plural(n, "прогон идёт", "прогона идут", "прогонов идут")}${ph && n === 1 ? ` · фаза ${ph}` : ""}`;
      tile = en ? `${n} running` : `${n} ${plural(n, "идёт", "идут", "идут")}`;
    } else {
      title = en ? "No background runs — nothing to do" : "Фоновых прогонов нет — делать ничего не нужно";
      // "0 runs", not a bare "none": next to the tile label "none / Agents" it would read like a refusal
      tile = en ? "0 runs" : "0 прогонов";
    }
    if (broken.length && status === "ok") status = "unknown";
    // activity= — for the hub's "is it safe to shut down" verdict: running runs (empty — no runs, quiet)
    let activity = "";
    if (running.length) {
      const v0 = running[0];
      const since = v0.r.final?.startTime || v0.r.startedMs || v0.r.firstSeenMs;
      const dur = Number.isFinite(since) && since > 0 ? fmtDur(Math.max(0, now - since), this.lang) : null;
      if (running.length === 1) activity = en ? `Run "${clean(v0.name)}" in progress${dur ? `, ${dur}` : ""}` : `Прогон «${clean(v0.name)}» идёт${dur ? `, ${dur}` : ""}`;
      else {
        const nm = running.slice(0, 3).map((v) => clean(v.name)).join(", ") + (running.length > 3 ? (en ? `, ${running.length - 3} more` : `, ещё ${running.length - 3}`) : "");
        activity = en ? `${running.length} runs in progress: ${nm}` : `${running.length} ${plural(running.length, "прогон идёт", "прогона идут", "прогонов идут")}: ${nm}`;
      }
    }
    // tileLabel — the popover tile label: "Claude Code Background Agents" does not fit in the tile (~110 pt, one line)
    const head = line(title, { status, tile, tileLabel: en ? "Agents" : "Агенты", sfimage: running.length ? "gearshape.2" : bad.length ? "exclamationmark.triangle" : "gearshape", activity });
    const out = [activity ? head : `${head} activity=""`];
    if (running.length) {
      const sum = running.reduce((a, v) => a + v.r.spend.read, 0);
      out.push(line(en ? `Used ≈${fmtTokens(sum, "en")} tokens` : `Потрачено ≈${fmtTokens(sum)} токенов`, { color: "gray" }));
    }
    out.push("---");
    if (!views.length) out.push(line(en ? "No runs in the last 12 h" : "За 12 ч прогонов не было", { color: "gray" }));
    for (const v of views.slice(0, MAX_SHOWN)) out.push(...this.renderRun(v, now));
    if (views.length > MAX_SHOWN) out.push(line(en ? `…and ${views.length - MAX_SHOWN} more` : `…и ещё ${views.length - MAX_SHOWN}`, { color: "gray" }));
    if (broken.length) {
      out.push("---");
      out.push(line(en ? "Can't read run logs" : "Не получается прочитать журналы прогонов", { color: "orange", event: "source-broken" }));
      for (const b of broken.slice(0, 3)) out.push(line(`--${clean(b)}`, { color: "gray" }));
    }
    return out.join("\n");
  }

  renderRun(v, now) {
    const { r, state, counts, curPhase, sess } = v;
    const L = this.lang;
    const en = L === "en";
    const out = [];
    const name = clean(v.name);
    const total = r.final?.agentCount ?? counts.started + counts.done + counts.failed;
    if (state === "running") {
      out.push(line(en ? `${name} — running${curPhase ? `, ${clean(curPhase)} phase` : ""}` : `${name} — идёт${curPhase ? `, фаза ${clean(curPhase)}` : ""}`, { sfimage: "play.circle" }));
    } else if (state === "orphaned") {
      const q_ = fmtDur(now - r.lastActivityMs, L);
      out.push(line(en ? `${name} — no session, quiet for ${q_}` : `${name} — без сессии, тихо ${q_}`, { color: "orange", sfimage: "questionmark.circle", event: `wf-orphaned-${r.runId}` }));
    } else if (state === "failed") {
      const st = /kill/i.test(r.final.status) ? (en ? "stopped" : "остановлен") : en ? "failed" : "упал";
      const d = r.final.durationMs ? (en ? ` after ${fmtDur(r.final.durationMs, L)}` : ` через ${fmtDur(r.final.durationMs)}`) : "";
      out.push(line(`${name} — ${st}${d}`, { color: "red", sfimage: "xmark.octagon", event: `wf-failed-${r.runId}` }));
    } else {
      const d = r.final.durationMs ? (en ? ` in ${fmtDur(r.final.durationMs, L)}` : ` за ${fmtDur(r.final.durationMs)}`) : "";
      out.push(line(en ? `${name} — done${d}` : `${name} — готово${d}`, { sfimage: "checkmark.circle", color: "gray" }));
    }
    const agentParts = [];
    if (counts.started && state === "running") agentParts.push(en ? `${counts.started} working` : `${counts.started} ${plural(counts.started, "работает", "работают", "работают")}`);
    agentParts.push(en ? `${counts.done} done` : `${counts.done} готово`);
    if (counts.failed) agentParts.push(en ? `${counts.failed} with errors` : `${counts.failed} с ошибкой`);
    out.push(line(`--${en ? "Agents" : "Агенты"}: ${agentParts.join(", ")}${total ? (en ? ` (${total} total)` : ` (всего ${total})`) : ""}`, counts.failed ? { color: "orange" } : {}));
    if (r.phases.length) out.push(line(`--${en ? "Phases" : "Фазы"}: ${clean(r.phases.join(" → "))}`, { color: "gray" }));
    const t = r.spend.total;
    out.push(line(en ? `--Used ≈${fmtTokens(r.spend.read, L)} tokens` : `--Потрачено ≈${fmtTokens(r.spend.read)} токенов`));
    out.push(
      line(
        en
          ? `----Read ${fmtTokens(r.spend.read, L)} (cache read ${fmtTokens(t.cacheRead, L)}, cache write ${fmtTokens(t.cacheWrite, L)}; input ${fmtTokens(t.input, L)}), output ≥ ${fmtTokens(t.output, L)}, ${r.spend.requests} ${plEn(r.spend.requests, "request", "requests")}`
          : `----Прочитано ${fmtTokens(r.spend.read)} (кэш: чтение ${fmtTokens(t.cacheRead)}, запись ${fmtTokens(t.cacheWrite)}; вход ${fmtTokens(t.input)}), выход ≥ ${fmtTokens(t.output)}, ${r.spend.requests} ${plural(r.spend.requests, "запрос", "запроса", "запросов")}`,
        { color: "gray" },
      ),
    );
    const started = r.final?.startTime || null;
    if (started) out.push(line(`--${en ? "Started" : "Начат"} ${fmtTime(started, now, L)}`, { color: "gray" }));
    out.push(line(`--${en ? "Last activity" : "Последняя активность"}: ${fmtTime(r.lastActivityMs, now, L)}`, { color: "gray" }));
    const sname = sess?.name || projectLabel(r.project, sess?.cwd) || r.sessionId.slice(0, 8);
    const sstate = sess ? (sess.alive ? (en ? "open" : "открыта") : en ? "closed" : "закрыта") : en ? "not found" : "не найдена";
    out.push(line(en ? `--Session "${clean(sname)}" ${sstate}` : `--Сессия «${clean(sname)}» ${sstate}`, { color: "gray" }));
    const surf = this.surfaces?.get(r.sessionId);
    if (surf && (state === "running" || state === "orphaned")) out.push(line(en ? "--Switch to the session's tab" : "--Перейти во вкладку сессии", { effect: `cmux.focus ${surf.surfaceId} workspaceId=${surf.workspaceId}` }));
    if (state === "running") out.push(line(en ? "--Can only be stopped in the session's tab: /workflows" : "--Остановить можно только во вкладке сессии: /workflows", { color: "gray" }));
    return out;
  }

  events() {
    const ev = [];
    for (const r of this.runs.values()) {
      const v = this.view(r);
      if (v.state === "failed") ev.push(`wf-failed-${r.runId}`);
      if (v.state === "orphaned") ev.push(`wf-orphaned-${r.runId}`);
    }
    return ev;
  }

  tick({ discover = false } = {}) {
    if (discover || !this.discovered) {
      this.discover();
      this.discovered = true;
    }
    this.refreshSessions(discover);
    this.update();
    this.saveCache();
    return this.frame();
  }
}

// cmux tabs: ~/.cmuxterm/claude-hook-sessions.json → Map(sessionId → {surfaceId, workspaceId}).
// Only identifiers are taken; lastBody/lastSubtitle/launchCommand and the rest are not read.
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
export function readSurfaces(home) {
  const map = new Map();
  try {
    const o = JSON.parse(readFileSync(join(home, ".cmuxterm", "claude-hook-sessions.json"), "utf8"));
    const list = o && o.sessions && typeof o.sessions === "object" ? Object.values(o.sessions) : [];
    for (const s of list) {
      if (!s || typeof s.sessionId !== "string" || !UUID_RE.test(s.surfaceId || "") || !UUID_RE.test(s.workspaceId || "")) continue;
      map.set(s.sessionId, { surfaceId: s.surfaceId, workspaceId: s.workspaceId });
    }
  } catch {}
  return map;
}

// Run name from the scenario file: workflows/scripts/<name>-<runId>.js
export function scriptName(dir, runId) {
  for (const f of safeReaddir(dir)) {
    const suf = `-${runId}.js`;
    if (f.endsWith(suf)) return f.slice(0, -suf.length) || null;
  }
  return null;
}

function projectLabel(project, cwd) {
  if (cwd) return cwd.replace(/^\/Users\/[^/]+/, "~");
  return project.replace(/^-Users-[^-]+-?/, "~/").replace(/^~\/$/, "~");
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// "Thu Oct 22 20:46:52 2026" as UTC time → epoch seconds (procStart in sessions/*.json is `ps -o lstart` with TZ=UTC).
export function parseLstartUtc(text) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(String(text));
  if (!m || !(m[1] in MONTHS)) return null;
  return Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
}

// Whether the process start time matches the recorded one; a whole number of hours difference (up to 14) is the same second in another
// zone. null — nothing to compare with. Same as in the claude-sessions plugin.
export function sameStart(psSec, recordedSec) {
  if (psSec == null || recordedSec == null) return null;
  const d = Math.abs(psSec - recordedSec);
  if (d <= 2) return true;
  if (d <= 14 * 3600 + 2) {
    const r = d % 3600;
    if (r <= 2 || r >= 3598) return true;
  }
  return false;
}

// `TZ=UTC ps -o pid=,lstart= -p …` → Map pid → epoch seconds. A ps failure gives an empty map (no check, liveness by signal).
export function psStartsUtc(pids) {
  const out = new Map();
  if (!pids.length || process.platform === "win32") return out;
  let text = "";
  try {
    text = execFileSync("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" }, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    text = String(e?.stdout || ""); // ps exits with 1 if some of the pids are gone, but prints the live ones
  }
  for (const l of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    const sec = parseLstartUtc(m[2]);
    if (sec !== null) out.set(Number(m[1]), sec);
  }
  return out;
}

// Live pids (kill(pid, 0) — no signals to processes). procStarts — pid → the session's recorded procStart: if the
// process start time does not match it, the pid is taken by another process and the session is dead.
export function pidsAlive(pids, procStarts = new Map(), { psStarts = psStartsUtc } = {}) {
  const list = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  const out = new Set();
  if (!list.length) return out;
  // Signal 0: only an existence check, nothing reaches the process. Works on Windows too (no ps).
  // EPERM — the process exists but belongs to someone else: considered alive (unless the start time says otherwise).
  for (const pid of list) {
    try {
      process.kill(pid, 0);
      out.add(pid);
    } catch (e) {
      if (e && e.code === "EPERM") out.add(pid);
    }
  }
  const check = [...out].filter((p) => procStarts.has(p));
  if (check.length) {
    const starts = psStarts(check);
    for (const pid of check) if (sameStart(starts.get(pid), parseLstartUtc(procStarts.get(pid))) === false) out.delete(pid);
  }
  return out;
}

// ---------- plugin process ----------
function main() {
  const tickMs = Math.max(500, Number(process.env.AGENTHUB_AGENTS_TICK_MS) || 3000);
  const cacheDir = process.env.AGENTHUB_PLUGIN_CACHE_PATH;
  const tracker = new Tracker({ cachePath: cacheDir ? join(cacheDir, "runs.json") : null });
  let lastText = null;
  let lastAt = 0;
  let n = 0;
  const emit = (opts) => {
    let text;
    try {
      text = tracker.tick(opts);
    } catch (e) {
      text = [line(envLang() === "en" ? "Can't read run logs" : "Не получается прочитать журналы прогонов", { status: "unknown", event: "source-broken" }), "---", line(clean(e.message), { color: "gray" })].join("\n");
    }
    const now = Date.now();
    if (text !== lastText || now - lastAt > 60_000) {
      process.stdout.write(text + "\n~~~\n");
      lastText = text;
      lastAt = now;
    }
  };
  emit({ discover: true });
  const timer = setInterval(() => emit({ discover: ++n % 5 === 0 }), tickMs);
  createInterface({ input: process.stdin }).on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m && (m.type === "refresh" || m.type === "fileChanged")) {
      lastText = null;
      emit({ discover: true });
    }
  });
  process.stdin.on("end", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

// Run as a program (not imported from tests). Paths are compared via realpath: /tmp → /private/tmp.
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) main();
