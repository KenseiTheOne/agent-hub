// The quota plugin: parsing the hub quota cache (usage service), pace, "elapsed" as one line, malformed shape → unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOutput } from "../lib/output.mjs";
import { readPluginMeta } from "../lib/meta.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(REPO, "plugins/quota");
const FILE = join(DIR, "quota.5m.mjs");
const FIX = join(DIR, "fixtures");
const Q = await import(FILE);

// fixtures' fetched_at = 1793790000 (2026-11-04 ~11:00Z)
const NOW = "2026-11-04T11:10:00Z";

// usage: fixture name; null: no file; false: no AGENTHUB_USAGE_FILE variable (service disabled)
function runWith(usage, { now = NOW, lang } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ah-quota-"));
  try {
    const file = join(dir, "usage.json");
    if (usage) cpSync(join(FIX, `usage-${usage}.json`), file);
    const env = { HOME: dir, PATH: "/usr/bin:/bin", AGENTHUB_TEST_NOW: now, ...(usage === false ? {} : { AGENTHUB_USAGE_FILE: file }), ...(lang ? { AGENTHUB_LANG: lang } : {}) };
    const text = execFileSync(process.execPath, [FILE], { env, encoding: "utf8" });
    return { text, parsed: parseOutput(text) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("quota: metadata has no statusline dependency and no night budget; the source is the hub cache", () => {
  const { meta } = readPluginMeta(FILE);
  const all = JSON.stringify(meta);
  assert.doesNotMatch(all, /statusline|ноч|night/i);
  // watch only the usage service cache (the core fills in the path); the 5m interval is a fallback
  assert.equal(meta.watch.length, 1);
  assert.match(meta.watch[0], /^\$AGENTHUB_USAGE_FILE — /);
  assert.equal(meta.i18n.en.why["$AGENTHUB_USAGE_FILE"] !== undefined, true);
  assert.equal(readPluginMeta(FILE).interval, "5m");
  assert.equal(meta.fsRead.length, 1);
  assert.match(meta.fsRead[0], /^\$AGENTHUB_USAGE_FILE — /);
  assert.doesNotMatch(readFileSync(FILE, "utf8"), /nightBudget|night_share|runnerDir|statusline/);
});

test("quota: a calm week is ok with no events; 5 h with its own elapsed line, the week elapsed line appears once", () => {
  const { text, parsed } = runWith("normal");
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.events, []);
  assert.deepEqual(parsed.warnings, []);
  assert.match(parsed.header[0].title, /^Неделя 20% · сброс /);
  assert.equal(parsed.header[0].params.tile, "20%");
  assert.match(text, /Неделя · ModelX — 3% использовано \| gauge=3 /);
  assert.match(text, /^Неделя 20%.* gauge=20 gaugeLabel="недели"/);
  assert.match(text, /5-часовое окно — 31% использовано \| gauge=31 .*\n--Если тратить так же.*\n--Прошло \d+% окна 5 часов/);
  assert.equal((text.match(/Прошло \d+% недели/g) || []).length, 1, text);
  assert.match(text, /\nПрошло 33% недели \| sfimage=hourglass color=gray\n$/);
  // the 5-hour window first, weekly cards next to each other
  const gauges = parsed.body.filter((i) => i.params.gauge !== undefined).map((i) => i.title);
  assert.deepEqual(gauges.map((t) => t.split(" — ")[0]), ["5-часовое окно", "Неделя", "Неделя · ModelX"]);
  assert.doesNotMatch(text, /Откуда данные|statusline|[Нн]оч/);
});

test("quota: week ≥ 80% → wait + week-80", () => {
  const { text, parsed } = runWith("hot");
  assert.equal(parsed.status, "wait");
  assert.ok(parsed.events.some((e) => /^week-80:\d{8}$/.test(e)), JSON.stringify(parsed.events));
  assert.doesNotMatch(text, /[Нн]оч/);
});

test("quota: pace reaching 85% before reset → pace-85", () => {
  const { parsed } = runWith("pace");
  assert.equal(parsed.status, "wait");
  assert.equal(parsed.events.length, 1);
  assert.match(parsed.events[0], /^pace-85:\d{8}$/);
});

test("quota: not logged in to Claude Code (no-token) → token-lost, short reason in the header, once", () => {
  const { text, parsed } = runWith("token-lost");
  assert.equal(parsed.status, "wait");
  assert.deepEqual(parsed.events, ["token-lost"]);
  assert.match(parsed.header[0].title, /^Квота не обновляется: нет входа в Claude Code/);
  // the event is on the header; no duplicate line with the same reason
  assert.equal(parsed.header[0].event, "token-lost");
  assert.equal((text.match(/нет входа в Claude Code/g) || []).length, 1, text);
  const en = runWith("token-lost", { lang: "en" });
  assert.match(en.parsed.header[0].title, /^Quota not updating: not signed in to Claude Code/);
});

test("quota: stale data with a service error → unknown, error code in plain words in the header", () => {
  const usage = { version: 1, fetched_at: 1793770000, checked_at: 1793790000, error: "http-429", rows: [{ kind: "weekly_all", group: "weekly", percent: 10, resets_at: "2026-11-09T04:00:00+00:00" }] };
  const u = Q.parseUsage(usage);
  const text = Q.render(u, Date.parse(NOW), "ru");
  const parsed = parseOutput(text);
  assert.equal(parsed.status, "unknown");
  assert.deepEqual(parsed.events, []);
  assert.match(parsed.header[0].title, /^Квота не обновляется: Anthropic просит подождать · данные 6 ч назад$/);
  const net = Q.render(Q.parseUsage({ ...usage, error: "network" }), Date.parse(NOW), "en");
  assert.match(parseOutput(net).header[0].title, /^Quota not updating: can't reach Anthropic · data from 6 h ago$/);
  // fresh data and an error on the last attempt: the header is normal
  const fresh = Q.render(Q.parseUsage({ ...usage, fetched_at: 1793790000 }), Date.parse(NOW), "ru");
  assert.match(parseOutput(fresh).header[0].title, /^Неделя \d+%/);
  // an unknown code gives "error other", no raw text
  const odd = Q.parseUsage({ ...usage, error: "Some Error: with text" });
  assert.equal(odd.error, "other");
});

test("quota: keychain unreadable (keychain-unavailable) → reason in plain words, no token-lost", () => {
  const usage = { version: 1, fetched_at: 1793770000, checked_at: 1793790000, error: "keychain-unavailable", rows: [{ kind: "weekly_all", group: "weekly", percent: 10, resets_at: "2026-11-09T04:00:00+00:00" }] };
  const ru = parseOutput(Q.render(Q.parseUsage(usage), Date.parse(NOW), "ru"));
  assert.match(ru.header[0].title, /^Квота не обновляется: нет доступа к связке ключей — повторю позже · данные 6 ч назад$/);
  assert.deepEqual(ru.events, []);
  const en = parseOutput(Q.render(Q.parseUsage(usage), Date.parse(NOW), "en"));
  assert.match(en.header[0].title, /^Quota not updating: can't read the keychain — will retry · data from 6 h ago$/);
  assert.deepEqual(en.events, []);
});

test("quota: malformed shape → unknown + source-broken; the event row text (and push) is in the hub language", () => {
  const { parsed } = runWith("broken");
  assert.equal(parsed.status, "unknown");
  assert.deepEqual(parsed.events, ["source-broken"]);
  const ru = parsed.body.find((i) => i.event === "source-broken");
  assert.match(ru.title, /^usage\.json: /);
  const en = runWith("broken", { lang: "en" });
  const line = en.parsed.body.find((i) => i.event === "source-broken");
  assert.match(line.title, /^usage\.json: /);
  assert.doesNotMatch(en.text, /[А-Яа-яЁё]/, en.text);
  // every malformation code is translated, unparsable JSON too
  for (const [j, ruText, enText] of [
    [[], "usage.json: не объект", "usage.json: not an object"],
    [{ rows: {} }, "usage.json: rows не массив", "usage.json: rows is not an array"],
    [{ fetched_at: "x", rows: [] }, "usage.json: fetched_at не число", "usage.json: fetched_at is not a number"],
    [{}, "usage.json: нет rows", "usage.json: no rows"],
    [{ rows: [{ kind: "x" }] }, "usage.json: строка без kind/percent", "usage.json: a row without kind/percent"],
  ]) {
    const u = Q.parseUsage(j);
    assert.equal(parseOutput(Q.render(u, Date.now(), "ru")).body.find((i) => i.event === "source-broken").title, ruText);
    assert.equal(parseOutput(Q.render(u, Date.now(), "en")).body.find((i) => i.event === "source-broken").title, enText);
  }
  const dir = mkdtempSync(join(tmpdir(), "ah-quota-"));
  try {
    writeFileSync(join(dir, "usage.json"), "{мусор");
    const text = execFileSync(process.execPath, [FILE], { env: { HOME: dir, PATH: "/usr/bin:/bin", AGENTHUB_USAGE_FILE: join(dir, "usage.json"), AGENTHUB_LANG: "en" }, encoding: "utf8" });
    assert.match(text, /^usage\.json couldn't be parsed \| status=unknown event=source-broken$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quota: cache older than an hour → unknown with no event; no cache yet → not loaded yet; no service → disabled", () => {
  const stale = runWith("normal", { now: "2026-11-04T14:00:00Z" });
  assert.equal(stale.parsed.status, "unknown");
  assert.deepEqual(stale.parsed.events, []);
  assert.match(stale.parsed.header[0].title, /^Квота не обновляется · данные 3 ч назад$/);
  const none = runWith(null);
  assert.equal(none.parsed.status, "unknown");
  assert.deepEqual(none.parsed.events, []);
  assert.match(none.parsed.header[0].title, /ещё не загружена/);
  const off = runWith(false);
  assert.equal(off.parsed.status, "unknown");
  assert.deepEqual(off.parsed.events, []);
  // not "in Settings": the switch is in the daemon's config.json, or the daemon is old
  assert.match(off.parsed.header[0].title, /^Квота недоступна: служба квоты хаба выключена или демон не перезапущен$/);
  assert.match(off.text, /services\.usage\.enabled в config\.json демона \(не в «Настройках»\)/);
});

test("quota: stale cache + error at week ≥ 80% / pace / 100%: the header names the age and reason, no pace from old numbers", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  const fetched = (now - 10 * 3_600_000) / 1000;
  const row = (percent) => ({ kind: "weekly_all", group: "weekly", percent, resets_at: "2026-11-09T04:00:00+00:00" });
  const go = (percent, error, lang = "ru") => {
    const text = Q.render(Q.parseUsage({ version: 1, fetched_at: fetched, checked_at: now / 1000, error, rows: [row(percent)] }), now, lang);
    return { text, parsed: parseOutput(text) };
  };
  // 62%: previously "quota running out: ≈130% by reset" from the old percentage; now an honest "not updating"
  const a = go(62, "token-expired");
  assert.equal(a.parsed.status, "unknown", a.text);
  assert.match(a.parsed.header[0].title, /^Квота не обновляется: токен Claude Code истёк.* · данные 10 ч назад$/);
  assert.doesNotMatch(a.text, /≈|При таком темпе|Если тратить так же/);
  assert.deepEqual(a.parsed.events, []);
  // 83%: "running out" stays (the weekly percentage only grows), but with the reason and age
  const b = go(83, "network");
  assert.equal(b.parsed.status, "wait");
  assert.match(b.parsed.header[0].title, /^Неделя 83% · не обновляется: нет связи с Anthropic · данные 10 ч назад$/);
  // 100% with 429
  const c = go(100, "http-429");
  assert.equal(c.parsed.status, "block");
  assert.match(c.parsed.header[0].title, /^Лимит исчерпан до .+ · не обновляется: Anthropic просит подождать · данные 10 ч назад$/);
  const en = go(100, "http-429", "en");
  assert.match(en.parsed.header[0].title, /^Limit reached until .+ · not updating: Anthropic asks to wait · data from 10 h ago$/);
  // fresh cache, not logged in, at 100%: the reason is appended, the event is on the header
  const d = Q.render(Q.parseUsage({ version: 1, fetched_at: now / 1000, error: "http-401", rows: [row(100)] }), now, "ru");
  assert.match(parseOutput(d).header[0].title, /^Лимит исчерпан до .+ · Claude Code не пускает к квоте — войдите заново$/);
  assert.ok(parseOutput(d).events.includes("token-lost"));
  assert.equal(parseOutput(d).header[0].event, "token-lost");
});

test("quota: pure functions: pace, passed, parseUsage", () => {
  const now = Date.parse("2026-11-05T04:00:00Z");
  const row = { percent: 50, resetsMs: Date.parse("2026-11-09T04:00:00Z"), windowMs: 7 * 86_400_000 };
  const p = Q.pace(row, now);
  // 3 of 7 days elapsed: 50% → 50 + 50/3*4 ≈ 116.7
  assert.ok(Math.abs(p.forecast - 116.67) < 0.1);
  assert.ok(p.hitMs > now && p.hitMs < row.resetsMs);
  assert.equal(Q.pace({ ...row, windowMs: null }, now), null);
  assert.ok(Math.abs(Q.passed(row, now) - (300 / 7)) < 0.01);
  assert.equal(Q.passed({ ...row, resetsMs: now - 1 }, now), null);
  assert.equal(Q.parseUsage([]).ok, false);
  assert.equal(Q.parseUsage({ rows: [{ kind: "x" }] }).ok, false);
  assert.equal(Q.parseUsage({ fetched_at: 1, rows: [] }).ok, true);
  assert.equal(Q.parseUsage({ fetched_at: null, error: "no-token", rows: [] }).ok, true);
  assert.equal(Q.nightBudget, undefined, "the night budget belongs in a runner plugin");
});

test("quota: 5 h = 100% with reset at 12:00, stale cache (now 22:00) → not a blocker, window shown as reset", () => {
  const usage = {
    version: 1,
    fetched_at: 1793790000,
    rows: [
      { kind: "session", group: "session", percent: 100, severity: "critical", resets_at: "2026-11-04T12:00:00+00:00" },
      { kind: "weekly_all", group: "weekly", percent: 20, severity: "normal", resets_at: "2026-11-09T04:00:00+00:00" },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), "ah-quota-x-"));
  try {
    const f = join(dir, "u.json");
    writeFileSync(f, JSON.stringify(usage));
    const nowMs = Date.parse("2026-11-04T22:00:00Z");
    const u = Q.parseUsage(JSON.parse(readFileSync(f, "utf8")));
    assert.equal(u.ok, true);
    const text = Q.render(u, nowMs, "ru");
    const parsed = parseOutput(text);
    assert.notEqual(parsed.status, "block", text);
    assert.doesNotMatch(parsed.header[0].title, /5 ч 100%/);
    assert.match(text, /сброшено/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
