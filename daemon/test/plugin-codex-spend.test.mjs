// The codex-spend plugin: Codex token spend from rollouts (new format summed by response_id, old format by token_count),
// forks and spawned agents count only their own requests, model by turn, archived sessions, incremental reads, the server's daily totals through a fake
// `codex app-server`, and no conversation text anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOutput, splitFrames } from "../lib/output.mjs";
import { readPluginMeta } from "../lib/meta.mjs";
import { SECRET, writer, rolloutPath, writeRollout } from "./fixtures/codex/rollouts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = join(REPO, "plugins/codex-spend/codex-spend.mjs");
const FAKE = join(REPO, "daemon/test/fixtures/codex/fake-codex.mjs");
const S = await import(FILE);

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ID = {
  a: "aaaaaaaa-0000-4000-8000-000000000001",
  fork: "aaaaaaaa-0000-4000-8000-000000000002",
  old: "aaaaaaaa-0000-4000-8000-000000000003",
  exec: "aaaaaaaa-0000-4000-8000-000000000004",
  sub: "aaaaaaaa-0000-4000-8000-000000000005",
  arch: "aaaaaaaa-0000-4000-8000-000000000006",
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "ah-cxs-"));
}
function fakeBin(root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  return bin;
}

// The original session: two turns on two models, new format (token_count repeats the record and must not double it).
function original() {
  const w = writer({ start: "2026-11-22T10:00:00.000Z" });
  w.meta({ id: ID.a, cwd: "/Users/test/Projects/alpha" });
  w.userMessage();
  w.turnContext({ turn: "t1", model: "gpt-6.1-terra" });
  w.taskStarted({ turn: "t1" });
  w.usage({ turn: "t1", response: "resp-1", input: 1000, cached: 400, output: 200, reasoning: 50 });
  w.tokenCount({ input: 1000, cached: 400, output: 200, reasoning: 50 });
  w.agentMessage();
  w.taskComplete({ turn: "t1" });
  w.turnContext({ turn: "t2", model: "gpt-6.1-sol" });
  w.taskStarted({ turn: "t2" });
  w.usage({ turn: "t2", response: "resp-2", input: 3000, cached: 2000, output: 500, reasoning: 100 });
  w.tokenCount({ input: 3000, cached: 2000, output: 500, reasoning: 100 });
  w.taskComplete({ turn: "t2" });
  return w;
}

