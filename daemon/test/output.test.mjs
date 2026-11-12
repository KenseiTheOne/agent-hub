import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameSplitter, MAX_DATA_VALUE, parseEffectSpec, parseLine, parseOutput, parseParams, splitFrames, worstStatus } from "../lib/output.mjs";

test("params: plain, quoted, escaped", () => {
  assert.deepEqual(parseParams(` color=red tooltip="a b" font='Menlo Bold' x="q\\"q"`).params, { color: "red", tooltip: "a b", font: "Menlo Bold", x: 'q"q' });
  assert.equal(parseParams(" not params").ok, false);
});

test("line: the separator is the last | with params on the right", () => {
  assert.deepEqual(parseLine("A | B | color=red"), { title: "A | B", params: { color: "red" } });
  assert.deepEqual(parseLine("просто текст | без параметров"), { title: "просто текст | без параметров", params: {} });
  assert.deepEqual(parseLine("Нет разделителя"), { title: "Нет разделителя", params: {} });
});

test("header up to ---, body, nesting, separators", () => {
  const out = parseOutput(`Прогоны: блокер | status=block sfimage=moon
Вторая строка шапки
---
Unity на batch-worktree | color=red
--Подробности
----Глубже
-----
---
Ссылка | href=https://example.com`);
  assert.equal(out.status, "block");
  assert.equal(out.header.length, 2);
  assert.equal(out.header[0].title, "Прогоны: блокер");
  assert.equal(out.header[0].params.sfimage, "moon");
  assert.equal(out.body[0].title, "Unity на batch-worktree");
  assert.equal(out.body[1].level, 1);
  assert.equal(out.body[2].level, 2);
  assert.equal(out.body[3].separator, true);
  assert.equal(out.body[3].level, 1);
  assert.equal(out.body[4].separator, true);
  assert.equal(out.body[5].href, "https://example.com");
});

test("status/effect/action/event are parsed; unknown status — a warning", () => {
  const out = parseOutput(`H | status=wait
---
A | effect="cmux.focus surface=abc"
B | action=check
C | event=run-blocked status=bogus`);
  assert.equal(out.status, "wait");
  assert.equal(out.body[0].effect, "cmux.focus surface=abc");
  assert.equal(out.body[1].action, "check");
  assert.deepEqual(out.events, ["run-blocked"]);
  assert.ok(out.warnings.some((w) => w.includes("bogus")));
});

test("bash=, shell=, terminal=, paramN= are dropped with a warning", () => {
  const out = parseOutput(`H\n---\nX | bash=/bin/rm param1=-rf param2=/ terminal=false shell=/bin/sh color=red`);
  const item = out.body[0];
  assert.deepEqual(item.params, { color: "red" });
  assert.equal(out.warnings.filter((w) => w.includes("is forbidden")).length, 5);
  assert.ok(!("bash" in item));
});

test("empty output → unknown; no status → ok", () => {
  assert.equal(parseOutput("").status, "unknown");
  assert.equal(parseOutput("\n\n").empty, true);
  assert.equal(parseOutput("Hi").status, "ok");
});

test("worst status: ok < unknown < wait < block < error", () => {
  assert.equal(worstStatus(["ok", "wait", "unknown"]), "wait");
  assert.equal(worstStatus(["block", "wait"]), "block");
  assert.equal(worstStatus(["block", "error"]), "error");
  assert.equal(worstStatus([]), "ok");
  assert.equal(worstStatus(["ok", "unknown"]), "unknown");
});

test("effect: primitive and arguments", () => {
  assert.deepEqual(parseEffectSpec("open.url https://x.y/?a=b"), { primitive: "open.url", tokens: ["https://x.y/?a=b"] });
  assert.deepEqual(parseEffectSpec(`cmux.focus surface="a b"`), { primitive: "cmux.focus", tokens: ["surface=a b"] });
  assert.equal(parseEffectSpec("rm -rf /"), null);
  assert.equal(parseEffectSpec(""), null);
});

test("streamable frames split by ~~~", () => {
  assert.deepEqual(splitFrames("A\n---\nb\n~~~\nC\n~~~\n"), ["A\n---\nb", "C"]);
  assert.deepEqual(splitFrames("~~~\nA\n~~~\n"), ["A"]);
  const frames = [];
  const s = new FrameSplitter((f) => frames.push(f));
  s.push("X | status=ok\n--");
  s.push("-\nbody\n~");
  assert.equal(frames.length, 0);
  s.push("~~\n");
  assert.deepEqual(frames, ["X | status=ok\n---\nbody"]);
});

test("an oversized frame is marked overflow", () => {
  const got = [];
  const s = new FrameSplitter((f, o) => got.push(o), 10);
  s.push("0123456789abcdef\nshort\n~~~\n");
  assert.deepEqual(got, [true]);
});

