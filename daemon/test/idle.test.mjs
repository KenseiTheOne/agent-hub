// The "can it be shut down" verdict: the header keys activity= / needsOn= (output.mjs), the computation (lib/idle.mjs) for each
// source and priority, the idle service (/state.idle and the idle.verdict event).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_MARKS, MAX_PHRASE, MAX_PHRASES, cleanPhrase, parseOutput } from "../lib/output.mjs";
import { STALE_MIN_MS, STREAM_STALE_MS, WARMUP_MS, computeIdle, sessionName, staleAt } from "../lib/idle.mjs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

// ---------- contract: activity= / needsOn= ----------

test("activity= and needsOn= in the header: frame phrases, an empty value means \"checked, quiet\", no key — null", () => {
  const r = parseOutput(['Прогоны | status=ok activity="Прогон идёт с 01:30" needsOn=""', 'Ещё | activity="Исследование до 15:30"', "---", "тело"].join("\n"));
  assert.deepEqual(r.activity, ["Прогон идёт с 01:30", "Исследование до 15:30"]);
  assert.deepEqual(r.needsOn, []);
  assert.equal(r.header[0].activity, "Прогон идёт с 01:30");
  assert.equal(r.header[0].needsOn, "");
  assert.equal(r.header[0].params.activity, undefined, "not duplicated in params");
  const none = parseOutput("Квота | status=ok tile=62%");
  assert.equal(none.activity, null);
  assert.equal(none.needsOn, null);
  assert.deepEqual(r.warnings, []);
});

test("needsOn= with a case-insensitive key; activity= in the body is not understood — a warning", () => {
  const r = parseOutput(['Прогоны | NEEDSON="Прогон в 04:30 — нужен включённый Mac"', "---", 'строка | activity="в теле"'].join("\n"));
  assert.deepEqual(r.needsOn, ["Прогон в 04:30 — нужен включённый Mac"]);
  assert.equal(r.activity, null, "not taken from the body");
  assert.ok(r.warnings.some((w) => /activity= is understood only in the header/.test(w)));
});

test("a phrase is cleaned and cut: control chars, bidi, zero width, line breaks; no longer than MAX_PHRASE", () => {
  assert.equal(cleanPhrase("a‮b​c d\te"), "a b c d e");
  const long = "я".repeat(500);
  const c = cleanPhrase(long);
  assert.equal([...c].length, MAX_PHRASE);
  assert.ok(c.endsWith("…"));
  // repeats and the limit on the number of phrases
  const lines = Array.from({ length: 8 }, (_, i) => `L${i} | activity="${i < 2 ? "одно" : `фраза ${i}`}"`);
  const r = parseOutput(lines.join("\n"));
  assert.equal(r.activity.length, MAX_PHRASES);
  assert.equal(r.activity[0], "одно");
  assert.equal(new Set(r.activity).size, r.activity.length);
});

test("review: a phrase has at most MAX_MARKS combining marks per grapheme, ZWJ between emoji is kept, cutting is by grapheme", () => {
  const zalgo = cleanPhrase("a" + "\u0301".repeat(500));
  assert.equal([...zalgo].length, 1 + MAX_MARKS, "a hundred diacritics over one letter do not pass");
  assert.equal(cleanPhrase("я\u0301 ok"), "я\u0301 ok", "a single diacritic — as is");
  assert.equal(cleanPhrase("Сборка 👨\u200D👩\u200D👧 идёт"), "Сборка 👨\u200D👩\u200D👧 идёт", "the family emoji stays intact");
  assert.equal(cleanPhrase("a\u200Db"), "a b", "ZWJ not between emoji — removed");
  assert.equal(cleanPhrase("1\uFE0F\u20E3 ok"), "1\uFE0F\u20E3 ok", "keycap — two marks, within the limit");
  // cut by grapheme: a family emoji is one grapheme, truncation does not split it
  const fam = "👨\u200D👩\u200D👧";
  const c = cleanPhrase(fam.repeat(200));
  assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(c)].length, MAX_PHRASE);
  assert.ok(c.endsWith(fam + "…"));
});

// ---------- computation: sources ----------

const S = (id, status, name = null) => ({ sessionId: id, status, name, cwd: `/Users/u/Projects/${id}` });

test("silence: nothing is running — quiet; \"checked\" — sessions, participating plugins, updates", () => {
  const v = computeIdle({
    sessions: [S("a", "idle", "alpha-05")],
    cards: [],
    plugins: [
      { id: "agents", title: "Агенты", status: "ok", activity: [], needsOn: null },
      { id: "quota", title: "Квота", status: "ok", activity: null, needsOn: null },
      { id: "hermes", title: "Hermes", status: "ok", activity: [], needsOn: [] },
    ],
    hubInstall: { phase: "idle" },
    pluginsBusy: [],
  });
  assert.equal(v.verdict, "quiet");
  assert.deepEqual(v.items, []);
  assert.deepEqual(v.checked, ["Сессии", "Агенты", "Hermes", "Идущие обновления"], "quota does not report activity — it is not in \"checked\"");
});

