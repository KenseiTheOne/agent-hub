#!/usr/bin/env node
// Codex CLI token spend journal: when and how many tokens were spent, by day, session, model and token type.
//
// <agenthub.title>Codex Расход</agenthub.title>
// <agenthub.title lang="en">Codex Spend</agenthub.title>
// <agenthub.version>0.1.2</agenthub.version>
// <agenthub.author.name>Kensei</agenthub.author.name>
// <agenthub.author.github>KenseiTheOne</agenthub.author.github>
// <agenthub.desc>Журнал токенов Codex: сколько и когда потрачено по дням, сессиям и моделям, плюс весь расход аккаунта по данным Codex</agenthub.desc>
// <agenthub.desc lang="en">Codex token journal: how much and when, by day, session and model, plus the whole account's usage as Codex reports it</agenthub.desc>
// <agenthub.requires name="Codex" url="https://github.com/openai/codex" check="~/.codex">агент, чей расход токенов считает плагин</agenthub.requires>
// <agenthub.requires lang="en" name="Codex">the agent whose token spend this plugin counts</agenthub.requires>
// <agenthub.status value="ok" label="Расход посчитан">Числа посчитаны по файлам сессий Codex</agenthub.status>
// <agenthub.status value="ok" lang="en" label="Spend counted">Numbers counted from Codex session files</agenthub.status>
// <agenthub.status value="unknown" label="Codex не найден">Папки ~/.codex нет — считать нечего</agenthub.status>
// <agenthub.status value="unknown" lang="en" label="Codex not found">There is no ~/.codex folder — nothing to count</agenthub.status>
// <agenthub.type>streamable</agenthub.type>
// <agenthub.platforms>macos</agenthub.platforms>
// <agenthub.fsRead>~/.codex/sessions/*/*/*/rollout-*.jsonl — только числа usage, id ответа, turn_id, модель, время и папка сессии; текст переписки не берётся и не пишется</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/sessions/*/*/*/rollout-*.jsonl — only usage numbers, the response id, turn_id, model, time and the session folder; no conversation text is taken or written</agenthub.fsRead>
// <agenthub.fsRead>~/.codex/archived_sessions/rollout-*.jsonl — то же для архивных сессий</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/archived_sessions/rollout-*.jsonl — the same for archived sessions</agenthub.fsRead>
// <agenthub.watch recursive="true">~/.codex/sessions — сессия дописала файл: обновить сегодняшние числа</agenthub.watch>
// <agenthub.watch recursive="true" lang="en">~/.codex/sessions — a session appended to its file: update today's numbers</agenthub.watch>
// <agenthub.exec>codex app-server — не чаще раза в 15 минут (через 5, если сессии писали; раз в час без входа по ChatGPT): initialize и account/usage/read по stdio (токены аккаунта по дням), затем процесс закрывается; токен читает сам Codex, и при каждом запуске он обновляет свои кэши и базы в ~/.codex</agenthub.exec>
// <agenthub.exec lang="en">codex app-server — at most every 15 minutes (after 5 if sessions wrote; hourly when not signed in with ChatGPT): initialize and account/usage/read over stdio (the account's tokens by day), then the process exits; Codex reads its own token, and each run makes it refresh its own caches and databases under ~/.codex</agenthub.exec>
// <agenthub.contract>3</agenthub.contract>
// <agenthub.icon symbol="chart.bar.xaxis" color="#10A37F"></agenthub.icon>
//
// Source 1 — session files on this Mac (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and ~/.codex/archived_sessions):
// - Codex 0.159+: one `token_usage_record` line per model response, `usage` = that response's tokens. Requests are
//   deduplicated by `response_id` and count only in their own thread's file (payload.thread_id).
// - Older Codex: `event_msg` `token_count` with `info.last_token_usage`, deduplicated on (line time + running totals);
//   a count repeating the previous running total (a resume) is skipped. In a file that has `token_usage_record` lines
//   the `token_count` events are ignored (they repeat the same numbers).
// - Forks and spawned agents copy the parent's lines (with fresh timestamps) first: see prefixStep.
// - The model of a request is the `turn_context.model` of its turn (`turn_id`), otherwise the file's last model.
// Only those fields are taken; a line is filtered by its type before JSON.parse, message lines are never parsed, and no
// text reaches the output, the index or a log. Token types: new input = input − cached, cached input, output
// (reasoning is part of output and is shown as its share).
//
// Source 2 — Codex itself: rarely (see callDue) `codex app-server` (stdio JSON-RPC) answers `account/usage/read` with the
// account's tokens by day. That includes runs without a session file (`codex exec --ephemeral`) and other devices, so
// the page shows it next to "sessions on this Mac". The plugin never opens Codex's credentials and never calls the
// backend itself. Not signed in / no network — the section says so, the file numbers stay.
//
// Indexing is incremental like the Claude Code spend plugin: per file size, mtime, inode, offset of the last complete
// line, its format and last model are kept in PluginData/index.json with the daily buckets and the hashed dedupe keys.
// Files last modified before the horizon (the earlier of the month start and 29 days before today) are not opened.
// Files are read oldest name first.
//
// No prices: tokens only. The status is always ok (unknown without ~/.codex). No events.
// stdin: refresh — rescan now and ask Codex if the last call is older than 5 min; fileChanged — rescan.
//
// For tests: AGENTHUB_TEST_BIN_DIR (a fake codex), AGENTHUB_TEST_NOW, AGENTHUB_CODEX_SPEND_TICK_MS (rescan interval,
// default 30 s), AGENTHUB_CODEX_USAGE_MS (server interval, default 15 min), AGENTHUB_CODEX_RPC_TIMEOUT_MS.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
const MIN = 60_000;
const RPC_TIMEOUT_MS = Math.max(500, Number(process.env.AGENTHUB_CODEX_RPC_TIMEOUT_MS) || 20_000);
// Each server call makes Codex refresh its own caches and databases under ~/.codex, so calls are rare: at most every
// USAGE_MS, sooner (but USAGE_SOON_MS apart) when a session file changed since the last call, a manual refresh after
// USAGE_MANUAL_MS; after "API key", "not signed in" or "no codex" only every USAGE_BACKOFF_MS (a refresh still asks).
const USAGE_MS = Math.max(1000, Number(process.env.AGENTHUB_CODEX_USAGE_MS) || 15 * MIN);
const USAGE_SOON_MS = Math.min(5 * MIN, USAGE_MS);
const USAGE_MANUAL_MS = Math.min(5 * MIN, USAGE_MS);
const USAGE_BACKOFF_MS = Math.max(60 * MIN, USAGE_MS);
const BACKOFF_ERRORS = new Set(["api-key", "not-logged-in", "no-codex"]);
// Is a server call due? { nowMs, calledAt, error, manual, changed (a session file changed after calledAt) }
export function callDue({ nowMs, calledAt, error, manual = false, changed = false }, { every = USAGE_MS, soon = USAGE_SOON_MS, manualMin = USAGE_MANUAL_MS, backoff = USAGE_BACKOFF_MS } = {}) {
  const since = nowMs - (calledAt || 0);
  if (manual) return since >= manualMin;
  if (BACKOFF_ERRORS.has(error)) return since >= backoff;
  return since >= every || (changed && since >= soon);
}

