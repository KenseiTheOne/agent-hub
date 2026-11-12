// Plugin output safety (S1, G16): `\|` in a title, escapeTitle, the built-in plugins' own helpers, and data keys over
// MAX_DATA_VALUE keeping their newest entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR } from "../lib/config.mjs";
import { escapeTitle, MAX_DATA_VALUE, parseLine, parseOutput, splitFrames, trimDataKeys, unescapeTitle } from "../lib/output.mjs";

const INJECT = "GET /x 200 | href=https://evil.example event=pwned";
const body = (text) => parseOutput(`h\n---\n${text}`).body;

test("S1 repro: foreign text printed last on a line adds href= and event=; escaped — it stays in the title", () => {
  const raw = body(`--${INJECT}`)[0];
  assert.equal(raw.href, "https://evil.example");
  assert.equal(raw.event, "pwned");
  const safe = body(`--${escapeTitle(INJECT)}`)[0];
  assert.deepEqual(safe, { title: INJECT, level: 1, params: {} });
  assert.deepEqual(parseOutput(`h\n---\n--${escapeTitle(INJECT)}`).events, []);
  // the same text before the plugin's own parameters
  const own = body(`--${escapeTitle(INJECT)} | color=gray`)[0];
  assert.deepEqual([own.title, own.params, own.href, own.event], [INJECT, { color: "gray" }, undefined, undefined]);
  // action=/arg= of the same plugin can't be smuggled either
  const act = body(escapeTitle('ok | action=deploy arg="prod"'))[0];
  assert.deepEqual([act.title, act.action, act.params], ['ok | action=deploy arg="prod"', undefined, {}]);
});

test("S1: escapeTitle round-trips any text in the header and the body, with and without parameters after it", () => {
  const samples = ["a|b", "a\\|b", "a\\\\|b", "|", "||", "\\", "x\\", "a\\b", "C:\\dir\\", "--x", "---", "-", "~~~", "~/p", "\\-x", "\\\\~", "  -x", "-|-", " | x", "a \\| b", "line\nbreak", "tab\there"];
  for (const t of samples) {
    const want = t.replace(/[\u0000-\u001f\u007f]/g, " ");
    for (const level of [0, 1, 2]) {
      const prefix = "--".repeat(level);
      const [withParams] = body(`${prefix}${escapeTitle(t)} | color=red`);
      assert.deepEqual([withParams.title, withParams.level, withParams.params], [want.trim(), level, { color: "red" }], `body ${JSON.stringify(t)} level ${level}`);
      const [alone] = body(`${prefix}${escapeTitle(t)}`);
      assert.deepEqual([alone.title, alone.level, alone.params, alone.separator], [want.trim(), level, {}, undefined], `body alone ${JSON.stringify(t)}`);
    }
    const head = parseOutput(`${escapeTitle(t)} | color=red\n---\nb`).header[0];
    assert.deepEqual([head.title, head.params], [want.trimEnd(), { color: "red" }], `header ${JSON.stringify(t)}`);
  }
  // "---" and "~~~" escaped are not a separator, a header end or a frame end
  assert.equal(parseOutput(`${escapeTitle("---")}\nstill header`).header.length, 2);
  assert.deepEqual(splitFrames(`a\n${escapeTitle("~~~")}\nb\n~~~\nc\n`), [`a\n\\~~~\nb`, "c"]);
});

test("S1: lines without escapes parse as before", () => {
  assert.deepEqual(parseLine("A | B | color=red"), { title: "A | B", params: { color: "red" } });
  assert.deepEqual(parseLine("a\\b | k=v"), { title: "a\\b", params: { k: "v" } });
  assert.deepEqual(parseLine("C:\\dir\\ | k=v"), { title: "C:\\dir\\", params: { k: "v" } });
  assert.deepEqual(parseLine("a\\\\b\\n | k=v"), { title: "a\\\\b\\n", params: { k: "v" } });
  assert.deepEqual(parseLine('x | t="a | b" u="c\\\\|d" k=v'), { title: "x", params: { t: "a | b", u: "c\\|d", k: "v" } });
  assert.deepEqual(parseLine("plain"), { title: "plain", params: {} });
  // an even run before "|" is still a separator; a "|" whose right side isn't parameters stays in the title as is
  assert.deepEqual(parseLine("a\\\\| k=v"), { title: "a\\\\", params: { k: "v" } });
  assert.deepEqual(parseLine("a\\\\| junk junk"), { title: "a\\\\| junk junk", params: {} });
  assert.equal(unescapeTitle("-x \\- y"), "-x \\- y");
  assert.equal(body("--sub | color=red")[0].level, 1);
  assert.equal(body("x\n---")[1].separator, true);
});