test("sessions: working ones — busy with names, \"N more\" after three", () => {
  const v = computeIdle({ sessions: [S("a", "busy", "demo-d9"), S("b", "busy", "alpha-05"), S("c", "busy"), S("d", "busy"), S("e", "busy")] });
  assert.equal(v.verdict, "busy");
  assert.equal(v.items.length, 1);
  assert.deepEqual(v.items[0], { source: "sessions", kind: "busy", text: "5 сессий работают: demo-d9, alpha-05, c, ещё 2", target: "sessions" });
  assert.ok(!v.checked.includes("Сессии"));
});

test("a session waiting for an answer is not a blocker: a summary as the last line, only work decides the verdict; cards and waiting without duplicates", () => {
  const v = computeIdle({
    sessions: [S("a", "busy", "demo-d9"), S("w", "waiting", "alpha-1d"), S("x", "waiting", "alpha-77")],
    cards: [{ sessionId: "x" }, { sessionId: "x" }, { sessionId: "w" }],
  });
  assert.equal(v.verdict, "busy", "too early — because of the working demo-d9, not the waiting ones");
  // a session with a card is not also counted as waiting by status=waiting
  assert.deepEqual(v.items.map((i) => [i.kind, i.text]), [
    ["busy", "1 сессия работает: demo-d9"],
    ["waiting", "2 сессии ждут ответа: alpha-77, alpha-1d — ответить можно и после включения"],
  ]);
  // only waiting ones — "safe to shut down": the question is not lost (sleep does not affect it, after shutdown — claude --resume)
  const one = computeIdle({ sessions: [S("w", "waiting", "alpha-1d")] });
  assert.equal(one.verdict, "quiet");
  assert.deepEqual(one.items, [{ source: "sessions", kind: "waiting", text: "1 сессия ждёт ответа: alpha-1d — ответить можно и после включения", target: "sessions" }]);
  assert.ok(!one.checked.includes("Сессии"), "there is already a line about sessions — not duplicated in \"checked\"");
  assert.ok(!/пропад|рано/.test(one.items[0].text));
  // only a PermissionRequest card (the session in the registry is waiting: the dialog is open, the hook runs in parallel) — also quiet
  const card = computeIdle({ sessions: [S("x", "waiting", "alpha-77")], cards: [{ sessionId: "x" }] });
  assert.equal(card.verdict, "quiet");
  assert.deepEqual(card.items.map((i) => i.kind), ["waiting"]);
});

// Review 2026-11-09 (high): a waiting session that shows activity is a blocker, not a summary: shutting down would kill
// its subagents, workers and commands, and claude --resume would not restart them.
test("review: waiting for an answer but working (status=busy with a card, a subagent card, waitingFor \"worker request\") — too early", () => {
  const busyCard = computeIdle({ sessions: [{ sessionId: "wf1", status: "busy", name: "alpha-6a" }], cards: [{ sessionId: "wf1" }] });
  assert.equal(busyCard.verdict, "busy");
  assert.deepEqual(busyCard.items, [{ source: "sessions", kind: "busy", text: "1 сессия работает и ждёт ответа на шаг: alpha-6a", target: "sessions" }]);
  assert.ok(!busyCard.checked.includes("Сессии"));
  // a subagent card: the session in the registry is waiting (dialog), but parallel subagents are running
  const sub = computeIdle({ sessions: [S("s", "waiting", "demo-d9")], cards: [{ sessionId: "s", subagent: false }, { sessionId: "s", subagent: true }] });
  assert.equal(sub.verdict, "busy");
  assert.deepEqual(sub.items.map((i) => [i.kind, i.text]), [["busy", "1 сессия работает и ждёт ответа на шаг: demo-d9"]]);
  // a subagent card from a session not in the registry — also work
  assert.equal(computeIdle({ cards: [{ sessionId: "12345678-aaaa", subagent: true }] }).verdict, "busy");
  // waitingFor "worker request" — a worker is waiting, not the main thread
  const worker = computeIdle({ sessions: [{ ...S("k", "waiting", "alpha-1d"), waitingFor: "worker request" }] });
  assert.equal(worker.verdict, "busy");
  assert.equal(worker.items[0].text, "1 сессия работает и ждёт ответа на шаг: alpha-1d");
  // an ordinary waiting one (permission prompt, question) next to them — still a summary at the end
  const mix = computeIdle({ sessions: [{ ...S("k", "waiting", "a"), waitingFor: "worker request" }, { ...S("p", "waiting", "b"), waitingFor: "permission prompt" }, S("c", "busy", "c")], cards: [{ sessionId: "p" }] });
  assert.deepEqual(mix.items.map((i) => [i.kind, i.text]), [
    ["busy", "1 сессия работает: c"],
    ["busy", "1 сессия работает и ждёт ответа на шаг: a"],
    ["waiting", "1 сессия ждёт ответа: b — ответить можно и после включения"],
  ]);
  assert.equal(computeIdle({ lang: "en", sessions: [S("x", "busy", "a"), S("y", "busy", "b")], cards: [{ sessionId: "x" }, { sessionId: "y" }] }).items[0].text, "2 sessions are working with a step waiting for a reply: a, b");
});

test("a card of a session not in the registry — by the start of the id", () => {
  const v = computeIdle({ sessions: [], cards: [{ sessionId: "12345678-aaaa" }] });
  assert.match(v.items[0].text, /12345678/);
});

