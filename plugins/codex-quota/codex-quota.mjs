#!/usr/bin/env node
// Codex CLI subscription limits: the 5-hour window and the week, the pace and a forecast to the reset.
//
// <agenthub.title>Codex Квота</agenthub.title>
// <agenthub.title lang="en">Codex Quota</agenthub.title>
// <agenthub.version>0.1.1</agenthub.version>
// <agenthub.author.name>Kensei</agenthub.author.name>
// <agenthub.author.github>KenseiTheOne</agenthub.author.github>
// <agenthub.desc>Сколько осталось лимитов Codex: 5-часовое окно, неделя и темп к сбросу</agenthub.desc>
// <agenthub.desc lang="en">How much Codex limit is left: the 5-hour window, the week and the pace to the reset</agenthub.desc>
// <agenthub.requires name="Codex" url="https://github.com/openai/codex" check="~/.codex">агент, чьи лимиты показывает плагин</agenthub.requires>
// <agenthub.requires lang="en" name="Codex">the agent whose limits this plugin shows</agenthub.requires>
// <agenthub.status value="ok" label="Запас есть">Лимитов хватает до сброса при нынешнем темпе</agenthub.status>
// <agenthub.status value="ok" lang="en" label="Plenty left">The limits will last until the reset at the current pace</agenthub.status>
// <agenthub.status value="wait" label="Лимит на исходе">Неделя ≥ 80% или при таком темпе 85% наступит раньше сброса</agenthub.status>
// <agenthub.status value="wait" lang="en" label="Running low">Week ≥ 80%, or at this pace you'll hit 85% before the reset</agenthub.status>
// <agenthub.status value="block" label="Лимит исчерпан">Лимит закончился — новые запросы до сброса не пройдут</agenthub.status>
// <agenthub.status value="block" lang="en" label="Limit reached">The limit is used up — requests won't go through until the reset</agenthub.status>
// <agenthub.status value="unknown" label="Лимиты не видны">Codex не установлен, нет входа или данные устарели — причина в первой строке</agenthub.status>
// <agenthub.status value="unknown" lang="en" label="Limits not visible">Codex isn't installed, not signed in, or the data is old — the reason is in the first line</agenthub.status>
// <agenthub.type>streamable</agenthub.type>
// <agenthub.platforms>macos</agenthub.platforms>
// <agenthub.exec>codex app-server — не чаще раза в 15 минут, через 5 минут, если сессии Codex что-то записали, и раз в час без входа через ChatGPT: initialize и account/rateLimits/read по stdio, затем процесс закрывается; токен читает сам Codex. Каждый запуск заставляет Codex обновить свои кэши и базы в ~/.codex</agenthub.exec>
// <agenthub.exec lang="en">codex app-server — at most every 15 minutes, after 5 minutes when Codex sessions wrote something, and hourly when not signed in with ChatGPT: initialize and account/rateLimits/read over stdio, then the process exits; Codex reads its own token. Each run makes Codex refresh its caches and databases under ~/.codex</agenthub.exec>
// <agenthub.fsRead>~/.codex/sessions/*/*/*/rollout-*.jsonl — время изменения файлов за последние дни (были ли сессии) и запасной источник: из хвоста новейших файлов только rate_limits событий token_count; текст переписки не читается</agenthub.fsRead>
// <agenthub.fsRead lang="en">~/.codex/sessions/*/*/*/rollout-*.jsonl — the files' modification times over the last days (whether sessions ran) and a fallback: from the tail of the newest files only rate_limits of token_count events; no conversation text is read</agenthub.fsRead>
// <agenthub.contract>3</agenthub.contract>
// <agenthub.icon symbol="gauge.with.dots.needle.50percent" color="#10A37F"></agenthub.icon>
// <agenthub.push key="week-80" cooldown="7d" kind="problems">Неделя Codex ≥ 80%</agenthub.push>
// <agenthub.push key="week-80" lang="en">Codex week ≥ 80%</agenthub.push>
// <agenthub.push key="pace-85" cooldown="7d" kind="problems">Codex: при таком темпе 85% наступит раньше сброса</agenthub.push>
// <agenthub.push key="pace-85" lang="en">Codex: at this pace you'll hit 85% before the reset</agenthub.push>
//
// Source: Codex itself. The plugin starts `codex app-server` (stdio JSON-RPC, the same server the Codex IDE extensions
// use, with CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1), sends `initialize`, the `initialized` notification and
// `account/rateLimits/read`, takes the answer and closes the server's stdin (the server exits on EOF; a stuck one gets
// SIGTERM, then SIGKILL). Codex makes the network call with its own sign-in; the plugin never opens Codex's credentials
// file and never calls the backend itself. The stdio server is not the background daemon: it does not start one and
// lives only for the call (≤ 20 s). Each start makes Codex refresh its own caches and databases under ~/.codex, so calls
// are rare (callDue): at most every 15 minutes, after 5 minutes when a session file changed since the last call, and
// once an hour after "API key", "not signed in" or "codex not found"; a manual refresh after 1 minute.
//
// Fallback: when the call fails (no network, timeout, an old Codex), the newest `token_count` event in the tail of the
// newest session files carries `rate_limits` (`primary`/`secondary`, `used_percent`, `window_minutes`, `resets_at`). The
// card then says the data comes from session files and how old it is. Windows are mapped by their length, not by their
// position: 300 min — the 5-hour window, 10080 min — the week (an older Codex had the week in `primary`).
//
// Not installed (no `codex` and no ~/.codex) or not signed in — a quiet state with a hint, no event. An answer of an
// unknown shape → status=unknown + event=source-broken. The last answer is kept in PluginData/limits.json, so a restart
// doesn't call Codex again before it is due. While the hub is paused the plugin doesn't start Codex.
//
// Events: week-80 (week ≥ 80%), pace-85 (at the current pace 85% will be reached before the reset).
// stdin: refresh — call Codex now (at most once a minute); stopping / EOF — exit.
//
// For tests: AGENTHUB_TEST_BIN_DIR (a fake codex), AGENTHUB_TEST_NOW, AGENTHUB_CODEX_REFRESH_MS, AGENTHUB_CODEX_RPC_TIMEOUT_MS.

