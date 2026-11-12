#!/usr/bin/env node
// Claude Code token spend journal: when and how many tokens were spent, by day, model and token type, and what that
// would cost at API list prices.
//
// <agenthub.title>Claude Code Расход</agenthub.title>
// <agenthub.title lang="en">Claude Code Spend</agenthub.title>
// <agenthub.version>0.2.1</agenthub.version>
// <agenthub.author.name>Kensei</agenthub.author.name>
// <agenthub.author.github>KenseiTheOne</agenthub.author.github>
// <agenthub.desc>Журнал расхода токенов Claude Code: сколько и когда потрачено, стоимость по ценам API за день, неделю и месяц</agenthub.desc>
// <agenthub.desc lang="en">Claude Code token spend journal: how much and when, and the cost at API list prices per day, week and month</agenthub.desc>
// <agenthub.status value="ok" label="Расход посчитан">Числа посчитаны по журналам сессий Claude Code</agenthub.status>
// <agenthub.status value="ok" lang="en" label="Spend counted">Numbers counted from Claude Code session transcripts</agenthub.status>
// <agenthub.status value="unknown" label="Журналы не читаются">Папка журналов Claude Code не найдена или не читается</agenthub.status>
// <agenthub.status value="unknown" lang="en" label="Can't read transcripts">The Claude Code transcripts folder is missing or unreadable</agenthub.status>
// <agenthub.type>streamable</agenthub.type>
// <agenthub.platforms>macos,windows</agenthub.platforms>
// <agenthub.fsRead>~/.claude/projects/*/*.jsonl — только числа usage, модель, время и requestId/message.id из ответов модели; текст переписки не берётся и не пишется</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.claude/projects/*/*.jsonl — only usage numbers, model, time and requestId/message.id of model responses; no conversation text is taken or written</agenthub.fsRead>
// <agenthub.fsRead>~/.claude/projects/*/*/subagents/agent-*.jsonl — то же для субагентов</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.claude/projects/*/*/subagents/agent-*.jsonl — the same for subagents</agenthub.fsRead>
// <agenthub.fsRead>~/.claude/projects/*/*/subagents/workflows/wf_*/agent-*.jsonl — то же для агентов фоновых прогонов Workflow</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.claude/projects/*/*/subagents/workflows/wf_*/agent-*.jsonl — the same for background Workflow agents</agenthub.fsRead>
// <agenthub.action id="set-alert" level="immediate" arg="amount:^(?:0|10|25|50|100|200|500)$" title="Set the daily spend alert" title-ru="Задать порог уведомления о расходе за день">spend.mjs --action set-alert {amount}</agenthub.action>
// <agenthub.action id="set-range" level="immediate" arg="days:^(?:14|30)$" title="Show 14 or 30 days" title-ru="Показывать 14 или 30 дней">spend.mjs --action set-range {days}</agenthub.action>
// <agenthub.contract>3</agenthub.contract>
// <agenthub.icon symbol="dollarsign.circle" color="#30D158"></agenthub.icon>
// <agenthub.push key="daily-over" kind="plugin" cooldown="12h">Расход за день превысил порог</agenthub.push>
// <agenthub.push key="daily-over" lang="en">Today's spend passed your threshold</agenthub.push>
//
// Source: Claude Code transcripts. Every model response line (type "assistant") carries message.usage; the same
// response is repeated as one line per content block, so requests are deduplicated by requestId (otherwise
// message.id), taking the maximum of each field (output_tokens is a stream snapshot and may grow). Only usage numbers,
// the model id, the timestamp and the dedupe key are taken; message text is parsed in memory by JSON.parse and
// dropped — it never reaches the output, the cache or a log.
//
// Indexing is incremental: per file the byte offset of the last complete line plus size, mtime and inode are kept in
// PluginData/index.json together with daily buckets and the hashed dedupe keys of the kept days. Files last modified
// before the horizon (the earlier of the month start and 29 days before today) are not opened at all. The first run reads
// whatever is inside the horizon in slices and prints progress frames; later runs read only appended bytes.
//
// Cost is an API list price equivalent (PRICES below, with an as-of date) — not a bill: on a subscription you pay a
// flat fee. Unknown models are counted in tokens and shown without a cost.
//
// The page uses the hub's chart elements (hub 0.1.3: chart=bars, chart=share, bar=, spark=); an older hub draws the
// same lines as plain text.
//
// Events: daily-over:<YYYYMMDD> — today's cost reached the threshold the human picked on the page. The set-alert and
// set-range actions write PluginData/settings.json. stdin: refresh / fileChanged — rescan now; actionResult — redraw.
//
// For tests: AGENTHUB_SPEND_TICK_MS (rescan interval, default 30 s), AGENTHUB_TEST_NOW (ISO time).