test("plugins: activity — busy, needsOn — needs-on; a failed plugin does not go into \"checked\", but does get a \"failure\" line", () => {
  const v = computeIdle({
    plugins: [
      { id: "agents", title: "Агенты", status: "ok", trusted: true, activity: ["Прогон «m81-gold» идёт, 12 мин"], needsOn: null },
      { id: "my-runner", title: "Прогоны", status: "ok", trusted: true, activity: [], needsOn: ["Прогон в 04:30 — нужен включённый Mac"] },
      { id: "broken", title: "Сломанный", status: "error", activity: [], needsOn: null },
    ],
  });
  assert.equal(v.verdict, "busy");
  assert.deepEqual(v.items.map((i) => [i.kind, i.source, i.target]), [
    ["busy", "plugin:agents", "plugin:agents"],
    ["unknown", "plugin:broken", "plugin:broken"],
    ["needs-on", "plugin:my-runner", "plugin:my-runner"],
  ]);
  assert.equal(v.items[1].text, "Сломанный: сбой — не знаю, тихо ли у него");
  assert.deepEqual([v.items[0].plugin, v.items[0].trusted, v.items[2].trusted], ["Агенты", true, true]);
  assert.ok(!v.checked.includes("Сломанный"));
  assert.ok(!v.checked.includes("Прогоны"));
});

test("only needsOn — quiet-needs-on", () => {
  const v = computeIdle({ sessions: [S("a", "idle")], plugins: [{ id: "my-runner", title: "Прогоны", status: "ok", trusted: true, activity: [], needsOn: ["Прогон в 04:30 — нужен включённый Mac"] }] });
  assert.equal(v.verdict, "quiet-needs-on");
  assert.deepEqual(v.items, [{ source: "plugin:my-runner", target: "plugin:my-runner", plugin: "Прогоны", trusted: true, kind: "needs-on", text: "Прогон в 04:30 — нужен включённый Mac" }]);
  assert.deepEqual(v.checked, ["Сессии"]);
});

test("hub update: building / switching / trial / rolling-back are work; ready, idle, failed are not", () => {
  for (const [phase, op, text] of [
    ["building", "install", "Собирается обновление хаба 0.3.0"],
    ["switching", "install", "Ставится обновление хаба 0.3.0"],
    ["trial", "install", "Ставится обновление хаба 0.3.0"],
    ["switching", "rollback", "Хаб переключается на 0.3.0"],
    ["rolling-back", "install", "Хаб возвращается на прежнюю версию"],
  ]) {
    const v = computeIdle({ hubInstall: { phase, op, label: "0.3.0" } });
    assert.equal(v.verdict, "busy", phase);
    assert.deepEqual(v.items, [{ source: "hub-update", kind: "busy", text, target: "settings" }], phase);
    assert.ok(!v.checked.includes("Идущие обновления"));
  }
  for (const phase of ["ready", "idle", "failed", "done", "rolled-back"]) {
    const v = computeIdle({ hubInstall: { phase, op: "install", label: "0.3.0" } });
    assert.equal(v.verdict, "quiet", phase);
    assert.ok(v.checked.includes("Идущие обновления"), phase);
  }
  // no service — "updates" are not checked
  assert.ok(!computeIdle({}).checked.includes("Идущие обновления"));
});

test("installing and updating plugins is work", () => {
  const v = computeIdle({
    pluginsBusy: [
      { id: "my-runner", op: "update", title: "Прогоны", version: "0.5.1" },
      { id: "hermes", op: "install", title: "Hermes", version: null },
    ],
  });
  assert.equal(v.verdict, "busy");
  assert.deepEqual(v.items.map((i) => i.text), ["Обновляется плагин: Прогоны 0.5.1", "Ставится плагин: Hermes"]);
  assert.ok(v.items.every((i) => i.target === "manager"));
});

test("a plugin action that is still running is work", () => {
  const v = computeIdle({ plugins: [{ id: "my-runner", title: "Прогоны", status: "ok", activity: null, needsOn: null }], actions: [{ plugin: "my-runner", title: "Остановить прогоны" }] });
  assert.equal(v.verdict, "busy");
  assert.deepEqual(v.items, [{ source: "plugin:my-runner", kind: "busy", text: "Прогоны: выполняется «Остановить прогоны»", target: "plugin:my-runner", plugin: "Прогоны" }]);
});

test("priorities: work > \"don't know\" and computer needed; waiting ones are a summary at the end and do not change the verdict", () => {
  const v = computeIdle({
    sessions: [S("w", "waiting", "alpha-1d"), S("b", "busy", "demo-d9")],
    plugins: [
      { id: "my-runner", title: "Прогоны", status: "ok", activity: [], needsOn: ["Прогон в 04:30 — нужен включённый Mac"] },
      { id: "hermes", title: "Hermes", status: "ok", activity: ["Hermes: 1 задача в работе"], needsOn: null },
    ],
    hubInstall: { phase: "building", op: "install", label: "0.3.0" },
  });
  assert.equal(v.verdict, "busy");
  assert.deepEqual(v.items.map((i) => i.kind), ["busy", "busy", "busy", "needs-on", "waiting"]);
  // needsOn and waiting ones — "yes, but" (like needsOn without them); needsOn and nothing else — the same
  const nw = computeIdle({ sessions: [S("w", "waiting")], plugins: [{ id: "n", title: "N", activity: null, needsOn: ["x"] }] });
  assert.equal(nw.verdict, "quiet-needs-on");
  assert.deepEqual(nw.items.map((i) => i.kind), ["needs-on", "waiting"]);
  assert.equal(computeIdle({ plugins: [{ id: "n", title: "N", activity: [], needsOn: ["x"] }] }).verdict, "quiet-needs-on");
  // "don't know about sessions" and waiting ones (a hook card exists, the sessions plugin is silent) — "yes, but not everything is known", not "too early"
  const unk = computeIdle({ cards: [{ sessionId: "12345678-aaaa" }], plugins: [{ id: "claude-sessions", title: "Сессии", status: "ok", activity: null, needsOn: null, lastRunAt: null }] });
  assert.equal(unk.verdict, "quiet-needs-on");
  assert.deepEqual(unk.items.map((i) => i.kind), ["unknown", "waiting"]);
});

