// The spend plugin (plugins/spend/spend.mjs, streamable) on a synthetic HOME.
// Run: env -u NODE_OPTIONS node --test test/plugin-spend.test.mjs
//
// The fixture times are UTC; the local zone is fixed to Asia/Tokyo (UTC+9, no DST) so that 14:30Z and 15:30Z on
// Nov 10 fall on different local days.
process.env.TZ = "Asia/Tokyo";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "../lib/config.mjs";
import { parseOutput } from "../lib/output.mjs";
import { readPluginMeta } from "../lib/meta.mjs";
import { tempHome } from "./helpers.mjs";

const PLUGIN = join(REPO_DIR, "plugins", "spend", "spend.mjs");
const FIX = join(REPO_DIR, "plugins", "spend", "fixtures");
const { SpendIndex, render, costOf, costParts, priceOf, modelKey, normalizeModel, dayKey, fmtUsd, fmtUsdShort, fmtTokens, fmtTokensShort, parseUsageLine, readSettings } = await import(PLUGIN);
const SID = "00000000-0000-4000-8000-0000000000a1";
const PROJ = "-synthetic-demo-project";
const NOW = Date.parse("2026-11-11T03:00:00Z"); // 12:00 in Tokyo, Wed Nov 11
const PRIVATE = "SYNTHETIC-PRIVATE-TEXT";
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

// Lays the fixtures out like Claude Code does; the main session file is the newest (read first).
function makeHome() {
  const home = tempHome("ah-sp-");
  const pdir = join(home, ".claude", "projects", PROJ);
  const wf = join(pdir, SID, "subagents", "workflows", "wf_demo-0001");
  mkdirSync(wf, { recursive: true });
  const main = join(pdir, `${SID}.jsonl`);
  copyFileSync(join(FIX, "session.jsonl"), main);
  copyFileSync(join(FIX, "agent-sub.jsonl"), join(pdir, SID, "subagents", "agent-s1.jsonl"));
  copyFileSync(join(FIX, "agent-wf.jsonl"), join(wf, "agent-w1.jsonl"));
  writeFileSync(join(wf, "journal.jsonl"), '{"type":"started","agentId":"w1"}\n');
  const t = NOW / 1000;
  utimesSync(join(pdir, SID, "subagents", "agent-s1.jsonl"), t - 120, t - 120);
  utimesSync(join(wf, "agent-w1.jsonl"), t - 60, t - 60);
  utimesSync(main, t, t);
  return { home, main, pdir };
}

function indexAll(idx) {
  idx.scan();
  while (idx.indexing) idx.step();
  idx.step(0);
  return idx;
}

const dayCost = (idx, day) => Object.entries(idx.days[day]?.m || {}).reduce((a, [mk, v]) => a + (costOf(mk, v) ?? 0), 0);
const dayVals = (idx, day) => Object.values(idx.days[day]?.m || {}).reduce((a, v) => a.map((x, i) => x + v[i]), [0, 0, 0, 0, 0, 0]);

test("metadata: streamable, no effects, the set-alert and set-range actions and the daily-over rule, bilingual", () => {
  const pm = readPluginMeta(PLUGIN);
  assert.equal(pm.id, "spend");
  assert.equal(pm.meta.type, "streamable");
  assert.deepEqual(pm.meta.effects, []);
  assert.deepEqual(pm.meta.secrets, []);
  assert.equal(pm.meta.contract, 3);
  for (const id of ["set-alert", "set-range"]) assert.equal(pm.meta.actions.find((x) => x.id === id)?.level, "immediate", id);
  assert.ok(!pm.meta.fsRead.some((e) => e.includes("AGENTHUB_CLAUDE_SESSIONS_FILE")), "no session names are read any more");
  assert.ok(pm.meta.push.some((r) => r.key === "daily-over" && r.kind === "plugin"));
  assert.ok(pm.meta.fsRead.every((e) => / — \S/.test(e)), "every read has a why");
  assert.deepEqual(pm.warnings || [], []);
  const src = readFileSync(PLUGIN, "utf8");
  assert.match(src, /<agenthub\.title lang="en">Claude Code Spend<\/agenthub\.title>/);
  assert.match(src, /<agenthub\.icon symbol="dollarsign\.circle"/);
});