import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// ---------- prices ----------
// USD per million tokens: in — input, out — output, cr — cache read. Cache writes are 1.25× input (5 min TTL) and
// 2× input (1 h TTL) for every model. Source: Anthropic API list prices (claude-api reference cached 2026-10-06),
// checked 2026-11-11. assumed — not in the reference: priced like the nearest model of the same family.
export const PRICES_AS_OF = "2026-11-11";
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
export const PRICES = {
  "claude-fable-5-2": { in: 10, out: 50, cr: 0.25, assumed: "claude-fable-5-1" },
  "claude-fable-5-1": { in: 10, out: 50, cr: 0.25 },
  "claude-mythos-5-1": { in: 10, out: 50, cr: 0.25 },
  "claude-fable-5": { in: 10, out: 50, cr: 1 },
  "claude-mythos-5": { in: 10, out: 50, cr: 1 },
  "claude-opus-5-5": { in: 4, out: 20, cr: 0.2, fast: { in: 8, out: 40, cr: 0.4 } },
  "claude-opus-5": { in: 5, out: 25, cr: 0.5, fast: { in: 10, out: 50, cr: 1 } },
  "claude-opus-4-8": { in: 5, out: 25, cr: 0.5 },
  "claude-opus-4-7": { in: 5, out: 25, cr: 0.5 },
  "claude-opus-4-6": { in: 5, out: 25, cr: 0.5, fast: { in: 30, out: 150, cr: 3 } },
  "claude-opus-4-5": { in: 5, out: 25, cr: 0.5 },
  "claude-opus-4-1": { in: 15, out: 75, cr: 1.5 },
  "claude-opus-4": { in: 15, out: 75, cr: 1.5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cr: 0.2 },
  "claude-sonnet-5": { in: 2, out: 10, cr: 0.2 },
  "claude-sonnet-4-6": { in: 3, out: 15, cr: 0.3 },
  "claude-sonnet-4-5": { in: 3, out: 15, cr: 0.3 },
  "claude-sonnet-4": { in: 3, out: 15, cr: 0.3 },
  "claude-sonnet-3-7": { in: 3, out: 15, cr: 0.3 },
  // Haiku 5.5: prompts over 100K tokens (input + cache) cost more; the cache read price is assumed at 0.1× input
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cr: 0.01, long: { above: 100_000, in: 0.5, out: 2.5, cr: 0.05 } },
  "claude-haiku-4-5": { in: 1, out: 5, cr: 0.1 },
  "claude-haiku-3-5": { in: 0.8, out: 4, cr: 0.08 },
  "claude-haiku-3": { in: 0.25, out: 1.25, cr: 0.03 },
};
// Fast mode without a listed price — 2× the standard price (assumed: Opus 5 and 5.5 fast are exactly 2×).
const FAST_FALLBACK = 2;
const FAMILIES = ["fable", "mythos", "opus", "sonnet", "haiku"];

// A model id as Claude Code or a cloud platform writes it → the plain id: "us.anthropic.claude-opus-4-5-20251101-v1:0",
// "claude-sonnet-4-5@20250929", "claude-opus-5-5[1m]" → "claude-opus-4-5", "claude-sonnet-4-5", "claude-opus-5-5";
// the old order "claude-3-5-haiku-20241022" → "claude-haiku-3-5".
export function normalizeModel(id) {
  let s = String(id ?? "").trim().toLowerCase();
  s = s.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "").replace(/\[[^\]]*\]$/, "").replace(/-v\d+(?::\d+)?$/, "").replace(/@\d{8}$/, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
  const old = /^claude-(\d+)(?:-(\d+))?-(haiku|sonnet|opus)$/.exec(s);
  if (old) s = `claude-${old[3]}-${old[1]}${old[2] ? `-${old[2]}` : ""}`;
  return s;
}

const verOf = (m) => {
  const r = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(m);
  return r ? { fam: r[1], v: Number(r[2]) + (r[3] ? Number(r[3]) / 10 : 0) } : null;
};

// → { p, as, assumed } | null. Not in the table but a known family: the nearest version of that family, preferring
// a lower one (a newer point release usually keeps its family's price) — assumed.
export function priceOf(model) {
  const m = normalizeModel(model);
  const p = PRICES[m];
  if (p) return { p, as: p.assumed || m, assumed: Boolean(p.assumed) };
  const v = verOf(m);
  if (!v || !FAMILIES.includes(v.fam)) return null;
  let best = null;
  for (const k of Object.keys(PRICES)) {
    const kv = verOf(k);
    if (!kv || kv.fam !== v.fam || PRICES[k].assumed) continue;
    const d = v.v - kv.v;
    const score = d >= 0 ? d : 100 - d; // lower versions first, then the nearest higher one
    if (!best || score < best.score) best = { k, score };
  }
  return best ? { p: PRICES[best.k], as: best.k, assumed: true } : null;
}

// Model key in the buckets: the plain id, "+fast" for fast mode, "+long" for a Haiku 5.5 prompt over its threshold.
export function modelKey(model, { fast = false, prompt = 0 } = {}) {
  const m = normalizeModel(model) || "unknown";
  const pr = priceOf(m);
  const long = Boolean(pr?.p.long && prompt > pr.p.long.above);
  return `${m}${fast ? "+fast" : ""}${long ? "+long" : ""}`;
}

// vals: [requests, input, cacheWrite5m, cacheWrite1h, cacheRead, output]
export const N = 0, IN = 1, CW5 = 2, CW1 = 3, CR = 4, OUT = 5;
export const zero = () => [0, 0, 0, 0, 0, 0];
const addTo = (a, b) => {
  for (let i = 0; i < 6; i++) a[i] += b[i];
  return a;
};
export const tokensOf = (v) => v[IN] + v[CW5] + v[CW1] + v[CR] + v[OUT];

// Cost of a bucket of one model key in USD by token type — { in, cw, cr, out } — or null for an unknown model.
export function costParts(mk, v) {
  const [model, ...flags] = mk.split("+");
  const pr = priceOf(model);
  if (!pr) return null;
  let p = pr.p;
  if (flags.includes("long") && p.long) p = p.long;
  if (flags.includes("fast")) p = pr.p.fast || { in: p.in * FAST_FALLBACK, out: p.out * FAST_FALLBACK, cr: p.cr * FAST_FALLBACK };
  return { in: (v[IN] * p.in) / 1e6, cw: (v[CW5] * p.in * CACHE_WRITE_5M + v[CW1] * p.in * CACHE_WRITE_1H) / 1e6, cr: (v[CR] * p.cr) / 1e6, out: (v[OUT] * p.out) / 1e6 };
}