test("line: parsing is linear — a long tail of \"|\" does not block the event loop (review: quadratic parseLine)", () => {
  // a "|" inside a quoted value still does not prevent finding the separator
  assert.deepEqual(parseLine(`a | t="x | y | z" k=v`), { title: "a", params: { t: "x | y | z", k: "v" } });
  const line = `x | ${"a=b|".repeat(250_000)}a=b junk`; // ~1 MB — the plugin output limit
  let t0 = Date.now();
  parseLine(line);
  assert.ok(Date.now() - t0 < 500, `parseLine: ${Date.now() - t0} ms`);
  t0 = Date.now();
  const out = parseOutput(`${line}\n${line}\nок | status=ok`);
  assert.ok(Date.now() - t0 < 1000, `parseOutput: ${Date.now() - t0} ms`);
  assert.ok(out.warnings.some((w) => w.includes("line cut")));
  assert.equal(out.header[2].title, "ок");
  assert.equal(out.status, "ok");
});

test("line: a long whitespace run before a character does not block the event loop (review: \\s+$ is quadratic)", () => {
  const line = `x${" ".repeat(1_000_000)}y`; // ~1 MB — the plugin output limit
  let t0 = Date.now();
  const out = parseOutput(`${line}\n---\n--${" ".repeat(500_000)}z\nок | status=ok`);
  assert.ok(Date.now() - t0 < 500, `parseOutput: ${Date.now() - t0} ms`);
  assert.ok(out.warnings.some((w) => w.includes("line cut")));
  assert.equal(out.warnings.filter((w) => w.includes("line cut")).length, 2, "one warning per line");
  assert.equal(out.header[0].title, "x");
  // the "--" level and trailing spaces are still stripped
  assert.equal(parseOutput("a\n---\n--b  \t ").body[0].title, "b");
  assert.equal(parseOutput("a\n---\n--b  \t ").body[0].level, 1);
});

test("chart params (hub 0.1.3) pass as is: commas, ¦, quotes, \\n in tips; data keys get a larger cap", () => {
  const tips = Array.from({ length: 30 }, (_, i) => `Wed Nov ${i + 1}, by 16:00 — 1.75B\\nCache read 1.71B\\nCache write 39.3M\\nOutput 6.6M\\nAPI price $698`).join("¦");
  const text = [
    'Today $101 · 236M tokens | tile="$101" spark="503,332,16.77,101" sparkAvg=342 sparkLabel="14 days" sparkNote="avg $342 a day"',
    "---",
    `By day | chart=bars values="503,332,16.77" labels="29¦30¦31" valueLabels="$503¦$332¦$17" avg=342 avgLabel="avg \\"$342\\"" highlight=last unit=$ tips="${tips.replace(/\\/g, "\\\\")}"`,
    'Tokens | chart=bars stack="Cache read,Cache write,Output" series="990,797;29.7,19.7;7.1,3.1" colors="#64D2FF,#BF5AF2,#FF9F0A" legend=true',
    "Where | chart=share",
    '--Background Workflow | value=2050 note="$2,050" color=#BF5AF2',
    'Opus 5.5 | bar=98 note="$2,981" color=orange',
    'Types | table=true columns="Type¦Today" barColumn=2',
  ].join("\n");
  const r = parseOutput(text);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.header[0].params, { tile: "$101", spark: "503,332,16.77,101", sparkAvg: "342", sparkLabel: "14 days", sparkNote: "avg $342 a day" });
  const [bars, tokens, share, part, line, table] = r.body;
  assert.equal(bars.params.chart, "bars");
  assert.equal(bars.params.values, "503,332,16.77");
  assert.equal(bars.params.labels, "29¦30¦31");
  assert.equal(bars.params.avgLabel, 'avg "$342"');
  assert.equal(bars.params.highlight, "last");
  assert.ok(tips.length > 2000 && tips.length < MAX_DATA_VALUE, `${tips.length}`);
  // inside quotes a backslash escapes the next character: the plugin writes \\n (an escaped backslash and n), the shell gets \n
  assert.equal(bars.params.tips, tips);
  assert.equal(parseParams('tips="a\\nb"').params.tips, "anb", "a single backslash is eaten by the quoting");
  assert.equal(bars.params.tips.split("¦").length, 30);
  assert.ok(bars.params.tips.includes("1.75B\\nCache read"));
  assert.equal(tokens.params.series, "990,797;29.7,19.7;7.1,3.1");
  assert.equal(tokens.params.colors, "#64D2FF,#BF5AF2,#FF9F0A");
  assert.equal(share.params.chart, "share");
  assert.deepEqual([part.level, part.params.value, part.params.note], [1, "2050", "$2,050"]);
  assert.deepEqual([line.params.bar, line.params.note, line.params.color], ["98", "$2,981", "orange"]);
  assert.equal(table.params.barColumn, "2");
  // other keys keep the 2000 cap; data keys stop at MAX_DATA_VALUE
  const long = "x".repeat(MAX_DATA_VALUE + 10);
  const capped = parseOutput(`t\n---\nc | chart=bars values="${long}" note="${long}"`).body[0].params;
  assert.equal(capped.values.length, MAX_DATA_VALUE);
  assert.equal(capped.note.length, 2000);
});