test("prices: per family, cache writes 1.25×/2×, fast, Haiku 5.5 long prompts, assumed and unknown models", () => {
  const v = (n, inp, cw5, cw1, cr, out) => [n, inp, cw5, cw1, cr, out];
  near(costOf("claude-opus-5-5", v(1, 1e6, 0, 0, 0, 0)), 4);
  near(costOf("claude-opus-5-5", v(1, 0, 1e6, 0, 0, 0)), 5);
  near(costOf("claude-opus-5-5", v(1, 0, 0, 1e6, 0, 0)), 8);
  near(costOf("claude-opus-5-5", v(1, 0, 0, 0, 1e6, 0)), 0.2);
  near(costOf("claude-opus-5-5", v(1, 0, 0, 0, 0, 1e6)), 20);
  near(costOf("claude-opus-5-5+fast", v(1, 1e6, 0, 0, 0, 1e6)), 48);
  near(costOf("claude-fable-5-1", v(1, 1e6, 0, 0, 1e6, 1e6)), 60.25);
  near(costOf("claude-fable-5", v(1, 0, 0, 0, 1e6, 0)), 1);
  near(costOf("claude-sonnet-5-5", v(1, 1e6, 0, 0, 0, 1e6)), 12);
  near(costOf("claude-haiku-5-5", v(1, 1e6, 0, 0, 0, 1e6)), 0.6);
  near(costOf("claude-haiku-5-5+long", v(1, 1e6, 0, 0, 0, 1e6)), 3);
  near(costOf("claude-haiku-4-5", v(1, 1e6, 0, 0, 0, 1e6)), 6);
  // Opus 4.8 has no listed fast price: 2× the standard one
  near(costOf("claude-opus-4-8+fast", v(1, 1e6, 0, 0, 0, 0)), 10);
  assert.equal(modelKey("claude-haiku-5-5", { prompt: 100_001 }), "claude-haiku-5-5+long");
  assert.equal(modelKey("claude-haiku-5-5", { prompt: 100_000 }), "claude-haiku-5-5");
  assert.equal(modelKey("claude-opus-5-5", { prompt: 900_000, fast: true }), "claude-opus-5-5+fast");
  // ids as platforms write them
  assert.equal(normalizeModel("us.anthropic.claude-opus-4-5-20251101-v1:0"), "claude-opus-4-5");
  assert.equal(normalizeModel("claude-sonnet-4-5@20250929"), "claude-sonnet-4-5");
  assert.equal(normalizeModel("claude-3-5-haiku-20241022"), "claude-haiku-3-5");
  assert.equal(normalizeModel("claude-opus-5-5[1m]"), "claude-opus-5-5");
  // assumed: Fable 5.2 is priced like 5.1; an unlisted point release — the nearest lower one of the family
  assert.deepEqual([priceOf("claude-fable-5-2").as, priceOf("claude-fable-5-2").assumed], ["claude-fable-5-1", true]);
  assert.deepEqual([priceOf("claude-opus-5-7").as, priceOf("claude-opus-5-7").assumed], ["claude-opus-5-5", true]);
  assert.equal(priceOf("claude-sonnet-6").as, "claude-sonnet-5-5");
  assert.equal(priceOf("claude-opus-5-5").assumed, false);
  // an unknown family — no price
  assert.equal(priceOf("claude-zeta-1"), null);
  assert.equal(costOf("claude-zeta-1", v(1, 1e6, 0, 0, 0, 0)), null);
  assert.equal(fmtUsd(1234.5, "en"), "$1,235");
  assert.equal(fmtUsd(2050, "ru"), "$2 050");
  assert.equal(fmtUsd(12.4, "ru"), "$12,40");
  assert.equal(fmtUsd(0.001, "en"), "<$0.01");
  // compact dollars for cards and bar captions; readable token counts, no long raw integers
  assert.deepEqual([4.83, 16.77, 698, 999.6, 3035, 12_345, 2.5e6].map((x) => fmtUsdShort(x, "en")), ["$4.83", "$17", "$698", "$1.0k", "$3.0k", "$12k", "$2.5M"]);
  assert.deepEqual([3035, 12_345].map((x) => fmtUsdShort(x, "ru")), ["$3,0 тыс.", "$12 тыс."]);
  assert.deepEqual([1.75e9, 236.4e6, 5.3e6, 828e3, 14_200, 1700, 424].map((n) => fmtTokens(n, "en")), ["1.75B", "236M", "5.3M", "828K", "14K", "1.7K", "424"]);
  assert.deepEqual([1.75e9, 236.4e6, 828e3].map((n) => fmtTokens(n, "ru")), ["1,75 млрд", "236 млн", "828 тыс."]);
  assert.deepEqual([2.03e9, 990.4e6, 14_200].map((n) => fmtTokensShort(n, "en")), ["2.0B", "990M", "14K"]);
  // the cost split by token type adds up to the cost
  const parts = costParts("claude-opus-5-5", v(1, 1e6, 1e6, 1e6, 1e6, 1e6));
  near(parts.in, 4);
  near(parts.cw, 13);
  near(parts.cr, 0.2);
  near(parts.out, 20);
  near(parts.in + parts.cw + parts.cr + parts.out, costOf("claude-opus-5-5", v(1, 1e6, 1e6, 1e6, 1e6, 1e6)));
  assert.equal(costParts("claude-zeta-1", v(1, 1, 0, 0, 0, 0)), null);
});

