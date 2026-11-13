#!/usr/bin/env node
// Claude Code sessions: who's working, who's waiting (for permission, a reply, a dialog), who died mid-turn.
//
// <agenthub.title>Claude Code Сессии</agenthub.title>
// <agenthub.title lang="en">Claude Code Sessions</agenthub.title>
// <agenthub.version>0.5.2</agenthub.version>
// <agenthub.author.name>Kensei</agenthub.author.name>
// <agenthub.author.github>KenseiTheOne</agenthub.author.github>
// <agenthub.desc>Сессии Claude Code по вкладкам cmux: кто работает, кто ждёт вас, кто оборвался</agenthub.desc>
// <agenthub.desc lang="en">Claude Code sessions by cmux tab: who's working, who needs you, who stopped</agenthub.desc>
// <agenthub.status value="ok" label="Никто не ждёт">Сессии работают или свободны — от вас ничего не нужно</agenthub.status>
// <agenthub.status value="ok" lang="en" label="No one is waiting">Sessions are working or idle — nothing needed from you</agenthub.status>
// <agenthub.status value="wait" label="Сессия ждёт вас">Сессия ждёт разрешения или ответа, или оборвалась посреди работы</agenthub.status>
// <agenthub.status value="wait" lang="en" label="A session needs you">A session is waiting for permission or an answer, or stopped mid-turn</agenthub.status>
// <agenthub.status value="unknown" label="Не видно сессий">Список сессий не читается — причина в первой строке</agenthub.status>
// <agenthub.status value="unknown" lang="en" label="Can't see sessions">The session list can't be read — the reason is in the first line</agenthub.status>
// <agenthub.type>streamable</agenthub.type>
// <agenthub.platforms>macos</agenthub.platforms>
// <agenthub.watch>~/.claude/sessions/*.json — сессия появилась, пропала или сменила статус</agenthub.watch>
// <agenthub.watch>~/.cmuxterm/claude-hook-sessions.json — сессия привязалась к вкладке cmux</agenthub.watch>
// <agenthub.exec>claude agents --json — истина о сессиях (официальный вывод «for a status bar»), раз в 2 с</agenthub.exec>
// <agenthub.exec>/bin/ps -o pid=,lstart= -p <pid,…> (TZ=UTC) — время старта процесса: pid не переиспользован</agenthub.exec>
// <agenthub.fsRead>~/.claude/sessions/<pid>.json — подсказка: procStart, status (бывает "shell"), statusUpdatedAt, entrypoint (cli или claude -p); *.key не открываются</agenthub.fsRead>
// <agenthub.fsRead>~/.cmuxterm/claude-hook-sessions.json — sessionId → surfaceId, workspaceId, agentLifecycle, pidStartSeconds; поля с текстом (lastBody, lastSubtitle, transcriptPath, launchCommand) не используются</agenthub.fsRead>
// <agenthub.fsRead>~/.claude/projects/*/<sessionId>.jsonl — только модель и effort последнего хода, команды /model и /effort после него и метки ultracode: хвост файла до 512 КБ (до 2 МБ, если в нём нет хода или метки ultracode) или дописанная с прошлого опроса часть до 2 МБ, поля type, model, requestedModel, effort, perTurnEffort, output_config.effort, attachment.type, timestamp и строка вывода локальной команды «Set model to …» / «Set effort level to …»; текст переписки не берётся и не пишется</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.claude/projects/*/<sessionId>.jsonl — only the last turn's model and effort, the /model and /effort commands after it and ultracode markers: the file's last 512 KB (up to 2 MB if it holds no turn or no ultracode marker) or the part appended since the last poll, up to 2 MB; fields type, model, requestedModel, effort, perTurnEffort, output_config.effort, attachment.type, timestamp and the local command output line "Set model to …" / "Set effort level to …"; no conversation text is taken or written</agenthub.fsRead>
// <agenthub.effects>cmux.focus,session.interrupt,session.stop</agenthub.effects>
// <agenthub.contract>3</agenthub.contract>
// <agenthub.icon symbol="terminal" color="#FF9F0A"></agenthub.icon>
// <agenthub.push key="died" kind="plugin" was="runs">Сессия оборвалась посреди работы</agenthub.push>
// <agenthub.push key="died" lang="en">A session stopped mid-turn</agenthub.push>
//
// The core verifies session authenticity: the plugin only reports `session=<id> pid=<pid>`, the core checks the
// executable's signature against requirements.claudeCode. Read-only. Unknown source shape → status=unknown +
// event=source-broken. A frame is text followed by a `~~~` line; stdin is NDJSON from the core (fileChanged, refresh).
//
// For tests: AGENTHUB_TEST_BIN_DIR (claude/ps doubles), AGENTHUB_TEST_POLL_MS, AGENTHUB_TEST_NOW.
// The daemon doesn't pass these variables to the plugin.

import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const STATUSES = ["busy", "waiting", "idle"];
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const DIED_KEEP_MS = 30 * 60_000;
// A "turn running" record older than this after the process died isn't "died mid-turn" but an old trace (reboot).
const RECENT_MS = 2 * 3_600_000;

// ---------- helpers ----------

// Text from external sources — on one line, without control characters, "|" and SwiftBar format prefixes.
// keepPrefix — for a quoted value (a line parameter): there "-" and "~" at the start aren't a format prefix but part
// of the value ("~/Projects/…" in sessionCwd).
export function clean(text, max = 120, { keepPrefix = false } = {}) {
  let s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\|/g, "¦").replace(/\s+/g, " ").trim();
  if (!keepPrefix) s = s.replace(/^[-~]+/, "").trim();
  if ([...s].length > max) s = [...s].slice(0, max - 1).join("") + "…";
  return s;
}

export function q(v) {
  return `"${clean(v, 400, { keepPrefix: true }).replace(/["\\]/g, "\\$&")}"`;
}

const ID_RE = /^[A-Za-z0-9][\w.-]{0,127}$/;
const pad2 = (n) => String(n).padStart(2, "0");
const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDateTime(ms, lang = "ru") {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return lang === "en" ? `${MON_EN[d.getMonth()]} ${d.getDate()}, ${hm}` : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${hm}`;
}
export function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "меньше минуты";
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${pad2(m % 60)} мин`;
}

function run(file, args, { timeoutMs = 4000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env }, (err, stdout) => {
      // error — a short code without the command text: timeout, exit N, ENOENT/EACCES…
      const error = !err ? null : err.killed || err.signal ? "timeout" : typeof err.code === "number" ? `exit ${err.code}` : /^[A-Z][A-Z0-9_]{1,30}$/.test(String(err.code || "")) ? String(err.code) : "error";
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout || ""), error });
    });
  });
}