test("English: hub texts in the hub language", () => {
  const v = computeIdle({ lang: "en", sessions: [S("w", "waiting", "alpha-1d"), S("a", "busy", "a"), S("b", "busy", "b")], pluginsBusy: [{ id: "x", op: "install", title: "X", version: "1.0.0" }], hubInstall: { phase: "idle" } });
  assert.deepEqual(v.items.map((i) => i.text), ["2 sessions are working: a, b", "Installing plugin: X 1.0.0", "1 session is waiting for a reply: alpha-1d — it can wait until the Mac is back on"]);
  assert.equal(computeIdle({ lang: "en", sessions: [S("w", "waiting", "a"), S("x", "waiting", "b")] }).items[0].text, "2 sessions are waiting for a reply: a, b — they can wait until the Mac is back on");
  assert.deepEqual(computeIdle({ lang: "en" }).checked, ["Sessions"]);
});

// ---------- review: a participant's failure and silence, daemon start, the sessions plugin, untrusted phrases ----------

const T0 = Date.parse("2026-11-07T02:00:00");

test("review: a failed participant does not drop out — \"failure — last: <phrase> (HH:MM)\": work — busy; needsOn — unknown, and the verdict is not \"quiet\"", () => {
  const signalsAt = Date.parse("2026-11-07T01:30:00");
  const busy = computeIdle({ plugins: [{ id: "batch", title: "Прогоны", status: "error", trusted: true, activity: ["Прогон идёт с 01:30"], needsOn: ["Прогон в 04:30 — нужен включённый Mac"], signalsAt }] });
  assert.equal(busy.verdict, "busy");
  assert.deepEqual(busy.items.map((i) => [i.kind, i.text]), [["busy", "Прогоны: сбой — последнее: Прогон идёт с 01:30 (01:30)"]], "a crashed plugin's needsOn does not get a separate line");
  assert.ok(!busy.checked.includes("Прогоны"));
  const needs = computeIdle({ sessions: [], plugins: [{ id: "batch", title: "Прогоны", status: "error", trusted: true, activity: [], needsOn: ["Прогон в 04:30 — нужен включённый Mac"], signalsAt }] });
  assert.equal(needs.verdict, "quiet-needs-on", "not \"safe to shut down — nothing will be lost\"");
  assert.deepEqual(needs.items.map((i) => [i.kind, i.text, i.trusted]), [["unknown", "Прогоны: сбой — последнее: Прогон в 04:30 — нужен включённый Mac (01:30)", false]], "not fit for the card title");
  // English
  const en = computeIdle({ lang: "en", plugins: [{ id: "n", title: "Runs", status: "error", activity: [], needsOn: [] }] });
  assert.equal(en.items[0].text, "Runs: failed — can't tell whether it's quiet");
});

test("review: a plugin went silent — no scheduled frame for longer than 3 intervals (at least 2 min), streamable with phrases — longer than 5 min; nextAt is the deadline", () => {
  const p = { id: "batch", title: "Прогоны", status: "ok", trusted: true, type: "standard", intervalMs: 30_000, activity: ["Прогон идёт с 01:30"], needsOn: [], signalsAt: T0 - 10 * 60_000 };
  assert.equal(staleAt({ ...p, lastRunAt: T0 }), T0 + STALE_MIN_MS, "3 × 30 s < 2 min — 2 min is used");
  assert.equal(staleAt({ ...p, intervalMs: 3_600_000, lastRunAt: T0 }), T0 + 3 * 3_600_000);
  assert.equal(staleAt({ ...p, intervalMs: null, lastRunAt: T0 }), null, "cron or no interval — no deadline");
  const fresh = computeIdle({ now: T0 + 60_000, plugins: [{ ...p, lastRunAt: T0 }] });
  assert.deepEqual(fresh.items.map((i) => i.text), ["Прогон идёт с 01:30"]);
  assert.equal(fresh.nextAt, T0 + STALE_MIN_MS, "the service wakes up at the deadline");
  const stale = computeIdle({ now: T0 + STALE_MIN_MS, plugins: [{ ...p, lastRunAt: T0 }] });
  assert.equal(stale.verdict, "busy");
  assert.equal(stale.items[0].text, "Прогоны не отвечает — последнее: Прогон идёт с 01:30 (01:50)");
  // streamable: no phrases — no deadline (a quiet stream may be silent for hours), with phrases — 5 min
  const s = { id: "agents", title: "Агенты", status: "ok", trusted: true, type: "streamable", intervalMs: null, lastRunAt: T0, activity: ["Прогон «m81-gold» идёт, 12 мин"], needsOn: null };
  assert.equal(staleAt(s), T0 + STREAM_STALE_MS);
  assert.equal(staleAt({ ...s, activity: [] }), null);
  assert.match(computeIdle({ now: T0 + STREAM_STALE_MS, plugins: [s] }).items[0].text, /^Агенты не отвечает — последнее: Прогон «m81-gold» идёт, 12 мин/);
  // a silent needsOn — unknown, verdict "yes, but"
  const n = computeIdle({ now: T0 + STALE_MIN_MS, plugins: [{ ...p, activity: [], needsOn: ["Прогон в 04:30 — нужен включённый Mac"], lastRunAt: T0 }] });
  assert.deepEqual([n.verdict, n.items[0].kind], ["quiet-needs-on", "unknown"]);
});