test("S1: a split inside a quoted value (its right side has a stray quote) loses to a clean split further left", () => {
  // the plugin quoted the foreign value but didn't escape "|": the tail `href=https://evil.example"` parses, with a quote
  const r = parseLine('row | note="a | href=https://evil.example" color=gray');
  assert.deepEqual(r, { title: "row", params: { note: "a | href=https://evil.example", color: "gray" } });
  const last = parseLine("row | note='a | href=https://evil.example'");
  assert.deepEqual(last, { title: "row", params: { note: "a | href=https://evil.example" } });
  // no clean split to the left — the old answer stays (an unquoted value with a quote is legal)
  assert.deepEqual(parseLine('row | tile=5"'), { title: "row", params: { tile: '5"' } });
  assert.deepEqual(parseLine('a | b | tile=5"'), { title: "a | b", params: { tile: '5"' } });
  // "|" escaped inside a quoted value is not a split candidate and unescapes to "|"
  assert.deepEqual(parseLine('row | note="a \\| href=x"'), { title: "row", params: { note: "a | href=x" } });
});

test("S1: escaped \"|\" don't count as split tries and the scan stays linear", () => {
  const many = `${"x\\|".repeat(5000)} | k=v`;
  const r = parseLine(many);
  assert.deepEqual(r.params, { k: "v" });
  assert.equal(r.title, "x|".repeat(5000).trimEnd());
  const t0 = Date.now();
  parseLine(`${"\\".repeat(15_000)}|${"\\".repeat(1000)}`);
  unescapeTitle(`${"\\".repeat(16_000)}x|`);
  escapeTitle(`${"\\".repeat(16_000)}|`);
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
});

test("S1 audit: the built-in plugins' own text helpers keep foreign text out of parameters", async () => {
  const mods = {
    "claude-sessions": await import(join(REPO_DIR, "plugins/claude-sessions/claude-sessions.mjs")),
    agents: await import(join(REPO_DIR, "plugins/agents/agents.mjs")),
    spend: await import(join(REPO_DIR, "plugins/spend/spend.mjs")),
    quota: await import(join(REPO_DIR, "plugins/quota/quota.5m.mjs")),
  };
  const nasty = [INJECT, "--x | href=https://evil.example", "~~~", "---", "a\nb | event=pwned", "x\\| href=https://evil.example"];
  for (const [id, m] of Object.entries(mods)) {
    assert.equal(typeof m.clean, "function", `${id}: clean()`);
    for (const f of nasty) {
      for (const line of [`--${m.clean(f)}`, `--${m.clean(f)} | color=gray`, m.clean(f)]) {
        const r = parseOutput(`h\n---\n${line}`);
        for (const it of r.body) {
          assert.equal(it.href, undefined, `${id}: ${JSON.stringify(line)}`);
          assert.equal(it.event, undefined, `${id}: ${JSON.stringify(line)}`);
          assert.ok(it.level <= 1 && !it.separator, `${id}: ${JSON.stringify(line)}`);
        }
        assert.equal(splitFrames(`h\n${line}\n`).length, 1, `${id}: frame end from ${JSON.stringify(f)}`);
      }
    }
  }
  // values: quoting helpers keep spaces and quotes inside the value
  const v = parseOutput(`h\n---\nx | note=${mods["claude-sessions"].q('a" href=https://evil.example b')}`).body[0];
  assert.equal(v.href, undefined);
  assert.equal(v.params.note, "a\" href=https://evil.example b");
  const s = parseOutput(`h\n---\n${mods.spend.line("x", { note: 'a" href=https://evil.example' })}`).body[0];
  assert.deepEqual([s.href, s.params.note], [undefined, 'a" href=https://evil.example']);
});