function world() {
  const root = tmp();
  const codex = join(root, ".codex");
  const w = original();
  writeRollout(rolloutPath(codex, ID.a, "2026-11-22T10:00:00.000Z"), w.text());
  // a user fork as Codex 0.159 writes it: its own meta, the parent's lines copied with fresh timestamps (the same
  // response_ids, the parent's thread_id), its own settings snapshot, then one request of its own
  const f = writer({ start: "2026-11-22T11:00:00.000Z" });
  f.meta({ id: ID.fork, cwd: "/Users/test/Projects/alpha", forkedFrom: ID.a });
  f.copy(w.lines);
  f.settingsApplied();
  f.wait(5 * 60_000);
  f.turnContext({ turn: "f1", model: "gpt-6.1-terra" });
  f.usage({ turn: "f1", response: "resp-f1", input: 100, cached: 0, output: 10, reasoning: 0 });
  writeRollout(rolloutPath(codex, ID.fork, "2026-11-22T11:00:00.000Z"), f.text());
  // an old-format session (0.146): only token_count; the same event repeated (a resumed copy) counts once
  const o = writer({ start: "2026-11-22T09:00:00.000Z", old: true });
  o.meta({ id: ID.old, cwd: "/Users/test/Projects/beta" });
  o.turnContext({ turn: "o1", model: "gpt-5.6-sol" });
  o.tokenCount({ input: 2000, cached: 1000, output: 300, reasoning: 0, total: 2300 });
  const dup = o.lines.at(-1);
  o.tokenCount({ input: 500, cached: 0, output: 100, reasoning: 0, total: 2900 });
  writeRollout(rolloutPath(codex, ID.old, "2026-11-22T09:00:00.000Z"), `${o.text()}${dup}\n`);
  // exec and a subagent
  const e = writer({ start: "2026-11-22T08:00:00.000Z" });
  e.meta({ id: ID.exec, source: "exec" });
  e.turnContext({ turn: "e1", model: "gpt-6.1-terra" });
  e.usage({ turn: "e1", response: "resp-e1", input: 400, cached: 0, output: 40, reasoning: 0 });
  writeRollout(rolloutPath(codex, ID.exec, "2026-11-22T08:00:00.000Z"), e.text());
  const s = writer({ start: "2026-11-22T08:30:00.000Z" });
  s.meta({ id: ID.sub, source: { subagent: { other: "guardian" } }, parent: ID.a });
  s.turnContext({ turn: "s1", model: "codex-auto-review" });
  s.usage({ turn: "s1", response: "resp-s1", input: 300, cached: 100, output: 30, reasoning: 0 });
  writeRollout(rolloutPath(codex, ID.sub, "2026-11-22T08:30:00.000Z"), s.text());
  // an archived session (flat folder)
  const a = writer({ start: "2026-11-21T10:00:00.000Z" });
  a.meta({ id: ID.arch });
  a.turnContext({ turn: "a1", model: "gpt-6.1-terra" });
  a.usage({ turn: "a1", response: "resp-a1", input: 700, cached: 0, output: 70, reasoning: 0 });
  writeRollout(rolloutPath(codex, ID.arch, "2026-11-21T10:00:00.000Z", { archived: true }), a.text());
  return { root, codex };
}

function indexOf(codex, cachePath = null) {
  const idx = new S.CodexSpendIndex({ codex, cachePath, now: () => NOW });
  idx.load();
  idx.scan();
  while (!idx.step()) {}
  return idx;
}

test("codex-spend: metadata — streamable, reads rollouts, asks app-server account/usage/read, no prices", () => {
  const { meta } = readPluginMeta(FILE);
  assert.equal(meta.type, "streamable");
  assert.ok(meta.fsRead.some((x) => x.startsWith("~/.codex/sessions/")));
  assert.ok(meta.fsRead.some((x) => x.startsWith("~/.codex/archived_sessions/")));
  assert.ok(meta.exec.some((x) => /^codex app-server — .*account\/usage\/read/.test(x)), meta.exec.join("\n"));
  const src = readFileSync(FILE, "utf8");
  assert.doesNotMatch(src, /auth\.json|chatgpt\.com/);
});