// ---------- formatting ----------
export function clean(text, max = 120) {
  let s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\|/g, "¦").replace(/\s+/g, " ").trim();
  s = s.replace(/^[-~]+/, "").trim();
  if ([...s].length > max) s = [...s].slice(0, max - 1).join("") + "…";
  return s;
}
const q = (v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
export function line(title, params = {}) {
  const ps = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}=${/^[\w.:/+#-]+$/.test(String(v)) ? v : q(v)}`);
  return ps.length ? `${title} | ${ps.join(" ")}` : title;
}
export function envLang() {
  return process.env.AGENTHUB_LANG === "en" ? "en" : "ru";
}
const group3 = (n, sep) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
const dec = (v, d, lang) => (lang === "en" ? v.toFixed(d) : v.toFixed(d).replace(".", ","));
// Tokens: "1.75B", "236M", "5.3M", "828K", "1.7K", "424" (ru "1,75 млрд", "236 млн", "828 тыс.").
export function fmtTokens(n, lang = "ru") {
  const en = lang === "en";
  const u = (v, d, e, r) => (en ? `${dec(v, d, lang)}${e}` : `${dec(v, d, lang)} ${r}`);
  if (n >= 995e6) return u(n / 1e9, 2, "B", "млрд");
  if (n >= 99.95e6) return u(Math.round(n / 1e6), 0, "M", "млн");
  if (n >= 999.5e3) return u(n / 1e6, 1, "M", "млн");
  if (n >= 9.95e3) return u(Math.round(n / 1e3), 0, "K", "тыс.");
  if (n >= 1e3) return u(n / 1e3, 1, "K", "тыс.");
  return String(Math.round(n));
}
// Tokens for a bar caption or a tile: "2.0B", "990M", "14K" (ru "2,0 млрд", "990 млн").
export function fmtTokensShort(n, lang = "ru") {
  const en = lang === "en";
  const u = (v, d, e, r) => (en ? `${dec(v, d, lang)}${e}` : `${dec(v, d, lang)} ${r}`);
  if (n >= 999.5e6) return u(n / 1e9, 1, "B", "млрд");
  if (n >= 999.5e3) return u(Math.round(n / 1e6), 0, "M", "млн");
  if (n >= 1e3) return u(Math.round(n / 1e3), 0, "K", "тыс.");
  return String(Math.round(n));
}
const pad2 = (n) => String(n).padStart(2, "0");
const WD = { ru: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_RU = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTH_RU = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// The local calendar day of a moment: "2026-11-11".
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const dayStart = (ms, back = 0) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
};
const keyDate = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
// "Wed Nov 11" / "ср 11 ноя"
export function fmtDay(key, lang) {
  const dt = keyDate(key);
  return lang === "en" ? `${WD.en[dt.getDay()]} ${MON[dt.getMonth()]} ${dt.getDate()}` : `${WD.ru[dt.getDay()]} ${dt.getDate()} ${MON_RU[dt.getMonth()]}`;
}
const fmtHm = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const pctOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
const pctText = (p) => (p > 0 && p < 0.5 ? "<1%" : `${Math.round(p)}%`);
// Numbers in the chart data: no exponent, at most 4 decimals.
const num = (x) => (Number.isFinite(x) && x > 0 ? String(Math.round(x * 1e4) / 1e4) : "0");
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- token buckets ----------
// [requests, new input, cached input, output, reasoning (part of output)]
export const N = 0, IN = 1, CACHED = 2, OUT = 3, REASON = 4;
export const zero = () => [0, 0, 0, 0, 0];
const addTo = (a, b) => {
  for (let i = 0; i < a.length; i++) a[i] += b[i] || 0;
  return a;
};
export const tokensOf = (v) => v[IN] + v[CACHED] + v[OUT];
const nz = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
// A usage object ({input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}) → bucket values
export function usageVals(u) {
  if (!u || typeof u !== "object") return null;
  const input = nz(u.input_tokens);
  const cached = Math.min(input, nz(u.cached_input_tokens));
  const out = nz(u.output_tokens);
  if (!input && !out) return null;
  return [1, input - cached, cached, out, Math.min(out, nz(u.reasoning_output_tokens))];
}

// Codex home: $CODEX_HOME or ~/.codex.
export function codexHome(env = process.env, home = homedir()) {
  const h = env.CODEX_HOME;
  return h && h.startsWith("/") ? h : join(home, ".codex");
}
// The session kind of a session_meta `source`: cli (the terminal UI), ide, exec, sub (a subagent), other.
export function kindOf(source) {
  if (typeof source === "string") {
    if (source === "cli") return "cli";
    if (source === "vscode" || source === "ide") return "ide";
    if (source === "exec") return "exec";
    return "other";
  }
  if (source && typeof source === "object" && "subagent" in source) return "sub";
  return "other";
}
const THREAD_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// One rollout line → a record, or null. Lines are filtered by their type before parsing: message lines (response_item,
// event_msg other than token_count) are never parsed.
//   { t: "meta", id, cwd, kind, inherits, ms }  { t: "turn", turn, model }  { t: "rec", key, thread, turn, ms, vals }
//   { t: "tc", key, total, ms, vals }  { t: "tsa", thread }
// `thread_settings_applied` is never parsed (its snapshot may hold instructions): its thread id is matched on the line head.
const TSA_RE = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"event_msg","payload":\{"type":"thread_settings_applied"(?:,"thread_id":"([0-9a-f-]{36})")?/i;
export function parseRolloutLine(text) {
  if (!text) return null;
  const head = text.slice(0, 200);
  let kind;
  if (head.includes('"type":"thread_settings_applied"')) {
    const m = TSA_RE.exec(head);
    return m ? { t: "tsa", thread: m[1] ? m[1].toLowerCase() : null } : null;
  }
  if (head.includes('"type":"token_usage_record"')) kind = "rec";
  else if (head.includes('"type":"turn_context"')) kind = "turn";
  else if (head.includes('"type":"session_meta"')) kind = "meta";
  else if (text.includes('"type":"token_count"') && head.includes('"type":"event_msg"')) kind = "tc";
  else return null;
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const p = o?.payload;
  if (!p || typeof p !== "object") return null;
  const ms = Date.parse(o.timestamp);
  if (kind === "meta" && o.type === "session_meta") {
    const id = typeof p.id === "string" ? p.id : null;
    // a fork (forked_from_id) or a spawned agent (parent_thread_id, a subagent source) starts with a copy of another
    // thread's lines
    const inherits = Boolean(p.forked_from_id || p.parent_thread_id || kindOf(p.source) === "sub");
    return { t: "meta", id, cwd: typeof p.cwd === "string" ? p.cwd : null, kind: kindOf(p.source), inherits, ms: Number.isFinite(ms) ? ms : Date.parse(p.timestamp) || null };
  }
  if (kind === "turn" && o.type === "turn_context") {
    return { t: "turn", turn: typeof p.turn_id === "string" ? p.turn_id : null, model: typeof p.model === "string" ? clean(p.model, 60) : null };
  }
  if (!Number.isFinite(ms)) return null;
  if (kind === "rec" && o.type === "token_usage_record") {
    const vals = usageVals(p.usage);
    if (!vals) return null;
    const key = typeof p.response_id === "string" && p.response_id ? `r:${p.response_id}` : `t:${o.timestamp}|${p.turn_id}|${p.usage?.total_tokens}`;
    return { t: "rec", key, thread: typeof p.thread_id === "string" ? p.thread_id.toLowerCase() : null, turn: typeof p.turn_id === "string" ? p.turn_id : null, ms, vals };
  }
  if (kind === "tc" && o.type === "event_msg" && p.type === "token_count") {
    const vals = usageVals(p.info?.last_token_usage);
    if (!vals) return null;
    const total = p.info?.total_token_usage?.total_tokens;
    return { t: "tc", key: `c:${o.timestamp}|${total}|${p.info?.last_token_usage?.total_tokens}`, total: typeof total === "number" ? total : null, ms, vals };
  }
  return null;
}

// ---------- the index ----------
const CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
export const DAYS_KEPT = 30;
const INDEX_VERSION = 2;
// A copied prefix is written in one burst (milliseconds apart); the first pause this long ends it in a file without a marker.
const PREFIX_GAP_MS = 1500;
const LINE_TS_RE = /^\{"timestamp":"([^"]{10,40})"/;
const MAX_THREADS = 2000;
const hashKey = (k) => createHash("sha1").update(k).digest("base64url").slice(0, 12);
function safeReaddir(p) {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class CodexSpendIndex {
  constructor({ home = homedir(), codex = null, cachePath = null, now = () => Date.now(), sliceBytes = 64 * 1024 * 1024 } = {}) {
    this.home = home;
    this.codex = codex || codexHome(process.env, home);
    this.cachePath = cachePath;
    this.now = now;
    this.sliceBytes = sliceBytes;
    this.days = {}; // day → { m: {model: vals}, t: {threadId: vals} }
    this.threads = {}; // threadId → { cwd, kind, ms }
    this.keys = new Map(); // hashed request key → day
    // path relative to the codex home → [size, mtimeMs, ino, offset, newFormat 0|1, lastModel, threadId,
    //   prefix state (0 own lines, 1 after a fork's own session_meta, 2 inside the copied prefix), last line ms, last token_count total]
    this.files = {};
    this.pending = [];
    this.progress = { files: 0, total: 0, bytes: 0, totalBytes: 0 };
    this.indexedOnce = false;
    this.indexedAt = 0;
    this.dirty = false;
    this.horizonKey = null;
    this.sourceMissing = false;
    this.compressed = 0;
  }

  horizon() {
    const now = this.now();
    const d = new Date(now);
    return Math.min(dayStart(now, DAYS_KEPT - 1), new Date(d.getFullYear(), d.getMonth(), 1).getTime());
  }

  load() {
    if (!this.cachePath) return;
    let c;
    try {
      c = JSON.parse(readFileSync(this.cachePath, "utf8"));
    } catch {
      return;
    }
    if (!c || c.v !== INDEX_VERSION || typeof c.days !== "object" || typeof c.files !== "object") return;
    this.days = c.days || {};
    this.files = c.files || {};
    this.threads = c.threads && typeof c.threads === "object" ? c.threads : {};
    for (const [day, s] of Object.entries(c.keys || {})) {
      if (typeof s !== "string") continue;
      for (let i = 0; i + 12 <= s.length; i += 12) this.keys.set(s.slice(i, i + 12), day);
    }
    this.indexedOnce = Boolean(c.indexedOnce);
    this.indexedAt = Number(c.indexedAt) || 0;
  }

  save() {
    if (!this.cachePath || !this.dirty) return;
    const keys = {};
    for (const [h, day] of this.keys) (keys[day] ||= []).push(h);
    for (const d of Object.keys(keys)) keys[d] = keys[d].join("");
    const body = JSON.stringify({ v: INDEX_VERSION, indexedOnce: this.indexedOnce, indexedAt: this.indexedAt, days: this.days, threads: this.threads, keys, files: this.files });
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.cachePath);
      this.dirty = false;
    } catch {}
  }

  // Drop days before the horizon (buckets and keys) and threads no kept day mentions.
  prune() {
    const hk = dayKey(this.horizon());
    if (hk === this.horizonKey) return;
    this.horizonKey = hk;
    for (const d of Object.keys(this.days)) {
      if (d < hk) {
        delete this.days[d];
        this.dirty = true;
      }
    }
    for (const [h, d] of this.keys) if (d < hk) this.keys.delete(h);
    const used = new Set();
    for (const d of Object.values(this.days)) for (const t of Object.keys(d.t || {})) used.add(t);
    for (const f of Object.values(this.files)) if (f[6]) used.add(f[6]);
    for (const t of Object.keys(this.threads)) if (!used.has(t)) delete this.threads[t];
  }

  // Session files: sessions/YYYY/MM/DD/rollout-*.jsonl and archived_sessions/rollout-*.jsonl (flat; a nested date
  // layout is accepted too). Files last modified before the horizon are not opened; .jsonl.zst files are counted, not read.
  scan() {
    this.prune();
    const horizon = this.horizon();
    const found = [];
    this.sourceMissing = !isDir(this.codex);
    let compressed = 0;
    const add = (rel) => {
      let st;
      try {
        st = statSync(join(this.codex, rel));
      } catch {
        return;
      }
      if (!st.isFile() || st.mtimeMs < horizon) return;
      found.push({ rel, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    };
    const walk = (rel, depth) => {
      for (const e of safeReaddir(join(this.codex, rel))) {
        if (e.name.startsWith(".")) continue;
        if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) add(join(rel, e.name));
        else if (e.isFile() && /^rollout-.*\.jsonl\.zst$/.test(e.name)) compressed++;
        else if (e.isDirectory() && depth < 3 && /^\d{1,4}$/.test(e.name)) walk(join(rel, e.name), depth + 1);
      }
    };
    walk("sessions", 0);
    walk("archived_sessions", 0);
    this.compressed = compressed;
    const seen = new Set(found.map((f) => f.rel));
    for (const rel of Object.keys(this.files)) {
      if (!seen.has(rel)) {
        delete this.files[rel];
        this.dirty = true;
      }
    }
    const pending = [];
    for (const f of found) {
      const s = this.files[f.rel];
      if (s && s[2] === f.ino && s[3] <= f.size && s[0] === f.size && s[1] === f.mtimeMs) continue;
      if (s && (s[2] !== f.ino || f.size < s[3])) s.splice(3, s.length, 0, 0, null, s[6], 0, 0, null); // replaced or truncated: from the start, the keys stop doubles
      pending.push({ ...f, offset: s ? s[3] : 0, fmt: s ? s[4] : 0, model: s ? s[5] : null, thread: s ? s[6] : null, pre: s ? s[7] || 0 : 0, lastMs: s ? s[8] || 0 : 0, total: s ? s[9] ?? null : null, skip: false, turns: new Map() });
    }
    // oldest name first (the name starts with the session's start time): a fork's copied requests stay with the original
    pending.sort((a, b) => (basename(a.rel) < basename(b.rel) ? -1 : basename(a.rel) > basename(b.rel) ? 1 : 0));
    this.pending = pending;
    this.progress = { files: 0, total: pending.length, bytes: 0, totalBytes: pending.reduce((a, f) => a + Math.max(0, f.size - f.offset), 0) };
    return pending.length;
  }

  get indexing() {
    return this.pending.length > 0;
  }

  step(budget = this.sliceBytes) {
    while (this.pending.length && budget > 0) {
      const f = this.pending[0];
      const used = this.readFile(f, budget);
      budget -= Math.max(used, 1);
      if (f.done) {
        this.pending.shift();
        this.progress.files++;
        this.files[f.rel] = [f.size, f.mtimeMs, f.ino, f.offset, f.fmt, f.model, f.thread, f.pre, f.lastMs, f.total];
        this.dirty = true;
      }
    }
    if (!this.pending.length) {
      if (!this.indexedOnce) this.dirty = true;
      this.indexedOnce = true;
      this.indexedAt = this.now();
    }
    return !this.pending.length;
  }

  readFile(f, budget) {
    let fd;
    try {
      fd = openSync(join(this.codex, f.rel), "r");
    } catch {
      f.done = true;
      return 0;
    }
    let used = 0;
    try {
      const st = fstatSync(fd);
      if (st.ino !== f.ino) {
        f.ino = st.ino;
        f.offset = 0;
        f.fmt = 0;
        f.pre = 0;
        f.lastMs = 0;
        f.total = null;
      }
      f.size = st.size;
      f.mtimeMs = st.mtimeMs;
      f.first = f.offset === 0;
      if (!f.thread) f.thread = THREAD_RE.exec(f.rel)?.[1]?.toLowerCase() || null;
      while (used < budget) {
        if (f.offset >= f.size) {
          f.done = true;
          break;
        }
        let len = Math.min(CHUNK, f.size - f.offset);
        let buf;
        let nl = -1;
        let got = 0;
        for (;;) {
          buf = Buffer.allocUnsafe(len);
          got = readSync(fd, buf, 0, len, f.offset);
          nl = buf.lastIndexOf(10, got - 1);
          if (nl >= 0 || f.offset + got >= f.size || len >= MAX_LINE) break;
          len = Math.min(len * 4, MAX_LINE, f.size - f.offset);
        }
        used += got;
        this.progress.bytes += got;
        if (nl < 0) {
          if (f.offset + got >= f.size) {
            f.done = true;
            break;
          }
          f.offset += got;
          f.skip = true;
          f.first = false;
          continue;
        }
        const lines = buf.toString("utf8", 0, nl).split("\n");
        if (f.skip) {
          lines.shift();
          f.skip = false;
        }
        f.offset += nl + 1;
        for (const l of lines) this.ingest(l, f);
      }
    } finally {
      closeSync(fd);
    }
    return used;
  }

  // Forks and spawned agents: Codex copies the parent's lines into the child's file with fresh timestamps, so they can't
  // be told apart by time or (for token_count) by key. A token_usage_record counts only in its own thread's file
  // (payload.thread_id). A token_count inside the copied prefix is skipped; the prefix ends at the child's own
  // thread_settings_applied (Codex 0.159 appends it right after the copy), its first own token_usage_record, or — for a
  // file written by an older Codex without that marker — the first pause of PREFIX_GAP_MS between lines.
  prefixStep(text, r, f) {
    if (r?.t === "tsa" && r.thread && r.thread === f.thread) return (f.pre = 0);
    if (r?.t === "rec" && r.thread && r.thread === f.thread) return (f.pre = 0);
    const ms = Date.parse(LINE_TS_RE.exec(text)?.[1] || "");
    if (!Number.isFinite(ms)) return;
    if (f.pre === 2 && ms - f.lastMs >= PREFIX_GAP_MS) f.pre = 0;
    else if (f.pre === 1) f.pre = 2;
    f.lastMs = ms;
  }

  ingest(text, f) {
    const r = parseRolloutLine(text);
    const first = f.first;
    f.first = false;
    if (f.pre) this.prefixStep(text, r, f);
    if (!r) return;
    if (r.t === "meta") {
      // the first session_meta of a file is its own; a fork repeats its parent's later
      const own = r.id && (!f.thread || f.thread === r.id.toLowerCase());
      if (own && first && r.inherits) f.pre = 1;
      if (own && !this.threads[f.thread || r.id]) {
        f.thread = r.id.toLowerCase();
        this.threads[f.thread] = { cwd: r.cwd ? clean(r.cwd, 300) : null, kind: r.kind, ms: r.ms || null };
        if (Object.keys(this.threads).length > MAX_THREADS) delete this.threads[Object.keys(this.threads)[0]];
        this.dirty = true;
      }
      return;
    }
    if (r.t === "tsa") return;
    if (r.t === "turn") {
      if (r.model) {
        f.model = r.model;
        if (r.turn) f.turns.set(r.turn, r.model);
      }
      return;
    }
    if (r.t === "rec") {
      f.fmt = 1;
      if (r.thread && f.thread && r.thread !== f.thread) return; // copied from the parent
    } else {
      if (f.fmt) return; // token_count repeats the token_usage_record numbers in a new-format file
      const repeat = r.total !== null && r.total === f.total; // a resumed old-format session repeats the last count
      if (r.total !== null) f.total = r.total;
      if (f.pre || repeat) return;
    }
    const day = dayKey(r.ms);
    if (this.horizonKey && day < this.horizonKey) return;
    const h = hashKey(r.key);
    if (this.keys.has(h)) return;
    this.keys.set(h, day);
    const model = (r.turn && f.turns.get(r.turn)) || f.model || "?";
    const d = (this.days[day] ||= { m: {}, t: {} });
    addTo((d.m[model] ||= zero()), r.vals);
    if (f.thread) addTo(((d.t ||= {})[f.thread] ||= zero()), r.vals);
    this.dirty = true;
  }
}

// ---------- codex app-server: account/usage/read ----------
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
export function codexBin() {
  const dir = process.env.AGENTHUB_TEST_BIN_DIR;
  if (dir) return existsSync(join(dir, "codex")) ? join(dir, "codex") : null;
  const p = which("codex");
  if (p) return p;
  const app = "/Applications/Codex.app/Contents/Resources/codex";
  try {
    accessSync(app, constants.X_OK);
    return app;
  } catch {
    return null;
  }
}
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("AGENTHUB_")) env[k] = v;
  // the short-lived server must not register itself for remote control
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  return env;
}
// One short stdio JSON-RPC session (initialize, initialized, one request), then stdin is closed (the server exits on
// EOF); a server still alive a second later gets SIGTERM, then SIGKILL. → { result } | { error: {message} } | { fail: code }
export function appServerRequest(bin, method, params, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: childEnv(), cwd: homedir() });
    } catch {
      resolve({ fail: "spawn" });
      return;
    }
    let done = false;
    let exited = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      if (!exited) {
        const term = setTimeout(() => {
          if (exited) return;
          try {
            child.kill("SIGTERM");
          } catch {}
          const kill = setTimeout(() => {
            if (!exited)
              try {
                child.kill("SIGKILL");
              } catch {}
          }, 3000);
          kill.unref?.();
        }, 1000);
        term.unref?.();
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ fail: "timeout" }), timeoutMs);
    child.on("error", () => {
      exited = true;
      finish({ fail: "spawn" });
    });
    child.on("exit", (code) => {
      exited = true;
      finish({ fail: `exit ${code ?? "signal"}` });
    });
    child.stdin.on("error", () => {});
    const send = (m) => {
      try {
        child.stdin.write(JSON.stringify(m) + "\n");
      } catch {}
    };
    createInterface({ input: child.stdout }).on("line", (l) => {
      if (done) return;
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      if (!m || typeof m !== "object" || m.id === undefined || m.method !== undefined) return;
      if (m.id === 1) {
        if (m.error) return finish({ error: { message: clean(m.error.message, 200) } });
        send({ method: "initialized" });
        send(params === undefined ? { id: 2, method } : { id: 2, method, params });
        return;
      }
      if (m.id === 2) finish(m.error ? { error: { message: clean(m.error.message, 200) } } : { result: m.result });
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent_hub", title: "Agent Hub", version: VERSION } } });
  });
}
// account/usage/read → { days: {"YYYY-MM-DD": tokens}, lifetime } | null (an unknown shape)
export function parseUsage(r) {
  if (!r || typeof r !== "object") return null;
  const b = r.dailyUsageBuckets;
  if (b !== null && b !== undefined && !Array.isArray(b)) return null;
  const days = {};
  for (const x of b || []) {
    if (!x || typeof x.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(x.startDate) || typeof x.tokens !== "number") continue;
    const k = x.startDate.slice(0, 10);
    days[k] = (days[k] || 0) + Math.max(0, x.tokens);
  }
  const life = r.summary?.lifetimeTokens;
  return { days, lifetime: typeof life === "number" && life >= 0 ? life : null, hasDays: Array.isArray(b) };
}
const reasonOf = (msg) => {
  const m = String(msg || "").toLowerCase();
  if (/chatgpt authentication required/.test(m)) return "api-key";
  if (/authentication required|not logged in|unauthori[sz]ed|login/.test(m)) return "not-logged-in";
  return "rpc";
};
// → server state { atMs, days, lifetime, error, calledAt }
export async function fetchUsage(prev, nowMs) {
  const bin = codexBin();
  if (!bin) return { ...prev, error: "no-codex", calledAt: nowMs };
  const r = await appServerRequest(bin, "account/usage/read");
  if (r.result !== undefined) {
    const p = parseUsage(r.result);
    if (p) return { atMs: nowMs, days: p.days, lifetime: p.lifetime, hasDays: p.hasDays, error: null, calledAt: nowMs };
    return { ...prev, error: "bad-response", calledAt: nowMs };
  }
  return { ...prev, error: r.error ? reasonOf(r.error.message) : r.fail || "rpc", calledAt: nowMs };
}
export function loadServer(path) {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (c && c.v === 1) return { atMs: Number(c.atMs) || 0, days: c.days && typeof c.days === "object" ? c.days : {}, lifetime: typeof c.lifetime === "number" ? c.lifetime : null, hasDays: Boolean(c.hasDays), error: typeof c.error === "string" ? c.error : null, calledAt: Number(c.calledAt) || 0 };
  } catch {}
  return { atMs: 0, days: {}, lifetime: null, hasDays: false, error: null, calledAt: 0 };
}
function saveServer(path, s) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ v: 1, ...s }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch {}
}