import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const H5 = 5 * HOUR;
const MAX_AGE_MS = HOUR;
const WEEK_WARN = 80;
const PACE_WARN = 85;
// The app-server cadence: every 15 min, after 5 min when sessions changed, hourly after a "won't work" error.
const REFRESH_MS = Math.max(1000, Number(process.env.AGENTHUB_CODEX_REFRESH_MS) || 15 * MIN);
const SOON_MS = Math.min(5 * MIN, REFRESH_MS);
const MANUAL_MIN_MS = Math.min(MIN, REFRESH_MS);
const BACKOFF_MS = Math.max(HOUR, REFRESH_MS);
const BACKOFF_ERRORS = new Set(["api-key", "not-logged-in", "no-codex"]);
const TICK_MS = Math.min(MIN, SOON_MS);
const RPC_TIMEOUT_MS = Math.max(500, Number(process.env.AGENTHUB_CODEX_RPC_TIMEOUT_MS) || 20_000);
const TAIL_BYTES = 512 * 1024;
const FALLBACK_FILES = 12;
const DAY_DIRS = 31; // newestRollouts looks at the files of the newest day folders only

// ---------- helpers ----------
export function clean(text, max = 120) {
  let s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\|/g, "¦").replace(/\s+/g, " ").trim();
  s = s.replace(/^[-~]+/, "").trim();
  if ([...s].length > max) s = [...s].slice(0, max - 1).join("") + "…";
  return s;
}
const q = (v) => `"${clean(v, 300).replace(/["\\]/g, "\\$&")}"`;
export function envLang() {
  return process.env.AGENTHUB_LANG === "en" ? "en" : "ru";
}
const pad2 = (n) => String(n).padStart(2, "0");
const WD = { ru: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtWhen(ms, nowMs, lang = "ru") {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (new Date(nowMs).toDateString() === d.toDateString()) return hm;
  if (lang === "en") return `${WD.en[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}, ${hm}`;
  return `${WD.ru[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${hm}`;
}
const pct = (v) => `${Math.round(v)}%`;

// Codex home: $CODEX_HOME or ~/.codex.
export function codexHome(env = process.env) {
  const h = env.CODEX_HOME;
  return h && h.startsWith("/") ? h : join(homedir(), ".codex");
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
// The codex binary: a test double, PATH, then the copy inside Codex.app.
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
// The child's environment: the plugin's own, without the hub's variables.
// Remote control off: the short-lived server must not register with or connect to the remote-control service.
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("AGENTHUB_")) env[k] = v;
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  return env;
}

// Whether to start `codex app-server` now. calledAt — the last call (ms), error — its reason, changed — a session file
// was modified after it, manual — the user asked for a refresh.
export function callDue({ nowMs, calledAt = 0, error = null, manual = false, changed = false }, { every = REFRESH_MS, soon = SOON_MS, manualMin = MANUAL_MIN_MS, backoff = BACKOFF_MS } = {}) {
  const since = nowMs - (Number(calledAt) || 0);
  if (manual) return since >= manualMin;
  if (error && BACKOFF_ERRORS.has(error)) return since >= backoff;
  return since >= every || (changed && since >= soon);
}