test("codex-spend: new format summed by response_id, token_count ignored there; fork copies counted once; model by turn", () => {
  const { root, codex } = world();
  try {
    const idx = indexOf(codex);
    const day = S.dayKey(Date.parse("2026-11-22T10:00:00.000Z"));
    const d = idx.days[day];
    const vals = (m) => d.m[m] || S.zero();
    // turn t1 → terra (1000 in, 400 cached → 600 new, 200 out), fork's own f1 → terra, exec e1 → terra
    assert.deepEqual(vals("gpt-6.1-terra"), [3, 600 + 100 + 400, 400, 200 + 10 + 40, 50]);
    // turn t2 → sol, once although the fork repeats it
    assert.deepEqual(vals("gpt-6.1-sol"), [1, 1000, 2000, 500, 100]);
    // old format: two token_counts (the repeated line once), model from the file's turn_context
    assert.deepEqual(vals("gpt-5.6-sol"), [2, 1000 + 500, 1000, 400, 0]);
    assert.deepEqual(vals("codex-auto-review"), [1, 200, 100, 30, 0]);
    // the forked copy stays with the original thread; the fork has only its own request
    assert.equal(d.t[ID.a][0], 2);
    assert.equal(d.t[ID.fork][0], 1);
    assert.equal(idx.threads[ID.exec].kind, "exec");
    assert.equal(idx.threads[ID.sub].kind, "sub");
    assert.equal(idx.threads[ID.a].cwd, "/Users/test/Projects/alpha");
    // archived sessions are read too (the day before)
    const yday = S.dayKey(Date.parse("2026-11-21T10:00:00.000Z"));
    assert.equal(idx.days[yday].m["gpt-6.1-terra"][0], 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Forks of a parent older than the horizon (its file isn't opened, so no key can dedupe the copy). Codex re-stamps the
// copied lines, so without the prefix rules the parent's whole history would land on today.
function forkWorld() {
  const root = tmp();
  const codex = join(root, ".codex");
  const P = { parent: "bbbbbbbb-0000-4000-8000-000000000001", oldParent: "bbbbbbbb-0000-4000-8000-000000000002", user: "bbbbbbbb-0000-4000-8000-000000000003", spawn: "bbbbbbbb-0000-4000-8000-000000000004", ofOld: "bbbbbbbb-0000-4000-8000-000000000005", legacy: "bbbbbbbb-0000-4000-8000-000000000006", resumed: "bbbbbbbb-0000-4000-8000-000000000007" };
  const OLD = "2026-09-01T10:00:00.000Z";
  // a new-format parent from September: two responses, each with its token_count
  const p = writer({ start: OLD });
  p.meta({ id: P.parent });
  p.turnContext({ turn: "p1", model: "gpt-6.1-sol" });
  p.usage({ turn: "p1", response: "resp-p1", input: 5000, cached: 0, output: 500, reasoning: 0 });
  p.tokenCount({ input: 5000, cached: 0, output: 500, reasoning: 0, total: 5500 });
  p.usage({ turn: "p1", response: "resp-p2", input: 7000, cached: 0, output: 700, reasoning: 0 });
  p.tokenCount({ input: 7000, cached: 0, output: 700, reasoning: 0, total: 13200 });
  const parentFile = writeRollout(rolloutPath(codex, P.parent, OLD), p.text());
  // an old-format (0.146) parent from September: token_count only
  const o = writer({ start: OLD, old: true });
  o.meta({ id: P.oldParent });
  o.turnContext({ turn: "q1", model: "gpt-5.6-sol" });
  o.tokenCount({ input: 9000, cached: 0, output: 900, reasoning: 0, total: 9900 });
  const oldParentFile = writeRollout(rolloutPath(codex, P.oldParent, OLD), o.text());
  const old = new Date(OLD);
  utimesSync(parentFile, old, old);
  utimesSync(oldParentFile, old, old);
  const own = (x, turn, response) => {
    x.wait(4000);
    x.turnContext({ turn, model: "gpt-6.1-terra" });
    x.usage({ turn, response, input: 100, cached: 0, output: 10, reasoning: 0 });
    x.tokenCount({ input: 100, cached: 0, output: 10, reasoning: 0, total: 99_000 });
  };
  // (a) a user fork today: the copy carries the parent's records (thread_id = parent) and token_counts
  const u = writer({ start: "2026-11-22T11:00:00.000Z" });
  u.meta({ id: P.user, forkedFrom: P.parent });
  u.copy(p.lines);
  u.settingsApplied();
  own(u, "u1", "resp-u1");
  writeRollout(rolloutPath(codex, P.user, "2026-11-22T11:00:00.000Z"), u.text());
  // (b) an agent spawn: Codex drops the parent's token_usage_record lines but keeps its token_count events
  const s = writer({ start: "2026-11-22T11:10:00.000Z" });
  s.meta({ id: P.spawn, parent: P.parent, source: { subagent: { thread_spawn: { parent_thread_id: P.parent, depth: 1 } } } });
  s.copy(p.lines.filter((l) => !l.includes('"type":"token_usage_record"')));
  s.settingsApplied();
  own(s, "s1", "resp-s1");
  writeRollout(rolloutPath(codex, P.spawn, "2026-11-22T11:10:00.000Z"), s.text());
  // (c) a Codex 0.159 fork of an old-format parent: the copy is token_count only, keyed by its fresh timestamp
  const c = writer({ start: "2026-11-22T11:20:00.000Z" });
  c.meta({ id: P.ofOld, forkedFrom: P.oldParent });
  c.copy(o.lines);
  c.settingsApplied();
  own(c, "c1", "resp-c1");
  writeRollout(rolloutPath(codex, P.ofOld, "2026-11-22T11:20:00.000Z"), c.text());
  // a fork written by an older Codex (no settings marker, old format): the copy is one burst, its own count comes later
  const l = writer({ start: "2026-11-22T11:30:00.000Z", old: true });
  l.meta({ id: P.legacy, forkedFrom: P.oldParent });
  l.copy(o.lines);
  l.wait(3000);
  l.turnContext({ turn: "l1", model: "gpt-5.6-sol" });
  l.tokenCount({ input: 300, cached: 0, output: 30, reasoning: 0, total: 10_230 });
  writeRollout(rolloutPath(codex, P.legacy, "2026-11-22T11:30:00.000Z"), l.text());
  // an old-format session resumed today: the first token_count after the resume repeats the last one (new timestamp)
  const r = writer({ start: "2026-11-22T11:40:00.000Z", old: true });
  r.meta({ id: P.resumed });
  r.turnContext({ turn: "r1", model: "gpt-5.6-sol" });
  r.tokenCount({ input: 400, cached: 0, output: 40, reasoning: 0, total: 440 });
  r.wait(60_000);
  r.tokenCount({ input: 400, cached: 0, output: 40, reasoning: 0, total: 440 });
  r.tokenCount({ input: 50, cached: 0, output: 5, reasoning: 0, total: 495 });
  writeRollout(rolloutPath(codex, P.resumed, "2026-11-22T11:40:00.000Z"), r.text());
  return { root, codex, P };
}

test("codex-spend: forks and spawned agents of an old parent count only their own requests; a resume's repeated count once", () => {
  const { root, codex, P } = forkWorld();
  try {
    const idx = indexOf(codex);
    const d = idx.days[S.dayKey(NOW)];
    const n = (id) => d.t[id]?.[0] || 0;
    assert.equal(n(P.user), 1, "user fork: only its own record");
    assert.equal(n(P.spawn), 1, "agent spawn: the copied token_counts are skipped");
    assert.equal(n(P.ofOld), 1, "fork of an old-format parent: the copied token_counts are skipped");
    assert.equal(n(P.legacy), 1, "a fork without the marker: the copy burst is skipped");
    assert.deepEqual(d.t[P.legacy], [1, 300, 0, 30, 0]);
    assert.deepEqual(d.t[P.resumed], [2, 450, 0, 45, 0], "the repeated count after a resume once");
    assert.equal(d.t[P.parent], undefined);
    assert.equal(d.t[P.oldParent], undefined);
    assert.equal(d.m["gpt-6.1-sol"], undefined, "nothing of the September parent lands on today");
    // the prefix state survives a restart in the middle of a fork's copy
    const cache = join(root, "data/index.json");
    const part = join(root, "part");
    const forkFile = rolloutPath(codex, P.spawn, "2026-11-22T11:10:00.000Z");
    const full = readFileSync(forkFile, "utf8").split("\n");
    const cut = full.findIndex((x) => x.includes('"type":"token_count"')) + 1;
    mkdirSync(part);
    const solo = join(part, ".codex");
    const soloFile = rolloutPath(solo, P.spawn, "2026-11-22T11:10:00.000Z");
    writeRollout(soloFile, full.slice(0, cut).join("\n") + "\n");
    let si = indexOf(solo, cache);
    si.save();
    appendFileSync(soloFile, full.slice(cut).join("\n"));
    si = indexOf(solo, cache);
    assert.equal(si.days[S.dayKey(NOW)].t[P.spawn][0], 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex-spend: parseRolloutLine — a record's thread, a fork's meta, the settings marker without parsing", () => {
  const w = writer();
  w.meta({ id: ID.fork, forkedFrom: ID.a });
  w.settingsApplied();
  w.usage({ turn: "x", response: "resp-x", thread: ID.a });
  const [meta, tsa, rec] = w.lines.map(S.parseRolloutLine);
  assert.equal(meta.inherits, true);
  assert.deepEqual(tsa, { t: "tsa", thread: ID.fork });
  assert.equal(rec.thread, ID.a);
  const plain = writer();
  plain.meta({ id: ID.a });
  plain.settingsApplied({ thread: null });
  const [m2, t2] = plain.lines.map(S.parseRolloutLine);
  assert.equal(m2.inherits, false);
  assert.deepEqual(t2, { t: "tsa", thread: null });
});

test("codex-spend: callDue — 15 min, 5 min after a session change, an hour after a sign-in error, manual after 5 min", () => {
  const M = 60_000;
  const due = (since, o = {}) => S.callDue({ nowMs: 1e9, calledAt: 1e9 - since, error: null, ...o }, { every: 15 * M, soon: 5 * M, manualMin: 5 * M, backoff: 60 * M });
  assert.equal(due(14 * M), false);
  assert.equal(due(15 * M), true);
  assert.equal(due(4 * M, { changed: true }), false);
  assert.equal(due(5 * M, { changed: true }), true);
  for (const error of ["api-key", "not-logged-in", "no-codex"]) {
    assert.equal(due(30 * M, { error, changed: true }), false, error);
    assert.equal(due(60 * M, { error }), true, error);
    assert.equal(due(5 * M, { error, manual: true }), true, error);
  }
  assert.equal(due(16 * M, { error: "timeout" }), true);
  assert.equal(due(4 * M, { manual: true }), false);
  assert.equal(S.callDue({ nowMs: 1e9, calledAt: 0, error: null }), true);
});

test("codex-spend: incremental — only the appended part is read; the cache survives a restart; no text in the cache", () => {
  const { root, codex } = world();
  try {
    const cache = join(root, "data/index.json");
    let idx = indexOf(codex, cache);
    idx.save();
    const day = S.dayKey(NOW);
    const before = idx.days[day].m["gpt-6.1-terra"][0];
    // append one more request to the original; a restarted index reads only it
    const w = writer({ start: "2026-11-22T11:30:00.000Z" });
    w.turnContext({ turn: "t3", model: "gpt-6.1-terra" });
    w.usage({ turn: "t3", response: "resp-3", input: 10, cached: 0, output: 1, reasoning: 0, thread: ID.a });
    appendFileSync(rolloutPath(codex, ID.a, "2026-11-22T10:00:00.000Z"), w.text());
    idx = indexOf(codex, cache);
    assert.equal(idx.days[day].m["gpt-6.1-terra"][0], before + 1);
    assert.equal(idx.progress.total, 1, "only the changed file is pending");
    idx.save();
    // a second pass with nothing new changes nothing
    idx = indexOf(codex, cache);
    assert.equal(idx.days[day].m["gpt-6.1-terra"][0], before + 1);
    const text = readFileSync(cache, "utf8");
    assert.doesNotMatch(text, new RegExp(SECRET));
    assert.doesNotMatch(text, /resp-/, "request keys are hashed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex-spend: frame — today's tokens, kinds, sessions by folder, models, server bars with duplicate dates summed; no text", () => {
  const { root, codex } = world();
  try {
    const idx = indexOf(codex);
    const usage = JSON.parse(readFileSync(join(REPO, "plugins/codex-spend/fixtures/usage.json"), "utf8"));
    const p = S.parseUsage(usage);
    assert.equal(p.days["2026-11-21"], 3_000_000);
    assert.equal(p.lifetime, 48_250_000);
    const server = { atMs: NOW, days: p.days, lifetime: p.lifetime, hasDays: true, error: null, calledAt: NOW };
    const text = S.render(idx, { lang: "en", server });
    const parsed = parseOutput(text);
    assert.equal(parsed.status, "ok");
    assert.match(parsed.header[0].title, /^Codex today /);
    assert.match(text, /all Codex today — 900K|all Codex today — 900,000|all Codex today — 900 000/);
    assert.match(text, /\n--alpha · /);
    assert.match(text, /\n--gpt-6\.1-terra \|/);
    assert.match(text, /\n--codex-auto-review \|/);
    assert.match(text, /Subagents|subagents/);
    assert.match(text, /\n---\nDetails \| details=true/);
    assert.doesNotMatch(text, new RegExp(SECRET));
    assert.doesNotMatch(text, /\$|USD/);
    // the server hasn't filled today yet: no "all Codex today — 0" line
    const lagging = S.render(idx, { lang: "en", server: { ...server, days: { ...p.days, "2026-11-22": 0 } } });
    assert.doesNotMatch(lagging, /all Codex today/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex-spend: parseUsage — null buckets, negatives clamped, bad shape rejected", () => {
  assert.deepEqual(S.parseUsage({ summary: {}, dailyUsageBuckets: null }), { days: {}, lifetime: null, hasDays: false });
  assert.equal(S.parseUsage({ dailyUsageBuckets: [{ startDate: "2026-11-22", tokens: -5 }] }).days["2026-11-22"], 0);
  assert.equal(S.parseUsage({ dailyUsageBuckets: {} }), null);
  assert.equal(S.parseUsage(null), null);
});

function runPlugin(env, { waitFor, timeoutMs = 8000 } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [FILE], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const done = () => {
      clearTimeout(t);
      p.stdin.end();
      res({ out, err, frames: splitFrames(out) });
    };
    const t = setTimeout(() => {
      p.kill();
      rej(new Error(`timeout; out=${out} err=${err}`));
    }, timeoutMs);
    p.stdout.on("data", (d) => {
      out += d;
      if (waitFor(out)) done();
    });
    p.stderr.on("data", (d) => (err += d));
  });
}

test("codex-spend: the process — server totals through a fake codex app-server; no ~/.codex → quiet, no spawn", async () => {
  const { root } = world();
  try {
    const bin = fakeBin(root);
    const log = join(root, "calls.log");
    const env = { HOME: root, PATH: "/usr/bin:/bin", AGENTHUB_LANG: "en", AGENTHUB_TEST_BIN_DIR: bin, AGENTHUB_PLUGIN_DATA_PATH: join(root, "data"), AGENTHUB_TEST_NOW: "2026-11-22T12:00:00.000Z", FAKE_CODEX_LOG: log, FAKE_CODEX_ENV_LOG: join(root, "env.log") };
    const r = await runPlugin(env, { waitFor: (o) => /All time: /.test(o) });
    assert.match(readFileSync(log, "utf8"), /account\/usage\/read/);
    assert.equal(readFileSync(join(root, "env.log"), "utf8"), "1\n", "remote control is off for the short-lived server");
    assert.doesNotMatch(r.out, new RegExp(SECRET));
    assert.ok(JSON.parse(readFileSync(join(root, "data/server.json"), "utf8")).hasDays);
    // without ~/.codex nothing is spawned
    const empty = tmp();
    try {
      const log2 = join(empty, "calls.log");
      const r2 = await runPlugin({ ...env, HOME: empty, AGENTHUB_PLUGIN_DATA_PATH: join(empty, "data"), FAKE_CODEX_LOG: log2 }, { waitFor: (o) => /Codex not found|Codex isn't/.test(o) });
      assert.equal(parseOutput(r2.frames.at(-1)).status, "unknown");
      await new Promise((r) => setTimeout(r, 300));
      assert.throws(() => readFileSync(log2), /ENOENT/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