// Cost of a bucket of one model key in USD, or null for an unknown model.
export function costOf(mk, v) {
  const c = costParts(mk, v);
  return c ? c.in + c.cw + c.cr + c.out : null;
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
// Dollars, exact enough for a line: "$0.19", "$16.77", "$698", "$2,050" (ru "$0,19", "$2 050").
export function fmtUsd(x, lang = "ru") {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x > 0 && x < 0.005) return `<$${dec(0.01, 2, lang)}`;
  return `$${x >= 100 ? group3(x, lang === "en" ? "," : " ") : dec(x, 2, lang)}`;
}
// Dollars, compact for big numbers and bar captions: "$4.83", "$17", "$698", "$3.0k", "$12k" (ru "$3,0 тыс.").
export function fmtUsdShort(x, lang = "ru") {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const en = lang === "en";
  if (x > 0 && x < 0.005) return `<$${dec(0.01, 2, lang)}`;
  if (x < 10) return `$${dec(x, 2, lang)}`;
  if (Math.round(x) < 1000) return `$${Math.round(x)}`;
  if (x < 9950) return en ? `$${dec(x / 1e3, 1, lang)}k` : `$${dec(x / 1e3, 1, lang)} тыс.`;
  if (Math.round(x / 1e3) < 1000) return en ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x / 1e3)} тыс.`;
  return en ? `$${dec(x / 1e6, 1, lang)}M` : `$${dec(x / 1e6, 1, lang)} млн`;
}
// A line's dollars: exact below $100, compact above.
const usdLine = (x, lang) => (Number.isFinite(x) && x >= 100 ? fmtUsdShort(x, lang) : fmtUsd(x, lang));
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
// Tokens for a bar caption: "2.0B", "990M", "14K" (ru "2,0 млрд", "990 млн").
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

// "claude-opus-5-5+fast" → "Opus 5.5 · fast"
export function modelName(mk, lang = "ru") {
  const [m, ...flags] = mk.split("+");
  const v = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(m);
  let name = v && FAMILIES.includes(v[1]) ? `${v[1][0].toUpperCase()}${v[1].slice(1)} ${v[2]}${v[3] ? `.${v[3]}` : ""}` : clean(m, 40);
  if (flags.includes("fast")) name += lang === "en" ? " · fast" : " · быстрый";
  return name;
}

// ---------- reading files ----------
const CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
const HOT_MAX = 20_000; // requests kept in memory for the max-merge of later duplicate lines
// Days kept: the 30-day chart (the month start may be further back — the horizon is the earlier of the two).
export const DAYS_KEPT = 30;
const INDEX_VERSION = 2; // 2 (0.2.0): 30 days, no per-session and per-hour buckets — an older index is rebuilt once

function safeReaddir(p) {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
const hashKey = (k) => createHash("sha1").update(k).digest("base64url").slice(0, 12);

// The usage of one transcript line → { key, ms, model, fast, vals } | null. Only these fields leave the function; the
// parsed object (message text included) is dropped.
export function parseUsageLine(text) {
  if (!text.includes('"assistant"') || !text.includes('"usage"')) return null;
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || o.type !== "assistant" || !o.message || typeof o.message !== "object") return null;
  const u = o.message.usage;
  if (!u || typeof u !== "object") return null;
  const model = typeof o.message.model === "string" ? o.message.model : "";
  if (!model || model === "<synthetic>") return null;
  const ms = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ms)) return null;
  const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  const cwTotal = num(u.cache_creation_input_tokens);
  let cw5 = cwTotal;
  let cw1 = 0;
  if (u.cache_creation && typeof u.cache_creation === "object") {
    cw1 = num(u.cache_creation.ephemeral_1h_input_tokens);
    cw5 = Math.max(num(u.cache_creation.ephemeral_5m_input_tokens), cwTotal - cw1);
  }
  const vals = [1, num(u.input_tokens), cw5, cw1, num(u.cache_read_input_tokens), num(u.output_tokens)];
  const key = typeof o.requestId === "string" && o.requestId ? `r:${o.requestId}` : typeof o.message.id === "string" && o.message.id ? `m:${o.message.id}` : null;
  return { key, ms, model, fast: u.speed === "fast", vals };
}

// ---------- the index ----------
export class SpendIndex {
  constructor({ home = homedir(), cachePath = null, now = () => Date.now(), sliceBytes = 64 * 1024 * 1024 } = {}) {
    this.projects = join(home, ".claude", "projects");
    this.cachePath = cachePath;
    this.now = now;
    this.sliceBytes = sliceBytes;
    this.days = {}; // day → { m: {mk: vals}, k: {sub: {mk: vals}, wf: {mk: vals}} }
    this.keys = new Map(); // hashed request key → day
    this.hot = new Map(); // hashed request key → { day, mk, kind, vals }
    this.files = {}; // path relative to projects → [size, mtimeMs, ino, offset]
    this.pending = [];
    this.progress = { files: 0, total: 0, bytes: 0, totalBytes: 0 };
    this.indexedOnce = false;
    this.indexedAt = 0;
    this.dirty = false;
    this.horizonKey = null;
    this.sourceMissing = false;
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
    const body = JSON.stringify({ v: INDEX_VERSION, indexedOnce: this.indexedOnce, indexedAt: this.indexedAt, days: this.days, keys, files: this.files });
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.cachePath);
      this.dirty = false;
    } catch {}
  }

  // Drop days before the horizon (buckets and keys).
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
    for (const [h, e] of this.hot) if (e.day < hk) this.hot.delete(h);
  }

  // Find transcripts: projects/<p>/<session>.jsonl, …/<session>/subagents/agent-*.jsonl,
  // …/<session>/subagents/workflows/wf_*/agent-*.jsonl. Files last modified before the horizon are not opened.
  scan() {
    this.prune();
    const horizon = this.horizon();
    const found = [];
    const top = safeReaddir(this.projects);
    this.sourceMissing = !top.length && !safeStatDir(this.projects);
    const add = (rel, kind) => {
      let st;
      try {
        st = statSync(join(this.projects, rel));
      } catch {
        return;
      }
      if (!st.isFile() || st.mtimeMs < horizon) return;
      found.push({ rel, kind, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    };
    for (const p of top) {
      if (!p.isDirectory() || p.name.startsWith(".")) continue;
      for (const e of safeReaddir(join(this.projects, p.name))) {
        if (e.name.startsWith(".")) continue;
        if (e.isFile() && e.name.endsWith(".jsonl")) add(join(p.name, e.name), "main");
        else if (e.isDirectory()) {
          const sub = join(p.name, e.name, "subagents");
          for (const a of safeReaddir(join(this.projects, sub))) {
            if (a.isFile() && /^agent-[\w.-]+\.jsonl$/.test(a.name)) add(join(sub, a.name), "sub");
            else if (a.isDirectory() && a.name === "workflows") {
              for (const w of safeReaddir(join(this.projects, sub, "workflows"))) {
                if (!w.isDirectory() || !/^wf_[\w-]{1,64}$/.test(w.name)) continue;
                for (const f of safeReaddir(join(this.projects, sub, "workflows", w.name))) {
                  if (f.isFile() && /^agent-[\w.-]+\.jsonl$/.test(f.name)) add(join(sub, "workflows", w.name, f.name), "wf");
                }
              }
            }
          }
        }
      }
    }
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
      // replaced or truncated — from the start: the dedupe keys keep already counted requests from counting twice
      if (s && (s[2] !== f.ino || f.size < s[3])) s[3] = 0;
      pending.push({ ...f, offset: s ? s[3] : 0, skip: false });
    }
    pending.sort((a, b) => b.mtimeMs - a.mtimeMs); // the freshest first: today shows up quickly
    this.pending = pending;
    this.progress = { files: 0, total: pending.length, bytes: 0, totalBytes: pending.reduce((a, f) => a + Math.max(0, f.size - f.offset), 0) };
    return pending.length;
  }

  get indexing() {
    return this.pending.length > 0;
  }

  // Read up to sliceBytes of pending files. → true when nothing is left.
  step(budget = this.sliceBytes) {
    while (this.pending.length && budget > 0) {
      const f = this.pending[0];
      const used = this.readFile(f, budget);
      budget -= Math.max(used, 1);
      if (f.done) {
        this.pending.shift();
        this.progress.files++;
        this.files[f.rel] = [f.size, f.mtimeMs, f.ino, f.offset];
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

  // Reads complete lines of a file from f.offset; an unfinished last line waits for the next scan.
  readFile(f, budget) {
    let fd;
    try {
      fd = openSync(join(this.projects, f.rel), "r");
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
      }
      f.size = st.size;
      f.mtimeMs = st.mtimeMs;
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
            f.done = true; // an unfinished line at the end: wait for its end
            break;
          }
          f.offset += got; // a line longer than MAX_LINE: skip it up to its end
          f.skip = true;
          continue;
        }
        const lines = buf.toString("utf8", 0, nl).split("\n");
        if (f.skip) {
          lines.shift();
          f.skip = false;
        }
        f.offset += nl + 1;
        for (const l of lines) this.ingest(l, f.kind);
      }
    } finally {
      closeSync(fd);
    }
    return used;
  }

  ingest(text, kind) {
    const r = parseUsageLine(text);
    if (!r) return;
    const day = dayKey(r.ms);
    if (this.horizonKey && day < this.horizonKey) return;
    const prompt = r.vals[IN] + r.vals[CW5] + r.vals[CW1] + r.vals[CR];
    const mk = modelKey(r.model, { fast: r.fast, prompt });
    if (r.key) {
      const h = hashKey(r.key);
      const hot = this.hot.get(h);
      if (hot) {
        // the same request again: the maximum of each field, the difference goes to the same buckets
        const delta = zero();
        let any = false;
        for (let i = 1; i < 6; i++) {
          if (r.vals[i] > hot.vals[i]) {
            delta[i] = r.vals[i] - hot.vals[i];
            hot.vals[i] = r.vals[i];
            any = true;
          }
        }
        if (any) this.addBuckets(hot.day, hot.mk, hot.kind, delta);
        return;
      }
      if (this.keys.has(h)) return; // counted in an earlier run
      this.keys.set(h, day);
      this.hot.set(h, { day, mk, kind, vals: r.vals.slice() });
      if (this.hot.size > HOT_MAX) {
        let drop = HOT_MAX / 2;
        for (const k of this.hot.keys()) {
          this.hot.delete(k);
          if (--drop <= 0) break;
        }
      }
    }
    this.addBuckets(day, mk, kind, r.vals);
  }

  addBuckets(day, mk, kind, vals) {
    const d = (this.days[day] ||= { m: {}, k: {} });
    addTo((d.m[mk] ||= zero()), vals);
    if (kind !== "main") addTo(((d.k[kind] ||= {})[mk] ||= zero()), vals);
    this.dirty = true;
  }
}

function safeStatDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------- texts ----------
// Tooltip lines are joined with the two characters "\n" (the hub splits on them); `line()` escapes the backslash.
const NL = "\\n";
const cntRu = (n) => group3(n, " ");
const cntEn = (n) => group3(n, ",");
export const T = {
  ru: {
    tileLabel: "Расход сегодня",
    head: (c, t) => `Сегодня ${c} · ${t} токенов`,
    headIndexing: (c, p) => `Сегодня ≥ ${c} · считаю журналы, ${p}`,
    headMissing: "Журналов Claude Code нет — считать нечего",
    paused: " · хаб на паузе",
    todayBy: (hm) => `Сегодня, к ${hm}`,
    todayIndexing: (p) => `Сегодня · считаю журналы, ${p}`,
    heroNote: (t, n) => `${t} токенов · ${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")}`,
    yesterdayWhole: (c) => `вчера за весь день — ${c}`,
    days14: "14 дней",
    avgPerDay: (c) => `в среднем ${c} в день`,
    disclaimer: "По ценам API — это не счёт: на подписке вы платите фиксированную сумму",
    yesterday: "Вчера",
    week: "7 дней",
    times: (m, int, r) => `в ${m} ${int ? plural(r, "раз", "раза", "раз") : "раза"} выше среднего`,
    perDay: (c) => `${c} в день`,
    forDays: (n) => `за ${n} ${plural(n, "день", "дня", "дней")}`,
    tokens: (t) => `${t} токенов`,
    statTip: (t, n) => `${t} токенов · ${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")}`,
    indexing: (a, b, x, y) => `Считаю журналы: ${a} из ${b} файлов (${x} из ${y})`,
    byDay: "По дням",
    range: "Период",
    rangeOpt: (n) => `${n} дней`,
    avgShort: (c) => `ср. ${c}`,
    byHm: (hm) => `, к ${hm}`,
    tipDay: (date, c, t, n) => `${date}${NL}${c} · ${t} токенов${NL}${cntRu(n)} ${plural(n, "запрос", "запроса", "запросов")}`,
    tipEmpty: (date) => `${date}${NL}запросов не было`,
    tipUnpriced: "+ токены моделей без цены",
    tokensByDay: "Токены по дням",
    tokensNote: (avg, week) => `в среднем ${avg} в день · 7 дней — ${week}`,
    cr: "Чтение кэша",
    cw: "Запись в кэш",
    out: "Ответы модели",
    outLong: "Ответы модели (выход)",
    inp: "Новый вход",
    tipTokens: (date, total) => `${date} — ${total}`,
    tipPrice: (c) => `По ценам API: ${c}`,
    byType: "По видам токенов",
    typeCols: "Вид токенов¦Сегодня¦7 дней¦Доля цены, 7 дней",
    cacheNote: (tp, cp) => `Чтение кэша — ${tp} токенов, но ${cp} цены за 7 дней`,
    where: "Куда уходит · 7 дней",
    wf: "Фоновые Workflow",
    main: "Сами сессии",
    sub: "Субагенты",
    models: "Модели · 7 дней",
    modelTip: (t) => `${t} токенов за 7 дней`,
    pricedAs: (m) => `цена как у ${m}`,
    underDollar: "меньше $1",
    noPrice: "без цены",
    alert: "Порог уведомления",
    alertNote: "уведомить, когда расход за день по ценам API его превысит",
    off: "Не уведомлять",
    over: (lim, c) => `Расход за сегодня больше ${lim}: ${c} по ценам API`,
    details: "Подробности",
    pricesAsOf: (d) => `Цены API на ${d}; запись в кэш — 1,25× входа (5 мин) и 2× (1 ч)`,
    assumed: (list) => `Цены приняты по ближайшей модели семейства: ${list}`,
    unpriced: (list) => `Без цены (только токены, в стоимость не входят): ${list}`,
    outputNote: "Выход может быть немного занижен: в журнале — снимок потока",
    files: (n, at) => `Файлов в индексе: ${n}${at ? ` · обновлено ${at}` : ""}`,
    monthName: (m) => MONTH_RU[m],
    broken: "Не получается посчитать расход",
  },
  en: {
    tileLabel: "Spend today",
    head: (c, t) => `Today ${c} · ${t} tokens`,
    headIndexing: (c, p) => `Today ≥ ${c} · indexing transcripts, ${p}`,
    headMissing: "No Claude Code transcripts — nothing to count",
    paused: " · hub paused",
    todayBy: (hm) => `Today, by ${hm}`,
    todayIndexing: (p) => `Today · indexing transcripts, ${p}`,
    heroNote: (t, n) => `${t} tokens · ${cntEn(n)} ${n === 1 ? "request" : "requests"}`,
    yesterdayWhole: (c) => `yesterday for the whole day — ${c}`,
    days14: "14 days",
    avgPerDay: (c) => `avg ${c} a day`,
    disclaimer: "By API list prices — not a bill; on a subscription you pay a flat fee",
    yesterday: "Yesterday",
    week: "7 days",
    times: (m) => `${m}× the average`,
    perDay: (c) => `${c} a day`,
    forDays: (n) => `for ${n} ${n === 1 ? "day" : "days"}`,
    tokens: (t) => `${t} tokens`,
    statTip: (t, n) => `${t} tokens · ${cntEn(n)} ${n === 1 ? "request" : "requests"}`,
    indexing: (a, b, x, y) => `Indexing transcripts: ${a} of ${b} files (${x} of ${y})`,
    byDay: "By day",
    range: "Range",
    rangeOpt: (n) => `${n} days`,
    avgShort: (c) => `avg ${c}`,
    byHm: (hm) => `, by ${hm}`,
    tipDay: (date, c, t, n) => `${date}${NL}${c} · ${t} tokens${NL}${cntEn(n)} ${n === 1 ? "request" : "requests"}`,
    tipEmpty: (date) => `${date}${NL}no requests`,
    tipUnpriced: "+ tokens of models without a price",
    tokensByDay: "Tokens by day",
    tokensNote: (avg, week) => `avg ${avg} a day · 7 days — ${week}`,
    cr: "Cache read",
    cw: "Cache write",
    out: "Output",
    outLong: "Output (model replies)",
    inp: "New input",
    tipTokens: (date, total) => `${date} — ${total}`,
    tipPrice: (c) => `At API prices: ${c}`,
    byType: "By token type",
    typeCols: "Token type¦Today¦7 days¦Share of cost, 7 days",
    cacheNote: (tp, cp) => `Cache reads are ${tp} of the tokens but ${cp} of the cost over 7 days`,
    where: "Where it goes · 7 days",
    wf: "Background Workflow",
    main: "The sessions themselves",
    sub: "Subagents",
    models: "Models · 7 days",
    modelTip: (t) => `${t} tokens over 7 days`,
    pricedAs: (m) => `priced as ${m}`,
    underDollar: "under $1",
    noPrice: "no price",
    alert: "Notify when today passes",
    alertNote: "at API list prices",
    off: "Off",
    over: (lim, c) => `Today's spend passed ${lim}: ${c} at API list prices`,
    details: "Details",
    pricesAsOf: (d) => `API list prices as of ${d}; cache writes are 1.25× input (5 min) and 2× (1 h)`,
    assumed: (list) => `Priced like the nearest model of the family: ${list}`,
    unpriced: (list) => `No price (tokens only, not in the cost): ${list}`,
    outputNote: "Output may be slightly under-counted: transcripts keep a stream snapshot",
    files: (n, at) => `Files in the index: ${n}${at ? ` · updated ${at}` : ""}`,
    monthName: (m) => MONTH_EN[m],
    broken: "Can't count the spend",
  },
};
function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const fmtBytes = (b, lang) => {
  const en = lang === "en";
  const v = b >= 1e9 ? `${(b / 1e9).toFixed(1)} ${en ? "GB" : "ГБ"}` : `${Math.max(0, Math.round(b / 1e6))} ${en ? "MB" : "МБ"}`;
  return en ? v : v.replace(".", ",");
};