test("review: daemon start — \"checking\" (verdict null) until every plugin has sent a frame, no longer than WARMUP_MS", () => {
  const plugins = [
    { id: "agents", title: "Агенты", status: "ok", activity: [], needsOn: null, lastRunAt: T0 },
    { id: "batch", title: "Прогоны", status: "unknown", activity: null, needsOn: null, lastRunAt: null },
  ];
  const early = computeIdle({ now: T0 + 200, startedAt: T0, plugins });
  assert.deepEqual(early, { verdict: null, items: [], checked: [], nextAt: T0 + WARMUP_MS });
  // everyone has sent a frame — compute right away
  assert.equal(computeIdle({ now: T0 + 200, startedAt: T0, plugins: [plugins[0]] }).verdict, "quiet");
  // the deadline has passed — compute from what there is (a plugin that has not answered is not a participant)
  assert.equal(computeIdle({ now: T0 + WARMUP_MS, startedAt: T0, plugins }).verdict, "quiet");
});

test("review: \"Sessions\" in \"checked\" only with a live sessions plugin; broken or silent — a \"don't know about sessions\" line, the verdict is not \"quiet\"", () => {
  const cs = (o) => ({ id: "claude-sessions", title: "Сессии Claude", status: "ok", activity: null, needsOn: null, lastRunAt: T0, ...o });
  assert.deepEqual(computeIdle({ plugins: [cs()] }).checked, ["Сессии"]);
  for (const [bad, text] of [
    [cs({ status: "error" }), "Не знаю про сессии: плагин сессий не ответил"],
    [cs({ status: "unknown" }), "Не знаю про сессии: плагин сессий сам не уверен"],
    [cs({ lastRunAt: null }), "Не знаю про сессии: плагин сессий не ответил"],
  ]) {
    const v = computeIdle({ plugins: [bad] });
    assert.equal(v.verdict, "quiet-needs-on", JSON.stringify(bad));
    assert.deepEqual(v.items, [{ source: "sessions", kind: "unknown", text, target: "plugin:claude-sessions" }]);
    assert.ok(!v.checked.includes("Сессии"));
  }
  // no sessions plugin at all — the session registry (hooks) as before
  assert.deepEqual(computeIdle({}).checked, ["Сессии"]);
  // working sessions are visible even with a broken plugin — on top
  const v = computeIdle({ sessions: [S("a", "busy", "demo-d9")], plugins: [cs({ status: "error" })] });
  assert.deepEqual(v.items.map((i) => i.kind), ["busy", "unknown"]);
  assert.equal(v.verdict, "busy");
});

test("a domain error of a plugin (status=error, error=null — a Hermes task failed) is not a \"failure\": its phrases are taken as usual", () => {
  const hermes = { id: "hermes", title: "Hermes", status: "error", error: null, trusted: true, activity: [], needsOn: null, lastRunAt: T0 };
  const v = computeIdle({ plugins: [hermes] });
  assert.equal(v.verdict, "quiet", "the plugin ran and said it is quiet");
  assert.deepEqual(v.items, []);
  assert.ok(v.checked.includes("Hermes"));
  // with a phrase — work, not "failure — last: …"
  const busy = computeIdle({ plugins: [{ ...hermes, activity: ["Задача «дайджест» идёт"] }] });
  assert.deepEqual(busy.items.map((i) => [i.kind, i.text]), [["busy", "Задача «дайджест» идёт"]]);
  // a real plugin failure — still a "failure"
  for (const error of ["exit 1", "timeout", "empty-output"]) {
    const f = computeIdle({ plugins: [{ ...hermes, error }] });
    assert.equal(f.items[0].text, "Hermes: сбой — не знаю, тихо ли у него", error);
  }
  const en = computeIdle({ lang: "en", plugins: [hermes] });
  assert.equal(en.verdict, "quiet");
});

