#!/usr/bin/env node
// Codex CLI sessions: which Codex sessions are alive, which are working, in which folder, with which model and effort.
//
// <agenthub.title>Codex Сессии</agenthub.title>
// <agenthub.title lang="en">Codex Sessions</agenthub.title>
// <agenthub.version>0.1.1</agenthub.version>
// <agenthub.author.name>Kensei</agenthub.author.name>
// <agenthub.author.github>KenseiTheOne</agenthub.author.github>
// <agenthub.desc>Живые сессии Codex: кто работает, кто свободен, папка, модель и effort, переход во вкладку</agenthub.desc>
// <agenthub.desc lang="en">Live Codex sessions: who's working, who's idle, the folder, model and effort, switching to the tab</agenthub.desc>
// <agenthub.requires name="Codex" url="https://github.com/openai/codex" check="~/.codex">агент, чьи сессии показывает плагин</agenthub.requires>
// <agenthub.requires lang="en" name="Codex">the agent whose sessions this plugin shows</agenthub.requires>
// <agenthub.status value="ok" label="Сессии видны">Список живых сессий Codex прочитан</agenthub.status>
// <agenthub.status value="ok" lang="en" label="Sessions visible">The list of live Codex sessions was read</agenthub.status>
// <agenthub.status value="unknown" label="Не видно сессий">Список сессий не читается — причина в первой строке</agenthub.status>
// <agenthub.status value="unknown" lang="en" label="Can't see sessions">The session list can't be read — the reason is in the first line</agenthub.status>
// <agenthub.type>streamable</agenthub.type>
// <agenthub.platforms>macos</agenthub.platforms>
// <agenthub.watch>~/.codex/thread-writer-locks/*.lock — сессия Codex началась или закончилась</agenthub.watch>
// <agenthub.watch lang="en">~/.codex/thread-writer-locks/*.lock — a Codex session started or ended</agenthub.watch>
// <agenthub.fsRead>~/.codex/thread-writer-locks/*.lock — только имена файлов (id сессии); сами файлы не открываются и не блокируются</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/thread-writer-locks/*.lock — file names only (the session id); the files are never opened or locked</agenthub.fsRead>
// <agenthub.fsRead>~/.codex/state_5.sqlite — только чтение, таблица threads: id, cwd, source, model, reasoning_effort, name, agent_nickname, agent_role, created_at_ms, updated_at_ms, rollout_path, и thread_spawn_edges; name — имя сессии, его может придумать сам Codex по первому сообщению (как заголовки сессий Claude Code) и оно показывается в строке; title, preview и первое сообщение не выбираются</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/state_5.sqlite — read-only, the threads table: id, cwd, source, model, reasoning_effort, name, agent_nickname, agent_role, created_at_ms, updated_at_ms, rollout_path, and thread_spawn_edges; name is the session's name, which Codex may generate from the first prompt (like Claude Code session titles), and it is shown in the row; title, preview and the first message are never selected</agenthub.fsRead>
// <agenthub.fsRead>~/.codex/sessions/*/*/*/rollout-*.jsonl — с конца файла назад до начала текущего хода (не больше 16 МБ), дальше только дописанное: из строк task_started, task_complete, turn_aborted, turn_context только тип, turn_id, started_at, модель и effort; текст переписки не берётся</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/sessions/*/*/*/rollout-*.jsonl — back from the end to the current turn's start (at most 16 MB), then only what was appended: from task_started, task_complete, turn_aborted and turn_context lines only the type, turn_id, started_at, model and effort; no conversation text is taken</agenthub.fsRead>
// <agenthub.fsRead>~/.codex/config.toml — только model и model_reasoning_effort верхнего уровня: модель и effort по умолчанию</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/config.toml — only the top-level model and model_reasoning_effort: the default model and effort</agenthub.fsRead>
// <agenthub.fsRead>~/.codex/models_cache.json — slug и default_reasoning_level моделей: effort модели по умолчанию</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/models_cache.json — models' slug and default_reasoning_level: a model's default effort</agenthub.fsRead>
// <agenthub.exec>/usr/sbin/lsof -Fpn -- <файлы блокировок> — какой процесс держит блокировку сессии (живая ли она)</agenthub.exec>
// <agenthub.exec lang="en">/usr/sbin/lsof -Fpn -- <lock files> — which process holds a session's lock (is it alive)</agenthub.exec>
// <agenthub.exec>/usr/sbin/lsof -a -d cwd -Fpn -p <pid,…> — рабочая папка процессов codex во вкладках: сопоставить сессию фонового сервера Codex с вкладкой</agenthub.exec>
// <agenthub.exec lang="en">/usr/sbin/lsof -a -d cwd -Fpn -p <pid,…> — the working folder of codex processes in tabs: match a session hosted by the Codex background server to its tab</agenthub.exec>
// <agenthub.exec>/bin/ps -A -o pid=,ppid=,tty=,lstart=,comm= — дерево процессов: вкладка (tty) процесса, время его запуска и запущен ли он в cmux; аргументы команд не читаются</agenthub.exec>
// <agenthub.exec lang="en">/bin/ps -A -o pid=,ppid=,tty=,lstart=,comm= — the process tree: a process's tab (tty), its start time and whether it runs in cmux; command arguments are not read</agenthub.exec>
// <agenthub.exec>/usr/bin/sqlite3 -readonly -json — запасной способ прочитать state_5.sqlite, если в node нет node:sqlite</agenthub.exec>
// <agenthub.exec lang="en">/usr/bin/sqlite3 -readonly -json — a fallback to read state_5.sqlite when node has no node:sqlite</agenthub.exec>
// <agenthub.effects>session.focus</agenthub.effects>
// <agenthub.contract>3</agenthub.contract>
// <agenthub.icon symbol="terminal" color="#10A37F"></agenthub.icon>
//
// Alive = a file in ~/.codex/thread-writer-locks/<threadId>.lock held by a process: Codex holds an advisory lock on it for
// as long as a process writes that session's file, and deletes it at the end. The plugin never opens or locks these
// files; `lsof` names the holder. A lock file nobody holds is a leftover — not a live session.
//
// The holder is the process that owns the session: a terminal Codex (it has a tty — that's the tab), `codex exec` (a
// background run), or Codex's background server (no tty). Since Codex 0.15x the terminal UI hands its sessions to the
// shared background server, so the holder usually has no tab; for a terminal (`cli`) session the plugin then looks for
// the terminal codex process with the same working folder that was already running when the session was created, and
// takes it only when exactly one such process and one such session exist. Otherwise the row is shown without a process
// (no tab switch, no hub registration). A session resumed in a newer tab therefore stays without a tab.
//
// Rows: one per interactive session (`cli`, IDE); `codex exec` runs carry a "background" tag; spawned subagents are nested
// under their parent; Codex's own auto_review (Guardian) threads are not shown. An interactive session with a tab gets
// `agentSession=<threadId> pid=<pid> agent=codex` (the hub lists it in externalSessions) and, outside cmux, a "Switch to
// tab" button (session.focus). In cmux the hub can't find a non-Claude tab, so no button there.
//
// Working vs idle: a task_started without a later task_complete or turn_aborted with the same turn_id means a turn is
// running. The state is kept per file between polls (RolloutTurns), so a long turn stays "working". "Waiting for approval" is not written to files, so it isn't shown.
// Model and effort: the last turn_context; effort falls back to the thread record, config.toml model_reasoning_effort and
// the model's default_reasoning_level in models_cache.json.
//
// Never: open/lock a lock file, start Codex or its background server, select titles or messages from the database,
// parse a rollout line other than the four types above (they are matched by regular expressions, never JSON-parsed).
//
// For tests: AGENTHUB_TEST_BIN_DIR (lsof/ps/sqlite3 doubles), AGENTHUB_TEST_POLL_MS, AGENTHUB_TEST_NOW,
// AGENTHUB_CODEX_NO_NODE_SQLITE=1 (use the sqlite3 fallback).