// Token types: their colors in the stacked chart and the table (cache read at the bottom).
export const TYPE_COLORS = { cr: "#4A8FAD", cw: "#BF5AF2", out: "#FF9F0A", in: "#8E8E93" };
const SHARE_COLORS = { wf: "#BF5AF2", main: "#0A84FF", sub: "#64D2FF" };
const MODEL_COLOR = "#FF9F0A";

export const ALERT_STEPS = [0, 10, 25, 50, 100, 200, 500];
export const RANGES = [14, 30];
export const DEFAULT_SETTINGS = Object.freeze({ alertUsd: 0, rangeDays: 14 });

export function readSettings(path) {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    const a = Number(o?.alertUsd);
    const r = Number(o?.rangeDays);
    return { alertUsd: ALERT_STEPS.includes(a) ? a : 0, rangeDays: RANGES.includes(r) ? r : DEFAULT_SETTINGS.rangeDays };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---------- totals ----------
// Sum of model buckets → { v: vals, cost, unpriced: tokens without a price, byModel: {mk: vals} }
function sumModels(list) {
  const byModel = {};
  for (const m of list) for (const [mk, v] of Object.entries(m || {})) addTo((byModel[mk] ||= zero()), v);
  const v = zero();
  let cost = 0;
  let unpriced = 0;
  for (const [mk, x] of Object.entries(byModel)) {
    addTo(v, x);
    const c = costOf(mk, x);
    if (c === null) unpriced += tokensOf(x);
    else cost += c;
  }
  return { v, cost, unpriced, byModel };
}

// The mean daily cost (or any value) over the complete days of a list (today, the last, excluded), counted from the
// first day with data — a history that starts mid-range isn't diluted by the days before it. null — no data.
function meanOfPast(list, pick) {
  const past = list.slice(0, -1).map(pick);
  const first = past.findIndex((x) => x > 0);
  if (first < 0) return null;
  const used = past.slice(first);
  return used.reduce((a, b) => a + b, 0) / used.length;
}

// "2" / "1.6" (ru "1,6"); { text, int, r }
function fmtRatio(m, lang) {
  const r = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
  const int = Number.isInteger(r);
  return { text: int ? String(r) : dec(r, 1, lang), int, r };
}

// ---------- the frame ----------
export function render(idx, { lang = envLang(), settings = DEFAULT_SETTINGS, paused = false } = {}) {
  const L = T[lang] || T.ru;
  const en = lang === "en";
  const now = idx.now();
  const usd = (x) => fmtUsd(x, lang);
  const usdS = (x) => fmtUsdShort(x, lang);
  const usdL = (x) => usdLine(x, lang);
  const tok = (n) => fmtTokens(n, lang);
  const tokS = (n) => fmtTokensShort(n, lang);
  const day = (back) => dayKey(dayStart(now, back));
  const todayK = day(0);
  const hm = fmtHm(now);
  const d = (k) => idx.days[k] || null;
  const sumDays = (keys, pick = (x) => x.m) => sumModels(keys.map((k) => (d(k) ? pick(d(k)) : null)));
  const range = RANGES.includes(settings.rangeDays) ? settings.rangeDays : DEFAULT_SETTINGS.rangeDays;
  // per day, oldest first
  const span = Math.max(range, 14);
  const all = [];
  for (let i = span - 1; i >= 0; i--) {
    const k = day(i);
    all.push({ k, s: sumDays([k]) });
  }
  const shown = all.slice(-range);
  const last14 = all.slice(-14);
  const avg14 = meanOfPast(last14, (x) => x.s.cost);
  const avgRange = meanOfPast(shown, (x) => x.s.cost);
  const today = all[all.length - 1].s;
  const yesterday = all[all.length - 2].s;
  const week = [0, 1, 2, 3, 4, 5, 6].map(day);
  const last7 = sumDays(week);
  const nd = new Date(now);
  const monthStart = dayKey(new Date(nd.getFullYear(), nd.getMonth(), 1).getTime());
  const month = sumDays(Object.keys(idx.days).filter((k) => k >= monthStart && k <= todayK));
  const out = [];
  // until the first full pass the numbers are partial (the very first frame comes before any file is read)
  const firstIndex = !idx.indexedOnce && !idx.sourceMissing;
  const share = idx.progress.totalBytes > 0 ? `${Math.min(99, Math.floor((idx.progress.bytes / idx.progress.totalBytes) * 100))}%` : "0%";
  const missing = idx.sourceMissing && !Object.keys(idx.days).length;

  // header: the headline (menu bar, older hubs), then the hero of the page: the tile value large with a caption, a note
  // and a 14-day sparkline with its average
  let head;
  if (missing) head = L.headMissing;
  else if (firstIndex) head = L.headIndexing(usdL(today.cost), share);
  else head = L.head(usdL(today.cost), tok(tokensOf(today.v)));
  if (paused) head += L.paused;
  const tile = firstIndex ? `≥${usdL(today.cost)}` : usdL(today.cost);
  const hero = missing
    ? {}
    : {
        stat: (firstIndex ? L.todayIndexing(share) : L.todayBy(hm)) + (paused ? L.paused : ""),
        note: L.heroNote(tok(tokensOf(today.v)), today.v[N]),
        spark: last14.map((x) => num(x.s.cost)).join(","),
        sparkAvg: avg14 ? num(avg14) : undefined,
        sparkLabel: L.days14,
        sparkNote: avg14 ? L.avgPerDay(usdS(avg14)) : undefined,
      };
  out.push(line(clean(head, 160), { status: missing ? "unknown" : "ok", tile, tileLabel: L.tileLabel, sfimage: "dollarsign.circle", ...hero }));
  if (!missing) out.push(line(L.yesterdayWhole(usdL(yesterday.cost))));
  out.push("---");
  out.push(line(L.disclaimer, { sfimage: "info.circle", color: "gray" }));

  // stat cards: yesterday (against the 14-day average), 7 days, this month
  const tip = (s) => L.statTip(tok(tokensOf(s.v)), s.v[N]);
  const ratio = avg14 ? yesterday.cost / avg14 : 0;
  const yNote = ratio > 1.5 ? { note: L.times(...Object.values(fmtRatio(ratio, lang))), color: "orange" } : { note: L.tokens(tok(tokensOf(yesterday.v))) };
  out.push(line(usdS(yesterday.cost), { stat: L.yesterday, ...yNote, tooltip: tip(yesterday) }));
  out.push(line(usdS(last7.cost), { stat: L.week, note: L.perDay(usdS(last7.cost / 7)), tooltip: tip(last7) }));
  out.push(line(usdS(month.cost), { stat: L.monthName(nd.getMonth()), note: L.forDays(nd.getDate()), tooltip: tip(month) }));
  if (idx.indexing) {
    out.push(line(L.indexing(idx.progress.files, idx.progress.total, fmtBytes(idx.progress.bytes, lang), fmtBytes(idx.progress.totalBytes, lang)), { sfimage: "arrow.triangle.2.circlepath", color: "gray" }));
  }

  // alert threshold
  const alert = settings.alertUsd || 0;
  const whole = (a) => `$${a}`;
  if (alert > 0 && today.cost >= alert) {
    out.push(line(L.over(whole(alert), usdL(today.cost)), { event: `daily-over:${todayK.replace(/-/g, "")}`, sfimage: "bell.badge", color: "orange" }));
  }

  // by day: cost bars, the average, today highlighted; 14 / 30 days
  const dateOf = (x) => fmtDay(x.k, lang) + (x.k === todayK ? L.byHm(hm) : "");
  const labels = shown.map((x) => String(keyDate(x.k).getDate())).join("¦");
  const dense = range > 14; // no captions above 30 narrow bars
  out.push("---");
  out.push(
    line(L.byDay, {
      chart: "bars",
      values: shown.map((x) => num(x.s.cost)).join(","),
      labels,
      valueLabels: dense ? undefined : shown.map((x) => (x.s.v[N] ? usdS(x.s.cost) : "")).join("¦"),
      avg: avgRange ? num(avgRange) : undefined,
      avgLabel: avgRange ? L.avgShort(usdS(avgRange)) : undefined,
      highlight: "last",
      unit: "$",
      tips: shown
        .map((x) => {
          if (!x.s.v[N]) return L.tipEmpty(dateOf(x));
          const t = L.tipDay(dateOf(x), usdL(x.s.cost), tok(tokensOf(x.s.v)), x.s.v[N]);
          return x.s.unpriced ? `${t}${NL}${L.tipUnpriced}` : t;
        })
        .join("¦"),
    }),
  );
  out.push(line(`--${L.range}`, { segment: "true" }));
  for (const r of RANGES) out.push(line(`----${L.rangeOpt(r)}`, r === range ? { selected: "true" } : { action: "set-range", arg: String(r) }));

  // tokens by day: stacked cache read / cache write / output, then the token types with their share of the cost
  const parts = (s) => ({ cr: s.v[CR], cw: s.v[CW5] + s.v[CW1], out: s.v[OUT], in: s.v[IN] });
  const avgTok = meanOfPast(shown, (x) => tokensOf(x.s.v));
  out.push("---");
  out.push(
    line(L.tokensByDay, {
      chart: "bars",
      stack: [L.cr, L.cw, L.out].join(","),
      // in millions: the proportions are what matters, and the line stays short
      series: ["cr", "cw", "out"].map((f) => shown.map((x) => num(parts(x.s)[f] / 1e6)).join(",")).join(";"),
      colors: [TYPE_COLORS.cr, TYPE_COLORS.cw, TYPE_COLORS.out].join(","),
      labels,
      valueLabels: dense ? undefined : shown.map((x) => (tokensOf(x.s.v) ? tokS(tokensOf(x.s.v)) : "")).join("¦"),
      highlight: "last",
      tint: "none",
      note: L.tokensNote(avgTok ? tok(avgTok) : "—", tok(tokensOf(last7.v))),
      tips: shown
        .map((x) => {
          if (!x.s.v[N]) return L.tipEmpty(dateOf(x));
          const p = parts(x.s);
          return [L.tipTokens(dateOf(x), tok(tokensOf(x.s.v))), `${L.cr} ${tok(p.cr)}`, `${L.cw} ${tok(p.cw)}`, `${L.out} ${tok(p.out)}`, `${L.inp} ${tok(p.in)}`, L.tipPrice(usdL(x.s.cost) + (x.s.unpriced ? "+" : ""))].join(NL);
        })
        .join("¦"),
    }),
  );
  const costT = { cr: 0, cw: 0, out: 0, in: 0 };
  for (const [mk, v] of Object.entries(last7.byModel)) {
    const c = costParts(mk, v);
    if (c) for (const f of Object.keys(costT)) costT[f] += c[f];
  }
  const costSum = costT.cr + costT.cw + costT.out + costT.in;
  const tp = parts(today);
  const wp = parts(last7);
  out.push(line(`--${L.byType}`, { table: "true", columns: L.typeCols, barColumn: "4" }));
  for (const [f, title] of [["cr", L.cr], ["cw", L.cw], ["out", L.outLong], ["in", L.inp]]) {
    const p = pctOf(costT[f], costSum);
    out.push(line(`----${title}`, { cells: [tok(tp[f]), tok(wp[f]), costSum > 0 ? pctText(p) : "—"].join("¦"), sfimage: "square.fill", iconColor: TYPE_COLORS[f], bar: num(p) }));
  }
  const wt = tokensOf(last7.v);
  if (wt > 0 && costSum > 0) out.push(line(`--${L.cacheNote(pctText(pctOf(wp.cr, wt)), pctText(pctOf(costT.cr, costSum)))}`, { color: "gray" }));

  // where it goes over 7 days: background Workflow runs, the sessions themselves, subagents
  const wfW = sumDays(week, (x) => x.k?.wf);
  const subW = sumDays(week, (x) => x.k?.sub);
  const mainW = Math.max(0, last7.cost - wfW.cost - subW.cost);
  const kinds = [["wf", L.wf, wfW.cost], ["main", L.main, mainW], ["sub", L.sub, subW.cost]].filter(([, , c]) => c > 0).sort((x, y) => y[2] - x[2]);
  if (kinds.length) {
    out.push("---");
    out.push(line(L.where, { chart: "share" }));
    for (const [k, title, c] of kinds) out.push(line(`--${title}`, { value: num(c), note: usd(c), color: SHARE_COLORS[k] }));
  }

  // models over 7 days, the most expensive first, with a bar against the top one
  const models = new Map(); // display key (model + fast) → { week, tokens, unpriced }
  const gk = (mk) => mk.replace(/\+long$/, "").replace(/\+long\+/, "+");
  for (const [mk, v] of Object.entries(last7.byModel)) {
    if (!models.has(gk(mk))) models.set(gk(mk), { week: 0, tokens: 0, unpriced: false });
    const g = models.get(gk(mk));
    const c = costOf(mk, v);
    if (c === null) g.unpriced = true;
    else g.week += c;
    g.tokens += tokensOf(v);
  }
  if (models.size) {
    out.push("---");
    out.push(line(L.models));
    const rows = [...models.entries()].sort((a, b) => b[1].week - a[1].week || b[1].tokens - a[1].tokens);
    const top = Math.max(...rows.map(([, x]) => x.week));
    for (const [g, x] of rows) {
      const pr = priceOf(g.split("+")[0]);
      // "under $1" next to models that cost hundreds; exact cents when everything is small
      const note = x.unpriced ? L.noPrice : x.week < 1 && top >= 100 ? L.underDollar : usd(x.week);
      out.push(line(`--${modelName(g, lang)}`, { bar: num(pctOf(x.week, top)), note, color: MODEL_COLOR, badge: pr?.assumed ? L.pricedAs(modelName(pr.as, lang)) : undefined, tooltip: L.modelTip(tok(x.tokens)) }));
    }
  }

  // alert threshold control
  out.push("---");
  out.push(line(L.alert, { select: "true", note: L.alertNote }));
  for (const a of ALERT_STEPS) {
    const title = a ? whole(a) : L.off;
    out.push(line(`--${title}`, a === alert ? { selected: "true" } : { action: "set-alert", arg: String(a) }));
  }

  // details
  const assumed = new Set();
  const unpriced = new Map();
  for (const [mk, v] of Object.entries(month.byModel)) {
    const m = mk.split("+")[0];
    const pr = priceOf(m);
    if (!pr) unpriced.set(m, (unpriced.get(m) || 0) + tokensOf(v));
    else if (pr.assumed) assumed.add(`${m} → ${pr.as}`);
  }
  out.push(line(L.details, { details: "true" }));
  out.push(line(`--${L.pricesAsOf(PRICES_AS_OF)}`));
  if (assumed.size) out.push(line(`--${clean(L.assumed([...assumed].join(", ")), 300)}`));
  if (unpriced.size) out.push(line(`--${clean(L.unpriced([...unpriced].map(([m, t]) => `${m} (${tok(t)})`).join(", ")), 300)}`));
  out.push(line(`--${L.outputNote}`));
  out.push(line(`--${L.files(Object.keys(idx.files).length, idx.indexedAt ? fmtHm(idx.indexedAt) : null)}`));
  return out.join("\n");
}

// ---------- action ----------
// set-alert <amount> | set-range <days>: one setting changes, the other is kept.
function runAction(argv) {
  const i = argv.indexOf("--action");
  const [id, arg] = argv.slice(i + 1);
  const en = envLang() === "en";
  const dataDir = process.env.AGENTHUB_PLUGIN_DATA_PATH;
  const n = Number(arg);
  const ok = (id === "set-alert" && ALERT_STEPS.includes(n)) || (id === "set-range" && RANGES.includes(n));
  if (!ok || !dataDir) {
    console.log(`message=${en ? "Unknown action or value" : "Неизвестное действие или значение"}`);
    console.log("reason=bad-action");
    process.exit(3);
  }
  const path = join(dataDir, "settings.json");
  const next = { ...readSettings(path), ...(id === "set-alert" ? { alertUsd: n } : { rangeDays: n }) };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  process.exit(0);
}

// ---------- plugin process ----------
function main() {
  const tickMs = Math.max(500, Number(process.env.AGENTHUB_SPEND_TICK_MS) || 30_000);
  const dataDir = process.env.AGENTHUB_PLUGIN_DATA_PATH || process.env.AGENTHUB_PLUGIN_CACHE_PATH || null;
  const testNow = process.env.AGENTHUB_TEST_NOW ? Date.parse(process.env.AGENTHUB_TEST_NOW) : NaN;
  const idx = new SpendIndex({ cachePath: dataDir ? join(dataDir, "index.json") : null, now: Number.isFinite(testNow) ? () => testNow : () => Date.now() });
  const settingsPath = dataDir ? join(dataDir, "settings.json") : null;
  const paused = process.env.AGENTHUB_PAUSED === "1";
  idx.load();
  let lastText = null;
  let lastAt = 0;
  const emit = (force = false) => {
    let text;
    try {
      text = render(idx, { settings: settingsPath ? readSettings(settingsPath) : DEFAULT_SETTINGS, paused });
    } catch (e) {
      text = [line(T[envLang()].broken, { status: "unknown", event: "source-broken" }), "---", line(clean(e?.message || e, 140), { color: "gray" })].join("\n");
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
        idx.step(0); // nothing pending: marks the index complete
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
  emit(true);
  cycle();
  const timer = setInterval(cycle, tickMs);
  createInterface({ input: process.stdin }).on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m?.type === "refresh" || m?.type === "fileChanged") {
      lastText = null;
      cycle();
    } else if (m?.type === "actionResult") emit(true);
  });
  process.stdin.on("end", () => {
    clearInterval(timer);
    idx.save();
    process.exit(0);
  });
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  if (process.argv.includes("--action")) runAction(process.argv);
  else main();
}