test("parseUsageLine: only numbers, model, time and key leave the line", () => {
  const lines = readFileSync(join(FIX, "session.jsonl"), "utf8").trim().split("\n");
  const r = parseUsageLine(lines[1]);
  assert.deepEqual(Object.keys(r).sort(), ["fast", "key", "model", "ms", "vals"]);
  assert.equal(r.key, "r:req_synthetic_A");
  assert.ok(!JSON.stringify(r).includes(PRIVATE));
  assert.equal(parseUsageLine(lines[0]), null, "user line");
  assert.equal(parseUsageLine(lines[3]), null, "tool result mentioning usage");
  assert.equal(parseUsageLine(lines[6]), null, "<synthetic> model");
  assert.equal(parseUsageLine("{broken"), null);
});

test("indexing: dedupe (max per field, a copy in another file), cache tokens, daily buckets across local midnight", () => {
  const { home } = makeHome();
  try {
    const idx = indexAll(new SpendIndex({ home, now: () => NOW }));
    // Nov 10 (local): request A once, output 400 (the larger of the two lines), not again from the subagent copy
    assert.deepEqual(dayVals(idx, "2026-11-10"), [1, 100, 1000, 0, 50000, 400]);
    near(dayCost(idx, "2026-11-10"), (100 * 4 + 1000 * 4 * 1.25 + 50000 * 0.2 + 400 * 20) / 1e6);
    // 15:30Z on Nov 10 is 00:30 on Nov 11 in Tokyo: request B is today's
    assert.equal(dayKey(Date.parse("2026-11-10T15:30:00Z")), "2026-11-11");
    const today = idx.days["2026-11-11"];
    assert.deepEqual(today.m["claude-opus-5-5"], [1, 200, 1000, 2000, 80000, 500]);
    assert.deepEqual(today.m["claude-opus-5-5+fast"], [1, 50, 0, 0, 0, 50]);
    assert.deepEqual(today.m["claude-haiku-5-5+long"], [1, 150000, 0, 0, 0, 1000]);
    assert.deepEqual(today.m["claude-fable-5-2"], [1, 1000, 0, 0, 0, 1000]);
    assert.deepEqual(today.m["claude-zeta-1"], [1, 500, 0, 0, 0, 500]);
    assert.equal(Object.keys(today.m).length, 5, "the <synthetic> notice is not a request");
    const expected = (200 * 4 + 1000 * 5 + 2000 * 8 + 80000 * 0.2 + 500 * 20 + 50 * 8 + 50 * 40 + 150000 * 0.5 + 1000 * 2.5 + 1000 * 10 + 1000 * 50) / 1e6;
    near(dayCost(idx, "2026-11-11"), expected);
    // kinds: the Workflow agent and the subagent; no per-session or per-hour buckets
    assert.deepEqual(Object.keys(today.k.wf).sort(), ["claude-fable-5-2", "claude-zeta-1"]);
    assert.deepEqual(Object.keys(today.k.sub), ["claude-haiku-5-5+long"]);
    assert.deepEqual(Object.keys(today).sort(), ["k", "m"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("incremental: an appended line is read alone; an unfinished line waits; a restart from the index adds nothing twice", () => {
  const { home, main } = makeHome();
  const cachePath = join(home, "data", "index.json");
  try {
    const idx = indexAll(new SpendIndex({ home, cachePath, now: () => NOW }));
    idx.save();
    const before = dayVals(idx, "2026-11-11");
    assert.equal(idx.scan(), 0, "nothing changed — no file to read");
    const extra = JSON.stringify({ type: "assistant", requestId: "req_synthetic_G", sessionId: SID, cwd: "/synthetic/demo-project", timestamp: "2026-11-11T02:30:00.000Z", message: { model: "claude-opus-5-5", id: "msg_G", content: [{ type: "text", text: PRIVATE }], usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 } } });
    appendFileSync(main, extra.slice(0, 40)); // an unfinished line
    assert.equal(idx.scan(), 1);
    assert.equal(idx.progress.totalBytes, 40, "only the appended bytes");
    indexAll(idx);
    assert.deepEqual(dayVals(idx, "2026-11-11"), before, "the unfinished line isn't counted");
    appendFileSync(main, extra.slice(40) + "\n");
    idx.scan();
    assert.equal(idx.progress.totalBytes, extra.length + 1);
    indexAll(idx);
    const after = dayVals(idx, "2026-11-11");
    assert.deepEqual(after, before.map((x, i) => x + [1, 7, 0, 0, 0, 3][i]));
    idx.save();
    // a new process: the same numbers from the index, the same line appended again is a duplicate
    const idx2 = new SpendIndex({ home, cachePath, now: () => NOW });
    idx2.load();
    assert.equal(idx2.scan(), 0);
    assert.deepEqual(dayVals(idx2, "2026-11-11"), after);
    appendFileSync(main, extra + "\n");
    indexAll(idx2);
    assert.deepEqual(dayVals(idx2, "2026-11-11"), after, "deduplicated by the stored key");
    // a replaced file (new inode) is read from the start; its requests are already known
    const text = readFileSync(main);
    rmSync(main);
    writeFileSync(main, text);
    assert.equal(idx2.scan(), 1);
    indexAll(idx2);
    assert.deepEqual(dayVals(idx2, "2026-11-11"), after);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("horizon: files older than the month start and 30 days aren't opened; old days are pruned", () => {
  const { home, main } = makeHome();
  try {
    const old = Date.parse("2026-09-01T00:00:00Z") / 1000;
    utimesSync(main, old, old);
    const idx = new SpendIndex({ home, now: () => NOW });
    idx.days["2026-09-15"] = { m: { "claude-opus-5-5": [1, 1, 0, 0, 0, 1] }, k: {} };
    idx.days["2026-10-13"] = { m: { "claude-opus-5-5": [1, 1, 0, 0, 0, 1] }, k: {} };
    idx.scan();
    assert.equal(idx.days["2026-09-15"], undefined);
    assert.ok(idx.days["2026-10-13"], "29 days back is kept for the 30-day chart");
    assert.ok(!idx.pending.some((f) => f.rel.endsWith(`${SID}.jsonl`)), "the old main file is skipped");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Visible texts of a parsed frame: titles and every param a hub shows as text.
const SHOWN = ["note", "stat", "tile", "tooltip", "badge", "cells", "columns", "valueLabels", "labels", "tips", "avgLabel", "sparkNote", "sparkLabel"];
const shownTexts = (parsed) => [...parsed.header, ...parsed.body].flatMap((it) => [it.title, ...SHOWN.map((k) => it.params[k]).filter(Boolean)]);
const tipsOf = (it) => it.params.tips.split("¦").map((t) => t.replace(/\\n/g, "\n"));

test("page: hero with spark, three cards, by-day and token charts, token types, where it goes, models; no message text anywhere", () => {
  const { home } = makeHome();
  const cachePath = join(home, "data", "index.json");
  try {
    const idx = indexAll(new SpendIndex({ home, cachePath, now: () => NOW }));
    idx.save();
    for (const lang of ["en", "ru"]) {
      const en = lang === "en";
      const text = render(idx, { lang });
      const parsed = parseOutput(text);
      assert.deepEqual(parsed.warnings, [], lang);
      assert.ok(!text.includes(PRIVATE), `${lang}: no message text`);
      // the header: the headline for the menu bar, the hero params for the page
      const head = parsed.header[0];
      assert.match(head.title, en ? /^Today \$0\.19 · / : /^Сегодня \$0,19 · /);
      assert.equal(head.params.tile, en ? "$0.19" : "$0,19");
      assert.equal(head.params.stat, en ? "Today, by 12:00" : "Сегодня, к 12:00");
      assert.match(head.params.note, en ? /^[\d.]+K tokens · 5 requests$/ : /^[\d,]+ тыс\. токенов · 5 запросов$/);
      assert.equal(head.params.spark.split(",").length, 14);
      assert.equal(head.params.sparkLabel, en ? "14 days" : "14 дней");
      assert.match(parsed.header[1].title, en ? /^yesterday for the whole day — \$0\.\d\d$/ : /^вчера за весь день — \$0,\d\d$/);
      assert.match(text, en ? /not a bill/ : /не счёт/);
      // three cards: yesterday, 7 days, the month
      const cards = parsed.body.filter((it) => it.params.stat);
      assert.deepEqual(cards.map((c) => c.params.stat), en ? ["Yesterday", "7 days", "November"] : ["Вчера", "7 дней", "Ноябрь"]);
      assert.equal(cards[2].params.note, en ? "for 11 days" : "за 11 дней");
      // by day: 14 bars, today highlighted, a tooltip per day with real line breaks after the hub's split
      const byDay = parsed.body.find((it) => it.params.chart === "bars" && !it.params.stack);
      assert.equal(byDay.title, en ? "By day" : "По дням");
      assert.equal(byDay.params.values.split(",").length, 14);
      assert.equal(byDay.params.labels.split("¦").length, 14);
      assert.equal(byDay.params.labels.split("¦").at(-1), "11");
      assert.equal(byDay.params.highlight, "last");
      assert.equal(byDay.params.valueLabels.split("¦").at(-1), en ? "$0.19" : "$0,19");
      const tips = tipsOf(byDay);
      assert.equal(tips.length, 14);
      assert.match(tips.at(-1), en ? /^Wed Nov 11, by 12:00\n\$0\.19 · \S+ tokens\n5 requests\n\+ tokens of models without a price$/ : /^ср 11 ноя, к 12:00\n\$0,19 · .+ токенов\n5 запросов\n\+ токены моделей без цены$/);
      assert.match(tips[0], en ? /^Thu Oct 29\nno requests$/ : /^чт 29 окт\nзапросов не было$/);
      // the 14 / 30 segment under the chart
      const i = parsed.body.indexOf(byDay);
      assert.deepEqual([parsed.body[i + 1].params.segment, parsed.body[i + 2].params.selected, parsed.body[i + 3].action], ["true", "true", "set-range"]);
      // tokens by day: three stacked series, a token table with the share of the cost, a note
      const tokens = parsed.body.find((it) => it.params.stack);
      assert.equal(tokens.params.stack, en ? "Cache read,Cache write,Output" : "Чтение кэша,Запись в кэш,Ответы модели");
      assert.deepEqual(tokens.params.series.split(";").map((x) => x.split(",").length), [14, 14, 14]);
      assert.equal(tokens.params.colors.split(",").length, 3);
      assert.match(tipsOf(tokens).at(-1), en ? /^Wed Nov 11, by 12:00 — .+\nCache read .+\nCache write .+\nOutput .+\nNew input .+\nAt API prices: \$0\.19\+$/ : /^ср 11 ноя, к 12:00 — .+\nЧтение кэша .+\nЗапись в кэш .+\nОтветы модели .+\nНовый вход .+\nПо ценам API: \$0,19\+$/);
      const table = parsed.body.find((it) => it.params.table === "true" && it.params.barColumn === "4");
      assert.equal(table.level, 1);
      const types = parsed.body.slice(parsed.body.indexOf(table) + 1, parsed.body.indexOf(table) + 5);
      assert.deepEqual(types.map((r) => r.level), [2, 2, 2, 2]);
      assert.ok(types.every((r) => r.params.bar !== undefined && r.params.cells.split("¦").length === 3));
      const shares = types.map((r) => Number(r.params.cells.split("¦")[2].replace(/[<%]/g, "")));
      assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 100) <= 2, `shares add up: ${shares}`);
      // where it goes: background Workflow, the sessions themselves, subagents — values and dollar notes
      const share = parsed.body.find((it) => it.params.chart === "share");
      const kids = parsed.body.slice(parsed.body.indexOf(share) + 1).filter((it, k, a) => k < 3 && it.level === 1);
      assert.equal(kids.length, 3);
      assert.ok(kids.every((k) => Number(k.params.value) > 0 && /^\$/.test(k.params.note)));
      // models: a bar each, the assumed price as a badge, the unknown model without a price
      assert.match(text, /^--Opus 5\.5 \| bar=/m);
      assert.match(text, en ? /^--Fable 5\.2 \| bar=[\d.]+ note="\$0\.\d\d" color=#FF9F0A badge="priced as Fable 5\.1"/m : /^--Fable 5\.2 \| bar=.* badge="цена как у Fable 5\.1"/m);
      assert.match(text, en ? /^--claude-zeta-1 \| bar=0 note="no price"/m : /^--claude-zeta-1 \| bar=0 note="без цены"/m);
      assert.match(text, /claude-fable-5-2 → claude-fable-5-1/);
      assert.match(text, en ? /claude-zeta-1 \(1\.0K\)/ : /claude-zeta-1 \(1,0 тыс\.\)/);
      // what the user removed: today by hour, top sessions; no switch buttons
      assert.ok(!/Today by hour|Сегодня по часам|Top sessions|самые дорогие|session\.focus|strip=/.test(text));
      assert.ok(!/event=/.test(text), "no alert without a threshold");
      // numbers are readable: no raw long integer in any visible text
      for (const t of shownTexts(parsed)) assert.ok(!/\d{5,}/.test(t), `${lang}: a raw long number in "${t}"`);
    }
    // 30 days: 30 bars, no captions above them, the 30 option selected
    const wide = parseOutput(render(idx, { lang: "en", settings: { alertUsd: 0, rangeDays: 30 } }));
    const byDay30 = wide.body.find((it) => it.params.chart === "bars" && !it.params.stack);
    assert.equal(byDay30.params.values.split(",").length, 30);
    assert.equal(byDay30.params.valueLabels, undefined);
    assert.equal(tipsOf(byDay30).length, 30);
    assert.match(render(idx, { lang: "en", settings: { alertUsd: 0, rangeDays: 30 } }), /^----30 days \| selected=true$/m);
    // the index file holds numbers only
    const cache = readFileSync(cachePath, "utf8");
    assert.ok(!cache.includes(PRIVATE));
    assert.ok(!cache.includes("req_synthetic"), "request ids are stored hashed");
    const c = JSON.parse(cache);
    assert.equal(c.v, 2);
    assert.ok(Object.values(c.days).every((x) => Object.keys(x).every((k) => k === "m" || k === "k")), "no per-session or per-hour buckets");
    assert.equal((statSync(cachePath).mode & 0o777).toString(8), "600");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("page numbers: yesterday against the 14-day average, per day, the cost share by token type, sorted shares", () => {
  const idx = new SpendIndex({ home: "/nonexistent", now: () => NOW });
  idx.scan();
  idx.step(0);
  const day = (back) => dayKey(NOW - back * 86_400_000);
  // 12 days at $10 (1M output on Opus 5.5 is $20, so 0.5M), yesterday $30, today $4 (1M input)
  for (let b = 2; b <= 13; b++) idx.addBuckets(day(b), "claude-opus-5-5", "main", [1, 0, 0, 0, 0, 500_000]);
  idx.addBuckets(day(1), "claude-opus-5-5", "main", [3, 0, 0, 0, 0, 1_500_000]);
  idx.addBuckets(day(0), "claude-opus-5-5", "wf", [1, 1_000_000, 0, 0, 0, 0]);
  idx.addBuckets(day(0), "claude-opus-5-5", "sub", [1, 0, 0, 0, 1_000_000, 0]);
  for (const lang of ["en", "ru"]) {
    const p = parseOutput(render(idx, { lang }));
    assert.deepEqual(p.warnings, []);
    const [y, w] = p.body.filter((it) => it.params.stat);
    // the average of the 13 complete days: (12 × 10 + 30) / 13 ≈ 11.5 → yesterday is 2.6×
    assert.equal(y.title, "$30");
    assert.equal(y.params.note, lang === "en" ? "2.6× the average" : "в 2,6 раза выше среднего");
    assert.equal(y.params.color, "orange");
    assert.equal(w.params.note, lang === "en" ? "$12 a day" : "$12 в день", "7 days: $10 × 5 + $30 + $4.20 = $84.20");
    const byDay = p.body.find((it) => it.params.chart === "bars" && !it.params.stack);
    assert.equal(Number(byDay.params.avg).toFixed(4), (150 / 13).toFixed(4));
    assert.deepEqual(byDay.params.values.split(",").slice(-3), ["10", "30", "4.2"]);
    // 7 days: input $4, output $80 (4M), cache read $0.20 → shares 5%, 95%, <1%
    const table = p.body.find((it) => it.params.barColumn === "4");
    const rows = p.body.slice(p.body.indexOf(table) + 1, p.body.indexOf(table) + 5);
    assert.deepEqual(rows.map((r) => r.params.cells.split("¦")[2]), ["<1%", "0%", "95%", "5%"]);
    assert.equal(Number(rows[2].params.bar).toFixed(2), ((80 / 84.2) * 100).toFixed(2));
    // where it goes: the sessions themselves first ($80), then Workflow ($4), then subagents ($0.20)
    const share = p.body.find((it) => it.params.chart === "share");
    const kids = p.body.slice(p.body.indexOf(share) + 1, p.body.indexOf(share) + 4);
    assert.deepEqual(kids.map((k) => k.params.value), ["80", "4", "0.2"]);
  }
  // a quiet yesterday: its tokens instead of the ratio, no color
  const calm = new SpendIndex({ home: "/nonexistent", now: () => NOW });
  calm.scan();
  calm.step(0);
  for (let b = 1; b <= 13; b++) calm.addBuckets(day(b), "claude-opus-5-5", "main", [1, 0, 0, 0, 0, 500_000]);
  const y = parseOutput(render(calm, { lang: "en" })).body.find((it) => it.params.stat);
  assert.deepEqual([y.params.note, y.params.color], ["500K tokens", undefined]);
});

test("alert: the daily-over event once today's cost reaches the chosen threshold; the select marks it", () => {
  const idx = new SpendIndex({ home: "/nonexistent", now: () => NOW });
  idx.scan();
  idx.addBuckets("2026-11-11", "claude-opus-5-5", "main", [10, 0, 0, 0, 0, 6_000_000]); // $120
  const text = render(idx, { lang: "en", settings: { alertUsd: 100 } });
  assert.match(text, /^Today's spend passed \$100: \$120 at API list prices \| event=daily-over:20261111/m);
  assert.match(text, /^--\$100 \| selected=true$/m);
  assert.match(text, /^--\$25 \| action=set-alert arg=25$/m);
  assert.match(text, /^--Off \| action=set-alert arg=0$/m);
  assert.ok(!/event=/.test(render(idx, { lang: "en", settings: { alertUsd: 200 } })));
  assert.deepEqual(parseOutput(text).warnings, []);
});

test("set-alert and set-range actions: write settings.json keeping the other value; a value outside the list is refused with message= and reason=", () => {
  const dir = tempHome("ah-spa-");
  try {
    const env = { HOME: dir, PATH: "/usr/bin:/bin", AGENTHUB_PLUGIN_DATA_PATH: join(dir, "data"), AGENTHUB_LANG: "en" };
    execFileSync(process.execPath, [PLUGIN, "--action", "set-alert", "50"], { env, cwd: join(REPO_DIR, "plugins", "spend") });
    assert.deepEqual(readSettings(join(dir, "data", "settings.json")), { alertUsd: 50, rangeDays: 14 });
    execFileSync(process.execPath, [PLUGIN, "--action", "set-range", "30"], { env });
    assert.deepEqual(readSettings(join(dir, "data", "settings.json")), { alertUsd: 50, rangeDays: 30 });
    execFileSync(process.execPath, [PLUGIN, "--action", "set-alert", "100"], { env });
    assert.deepEqual(readSettings(join(dir, "data", "settings.json")), { alertUsd: 100, rangeDays: 30 });
    let err;
    try {
      execFileSync(process.execPath, [PLUGIN, "--action", "set-alert", "7"], { env, encoding: "utf8" });
    } catch (e) {
      err = e;
    }
    assert.equal(err.status, 3);
    assert.match(err.stdout, /message=Unknown action or value\nreason=bad-action/);
    err = null;
    try {
      execFileSync(process.execPath, [PLUGIN, "--action", "set-range", "7"], { env, encoding: "utf8" });
    } catch (e) {
      err = e;
    }
    assert.equal(err?.status, 3);
    assert.deepEqual(readSettings(join(dir, "data", "settings.json")), { alertUsd: 100, rangeDays: 30 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no transcripts folder: unknown, nothing to count", () => {
  const idx = new SpendIndex({ home: "/nonexistent-home-for-spend", now: () => NOW });
  idx.scan();
  idx.step(0);
  const head = render(idx, { lang: "en" }).split("\n")[0];
  assert.match(head, /^No Claude Code transcripts — nothing to count \| status=unknown/);
});

test("plugin process: frames via ~~~, the index in PluginData, an appended request after refresh, end of stdin — exit", async () => {
  const { home, main } = makeHome();
  let child = null;
  try {
    const data = join(home, "data");
    child = spawn(process.execPath, [PLUGIN], {
      env: { HOME: home, PATH: "/usr/bin:/bin", TZ: "Asia/Tokyo", AGENTHUB_LANG: "en", AGENTHUB_PAUSED: "0", AGENTHUB_PLUGIN_DATA_PATH: data, AGENTHUB_TEST_NOW: new Date(NOW).toISOString(), AGENTHUB_SPEND_TICK_MS: "60000" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const frames = [];
    let wake = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s) => {
      buf += s;
      let i;
      while ((i = buf.indexOf("\n~~~\n")) >= 0) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 5);
        wake?.();
      }
    });
    const until = (re) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no frame matching ${re}; last: ${frames.at(-1)?.split("\n")[0]}`)), 5000);
        const check = () => {
          const f = frames.find((x) => re.test(x));
          if (f) {
            clearTimeout(t);
            wake = null;
            res(f);
          } else wake = check;
        };
        check();
      });
    const f1 = await until(/^Today \$0\.19 · /);
    assert.deepEqual(parseOutput(f1).warnings, []);
    assert.ok(!f1.includes(PRIVATE));
    assert.match(f1, /chart=bars/);
    for (let i = 0; i < 50 && !existsSync(join(data, "index.json")); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(join(data, "index.json")));
    const extra = JSON.stringify({ type: "assistant", requestId: "req_synthetic_H", sessionId: SID, timestamp: "2026-11-11T02:40:00.000Z", message: { model: "claude-opus-5-5", id: "msg_H", usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1_000_000 } } });
    appendFileSync(main, extra + "\n");
    child.stdin.write(JSON.stringify({ type: "refresh", reason: "Manual" }) + "\n");
    await until(/^Today \$20\.19 · /);
    const exited = new Promise((res) => child.on("exit", (code) => res(code)));
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.ok(!readFileSync(join(data, "index.json"), "utf8").includes(PRIVATE));
  } finally {
    if (child && child.exitCode === null) child.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
