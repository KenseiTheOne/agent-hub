// The agents plugin (plugins/agents/agents.mjs, streamable) on a synthetic HOME.
// Run: env -u NODE_OPTIONS node --test test/plugin-agents.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "../lib/config.mjs";
import { parseOutput } from "../lib/output.mjs";
import { readPluginMeta } from "../lib/meta.mjs";
import { tempHome } from "./helpers.mjs";

const PLUGIN = join(REPO_DIR, "plugins", "agents", "agents.mjs");
const FIX = join(REPO_DIR, "plugins", "agents", "fixtures");
const { Tracker, Spend, Tail, pidsAlive, parseLstartUtc } = await import(PLUGIN);
const SID = "00000000-0000-4000-8000-000000000001";
const PROJ = "-Users-synthetic-demo";
const MARKERS = ["СИНТЕТИЧЕСК", "123456789", "123,5", "999999"];

// An independent manual count: unique message.id, usage fields as is.
function manualSpend(files) {
  const seen = new Map();
  for (const f of files)
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l) continue;
      const o = JSON.parse(l);
      if (o.type !== "assistant" || !o.message?.usage) continue;
      seen.set(o.message.id, o.message.usage);
    }
  let read = 0;
  let out = 0;
  for (const u of seen.values()) {
    read += u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    out += u.output_tokens;
  }
  return { read, out, requests: seen.size };
}

function makeRun(home, runId, { final = null, script = true, ageMs = 0 } = {}) {
  const sdir = join(home, ".claude", "projects", PROJ, SID);
  const dir = join(sdir, "subagents", "workflows", runId);
  mkdirSync(dir, { recursive: true });
  for (const f of ["journal.jsonl", "agent-a1.jsonl", "agent-a2.jsonl", "agent-a2.meta.json"]) copyFileSync(join(FIX, f), join(dir, f));
  mkdirSync(join(sdir, "workflows", "scripts"), { recursive: true });
  if (script) writeFileSync(join(sdir, "workflows", "scripts", `demo-flow-${runId}.js`), "// синтетика\n");
  if (final) {
    const o = JSON.parse(readFileSync(join(FIX, final), "utf8"));
    o.runId = runId;
    o.startTime = Date.now() - 600_000 - ageMs;
    writeFileSync(join(sdir, "workflows", `${runId}.json`), JSON.stringify(o));
  }
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    for (const p of [join(dir, "journal.jsonl"), join(dir, "agent-a1.jsonl"), join(dir, "agent-a2.jsonl"), join(dir, "agent-a2.meta.json"), dir])
      utimesSync(p, t, t);
    if (final) utimesSync(join(sdir, "workflows", `${runId}.json`), t, t);
  }
  return { sdir, dir };
}

function liveSession(home, pid = process.pid) {
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(home, ".claude", "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: SID, cwd: "/synthetic/project", status: "busy" }));
  writeFileSync(join(home, ".claude", "sessions", `${pid}.key`), "НЕ-ЧИТАТЬ");
}

function check(text) {
  const parsed = parseOutput(text);
  assert.deepEqual(parsed.warnings, []);
  for (const m of MARKERS) assert.ok(!text.includes(m), `output doesn't contain "${m}"`);
  return parsed;
}

test("metadata: streamable, effects only cmux.focus, no secrets", () => {
  const pm = readPluginMeta(PLUGIN);
  assert.equal(pm.id, "agents");
  assert.equal(pm.meta.type, "streamable");
  assert.deepEqual(pm.meta.effects, ["cmux.focus"]);
  assert.deepEqual(pm.meta.secrets, []);
});

test("Spend: dedup by requestId, max per field, lines without usage are ignored", () => {
  const s = new Spend();
  const a = (req, u, mid = "m") => JSON.stringify({ type: "assistant", requestId: req, message: { id: mid, usage: u } });
  const u = (i, cw, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: o });
  s.addLine(a("r1", u(1, 10, 100, 5)));
  s.addLine(a("r1", u(1, 10, 100, 5)));
  s.addLine(a("r1", u(1, 10, 100, 9)));
  s.addLine(a("r2", u(2, 20, 200, 1)));
  s.addLine(JSON.stringify({ type: "user", message: { content: "x" } }));
  s.addLine("{битая строка с \"usage\"");
  s.addLine(JSON.stringify({ type: "assistant", message: { id: "only-mid", usage: u(3, 0, 0, 0) } }));
  s.addLine(JSON.stringify({ type: "assistant", message: { id: "only-mid", usage: u(3, 0, 0, 0) } }));
  assert.deepEqual(s.total, { input: 6, cacheWrite: 30, cacheRead: 300, output: 10 });
  assert.equal(s.requests, 3);
});