import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 256 * 1024;
// Codex's ReasoningEffort values (protocol/src/openai_models.rs)
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:()[\]/+-]{0,63}$/;

// ---------- helpers ----------
export function clean(text, max = 120, { keepPrefix = false } = {}) {
  let s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\|/g, "¦").replace(/\s+/g, " ").trim();
  if (!keepPrefix) s = s.replace(/^[-~]+/, "").trim();
  if ([...s].length > max) s = [...s].slice(0, max - 1).join("") + "…";
  return s;
}
const q = (v) => `"${clean(v, 300, { keepPrefix: true }).replace(/["\\]/g, "\\$&")}"`;
export function envLang() {
  return process.env.AGENTHUB_LANG === "en" ? "en" : "ru";
}
const pad2 = (n) => String(n).padStart(2, "0");
export function homeShort(p, home = homedir()) {
  const h = String(home || "").replace(/\/+$/, "");
  if (!h || !p) return p;
  if (p === h) return "~";
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}
export function codexHome(env = process.env, home = homedir()) {
  const h = env.CODEX_HOME;
  return h && h.startsWith("/") ? h : join(home, ".codex");
}
// A system tool: the test double from AGENTHUB_TEST_BIN_DIR, otherwise the fixed path.
function bin(name, fixed) {
  const dir = process.env.AGENTHUB_TEST_BIN_DIR;
  return dir ? join(dir, name) : fixed;
}
// execFile → { ok, out, err: short code }. `exit1Ok`: exit 1 is an answer, not a failure — lsof exits 1 when some (or
// all) of the files or processes it was asked about aren't open by anyone, and its output (maybe empty) is still right.
// A spawn error, a timeout or another exit code is a failure.
function run(file, args, { timeout = 5000, maxBuffer = 8 * 1024 * 1024, exit1Ok = false } = {}) {
  return new Promise((res) => {
    execFile(file, args, { timeout, maxBuffer, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", HOME: homedir() } }, (e, out) => {
      const text = String(out || "");
      if (!e || (exit1Ok && e.code === 1 && !e.killed && !e.signal)) res({ ok: true, out: text });
      else res({ ok: false, out: text, err: e.killed || e.signal ? "timeout" : /^[A-Z][A-Z0-9_]{1,30}$/.test(String(e.code)) ? e.code : `exit ${e.code}` });
    });
  });
}

