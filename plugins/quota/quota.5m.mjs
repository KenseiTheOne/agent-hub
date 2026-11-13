#!/usr/bin/env node
// Claude subscription quota: the week, the 5-hour window, the pace and a forecast to the reset.
//
// <agenthub.title>Claude Code Квота</agenthub.title>
// <agenthub.title lang="en">Claude Code Quota</agenthub.title>
// <agenthub.version>0.5.2</agenthub.version>
// <agenthub.author.name>Kensei</agenthub.author.name>
// <agenthub.author.github>KenseiTheOne</agenthub.author.github>
// <agenthub.desc>Сколько осталось квоты Claude: неделя, 5-часовое окно и темп к сбросу</agenthub.desc>
// <agenthub.desc lang="en">How much Claude quota is left: week, 5-hour window and pace to reset</agenthub.desc>
// <agenthub.status value="ok" label="Запас есть">Квоты хватает до сброса при нынешнем темпе</agenthub.status>
// <agenthub.status value="ok" lang="en" label="Plenty left">Quota will last until reset at the current pace</agenthub.status>
// <agenthub.status value="wait" label="Квота на исходе">Неделя ≥ 80% или при таком темпе 85% наступит раньше сброса</agenthub.status>
// <agenthub.status value="wait" lang="en" label="Running low">Week ≥ 80%, or at this pace you'll hit 85% before reset</agenthub.status>
// <agenthub.status value="block" label="Лимит исчерпан">Квота закончилась — новые запросы до сброса не пройдут</agenthub.status>
// <agenthub.status value="block" lang="en" label="Limit reached">Quota is used up — requests won't go through until reset</agenthub.status>
// <agenthub.status value="unknown" label="Квота не обновляется">Хаб не смог узнать квоту — причина в первой строке</agenthub.status>
// <agenthub.status value="unknown" lang="en" label="Quota not updating">The hub couldn't get the quota — the reason is in the first line</agenthub.status>
// <agenthub.platforms>macos,windows</agenthub.platforms>
// <agenthub.fsRead>$AGENTHUB_USAGE_FILE — кэш квоты хаба (служба usage): проценты и время сброса, без токенов</agenthub.fsRead>
// <agenthub.fsRead lang="en">$AGENTHUB_USAGE_FILE — the hub's quota cache (usage service): percentages and reset times, no tokens</agenthub.fsRead>
// <agenthub.watch>$AGENTHUB_USAGE_FILE — служба usage записала свежую квоту: показать её сразу</agenthub.watch>
// <agenthub.watch lang="en">$AGENTHUB_USAGE_FILE — the usage service wrote fresh quota: show it right away</agenthub.watch>
// <agenthub.contract>2</agenthub.contract>
// <agenthub.icon symbol="gauge.with.dots.needle.50percent" color="#0A84FF"></agenthub.icon>
// <agenthub.push key="week-80" cooldown="7d" kind="problems">Неделя ≥ 80%</agenthub.push>
// <agenthub.push key="week-80" lang="en">Week ≥ 80%</agenthub.push>
// <agenthub.push key="pace-85" cooldown="7d" kind="problems">При таком темпе 85% наступит раньше сброса</agenthub.push>
// <agenthub.push key="pace-85" lang="en">At this pace you'll hit 85% before reset</agenthub.push>
// <agenthub.push key="token-lost" kind="problems">Не обновляется: нужен вход в Claude</agenthub.push>
// <agenthub.push key="token-lost" lang="en">Not updating: sign in to Claude</agenthub.push>
//
// Doesn't touch the network: every 3 min the core's usage service (daemon/lib/services/usage.mjs) fetches the quota and puts the rows into
// <home>/Cache/usage.json; the path is in AGENTHUB_USAGE_FILE (the core gives it only to built-in and official plugins).
// Runs right after every cache write (<agenthub.watch> on $AGENTHUB_USAGE_FILE — the core substitutes the path);
// the interval in the file name (5m) is a fallback: in case the watch lost an event or there's no cache yet.
// No variable — the service is off (services.usage.enabled = false) or the daemon is old. Cache older than an hour —
// status=unknown without an event, the reason (the service's error code) and the data age briefly in the header; for "running low" /
// "exhausted" on old numbers — appended to the same header, no pace forecast on old numbers. Unknown shape → status=unknown + event=source-broken.
// Events: week-80 (week ≥ 80%), pace-85 (at the current pace 85% will be reached before the reset), token-lost.
//
// For tests: AGENTHUB_TEST_NOW.

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const SESSION_WINDOW = 5 * HOUR;
const MAX_AGE_MS = HOUR;
const WEEK_WARN = 80;
const PACE_WARN = 85;