// ---------- texts ----------
const NL = "\\n";
const cntRu = (n) => group3(n, " ");
const cntEn = (n) => group3(n, ",");
export const T = {
  ru: {
    tileLabel: "Codex расход",
    head: (t, n) => `Codex сегодня ${t} токенов · ${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")}`,
    headIndexing: (t, p) => `Codex сегодня ≥ ${t} токенов · считаю файлы сессий, ${p}`,
    headMissing: "Codex не найден — считать нечего",
    paused: " · хаб на паузе",
    todayBy: (hm) => `Сегодня на этом Mac, к ${hm}`,
    todayIndexing: (p) => `Сегодня · считаю файлы сессий, ${p}`,
    heroNote: (n, c) => `${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")} · из кэша ${c}`,
    allToday: (t) => `весь Codex за сегодня — ${t} (по данным Codex)`,
    days14: "14 дней",
    avgPerDay: (t) => `в среднем ${t} в день`,
    disclaimer: "Только токены, без цен: Codex на подписке. Кэш — часть входа, рассуждения — часть ответов",
    yesterday: "Вчера",
    week: "7 дней",
    perDay: (t) => `${t} в день`,
    forDays: (n) => `за ${n} ${plural(n, "день", "дня", "дней")}`,
    reqs: (n) => `${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")}`,
    statTip: (t, n) => `${t} токенов · ${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")}`,
    indexing: (a, b) => `Считаю файлы сессий: ${a} из ${b}`,
    byDay: "По дням · сессии на этом Mac",
    avgShort: (t) => `ср. ${t}`,
    byHm: (hm) => `, к ${hm}`,
    tipEmpty: (date) => `${date}${NL}запросов не было`,
    cached: "Вход из кэша",
    inp: "Новый вход",
    out: "Ответы модели",
    reason: "из них рассуждения",
    tipDay: (date, total, n) => `${date} — ${total} токенов${NL}${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")}`,
    tipAll: (t) => `весь Codex: ${t}`,
    byType: "По видам токенов",
    typeCols: "Вид токенов¦Сегодня¦7 дней¦Доля, 7 дней",
    server: "Весь Codex · по данным Codex",
    serverNote: "с запусками без файла сессии (--ephemeral) и с других устройств",
    serverTip: (date, t, l) => `${date}${NL}весь Codex: ${t}${l !== null ? `${NL}на этом Mac: ${l}` : ""}`,
    serverNone: (why) => `Весь Codex: ${why}`,
    serverWaiting: "Весь Codex: спрашиваю Codex",
    serverStale: (when, why) => `данные ${when}${why ? ` · не обновляются: ${why}` : ""}`,
    lifetime: (t) => `За всё время: ${t} токенов`,
    where: "Откуда запросы · 7 дней",
    kinds: { cli: "Сессии в терминале", ide: "Сессии в редакторе", exec: "Запуски codex exec", sub: "Субагенты", other: "Прочее" },
    sessions: "Сессии · 7 дней",
    sessionTip: (t, n, k) => `${t} токенов · ${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")} · ${k}`,
    noFolder: "папка неизвестна",
    models: "Модели · 7 дней",
    modelTip: (t, n) => `${t} токенов · ${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")} за 7 дней`,
    unknownModel: "модель не указана",
    details: "Подробности",
    filesNote: (n, at) => `Файлов сессий в индексе: ${n}${at ? ` · обновлено ${at}` : ""}`,
    zstNote: (n) => `Сжатых файлов (.zst) пропущено: ${n}`,
    countNote: "Запрос считается один раз по id ответа: копии в ответвлённых сессиях не удваивают счёт",
    serverDefNote: "«Весь Codex» — дневные суммы с сервера; день у них может считаться по UTC",
    monthName: (m) => MONTH_RU[m],
    why: { "not-logged-in": "нет входа в Codex", "api-key": "вход по ключу API — у ключа нет этих данных", timeout: "Codex не ответил за 20 с", "no-codex": "codex не найден", "bad-response": "незнакомый ответ Codex", rpc: "Codex вернул ошибку", spawn: "codex не запустился" },
    whyOther: (c) => `ошибка ${c}`,
    ago: (m) => (m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 2880 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`),
    broken: "Не получается посчитать расход Codex",
  },
  en: {
    tileLabel: "Codex spend",
    head: (t, n) => `Codex today ${t} tokens · ${cntEn(n)} ${n === 1 ? "request" : "requests"}`,
    headIndexing: (t, p) => `Codex today ≥ ${t} tokens · indexing session files, ${p}`,
    headMissing: "Codex not found — nothing to count",
    paused: " · hub paused",
    todayBy: (hm) => `Today on this Mac, by ${hm}`,
    todayIndexing: (p) => `Today · indexing session files, ${p}`,
    heroNote: (n, c) => `${cntEn(n)} ${n === 1 ? "request" : "requests"} · ${c} from cache`,
    allToday: (t) => `all Codex today — ${t} (as Codex reports)`,
    days14: "14 days",
    avgPerDay: (t) => `avg ${t} a day`,
    disclaimer: "Tokens only, no prices: Codex is on a subscription. Cached is part of input, reasoning part of output",
    yesterday: "Yesterday",
    week: "7 days",
    perDay: (t) => `${t} a day`,
    forDays: (n) => `for ${n} ${n === 1 ? "day" : "days"}`,
    reqs: (n) => `${cntEn(n)} ${n === 1 ? "request" : "requests"}`,
    statTip: (t, n) => `${t} tokens · ${cntEn(n)} ${n === 1 ? "request" : "requests"}`,
    indexing: (a, b) => `Indexing session files: ${a} of ${b}`,
    byDay: "By day · sessions on this Mac",
    avgShort: (t) => `avg ${t}`,
    byHm: (hm) => `, by ${hm}`,
    tipEmpty: (date) => `${date}${NL}no requests`,
    cached: "Cached input",
    inp: "New input",
    out: "Output",
    reason: "of it reasoning",
    tipDay: (date, total, n) => `${date} — ${total} tokens${NL}${cntEn(n)} ${n === 1 ? "request" : "requests"}`,
    tipAll: (t) => `all Codex: ${t}`,
    byType: "By token type",
    typeCols: "Token type¦Today¦7 days¦Share, 7 days",
    server: "All Codex · as Codex reports",
    serverNote: "includes runs without a session file (--ephemeral) and other devices",
    serverTip: (date, t, l) => `${date}${NL}all Codex: ${t}${l !== null ? `${NL}on this Mac: ${l}` : ""}`,
    serverNone: (why) => `All Codex: ${why}`,
    serverWaiting: "All Codex: asking Codex",
    serverStale: (when, why) => `data from ${when}${why ? ` · not updating: ${why}` : ""}`,
    lifetime: (t) => `All time: ${t} tokens`,
    where: "Where requests come from · 7 days",
    kinds: { cli: "Terminal sessions", ide: "Editor sessions", exec: "codex exec runs", sub: "Subagents", other: "Other" },
    sessions: "Sessions · 7 days",
    sessionTip: (t, n, k) => `${t} tokens · ${cntEn(n)} ${n === 1 ? "request" : "requests"} · ${k}`,
    noFolder: "folder unknown",
    models: "Models · 7 days",
    modelTip: (t, n) => `${t} tokens · ${cntEn(n)} ${n === 1 ? "request" : "requests"} over 7 days`,
    unknownModel: "model not recorded",
    details: "Details",
    filesNote: (n, at) => `Session files in the index: ${n}${at ? ` · updated ${at}` : ""}`,
    zstNote: (n) => `Compressed files (.zst) skipped: ${n}`,
    countNote: "A request counts once by its response id: copies in forked sessions don't double it",
    serverDefNote: "\"All Codex\" is the server's daily totals; its days may be UTC days",
    monthName: (m) => MONTH_EN[m],
    why: { "not-logged-in": "not signed in to Codex", "api-key": "signed in with an API key — no such data for a key", timeout: "Codex didn't answer within 20 s", "no-codex": "codex not found", "bad-response": "unexpected answer from Codex", rpc: "Codex returned an error", spawn: "codex didn't start" },
    whyOther: (c) => `error ${c}`,
    ago: (m) => (m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`),
    broken: "Can't count the Codex spend",
  },
};