// ---------- live sessions: lock files and their holders ----------
// Lock file names → thread ids (the .coordination.lock and anything not a UUID are ignored).
export function lockIds(codex) {
  let names;
  try {
    names = readdirSync(join(codex, "thread-writer-locks"));
  } catch {
    return null; // no folder
  }
  return names.filter((n) => n.endsWith(".lock") && UUID_RE.test(n.slice(0, -5))).map((n) => n.slice(0, -5).toLowerCase());
}
// `lsof -Fpn` output → Map(path → pid)
export function parseLsof(text) {
  const map = new Map();
  let pid = null;
  for (const l of String(text).split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1)) || null;
    else if (l.startsWith("n") && pid) {
      const path = l.slice(1);
      if (!map.has(path)) map.set(path, pid);
    }
  }
  return map;
}
// `ps -A -o pid=,ppid=,tty=,lstart=,comm=` → Map(pid → { pid, ppid, tty|null, startMs|null, comm }). lstart (LANG=C) is
// "Sun Nov 22 09:00:05 2026" in local time; without it the line is pid, ppid, tty, comm.
const LSTART_RE = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function parsePs(text) {
  const map = new Map();
  for (const l of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const tty = m[3] === "??" || m[3] === "-" ? null : m[3];
    let rest = m[4];
    let startMs = null;
    const st = LSTART_RE.exec(rest);
    if (st) {
      startMs = new Date(Number(st[6]), MONTHS.indexOf(st[1]), Number(st[2]), Number(st[3]), Number(st[4]), Number(st[5])).getTime();
      rest = rest.slice(st[0].length);
    }
    map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty, startMs, comm: rest.trim() });
  }
  return map;
}
export const isCodexComm = (comm) => /(^|\/)codex(-[A-Za-z0-9_.-]+)?$/.test(String(comm || "").replace(/^-/, ""));
// Is the process inside cmux (an ancestor's executable is cmux)?
export function inCmux(pid, procs) {
  let p = procs.get(pid);
  for (let i = 0; p && i < 64; i++) {
    if (/(^|\/)cmux([^/]*)$/i.test(p.comm) || /cmux\.app\//i.test(p.comm)) return true;
    if (p.ppid <= 1) break;
    p = procs.get(p.ppid);
  }
  return false;
}

// ---------- the thread database (read-only) ----------
const COLS = "id, cwd, source, model, reasoning_effort, name, agent_nickname, agent_role, created_at_ms, updated_at_ms, rollout_path";
let nodeSqlite;
async function loadNodeSqlite() {
  if (nodeSqlite !== undefined) return nodeSqlite;
  if (process.env.AGENTHUB_CODEX_NO_NODE_SQLITE === "1") return (nodeSqlite = null);
  try {
    const origEmit = process.emitWarning;
    process.emitWarning = () => {}; // an older node marks node:sqlite experimental on stderr
    try {
      nodeSqlite = (await import("node:sqlite")).DatabaseSync || null;
    } finally {
      process.emitWarning = origEmit;
    }
  } catch {
    nodeSqlite = null;
  }
  return nodeSqlite;
}
// Thread rows and spawn edges for the given ids → { rows: Map(id → row), parents: Map(child → parent), error }
export async function readThreads(codex, ids) {
  const db = join(codex, "state_5.sqlite");
  const out = { rows: new Map(), parents: new Map(), error: null };
  if (!ids.length) return out;
  if (!existsSync(db)) {
    out.error = "no-db";
    return out;
  }
  const list = ids.filter((x) => UUID_RE.test(x));
  const inList = list.map((x) => `'${x}'`).join(",");
  const sqlRows = `SELECT ${COLS} FROM threads WHERE id IN (${inList})`;
  const sqlEdges = `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges WHERE child_thread_id IN (${inList})`;
  let rows = [];
  let edges = [];
  const D = await loadNodeSqlite();
  if (D) {
    let h;
    try {
      h = new D(db, { readOnly: true });
      rows = h.prepare(sqlRows).all();
      try {
        edges = h.prepare(sqlEdges).all();
      } catch {}
    } catch (e) {
      out.error = /locked|busy/i.test(String(e?.message)) ? "db-busy" : "db-read";
    } finally {
      try {
        h?.close();
      } catch {}
    }
  } else {
    const uri = `file:${db}?mode=ro`;
    const r = await run(bin("sqlite3", "/usr/bin/sqlite3"), ["-readonly", "-json", uri, sqlRows]);
    if (!r.ok) out.error = `sqlite3:${r.err}`;
    else {
      try {
        rows = r.out.trim() ? JSON.parse(r.out) : [];
      } catch {
        out.error = "sqlite3:not-json";
      }
      const e = await run(bin("sqlite3", "/usr/bin/sqlite3"), ["-readonly", "-json", uri, sqlEdges]);
      try {
        edges = e.ok && e.out.trim() ? JSON.parse(e.out) : [];
      } catch {}
    }
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.id !== "string") continue;
    out.rows.set(r.id.toLowerCase(), {
      id: r.id.toLowerCase(),
      cwd: typeof r.cwd === "string" ? r.cwd : null,
      source: typeof r.source === "string" ? r.source : null,
      model: typeof r.model === "string" ? r.model : null,
      effort: typeof r.reasoning_effort === "string" ? r.reasoning_effort : null,
      name: typeof r.name === "string" && r.name.trim() ? r.name : null,
      nickname: typeof r.agent_nickname === "string" && r.agent_nickname.trim() ? r.agent_nickname : null,
      role: typeof r.agent_role === "string" && r.agent_role.trim() ? r.agent_role : null,
      createdAtMs: Number(r.created_at_ms) || null,
      updatedAtMs: Number(r.updated_at_ms) || null,
      rolloutPath: typeof r.rollout_path === "string" ? r.rollout_path : null,
    });
  }
  for (const e of Array.isArray(edges) ? edges : []) {
    if (typeof e?.child_thread_id === "string" && typeof e?.parent_thread_id === "string") out.parents.set(e.child_thread_id.toLowerCase(), e.parent_thread_id.toLowerCase());
  }
  return out;
}
// The `source` column/field → { kind: cli|ide|exec|sub|other, parent: id|null, label }
export function sourceKind(src) {
  let s = src;
  if (typeof s === "string" && s.startsWith("{")) {
    try {
      s = JSON.parse(s);
    } catch {}
  }
  if (typeof s === "string") {
    if (s === "cli") return { kind: "cli", parent: null };
    if (s === "vscode" || s === "ide") return { kind: "ide", parent: null };
    if (s === "exec") return { kind: "exec", parent: null };
    if (s === "mcp") return { kind: "other", parent: null };
    return { kind: "other", parent: null };
  }
  if (s && typeof s === "object" && s.subagent !== undefined) {
    const sub = s.subagent;
    let parent = null;
    let what = null;
    if (sub && typeof sub === "object") {
      const spawn = sub.thread_spawn || sub.threadSpawn;
      if (spawn && typeof spawn.parent_thread_id === "string") parent = spawn.parent_thread_id.toLowerCase();
      what = typeof sub.other === "string" ? sub.other : Object.keys(sub)[0] || null;
    } else if (typeof sub === "string") what = sub;
    return { kind: "sub", parent, what: what ? clean(what, 30) : null };
  }
  return { kind: "other", parent: null };
}