export function clean(text, max = 120) {
  let s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\|/g, "¦").replace(/\s+/g, " ").trim();
  s = s.replace(/^[-~]+/, "").trim();
  if ([...s].length > max) s = [...s].slice(0, max - 1).join("") + "…";
  return s;
}

const pad2 = (n) => String(n).padStart(2, "0");
// Language — AGENTHUB_LANG (ru | en) from the core; without the variable — ru.
export function envLang() {
  return process.env.AGENTHUB_LANG === "en" ? "en" : "ru";
}
// The popover tile caption: "Claude Code Quota" does not fit the tile (~110 pt, one line)
const TILE_LABEL = () => (envLang() === "en" ? "Quota" : "Квота");
const WD = { ru: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtWhen(ms, nowMs, lang = "ru") {
  const d = new Date(ms);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (ms - nowMs < DAY && new Date(nowMs).getDate() === d.getDate()) return hm;
  if (lang === "en") return `${WD.en[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}, ${hm}`;
  return `${WD.ru[d.getDay()]} ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${hm}`;
}
const pct = (v) => `${Math.round(v)}%`;

export const T = {
  ru: {
    week: "Неделя",
    h5: "5-часовое окно",
    gaugeLabel: "недели",
    used: (p) => `${p} использовано`,
    // the header is always the current state: the week's percent and the reset; the forecast "by the reset it'll be ≈…" — only as an event line in the body
    headNow: (w, r) => `Неделя ${w}${r ? ` · сброс ${r}` : ""}`,
    headBlock: (r) => (r ? `Лимит исчерпан до ${r}` : "Лимит исчерпан"),
    headOff: "Квота недоступна: служба квоты хаба выключена или демон не перезапущен",
    offHint: "Служба квоты — services.usage.enabled в config.json демона (не в «Настройках»); после обновления плагинов перезапустите демон",
    tail: (why, when) => ` · не обновляется${why ? `: ${why}` : ""}${when ? ` · данные ${when}` : ""}`,
    headWaiting: "Квота ещё не загружена — хаб спросит её через пару секунд",
    headNone: "Данных о квоте пока нет",
    headBroken: "Не получается прочитать кэш квоты хаба",
    headStale: (why, when) => `Квота не обновляется${why ? `: ${why}` : ""}${when ? ` · данные ${when}` : ""}`,
    why: {
      "no-token": "нет входа в Claude Code — войдите заново",
      "token-expired": "токен Claude Code истёк — обновится, когда откроете сессию Claude",
      "http-401": "Claude Code не пускает к квоте — войдите заново",
      "http-403": "нет доступа к квоте",
      "http-429": "Anthropic просит подождать",
      network: "нет связи с Anthropic",
      timeout: "Anthropic не ответил вовремя",
      "bad-response": "незнакомый ответ Anthropic",
      "no-endpoint": "адрес квоты не задан",
      "keychain-unavailable": "нет доступа к связке ключей — повторю позже",
    },
    whyOther: (code) => `ошибка ${code}`,
    week80: (n) => `Неделя ≥ ${n}%`,
    paceHit: (n, hit, reset) => `При таком темпе ${n}% наступит ${hit} — раньше сброса (${reset})`,
    reset: (r) => `сброс ${r}`,
    wasReset: (l, r) => `${l}: сброшено ${r}, свежих данных пока нет`,
    pace: (f) => `Если тратить так же, к сбросу будет ≈${f}`,
    passedWeek: (p) => `Прошло ${p} недели`,
    passedH5: (p) => `Прошло ${p} окна 5 часов`,
    ago: (m) => (m < 1 ? "только что" : m < 60 ? `${m} мин назад` : `${Math.round(m / 60)} ч назад`),
    pluginError: "Сбой плагина квоты",
    problem: {
      "not-object": "usage.json: не объект",
      "rows-not-array": "usage.json: rows не массив",
      "fetched-not-number": "usage.json: fetched_at не число",
      "no-rows": "usage.json: нет rows",
      "bad-row": "usage.json: строка без kind/percent",
      unparsed: "usage.json не разобран",
    },
  },
  en: {
    week: "Week",
    h5: "5-hour window",
    gaugeLabel: "of week",
    used: (p) => `${p} used`,
    headNow: (w, r) => `Week ${w}${r ? ` · resets ${r}` : ""}`,
    headBlock: (r) => (r ? `Limit reached until ${r}` : "Limit reached"),
    headOff: "Quota unavailable: the hub's quota service is off or the daemon wasn't restarted",
    offHint: "The quota service is services.usage.enabled in the daemon's config.json (not in Settings); restart the daemon after updating plugins",
    tail: (why, when) => ` · not updating${why ? `: ${why}` : ""}${when ? ` · data from ${when}` : ""}`,
    headWaiting: "Quota not loaded yet — the hub will ask in a few seconds",
    headNone: "No quota data yet",
    headBroken: "Can't read the hub's quota cache",
    headStale: (why, when) => `Quota not updating${why ? `: ${why}` : ""}${when ? ` · data from ${when}` : ""}`,
    why: {
      "no-token": "not signed in to Claude Code — sign in again",
      "token-expired": "the Claude Code token expired — it refreshes when you open a Claude session",
      "http-401": "Claude Code isn't allowed to read quota — sign in again",
      "http-403": "no access to quota",
      "http-429": "Anthropic asks to wait",
      network: "can't reach Anthropic",
      timeout: "Anthropic didn't answer in time",
      "bad-response": "unexpected answer from Anthropic",
      "no-endpoint": "no quota address set",
      "keychain-unavailable": "can't read the keychain — will retry",
    },
    whyOther: (code) => `error ${code}`,
    week80: (n) => `Week ≥ ${n}%`,
    paceHit: (n, hit, reset) => `At this pace you'll hit ${n}% at ${hit} — before reset (${reset})`,
    reset: (r) => `resets ${r}`,
    wasReset: (l, r) => `${l}: reset at ${r}, no fresh data yet`,
    pace: (f) => `At this pace: ≈${f} by reset`,
    passedWeek: (p) => `${p} of the week has passed`,
    passedH5: (p) => `${p} of the 5-hour window has passed`,
    ago: (m) => (m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`),
    pluginError: "Quota plugin failure",
    problem: {
      "not-object": "usage.json: not an object",
      "rows-not-array": "usage.json: rows is not an array",
      "fetched-not-number": "usage.json: fetched_at is not a number",
      "no-rows": "usage.json: no rows",
      "bad-row": "usage.json: a row without kind/percent",
      unparsed: "usage.json couldn't be parsed",
    },
  },
};

const ERROR_RE = /^[a-z0-9-]{1,40}$/;

// Hub cache (usage service) → { ok, fetchedMs, checkedMs, error, rows:[{kind, label, group, percent, resetsMs, windowMs}] }
// | { ok:false, problem }. error — the service's code (no-token, http-429, …) or null; problem — a corruption code (text in the hub
// language — T[lang].problem).
export function parseUsage(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, problem: "not-object" };
  if (j.rows !== undefined && !Array.isArray(j.rows)) return { ok: false, problem: "rows-not-array" };
  if (j.fetched_at !== undefined && j.fetched_at !== null && typeof j.fetched_at !== "number") return { ok: false, problem: "fetched-not-number" };
  if (j.rows === undefined && typeof j.error !== "string") return { ok: false, problem: "no-rows" };
  const rows = [];
  for (const r of j.rows || []) {
    if (!r || typeof r !== "object" || typeof r.kind !== "string" || typeof r.percent !== "number") {
      return { ok: false, problem: "bad-row" };
    }
    const resetsMs = typeof r.resets_at === "string" ? Date.parse(r.resets_at) : NaN;
    const group = typeof r.group === "string" ? r.group : null;
    const model = typeof r.scope?.model?.display_name === "string" ? clean(r.scope.model.display_name, 30) : null;
    const own = typeof r.label === "string" ? clean(r.label, 30) : null;
    const isSession = r.kind === "session" || group === "session";
    const isWeek = group === "weekly" || r.kind.startsWith("weekly");
    // label is the row's code; render (rowLabel) builds the localized label
    let label;
    if (isSession) label = "@h5";
    else if (r.kind === "weekly_all") label = "@week";
    else if (isWeek) label = `@week · ${model || own || clean(r.kind, 30)}`;
    else label = clean(model || own || r.kind, 30);
    rows.push({
      kind: r.kind,
      label,
      group,
      percent: r.percent,
      resetsMs: Number.isFinite(resetsMs) ? resetsMs : null,
      windowMs: isSession ? SESSION_WINDOW : isWeek ? WEEK : null,
    });
  }
  const error = typeof j.error === "string" && ERROR_RE.test(j.error) ? j.error : typeof j.error === "string" ? "other" : null;
  return {
    ok: true,
    fetchedMs: typeof j.fetched_at === "number" ? j.fetched_at * 1000 : null,
    checkedMs: typeof j.checked_at === "number" ? j.checked_at * 1000 : null,
    error,
    rows,
  };
}

// A linear forecast to the reset and the moment the threshold will be reached. → { forecast, hitMs } | null
export function pace(row, nowMs, threshold = PACE_WARN) {
  if (!row.windowMs || !row.resetsMs) return null;
  const start = row.resetsMs - row.windowMs;
  const elapsed = nowMs - start;
  if (elapsed <= 0 || row.resetsMs <= nowMs) return null;
  // in the first 5% of the window the pace means nothing yet
  if (elapsed < row.windowMs * 0.05) return null;
  const rate = row.percent / elapsed; // % per ms
  const forecast = row.percent + rate * (row.resetsMs - nowMs);
  let hitMs = null;
  if (row.percent >= threshold) hitMs = nowMs;
  else if (rate > 0) hitMs = nowMs + (threshold - row.percent) / rate;
  return { forecast, hitMs: hitMs !== null && hitMs < row.resetsMs ? hitMs : null };
}

// The share of the window that has already passed (0…100), or null.
export function passed(row, nowMs) {
  if (!row?.windowMs || !row.resetsMs || row.resetsMs <= nowMs) return null;
  const elapsed = nowMs - (row.resetsMs - row.windowMs);
  return elapsed <= 0 ? null : Math.min(100, (elapsed / row.windowMs) * 100);
}

const rowLabel = (label, L) => label.replace(/^@week/, L.week).replace(/^@h5/, L.h5);

function whyText(code, L) {
  if (!code) return null;
  return L.why[code] || L.whyOther(code);
}

// The header answers "will the quota last": block → wait → not updating → enough left. tile= — the week's percent.
export function render(u, nowMs, lang = envLang()) {
  const L = T[lang] || T.ru;
  const when = (ms) => fmtWhen(ms, nowMs, lang);
  const out = [];
  if (!u.ok) {
    const head = u.off ? L.headOff : L.headBroken;
    out.push(`${head} | status=unknown tile="—" tileLabel="${TILE_LABEL()}" sfimage=gauge.with.dots.needle.0percent`);
    out.push("---");
    if (u.off) out.push(`${clean(L.offHint, 160)} | sfimage=info.circle color=gray`);
    else out.push(`${clean(L.problem[u.problem] || L.problem.unparsed, 140)} | status=unknown event=source-broken`);
    return out.join("\n") + "\n";
  }
  const age = u.fetchedMs ? nowMs - u.fetchedMs : null;
  const stale = age === null || age > MAX_AGE_MS;
  const tokenLost = u.error === "no-token" || u.error === "http-401";
  // A window whose reset has already passed has been reset: its percent from a stale cache means nothing. Rows like that
  // produce no blocker, no events and no pace (otherwise in the evening a blocker would light up for a 5-hour window reset during the day).
  const live = (r) => !r.resetsMs || r.resetsMs > nowMs;
  const rows = u.rows;
  const liveRows = rows.filter(live);
  const week = liveRows.find((r) => r.kind === "weekly_all") || null;
  // Week event keys carry the reset date: each quota week has its own "≥ 80%"; the rule's cooldown is only debounce.
  const weekTag = week?.resetsMs ? `:${new Date(week.resetsMs).toISOString().slice(0, 10).replace(/-/g, "")}` : "";
  const events = [];
  let status = "ok";
  // Pace only from fresh data: an old percent at the current time understates the forecast
  const wp = week && !stale ? pace(week, nowMs) : null;
  if (week) {
    if (week.percent >= WEEK_WARN) events.push({ key: `week-80${weekTag}`, text: L.week80(WEEK_WARN) });
    if (wp && wp.hitMs !== null && week.percent < PACE_WARN) events.push({ key: `pace-85${weekTag}`, text: L.paceHit(PACE_WARN, when(wp.hitMs), when(week.resetsMs)) });
  }
  if (events.length || tokenLost) status = "wait";
  const full = liveRows.find((r) => r.percent >= 100) || null;
  if (full) status = "block";
  if (stale && status === "ok") status = "unknown";
  const agoText = u.fetchedMs ? L.ago(Math.max(0, Math.round((nowMs - u.fetchedMs) / 60_000))) : null;
  let head;
  if (full) head = L.headBlock(full.resetsMs ? when(full.resetsMs) : null);
  // fresh numbers are always the current state; with old numbers we show the figure only if the week is already high (the week's percent
  // only grows until the reset), with the reason and data age appended; otherwise an honest "not updating" without a figure
  else if (week && (!stale || events.length)) head = L.headNow(pct(week.percent), !stale && week.resetsMs ? when(week.resetsMs) : null);
  if (head) {
    // "Limit exhausted" / the current week on old numbers or without sign-in — with the reason and data age in the same header
    if (stale) head += L.tail(whyText(u.error, L), agoText);
    else if (tokenLost) head += ` · ${whyText(u.error, L)}`;
  } else if (tokenLost) head = L.headStale(whyText(u.error, L), stale ? agoText : null);
  else if (stale && u.error) head = L.headStale(whyText(u.error, L), agoText);
  else if (stale && u.fetchedMs) head = L.headStale(null, agoText);
  else if (stale) head = u.checkedMs ? L.headNone : L.headWaiting;
  else head = L.headNone;
  const tile = week ? pct(week.percent) : "—";
  // gauge= in the header is the ring on the plugin page (the week's share), gaugeLabel is the caption under the number
  const ring = week ? ` gauge=${Math.round(Math.min(100, week.percent))} gaugeLabel="${L.gaugeLabel}"` : "";
  // token-lost — as an event on the header itself: the reason is already in its text, no separate repeating row
  out.push(`${clean(head, 200)} | status=${status} tile="${tile}" tileLabel="${TILE_LABEL()}"${ring}${tokenLost ? " event=token-lost" : ""} sfimage=gauge.with.dots.needle.67percent`);
  out.push("---");
  for (const e of events) out.push(`${clean(e.text, 140)} | status=wait event=${e.key} sfimage=exclamationmark.triangle`);
  // the 5-hour window first (its own "passed"), then the weekly cards; "… of the week passed" as one row below them
  const ordered = [...rows.filter((r) => r.windowMs === SESSION_WINDOW), ...rows.filter((r) => r.windowMs !== SESSION_WINDOW)];
  let weekPassed = null;
  for (const r of ordered) {
    const label = rowLabel(r.label, L);
    const icon = r.windowMs === SESSION_WINDOW ? "clock" : "calendar";
    if (!live(r)) {
      out.push(`${clean(L.wasReset(label, when(r.resetsMs)), 120)} | sfimage=${icon} color=gray`);
      continue;
    }
    // a card with a bar: "Week — 31% used", "reset …" on the right
    const note = r.resetsMs ? ` note="${clean(L.reset(when(r.resetsMs)), 60)}"` : "";
    out.push(`${clean(`${label} — ${L.used(pct(r.percent))}`, 120)} | gauge=${Math.round(Math.min(100, Math.max(0, r.percent)))}${note} sfimage=${icon}${r.percent >= 100 ? " status=block color=red" : r.percent >= WEEK_WARN ? " color=orange" : ""}`);
    const p = stale ? null : pace(r, nowMs);
    if (p) out.push(`--${L.pace(pct(Math.min(p.forecast, 999)))}`);
    const done = passed(r, nowMs);
    if (r.windowMs === SESSION_WINDOW && done !== null) out.push(`--${L.passedH5(pct(done))}`);
    if (r.windowMs === WEEK && weekPassed === null && (r.kind === "weekly_all" || !rows.some((x) => x.kind === "weekly_all" && live(x)))) weekPassed = done;
  }
  if (weekPassed !== null) out.push(`${L.passedWeek(pct(weekPassed))} | sfimage=hourglass color=gray`);
  return out.join("\n") + "\n";
}

// Hub cache: the path is AGENTHUB_USAGE_FILE (the core gives it to built-in and official plugins while the usage service is on).
export function collect({ file = process.env.AGENTHUB_USAGE_FILE, nowMs = Date.now() } = {}) {
  let u;
  if (!file) u = { ok: false, off: true };
  else {
    try {
      u = parseUsage(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      u = e.code === "ENOENT" ? { ok: true, fetchedMs: null, checkedMs: null, error: null, rows: [] } : { ok: false, problem: "unparsed" };
    }
  }
  return render(u, nowMs);
}

function main() {
  const now = process.env.AGENTHUB_TEST_NOW ? Date.parse(process.env.AGENTHUB_TEST_NOW) : Date.now();
  let text;
  try {
    text = collect({ nowMs: now });
  } catch (e) {
    text = `${T[envLang()].pluginError} | status=unknown\n---\n${clean(e?.message || e, 140)} | event=source-broken\n`;
  }
  process.stdout.write(text);
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) main();