export const TYPE_COLORS = { cached: "#4A8FAD", inp: "#8E8E93", out: "#FF9F0A" };
const KIND_COLORS = { cli: "#0A84FF", ide: "#64D2FF", exec: "#BF5AF2", sub: "#30D158", other: "#8E8E93" };
const SERVER_COLOR = "#10A37F";
const BAR_COLOR = "#FF9F0A";
const SESSIONS_SHOWN = 8;

function meanOfPast(list, pick) {
  const past = list.slice(0, -1).map(pick);
  const first = past.findIndex((x) => x > 0);
  if (first < 0) return null;
  const used = past.slice(first);
  return used.reduce((a, b) => a + b, 0) / used.length;
}
const sumVals = (objs) => {
  const v = zero();
  for (const o of objs) for (const x of Object.values(o || {})) addTo(v, x);
  return v;
};
// ~/ instead of the home folder
const homeShort = (p, home) => (p && home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);

// ---------- the frame ----------
// server: { atMs, days, lifetime, error, calledAt } | null
export function render(idx, { lang = envLang(), server = null, paused = false, checking = false } = {}) {
  const L = T[lang] || T.ru;
  const now = idx.now();
  const tok = (n) => fmtTokens(n, lang);
  const tokS = (n) => fmtTokensShort(n, lang);
  const why = (c) => (c ? L.why[c] || L.whyOther(c) : null);
  const day = (back) => dayKey(dayStart(now, back));
  const todayK = day(0);
  const hm = fmtHm(now);
  const vOf = (k) => sumVals([idx.days[k]?.m]);
  const all = [];
  for (let i = 13; i >= 0; i--) {
    const k = day(i);
    all.push({ k, v: vOf(k) });
  }
  const today = all[13].v;
  const yesterday = all[12].v;
  const weekKeys = [0, 1, 2, 3, 4, 5, 6].map(day);
  const week = sumVals(weekKeys.map((k) => idx.days[k]?.m));
  const nd = new Date(now);
  const monthStart = dayKey(new Date(nd.getFullYear(), nd.getMonth(), 1).getTime());
  const month = sumVals(Object.keys(idx.days).filter((k) => k >= monthStart && k <= todayK).map((k) => idx.days[k].m));
  const avg14 = meanOfPast(all, (x) => tokensOf(x.v));
  const firstIndex = !idx.indexedOnce && !idx.sourceMissing;
  const share = idx.progress.totalBytes > 0 ? `${Math.min(99, Math.floor((idx.progress.bytes / idx.progress.totalBytes) * 100))}%` : "0%";
  const missing = idx.sourceMissing && !Object.keys(idx.days).length;
  const srv = server && server.atMs ? server : null;
  const srvToday = srv && srv.hasDays ? srv.days[todayK] || 0 : null;
  const out = [];

  let head;
  if (missing) head = L.headMissing;
  else if (firstIndex) head = L.headIndexing(tok(tokensOf(today)), share);
  else head = L.head(tok(tokensOf(today)), today[N]);
  if (paused) head += L.paused;
  const tile = firstIndex ? `≥${tokS(tokensOf(today))}` : tokS(tokensOf(today));
  const hero = missing
    ? {}
    : {
        stat: (firstIndex ? L.todayIndexing(share) : L.todayBy(hm)) + (paused ? L.paused : ""),
        note: L.heroNote(today[N], pctText(pctOf(today[CACHED], today[IN] + today[CACHED]))),
        spark: all.map((x) => num(tokensOf(x.v))).join(","),
        sparkAvg: avg14 ? num(avg14) : undefined,
        sparkLabel: L.days14,
        sparkNote: avg14 ? L.avgPerDay(tokS(avg14)) : undefined,
      };
  out.push(line(clean(head, 160), { status: missing ? "unknown" : "ok", tile, tileLabel: L.tileLabel, sfimage: "chart.bar.xaxis", ...hero }));
  // The server fills a day with a delay (seen live: 0 for today while this Mac already had requests), so a zero
  // "today" is not shown as a fact; the bar chart below still has the day.
  if (!missing && srvToday > 0) out.push(line(L.allToday(tok(srvToday))));
  out.push("---");
  if (missing) return out.join("\n");
  out.push(line(L.disclaimer, { sfimage: "info.circle", color: "gray" }));

  const tip = (v) => L.statTip(tok(tokensOf(v)), v[N]);
  out.push(line(tokS(tokensOf(yesterday)), { stat: L.yesterday, note: L.reqs(yesterday[N]), tooltip: tip(yesterday) }));
  out.push(line(tokS(tokensOf(week)), { stat: L.week, note: L.perDay(tokS(tokensOf(week) / 7)), tooltip: tip(week) }));
  out.push(line(tokS(tokensOf(month)), { stat: L.monthName(nd.getMonth()), note: L.forDays(nd.getDate()), tooltip: tip(month) }));
  if (idx.indexing) out.push(line(L.indexing(idx.progress.files, idx.progress.total), { sfimage: "arrow.triangle.2.circlepath", color: "gray" }));

  // by day on this Mac: stacked cached / new input / output
  const dateOf = (x) => fmtDay(x.k, lang) + (x.k === todayK ? L.byHm(hm) : "");
  const labels = all.map((x) => String(keyDate(x.k).getDate())).join("¦");
  out.push("---");
  out.push(
    line(L.byDay, {
      chart: "bars",
      stack: [L.cached, L.inp, L.out].join(","),
      series: [CACHED, IN, OUT].map((f) => all.map((x) => num(x.v[f] / 1e6)).join(",")).join(";"),
      colors: [TYPE_COLORS.cached, TYPE_COLORS.inp, TYPE_COLORS.out].join(","),
      labels,
      valueLabels: all.map((x) => (tokensOf(x.v) ? tokS(tokensOf(x.v)) : "")).join("¦"),
      highlight: "last",
      tint: "none",
      note: avg14 ? L.avgPerDay(tok(avg14)) : undefined,
      tips: all
        .map((x) => {
          if (!x.v[N]) return L.tipEmpty(dateOf(x));
          const rows = [L.tipDay(dateOf(x), tok(tokensOf(x.v)), x.v[N]), `${L.cached} ${tok(x.v[CACHED])}`, `${L.inp} ${tok(x.v[IN])}`, `${L.out} ${tok(x.v[OUT])}`];
          if (srv?.hasDays && srv.days[x.k] !== undefined) rows.push(L.tipAll(tok(srv.days[x.k])));
          return rows.join(NL);
        })
        .join("¦"),
    }),
  );
  const wt = tokensOf(week);
  out.push(line(`--${L.byType}`, { table: "true", columns: L.typeCols, barColumn: "4" }));
  for (const [f, title] of [[CACHED, L.cached], [IN, L.inp], [OUT, L.out]]) {
    const p = pctOf(week[f], wt);
    const key = f === CACHED ? "cached" : f === IN ? "inp" : "out";
    out.push(line(`----${title}`, { cells: [tok(today[f]), tok(week[f]), wt > 0 ? pctText(p) : "—"].join("¦"), sfimage: "square.fill", iconColor: TYPE_COLORS[key], bar: num(p) }));
  }
  if (week[OUT] > 0 && week[REASON] > 0) out.push(line(`--${L.out}: ${L.reason} ${pctText(pctOf(week[REASON], week[OUT]))}`, { color: "gray" }));

  // all Codex as the server reports it
  out.push("---");
  if (srv && srv.hasDays) {
    const sv = all.map((x) => srv.days[x.k] || 0);
    const stale = srv.error || now - srv.atMs > 2 * USAGE_MS ? L.serverStale(L.ago(Math.max(0, Math.round((now - srv.atMs) / MIN))), why(srv.error)) : null;
    out.push(
      line(L.server, {
        chart: "bars",
        values: sv.map(num).join(","),
        labels,
        valueLabels: sv.map((t) => (t ? tokS(t) : "")).join("¦"),
        highlight: "last",
        color: SERVER_COLOR,
        note: stale ? `${L.serverNote} · ${stale}` : L.serverNote,
        tips: all.map((x, i) => L.serverTip(dateOf(x), tok(sv[i]), x.v[N] ? tok(tokensOf(x.v)) : null)).join("¦"),
      }),
    );
    if (srv.lifetime !== null) out.push(line(`--${L.lifetime(tok(srv.lifetime))}`, { color: "gray" }));
  } else if (checking && !server?.error) out.push(line(L.serverWaiting, { sfimage: "arrow.triangle.2.circlepath", color: "gray" }));
  else out.push(line(clean(L.serverNone(why(server?.error || (paused ? null : "rpc")) || "—"), 160), { sfimage: "icloud.slash", color: "gray" }));

  // where requests come from: session kinds over 7 days
  const byThread = {};
  for (const k of weekKeys) for (const [t, v] of Object.entries(idx.days[k]?.t || {})) addTo((byThread[t] ||= zero()), v);
  const byKind = {};
  for (const [t, v] of Object.entries(byThread)) addTo((byKind[idx.threads[t]?.kind || "other"] ||= zero()), v);
  const kinds = Object.entries(byKind).filter(([, v]) => tokensOf(v) > 0).sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]));
  if (kinds.length > 1) {
    out.push("---");
    out.push(line(L.where, { chart: "share" }));
    for (const [k, v] of kinds) out.push(line(`--${L.kinds[k] || L.kinds.other}`, { value: num(tokensOf(v)), note: tok(tokensOf(v)), color: KIND_COLORS[k] || KIND_COLORS.other }));
  }

  // sessions over 7 days: the biggest first, labelled by folder, kind and start
  const threads = Object.entries(byThread).filter(([, v]) => tokensOf(v) > 0).sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]));
  if (threads.length) {
    out.push("---");
    out.push(line(L.sessions));
    const top = tokensOf(threads[0][1]);
    for (const [t, v] of threads.slice(0, SESSIONS_SHOWN)) {
      const meta = idx.threads[t] || {};
      const folder = meta.cwd ? basename(meta.cwd) || meta.cwd : L.noFolder;
      const when = meta.ms ? `${fmtDay(dayKey(meta.ms), lang)} ${fmtHm(meta.ms)}` : "";
      const kind = L.kinds[meta.kind] || L.kinds.other;
      out.push(line(`--${clean(folder, 60)}${when ? ` · ${when}` : ""}`, { bar: num(pctOf(tokensOf(v), top)), note: tok(tokensOf(v)), color: KIND_COLORS[meta.kind] || KIND_COLORS.other, tooltip: clean(L.sessionTip(tok(tokensOf(v)), v[N], kind) + (meta.cwd ? `${NL}${homeShort(meta.cwd, idx.home)}` : ""), 300) }));
    }
  }

  // models over 7 days
  const models = {};
  for (const k of weekKeys) for (const [m, v] of Object.entries(idx.days[k]?.m || {})) addTo((models[m] ||= zero()), v);
  const mrows = Object.entries(models).filter(([, v]) => tokensOf(v) > 0).sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]));
  if (mrows.length) {
    out.push("---");
    out.push(line(L.models));
    const top = tokensOf(mrows[0][1]);
    for (const [m, v] of mrows) out.push(line(`--${m === "?" ? L.unknownModel : clean(m, 60)}`, { bar: num(pctOf(tokensOf(v), top)), note: tok(tokensOf(v)), color: BAR_COLOR, tooltip: L.modelTip(tok(tokensOf(v)), v[N]) }));
  }

  out.push("---");
  out.push(line(L.details, { details: "true" }));
  out.push(line(`--${L.countNote}`));
  out.push(line(`--${L.serverDefNote}`));
  if (idx.compressed) out.push(line(`--${L.zstNote(idx.compressed)}`));
  out.push(line(`--${L.filesNote(Object.keys(idx.files).length, idx.indexedAt ? fmtHm(idx.indexedAt) : null)}`));
  return out.join("\n");
}