// ---------- codex app-server over stdio ----------
// One short JSON-RPC session: initialize, initialized, then the given requests in order. → { ok, results: {method: result},
// errors: {method: {code, message}}, error: short code | null }. The child's stdin is closed as soon as every request has an
// answer (the server exits on EOF); one still alive a second later gets SIGTERM, and SIGKILL after 3 s more.
export function appServerCall(bin, requests, { timeoutMs = RPC_TIMEOUT_MS, cwd = homedir() } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: childEnv(), cwd: existsSync(cwd) ? cwd : "/" });
    } catch (e) {
      resolve({ ok: false, results: {}, errors: {}, error: /^[A-Z][A-Z0-9_]{1,30}$/.test(String(e?.code || "")) ? e.code : "spawn" });
      return;
    }
    const results = {};
    const errors = {};
    const pending = new Map(); // id → method
    let done = false;
    let exited = false;
    const finish = (error) => {
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
      resolve({ ok: !error, results, errors, error: error || null });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    child.on("error", (e) => {
      exited = true;
      finish(/^[A-Z][A-Z0-9_]{1,30}$/.test(String(e?.code || "")) ? e.code : "spawn");
    });
    child.on("exit", (code) => {
      exited = true;
      finish(pending.size ? `exit ${code ?? "signal"}` : null);
    });
    child.stdin.on("error", () => {});
    const send = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + "\n");
      } catch {}
    };
    const rl = createInterface({ input: child.stdout });
    let next = 2;
    const sendRequests = () => {
      for (const r of requests) {
        const id = next++;
        pending.set(id, r.method);
        send(r.params === undefined ? { id, method: r.method } : { id, method: r.method, params: r.params });
      }
      if (!pending.size) finish(null);
    };
    rl.on("line", (line) => {
      if (done) return;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return; // not a protocol line
      }
      if (!m || typeof m !== "object" || m.id === undefined || m.method !== undefined) return; // notifications and server requests
      if (m.id === 1) {
        if (m.error) {
          errors.initialize = { code: m.error.code, message: clean(m.error.message, 200) };
          finish("initialize");
          return;
        }
        send({ method: "initialized" });
        sendRequests();
        return;
      }
      const method = pending.get(m.id);
      if (!method) return;
      pending.delete(m.id);
      if (m.error) errors[method] = { code: m.error.code, message: clean(m.error.message, 200) };
      else results[method] = m.result;
      if (!pending.size) finish(null);
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent_hub", title: "Agent Hub", version: VERSION } } });
  });
}

// An RPC error → a short reason code: not signed in, an API key instead of a ChatGPT sign-in, or "rpc".
export function rpcReason(err) {
  const m = String(err?.message || "").toLowerCase();
  if (/chatgpt authentication required/.test(m)) return "api-key";
  if (/authentication required|not logged in|unauthori[sz]ed|login/.test(m)) return "not-logged-in";
  return "rpc";
}

// ---------- snapshots ----------
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
// A window from the server (usedPercent, windowDurationMins, resetsAt) or from a session file (used_percent,
// window_minutes, resets_at) → { percent, minutes, resetsMs } | null; undefined — an unknown shape.
export function parseWindow(w) {
  if (w === null || w === undefined) return null;
  if (typeof w !== "object" || Array.isArray(w)) return undefined;
  const percent = num(w.usedPercent ?? w.used_percent);
  if (percent === null) return undefined;
  const minutes = num(w.windowDurationMins ?? w.window_minutes);
  const resets = num(w.resetsAt ?? w.resets_at);
  return { percent, minutes, resetsMs: resets !== null ? resets * 1000 : null };
}
// A snapshot → { ok, limitId, name, plan, reached, windows:[…] } | { ok:false, problem }.
export function parseSnapshot(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, problem: "snapshot" };
  const windows = [];
  for (const k of ["primary", "secondary"]) {
    const w = parseWindow(s[k]);
    if (w === undefined) return { ok: false, problem: "window" };
    if (w) windows.push(w);
  }
  const str = (x) => (typeof x === "string" && x ? clean(x, 40) : null);
  return {
    ok: true,
    limitId: str(s.limitId ?? s.limit_id),
    name: str(s.limitName ?? s.limit_name) || str(s.normalModelSlug ?? s.normal_model_slug),
    plan: str(s.planType ?? s.plan_type),
    reached: str(s.rateLimitReachedType ?? s.rate_limit_reached_type),
    windows,
  };
}
// The account/rateLimits/read result → { ok, snapshots:[main, …others] } | { ok:false, problem }. The main one is the
// `codex` bucket when the server lists buckets, otherwise the single-bucket view.
export function parseRateLimits(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, problem: "not-object" };
  const main = parseSnapshot(r.rateLimits);
  if (!main.ok) return { ok: false, problem: `rateLimits:${main.problem}` };
  const snapshots = [main];
  const by = r.rateLimitsByLimitId;
  if (by && typeof by === "object" && !Array.isArray(by)) {
    for (const [id, s] of Object.entries(by)) {
      const p = parseSnapshot(s);
      if (!p.ok || !p.windows.length) continue;
      p.limitId ||= clean(id, 40);
      if (p.limitId === main.limitId || (!main.limitId && id === "codex")) {
        snapshots[0] = { ...p, plan: p.plan || main.plan };
        continue;
      }
      snapshots.push(p);
    }
  }
  return { ok: true, snapshots, allowed: typeof r.ordinaryUsageAllowed === "boolean" ? r.ordinaryUsageAllowed : null };
}