// ---------- the rollout turn state ----------
// A rollout path from the database, only inside <codex>/sessions or <codex>/archived_sessions.
export function safeRollout(codex, p) {
  if (typeof p !== "string" || !p.endsWith(".jsonl")) return null;
  const abs = resolve(p);
  for (const dir of ["sessions", "archived_sessions"]) if (abs.startsWith(join(codex, dir) + "/")) return abs;
  return null;
}
// Without the database: sessions/YYYY/MM/DD/rollout-*-<id>.jsonl, newest days first (at most 60 day folders).
export function findRollout(codex, id) {
  const root = join(codex, "sessions");
  const desc = (p) => {
    try {
      return readdirSync(p).filter((n) => /^\d{1,4}$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        if (++days > 60) return null;
        try {
          const f = readdirSync(join(root, y, m, d)).find((n) => n.startsWith("rollout-") && n.endsWith(`-${id}.jsonl`));
          if (f) return join(root, y, m, d, f);
        } catch {}
      }
  return null;
}
// The first line of a rollout (session_meta) → { cwd, source, createdAtMs (the line's time) } by regular expressions only.
function readHeadMeta(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(64 * 1024);
    const got = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.toString("utf8", 0, got).split("\n")[0];
    if (!/^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"session_meta"/.test(first)) return null;
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(first)?.[1];
    const createdAtMs = Date.parse(/^\{"timestamp":"([^"]*)"/.exec(first)?.[1] || "") || null;
    let source = /"source":"(\w+)"/.exec(first)?.[1] || null;
    // Codex's own approval reviewer (auto_review): a guardian subagent or a guardian_review thread
    if (/"source":\{"subagent":\{"other":"guardian"\}|"thread_source":"guardian_review"/.test(first)) source = '{"subagent":{"other":"guardian"}}';
    else if (!source && /"source":\{"subagent"/.test(first)) source = '{"subagent":null}';
    return { cwd: cwd ? JSON.parse(`"${cwd}"`) : null, source, createdAtMs };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// The line's own type, read from the line's head: {"timestamp":…,"ordinal":…,"type":"<t>","payload":{"type":"<pt>"…
const LINE_HEAD = /^\{"timestamp":"([^"]*)",(?:"ordinal":\d+,)?"type":"(\w+)","payload":\{(?:"type":"(\w+)")?/;
// Turn state from rollout lines. Only task_started / task_complete / turn_aborted and turn_context lines are looked at,
// and only their turn_id, started_at, model and effort fields — by regular expression.
const MAX_OPEN_TURNS = 32;
const newTurnState = () => ({ open: new Map(), model: null, effort: null, lastAtMs: null });
const TURN_EVENT = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"\w+","turn_id":"([^"]+)"/;
function applyLine(st, l) {
  const h = LINE_HEAD.exec(l);
  if (!h) return;
  const at = Date.parse(h[1]);
  if (Number.isFinite(at)) st.lastAtMs = at;
  const [, , type, ptype] = h;
  if (type === "event_msg" && (ptype === "task_started" || ptype === "task_complete" || ptype === "turn_aborted")) {
    const turn = TURN_EVENT.exec(l)?.[1] || /"turn_id":"([^"]+)"/.exec(l.slice(0, 400))?.[1];
    if (ptype === "task_started") {
      const s = Number(/"started_at":(\d+)/.exec(l.slice(0, 600))?.[1]);
      st.open.set(turn || `?${st.open.size}`, Number.isFinite(s) && s > 0 ? s * 1000 : at);
      if (st.open.size > MAX_OPEN_TURNS) st.open.delete(st.open.keys().next().value);
    } else if (turn) st.open.delete(turn);
    else st.open.clear();
  } else if (type === "turn_context") {
    // payload keys come in a fixed order: turn_id, …, model, …, collaboration_mode{mode, settings{model, reasoning_effort, …}}
    const m = /"model":"([^"\\]{1,64})"/.exec(l)?.[1];
    if (m) st.model = m;
    st.effort = /"effort":"(\w+)"/.exec(l)?.[1] || /"reasoning_effort":"(\w+)"/.exec(l)?.[1] || null;
  }
}
function turnSummary(st) {
  const starts = [...st.open.values()];
  return { busy: starts.length > 0, turnStartedMs: starts.length ? Math.min(...starts) : null, model: st.model, effort: st.effort, lastAtMs: st.lastAtMs };
}
// Lines → { busy, turnStartedMs, model, effort, lastAtMs }: a task_started without a later task_complete or turn_aborted
// with the same turn_id is a running turn.
export function tailState(lines) {
  const st = newTurnState();
  for (const l of lines) applyLine(st, l);
  return turnSummary(st);
}