function which(name) {
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function bin(name, fallback) {
  const dir = process.env.AGENTHUB_TEST_BIN_DIR;
  if (dir && existsSync(join(dir, name))) return join(dir, name);
  return fallback;
}

// ---------- sources ----------

// `claude agents --json` → { ok, sessions:[…], problems:[…] }. ok=false — the shape is entirely unknown.
export function parseAgents(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, sessions: [], problems: ["agents:not-json"] };
  }
  if (!Array.isArray(j)) return { ok: false, sessions: [], problems: ["agents:not-array"] };
  const sessions = [];
  const problems = [];
  for (const a of j) {
    if (!a || typeof a !== "object" || !Number.isInteger(a.pid) || a.pid <= 0 || typeof a.sessionId !== "string" || !ID_RE.test(a.sessionId) || typeof a.status !== "string") {
      problems.push("agents:bad-record");
      continue;
    }
    if (!STATUSES.includes(a.status)) problems.push(`agents:bad-status:${clean(a.status, 20)}`);
    sessions.push({
      sessionId: a.sessionId,
      pid: a.pid,
      status: STATUSES.includes(a.status) ? a.status : null,
      waitingFor: typeof a.waitingFor === "string" && a.waitingFor ? clean(a.waitingFor, 40) : null,
      name: typeof a.name === "string" ? clean(a.name, 60) : null,
      cwd: typeof a.cwd === "string" ? a.cwd : null,
      kind: typeof a.kind === "string" ? clean(a.kind, 20) : null,
      startedAt: typeof a.startedAt === "number" ? a.startedAt : null,
    });
  }
  return { ok: true, sessions, problems: [...new Set(problems)] };
}

// ~/.claude/sessions/<pid>.json → hints by pid. *.key and other files aren't opened.
export function readHints(dir) {
  const hints = new Map();
  const problems = [];
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { hints, problems, count: 0 };
  }
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    let j;
    try {
      j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue; // a file mid-write isn't a shape problem; the next poll will read it
    }
    if (!j || typeof j !== "object" || !Number.isInteger(j.pid) || typeof j.sessionId !== "string" || !ID_RE.test(j.sessionId)) {
      problems.push("hints:bad-file");
      continue;
    }
    hints.set(j.pid, {
      pid: j.pid,
      sessionId: j.sessionId,
      procStart: typeof j.procStart === "string" ? j.procStart : null,
      status: typeof j.status === "string" ? clean(j.status, 20) : null,
      statusUpdatedAt: typeof j.statusUpdatedAt === "number" ? j.statusUpdatedAt : null,
      name: typeof j.name === "string" ? clean(j.name, 60) : null,
      // where the name comes from: auto — a title Claude Code composed from the conversation; derived — from the folder and branch; otherwise — set
      // by a human. The core doesn't put an auto name into the session metadata file for plugins (contract 3)
      nameSource: typeof j.nameSource === "string" && /^[a-z][a-z-]{0,19}$/.test(j.nameSource) ? j.nameSource : null,
      cwd: typeof j.cwd === "string" ? j.cwd : null,
      kind: typeof j.kind === "string" ? clean(j.kind, 20) : null,
      // cli — terminal; sdk-cli (claude -p) and other sdk-* — background runs, their exit after the reply is normal
      entrypoint: typeof j.entrypoint === "string" ? clean(j.entrypoint, 30) : null,
    });
  }
  return { hints, problems: [...new Set(problems)], count: hints.size };
}

// ~/.cmuxterm/claude-hook-sessions.json → bindings by sessionId. Only ids, pid and start time are taken.
export function parseCmux(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, bySession: new Map(), problem: "cmux:not-json" };
  }
  if (!j || typeof j !== "object" || typeof j.sessions !== "object" || j.sessions === null || Array.isArray(j.sessions)) {
    return { ok: false, bySession: new Map(), problem: "cmux:no-sessions" };
  }
  const bySession = new Map();
  for (const [key, s] of Object.entries(j.sessions)) {
    if (!s || typeof s !== "object") continue;
    const sid = typeof s.sessionId === "string" ? s.sessionId : key;
    if (!ID_RE.test(sid)) continue;
    bySession.set(sid, {
      pid: Number.isInteger(s.pid) ? s.pid : null,
      pidStartSeconds: typeof s.pidStartSeconds === "number" ? s.pidStartSeconds : null,
      surfaceId: typeof s.surfaceId === "string" && ID_RE.test(s.surfaceId) ? s.surfaceId : null,
      workspaceId: typeof s.workspaceId === "string" && ID_RE.test(s.workspaceId) ? s.workspaceId : null,
      lifecycle: typeof s.agentLifecycle === "string" ? clean(s.agentLifecycle, 20) : null,
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null,
    });
  }
  return { ok: true, bySession };
}

// ---------- liveness ----------

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// "Thu Oct 22 20:46:52 2026" as UTC time → epoch seconds. procStart in sessions/*.json is written exactly like that
// (`ps -o lstart` output with TZ=UTC), while `ps` without TZ shows local time — hence the "one-hour shift".
export function parseLstartUtc(text) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(String(text));
  if (!m || !(m[1] in MONTHS)) return null;
  return Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
}

// `TZ=UTC ps -o pid=,lstart= -p …` → Map pid → epoch seconds
export function parsePsStarts(text) {
  const out = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const sec = parseLstartUtc(m[2]);
    if (sec !== null) out.set(Number(m[1]), sec);
  }
  return out;
}

// Whether the process start time matches the recorded one. A whole number of hours of difference (up to 14) is the same second in
// another zone: count it as a match.
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