export function brokenFrame(err, lang = envLang()) {
  const L = T[lang] || T.ru;
  return [line(L.broken, { status: "unknown", tileLabel: L.tileLabel, event: "source-broken" }), "---", line(clean(err?.message || err, 140), { color: "gray" })].join("\n");
}

// ---------- plugin process ----------
function main() {
  const tickMs = Math.max(500, Number(process.env.AGENTHUB_CODEX_SPEND_TICK_MS) || 30_000);
  const dataDir = process.env.AGENTHUB_PLUGIN_DATA_PATH || process.env.AGENTHUB_PLUGIN_CACHE_PATH || null;
  const testNow = process.env.AGENTHUB_TEST_NOW ? Date.parse(process.env.AGENTHUB_TEST_NOW) : NaN;
  const now = Number.isFinite(testNow) ? () => testNow : () => Date.now();
  const idx = new CodexSpendIndex({ cachePath: dataDir ? join(dataDir, "index.json") : null, now });
  const serverPath = dataDir ? join(dataDir, "server.json") : null;
  let server = serverPath ? loadServer(serverPath) : loadServer("");
  const paused = process.env.AGENTHUB_PAUSED === "1";
  idx.load();
  let lastText = null;
  let lastAt = 0;
  let checking = false;
  const emit = (force = false) => {
    let text;
    try {
      text = render(idx, { server, paused, checking });
    } catch (e) {
      text = brokenFrame(e);
    }
    const t = Date.now();
    if (force || text !== lastText || t - lastAt > 60_000) {
      process.stdout.write(text + "\n~~~\n");
      lastText = text;
      lastAt = t;
    }
  };
  let busy = false;
  let again = false;
  let lastSave = Date.now();
  const cycle = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      if (!paused) {
        idx.scan();
        let lastFrame = 0;
        while (idx.indexing) {
          idx.step();
          if (Date.now() - lastFrame > 1000) {
            emit();
            lastFrame = Date.now();
          }
          if (Date.now() - lastSave > 15_000) {
            idx.save();
            lastSave = Date.now();
          }
          await new Promise((r) => setImmediate(r));
        }
        idx.step(0);
      }
      idx.save();
      lastSave = Date.now();
      emit();
    } finally {
      busy = false;
      if (again) {
        again = false;
        setImmediate(cycle);
      }
    }
  };
  // the server's numbers: rarely, never while paused or without ~/.codex
  let asking = false;
  const ask = async (manual = false) => {
    if (asking || paused || idx.sourceMissing || !isDir(idx.codex)) return;
    const t = Date.now();
    const changed = Object.values(idx.files).some((f) => f[1] > server.calledAt);
    if (!callDue({ nowMs: t, calledAt: server.calledAt, error: server.error, manual, changed })) return;
    asking = true;
    checking = true;
    try {
      server = await fetchUsage(server, t);
      if (serverPath) saveServer(serverPath, server);
    } finally {
      asking = false;
      checking = false;
      emit();
    }
  };
  emit(true);
  cycle().then(() => ask());
  const timer = setInterval(cycle, tickMs);
  const askTimer = setInterval(() => ask(), Math.min(USAGE_SOON_MS, MIN));
  createInterface({ input: process.stdin }).on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m?.type === "refresh") {
      lastText = null;
      cycle();
      ask(true);
    } else if (m?.type === "fileChanged") cycle();
    else if (m?.type === "stopping") {
      idx.save();
      process.exit(0);
    }
  });
  process.stdin.on("end", () => {
    clearInterval(timer);
    clearInterval(askTimer);
    idx.save();
    process.exit(0);
  });
  process.stdout.on("error", () => process.exit(0));
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) main();
