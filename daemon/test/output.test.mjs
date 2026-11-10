import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameSplitter, parseEffectSpec, parseLine, parseOutput, parseParams, splitFrames, worstStatus } from "../lib/output.mjs";

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