test("the sessions plugin sent a frame with its own reason (status=unknown) — \"Don't know about sessions: <reason>\", not \"did not answer\"", () => {
  const cs = (o) => ({ id: "claude-sessions", title: "Сессии Claude", status: "unknown", error: null, activity: null, needsOn: null, lastRunAt: T0, why: "Не найден claude — хаб ищет его в ~/.local/bin, /opt/homebrew/bin и /usr/local/bin", ...o });
  const v = computeIdle({ plugins: [cs()] });
  assert.equal(v.verdict, "quiet-needs-on");
  assert.deepEqual(v.items, [{ source: "sessions", kind: "unknown", text: "Не знаю про сессии: не найден claude — хаб ищет его в ~/.local/bin, /opt/homebrew/bin и /usr/local/bin", target: "plugin:claude-sessions" }]);
  const en = computeIdle({ lang: "en", plugins: [cs({ why: "claude not found — the hub looks in ~/.local/bin" })] });
  assert.equal(en.items[0].text, "Not sure about sessions: claude not found — the hub looks in ~/.local/bin");
  // no reason — a generic phrase, but not "did not answer"
  assert.equal(computeIdle({ plugins: [cs({ why: null })] }).items[0].text, "Не знаю про сессии: плагин сессий сам не уверен");
  // no frame or a failure of the plugin itself — "did not answer"
  for (const bad of [cs({ lastRunAt: null }), cs({ status: "error", error: "timeout" }), cs({ status: "error", error: "exit 2" })]) {
    assert.equal(computeIdle({ plugins: [bad] }).items[0].text, "Не знаю про сессии: плагин сессий не ответил", JSON.stringify(bad));
  }
});

test("review: phrases of untrusted plugins carry the plugin name; a blocked plugin does not go into \"checked\"", () => {
  const v = computeIdle({
    plugins: [
      { id: "fake", title: "Сборка", status: "ok", trusted: false, activity: ["2 сессии ждут ответа: a, b — если выключить, вопросы пропадут"], needsOn: ["выключать нельзя — совсем"] },
      { id: "build2", title: "Сборка", status: "ok", trusted: false, activity: ["Сборка: шаг 3"], needsOn: null },
      { id: "agents", title: "Агенты", status: "ok", trusted: true, activity: ["Прогон «x» идёт"], needsOn: null },
      { id: "batch", title: "Прогоны", status: "block", trusted: true, activity: [], needsOn: [] },
    ],
  });
  assert.deepEqual(v.items.map((i) => i.text), ["Сборка: 2 сессии ждут ответа: a, b — если выключить, вопросы пропадут", "Сборка: шаг 3", "Прогон «x» идёт", "Сборка: выключать нельзя — совсем"]);
  assert.deepEqual(v.items.map((i) => i.trusted), [false, false, true, false]);
  assert.ok(!v.checked.includes("Прогоны"), "block is not \"fine\"");
});

test("session name: name → directory → start of the id", () => {
  assert.equal(sessionName({ sessionId: "abcdef0123", name: " n " }), "n");
  assert.equal(sessionName({ sessionId: "abcdef0123", cwd: "/x/proj" }), "proj");
  assert.equal(sessionName({ sessionId: "abcdef0123" }), "abcdef01");
});

// ---------- idle service ----------

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";

function sysAs(state) {
  const procs = { 10: { ppid: 1, path: APP }, 20: { ppid: 1, path: "/usr/bin/curl" }, 40: { ppid: 1, path: CLAUDE } };
  const pidOf = { app: 10, cli: 20 };
  return {
    available: true,
    peerPid: () => pidOf[state.who],
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === APP || path === CLAUDE,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}
const overrides = { requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' } };

const BATCH = `#!/bin/sh
# <agenthub.title>Прогоны</agenthub.title>
# <agenthub.action id="slow" level="immediate">/bin/sleep 0.6</agenthub.action>
echo 'Прогоны готовы | status=ok activity="" needsOn="Прогон в 04:30 — нужен включённый Mac"'
echo "---"
echo "Подождать | action=slow"
`;

async function idleHub(state) {
  const plugins = tempHome("ah-pl-");
  writePlugin(plugins, "batch.1h.sh", BATCH);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(state), services: "idle" });
  const stop = h.stop;
  h.stop = async () => {
    await stop();
    cleanup(plugins);
  };
  await waitFor(() => h.core.pluginState("batch")?.header.length);
  return h;
}

test("service: /state.idle and the idle.verdict event on change; a hub pause does not change the verdict by itself — only restarts plugins", async () => {
  const state = { who: "app" };
  const h = await idleHub(state);
  try {
    await waitFor(() => h.core.snapshot().idle?.verdict === "quiet-needs-on");
    const s0 = (await req(h.sock, "GET", "/state")).body.idle;
    assert.equal(s0.verdict, "quiet-needs-on");
    assert.deepEqual(s0.items.map((i) => i.text), ["Прогон в 04:30 — нужен включённый Mac"]);
    assert.deepEqual(s0.checked, ["Сессии"]);
    assert.ok(Number.isFinite(Date.parse(s0.since)));
    // the plugin reported work → an event with the new verdict
    const seen = [];
    h.core.on("idle.verdict", (ev) => seen.push(ev.idle));
    h.core.applyFrame("batch", 'Прогон идёт | status=ok activity="Прогон идёт с 01:30" needsOn=""');
    await waitFor(() => seen.length >= 1);
    assert.equal(seen.at(-1).verdict, "busy");
    assert.deepEqual(seen.at(-1).items, [{ source: "plugin:batch", target: "plugin:batch", plugin: "Прогоны", trusted: h.core.pluginState("batch").trusted, kind: "busy", text: "Прогон идёт с 01:30" }]);
    // the same frame again — no event
    h.core.applyFrame("batch", 'Прогон идёт | status=ok activity="Прогон идёт с 01:30" needsOn=""');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.length, 1);
    // a hub pause does not change the verdict by itself: plugin frames decide it. But a pause restarts plugins (contract 3,
    // AGENTHUB_PAUSED) — the plugin sent its usual frame ("Mac must be on"), and the verdict follows it
    const ran = h.core.pluginState("batch").lastRunAt;
    assert.equal((await req(h.sock, "POST", "/estop", { on: true })).status, 200);
    await waitFor(() => h.core.pluginState("batch").lastRunAt !== ran);
    await waitFor(() => h.core.snapshot().idle.verdict === "quiet-needs-on");
    assert.equal(seen.at(-1).verdict, "quiet-needs-on");
    // resuming is a restart too: wait for its frame so it does not land on top of the next one
    const paused = h.core.pluginState("batch").lastRunAt;
    await req(h.sock, "POST", "/estop", { on: false });
    await waitFor(() => h.core.pluginState("batch").lastRunAt !== paused);
    // quiet
    h.core.applyFrame("batch", 'Прогоны выключены | status=ok activity="" needsOn=""');
    await waitFor(() => seen.at(-1).verdict === "quiet");
    assert.deepEqual(seen.at(-1).checked, ["Сессии", "Прогоны"]);
  } finally {
    await h.stop();
  }
});