test("S1 audit: claude-sessions memory file can't put foreign text into event= or a title (sessionId from the checked key)", async () => {
  const C = await import(join(REPO_DIR, "plugins/claude-sessions/claude-sessions.mjs"));
  const dir = mkdtempSync(join(tmpdir(), "ah-mem-"));
  try {
    const sid = "11111111-1111-4111-8111-111111111111";
    const path = join(dir, "memory.json");
    const evil = "x href=https://evil.example";
    writeFileSync(path, JSON.stringify({ version: 1, waitingSince: [], lastBusy: [], gone: [], died: [[sid, { sessionId: evil, pid: "1 | href=https://evil.example", name: "n", at: Date.now(), why: "gone" }]] }));
    const mem = C.loadMemory(path);
    const d = mem.died.get(sid);
    assert.deepEqual([d.sessionId, d.pid], [sid, null]);
    const r = parseOutput(C.render({ sessions: [], died: [...mem.died.values()], problems: [], agentsOk: true }, Date.now(), "en"));
    const all = [...r.header, ...r.body];
    assert.ok(all.every((i) => i.href === undefined));
    assert.deepEqual(r.events, [`died:${sid}`]);
    assert.ok(r.body.some((i) => / · process \?$/.test(i.title)), JSON.stringify(r.body.map((i) => i.title)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- G16: data keys over the cap keep the newest entries ----------

const nums = (n, from = 0) => Array.from({ length: n }, (_, i) => String(from + i));

test("G16: values= over the cap drops the oldest entries; labels, valueLabels and tips lose the same count; highlight moves", () => {
  const N = 1900; // values ≈ 8.4K characters
  const values = nums(N).join(",");
  const labels = nums(N).map((x) => x.slice(-1)).join("¦");
  const warnings = [];
  const p = trimDataKeys({ chart: "bars", values, labels, valueLabels: labels, tips: labels, highlight: String(N - 1), note: "x" }, warnings);
  const v = p.values.split(",");
  assert.ok(p.values.length <= MAX_DATA_VALUE);
  assert.equal(v.at(-1), String(N - 1), "the newest entry stays");
  const dropped = N - v.length;
  assert.ok(dropped > 0);
  assert.equal(v[0], String(dropped));
  for (const k of ["labels", "valueLabels", "tips"]) {
    const l = p[k].split("¦");
    assert.equal(l.length, v.length, k);
    assert.equal(l[0], String(dropped).slice(-1), k);
  }
  assert.equal(p.highlight, String(N - 1 - dropped));
  assert.equal(p.note, "x");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /values=.*8000/);
  // the same through parseOutput (the line itself stays under 16K)
  const r = parseOutput(`h\n---\nc | chart=bars values="${values}" labels="${labels}" highlight=last`);
  const q = r.body[0].params;
  assert.deepEqual([q.values, q.labels, q.highlight], [p.values, p.labels, "last"]);
  assert.equal(r.warnings.length, 1);
});

test("G16: series rows each lose the head entries; comma labels; a highlight that fell off goes; spark trims alone", () => {
  const rows = [nums(900, 1000), nums(900, 5000)];
  const series = rows.map((r) => r.join(",")).join(";");
  assert.ok(series.length > MAX_DATA_VALUE && series.length < 16_000);
  const p = trimDataKeys({ series, labels: nums(900).join(","), values: "1,2,3", highlight: "0" }, []);
  const out = p.series.split(";").map((r) => r.split(","));
  assert.ok(p.series.length <= MAX_DATA_VALUE);
  const kept = out[0].length;
  assert.equal(out[1].length, kept);
  assert.equal(out[0].at(-1), "1899");
  assert.equal(out[1].at(-1), "5899");
  assert.equal(out[0][0], String(1000 + 900 - kept));
  assert.deepEqual(p.labels.split(",").at(0), String(900 - kept));
  assert.equal(p.labels.split(",").length, kept);
  assert.equal(p.values, "", "a list shorter than the drop is emptied, not misaligned");
  assert.equal(p.highlight, undefined);
  // spark is its own list: values on the same line aren't touched
  const warnings = [];
  const q = trimDataKeys({ spark: nums(1900).join(","), values: "1,2" }, warnings);
  assert.equal(q.values, "1,2");
  assert.equal(q.spark.split(",").at(-1), "1899");
  assert.ok(q.spark.length <= MAX_DATA_VALUE);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /spark=/);
  // highlight=last is left alone; under the cap nothing changes
  const same = { values: "1,2", tips: "a¦b", highlight: "last" };
  assert.deepEqual(trimDataKeys({ ...same }, []), same);
});

test("G16: one entry longer than the cap keeps its tail; the warning reaches the journal through core.warn", () => {
  const long = "x".repeat(MAX_DATA_VALUE + 10) + "END";
  const r = parseOutput(`h\n---\nc | chart=bars values="${long}" note="${"y".repeat(3000)}"`);
  assert.equal(r.body[0].params.values.length, MAX_DATA_VALUE);
  assert.ok(r.body[0].params.values.endsWith("END"));
  assert.equal(r.body[0].params.note.length, 2000);
  assert.equal(r.warnings.filter((w) => /values=/.test(w)).length, 1);
});
