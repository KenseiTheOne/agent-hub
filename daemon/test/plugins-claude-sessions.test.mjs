// The claude-sessions plugin (streamable): agents as the source of truth, sessions/*.json hints, binding to a cmux tab,
// liveness via kill -0 + procStart with a time zone correction, "died mid-turn", corruption → unknown + source-broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsMod from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOutput, splitFrames } from "../lib/output.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(REPO, "plugins/claude-sessions");
const FILE = join(DIR, "claude-sessions.mjs");
const FIX = join(DIR, "fixtures");
const C = await import(FILE);

const SID = {
  busy: "11111111-1111-4111-8111-111111111111",
  wait: "22222222-2222-4222-8222-222222222222",
  idle: "33333333-3333-4333-8333-333333333333",
  deadCmux: "44444444-4444-4444-8444-444444444444",
  shell: "66666666-6666-4666-8666-666666666666",
  reused: "77777777-7777-4777-8777-777777777777",
};

function sleeper() {
  const p = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  return p;
}

async function deadPid() {
  const p = spawn("/usr/bin/true", [], { stdio: "ignore" });
  await new Promise((r) => p.on("exit", r));
  return p.pid;
}

// `ps -o lstart` with TZ=UTC — this is how Claude Code writes procStart
function lstartUtc(pid) {
  return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { TZ: "UTC", LC_ALL: "C", PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trim();
}

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

async function world() {
  const root = mkdtempSync(join(tmpdir(), "ah-cs-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".claude/sessions"), { recursive: true });
  mkdirSync(join(home, ".cmuxterm"), { recursive: true });
  mkdirSync(bin);
  const procs = { busy: sleeper(), wait: sleeper(), idle: sleeper(), shell: sleeper(), reused: sleeper() };
  await new Promise((r) => setTimeout(r, 100));
  const vars = {
    HOME: home,
    PID_BUSY: procs.busy.pid,
    PID_WAIT: procs.wait.pid,
    PID_IDLE: procs.idle.pid,
    PID_DEAD: await deadPid(),
    START_BUSY: C.parseLstartUtc(lstartUtc(procs.busy.pid)),
    NOW_SEC: Math.floor(Date.now() / 1000),
  };
  const w = {
    root,
    home,
    bin,
    vars,
    procs,
    setAgents(text) {
      writeFileSync(join(root, "agents.out"), text);
      writeFileSync(join(bin, "claude"), `#!/bin/sh\n[ "$1 $2" = "agents --json" ] || exit 64\ncat '${join(root, "agents.out")}'\n`);
      chmodSync(join(bin, "claude"), 0o755);
    },
    agentsFixture(filter = () => true) {
      const list = JSON.parse(fill(readFileSync(join(FIX, "agents.json"), "utf8"), vars)).filter(filter);
      return JSON.stringify(list);
    },
    hint(pid, { sid, status = "idle", name = "hint", procStart, updated = Date.now() }) {
      const t = fill(readFileSync(join(FIX, "session.template.json"), "utf8"), {
        ...vars,
        PID: pid,
        SID: sid,
        DIR: name,
        NAME: name,
        STATUS: status,
        PROCSTART: procStart ?? lstartUtc(pid),
        UPDATED: updated,
      });
      writeFileSync(join(home, ".claude/sessions", `${pid}.json`), t);
    },
    stop() {
      for (const p of Object.values(procs)) p.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
  writeFileSync(join(home, ".cmuxterm/claude-hook-sessions.json"), fill(readFileSync(join(FIX, "cmux.template.json"), "utf8"), vars));
  // a key next to the session file: the plugin doesn't open it (mode 000 — opening would fail)
  writeFileSync(join(home, ".claude/sessions", `${procs.busy.pid}.0123abcd.key`), "synthetic");
  chmodSync(join(home, ".claude/sessions", `${procs.busy.pid}.0123abcd.key`), 0o000);
  w.setAgents(w.agentsFixture());
  return w;
}

// Run streamable the way the core does: stdin open, frames separated by `~~~`.
function startPlugin(w, extraEnv = {}) {
  const child = spawn(process.execPath, [FILE], {
    env: { HOME: w.home, PATH: "/usr/bin:/bin", AGENTHUB_TEST_BIN_DIR: w.bin, AGENTHUB_TEST_POLL_MS: "150", ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    for (const wt of [...waiters]) wt();
  });
  return {
    child,
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    },
    // the next frame satisfying the condition
    frame(pred = () => true, timeoutMs = 8000) {
      return new Promise((resolveFrame, reject) => {
        const timer = setTimeout(() => reject(new Error(`no frame; output:\n${buf}`)), timeoutMs);
        const check = () => {
          let idx;
          while ((idx = buf.indexOf("\n~~~\n")) >= 0) {
            const text = buf.slice(0, idx);
            buf = buf.slice(idx + 5);
            if (pred(text)) {
              clearTimeout(timer);
              waiters.splice(waiters.indexOf(check), 1);
              resolveFrame({ text, parsed: parseOutput(text) });
              return;
            }
          }
        };
        waiters.push(check);
        check();
      });
    },
    async stop() {
      child.stdin.end();
      await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
    },
  };
}

const byTitle = (items, re) => items.find((i) => re.test(i.title));

test("claude-sessions: frame — waiting ones on top, session parameters for the core, cmux tab, died per cmux", async () => {
  const w = await world();
  const p = startPlugin(w);
  try {
    const { parsed, text } = await p.frame();
    assert.deepEqual(parsed.warnings, [], text);
    assert.equal(parsed.status, "wait");
    // the working sessions are still counted next to the waiting one
    assert.match(parsed.header[0].title, /^1 сессия ждёт вас( · \d+ в работе)?$/);
    assert.match(parsed.header[0].params.tile, /^1 ждёт( · \d+ раб\.)?$/);
    // the waiting one is first among sessions; a foreign "| bash=evil" in the name didn't become a parameter
    const sessions = parsed.body.filter((i) => i.params.session);
    assert.equal(sessions[0].params.session, SID.wait);
    // a folder inside home is "~/…", not a truncated "/Projects/…"
    assert.equal(sessions[0].params.sessionCwd, "~/Projects/Beta");
    assert.equal(sessions[0].params.pid, String(w.vars.PID_WAIT));
    assert.equal(sessions[0].params.sessionStatus, "waiting");
    assert.equal(sessions[0].params.waitingFor, "permission prompt");
    assert.equal(sessions[0].params.sessionName, "beta ¦ bash=evil");
    assert.equal(sessions[0].event, `waiting:${SID.wait}`);
    assert.equal(sessions[0].status, "wait");
    assert.ok(!("bash" in sessions[0].params));
    const busy = sessions.find((s) => s.params.session === SID.busy);
    assert.equal(busy.params.surfaceId, "AAAAAAAA-0000-4000-8000-000000000001");
    assert.equal(busy.params.workspaceId, "BBBBBBBB-0000-4000-8000-000000000001");
    assert.match(busy.title, /^alpha-refactor — работает$/);
    // offers to the core: switch to the tab, interrupt the turn (busy only), stop — arguments are only the id
    const effects = parsed.body.map((i) => i.effect).filter(Boolean);
    assert.ok(effects.includes(`cmux.focus AAAAAAAA-0000-4000-8000-000000000001 workspaceId=BBBBBBBB-0000-4000-8000-000000000001`), effects.join("\n"));
    if (/^[0-9a-f-]{36}$/i.test(SID.busy)) {
      assert.ok(effects.includes(`session.interrupt ${SID.busy}`));
      assert.ok(effects.includes(`session.stop ${SID.busy}`));
      assert.ok(!effects.includes(`session.interrupt ${SID.idle}`), "only a running turn can be interrupted");
    }
    const idle = sessions.find((s) => s.params.session === SID.idle);
    assert.match(idle.title, /свободна \(не во вкладке cmux\)/);
    // cmux: running + dead pid + fresh record → died mid-turn; no session= (there's no signature there)
    const died = byTitle(parsed.body, /оборвалась посреди работы/);
    assert.equal(died.event, `died:${SID.deadCmux}`);
    assert.ok(!died.params.session);
    assert.ok(parsed.events.includes(`waiting:${SID.wait}`));
    // text from cmux (lastBody etc.) doesn't get into the output
    assert.doesNotMatch(text, /синтетика|synthetic\.jsonl/);
  } finally {
    await p.stop();
    w.stop();
  }
});

test("claude-sessions: hints — status shell, pid reused (procStart mismatch), one-hour zone shift", async () => {
  const w = await world();
  // a live session only in the file, status "shell", procStart shifted by exactly an hour — the same second in another zone
  const real = C.parseLstartUtc(lstartUtc(w.procs.shell.pid));
  const shifted = new Date((real + 3600) * 1000).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, (_, d, dd, mon, y, t) => `${d} ${mon} ${String(Number(dd)).padStart(2)} ${t} ${y}`);
  w.hint(w.procs.shell.pid, { sid: SID.shell, status: "shell", name: "shelly", procStart: shifted });
  // a live pid, but the start time is off by 37 minutes — it's another process
  const other = new Date((C.parseLstartUtc(lstartUtc(w.procs.reused.pid)) - 37 * 60) * 1000).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, (_, d, dd, mon, y, t) => `${d} ${mon} ${String(Number(dd)).padStart(2)} ${t} ${y}`);
  w.hint(w.procs.reused.pid, { sid: SID.reused, status: "busy", name: "reused", procStart: other });
  const p = startPlugin(w);
  try {
    const { parsed, text } = await p.frame();
    const shell = parsed.body.find((i) => i.params.session === SID.shell);
    assert.ok(shell, text);
    assert.match(shell.title, /^shelly — shell \(не во вкладке cmux\)$/);
    assert.ok(!shell.params.sessionStatus, "shell is not a registry status");
    assert.ok(!parsed.body.some((i) => i.params.session === SID.reused), "a reused pid is not a session");
    // busy per the file and not alive → died mid-turn (fresh record)
    const died = parsed.body.find((i) => i.event === `died:${SID.reused}`);
    assert.match(died.title, /номер процесса занят другим/);
  } finally {
    await p.stop();
    w.stop();
  }
});

test(`claude-sessions: a busy session vanished and the process died → "died mid-turn"; refresh from stdin`, async () => {
  const w = await world();
  const p = startPlugin(w, { AGENTHUB_TEST_POLL_MS: "60000" });
  try {
    await p.frame();
    w.procs.busy.kill("SIGKILL");
    await new Promise((r) => w.procs.busy.on("exit", r));
    w.setAgents(w.agentsFixture((a) => a.sessionId !== SID.busy));
    p.send({ type: "fileChanged", path: join(w.home, ".claude/sessions/x.json") });
    const { parsed } = await p.frame((t) => t.includes(`died:${SID.busy}`));
    const died = parsed.body.find((i) => i.event === `died:${SID.busy}`);
    assert.match(died.title, /^alpha-refactor — оборвалась посреди работы \(процесс завершился\)$/);
    assert.equal(parsed.status, "wait");
    // the session came back with the same id (resume) — the "died" record is cleared
    w.setAgents(JSON.stringify([{ pid: w.vars.PID_IDLE, cwd: "/x", kind: "interactive", startedAt: 1, sessionId: SID.busy, name: "alpha-refactor", status: "idle" }]));
    p.send({ type: "refresh", reason: "Manual" });
    const back = await p.frame((t) => !t.includes(`died:${SID.busy}`));
    assert.ok(back.parsed.body.some((i) => i.params.session === SID.busy));
  } finally {
    await p.stop();
    w.stop();
  }
});

test("claude-sessions: corrupted agents output → unknown + source-broken; no claude — files only", async () => {
  const w = await world();
  rmSync(join(w.home, ".cmuxterm/claude-hook-sessions.json")); // without the one that died per cmux: its wait would have masked unknown
  w.setAgents('{"sessions": []}');
  w.hint(w.procs.idle.pid, { sid: SID.idle, status: "idle", name: "gamma-file" });
  const p = startPlugin(w);
  try {
    const { parsed, text } = await p.frame();
    assert.equal(parsed.status, "unknown");
    assert.ok(parsed.events.includes("source-broken"));
    assert.match(text, /claude agents --json: не массив/);
    assert.ok(parsed.body.some((i) => i.params.session === SID.idle));
    assert.match(text, /Данные из файла сессии/);
    // an unknown status in a record is also form corruption
    w.setAgents(JSON.stringify([{ pid: w.vars.PID_IDLE, sessionId: SID.idle, status: "thinking", name: "g" }]));
    p.send({ type: "refresh" });
    const f2 = await p.frame((t) => t.includes("thinking"));
    assert.equal(f2.parsed.status, "unknown");
    assert.ok(f2.parsed.events.includes("source-broken"));
  } finally {
    await p.stop();
    w.stop();
  }
  const w2 = await world();
  rmSync(join(w2.bin, "claude"));
  rmSync(join(w2.home, ".cmuxterm/claude-hook-sessions.json"));
  const p2 = startPlugin(w2, { PATH: "/nonexistent" });
  try {
    const { parsed, text } = await p2.frame();
    assert.equal(parsed.status, "unknown");
    // claude not found — the header says exactly that (no advice to update Claude Code), not repeated in the line below
    assert.equal(parsed.header[0].title, "Не найден claude — нужен Claude Code");
    assert.ok(parsed.events.includes("source-broken"));
    assert.doesNotMatch(text, /обновите/);
    assert.equal(text.split("Не найден claude").length, 2, "the reason appears once");
    assert.match(text, /только файлы/);
  } finally {
    await p2.stop();
    w2.stop();
  }
});

test("claude-sessions: closed stdin — the plugin exits", async () => {
  const w = await world();
  const p = startPlugin(w);
  try {
    await p.frame();
    const t0 = Date.now();
    await p.stop();
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(p.child.exitCode, 0);
  } finally {
    w.stop();
  }
});

test("claude-sessions: pure functions — start time, zones, source parsing", () => {
  assert.equal(C.parseLstartUtc("Thu Oct 22 20:46:52 2026"), Date.UTC(2026, 9, 22, 20, 46, 52) / 1000);
  assert.equal(C.parseLstartUtc("Mon Nov  9 01:02:03 2026"), Date.UTC(2026, 10, 9, 1, 2, 3) / 1000);
  assert.equal(C.parseLstartUtc("вчера"), null);
  assert.equal(C.sameStart(1000, 1001), true);
  assert.equal(C.sameStart(1000 + 3600, 1000), true);
  assert.equal(C.sameStart(1000 + 2 * 3600 + 1, 1000), true);
  assert.equal(C.sameStart(1000 + 37 * 60, 1000), false);
  assert.equal(C.sameStart(1000 + 20 * 3600, 1000), false);
  assert.equal(C.sameStart(null, 1000), null);
  const m = C.parsePsStarts("  123 Thu Oct 22 20:46:52 2026\n  45 Mon Nov  9 01:02:03 2026\n");
  assert.equal(m.get(45), Date.UTC(2026, 10, 9, 1, 2, 3) / 1000);
  assert.equal(C.parseAgents("[]").ok, true);
  assert.equal(C.parseAgents("{}").ok, false);
  assert.deepEqual(C.parseAgents('[{"pid":"1"}]').problems, ["agents:bad-record"]);
  assert.equal(C.problemText("agents:bad-record"), "claude agents --json: запись без pid/sessionId/status");
  assert.equal(C.problemText("agents:bad-status:thinking", "en"), 'claude agents --json: unknown status "thinking"');
  assert.equal(C.problemText("agents:failed:timeout", "en"), "claude agents --json: no answer within 5 s");
  assert.equal(C.parseCmux('{"sessions":[]}').ok, false);
  assert.equal(C.parseCmux('{"version":1,"sessions":{}}').ok, true);
  // "died" per file: only a fresh record; a repeat after the expiry doesn't resurrect it
  const mem = C.newMemory();
  const hint = { pid: 9, sessionId: SID.reused, status: "busy", statusUpdatedAt: 1_000_000, procStart: null };
  const base = { agents: { ok: true, sessions: [], problems: [] }, hints: { hints: new Map([[9, hint]]), problems: [] }, cmux: null, alive: new Map([[9, { alive: false, reason: "нет процесса" }]]), mem };
  assert.equal(C.merge({ ...base, nowMs: 1_000_000 + 1000 }).died.length, 1);
  assert.equal(C.merge({ ...base, nowMs: 1_000_000 + 31 * 60_000 }).died.length, 0);
  assert.equal(C.merge({ ...base, nowMs: 1_000_000 + 32 * 60_000 }).died.length, 0);
  const old = C.merge({ ...base, mem: C.newMemory(), nowMs: 1_000_000 + 3 * 3_600_000 });
  assert.equal(old.died.length, 0, "an old trace after a reboot is not a mid-turn death");
});

test(`memory survives a plugin restart (language change): an expired "cut off" doesn't resurface, waiting isn't reset`, () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-mem-"));
  try {
    const path = join(dir, "memory.json");
    const sid = "11111111-2222-3333-4444-555555555555";
    const wsid = "22222222-2222-3333-4444-555555555555";
    const t0 = Date.parse("2026-11-05T10:00:00Z");
    const hint = { sessionId: sid, pid: 999999, status: "busy", statusUpdatedAt: t0 - 60_000, name: "demo", cwd: "/tmp/demo" };
    const waiting = { sessionId: wsid, pid: 4242, status: "waiting", waitingFor: "permission", name: "w", cwd: "/tmp/w" };
    const input = (now, mem) => ({
      agents: { ok: true, sessions: [waiting] },
      hints: { hints: new Map([[hint.pid, hint]]) },
      cmux: null,
      alive: new Map([[hint.pid, { alive: false, reason: "gone" }]]),
      mem,
      nowMs: now,
    });
    const mem = C.newMemory();
    assert.deepEqual(C.merge(input(t0, mem)).died.map((d) => d.sessionId), [sid]);
    const since = mem.waitingSince.get(wsid);
    assert.deepEqual(C.merge(input(t0 + 31 * 60_000, mem)).died, [], "expired — gone");
    assert.equal(C.saveMemory(path, mem), true);
    assert.equal(C.saveMemory(path, mem), false, "without changes the file isn't rewritten");
    assert.equal(statSyncMode(path), 0o600);
    const back = C.loadMemory(path); // a new plugin process
    assert.deepEqual(C.merge(input(t0 + 32 * 60_000, back)).died, [], "one cleared long ago doesn't resurface");
    assert.equal(back.waitingSince.get(wsid), since, "the waiting time is preserved");
    writeFileSync(path, "{мусор");
    assert.equal(C.loadMemory(path).died.size, 0, "a broken file — clean memory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function statSyncMode(p) {
  return execFileSync("/usr/bin/stat", ["-f", "%Lp", p]).toString().trim() === "600" ? 0o600 : -1;
}

// Effort of the last turn: only metadata fields of the transcript tail (synthetic), cached by (size, mtime).
test("claude-sessions: effort from the transcript tail — perTurnEffort beats effort, API errors and traps in text don't count, ultracode via attachment", () => {
  const text = readFileSync(join(FIX, "transcript.synthetic.jsonl"), "utf8");
  assert.deepEqual(C.effortFromTail(text, { fromStart: true }), { effort: "xhigh", ultracode: true, at: "2026-11-05T10:01:09.000Z" });
  // exit from ultracode later than entry
  const exit = text + JSON.stringify({ type: "attachment", attachment: { type: "ultra_effort_exit" } }) + "\n";
  assert.equal(C.effortFromTail(exit, { fromStart: true }).ultracode, false);
  // api-request later than the reply — its output_config.effort
  const req = text + JSON.stringify({ type: "api-request", params: { output_config: { effort: "max" }, messages: [{ role: "user", content: "СИНТЕТИКА" }] } }) + "\n";
  assert.equal(C.effortFromTail(req, { fromStart: true }).effort, "max");
  // an unknown level and an empty tail — null
  assert.deepEqual(C.effortFromTail(JSON.stringify({ type: "assistant", effort: "ultra" }), { fromStart: true }), { effort: null, ultracode: null, at: null });
  assert.deepEqual(C.effortFromTail(""), { effort: null, ultracode: null, at: null });
  // the tail doesn't start at the file start: the first (cut) line isn't parsed
  const cut = '"perTurnEffort":"max"}\n' + JSON.stringify({ type: "assistant", effort: "low" }) + "\n";
  assert.equal(C.effortFromTail(cut).effort, "low");
  assert.equal(C.projectSlug("/Users/a/src/agent-hub"), "-Users-a-src-agent-hub");
});

test("claude-sessions: readTail — no more than the limit from the end; attachEffort — folder by cwd or by search, cache by (size, mtime)", () => {
  const root = mkdtempSync(join(tmpdir(), "ah-eff-"));
  try {
    const big = join(root, "big.jsonl");
    writeFileSync(big, "x".repeat(10_000) + "\n" + JSON.stringify({ type: "assistant", effort: "high" }) + "\n");
    const t = C.readTail(big, 200);
    assert.ok(t.text.length <= 200);
    assert.equal(t.fromStart, false);
    assert.equal(C.effortFromTail(t.text).effort, "high");
    const home = join(root, "home");
    const sid1 = "11111111-1111-4111-8111-111111111111";
    const sid2 = "22222222-2222-4222-8222-222222222222";
    const cwd = "/Users/x/Projects/Alpha";
    mkdirSync(join(home, ".claude/projects", C.projectSlug(cwd)), { recursive: true });
    mkdirSync(join(home, ".claude/projects/-elsewhere"), { recursive: true });
    const f1 = join(home, ".claude/projects", C.projectSlug(cwd), `${sid1}.jsonl`);
    writeFileSync(f1, readFileSync(join(FIX, "transcript.synthetic.jsonl")));
    fsMod.utimesSync(f1, 1_700_000_000, 1_700_000_000);
    writeFileSync(join(home, ".claude/projects/-elsewhere", `${sid2}.jsonl`), JSON.stringify({ type: "assistant", effort: "low" }) + "\n");
    const cache = C.newEffortCache();
    const list = [{ sessionId: sid1, cwd }, { sessionId: sid2, cwd: "/nowhere" }, { sessionId: "not-a-uuid" }];
    C.attachEffort(list, { home, cache, nowMs: 1 });
    assert.equal(list[0].effort, "xhigh");
    assert.equal(list[0].ultracode, true);
    assert.equal(list[1].effort, "low");
    assert.equal(list[2].effort, undefined);
    // same size and mtime — the file isn't re-read (contents replaced with the same size and time)
    const same = readFileSync(f1, "utf8").replace('"perTurnEffort":"xhigh"', '"perTurnEffort":"max__"');
    writeFileSync(f1, same);
    fsMod.utimesSync(f1, 1_700_000_000, 1_700_000_000);
    const again = [{ sessionId: sid1, cwd }];
    C.attachEffort(again, { home, cache, nowMs: 2 });
    assert.equal(again[0].effort, "xhigh", "cache by (size, mtime)");
    // the file grew — re-read
    writeFileSync(f1, readFileSync(join(FIX, "transcript.synthetic.jsonl"), "utf8") + JSON.stringify({ type: "assistant", perTurnEffort: "medium" }) + "\n");
    C.attachEffort(again, { home, cache, nowMs: 3 });
    assert.equal(again[0].effort, "medium");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude-sessions: the last turn decides effort, no fallback to earlier ones; a huge line after a turn; ultracode survives the mark leaving the tail", () => {
  const A = (o) => JSON.stringify({ type: "assistant", ...o }) + "\n";
  // last assistant without effort — no level (not high from the previous turn); unknown — also none
  assert.equal(C.effortFromTail(A({ effort: "high" }) + A({}), { fromStart: true }).effort, null);
  assert.equal(C.effortFromTail(A({ effort: "low" }) + A({ effort: "auto" }), { fromStart: true }).effort, null);
  // an API error and a sidechain turn don't decide
  assert.equal(C.effortFromTail(A({ effort: "low" }) + A({ effort: "max", isApiErrorMessage: true }) + A({ effort: "max", isSidechain: true }), { fromStart: true }).effort, "low");
  const root = mkdtempSync(join(tmpdir(), "ah-eff2-"));
  try {
    const home = join(root, "home");
    const sid = "33333333-3333-4333-8333-333333333333";
    const cwd = "/Users/x/Projects/Beta";
    const dir = join(home, ".claude/projects", C.projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${sid}.jsonl`);
    const filler = (kb) => {
      let out = "";
      for (let i = 0; i < kb; i++) out += JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } }) + "\n";
      return out;
    };
    // an xhigh turn followed by one 600 KB tool_result line (fresh cache, file not seen before) — the level is still there
    writeFileSync(f, A({ perTurnEffort: "xhigh" }) + JSON.stringify({ type: "user", message: { content: "y".repeat(600 * 1024) } }) + "\n");
    const list = [{ sessionId: sid, cwd }];
    C.attachEffort(list, { home, cache: C.newEffortCache(), nowMs: 1 });
    assert.equal(list[0].effort, "xhigh", "a huge line after the turn");
    // ultracode: entry mark, max turn; then ~560 KB of regular turns without marks
    writeFileSync(f, JSON.stringify({ type: "attachment", attachment: { type: "ultra_effort_enter" } }) + "\n" + A({ effort: "max" }));
    const cache = C.newEffortCache();
    const s1 = [{ sessionId: sid, cwd }];
    C.attachEffort(s1, { home, cache, nowMs: 2 });
    assert.equal(s1[0].ultracode, true);
    fsMod.appendFileSync(f, filler(560) + A({ effort: "max" }));
    const s2 = [{ sessionId: sid, cwd }];
    C.attachEffort(s2, { home, cache, nowMs: 3 });
    assert.equal(s2[0].effort, "max");
    assert.equal(s2[0].ultracode, true, "the mark moved beyond 512 KB, ultracode wasn't turned off");
    // exit from ultracode in the appended part — off; a new turn without effort — no level
    fsMod.appendFileSync(f, JSON.stringify({ type: "attachment", attachment: { type: "ultra_effort_exit" } }) + "\n" + A({}));
    const s3 = [{ sessionId: sid, cwd }];
    C.attachEffort(s3, { home, cache, nowMs: 4 });
    assert.equal(s3[0].ultracode, false);
    assert.equal(s3[0].effort, null);
    // only user records appended — the previous level and state stay
    fsMod.appendFileSync(f, A({ effort: "medium" }));
    C.attachEffort(s3, { home, cache, nowMs: 5 });
    fsMod.appendFileSync(f, filler(3));
    const s4 = [{ sessionId: sid, cwd }];
    C.attachEffort(s4, { home, cache, nowMs: 6 });
    assert.equal(s4[0].effort, "medium");
    assert.equal(s4[0].ultracode, false);
    // the file was rewritten shorter — no carry-over
    writeFileSync(f, A({ effort: "low" }));
    const s5 = [{ sessionId: sid, cwd }];
    C.attachEffort(s5, { home, cache, nowMs: 7 });
    assert.equal(s5[0].effort, "low");
    assert.equal(s5[0].ultracode, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`claude-sessions: the frame has sessionEffort/sessionUltracode on the session and the "by last turn" line; no conversation text`, async () => {
  const w = await world();
  const dir = join(w.home, ".claude/projects", C.projectSlug(join(w.home, "Projects/Alpha")));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID.busy}.jsonl`), readFileSync(join(FIX, "transcript.synthetic.jsonl")));
  const p = startPlugin(w);
  try {
    const { parsed, text } = await p.frame((t) => t.includes("sessionEffort="));
    assert.deepEqual(parsed.warnings, [], text);
    const busy = parsed.body.find((i) => i.params.session === SID.busy);
    assert.equal(busy.params.sessionEffort, "xhigh");
    assert.equal(busy.params.sessionUltracode, "true");
    assert.match(text, /--Effort: xhigh · ⚡ultracode \(по последнему ходу\)/);
    const idle = parsed.body.find((i) => i.params.session === SID.idle);
    assert.equal(idle.params.sessionEffort, undefined);
    assert.doesNotMatch(text, /СИНТЕТИКА/);
  } finally {
    await p.stop();
    w.stop();
  }
});

test("claude-sessions (contract 3): model and sources in the frame — sessionModel, sessionModelSource, sessionEffortSource, sessionAt; /model and /effort commands beat the turn", async () => {
  const w = await world();
  const dir = join(w.home, ".claude/projects", C.projectSlug(join(w.home, "Projects/Alpha")));
  mkdirSync(dir, { recursive: true });
  const rec = (o) => JSON.stringify(o);
  writeFileSync(
    join(dir, `${SID.busy}.jsonl`),
    [
      rec({ type: "user", timestamp: "2026-11-05T10:00:00.000Z", message: { role: "user", content: "СИНТЕТИКА: вопрос" } }),
      rec({ type: "assistant", timestamp: "2026-11-05T10:00:05.000Z", effort: "high", message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "СИНТЕТИКА: ответ" }] } }),
      rec({ type: "user", timestamp: "2026-11-05T10:02:00.000Z", message: { role: "user", content: "<local-command-stdout>Set effort level to max (this session only): СИНТЕТИКА</local-command-stdout>" } }),
      "",
    ].join("\n"),
  );
  const p = startPlugin(w);
  try {
    const { parsed, text } = await p.frame((t) => t.includes("sessionModel="));
    assert.deepEqual(parsed.warnings, [], text);
    const busy = parsed.body.find((i) => i.params.session === SID.busy);
    assert.equal(busy.params.sessionModel, "claude-opus-5-5");
    assert.equal(busy.params.sessionModelSource, "turn");
    assert.equal(busy.params.sessionEffort, "max");
    assert.equal(busy.params.sessionEffortSource, "command");
    assert.equal(busy.params.sessionAt, "2026-11-05T10:02:00.000Z", "the time is that of the freshest model and effort record");
    assert.match(text, /--Модель: claude-opus-5-5\n/);
    assert.match(text, /--Effort: max \(по команде \/effort\)/);
    assert.doesNotMatch(text, /СИНТЕТИКА/);
  } finally {
    await p.stop();
    w.stop();
  }
});

const RU_RE = /[А-Яа-яЁё]/;

test("claude-sessions: in English the corruption details are in English; the header reason depends on the failure kind", () => {
  const frame = (problems, lang, extra = {}) => parseOutput(C.render({ sessions: [], died: [], problems, agentsOk: false, ...extra }, Date.now(), lang));
  // an unknown output shape — advice to update Claude Code; details in the hub language
  let f = frame(["agents:not-array", "hints:bad-file"], "en");
  assert.equal(f.header[0].title, "Can't read the session list — update Claude Code");
  assert.ok(f.events.includes("source-broken"));
  const detail = f.body.find((i) => /^Details:/.test(i.title));
  assert.equal(detail.title, "Details: claude agents --json: not an array; ~/.claude/sessions: a file without pid/sessionId");
  for (const i of [...f.header, ...f.body]) assert.doesNotMatch(i.title, RU_RE, i.title);
  // didn't answer (timeout) — no advice to update
  f = frame(["agents:failed:timeout"], "ru");
  assert.equal(f.header[0].title, "claude agents --json не ответил — список сессий не прочитан");
  assert.match(f.body.map((i) => i.title).join("\n"), /нет ответа за 5 с/);
  // no claude, in English
  f = frame(["claude:not-found"], "en");
  assert.equal(f.header[0].title, "claude not found — Claude Code is needed");
  // no claude: the header is short (it's also the reason in the "Safe to shut down" card, without paths that break there
  // across lines), and the details don't repeat it — where we looked and what to do
  f = frame(["claude:not-found"], "ru");
  assert.equal(f.header[0].title, "Не найден claude — нужен Claude Code");
  assert.doesNotMatch(f.header[0].title, /\//);
  const why = f.body.find((i) => /^Подробности:/.test(i.title));
  assert.equal(why?.title, "Подробности: хаб ищет claude в ~/.local/bin, /opt/homebrew/bin и /usr/local/bin — поставьте Claude Code или положите ссылку на claude в одну из этих папок");
  // sessions exist (from files) but claude doesn't: the corruption line and the details under it use different words
  const waitingByFile = { sessionId: SID.idle, pid: 9, status: "waiting", name: "ES", source: "file" };
  const text = C.render({ sessions: [waitingByFile], died: [], problems: ["claude:not-found"], agentsOk: false }, Date.now(), "ru");
  assert.match(text, /\nНе найден claude — нужен Claude Code \|.*\n--Подробности: хаб ищет claude в/);
  assert.equal(text.match(/не найден/gi).length, 1, "\"не найден\" appears once");
  // sessions exist, only the files are broken — the header is about sessions, the corruption line below with details
  const idle = { sessionId: SID.idle, pid: 9, status: "idle", name: "g", cwd: "/x" };
  f = frame(["cmux:no-sessions"], "en", { sessions: [idle], agentsOk: true });
  assert.equal(f.header[0].title, "All idle");
  const line = f.body.find((i) => i.event === "source-broken");
  assert.equal(line.title, "Some session data can't be read");
  assert.match(C.render({ sessions: [idle], died: [], problems: ["cmux:no-sessions"], agentsOk: true }, Date.now(), "en"), /--Details: cmux claude-hook-sessions\.json: no sessions/);
});

test(`claude-sessions: the waiting tile is inflected; sessionCwd — "~" only for folders inside home`, () => {
  const w = (n) => Array.from({ length: n }, (_, i) => ({ sessionId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, pid: 100 + i, status: "waiting", name: `s${i}` }));
  const tile = (n, lang = "ru") => parseOutput(C.render({ sessions: w(n), died: [], problems: [], agentsOk: true }, Date.now(), lang)).header[0].params.tile;
  assert.equal(tile(1), "1 ждёт");
  assert.equal(tile(2), "2 ждут");
  assert.equal(tile(5), "5 ждут");
  assert.equal(tile(11), "11 ждут");
  assert.equal(tile(21), "21 ждёт");
  assert.equal(tile(1, "en"), "1 waiting");
  assert.equal(C.homeShort("/Users/k/Projects/Alpha", "/Users/k"), "~/Projects/Alpha");
  assert.equal(C.homeShort("/Users/k", "/Users/k"), "~");
  assert.equal(C.homeShort("/Users/k2/x", "/Users/k"), "/Users/k2/x");
  assert.equal(C.homeShort("/opt/x", "/Users/k/"), "/opt/x");
  // in the session line "~" isn't stripped by value parsing
  const s = { sessionId: SID.idle, pid: 9, status: "idle", name: "-~name", cwd: `${process.env.HOME}/Projects/Alpha` };
  const f = parseOutput(C.render({ sessions: [s], died: [], problems: [], agentsOk: true }, Date.now(), "ru"));
  const item = f.body.find((i) => i.params.session === SID.idle);
  assert.equal(item.params.sessionCwd, "~/Projects/Alpha");
  assert.equal(item.params.sessionName, "-~name");
});

test(`claude-sessions: a normal exit (session file removed), claude -p and old memory are not "cut off"; a crashed one (file stayed) is cut off`, () => {
  const sid = "12121212-1212-4121-8121-121212121212";
  const t0 = Date.parse("2026-11-05T10:00:00Z");
  const hint = (o = {}) => ({ pid: 77, sessionId: sid, status: "busy", statusUpdatedAt: t0, procStart: null, name: "n", cwd: "/x", entrypoint: "cli", ...o });
  const busy = { sessionId: sid, pid: 77, status: "busy", name: "n", cwd: "/x", kind: "interactive" };
  const step = (mem, { agents = [], hints = [], now = t0, alive = false }) =>
    C.merge({ agents: { ok: true, sessions: agents, problems: [] }, hints: { hints: new Map(hints.map((h) => [h.pid, h])), problems: [] }, cmux: null, alive: new Map([[77, { alive, reason: "gone" }]]), mem, nowMs: now });
  // 1. busy (file exists) → the process exited and removed the file itself: a normal exit (claude -p reply, "End session", exit)
  let mem = C.newMemory();
  step(mem, { agents: [busy], hints: [hint()], alive: true });
  assert.equal(mem.lastBusy.get(sid).hadFile, true);
  assert.deepEqual(step(mem, { now: t0 + 2000 }).died, [], "file removed — normal exit");
  // a cmux "running" record after a normal exit (the tab didn't update in time) doesn't raise "cut off" either
  mem = C.newMemory();
  step(mem, { agents: [busy], hints: [hint()], alive: true });
  const cmux = { ok: true, bySession: new Map([[sid, { pid: 77, pidStartSeconds: null, surfaceId: null, workspaceId: null, lifecycle: "running", updatedAt: t0 / 1000 }]]) };
  assert.deepEqual(C.merge({ agents: { ok: true, sessions: [], problems: [] }, hints: { hints: new Map(), problems: [] }, cmux, alive: new Map([[77, { alive: false, reason: "gone" }]]), mem, nowMs: t0 + 2000 }).died, []);
  // 2. busy → the process crashed, the file stayed (the file status is no longer busy) → cut off
  mem = C.newMemory();
  step(mem, { agents: [busy], hints: [hint()], alive: true });
  assert.deepEqual(step(mem, { hints: [hint({ status: "idle" })], now: t0 + 2000 }).died.map((d) => d.sessionId), [sid]);
  // 3. claude -p (entrypoint sdk-cli): even with a leftover busy file — not "cut off"; the line says background, without "End"
  mem = C.newMemory();
  const m1 = step(mem, { agents: [busy], hints: [hint({ entrypoint: "sdk-cli" })], alive: true });
  const text = C.render({ ...m1, problems: [] }, t0, "ru");
  assert.match(text, /фоновая \(claude -p\)/);
  assert.doesNotMatch(text, /session\.stop|session\.interrupt/);
  assert.deepEqual(step(mem, { hints: [hint({ entrypoint: "sdk-cli" })], now: t0 + 2000 }).died, []);
  // 4. no session file at all (old Claude Code) — still "cut off"
  mem = C.newMemory();
  step(mem, { agents: [busy], alive: true });
  assert.equal(step(mem, { now: t0 + 2000 }).died.length, 1);
  // 5. memory restored after a long hub downtime: "busy" was seen 3 h ago — an old trace
  const dir = mkdtempSync(join(tmpdir(), "ah-mem2-"));
  try {
    const path = join(dir, "memory.json");
    mem = C.newMemory();
    step(mem, { agents: [busy], alive: true }); // no file — otherwise it would be filtered out as a normal exit
    C.saveMemory(path, mem);
    assert.equal(step(C.loadMemory(path), { now: t0 + 3 * 3_600_000 }).died.length, 0, "an old trace after downtime");
    assert.equal(step(C.loadMemory(path), { now: t0 + 5 * 60_000 }).died.length, 1, "a short restart — the death is visible");
    // memory before 0.3.1 (no seenAt): "seen" is the file write time
    const j = JSON.parse(readFileSync(path, "utf8"));
    for (const [, v] of j.lastBusy) delete v.seenAt;
    writeFileSync(path, JSON.stringify(j));
    fsMod.utimesSync(path, t0 / 1000, t0 / 1000);
    assert.equal(step(C.loadMemory(path), { now: t0 + 3 * 3_600_000 }).died.length, 0);
    assert.equal(step(C.loadMemory(path), { now: t0 + 60_000 }).died.length, 1);
    // seenAt is written with minute precision: a busy session doesn't rewrite the file on every poll
    mem = C.loadMemory(path);
    step(mem, { agents: [busy], alive: true, now: t0 + 10 * 60_000 });
    assert.equal(C.saveMemory(path, mem), true);
    step(mem, { agents: [busy], alive: true, now: t0 + 10 * 60_000 + 2000 });
    assert.equal(C.saveMemory(path, mem), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude-sessions: the effort cache survives a restart — ⚡ultracode doesn't vanish when the mark is more than 2 MB from the end", () => {
  const root = mkdtempSync(join(tmpdir(), "ah-eff3-"));
  try {
    const home = join(root, "home");
    const sid = "34343434-3434-4343-8343-343434343434";
    const cwd = "/Users/x/Projects/Delta";
    const dir = join(home, ".claude/projects", C.projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${sid}.jsonl`);
    const A = (o) => JSON.stringify({ type: "assistant", ...o }) + "\n";
    const filler = (kb) => {
      let out = "";
      for (let i = 0; i < kb; i++) out += JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } }) + "\n";
      return out;
    };
    writeFileSync(f, JSON.stringify({ type: "attachment", attachment: { type: "ultra_effort_enter" } }) + "\n" + A({ effort: "max" }));
    const cache = C.newEffortCache();
    const s1 = [{ sessionId: sid, cwd }];
    C.attachEffort(s1, { home, cache, nowMs: 1 });
    assert.equal(s1[0].ultracode, true);
    // ~1.5 MB appended, then a turn — within the process ultracode carries over
    fsMod.appendFileSync(f, filler(1500) + A({ effort: "xhigh" }));
    C.attachEffort([{ sessionId: sid, cwd }], { home, cache, nowMs: 2 });
    const path = join(root, "effort.json");
    assert.equal(C.saveEffortCache(path, cache), true);
    assert.equal(C.saveEffortCache(path, cache), false, "the result didn't change — the file isn't rewritten");
    assert.equal(statSyncMode(path), 0o600);
    assert.doesNotMatch(readFileSync(path, "utf8"), /xxxx/, "the cache holds no transcript text");
    // another 1.5 MB (the mark is now more than 2 MB from the end) — and a plugin restart
    fsMod.appendFileSync(f, filler(1500) + A({ effort: "high" }));
    const cold = [{ sessionId: sid, cwd }];
    C.attachEffort(cold, { home, cache: C.newEffortCache(), nowMs: 3 });
    assert.equal(cold[0].ultracode, null, "without a saved cache the mark is lost (as before)");
    const back = [{ sessionId: sid, cwd }];
    C.attachEffort(back, { home, cache: C.loadEffortCache(path), nowMs: 3 });
    assert.equal(back[0].effort, "high");
    assert.equal(back[0].ultracode, true, "after a restart ultracode comes from the saved cache");
    writeFileSync(path, "{мусор");
    assert.equal(C.loadEffortCache(path).results.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude-sessions: header counts working sessions next to the waiting ones", () => {
  const s = (status, i) => ({ status, sessionId: `0000000${i}-0000-4000-8000-000000000000`, pid: 100 + i, name: `demo-${i}`, cwd: "/tmp" });
  const sessions = [s("waiting", 1), s("busy", 2), s("busy", 3), s("idle", 4)];
  const en = parseOutput(C.render({ sessions, died: [], problems: [], agentsOk: true }, Date.now(), "en"));
  assert.equal(en.header[0].title, "1 session needs you · 2 working");
  assert.equal(en.header[0].params.tile, "1 wait · 2 run");
  const ru = parseOutput(C.render({ sessions: [s("waiting", 1), s("idle", 2)], died: [], problems: [], agentsOk: true }, Date.now(), "ru"));
  assert.equal(ru.header[0].title, "1 сессия ждёт вас");
});