test("service: a Claude Code session is working and waiting for an answer — from the core's session registry", async () => {
  const h = await idleHub({ who: "app" });
  try {
    await h.core.sessions.register("11111111-1111-4111-8111-111111111111", { pid: 40, source: "test", status: "busy", name: "demo-d9" });
    await waitFor(() => h.core.snapshot().idle.verdict === "busy");
    assert.equal(h.core.snapshot().idle.items[0].text, "1 сессия работает: demo-d9");
    await h.core.sessions.register("11111111-1111-4111-8111-111111111111", { pid: 40, source: "test", status: "waiting", name: "demo-d9" });
    await waitFor(() => h.core.snapshot().idle.items.some((i) => i.kind === "waiting"));
    // the work is over, the session is stuck on a question: the verdict follows the test plugin (needsOn), the waiting one is a summary after it
    assert.equal(h.core.snapshot().idle.verdict, "quiet-needs-on");
    assert.match(h.core.snapshot().idle.items.at(-1).text, /ждёт ответа: demo-d9 — ответить можно и после включения/);
  } finally {
    await h.stop();
  }
});

test("service: a plugin action while running — a \"running\" line; finished — gone", async () => {
  const state = { who: "app" };
  const h = await idleHub(state);
  try {
    const offer = h.core.pluginState("batch").body.find((b) => b.title === "Подождать").offer;
    const started = [];
    h.core.on("action.started", (ev) => started.push(ev));
    const run = req(h.sock, "POST", `/actions/${offer.id}`);
    await waitFor(() => h.core.snapshot().idle.items.some((i) => /выполняется/.test(i.text)));
    const it = h.core.snapshot().idle.items.find((i) => /выполняется/.test(i.text));
    assert.equal(it.text, "Прогоны: выполняется «slow»");
    assert.equal(h.core.snapshot().idle.verdict, "busy");
    assert.equal(started.length, 1);
    assert.equal(started[0].plugin, "batch");
    assert.equal((await run).status, 200);
    await waitFor(() => !h.core.snapshot().idle.items.some((i) => /выполняется/.test(i.text)));
  } finally {
    await h.stop();
  }
});

test("service disabled — /state.idle = null", async () => {
  const h = await startHub({ services: "none" });
  try {
    assert.equal((await req(h.sock, "GET", "/state")).body.idle, null);
  } finally {
    await h.stop();
  }
});

test("service: hub update progress (hub-update.status) and plugin install (plugins.busy) are work", async () => {
  const h = await startHub({ services: "plugins,idle" });
  try {
    const { managerFor } = await import("../lib/plugins.mjs");
    const mgr = managerFor(h.home);
    assert.ok(mgr, "plugin manager is running");
    // the plugins service starts after idle: its fact is visible after services.started
    await waitFor(() => h.core.snapshot().idle?.checked.includes("Идущие обновления"));
    assert.equal(h.core.snapshot().idle.verdict, "quiet");
    h.core.emit({ type: "hub-update.status", hubUpdate: { install: { phase: "building", op: "install", label: "0.3.0" } } });
    await waitFor(() => h.core.snapshot().idle.verdict === "busy");
    assert.equal(h.core.snapshot().idle.items[0].text, "Собирается обновление хаба 0.3.0");
    h.core.emit({ type: "hub-update.status", hubUpdate: { install: { phase: "ready", op: "install", label: "0.3.0" } } });
    await waitFor(() => h.core.snapshot().idle.verdict === "quiet");
    // install: plugins.busy events with start and end
    const ev = [];
    h.core.on("plugins.busy", (e) => ev.push(e.busy));
    mgr.setBusy("my-runner", { op: "update", title: "Прогоны", version: "0.5.1" });
    await waitFor(() => h.core.snapshot().idle.verdict === "busy");
    assert.equal(h.core.snapshot().idle.items[0].text, "Обновляется плагин: Прогоны 0.5.1");
    mgr.setBusy("my-runner", null);
    await waitFor(() => h.core.snapshot().idle.verdict === "quiet");
    assert.deepEqual(ev.map((b) => b.length), [1, 0]);
    // a real install of an unknown id: busy during the call and cleared after the refusal
    ev.length = 0;
    await assert.rejects(mgr.install("ghost"));
    assert.deepEqual(ev.map((b) => b.map((x) => x.id)), [["ghost"], []]);
    assert.equal(ev[0][0].op, "install");
  } finally {
    await h.stop();
  }
});