test("Tail: complete lines only, the tail is appended later; a replaced file — from the start", () => {
  const home = tempHome("ah-ag-");
  try {
    const f = join(home, "x.jsonl");
    writeFileSync(f, "a\nb\nc");
    const t = new Tail(f);
    assert.deepEqual(t.read().lines, ["a", "b"]);
    assert.deepEqual(t.read().lines, []);
    appendFileSync(f, "d\ne\n");
    assert.deepEqual(t.read().lines, ["cd", "e"]);
    unlinkSync(f);
    writeFileSync(f, "z\n");
    assert.deepEqual(t.read().lines, ["z"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Tail: a line longer than a chunk (4 MB) is skipped entirely, the following ones are read", () => {
  const home = tempHome("ah-ag-");
  try {
    const f = join(home, "big.jsonl");
    writeFileSync(f, "first\n" + "x".repeat(5 * 1024 * 1024) + "\nafter\n");
    const t = new Tail(f);
    const got = [];
    for (let i = 0; i < 10; i++) {
      const r = t.read(64 * 1024 * 1024);
      got.push(...r.lines);
      if (!r.more) break;
    }
    assert.deepEqual(got, ["first", "after"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("running workflow: phase, agents, spend matches the manual count", () => {
  const home = tempHome("ah-ag-");
  try {
    const { dir } = makeRun(home, "wf_run-0001");
    liveSession(home);
    const tr = new Tracker({ home });
    const parsed = check(tr.tick({ discover: true }));
    const run = [...tr.runs.values()][0];
    const manual = manualSpend([join(dir, "agent-a1.jsonl"), join(dir, "agent-a2.jsonl")]);
    assert.equal(run.spend.read, manual.read);
    assert.equal(run.spend.read, 54_515);
    assert.equal(run.spend.total.output, manual.out);
    assert.equal(run.spend.requests, manual.requests);
    assert.equal(parsed.status, "ok");
    assert.deepEqual(parsed.events, []);
    const title = parsed.body[0].title;
    assert.match(title, /^demo-flow — идёт, фаза Build/);
    // activity= for the hub's "safe to shut down?" verdict: a running workflow and how long it has been running
    assert.equal(parsed.activity.length, 1);
    assert.match(parsed.activity[0], /^Прогон «demo-flow» идёт, \d+ (с|мин)$/);
    const text = parsed.body.map((i) => i.title).join("\n");
    assert.match(text, /Агенты: 1 работает, 1 готово, 1 с ошибкой/);
    assert.match(text, /Прочитано 55 тыс/);
    assert.match(text, /5 запросов/);
    assert.match(text, /Сессия «.+» открыта/);
    assert.match(text, /только во вкладке сессии/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tail by offset: appended requests are counted once, an unfinished line — after the line ends", () => {
  const home = tempHome("ah-ag-");
  try {
    const { dir } = makeRun(home, "wf_run-0002");
    liveSession(home);
    const tr = new Tracker({ home });
    tr.tick({ discover: true });
    const run = [...tr.runs.values()][0];
    const before = run.spend.read;
    const extra = JSON.stringify({ type: "assistant", requestId: "req_new", message: { id: "msg_new", usage: { input_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 } } });
    appendFileSync(join(dir, "agent-a1.jsonl"), extra + "\n" + extra + "\n" + extra.slice(0, 40));
    tr.tick();
    assert.equal(run.spend.read, before + 1101);
    appendFileSync(join(dir, "agent-a1.jsonl"), extra.slice(40) + "\n");
    tr.tick();
    assert.equal(run.spend.read, before + 1101, "same requestId — not doubled");
    assert.equal(run.spend.requests, 6);
    const manual = manualSpend([join(dir, "agent-a1.jsonl"), join(dir, "agent-a2.jsonl")]);
    assert.equal(run.spend.read, manual.read);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cmux tab from claude-hook-sessions.json → a cmux.focus offer; notification text isn't read", () => {
  const home = tempHome("ah-ag-");
  try {
    makeRun(home, "wf_focus-0001");
    liveSession(home);
    const surf = "11111111-2222-4333-8444-555555555555";
    const ws = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    mkdirSync(join(home, ".cmuxterm"), { recursive: true });
    writeFileSync(
      join(home, ".cmuxterm", "claude-hook-sessions.json"),
      JSON.stringify({ version: 1, activeSessionsBySurface: {}, sessions: { [SID]: { sessionId: SID, surfaceId: surf, workspaceId: ws, agentLifecycle: "running", lastBody: "СИНТЕТИЧЕСКИЙ-ТЕКСТ-УВЕДОМЛЕНИЯ", lastSubtitle: "СИНТЕТИЧЕСКИЙ-ТЕКСТ", pid: process.pid } } }),
    );
    const parsed = check(new Tracker({ home }).tick({ discover: true }));
    const focus = parsed.body.find((i) => i.effect && i.effect.startsWith("cmux.focus"));
    assert.equal(focus.effect, `cmux.focus ${surf} workspaceId=${ws}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("finished workflow: name from the result, \"done\", totalTokens isn't used; killed → wf-failed", () => {
  const home = tempHome("ah-ag-");
  try {
    makeRun(home, "wf_done-0001", { final: "wf_completed.json", ageMs: 60_000 });
    makeRun(home, "wf_kill-0001", { final: "wf_killed.json", ageMs: 120_000 });
    const tr = new Tracker({ home });
    const parsed = check(tr.tick({ discover: true }));
    const text = parsed.body.map((i) => i.title).join("\n");
    assert.match(text, /demo-review — готово за 10 мин/);
    assert.match(text, /demo-review — остановлен через 10 мин/);
    assert.deepEqual(parsed.events, ["wf-failed-wf_kill-0001"]);
    assert.equal(parsed.status, "wait");
    // stopped by the user (killed) — the header and tile say "stopped", not "failed"; wait and wf-failed remain
    assert.equal(parsed.header[0].title, "Прогон «demo-review» остановлен");
    assert.equal(parsed.header[0].params.tile, "1 стоп", "the tile fits the sidebar badge (6 chars)");
    // no workflows running — activity="" (the plugin takes part in the "safe to shut down?" verdict and is quiet)
    assert.deepEqual(parsed.activity, []);
    const en = check(new Tracker({ home, lang: "en" }).tick({ discover: true }));
    assert.equal(en.header[0].title, 'Run "demo-review" was stopped');
    assert.equal(en.header[0].params.tile, "1 stop");
    // the wait status label is shared by "failed", "stopped", "no session": under a "stopped" header there's no "failed"
    const { meta } = readPluginMeta(PLUGIN);
    assert.doesNotMatch(meta.statuses.wait.label, /упал/);
    assert.match(meta.statuses.wait.hint, /остановлен/);
    assert.doesNotMatch(meta.i18n.en.statuses?.wait?.label ?? "", /failed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("orphaned workflow: no result, no session, quiet > 5 min → wf-orphaned; with a live session — running", () => {
  const home = tempHome("ah-ag-");
  try {
    makeRun(home, "wf_orph-0001", { ageMs: 10 * 60_000 });
    let tr = new Tracker({ home });
    let parsed = check(tr.tick({ discover: true }));
    assert.deepEqual(parsed.events, ["wf-orphaned-wf_orph-0001"]);
    liveSession(home);
    tr = new Tracker({ home });
    parsed = check(tr.tick({ discover: true }));
    assert.deepEqual(parsed.events, []);
    assert.match(parsed.body[0].title, /идёт/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("workflows older than 12 h aren't shown; broken result → source-broken", () => {
  const home = tempHome("ah-ag-");
  try {
    makeRun(home, "wf_old-0001", { final: "wf_completed.json", ageMs: 13 * 3600_000 });
    let parsed = check(new Tracker({ home }).tick({ discover: true }));
    assert.match(parsed.header[0].title, /^Фоновых прогонов нет/);
    const { sdir } = makeRun(home, "wf_bad-0001", { final: "wf_completed.json" });
    writeFileSync(join(sdir, "workflows", "wf_bad-0001.json"), "{не json");
    parsed = check(new Tracker({ home }).tick({ discover: true }));
    assert.ok(parsed.events.includes("source-broken"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("finished workflow cache: after a restart the numbers are the same without re-reading transcripts", () => {
  const home = tempHome("ah-ag-");
  try {
    const { dir } = makeRun(home, "wf_done-0002", { final: "wf_completed.json", ageMs: 60_000 });
    const cachePath = join(home, "cache", "runs.json");
    const tr = new Tracker({ home, cachePath });
    tr.tick({ discover: true });
    const read = [...tr.runs.values()][0].spend.read;
    assert.ok(existsSync(cachePath));
    unlinkSync(join(dir, "agent-a1.jsonl"));
    const tr2 = new Tracker({ home, cachePath });
    tr2.tick({ discover: true });
    assert.equal([...tr2.runs.values()][0].spend.read, read);
    assert.ok(!readFileSync(cachePath, "utf8").includes("СИНТЕТИЧЕСК"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugin process: frames via ~~~, refresh from stdin yields a new frame, end of stdin — exit", async () => {
  const home = tempHome("ah-ag-");
  try {
    const { dir } = makeRun(home, "wf_live-0001");
    liveSession(home);
    const child = spawn(process.execPath, [PLUGIN], {
      env: { HOME: home, PATH: "/usr/bin:/bin", AGENTHUB_AGENTS_TICK_MS: "500", AGENTHUB_PLUGIN_CACHE_PATH: join(home, "cache") },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const frames = [];
    const waiters = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s) => {
      buf += s;
      let i;
      while ((i = buf.indexOf("\n~~~\n")) >= 0) {
        frames.push(buf.slice(0, i));
        buf = buf.slice(i + 5);
        waiters.shift()?.();
      }
    });
    const next = (n) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("no frame")), 5000);
        const check = () => (frames.length >= n ? (clearTimeout(t), res(frames[n - 1])) : waiters.push(check));
        check();
      });
    const f1 = await next(1);
    assert.match(f1, /5 запросов/);
    const extra = JSON.stringify({ type: "assistant", requestId: "req_live", message: { id: "msg_live", usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 } } });
    appendFileSync(join(dir, "agent-a2.jsonl"), extra + "\n");
    child.stdin.write(JSON.stringify({ type: "refresh", reason: "Manual" }) + "\n");
    const f2 = await next(2);
    assert.match(f2, /6 запросов/);
    check(f2);
    const exited = new Promise((res) => child.on("exit", (code) => res(code)));
    child.stdin.end();
    assert.equal(await exited, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Tail: a line didn't fit in the remaining budget — \"more available\", not \"waiting for the line end\"", () => {
  const home = tempHome("ah-ag-");
  try {
    const f = join(home, "x.jsonl");
    const l = (c) => c.repeat(999) + "\n";
    writeFileSync(f, l("a") + l("b") + l("c"));
    const t = new Tail(f);
    const r1 = t.read(1500);
    assert.equal(r1.lines.length, 1);
    assert.equal(r1.more, true);
    const r2 = t.read(500); // no newline in the remaining budget
    assert.deepEqual(r2, { lines: [], bytes: 0, more: true });
    const r3 = t.read();
    assert.equal(r3.lines.length, 2);
    assert.equal(r3.more, false);
    // an unfinished last line at the end of the file — still "waiting", not "more available"
    appendFileSync(f, "недописано");
    assert.deepEqual(t.read(), { lines: [], bytes: 0, more: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tick budget ran out mid-line: a finished workflow isn't settled until everything is read; cache — complete numbers", () => {
  const home = tempHome("ah-ag-");
  try {
    const { dir } = makeRun(home, "wf_big-0001", { final: "wf_completed.json", ageMs: 60_000 });
    const pad = "p".repeat(900);
    const u = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
    for (const a of ["b1", "b2"]) {
      let text = "";
      for (let i = 0; i < 20; i++) text += JSON.stringify({ type: "assistant", requestId: `req_${a}_${i}`, message: { id: `msg_${a}_${i}`, usage: u }, pad }) + "\n";
      writeFileSync(join(dir, `agent-${a}.jsonl`), text);
    }
    // the log is long too: five agents j* with a result, lines ~1 KB
    for (let i = 0; i < 5; i++) appendFileSync(join(dir, "journal.jsonl"), JSON.stringify({ type: "result", agentId: `j${i}`, pad }) + "\n");
    const manual = manualSpend(["agent-a1.jsonl", "agent-a2.jsonl", "agent-b1.jsonl", "agent-b2.jsonl"].map((f) => join(dir, f)));
    const cachePath = join(home, "cache", "runs.json");
    const tr = new Tracker({ home, cachePath, readBudget: 2500 });
    tr.tick({ discover: true });
    const run = [...tr.runs.values()][0];
    assert.equal(run.settled, false, "not everything read — not settled");
    let ticks = 1;
    while (!run.settled && ticks < 200) {
      tr.tick();
      ticks++;
    }
    assert.ok(run.settled);
    assert.ok(ticks > 5, `read in parts: ${ticks} ticks`);
    assert.equal(run.spend.requests, manual.requests);
    assert.equal(run.spend.read, manual.read);
    for (let i = 0; i < 5; i++) assert.equal(run.agents.get(`j${i}`)?.state, "done", `log fully read: j${i}`);
    const tr2 = new Tracker({ home, cachePath });
    tr2.tick({ discover: true });
    const back = [...tr2.runs.values()][0];
    assert.equal(back.spend.requests, manual.requests, "the cache has complete numbers");
    assert.equal(back.spend.read, manual.read);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const lstartUtc = (pid) => execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { TZ: "UTC", LC_ALL: "C", PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trim();

test("session liveness: pid alive but procStart differs (pid reused) — session dead, workflow without a result is orphaned", () => {
  const home = tempHome("ah-ag-");
  try {
    // pure function: start time is compared, a whole hour of difference is the same second in another zone
    const real = parseLstartUtc(lstartUtc(process.pid));
    const fmt = (sec) => new Date(sec * 1000).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, (_, d, dd, mon, y, t) => `${d} ${mon} ${String(Number(dd)).padStart(2)} ${t} ${y}`);
    assert.ok(pidsAlive([process.pid], new Map([[process.pid, fmt(real)]])).has(process.pid));
    assert.ok(pidsAlive([process.pid], new Map([[process.pid, fmt(real + 3600)]])).has(process.pid), "zone shift by an hour");
    assert.ok(!pidsAlive([process.pid], new Map([[process.pid, fmt(real - 37 * 60)]])).has(process.pid), "another process");
    assert.ok(pidsAlive([process.pid]).has(process.pid), "without procStart — by signal");
    assert.ok(pidsAlive([process.pid], new Map([[process.pid, "Thu Jan  1 00:00:00 2015"]]), { psStarts: () => new Map() }).has(process.pid), "ps didn't answer — by signal");
    // a workflow without a result, log quiet for 10 min, a session file with a live pid but a foreign start time
    makeRun(home, "wf_reuse-0001", { ageMs: 10 * 60_000 });
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    const sessFile = join(home, ".claude", "sessions", `${process.pid}.json`);
    writeFileSync(sessFile, JSON.stringify({ pid: process.pid, sessionId: SID, cwd: "/synthetic/project", name: "p", procStart: fmt(real - 37 * 60) }));
    let parsed = check(new Tracker({ home }).tick({ discover: true }));
    assert.deepEqual(parsed.events, ["wf-orphaned-wf_reuse-0001"]);
    assert.match(parsed.body.map((i) => i.title).join("\n"), /Сессия «p» закрыта/);
    writeFileSync(sessFile, JSON.stringify({ pid: process.pid, sessionId: SID, cwd: "/synthetic/project", name: "p", procStart: lstartUtc(process.pid) }));
    parsed = check(new Tracker({ home }).tick({ discover: true }));
    assert.deepEqual(parsed.events, []);
    assert.match(parsed.body.map((i) => i.title).join("\n"), /Сессия «p» открыта/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("broken result in English: details — in English", () => {
  const home = tempHome("ah-ag-");
  try {
    const { sdir } = makeRun(home, "wf_bad-0002", { final: "wf_completed.json" });
    writeFileSync(join(sdir, "workflows", "wf_bad-0002.json"), "{не json");
    makeRun(home, "wf_bad-0003", { final: "wf_completed.json" });
    writeFileSync(join(sdir, "workflows", "wf_bad-0003.json"), JSON.stringify({ workflowName: "x" }));
    const en = new Tracker({ home, lang: "en" }).tick({ discover: true });
    check(en);
    assert.match(en, /--wf_bad-0002\.json: not JSON/);
    assert.match(en, /--wf_bad-0003\.json: no status/);
    assert.doesNotMatch(en, /нет status|не JSON|Unexpected/);
    const ru = new Tracker({ home }).tick({ discover: true });
    assert.match(ru, /wf_bad-0002\.json: не JSON/);
    assert.match(ru, /wf_bad-0003\.json: нет status/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