function signalZero(pid) {
  try {
    process.kill(pid, 0); // signal 0: only an existence check, nothing is delivered to the process
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// → Map pid → { alive, reason }
export async function checkAlive(pids, hintsByPid, cmuxBySession) {
  const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  const out = new Map();
  if (!list.length) return out;
  const live = list.filter(signalZero);
  for (const p of list) if (!live.includes(p)) out.set(p, { alive: false, reason: "gone" });
  if (!live.length) return out;
  const r = await run(bin("ps", "/bin/ps"), ["-o", "pid=,lstart=", "-p", live.join(",")], { env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeoutMs: 3000 });
  const starts = r.code === 0 || r.stdout ? parsePsStarts(r.stdout) : new Map();
  for (const p of live) {
    const ps = starts.get(p);
    const hint = hintsByPid.get(p);
    let verdict = null;
    if (hint?.procStart) verdict = sameStart(ps, parseLstartUtc(hint.procStart));
    if (verdict === null && hint) {
      const c = cmuxBySession.get(hint.sessionId);
      if (c && c.pid === p) verdict = sameStart(ps, c.pidStartSeconds);
    }
    if (verdict === false) out.set(p, { alive: false, reason: "reused" });
    else out.set(p, { alive: true, reason: verdict === null ? "signal" : "signal+start" });
  }
  return out;
}

// ---------- assembly ----------

// Memory between polls (streamable — a single process): when a session started waiting, who was busy, who died.
export function newMemory() {
  // gone — dead ones whose entry has already expired: don't resurrect them from the same stale file
  return { waitingSince: new Map(), lastBusy: new Map(), died: new Map(), gone: new Set() };
}

// Memory survives a plugin restart (hub language change, daemon restart): otherwise a long-cleared "died"
// would pop up again and raise a repeat push, and waiting sessions would get their waiting time reset. The file is
// $AGENTHUB_PLUGIN_DATA_PATH/memory.json (0600): only session ids, pid, name, folder, entrypoint, whether there was a session file
// and timestamps.
const MEMORY_VERSION = 1;
export function saveMemory(path, mem) {
  const data = {
    version: MEMORY_VERSION,
    waitingSince: [...mem.waitingSince],
    // seenAt — to the minute: a busy session doesn't rewrite the file on every poll
    lastBusy: [...mem.lastBusy].map(([k, v]) => [k, { ...v, seenAt: Number.isFinite(v.seenAt) ? Math.floor(v.seenAt / 60_000) * 60_000 : v.seenAt }]),
    died: [...mem.died],
    gone: [...mem.gone].slice(-2000),
  };
  const text = JSON.stringify(data);
  if (mem.savedText === text) return false;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  mem.savedText = text;
  return true;
}

export function loadMemory(path) {
  const mem = newMemory();
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    let fileAt = null; // memory before 0.3.1 has no seenAt: "seen" no later than the file's last write
    try {
      fileAt = statSync(path).mtimeMs;
    } catch {}
    if (j?.version !== MEMORY_VERSION) return mem;
    const pairs = (v) => (Array.isArray(v) ? v.filter((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && UUID_RE.test(x[0])) : []);
    for (const [k, v] of pairs(j.waitingSince)) if (Number.isFinite(v)) mem.waitingSince.set(k, v);
    // sessionId comes from the checked key, not the stored object: it goes into event= and titles unquoted
    for (const [k, v] of pairs(j.lastBusy)) if (v && Number.isInteger(v.pid)) mem.lastBusy.set(k, { ...v, sessionId: k, seenAt: Number.isFinite(v.seenAt) ? v.seenAt : fileAt });
    for (const [k, v] of pairs(j.died)) if (v && typeof v === "object" && Number.isFinite(v.at)) mem.died.set(k, { ...v, sessionId: k, pid: Number.isInteger(v.pid) ? v.pid : null });
    for (const k of Array.isArray(j.gone) ? j.gone : []) if (typeof k === "string" && UUID_RE.test(k)) mem.gone.add(k);
  } catch {}
  return mem;
}

// ---------- last turn's effort (the session transcript — metadata fields only) ----------
//
// Claude Code writes the effort and perTurnEffort fields on assistant records in ~/.claude/projects/<folder>/<sessionId>.jsonl
// (the turn's effective level: perTurnEffort, or effort if it's absent), params.output_config.effort on api-request,
// and turning ultracode on and off as attachments attachment.type = ultra_effort_enter / ultra_effort_exit. The plugin
// reads only the file's tail (up to TAIL_MAX bytes, from the end) and takes only these fields from records: neither message text
// nor anything else is extracted, output or stored. Cached by the file's (size, mtime).

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TAIL_MAX = 512 * 1024;
const LOCATE_RETRY_MS = 30_000;

// JSONL tail → { effort, effortSource, ultracode, at, decided, model, modelSource, modelAt, modelDecided }.
// Effort is decided by the last turn record — assistant (not an API error, not a sidechain) or api-request: its perTurnEffort ??
// effort (or output_config.effort); an unknown value or its absence on that record — null (earlier turns aren't
// substituted). But if there's /effort command output after the turn ("Set effort level to <level> …"), it decides
// (effortSource: "command"): an idle session's turn may have come before the command. The model works the same way: message.model (or
// requestedModel) of the last assistant record, and /model output after it ("Set model to `<name>` …") takes precedence
// (modelSource: "command"). at / modelAt — the time of the record effort / model was taken from. decided / modelDecided —
// whether such a record was found at all; ultracode — from the last ultra_effort_enter/exit marker (true/false) or null.
// Only these fields and the local command output line are taken from records; message text isn't parsed.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:()[\]/+-]{0,63}$/;
const CMD_PREFIX = "<local-command-stdout>";
const MODEL_CMD_RE = /^<local-command-stdout>(?:Set model to|Kept model as) `([^`\n]{1,80})`/;
const EFFORT_CMD_RE = /^<local-command-stdout>Set effort level to ([a-z]{1,16})\b/;
const tsOf = (o) => (typeof o.timestamp === "string" && Number.isFinite(Date.parse(o.timestamp)) ? o.timestamp : null);
// ANSI codes (the bold model name in /model output) and extra spaces go; doesn't look like a name — null.
const modelName = (v) => {
  if (typeof v !== "string") return null;
  const m = v.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return MODEL_RE.test(m) ? m : null;
};
export function scanTail(text, { fromStart = false } = {}) {
  const lines = String(text).split("\n");
  if (!fromStart) lines.shift(); // the tail's first line is a fragment
  const r = { effort: null, effortSource: null, at: null, decided: false, model: null, modelSource: null, modelAt: null, modelDecided: false };
  let ultracode;
  for (let i = lines.length - 1; i >= 0 && (!r.decided || !r.modelDecided || ultracode === undefined); i--) {
    const line = lines[i];
    // a cheap filter before parsing: other records (user, tool_result, …) aren't parsed at all
    const isAssistant = line.includes('"assistant"');
    const isRequest = line.includes('"api-request"');
    const isUltra = line.includes('"ultra_effort_');
    const isCmd = line.includes(CMD_PREFIX + "Set ") || line.includes(CMD_PREFIX + "Kept model as");
    if (!isAssistant && !isRequest && !isUltra && !isCmd) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (ultracode === undefined && o.type === "attachment") {
      const t = o.attachment?.type;
      if (t === "ultra_effort_enter") ultracode = true;
      else if (t === "ultra_effort_exit") ultracode = false;
    }
    // local command output: a user record whose content is a string starting with <local-command-stdout>, or a
    // system/local_command record with such a string in content (that's how Claude Code 2.1.3xx writes "Kept model as …"); a tool
    // result with such text is an array, not a string, and doesn't count
    const cmdText =
      o.isSidechain === true ? null
      : o.type === "user" && typeof o.message?.content === "string" ? o.message.content
      : o.type === "system" && o.subtype === "local_command" && typeof o.content === "string" ? o.content
      : null;
    if (cmdText !== null && cmdText.startsWith(CMD_PREFIX)) {
      const c = cmdText;
      const mm = MODEL_CMD_RE.exec(c);
      if (mm && !r.modelDecided) {
        const m = modelName(mm[1]);
        if (m) Object.assign(r, { model: m, modelSource: "command", modelAt: tsOf(o), modelDecided: true });
      }
      const me = EFFORT_CMD_RE.exec(c);
      if (me && !r.decided) {
        const known = EFFORTS.includes(me[1]);
        Object.assign(r, { effort: known ? me[1] : null, effortSource: known ? "command" : null, at: known ? tsOf(o) : null, decided: true });
      }
      continue;
    }
    if (o.type === "assistant" && !o.isApiErrorMessage && o.isSidechain !== true) {
      if (!r.modelDecided) {
        // "<synthetic>" and anything else that doesn't look like a model isn't a decision: look for an earlier turn
        const m = modelName(o.message?.model) || modelName(o.requestedModel);
        if (m) Object.assign(r, { model: m, modelSource: "turn", modelAt: tsOf(o), modelDecided: true });
      }
      if (!r.decided) {
        const e = o.perTurnEffort === undefined || o.perTurnEffort === null ? o.effort : o.perTurnEffort;
        r.decided = true;
        if (typeof e === "string" && EFFORTS.includes(e)) Object.assign(r, { effort: e, effortSource: "turn", at: tsOf(o) });
      }
    } else if (o.type === "api-request" && !r.decided) {
      const e = o.params?.output_config?.effort;
      r.decided = true;
      if (typeof e === "string" && EFFORTS.includes(e)) Object.assign(r, { effort: e, effortSource: "turn", at: tsOf(o) });
    }
  }
  return { ...r, ultracode: ultracode ?? null };
}

// The same without the internal decided: { effort, ultracode, at }.
export function effortFromTail(text, opts) {
  const { effort, ultracode, at } = scanTail(text, opts);
  return { effort, ultracode, at };
}

// File tail: the last max bytes; fromStart — whether the file was read from the start (the first line is whole).
// from — read no earlier than this offset (the appended part of the file); size — the size to read up to.
export function readTail(path, max = TAIL_MAX, { from = 0, size: upTo } = {}) {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(fstatSync(fd).size, upTo ?? Infinity);
    const start = Math.max(from, size - max, 0);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString("utf8"), fromStart: start === 0 };
  } finally {
    closeSync(fd);
  }
}

// A file's effort taking the previous result into account. The file only grew (appended ≤ GROW_MAX) — the appended part is read
// (with an OVERLAP margin for a line cut off by the last read): a turn/marker found — it's newer, none — the previous ones stay
// (Claude Code writes ultracode markers only on state change, and in a long session it's far behind the tail).
// Otherwise — the TAIL_MAX tail, and if it has no turn at all (one huge tool_result line) — the TAIL_EXT tail.
const TAIL_EXT = 2 * 1024 * 1024;
const GROW_MAX = 2 * 1024 * 1024;
const OVERLAP = 64 * 1024;
export function effortOfFile(path, size, prev = null) {
  if (prev && prev.path === path && size > prev.size && size - prev.size <= GROW_MAX) {
    const t = readTail(path, GROW_MAX + OVERLAP, { from: Math.max(0, prev.size - OVERLAP), size });
    const r = scanTail(t.text, { fromStart: t.fromStart });
    const keep = prev.r;
    return {
      effort: r.decided ? r.effort : keep.effort,
      effortSource: r.decided ? r.effortSource : (keep.effortSource ?? null),
      at: r.decided ? r.at : keep.at,
      decided: r.decided || keep.decided,
      model: r.modelDecided ? r.model : (keep.model ?? null),
      modelSource: r.modelDecided ? r.modelSource : (keep.modelSource ?? null),
      modelAt: r.modelDecided ? r.modelAt : (keep.modelAt ?? null),
      modelDecided: r.modelDecided || keep.modelDecided === true,
      ultracode: r.ultracode ?? keep.ultracode,
    };
  }
  let t = readTail(path, TAIL_MAX, { size });
  let r = scanTail(t.text, { fromStart: t.fromStart });
  if ((!r.decided || !r.modelDecided || r.ultracode === null) && !t.fromStart) {
    t = readTail(path, TAIL_EXT, { size });
    r = scanTail(t.text, { fromStart: t.fromStart });
  }
  // grew by more than GROW_MAX: a marker that isn't in the extended tail either is taken from the previous result
  if (r.ultracode === null && prev && prev.path === path && size > prev.size) r.ultracode = prev.r.ultracode;
  return r;
}

// Claude Code project folder: the cwd path with everything except letters and digits replaced by "-".
export const projectSlug = (cwd) => String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");

export function newEffortCache() {
  return { paths: new Map(), misses: new Map(), results: new Map() };
}

// The effort cache survives a plugin restart (language change, daemon restart, builtin update): in a long session the ultracode marker
// is long past 2 MB from the end, and without the previous result ⚡ultracode would disappear until the next toggle.
// The file is $AGENTHUB_PLUGIN_DATA_PATH/effort.json (0600): session id, transcript path, its size/mtime and the result
// (level, ultracode, turn time). Rewritten only when the result or the path changes, not the file size:
// from a stale size the next run reads the appended part (or the tail) and carries ultracode over.
// Version 2 (contract 3): also the model, where the model and effort came from (turn or command) and the model record's time. A version 1
// cache is read as is (it has no model — the next tail read finds it: size/mtime are reset).
const EFFORT_VERSION = 2;
const R_KEYS = ["effort", "effortSource", "ultracode", "at", "decided", "model", "modelSource", "modelAt", "modelDecided"];
const effortKey = (cache) => JSON.stringify([...cache.results].map(([k, v]) => [k, v.path, ...R_KEYS.map((x) => v.r[x] ?? null)]));
export function saveEffortCache(path, cache) {
  const key = effortKey(cache);
  if (cache.savedKey === key) return false;
  const data = { version: EFFORT_VERSION, results: [...cache.results].map(([k, v]) => [k, { path: v.path, size: v.size, mtimeMs: v.mtimeMs, r: Object.fromEntries(R_KEYS.map((x) => [x, v.r[x] ?? null])) }]) };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
  cache.savedKey = key;
  return true;
}

export function loadEffortCache(path) {
  const cache = newEffortCache();
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if ((j?.version !== EFFORT_VERSION && j?.version !== 1) || !Array.isArray(j.results)) return cache;
    const v1 = j.version === 1;
    for (const e of j.results) {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || !UUID_RE.test(e[0])) continue;
      const v = e[1];
      if (!v || typeof v.path !== "string" || !v.path.endsWith(`${e[0]}.jsonl`) || !Number.isFinite(v.size) || !Number.isFinite(v.mtimeMs) || !v.r) continue;
      const iso = (x) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null);
      const src = (x) => (x === "turn" || x === "command" ? x : null);
      const r = {
        effort: EFFORTS.includes(v.r.effort) ? v.r.effort : null,
        effortSource: src(v.r.effortSource),
        ultracode: v.r.ultracode === true || v.r.ultracode === false ? v.r.ultracode : null,
        at: iso(v.r.at),
        decided: v.r.decided === true,
        model: typeof v.r.model === "string" && MODEL_RE.test(v.r.model) ? v.r.model : null,
        modelSource: src(v.r.modelSource),
        modelAt: iso(v.r.modelAt),
        modelDecided: v.r.modelDecided === true,
      };
      // a version 1 cache doesn't know the model: size 0 — the next poll re-reads the tail (ultracode carries over from r)
      cache.results.set(e[0], { path: v.path, size: v1 ? 0 : v.size, mtimeMs: v1 ? 0 : v.mtimeMs, r });
    }
    cache.savedKey = effortKey(cache);
  } catch {}
  return cache;
}

function locateTranscript(projects, s, cache, nowMs) {
  const known = cache.paths.get(s.sessionId);
  if (known && existsSync(known)) return known;
  const miss = cache.misses.get(s.sessionId);
  if (miss && nowMs - miss < LOCATE_RETRY_MS) return null;
  const name = `${s.sessionId}.jsonl`;
  const cands = s.cwd ? [join(projects, projectSlug(s.cwd), name)] : [];
  let found = cands.find((p) => existsSync(p)) || null;
  if (!found) {
    let dirs = [];
    try {
      dirs = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {}
    for (const d of dirs) {
      const p = join(projects, d, name);
      if (existsSync(p)) {
        found = p;
        break;
      }
    }
  }
  if (found) {
    cache.paths.set(s.sessionId, found);
    cache.misses.delete(s.sessionId);
  } else cache.misses.set(s.sessionId, nowMs);
  return found;
}

// Effort for the listed sessions (in place: s.effort, s.ultracode, s.effortAt). Read errors — no effort.
export function attachEffort(sessions, { home = homedir(), cache, nowMs = Date.now() } = {}) {
  const projects = join(home, ".claude", "projects");
  const live = new Set();
  for (const s of sessions) {
    if (!UUID_RE.test(s.sessionId)) continue;
    live.add(s.sessionId);
    const path = locateTranscript(projects, s, cache, nowMs);
    if (!path) continue;
    let st;
    try {
      st = statSync(path);
    } catch {
      cache.paths.delete(s.sessionId);
      continue;
    }
    const prev = cache.results.get(s.sessionId);
    let r = prev && prev.path === path && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.r : null;
    if (!r) {
      try {
        r = effortOfFile(path, st.size, prev);
      } catch {
        r = { effort: null, effortSource: null, ultracode: null, at: null, decided: false, model: null, modelSource: null, modelAt: null, modelDecided: false };
      }
      cache.results.set(s.sessionId, { path, size: st.size, mtimeMs: st.mtimeMs, r });
    }
    s.effort = r.effort;
    s.effortSource = r.effortSource ?? null;
    s.ultracode = r.ultracode;
    s.effortAt = r.at;
    s.model = r.model ?? null;
    s.modelSource = r.modelSource ?? null;
    s.modelAt = r.modelAt ?? null;
  }
  for (const k of [...cache.results.keys()]) if (!live.has(k)) cache.results.delete(k);
  for (const k of [...cache.paths.keys()]) if (!live.has(k)) cache.paths.delete(k);
  if (cache.misses.size > 500) cache.misses.clear();
  return sessions;
}

// Pure list assembly. → { sessions:[…], died:[…], problems:[…], agentsOk }
export function merge({ agents, hints, cmux, alive, mem, nowMs }) {
  const problems = [...(agents.problems || []), ...(hints.problems || [])];
  if (cmux && !cmux.ok && cmux.problem) problems.push(cmux.problem);
  const bindings = cmux?.ok ? cmux.bySession : new Map();
  const sessions = [];
  const seen = new Set();
  const bind = (s) => {
    const c = bindings.get(s.sessionId);
    if (c && (c.pid === null || c.pid === s.pid)) {
      s.surfaceId = c.surfaceId;
      s.workspaceId = c.workspaceId;
      s.lifecycle = c.lifecycle;
    }
    return s;
  };
  const hintsBySid = new Map([...hints.hints.values()].map((h) => [h.sessionId, h]));
  if (agents.ok) {
    for (const a of agents.sessions) {
      const h = hints.hints.get(a.pid);
      const own = h && h.sessionId === a.sessionId;
      sessions.push(bind({ ...a, source: "agents", statusUpdatedAt: own ? h.statusUpdatedAt : null, entrypoint: own ? h.entrypoint || null : null, nameSource: own ? h.nameSource ?? null : null, hasFile: Boolean(own) }));
      seen.add(a.sessionId);
    }
  }
  // hints: sessions not in agents (or agents unavailable)
  for (const h of hints.hints.values()) {
    if (seen.has(h.sessionId)) continue;
    const lv = alive.get(h.pid);
    if (!lv || !lv.alive) {
      const fresh = h.statusUpdatedAt && nowMs - h.statusUpdatedAt <= RECENT_MS;
      if (h.status === "busy" && fresh && !isSdk(h.entrypoint) && !mem.died.has(h.sessionId) && !mem.gone.has(h.sessionId)) mem.died.set(h.sessionId, { sessionId: h.sessionId, pid: h.pid, name: h.name, cwd: h.cwd, at: nowMs, why: lv?.reason || "gone" });
      continue;
    }
    const st = STATUSES.includes(h.status) ? h.status : null;
    sessions.push(bind({ sessionId: h.sessionId, pid: h.pid, status: st, rawStatus: h.status, waitingFor: null, name: h.name, nameSource: h.nameSource ?? null, cwd: h.cwd, kind: h.kind, entrypoint: h.entrypoint || null, startedAt: null, source: "file", statusUpdatedAt: h.statusUpdatedAt, hasFile: true }));
    seen.add(h.sessionId);
  }
  // Busy last time, now gone and dead — died mid-turn. Except:
  // - a normal exit: on exit Claude Code removes its own ~/.claude/sessions/<pid>.json (a claude -p reply,
  //   "End session" from the hub — SIGTERM, leaving the session); the file remained — the process crashed (SIGKILL, OOM, failure);
  // - background runs (entrypoint sdk-*: claude -p and the SDK) — they have their own result (reported by whichever plugin runs them);
  // - an old trace: "busy" was seen more than RECENT_MS ago (the hub was down, memory restored after downtime).
  const exited = new Set(); // exited normally or background — the cmux "running" record doesn't raise them either
  for (const [sid, prev] of mem.lastBusy) {
    if (seen.has(sid)) continue;
    const lv = alive.get(prev.pid);
    if (lv && lv.alive) continue;
    const h = hints.hints.get(prev.pid);
    if (isSdk(prev.entrypoint) || (prev.hadFile && !(h && h.sessionId === sid))) {
      exited.add(sid);
      continue;
    }
    if (!Number.isFinite(prev.seenAt) || nowMs - prev.seenAt > RECENT_MS) continue;
    if (!mem.died.has(sid) && !mem.gone.has(sid)) {
      const { seenAt, hadFile, entrypoint, ...info } = prev;
      mem.died.set(sid, { ...info, at: nowMs, why: lv?.reason || "gone" });
    }
  }
  // cmux: a turn was running, no process — fresh records only, old ones after a reboot don't count
  for (const [sid, c] of bindings) {
    if (seen.has(sid) || exited.has(sid) || mem.died.has(sid) || mem.gone.has(sid) || c.lifecycle !== "running" || !c.pid) continue;
    if (!c.updatedAt || nowMs - c.updatedAt * 1000 > RECENT_MS) continue;
    const lv = alive.get(c.pid);
    if (lv && !lv.alive) {
      const h = hintsBySid.get(sid);
      mem.died.set(sid, { sessionId: sid, pid: c.pid, name: h?.name || null, cwd: h?.cwd || null, at: nowMs, why: lv.reason, surfaceId: c.surfaceId });
    }
  }
  // memory
  mem.lastBusy = new Map(
    sessions
      .filter((s) => s.status === "busy")
      .map((s) => [s.sessionId, { sessionId: s.sessionId, pid: s.pid, name: s.name, cwd: s.cwd, surfaceId: s.surfaceId || null, seenAt: nowMs, hadFile: Boolean(s.hasFile), entrypoint: s.entrypoint || null }]),
  );
  for (const s of sessions) {
    if (s.status === "waiting") {
      if (!mem.waitingSince.has(s.sessionId)) mem.waitingSince.set(s.sessionId, s.statusUpdatedAt && s.statusUpdatedAt <= nowMs ? s.statusUpdatedAt : nowMs);
      s.waitingSince = mem.waitingSince.get(s.sessionId);
    } else mem.waitingSince.delete(s.sessionId);
    mem.died.delete(s.sessionId); // came back to life (resume with the same id)
    mem.gone.delete(s.sessionId);
  }
  for (const sid of [...mem.waitingSince.keys()]) if (!seen.has(sid)) mem.waitingSince.delete(sid);
  for (const [sid, d] of mem.died) {
    if (nowMs - d.at <= DIED_KEEP_MS) continue;
    mem.died.delete(sid);
    mem.gone.add(sid);
  }
  if (mem.gone.size > 5000) mem.gone.clear();
  const order = { waiting: 0, busy: 1, idle: 2 };
  sessions.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (a.name || "").localeCompare(b.name || ""));
  return { sessions, died: [...mem.died.values()], problems: [...new Set(problems)], agentsOk: agents.ok };
}

// ---------- output ----------
// Language — AGENTHUB_LANG (ru | en) from the core; without the variable — ru.

export function envLang() {
  return process.env.AGENTHUB_LANG === "en" ? "en" : "ru";
}
// The popover tile caption: "Claude Code Sessions" does not fit the tile (~110 pt, one line)
const TILE_LABEL = (lang = envLang()) => (lang === "en" ? "Sessions" : "Сессии");

const pl = {
  ru: (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  },
  en: (n, one, other) => (n === 1 ? one : other),
};

export const T = {
  ru: {
    min: (m) => (m < 1 ? "меньше минуты" : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${pad2(m % 60)} мин`),
    headWaiting: (n) => `${n} ${pl.ru(n, "сессия ждёт", "сессии ждут", "сессий ждут")} вас`,
    headDied: (n) => `${n} ${pl.ru(n, "сессия оборвалась", "сессии оборвались", "сессий оборвались")}`,
    headBusy: (n) => `${n} ${pl.ru(n, "работает", "работают", "работают")}, ждущих нет`,
    headIdle: "Все свободны",
    headNone: "Сессий нет",
    // the reason for "no sessions visible" — from the first problem: an update helps only with an unknown output shape
    broken: {
      // briefly: this same line is the reason in the "Safe to shut down?" card; where we looked and what to do — in the details
      noClaude: "Не найден claude — нужен Claude Code",
      failed: "claude agents --json не ответил — список сессий не прочитан",
      form: "Не получается прочитать список сессий — обновите Claude Code",
      files: "Часть данных о сессиях не читается",
    },
    problem: {
      "claude:not-found": "хаб ищет claude в ~/.local/bin, /opt/homebrew/bin и /usr/local/bin — поставьте Claude Code или положите ссылку на claude в одну из этих папок",
      "agents:failed": (x) => `claude agents --json: ${x === "timeout" ? "нет ответа за 5 с" : x}`,
      "agents:not-json": "claude agents --json: не JSON",
      "agents:not-array": "claude agents --json: не массив",
      "agents:bad-record": "claude agents --json: запись без pid/sessionId/status",
      "agents:bad-status": (x) => `claude agents --json: незнакомый status «${x}»`,
      "hints:bad-file": "~/.claude/sessions: файл без pid/sessionId",
      "cmux:not-json": "cmux claude-hook-sessions.json: не JSON",
      "cmux:no-sessions": "cmux claude-hook-sessions.json: нет sessions",
    },
    tileWaiting: (n) => `${n} ${pl.ru(n, "ждёт", "ждут", "ждут")}`,
    tileDied: (n) => `${n} оборв.`,
    tileBusy: (n) => `${n} в работе`,
    alsoBusy: (n) => ` · ${n} в работе`,
    tileShort: { waiting: (n) => `${n} ждёт`, died: (n) => `${n} оборв.`, busy: (n) => `${n} раб.` },
    tileIdle: (n) => `${n} ${pl.ru(n, "свободна", "свободны", "свободны")}`,
    unnamed: (id) => `сессия ${id}`,
    waitFor: { permission: "разрешения", question: "ответа на вопрос", input: "вашего сообщения" },
    waiting: (wf) => (wf ? `ждёт ${wf}` : "ждёт вас"),
    busy: "работает",
    idle: "свободна",
    unknown: "состояние неизвестно",
    tagBackground: (k) => `фоновая (${k})`,
    tagNoTab: "не во вкладке cmux",
    folder: (f) => `Папка: ${f}`,
    effort: (e, u, cmd) => `Effort: ${[e, u ? "⚡ultracode" : null].filter(Boolean).join(" · ")} (${cmd ? "по команде /effort" : "по последнему ходу"})`,
    model: (m, cmd) => `Модель: ${m}${cmd ? " (по команде /model)" : ""}`,
    detailsTitle: "Подробности",
    details: (pid, started, life) => `процесс ${pid}${started ? ` · запущена ${started}` : ""}${life ? ` · состояние во вкладке cmux: ${life}` : ""}`,
    byFile: "Данные из файла сессии (claude agents её не видит)",
    died: "оборвалась посреди работы",
    why: { gone: "процесс завершился", reused: "номер процесса занят другим" },
    resume: (sid) => `Продолжить: claude --resume ${sid}`,
    seen: (t) => `замечено ${t}`,
    focus: "Перейти во вкладку",
    interrupt: "Прервать ход (Esc)",
    stop: "Завершить сессию",
    sourceTitle: "Откуда данные",
    source: (ok, files, binds) => `${ok ? "claude agents --json" : "claude agents --json недоступен — только файлы сессий"} · файлов сессий ${files} · привязок к вкладкам ${binds}`,
    brokenDetail: (p) => `Подробности: ${p}`,
    pluginError: "Сбой плагина сессий",
  },
  en: {
    min: (m) => (m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad2(m % 60)} min`),
    headWaiting: (n) => `${n} ${pl.en(n, "session needs", "sessions need")} you`,
    headDied: (n) => `${n} ${pl.en(n, "session", "sessions")} stopped mid-turn`,
    headBusy: (n) => `${n} working, none waiting`,
    headIdle: "All idle",
    headNone: "No sessions",
    broken: {
      noClaude: "claude not found — Claude Code is needed",
      failed: "claude agents --json didn't answer — the session list wasn't read",
      form: "Can't read the session list — update Claude Code",
      files: "Some session data can't be read",
    },
    problem: {
      "claude:not-found": "the hub looks for claude in ~/.local/bin, /opt/homebrew/bin and /usr/local/bin — install Claude Code or link claude into one of these folders",
      "agents:failed": (x) => `claude agents --json: ${x === "timeout" ? "no answer within 5 s" : x}`,
      "agents:not-json": "claude agents --json: not JSON",
      "agents:not-array": "claude agents --json: not an array",
      "agents:bad-record": "claude agents --json: an entry without pid/sessionId/status",
      "agents:bad-status": (x) => `claude agents --json: unknown status "${x}"`,
      "hints:bad-file": "~/.claude/sessions: a file without pid/sessionId",
      "cmux:not-json": "cmux claude-hook-sessions.json: not JSON",
      "cmux:no-sessions": "cmux claude-hook-sessions.json: no sessions",
    },
    tileWaiting: (n) => `${n} waiting`,
    tileDied: (n) => `${n} stopped`,
    tileBusy: (n) => `${n} working`,
    alsoBusy: (n) => ` · ${n} working`,
    tileShort: { waiting: (n) => `${n} wait`, died: (n) => `${n} stop`, busy: (n) => `${n} run` },
    tileIdle: (n) => `${n} idle`,
    unnamed: (id) => `session ${id}`,
    waitFor: { permission: "permission", question: "an answer", input: "your message" },
    waiting: (wf) => (wf ? `waiting for ${wf}` : "needs you"),
    busy: "working",
    idle: "idle",
    unknown: "status unknown",
    tagBackground: (k) => `background (${k})`,
    tagNoTab: "not in a cmux tab",
    folder: (f) => `Folder: ${f}`,
    effort: (e, u, cmd) => `Effort: ${[e, u ? "⚡ultracode" : null].filter(Boolean).join(" · ")} (${cmd ? "set by /effort" : "as of the last turn"})`,
    model: (m, cmd) => `Model: ${m}${cmd ? " (set by /model)" : ""}`,
    detailsTitle: "Details",
    details: (pid, started, life) => `process ${pid}${started ? ` · started ${started}` : ""}${life ? ` · cmux tab state: ${life}` : ""}`,
    byFile: "From the session file (claude agents doesn't list it)",
    died: "stopped mid-turn",
    why: { gone: "process exited", reused: "its process ID now belongs to another process" },
    resume: (sid) => `Resume: claude --resume ${sid}`,
    seen: (t) => `seen at ${t}`,
    focus: "Switch to tab",
    interrupt: "Interrupt (Esc)",
    stop: "End session",
    sourceTitle: "Where the data comes from",
    source: (ok, files, binds) => `${ok ? "claude agents --json" : "claude agents --json unavailable — session files only"} · session files ${files} · tab bindings ${binds}`,
    brokenDetail: (p) => `Details: ${p}`,
    pluginError: "Sessions plugin failure",
  },
};

// What the session is waiting for (waitingFor from claude agents) → in plain words; unknown — as is.
export function waitingText(raw, lang = "ru") {
  if (!raw) return null;
  const w = String(raw).toLowerCase();
  const m = T[lang].waitFor;
  if (/permission/.test(w)) return m.permission;
  if (/question|choice|select/.test(w)) return m.question;
  if (/input|message|prompt|reply/.test(w)) return m.input;
  return clean(raw, 40);
}

// A folder inside home — "~/…" (only with a separator: /Users/u2 isn't inside /Users/u).
export function homeShort(cwd, home = homedir()) {
  const h = String(home || "").replace(/\/+$/, "");
  if (!h) return cwd;
  if (cwd === h) return "~";
  return cwd.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd;
}

// A background Claude Code run: kind isn't interactive or entrypoint is sdk-* (claude -p registers as interactive)
export const isSdk = (entrypoint) => typeof entrypoint === "string" && /^sdk/.test(entrypoint);

// Session name — like the cmux tab: -n (name in claude agents; the hub sets it on the tab at launch) → folder → id.
const label = (s, lang = "ru") => clean(s.name || (s.cwd ? basename(s.cwd) : "") || T[lang].unnamed(s.sessionId.slice(0, 8)), 50);

const fmtDurL = (ms, lang) => T[lang].min(Math.max(0, Math.floor(ms / 60_000)));

function sessionLine(s, nowMs, lang = "ru") {
  const L = T[lang];
  const p = [`session=${s.sessionId}`, `pid=${s.pid}`];
  if (s.status) p.push(`sessionStatus=${s.status}`);
  if (s.kind) p.push(`sessionKind=${q(s.kind)}`);
  if (s.waitingFor) p.push(`waitingFor=${q(s.waitingFor)}`);
  if (s.name) p.push(`sessionName=${q(s.name)}`);
  if (s.name && s.nameSource) p.push(`sessionNameSource=${s.nameSource}`);
  if (s.cwd) p.push(`sessionCwd=${q(homeShort(s.cwd))}`);
  if (s.surfaceId) p.push(`surfaceId=${s.surfaceId}`);
  if (s.workspaceId) p.push(`workspaceId=${s.workspaceId}`);
  if (s.effort && EFFORTS.includes(s.effort)) p.push(`sessionEffort=${s.effort}`);
  if (s.ultracode === true || s.ultracode === false) p.push(`sessionUltracode=${s.ultracode}`);
  // contract 3: the model, where the model and effort came from (turn or the /model, /effort command) and the time of the most recent of these
  // records — the core puts them into the registry, the sessions service into the metadata file for trusted plugins
  if (s.model && MODEL_RE.test(s.model)) p.push(`sessionModel=${q(s.model)}`);
  if (s.model && s.modelSource) p.push(`sessionModelSource=${s.modelSource}`);
  if (s.effort && s.effortSource) p.push(`sessionEffortSource=${s.effortSource}`);
  const at = [s.effortAt, s.modelAt].filter((x) => typeof x === "string" && Number.isFinite(Date.parse(x))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (at) p.push(`sessionAt=${at}`);
  let text;
  if (s.status === "waiting") {
    text = `${label(s, lang)} — ${L.waiting(waitingText(s.waitingFor, lang))} · ${fmtDurL(nowMs - (s.waitingSince || nowMs), lang)}`;
    p.push("status=wait", `event=waiting:${s.sessionId}`, "sfimage=hand.raised", "color=orange");
  } else if (s.status === "busy") {
    text = `${label(s, lang)} — ${L.busy}`;
    p.push("sfimage=bolt.fill");
  } else if (s.status === "idle") {
    text = `${label(s, lang)} — ${L.idle}`;
    p.push("sfimage=moon");
  } else {
    text = `${label(s, lang)} — ${s.rawStatus ? clean(s.rawStatus, 20) : L.unknown}`;
    p.push("sfimage=questionmark.circle");
  }
  const tags = [];
  if (s.kind && s.kind !== "interactive") tags.push(L.tagBackground(s.kind === "sdk-cli" ? "claude -p" : clean(s.kind, 20)));
  else if (isSdk(s.entrypoint)) tags.push(L.tagBackground(s.entrypoint === "sdk-cli" ? "claude -p" : clean(s.entrypoint, 20)));
  if (!s.surfaceId) tags.push(L.tagNoTab);
  return `${text}${tags.length ? ` (${tags.join(", ")})` : ""} | ${p.join(" ")}`;
}

// The header answers "do I need to do anything": waiting → died → working → free → nobody.
// The tile= parameter is a short value for the popover tile.
// Source problem code → text in the hub language ("agents:bad-status:thinking" → "…unknown status "thinking"").
export function problemText(code, lang = "ru") {
  const P = (T[lang] || T.ru).problem;
  const c = String(code);
  if (typeof P[c] === "string") return P[c];
  const m = /^([a-z]+:[a-z-]+):(.*)$/.exec(c);
  if (m && typeof P[m[1]] === "function") return P[m[1]](clean(m[2], 30));
  return clean(c, 60);
}

// What the corruption is due to: claude not found → didn't answer → unknown output shape → session files / cmux.
export function brokenKind(problems) {
  if (problems.includes("claude:not-found")) return "noClaude";
  if (problems.some((p) => p.startsWith("agents:failed"))) return "failed";
  if (problems.some((p) => p.startsWith("agents:"))) return "form";
  return "files";
}

export function render({ sessions, died, problems, agentsOk, hintsCount = 0, bindingsCount = 0 }, nowMs, lang = envLang()) {
  const L = T[lang] || T.ru;
  const brokenText = problems.length ? L.broken[brokenKind(problems)] : null;
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const busy = sessions.filter((s) => s.status === "busy").length;
  const broken = problems.length > 0;
  let status = waiting || died.length ? "wait" : "ok";
  if (broken && status === "ok") status = "unknown";
  let head;
  let tile;
  // Waiting / stopped sessions lead, but the working ones are still counted (2026-11-11: "1 waiting" alone hid that
  // two tabs were busy): "1 session needs you · 2 working".
  const also = busy ? L.alsoBusy(busy) : "";
  // The popover tile is narrow: both counts in the short form ("1 wait · 3 run"); the header keeps the full words.
  const tileBoth = (k, n) => `${L.tileShort[k](n)} · ${L.tileShort.busy(busy)}`;
  if (waiting) [head, tile] = [L.headWaiting(waiting) + also, busy ? tileBoth("waiting", waiting) : L.tileWaiting(waiting)];
  else if (died.length) [head, tile] = [L.headDied(died.length) + also, busy ? tileBoth("died", died.length) : L.tileDied(died.length)];
  else if (!agentsOk && broken && !sessions.length) [head, tile] = [brokenText, "?"];
  else if (busy) [head, tile] = [L.headBusy(busy), L.tileBusy(busy)];
  else if (sessions.length) [head, tile] = [L.headIdle, L.tileIdle(sessions.length)];
  else [head, tile] = [L.headNone, "0"];
  // The header itself names the corruption reason — the event is on it, and the body has only details the header lacks.
  const headBroken = broken && head === brokenText;
  const out = [`${head} | status=${status} tile=${q(tile)} tileLabel=${q(TILE_LABEL(lang))}${headBroken ? " event=source-broken" : ""} sfimage=${waiting ? "bubble.left.and.exclamationmark.bubble.right" : "terminal"}`, "---"];
  if (broken) {
    // "claude not found" in the details isn't a repeat of the header but where we looked and what to do; other codes — as is
    const rest = problems;
    const detail = L.brokenDetail(clean(rest.map((p) => problemText(p, lang)).join("; "), 300));
    if (headBroken) {
      if (rest.length) out.push(`${detail} | color=gray`);
    } else {
      out.push(`${brokenText} | status=unknown event=source-broken sfimage=exclamationmark.triangle`);
      out.push(`--${detail}`);
    }
  }
  for (const d of died) {
    const name = clean(d.name || (d.cwd ? basename(d.cwd) : "") || L.unnamed(d.sessionId.slice(0, 8)), 50);
    out.push(`${name} — ${L.died} (${L.why[d.why] || clean(d.why, 40)}) | status=wait event=died:${d.sessionId} sfimage=xmark.octagon color=red`);
    out.push(`--${L.resume(d.sessionId)}`);
    out.push(`--${L.detailsTitle} | details=true`);
    out.push(`----${L.seen(fmtDateTime(d.at, lang))} · ${L.details(Number.isInteger(d.pid) ? d.pid : "?", null, null)}`);
  }
  for (const s of sessions) {
    out.push(sessionLine(s, nowMs, lang));
    if (s.cwd) out.push(`--${L.folder(clean(basename(s.cwd), 60))}`);
    if (s.model) out.push(`--${L.model(clean(s.model, 64), s.modelSource === "command")}`);
    if (s.effort || s.ultracode) out.push(`--${L.effort(s.effort, s.ultracode === true, s.effortSource === "command")}`);
    out.push(`--${L.detailsTitle} | details=true`);
    out.push(`----${L.details(s.pid, s.startedAt ? fmtDateTime(s.startedAt, lang) : null, s.lifecycle)}`);
    if (s.source === "file") out.push(`----${L.byFile}`);
    // Offers to the core: arguments are ids only; the core itself checks them against the registry and tabs.
    if (UUID_RE.test(s.sessionId)) {
      if (s.surfaceId && UUID_RE.test(s.surfaceId)) {
        out.push(`--${L.focus} | effect="cmux.focus ${s.surfaceId}${s.workspaceId && UUID_RE.test(s.workspaceId) ? ` workspaceId=${s.workspaceId}` : ""}" sfimage=arrow.up.forward.app`);
      }
      // Non-interactive ones (claude -p, SDK) aren't interrupted or stopped from here: their runner has its own graceful stop.
      if ((!s.kind || s.kind === "interactive") && !isSdk(s.entrypoint)) {
        if (s.status === "busy") out.push(`--${L.interrupt} | effect="session.interrupt ${s.sessionId}" sfimage=escape`);
        out.push(`--${L.stop} | effect="session.stop ${s.sessionId}" sfimage=stop.circle`);
      }
    }
  }
  out.push("---");
  out.push(`${L.sourceTitle} | color=gray size=11`);
  out.push(`--${L.source(agentsOk, hintsCount, bindingsCount)} | color=gray size=11`);
  return out.join("\n");
}

// ---------- polling ----------

export async function poll({ home = homedir(), mem, nowMs = Date.now(), effortCache = null }) {
  const claude = bin("claude", which("claude"));
  let agents;
  if (!claude) agents = { ok: false, sessions: [], problems: ["claude:not-found"] };
  else {
    const r = await run(claude, ["agents", "--json"], { timeoutMs: 5000 });
    agents = r.code === 0 ? parseAgents(r.stdout) : { ok: false, sessions: [], problems: [`agents:failed:${r.error || `exit ${r.code}`}`] };
  }
  const hints = readHints(join(home, ".claude", "sessions"));
  const cmuxPath = join(home, ".cmuxterm", "claude-hook-sessions.json");
  let cmux = null;
  if (existsSync(cmuxPath)) {
    try {
      cmux = parseCmux(readFileSync(cmuxPath, "utf8"));
    } catch {
      cmux = null;
    }
  }
  const bindings = cmux?.ok ? cmux.bySession : new Map();
  const agentSids = new Set(agents.sessions.map((a) => a.sessionId));
  const pids = [];
  for (const h of hints.hints.values()) if (!agentSids.has(h.sessionId)) pids.push(h.pid);
  for (const [sid, prev] of mem.lastBusy) if (!agentSids.has(sid)) pids.push(prev.pid);
  for (const [sid, c] of bindings) if (!agentSids.has(sid) && c.lifecycle === "running" && c.pid) pids.push(c.pid);
  const alive = await checkAlive(pids, hints.hints, bindings);
  const merged = merge({ agents, hints, cmux, alive, mem, nowMs });
  if (effortCache) attachEffort(merged.sessions, { home, cache: effortCache, nowMs });
  return render({ ...merged, hintsCount: hints.count, bindingsCount: bindings.size }, nowMs, envLang());
}

// The frame for a failed poll: the same short tile caption as a normal frame, so the popover tile keeps its name.
export function brokenFrame(err, lang = envLang()) {
  return `${T[lang].pluginError} | status=unknown tileLabel=${q(TILE_LABEL(lang))}\n---\n${clean(err?.message || err, 140)} | event=source-broken`;
}

async function main() {
  const dataDir = process.env.AGENTHUB_PLUGIN_DATA_PATH || null;
  const memPath = dataDir ? join(dataDir, "memory.json") : null;
  const effortPath = dataDir ? join(dataDir, "effort.json") : null;
  const mem = memPath ? loadMemory(memPath) : newMemory();
  const pollMs = Number(process.env.AGENTHUB_TEST_POLL_MS) || 2000;
  const effortCache = effortPath ? loadEffortCache(effortPath) : newEffortCache();
  let timer = null;
  let busy = false;
  let again = false;
  let last = null;
  const tick = async () => {
    clearTimeout(timer);
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const now = process.env.AGENTHUB_TEST_NOW ? Date.parse(process.env.AGENTHUB_TEST_NOW) : Date.now();
      let frame;
      try {
        frame = await poll({ mem, nowMs: now, effortCache });
      } catch (e) {
        frame = brokenFrame(e);
      }
      if (frame !== last) {
        process.stdout.write(`${frame}\n~~~\n`);
        last = frame;
      }
      if (memPath) {
        try {
          saveMemory(memPath, mem);
        } catch {}
        try {
          saveEffortCache(effortPath, effortCache);
        } catch {}
      }
    } finally {
      busy = false;
      if (again) {
        again = false;
        setImmediate(tick);
      } else timer = setTimeout(tick, pollMs);
    }
  };
  let kick = null;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && (msg.type === "fileChanged" || msg.type === "refresh")) {
      clearTimeout(kick);
      kick = setTimeout(tick, 100);
    }
  });
  rl.on("close", () => process.exit(0)); // the core closed stdin — we've been stopped
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