test("review, service: a plugin crashed after activity — the verdict does not freeze on the phrase; an empty frame with an error does not erase phrases", async () => {
  const h = await idleHub({ who: "app" });
  try {
    await waitFor(() => h.core.snapshot().idle?.verdict === "quiet-needs-on");
    h.core.applyFrame("batch", 'Прогон идёт | status=ok activity="Прогон идёт с 01:30" needsOn=""');
    await waitFor(() => h.core.snapshot().idle.verdict === "busy");
    h.core.pluginFailed("batch", "timeout");
    await waitFor(() => /сбой/.test(h.core.snapshot().idle.items[0]?.text || ""));
    assert.match(h.core.snapshot().idle.items[0].text, /^Прогоны: сбой — последнее: Прогон идёт с 01:30 \(\d\d:\d\d\)$/);
    // the plugin reports needsOn again, then exits with code 1 without output — phrases stay, a "failure" line, not "quiet"
    h.core.applyFrame("batch", 'Прогоны | status=ok activity="" needsOn="Прогон в 04:30 — нужен включённый Mac"');
    await waitFor(() => h.core.snapshot().idle.verdict === "quiet-needs-on" && h.core.snapshot().idle.items[0].kind === "needs-on");
    h.core.applyFrame("batch", "", { exitCode: 1 });
    await waitFor(() => h.core.snapshot().idle.items[0]?.kind === "unknown");
    const v = h.core.snapshot().idle;
    assert.equal(v.verdict, "quiet-needs-on");
    assert.match(v.items[0].text, /^Прогоны: сбой — последнее: Прогон в 04:30 — нужен включённый Mac/);
    assert.deepEqual(h.core.pluginState("batch").needsOn, ["Прогон в 04:30 — нужен включённый Mac"]);
    // and the plugin state has no phrase times (otherwise every frame would broadcast plugin)
    assert.equal("_signalsAt" in JSON.parse(JSON.stringify(h.core.pluginState("batch"))), false);
  } finally {
    await h.stop();
  }
});

test("service: core signals — error (plugin failure) and why (its reason) reach the verdict", async () => {
  const h = await idleHub({ who: "app" });
  try {
    await waitFor(() => h.core.snapshot().idle?.verdict === "quiet-needs-on");
    // the plugin ran but reported status=error (a domain error) — not a failure
    h.core.applyFrame("batch", 'Задача упала | status=error activity="" needsOn=""');
    await waitFor(() => h.core.snapshot().idle.verdict === "quiet");
    const sig = h.core.pluginSignals().find((p) => p.id === "batch");
    assert.deepEqual([sig.status, sig.error, sig.why], ["error", null, "Задача упала"]);
    // exit with code 1 — a failure
    h.core.applyFrame("batch", 'Задача упала | status=error activity="" needsOn=""', { exitCode: 1 });
    await waitFor(() => /сбой/.test(h.core.snapshot().idle.items[0]?.text || ""));
  } finally {
    await h.stop();
  }
});

test("review, service: right after the daemon starts — \"checking\" (verdict null) until the plugin has sent its first frame", async () => {
  const plugins = tempHome("ah-pl-");
  writePlugin(plugins, "slow.1h.sh", `#!/bin/sh
# <agenthub.title>Медленный</agenthub.title>
sleep 1.5
echo 'Медленный | status=ok activity=""'
`);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "app" }), services: "idle" });
  try {
    const s0 = (await req(h.sock, "GET", "/state")).body.idle;
    assert.equal(s0.verdict, null, "not \"Safe to shut down\" until the source has answered");
    assert.deepEqual(s0.items, []);
    await waitFor(() => h.core.snapshot().idle.verdict === "quiet", 5000);
    assert.ok(h.core.snapshot().idle.checked.includes("Медленный"));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("review, service: two simultaneous installs of the same plugin — the mark is cleared when the last one finishes", async () => {
  const h = await startHub({ services: "plugins,idle" });
  try {
    const { managerFor } = await import("../lib/plugins.mjs");
    const mgr = managerFor(h.home);
    await waitFor(() => h.core.snapshot().idle?.checked.includes("Идущие обновления"));
    const done = [];
    mgr.installNow = (id, o) => new Promise((r) => done.push(() => r({ ok: true, id, o })));
    const a = mgr.install("ghost");
    const b = mgr.install("ghost");
    await waitFor(() => done.length === 2 && h.core.snapshot().idle.verdict === "busy");
    done[0]();
    await a;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.core.snapshot().idle.verdict, "busy", "the second install is still running");
    assert.deepEqual(mgr.busyList().map((x) => x.id), ["ghost"]);
    done[1]();
    await b;
    await waitFor(() => h.core.snapshot().idle.verdict === "quiet");
    assert.deepEqual(mgr.busyList(), []);
  } finally {
    await h.stop();
  }
});