// ---------- the fallback: session files ----------
function safeReaddir(p) {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
// The most recently modified rollout files: sessions/YYYY/MM/DD/rollout-*.jsonl from the newest `days` day folders (a
// file lives in the folder of the day its session started, so a long session's file can be days old by name), sorted by
// mtime, at most `limit`.
export function newestRollouts(home, limit = FALLBACK_FILES, { days = DAY_DIRS } = {}) {
  const root = join(home, "sessions");
  const out = [];
  let left = days;
  const desc = (list) => list.filter((e) => e.isDirectory() && /^\d{2,4}$/.test(e.name)).map((e) => e.name).sort().reverse();
  walk: for (const y of desc(safeReaddir(root))) {
    for (const m of desc(safeReaddir(join(root, y)))) {
      for (const d of desc(safeReaddir(join(root, y, m)))) {
        if (left-- <= 0) break walk;
        const dir = join(root, y, m, d);
        for (const f of safeReaddir(dir)) {
          if (!f.isFile() || !/^rollout-.*\.jsonl$/.test(f.name)) continue;
          try {
            out.push({ path: join(dir, f.name), mtimeMs: statSync(join(dir, f.name)).mtimeMs });
          } catch {}
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}
// The last `bytes` of a file, complete lines only.
export function tailLines(path, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.allocUnsafe(size - start);
    const got = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8", 0, got).split("\n");
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// The newest rate_limits snapshot in a token_count event of the newest session files → { atMs, snapshot } | null.
// Only lines that are token_count events are parsed, and only rate_limits and the timestamp are kept.
export function rolloutLimits(home, { limit = FALLBACK_FILES } = {}) {
  let best = null;
  for (const f of newestRollouts(home, limit)) {
    if (best && f.mtimeMs < best.atMs) break; // nothing newer can be inside an older file
    const lines = tailLines(f.path);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"token_count"') || !l.includes('"rate_limits"')) continue;
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if (o?.type !== "event_msg" || o.payload?.type !== "token_count") continue;
      const rl = o.payload.rate_limits;
      const at = Date.parse(o.timestamp);
      if (!rl || typeof rl !== "object" || !Number.isFinite(at)) continue;
      const p = parseSnapshot(rl);
      if (!p.ok || !p.windows.length) continue;
      if (!best || at > best.atMs) best = { atMs: at, snapshot: p };
      break; // the newest in this file
    }
  }
  return best;
}

// ---------- texts ----------
export const T = {
  ru: {
    tileLabel: "Codex Квота",
    week: "Неделя",
    h5: "5-часовое окно",
    window: (m) => (m % 1440 === 0 ? `Окно ${m / 1440} дн` : m % 60 === 0 ? `Окно ${m / 60} ч` : `Окно ${m} мин`),
    gaugeLabel: "недели",
    gaugeLabelH5: "5 часов",
    used: (p) => `${p} использовано`,
    headNow: (w, r) => `Неделя ${w}${r ? ` · сброс ${r}` : ""}`,
    headNowH5: (p, r) => `5 часов ${p}${r ? ` · сброс ${r}` : ""}`,
    headBlock: (r) => (r ? `Codex: лимит исчерпан до ${r}` : "Codex: лимит исчерпан"),
    headScopeBlock: (m, r, w) => `Лимит ${m} исчерпан${r ? ` до ${r}` : ""}${w ? ` · неделя ${w}` : ""}`,
    tail: (why, when) => ` · не обновляется${why ? `: ${why}` : ""}${when ? ` · данные ${when}` : ""}`,
    fromFiles: (when) => ` · по файлам сессий, ${when}`,
    headStale: (why, when) => `Codex: квота не обновляется${why ? `: ${why}` : ""}${when ? ` · данные ${when}` : ""}`,
    headWaiting: "Codex: квота загружается",
    headNone: "Codex: данных о квоте пока нет",
    headNotInstalled: "Codex не установлен",
    hintNotInstalled: "Плагин ищет codex в ~/.local/bin, /opt/homebrew/bin, /usr/local/bin и в Codex.app",
    headNoLogin: "Codex: нет входа — квота недоступна",
    hintNoLogin: "Войдите в Codex: codex login (вход через ChatGPT)",
    headApiKey: "Codex вошёл по ключу API — у ключа нет лимитов подписки",
    headPaused: "Codex: квота на паузе вместе с хабом",
    why: {
      "not-logged-in": "нет входа в Codex",
      "api-key": "вход по ключу API, лимитов подписки нет",
      timeout: "Codex не ответил за 20 с",
      "no-codex": "codex не найден",
      rpc: "Codex вернул ошибку",
      initialize: "Codex не принял подключение",
      "bad-response": "незнакомый ответ Codex",
      paused: "хаб на паузе",
    },
    whyOther: (code) => `ошибка ${code}`,
    week80: (n) => `Неделя ≥ ${n}%`,
    paceHit: (n, hit, reset) => `При таком темпе ${n}% наступит ${hit} — раньше сброса (${reset})`,
    reset: (r) => `сброс ${r}`,
    wasReset: (l, r) => `${l}: сброшено ${r}, свежих данных пока нет`,
    pace: (f) => `Если тратить так же, к сбросу будет ≈${f}`,
    passedWeek: (p) => `Прошло ${p} недели`,
    passedH5: (p) => `Прошло ${p} окна 5 часов`,
    ago: (m) => (m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 2880 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн назад`),
    reached: "Codex сообщил: лимит достигнут",
    notAllowed: "Codex сообщил: обычное использование сейчас недоступно",
    sourceTitle: "Откуда данные",
    sourceLive: (when) => `codex app-server (account/rateLimits/read) · ${when}`,
    sourceFiles: (when, why) => `последнее событие token_count в файлах сессий · ${when}${why ? ` · Codex не ответил: ${why}` : ""}`,
    plan: (p) => `План: ${p}`,
    broken: "Не получается прочитать квоту Codex",
    problem: (p) => `Ответ account/rateLimits/read: ${p}`,
    pluginError: "Сбой плагина квоты Codex",
  },
  en: {
    tileLabel: "Codex quota",
    week: "Week",
    h5: "5-hour window",
    window: (m) => (m % 1440 === 0 ? `${m / 1440}-day window` : m % 60 === 0 ? `${m / 60}-hour window` : `${m}-minute window`),
    gaugeLabel: "of week",
    gaugeLabelH5: "of 5 h",
    used: (p) => `${p} used`,
    headNow: (w, r) => `Week ${w}${r ? ` · resets ${r}` : ""}`,
    headNowH5: (p, r) => `5 hours ${p}${r ? ` · resets ${r}` : ""}`,
    headBlock: (r) => (r ? `Codex limit reached until ${r}` : "Codex limit reached"),
    headScopeBlock: (m, r, w) => `${m} limit reached${r ? ` until ${r}` : ""}${w ? ` · week ${w}` : ""}`,
    tail: (why, when) => ` · not updating${why ? `: ${why}` : ""}${when ? ` · data from ${when}` : ""}`,
    fromFiles: (when) => ` · from session files, ${when}`,
    headStale: (why, when) => `Codex quota not updating${why ? `: ${why}` : ""}${when ? ` · data from ${when}` : ""}`,
    headWaiting: "Codex quota loading — asking Codex",
    headNone: "No Codex quota data yet",
    headNotInstalled: "Codex isn't installed",
    hintNotInstalled: "The plugin looks for codex in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin and in Codex.app",
    headNoLogin: "Not signed in to Codex — no quota",
    hintNoLogin: "Sign in to Codex: codex login (with ChatGPT)",
    headApiKey: "Codex uses an API key — a key has no subscription limits",
    headPaused: "Codex quota: the hub is paused",
    why: {
      "not-logged-in": "not signed in to Codex",
      "api-key": "signed in with an API key, no subscription limits",
      timeout: "Codex didn't answer within 20 s",
      "no-codex": "codex not found",
      rpc: "Codex returned an error",
      initialize: "Codex refused the connection",
      "bad-response": "unexpected answer from Codex",
      paused: "the hub is paused",
    },
    whyOther: (code) => `error ${code}`,
    week80: (n) => `Week ≥ ${n}%`,
    paceHit: (n, hit, reset) => `At this pace you'll hit ${n}% at ${hit} — before the reset (${reset})`,
    reset: (r) => `resets ${r}`,
    wasReset: (l, r) => `${l}: reset at ${r}, no fresh data yet`,
    pace: (f) => `At this pace: ≈${f} by the reset`,
    passedWeek: (p) => `${p} of the week has passed`,
    passedH5: (p) => `${p} of the 5-hour window has passed`,
    ago: (m) => (m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`),
    reached: "Codex says: limit reached",
    notAllowed: "Codex says: ordinary usage isn't available right now",
    sourceTitle: "Where the data comes from",
    sourceLive: (when) => `codex app-server (account/rateLimits/read) · ${when}`,
    sourceFiles: (when, why) => `the last token_count event in session files · ${when}${why ? ` · Codex didn't answer: ${why}` : ""}`,
    plan: (p) => `Plan: ${p}`,
    broken: "Can't read the Codex quota",
    problem: (p) => `account/rateLimits/read answer: ${p}`,
    pluginError: "Codex quota plugin failure",
  },
};

// ---------- pace ----------
const windowMs = (w) => (w.minutes ? w.minutes * MIN : null);
// A linear forecast to the reset and the moment the threshold will be reached. → { forecast, hitMs } | null
export function pace(w, nowMs, threshold = PACE_WARN) {
  const len = windowMs(w);
  if (!len || !w.resetsMs) return null;
  const elapsed = nowMs - (w.resetsMs - len);
  if (elapsed <= 0 || w.resetsMs <= nowMs) return null;
  if (elapsed < len * 0.05) return null; // the first 5% of the window say nothing yet
  const rate = w.percent / elapsed;
  const forecast = w.percent + rate * (w.resetsMs - nowMs);
  let hitMs = null;
  if (w.percent >= threshold) hitMs = nowMs;
  else if (rate > 0) hitMs = nowMs + (threshold - w.percent) / rate;
  return { forecast, hitMs: hitMs !== null && hitMs < w.resetsMs ? hitMs : null };
}
export function passed(w, nowMs) {
  const len = windowMs(w);
  if (!len || !w.resetsMs || w.resetsMs <= nowMs) return null;
  const elapsed = nowMs - (w.resetsMs - len);
  return elapsed <= 0 ? null : Math.min(100, (elapsed / len) * 100);
}

// Rows for rendering: every window of every snapshot. kind: h5 | week | other; scope — the bucket name for a narrower
// limit (null for the main bucket).
export function rowsOf(snapshots) {
  const rows = [];
  snapshots.forEach((s, i) => {
    for (const w of s.windows) {
      const kind = w.minutes === 300 ? "h5" : w.minutes === 10080 ? "week" : "other";
      rows.push({ ...w, kind, scope: i === 0 ? null : s.name || s.limitId || "?" });
    }
  });
  return rows;
}

// state: { installed, data: { source: "live"|"files", atMs, snapshots, allowed } | null, error: code | null,
//          problem: string | null, checking, paused }
export function render(state, nowMs, lang = envLang()) {
  const L = T[lang] || T.ru;
  const when = (ms) => fmtWhen(ms, nowMs, lang);
  const ago = (ms) => L.ago(Math.max(0, Math.round((nowMs - ms) / MIN)));
  const why = (code) => (code ? L.why[code] || L.whyOther(code) : null);
  const out = [];
  const head0 = (text, extra = "") => `${clean(text, 200)} | status=unknown tile="—" tileLabel=${q(L.tileLabel)}${extra} sfimage=gauge.with.dots.needle.0percent`;
  if (!state.installed) {
    out.push(head0(L.headNotInstalled), "---", `${clean(L.hintNotInstalled, 160)} | sfimage=info.circle color=gray`);
    return out.join("\n");
  }
  const d = state.data;
  if (!d) {
    if (state.problem) {
      out.push(head0(L.broken), "---", `${clean(L.problem(state.problem), 160)} | status=unknown event=source-broken`);
    } else if (state.error === "not-logged-in") {
      out.push(head0(L.headNoLogin), "---", `${clean(L.hintNoLogin, 160)} | sfimage=info.circle color=gray`);
    } else if (state.error === "api-key") {
      out.push(head0(L.headApiKey));
      out.push("---");
    } else if (state.paused) {
      out.push(head0(L.headPaused));
      out.push("---");
    } else if (state.error) {
      out.push(head0(L.headStale(why(state.error), null)));
      out.push("---");
    } else {
      out.push(head0(state.checking ? L.headWaiting : L.headNone));
      out.push("---");
    }
    return out.join("\n");
  }
  const age = nowMs - d.atMs;
  const stale = age > MAX_AGE_MS;
  const files = d.source === "files";
  const live = (r) => !r.resetsMs || r.resetsMs > nowMs;
  const rows = rowsOf(d.snapshots);
  const liveRows = rows.filter(live);
  const week = liveRows.find((r) => r.kind === "week" && !r.scope) || null;
  const h5 = liveRows.find((r) => r.kind === "h5" && !r.scope) || null;
  const weekTag = week?.resetsMs ? `:${new Date(week.resetsMs).toISOString().slice(0, 10).replace(/-/g, "")}` : "";
  const events = [];
  const wp = week && !stale ? pace(week, nowMs) : null;
  if (week) {
    if (week.percent >= WEEK_WARN) events.push({ key: `week-80${weekTag}`, text: L.week80(WEEK_WARN) });
    if (wp && wp.hitMs !== null && week.percent < PACE_WARN) events.push({ key: `pace-85${weekTag}`, text: L.paceHit(PACE_WARN, when(wp.hitMs), when(week.resetsMs)) });
  }
  let status = events.length ? "wait" : "ok";
  const full = liveRows.find((r) => r.percent >= 100 && !r.scope) || null;
  const scopeFull = full ? null : liveRows.find((r) => r.percent >= 100 && r.scope) || null;
  const reached = !stale && d.snapshots[0]?.reached;
  if (full || reached) status = "block";
  else if (scopeFull) status = "wait";
  if (stale && status === "ok") status = "unknown";
  const lead = week || h5;
  let head;
  if (full || reached) head = L.headBlock(full?.resetsMs ? when(full.resetsMs) : null);
  else if (scopeFull) head = L.headScopeBlock(scopeFull.scope, scopeFull.resetsMs ? when(scopeFull.resetsMs) : null, week ? pct(week.percent) : null);
  else if (lead && (!stale || events.length)) head = week ? L.headNow(pct(week.percent), !stale && week.resetsMs ? when(week.resetsMs) : null) : L.headNowH5(pct(h5.percent), !stale && h5.resetsMs ? when(h5.resetsMs) : null);
  if (head) {
    if (stale) head += L.tail(why(state.error), ago(d.atMs));
    else if (files) head += L.fromFiles(ago(d.atMs));
  } else head = L.headStale(why(state.error), ago(d.atMs));
  const tile = lead ? pct(lead.percent) : "—";
  const ring = lead ? ` gauge=${Math.round(Math.min(100, Math.max(0, lead.percent)))} gaugeLabel=${q(week ? L.gaugeLabel : L.gaugeLabelH5)}` : "";
  out.push(`${clean(head, 200)} | status=${status} tile=${q(tile)} tileLabel=${q(L.tileLabel)}${ring} sfimage=gauge.with.dots.needle.67percent`);
  out.push("---");
  for (const e of events) out.push(`${clean(e.text, 140)} | status=wait event=${e.key} sfimage=exclamationmark.triangle`);
  if (reached && !full) out.push(`${L.reached} | status=block sfimage=xmark.octagon color=red`);
  else if (d.allowed === false && !stale) out.push(`${L.notAllowed} | sfimage=exclamationmark.triangle color=orange`);
  const label = (r) => {
    const base = r.kind === "h5" ? L.h5 : r.kind === "week" ? L.week : r.minutes ? L.window(r.minutes) : "?";
    return r.scope ? `${base} · ${r.scope}` : base;
  };
  const order = { h5: 0, week: 1, other: 2 };
  const ordered = [...rows].sort((a, b) => (a.scope ? 1 : 0) - (b.scope ? 1 : 0) || order[a.kind] - order[b.kind]);
  let weekPassed = null;
  for (const r of ordered) {
    const icon = r.kind === "h5" ? "clock" : "calendar";
    if (!live(r)) {
      out.push(`${clean(L.wasReset(label(r), when(r.resetsMs)), 120)} | sfimage=${icon} color=gray`);
      continue;
    }
    const note = r.resetsMs ? ` note=${q(L.reset(when(r.resetsMs)))}` : "";
    const color = r.percent >= 100 ? ` status=${r.scope ? "wait" : "block"} color=red` : r.percent >= WEEK_WARN ? " color=orange" : "";
    out.push(`${clean(`${label(r)} — ${L.used(pct(r.percent))}`, 120)} | gauge=${Math.round(Math.min(100, Math.max(0, r.percent)))}${note} sfimage=${icon}${color}`);
    const p = stale ? null : pace(r, nowMs);
    if (p) out.push(`--${L.pace(pct(Math.min(p.forecast, 999)))}`);
    const done = passed(r, nowMs);
    if (r.kind === "h5" && done !== null) out.push(`--${L.passedH5(pct(done))}`);
    if (r.kind === "week" && !r.scope && weekPassed === null) weekPassed = done;
  }
  if (weekPassed !== null) out.push(`${L.passedWeek(pct(weekPassed))} | sfimage=hourglass color=gray`);
  out.push("---");
  out.push(`${L.sourceTitle} | color=gray size=11`);
  out.push(`--${clean(files ? L.sourceFiles(ago(d.atMs), why(state.error)) : L.sourceLive(ago(d.atMs)), 200)} | color=gray size=11`);
  if (d.snapshots[0]?.plan) out.push(`--${clean(L.plan(d.snapshots[0].plan), 60)} | color=gray size=11`);
  return out.join("\n");
}

// ---------- one refresh ----------
// → { installed, data, error, problem } for render. `last` — the previous live data (kept when a call fails).
export async function refresh({ home = codexHome(), last = null, nowMs = Date.now(), paused = false, call = true } = {}) {
  const bin = codexBin();
  const hasHome = existsSync(home);
  if (!bin && !hasHome) return { installed: false, data: null, error: null, problem: null, live: null };
  let live = last;
  let error = null;
  let problem = null;
  if (paused) error = "paused";
  else if (!bin) error = "no-codex";
  else if (!hasHome) error = "not-logged-in"; // codex is there but has never been set up
  else if (call) {
    const r = await appServerCall(bin, [{ method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } }]);
    const res = r.results["account/rateLimits/read"];
    const err = r.errors["account/rateLimits/read"];
    if (res !== undefined) {
      const p = parseRateLimits(res);
      if (p.ok) live = { source: "live", atMs: nowMs, snapshots: p.snapshots, allowed: p.allowed };
      else {
        problem = p.problem;
        error = "bad-response";
      }
    } else if (err) error = rpcReason(err);
    else error = r.error === "initialize" ? "initialize" : r.error || "rpc";
  }
  // the newest of: the last live answer, the newest token_count in session files
  let data = live;
  if (hasHome && (!live || error)) {
    const f = rolloutLimits(home);
    if (f && (!data || f.atMs > data.atMs)) data = { source: "files", atMs: f.atMs, snapshots: [f.snapshot], allowed: null };
  }
  return { installed: true, data, error, problem: data ? null : problem, live };
}

// PluginData/limits.json: the last live answer and the time of the last call.
function loadCache(path) {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    if (c && c.v === 1) return { live: c.live && Array.isArray(c.live.snapshots) ? c.live : null, calledAt: Number(c.calledAt) || 0, error: typeof c.error === "string" ? c.error : null };
  } catch {}
  return { live: null, calledAt: 0, error: null };
}
function saveCache(path, c) {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ v: 1, ...c }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch {}
}

// The frame for a failed refresh: the same tile caption as a normal frame.
export function brokenFrame(err, lang = envLang()) {
  const L = T[lang] || T.ru;
  return `${L.pluginError} | status=unknown tileLabel=${q(L.tileLabel)}\n---\n${clean(err?.message || err, 140)} | event=source-broken`;
}

async function main() {
  const dataDir = process.env.AGENTHUB_PLUGIN_DATA_PATH || process.env.AGENTHUB_PLUGIN_CACHE_PATH || null;
  const cachePath = dataDir ? join(dataDir, "limits.json") : null;
  const cache = cachePath ? loadCache(cachePath) : { live: null, calledAt: 0, error: null };
  const paused = process.env.AGENTHUB_PAUSED === "1";
  const now = () => (process.env.AGENTHUB_TEST_NOW ? Date.parse(process.env.AGENTHUB_TEST_NOW) : Date.now());
  let last = null;
  let busy = false;
  let again = false;
  let timer = null;
  let state = null;
  const emit = (text) => {
    if (text !== last) {
      process.stdout.write(`${text}\n~~~\n`);
      last = text;
    }
  };
  const tick = async (force = false) => {
    clearTimeout(timer);
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const t = Date.now();
      const home = codexHome();
      const newest = !force && cache.calledAt ? newestRollouts(home, 1)[0] : null;
      const due = callDue({ nowMs: t, calledAt: cache.calledAt, error: cache.error, manual: force, changed: Boolean(newest && newest.mtimeMs > cache.calledAt) });
      if (due && !state && !paused && codexBin() && existsSync(codexHome())) emit(render({ installed: true, data: cache.live, error: null, checking: true, paused }, now()));
      const r = await refresh({ last: cache.live, nowMs: now(), paused, call: due });
      if (due && !paused && r.installed) {
        cache.calledAt = t;
        cache.error = r.error;
      } else if (!due) r.error = r.error || cache.error;
      cache.live = r.live;
      if (cachePath) saveCache(cachePath, cache);
      state = r;
      emit(render({ ...r, paused }, now()));
    } catch (e) {
      emit(brokenFrame(e));
    } finally {
      busy = false;
      if (again) {
        again = false;
        setImmediate(() => tick(true));
      } else timer = setTimeout(tick, TICK_MS);
    }
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m?.type === "refresh") tick(true);
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