// Per-rollout turn state kept between polls, so a long turn whose task_started has scrolled far back is still seen as
// running. The first look scans back from the end in TAIL_BYTES chunks until the region holds a task_started and a
// turn_context (or the file start, or SCAN_CAP); then each poll reads only the appended complete lines. The state is
// reset when the file is replaced (inode), truncated, rewritten (the bytes before the offset changed) or grew by more
// than SCAN_CAP since the last poll. Memory per file: a few open turn ids and a 64-byte check.
const SCAN_CAP = 16 * 1024 * 1024;
const CHECK_BYTES = 64;
const HAS_START = /"type":"event_msg","payload":\{"type":"task_started"/;
const HAS_CONTEXT = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"turn_context"/m;
function readAt(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  const got = readSync(fd, buf, 0, len, pos);
  return got === len ? buf : buf.subarray(0, got);
}
export class RolloutTurns {
  constructor({ chunk = TAIL_BYTES, cap = SCAN_CAP } = {}) {
    this.chunk = chunk;
    this.cap = cap;
    this.files = new Map(); // path → { ino, offset, check, st }
  }
  // → { busy, turnStartedMs, model, effort, lastAtMs } | null (unreadable)
  state(path) {
    let fd;
    try {
      fd = openSync(path, "r");
      const { ino, size } = fstatSync(fd);
      let f = this.files.get(path);
      if (f && (f.ino !== ino || size < f.offset || size - f.offset > this.cap || (f.offset > 0 && !readAt(fd, Math.max(0, f.offset - CHECK_BYTES), Math.min(CHECK_BYTES, f.offset)).equals(f.check)))) f = null;
      if (!f) {
        f = { ino, offset: 0, check: Buffer.alloc(0), st: newTurnState() };
        this.scanBack(fd, size, f);
      } else if (size > f.offset) this.readFrom(fd, size, f);
      this.files.set(path, f);
      return turnSummary(f.st);
    } catch {
      this.files.delete(path);
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  // complete lines of buf (starting at file position pos, `cutFirst` when pos is mid-line) → the state; f.offset after
  // the last newline
  feed(buf, pos, f, cutFirst, fd) {
    const nl = buf.lastIndexOf(10);
    if (nl < 0) return;
    const lines = buf.toString("utf8", 0, nl).split("\n");
    if (cutFirst) lines.shift();
    for (const l of lines) applyLine(f.st, l);
    f.offset = pos + nl + 1;
    f.check = Buffer.from(readAt(fd, Math.max(0, f.offset - CHECK_BYTES), Math.min(CHECK_BYTES, f.offset)));
  }
  scanBack(fd, size, f) {
    let start = size;
    let sawStart = false;
    let sawContext = false;
    while (start > 0 && size - start < this.cap && !(sawStart && sawContext)) {
      const from = Math.max(0, start - this.chunk, size - this.cap);
      // a little overlap, so a line head split between two chunks is still seen
      const piece = readAt(fd, from, Math.min(start - from + 512, size - from)).toString("utf8");
      sawStart ||= HAS_START.test(piece);
      sawContext ||= HAS_CONTEXT.test(piece);
      start = from;
    }
    this.feed(readAt(fd, start, size - start), start, f, start > 0, fd);
  }
  readFrom(fd, size, f) {
    this.feed(readAt(fd, f.offset, size - f.offset), f.offset, f, false, fd);
  }
  // forget files not looked at in this poll
  keepOnly(paths) {
    for (const p of this.files.keys()) if (!paths.has(p)) this.files.delete(p);
  }
}

// ---------- defaults: config.toml and models_cache.json ----------
// Top-level `model = "…"` and `model_reasoning_effort = "…"` (before the first [table]).
export function readConfigDefaults(codex) {
  const out = { model: null, effort: null };
  let text;
  try {
    text = readFileSync(join(codex, "config.toml"), "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("[")) break;
    const m = /^(model|model_reasoning_effort)\s*=\s*"([^"]{1,64})"/.exec(l);
    if (m) out[m[1] === "model" ? "model" : "effort"] = m[2];
  }
  return out;
}
// models_cache.json → Map(slug → default_reasoning_level)
export function readModelDefaults(codex) {
  const map = new Map();
  try {
    const j = JSON.parse(readFileSync(join(codex, "models_cache.json"), "utf8"));
    for (const m of Array.isArray(j?.models) ? j.models : []) if (typeof m?.slug === "string" && typeof m.default_reasoning_level === "string") map.set(m.slug, m.default_reasoning_level);
  } catch {}
  return map;
}

// ---------- one poll ----------
// → { installed, sessions: [...], problems: [...] }
const defaultTurns = new RolloutTurns();
export async function collect({ codex = codexHome(), home = homedir(), turns = defaultTurns } = {}) {
  const ids = lockIds(codex);
  if (ids === null) return { installed: existsSync(codex), sessions: [], problems: [] };
  if (!ids.length) return { installed: true, sessions: [], problems: [] };
  const problems = [];
  const lockDir = join(codex, "thread-writer-locks");
  const lockPaths = ids.map((id) => join(lockDir, `${id}.lock`));
  const [lsof, ps] = await Promise.all([run(bin("lsof", "/usr/sbin/lsof"), ["-Fpn", "--", ...lockPaths], { exit1Ok: true }), run(bin("ps", "/bin/ps"), ["-A", "-o", "pid=,ppid=,tty=,lstart=,comm="])]);
  if (!lsof.ok) problems.push(`lsof:${lsof.err}`);
  if (!ps.ok) problems.push(`ps:${ps.err}`);
  const holders = parseLsof(lsof.out);
  const procs = parsePs(ps.out);
  // lsof may print the resolved path (/private/var… for /var…): match by file name
  const holderOf = new Map();
  for (const [p, pid] of holders) {
    const n = basename(p);
    if (n.endsWith(".lock")) holderOf.set(n.slice(0, -5).toLowerCase(), pid);
  }
  const live = ids.filter((id) => holderOf.has(id));
  if (!live.length) {
    turns.keepOnly(new Set());
    return { installed: true, sessions: [], problems };
  }
  const db = await readThreads(codex, live);
  if (db.error && db.error !== "no-db") problems.push(`db:${db.error}`);
  const cfg = readConfigDefaults(codex);
  const modelDefaults = readModelDefaults(codex);
  const sessions = [];
  const looked = new Set();
  for (const id of live) {
    const row = db.rows.get(id) || null;
    let rollout = row ? safeRollout(codex, row.rolloutPath) : null;
    if (!rollout) rollout = findRollout(codex, id);
    const head = !row && rollout ? readHeadMeta(rollout) : null;
    const src = sourceKind(row?.source ?? head?.source ?? null);
    // Codex's auto_review threads are not the user's sessions: they only check one command of the session they serve
    if (src.kind === "sub" && src.what === "guardian") continue;
    if (rollout) looked.add(rollout);
    const st = (rollout && turns.state(rollout)) || { busy: false, model: null, effort: null, lastAtMs: null, turnStartedMs: null };
    const model = st.model || row?.model || cfg.model || null;
    let effort = st.effort || row?.effort || null;
    let effortFrom = effort ? "turn" : null;
    if (!effort && cfg.effort) [effort, effortFrom] = [cfg.effort, "config"];
    if (!effort && model && modelDefaults.has(model)) [effort, effortFrom] = [modelDefaults.get(model), "model"];
    const holder = holderOf.get(id);
    const hp = procs.get(holder) || null;
    sessions.push({
      id,
      kind: src.kind,
      subWhat: src.what || null,
      parent: db.parents.get(id) || src.parent || null,
      cwd: row?.cwd || head?.cwd || null,
      name: row?.name || null,
      nickname: row?.nickname || null,
      role: row?.role || null,
      model: model && MODEL_RE.test(model) ? model : null,
      effort: effort && EFFORTS.includes(effort) ? effort : null,
      effortFrom,
      busy: st.busy,
      turnStartedMs: st.turnStartedMs,
      lastAtMs: st.lastAtMs || row?.updatedAtMs || null,
      createdAtMs: row?.createdAtMs || head?.createdAtMs || null,
      holder,
      holderTty: hp?.tty || null,
      pid: null,
      tty: null,
      via: null,
      cmux: false,
      known: Boolean(row || rollout),
    });
  }
  turns.keepOnly(looked);
  // a lock with neither a database row nor a rollout, held by a process that also holds a known session, is a helper
  // thread of that process (an auto_review thread before its rollout is written), not a session of its own
  const knownHolders = new Set(sessions.filter((s) => s.known).map((s) => s.holder));
  for (let i = sessions.length - 1; i >= 0; i--) if (!sessions[i].known && knownHolders.has(sessions[i].holder)) sessions.splice(i, 1);
  // the tab of each interactive session: the holder itself when it has a tty, otherwise (terminal sessions only) a unique
  // terminal codex process with the same working folder that was already running when the session was created
  const interactive = sessions.filter((s) => s.kind === "cli" || s.kind === "ide" || s.kind === "other");
  for (const s of interactive) {
    if (s.holderTty) [s.pid, s.tty, s.via] = [s.holder, s.holderTty, "holder"];
  }
  const holderPids = new Set(sessions.map((s) => s.holder));
  const hosted = interactive.filter((s) => s.kind === "cli" && !s.pid && s.cwd);
  if (hosted.length) {
    // terminal codex processes that hold no session themselves and whose parent isn't codex (not a helper)
    const cands = [...procs.values()].filter((p) => p.tty && isCodexComm(p.comm) && !holderPids.has(p.pid) && !isCodexComm(procs.get(p.ppid)?.comm));
    if (cands.length) {
      const r = await run(bin("lsof", "/usr/sbin/lsof"), ["-a", "-d", "cwd", "-Fpn", "-p", cands.map((p) => p.pid).join(",")], { exit1Ok: true });
      const cwdOf = parseLsof(r.out); // path → pid; invert
      const byCwd = new Map();
      for (const [path, pid] of cwdOf) (byCwd.get(path) || byCwd.set(path, []).get(path)).push(pid);
      // lsof reports each process once; a second pass catches several processes in one folder
      const pidsByCwd = new Map();
      let cur = null;
      for (const l of r.out.split("\n")) {
        if (l.startsWith("p")) cur = Number(l.slice(1));
        else if (l.startsWith("n") && cur) (pidsByCwd.get(l.slice(1)) || pidsByCwd.set(l.slice(1), new Set()).get(l.slice(1))).add(cur);
      }
      const sessionsByCwd = new Map();
      for (const s of hosted) (sessionsByCwd.get(s.cwd) || sessionsByCwd.set(s.cwd, []).get(s.cwd)).push(s);
      for (const [cwd, list] of sessionsByCwd) {
        let real = cwd;
        try {
          real = realpathSync(cwd);
        } catch {}
        const pids = new Set([...(pidsByCwd.get(cwd) || []), ...(pidsByCwd.get(real) || [])]);
        // a process started after the session was created didn't create it (lstart is whole seconds, rounded down)
        const created = list.length === 1 ? list[0].createdAtMs : null;
        if (created) for (const pid of pids) if (procs.get(pid)?.startMs && procs.get(pid).startMs > created) pids.delete(pid);
        if (list.length === 1 && pids.size === 1) {
          const pid = [...pids][0];
          [list[0].pid, list[0].tty, list[0].via] = [pid, procs.get(pid)?.tty || null, "cwd"];
        }
      }
    }
  }
  for (const s of interactive) if (s.pid) s.cmux = inCmux(s.pid, procs);
  return { installed: true, sessions, problems };
}

// ---------- texts ----------
const pl = {
  ru: (n, one, few, many) => {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  },
  en: (n, one, many) => (n === 1 ? one : many),
};
export const T = {
  ru: {
    tileLabel: "Codex",
    min: (m) => (m < 1 ? "меньше минуты" : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${pad2(m % 60)} мин`),
    headBusy: (n, idle) => `Codex: ${n} в работе${idle ? ` · ${idle} ${pl.ru(idle, "свободна", "свободны", "свободны")}` : ""}`,
    headIdle: (n) => `Codex: ${n} ${pl.ru(n, "сессия свободна", "сессии свободны", "сессий свободны")}`,
    headBg: (n) => `Codex: ${n} ${pl.ru(n, "фоновый запуск", "фоновых запуска", "фоновых запусков")}`,
    headNone: "Codex: сессий нет",
    headNotInstalled: "Codex не установлен",
    hintNotInstalled: "Папки ~/.codex нет — сессий Codex на этом Mac не было",
    tileBusy: (n) => `${n} в работе`,
    tileIdle: (n) => `${n} ${pl.ru(n, "свободна", "свободны", "свободны")}`,
    unnamed: (id) => `сессия ${id}`,
    busy: "работает",
    idle: "свободна",
    tagBackground: "фоновая (codex exec)",
    tagIde: "в редакторе",
    tagNoTab: "вкладка не найдена",
    sub: (what) => `субагент${what ? ` (${what})` : ""}`,
    folder: (f) => `Папка: ${f}`,
    model: (m) => `Модель: ${m}`,
    effort: (e, from) => `Effort: ${e} (${from === "turn" ? "по последнему ходу" : from === "config" ? "из config.toml" : "по умолчанию у модели"})`,
    focus: "Перейти во вкладку",
    cmuxNoFocus: "Вкладка в cmux — хаб не переключает на вкладки не Claude Code",
    detailsTitle: "Подробности",
    details: (pid, tty, via) => (pid ? `процесс ${pid}${tty ? ` · ${tty}` : ""}${via === "cwd" ? " · найден по папке" : ""}` : "процесс вкладки не найден: сессию держит фоновый сервер Codex"),
    holder: (pid) => `блокировку держит процесс ${pid}`,
    lastActive: (t) => `последняя запись ${t}`,
    waitingNote: "Ожидание разрешения в файлах Codex не видно — здесь его нет",
    sourceTitle: "Откуда данные",
    source: (n) => `блокировки ~/.codex/thread-writer-locks · живых ${n} · база state_5.sqlite · файлы сессий`,
    problems: (p) => `Не всё прочиталось: ${p}`,
    broken: "Не получается прочитать сессии Codex",
    pluginError: "Сбой плагина сессий Codex",
  },
  en: {
    tileLabel: "Codex",
    min: (m) => (m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad2(m % 60)} min`),
    headBusy: (n, idle) => `Codex: ${n} working${idle ? ` · ${idle} idle` : ""}`,
    headIdle: (n) => `Codex: ${n} ${pl.en(n, "session", "sessions")} idle`,
    headBg: (n) => `Codex: ${n} background ${pl.en(n, "run", "runs")}`,
    headNone: "No Codex sessions",
    headNotInstalled: "Codex isn't installed",
    hintNotInstalled: "There is no ~/.codex folder — no Codex sessions on this Mac yet",
    tileBusy: (n) => `${n} working`,
    tileIdle: (n) => `${n} idle`,
    unnamed: (id) => `session ${id}`,
    busy: "working",
    idle: "idle",
    tagBackground: "background (codex exec)",
    tagIde: "in an editor",
    tagNoTab: "tab not found",
    sub: (what) => `subagent${what ? ` (${what})` : ""}`,
    folder: (f) => `Folder: ${f}`,
    model: (m) => `Model: ${m}`,
    effort: (e, from) => `Effort: ${e} (${from === "turn" ? "as of the last turn" : from === "config" ? "from config.toml" : "the model's default"})`,
    focus: "Switch to tab",
    cmuxNoFocus: "The tab is in cmux — the hub doesn't switch to non-Claude Code tabs",
    detailsTitle: "Details",
    details: (pid, tty, via) => (pid ? `process ${pid}${tty ? ` · ${tty}` : ""}${via === "cwd" ? " · matched by folder" : ""}` : "no tab process found: the Codex background server holds the session"),
    holder: (pid) => `the lock is held by process ${pid}`,
    lastActive: (t) => `last write ${t}`,
    waitingNote: "Waiting for approval isn't visible in Codex's files — it isn't shown here",
    sourceTitle: "Where the data comes from",
    source: (n) => `locks in ~/.codex/thread-writer-locks · ${n} live · the state_5.sqlite database · session files`,
    problems: (p) => `Not everything was read: ${p}`,
    broken: "Can't read Codex sessions",
    pluginError: "Codex sessions plugin failure",
  },
};
const fmtTime = (ms, nowMs) => {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return nowMs - ms < 20 * 3_600_000 ? hm : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${hm}`;
};

const labelOf = (s, L) => clean(s.name || (s.cwd ? basename(s.cwd) : "") || L.unnamed(s.id.slice(0, 8)), 50);
const subLabel = (s, L) => clean([s.nickname, s.role].filter(Boolean).join(" · ") || L.sub(s.subWhat), 50);

export function render({ installed, sessions, problems = [] }, nowMs, lang = envLang(), home = homedir()) {
  const L = T[lang] || T.ru;
  const head0 = (text, extra = "") => `${text} | status=ok tile="0" tileLabel=${q(L.tileLabel)}${extra} sfimage=terminal`;
  if (!installed) return [head0(L.headNotInstalled), "---", `${L.hintNotInstalled} | sfimage=info.circle color=gray`].join("\n");
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // subagents go under their live parent; an orphan subagent is a row of its own
  const children = new Map();
  const top = [];
  for (const s of sessions) {
    if (s.kind === "sub" && s.parent && byId.has(s.parent) && s.parent !== s.id) (children.get(s.parent) || children.set(s.parent, []).get(s.parent)).push(s);
    else top.push(s);
  }
  const isBg = (s) => s.kind === "exec";
  const fg = top.filter((s) => !isBg(s));
  const busyOf = (s) => s.busy || (children.get(s.id) || []).some((c) => c.busy);
  const busy = fg.filter(busyOf).length;
  const idle = fg.length - busy;
  const bg = top.filter(isBg).length;
  let head;
  let tile;
  if (busy) [head, tile] = [L.headBusy(busy, idle), L.tileBusy(busy)];
  else if (fg.length) [head, tile] = [L.headIdle(fg.length), L.tileIdle(fg.length)];
  else if (bg) [head, tile] = [L.headBg(bg), String(bg)];
  else [head, tile] = [L.headNone, "0"];
  const broken = problems.length > 0 && !sessions.length;
  const out = [`${clean(head, 160)} | status=${broken ? "unknown" : "ok"} tile=${q(tile)} tileLabel=${q(L.tileLabel)}${broken ? " event=source-broken" : ""} sfimage=terminal`, "---"];
  if (broken) out.push(`${L.broken} | status=unknown sfimage=exclamationmark.triangle`, `--${clean(L.problems(problems.join(", ")), 200)}`);
  // working first, then idle, then background; newest activity first inside
  const order = (s) => (isBg(s) ? 2 : busyOf(s) ? 0 : 1);
  const sorted = [...top].sort((a, b) => order(a) - order(b) || (b.lastAtMs || 0) - (a.lastAtMs || 0));
  for (const s of sorted) {
    const name = labelOf(s, L);
    const state = busyOf(s) ? `${L.busy}${s.turnStartedMs ? ` · ${L.min(Math.max(0, Math.floor((nowMs - s.turnStartedMs) / 60_000)))}` : ""}` : L.idle;
    const tags = [];
    if (isBg(s)) tags.push(L.tagBackground);
    else if (s.kind === "ide") tags.push(L.tagIde);
    else if (s.kind === "sub") tags.push(L.sub(s.subWhat));
    const p = [];
    // only an interactive session with its tab process is registered with the hub
    if (!isBg(s) && s.kind !== "sub" && s.pid && UUID_RE.test(s.id)) p.push(`agentSession=${s.id}`, `pid=${s.pid}`, "agent=codex", `agentName=${q(name)}`);
    p.push(busyOf(s) ? "sfimage=bolt.fill" : isBg(s) ? "sfimage=gearshape" : "sfimage=moon");
    out.push(`${clean(`${name} — ${state}${tags.length ? ` · ${tags.join(" · ")}` : ""}`, 160)} | ${p.join(" ")}`);
    if (s.cwd) out.push(`--${clean(L.folder(homeShort(s.cwd, home)), 120)}`);
    if (s.model) out.push(`--${L.model(clean(s.model, 64))}`);
    if (s.effort) out.push(`--${L.effort(s.effort, s.effortFrom)}`);
    for (const c of (children.get(s.id) || []).sort((a, b) => (b.lastAtMs || 0) - (a.lastAtMs || 0))) {
      const cs = c.busy ? `${L.busy}${c.turnStartedMs ? ` · ${L.min(Math.max(0, Math.floor((nowMs - c.turnStartedMs) / 60_000)))}` : ""}` : L.idle;
      out.push(`--${clean(`${subLabel(c, L)} — ${cs}`, 120)} | sfimage=${c.busy ? "bolt.fill" : "moon"}`);
      if (c.model) out.push(`----${L.model(clean(c.model, 64))}`);
    }
    if (!isBg(s) && s.kind !== "sub" && s.pid && UUID_RE.test(s.id)) {
      if (s.cmux) out.push(`--${L.cmuxNoFocus} | color=gray size=11`);
      else out.push(`--${L.focus} | effect="session.focus ${s.id}" sfimage=arrow.up.forward.app`);
    }
    out.push(`--${L.detailsTitle} | details=true`);
    out.push(`----${isBg(s) ? L.holder(s.holder) : L.details(s.pid, s.tty, s.via)}`);
    if (s.lastAtMs) out.push(`----${L.lastActive(fmtTime(s.lastAtMs, nowMs))}`);
  }
  if (out.at(-1) !== "---") out.push("---");
  out.push(`${L.sourceTitle} | color=gray size=11`);
  out.push(`--${clean(L.source(sessions.length), 200)} | color=gray size=11`);
  out.push(`--${L.waitingNote} | color=gray size=11`);
  if (problems.length && !broken) out.push(`--${clean(L.problems(problems.join(", ")), 200)} | color=gray size=11`);
  return out.join("\n");
}

export function brokenFrame(err, lang = envLang()) {
  const L = T[lang] || T.ru;
  return `${L.pluginError} | status=unknown tileLabel=${q(L.tileLabel)}\n---\n${clean(err?.message || err, 140)} | event=source-broken`;
}

async function main() {
  const pollMs = Math.max(200, Number(process.env.AGENTHUB_TEST_POLL_MS) || 3000);
  const now = () => (process.env.AGENTHUB_TEST_NOW ? Date.parse(process.env.AGENTHUB_TEST_NOW) : Date.now());
  let last = null;
  let busy = false;
  let again = false;
  let timer = null;
  const tick = async () => {
    clearTimeout(timer);
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    let text;
    try {
      text = render(await collect(), now());
    } catch (e) {
      text = brokenFrame(e);
    }
    if (text !== last) {
      process.stdout.write(`${text}\n~~~\n`);
      last = text;
    }
    busy = false;
    if (again) {
      again = false;
      setImmediate(tick);
    } else timer = setTimeout(tick, pollMs);
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m?.type === "refresh" || m?.type === "fileChanged") tick();
    else if (m?.type === "stopping") process.exit(0);
  });
  rl.on("close", () => process.exit(0));
  process.stdout.on("error", () => process.exit(0));
  tick();
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMain()) main();
