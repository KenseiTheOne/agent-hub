// Stage 5 primitives on doubles: the process table and signatures are replaced, the bridge is a software double of the channel,
// external programs are not run (AGENTHUB_TEST_EXEC_LOG), ~/.claude and cmux files are synthetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { createPeer } from "../lib/peer.mjs";
import { procStartMatches } from "../lib/primitives/_actions-support.mjs";
import { cleanup, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const SID = "aaaaaaaa-1111-4111-8111-111111111111";
const SID2 = "bbbbbbbb-2222-4222-8222-222222222222";
const SURF = "C0FFEE00-1111-4111-8111-111111111111";
const WS = "DEADBEEF-2222-4222-8222-222222222222";
const START = 1792600000;
const APP = { class: "app", pid: 10 };
const CLI = { class: "cli", pid: 20 };

function fakeSys(procs) {
  return {
    available: true,
    peerPid: () => null,
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: 1, uid: 501, startSec: procs[pid].start ?? START, startUsec: 0, tty: procs[pid].tty ?? false } : null),
    procArgv: (pid) => procs[pid]?.argv ?? null,
    codesignVerify: async (path, req) => path === CLAUDE && req.includes("com.anthropic.claude-code"),
    fileId: (p) => `${p}|${JSON.stringify(procs)}`,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}

// A synthetic world: ~/.claude, the cmux file.
async function makeHub({ actions = {}, procs = null, builtin = null, services = "actions" } = {}) {
  const home = tempHome("ah-act-");
  const claudeHome = join(home, "claude");
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  const cmuxFile = join(home, "claude-hook-sessions.json");
  const config = loadConfig({
    env: {
      AGENTHUB_HOME: home,
      AGENTHUB_BUILTIN_PLUGINS: builtin || join(home, "no-builtin"),
      AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log"),
      AGENTHUB_CLAUDE_HOME: claudeHome,
      AGENTHUB_SERVICES: services,
    },
    overrides: {
      actions: {
        cmuxHookSessions: cmuxFile,
        launch: { registerTimeoutMs: 3000, pollMs: 50 },
      },
      // session.launch opens the tab in cmux whatever is installed on the test machine
      services: { actions: { pickupMs: 300, resultMs: 1000 }, terminal: { launch: "cmux" } },
    },
  });
  // 2220, 3330 — interactive Claude (terminal, no -p); 5560 — a nightly `claude -p` under launchd (no terminal)
  const table = procs || {
    2220: { path: CLAUDE, argv: ["claude"], tty: true },
    3330: { path: CLAUDE, argv: ["claude", "--resume"], tty: true },
    4440: { path: "/bin/sleep" },
    5560: { path: CLAUDE, argv: ["claude", "-p", "задача"], tty: false },
  };
  const peer = createPeer({ config, sys: fakeSys(table) });
  const core = new Core({ config, peer });
  await core.init();
  const project = tempHome("ah-proj-");
  const h = {
    home,
    project,
    claudeHome,
    cmuxFile,
    config,
    core,
    procs: table,
    channel: core.facts.get("bridge.channel"),
    execLog: () => (existsSync(join(home, "exec.log")) ? readFileSync(join(home, "exec.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    journal: () => readFileSync(config.paths.journal, "utf8"),
    async stop() {
      bridgeStop?.();
      await core.stop();
      cleanup(home);
      cleanup(project);
    },
  };
  let bridgeStop = null;
  // A software double of the bridge: takes operations and answers with handler(op).
  h.fakeBridge = (handler = () => ({ ok: true, code: 0 })) => {
    const bp = { class: "bridge", pid: 777, startSec: 5 };
    assert.equal(h.channel.hello(bp, { version: "test" }).status, 200);
    const ops = [];
    let on = true;
    (async () => {
      while (on) {
        const r = await h.channel.next(bp, 100);
        if (r?.body?.op) {
          ops.push(r.body.op);
          const res = await handler(r.body.op);
          h.channel.result(bp, r.body.op.id, res);
        }
      }
    })();
    bridgeStop = () => {
      on = false;
    };
    return ops;
  };
  return h;
}

// The plugin appears atomically: the host will not catch a half-written file without the x bit.
function placePlugin(dir, name, text) {
  writePlugin(dir, `.tmp-${name}`, text);
  renameSync(join(dir, `.tmp-${name}`), join(dir, name));
}

function cmuxSessions(h, entries) {
  const sessions = {};
  for (const e of entries) sessions[e.sessionId] = { cwd: "/tmp/x", lastBody: "СЕКРЕТНЫЙ ТЕКСТ", hookEventName: "Stop", ...e };
  writeFileSync(h.cmuxFile, JSON.stringify({ version: 1, sessions, activeSessionsBySurface: {}, activeSessionsByWorkspace: {} }));
}

async function confirmed(core, id, args, peer = APP) {
  const first = await core.invoke({ id, args, peer });
  if (first.status !== 428) return { first, final: first };
  const final = await core.invoke({ id, args, confirmToken: first.body.token, peer });
  return { first, final };
}

function procStartString(sec, shiftH = 1) {
  // like `ps -o lstart`, but with the zone shifted by shiftH hours
  const d = new Date((sec + shiftH * 3600) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getDay()]} ${mons[d.getMonth()]} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`;
}

test("stage 5 primitives are registered with levels, app-only and remoteAllowed", async () => {
  const h = await makeHub();
  try {
    const prims = Object.fromEntries(h.core.snapshot().primitives.map((p) => [p.name, p]));
    const want = {
      "terminal.focus": ["immediate", false, false],
      "cmux.focus": ["immediate", false, false],
      "session.focus": ["immediate", false, false],
      "session.interrupt": ["confirm", true, true],
      "session.stop": ["confirm", true, true],
      "session.launch": ["confirm-cost", true, false],
    };
    for (const [n, [level, appOnly, remote]] of Object.entries(want)) {
      assert.ok(prims[n], n);
      assert.deepEqual([prims[n].level, prims[n].appOnly, prims[n].remoteAllowed], [level, appOnly, remote], n);
    }
    // while the hub is paused only open.url/open.file work — this is visible in the snapshot (the shell disables the other buttons)
    for (const n of Object.keys(prims)) assert.equal(prims[n].safeUnderEstop, n === "open.url" || n === "open.file", n);
    // the core knows nothing about external agents: controlling them is done via plugins' declared actions
    // job.cancel (G6) stops a plugin's own background job — not an external agent
    for (const n of Object.keys(prims)) assert.match(n, /^(open|terminal|cmux|session|job)\./, n);
    // cmux.focus is a deprecated alias of terminal.focus (until the next contract)
    assert.equal(prims["cmux.focus"].aliasOf, "terminal.focus");
    assert.equal(prims["cmux.focus"].deprecated, true);
    assert.equal(prims["terminal.focus"].aliasOf, undefined);
    // journal without load-error
    assert.ok(!h.journal().includes("load-error"));
  } finally {
    await h.stop();
  }
});

test("without the actions service primitives fail closed (facts:actions-off)", async () => {
  const h = await makeHub({ services: "none" });
  try {
    const r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: SURF }, peer: CLI });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "facts:actions-off");
    const s = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, peer: APP });
    assert.equal(s.body.error, "facts:actions-off");
  } finally {
    await h.stop();
  }
});

test("cmux.focus: immediate, cli too; the tab from the cmux file; bridge offline and an unknown tab — 409", async () => {
  const h = await makeHub();
  try {
    cmuxSessions(h, [{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    let r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: SURF }, peer: CLI });
    assert.equal(r.body.error, "facts:bridge-offline");
    const ops = h.fakeBridge();
    r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: SURF }, peer: CLI });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(
      ops.map((o) => [o.op, o.surfaceId, o.workspaceId]),
      [["surface.focus", SURF, WS]],
    );
    r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: "11111111-1111-4111-8111-999999999999" }, peer: CLI });
    assert.equal(r.body.error, "facts:unknown-surface");
    r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: SURF, workspaceId: "11111111-1111-4111-8111-999999999999" }, peer: CLI });
    assert.equal(r.body.error, "facts:workspace-mismatch");
    r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: "surface:2" }, peer: CLI });
    assert.equal(r.body.error, "args:surfaceId:pattern");
    // ESTOP — 423
    h.core.setEstop(true, CLI);
    r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: SURF }, peer: CLI });
    assert.equal(r.status, 423);
    const j = h.journal();
    assert.ok(j.includes('"type":"bridge-op"'));
    assert.ok(!j.includes("СЕКРЕТНЫЙ"), "lastBody from the cmux file does not get into the journal");
  } finally {
    await h.stop();
  }
});

test("cmux.focus from a third-party plugin's output (effects ceiling) — passes", async () => {
  const h = await makeHub();
  try {
    cmuxSessions(h, [{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    const ops = h.fakeBridge();
    h.core.setPluginPolicy(async () => null); // no plugins service: a policy double (without it — policy:no-manager)
    mkdirSync(join(h.config.paths.plugins, "third"), { recursive: true });
    placePlugin(
      join(h.config.paths.plugins, "third"),
      "third.1h.sh",
      `#!/bin/sh\n# <agenthub.effects>cmux.focus,session.stop</agenthub.effects>\necho "Чужой | status=ok"\necho "---"\necho "Вкладка | effect='cmux.focus ${SURF}'"\necho "Стоп | effect='session.stop ${SID}'"\n`,
    );
    await h.core.host.rescan(); // do not wait for FSEvents (under load the event is lost, the safety rescan runs once a minute)
    const offer = await waitFor(() => h.core.pluginState("third")?.body.find((b) => b.title === "Вкладка")?.offer);
    assert.equal(offer.primitive, "cmux.focus");
    assert.equal(h.core.pluginState("third").body.find((b) => b.title === "Стоп").offer, undefined, "session.stop for third parties — no");
    const r = await h.core.invoke({ id: offer.id, peer: CLI });
    assert.equal(r.status, 200);
    assert.equal(ops.length, 1);
  } finally {
    await h.stop();
  }
});

test("session.focus: the terminal layer finds the tab via the session registry; immediate, cli too; refusal codes", async () => {
  const h = await makeHub();
  try {
    const focus = (sessionId = SID, peer = CLI) => h.core.invoke({ id: "session.focus", args: { sessionId }, peer });
    let r = await focus();
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "facts:unknown-session");
    assert.deepEqual(await h.core.sessions.register(SID, { pid: 2220, source: "plugin:test", name: "Работа" }), { verified: true });
    // it is in the registry, but no terminal knows the tab
    r = await focus();
    assert.equal(r.body.error, "facts:no-terminal");
    let s = h.core.sessionList().find((x) => x.sessionId === SID);
    assert.deepEqual([s.terminal, s.focusable], [null, false]);
    // the cmux tab belongs to another process
    cmuxSessions(h, [{ sessionId: SID, pid: 9999, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    r = await focus();
    assert.equal(r.body.error, "facts:pid-mismatch");
    assert.equal(h.core.sessionList().find((x) => x.sessionId === SID).focusable, false);
    cmuxSessions(h, [{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "running" }]);
    // the tab was found (a flag for the shell), but the bridge is not connected — the adapter's code
    s = h.core.sessionList().find((x) => x.sessionId === SID);
    assert.deepEqual([s.terminal, s.focusable], ["cmux", true]);
    assert.equal(h.core.snapshot().sessions.find((x) => x.sessionId === SID).focusable, true);
    r = await focus();
    assert.equal(r.body.error, "facts:bridge-offline");
    const ops = h.fakeBridge();
    // id is case-insensitive; level "immediate" — no confirmation, cli too
    r = await focus(SID.toUpperCase());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.terminal, "cmux");
    assert.deepEqual(ops.map((o) => [o.op, o.surfaceId, o.workspaceId]), [["surface.focus", SURF, WS]]);
    assert.equal(ops[0].sessionId, undefined);
    // action text — by the session name
    const d = h.core.describeTarget({ kind: "primitive", prim: h.core.primitives.get("session.focus"), args: { sessionId: SID } });
    assert.equal(d.text, "Перейти во вкладку «Работа»");
    // the id is a UUID or an external agent session id (G13: [A-Za-z0-9][A-Za-z0-9._-]{0,63}); anything else is a pattern error
    r = await focus("not a uuid");
    assert.equal(r.body.error, "args:sessionId:pattern");
    r = await focus("not-a-uuid");
    assert.equal(r.body.error, "facts:unknown-session");
    h.core.setEstop(true, CLI);
    r = await focus();
    assert.equal(r.status, 423);
  } finally {
    await h.stop();
  }
});

test("session.focus: bridge failure — ok: false with the adapter's code; from a third-party plugin's output (effects ceiling) — passes", async () => {
  const h = await makeHub();
  try {
    await h.core.sessions.register(SID, { pid: 2220, source: "plugin:test" });
    cmuxSessions(h, [{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    let fail = true;
    const ops = h.fakeBridge(() => (fail ? { ok: false, error: "cmux-failed", code: 1 } : { ok: true, code: 0 }));
    let r = await h.core.invoke({ id: "session.focus", args: { sessionId: SID }, peer: CLI });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.ok, r.body.result.error], [false, "cmux-failed"]);
    fail = false;
    h.core.setPluginPolicy(async () => null);
    mkdirSync(join(h.config.paths.plugins, "third"), { recursive: true });
    placePlugin(
      join(h.config.paths.plugins, "third"),
      "third.1h.sh",
      `#!/bin/sh\n# <agenthub.contract>3</agenthub.contract>\n# <agenthub.effects>open.url,session.focus</agenthub.effects>\necho "Чужой | status=ok"\necho "---"\necho "Перейти | effect='session.focus ${SID}'"\n`,
    );
    await h.core.host.rescan();
    const offer = await waitFor(() => h.core.pluginState("third")?.body.find((b) => b.title === "Перейти")?.offer);
    assert.equal(offer.primitive, "session.focus");
    r = await h.core.invoke({ id: offer.id, peer: CLI });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(ops.length, 2);
    // no session name — the description uses the start of the id
    const prim = h.core.primitives.get("session.focus");
    assert.equal(prim.describe({ sessionId: SID }, h.core.facts, "en").text, `Switch to the tab of session ${SID.slice(0, 8)}…`);
    assert.equal(prim.describe({ sessionId: SID }, h.core.facts, "ru").text, `Перейти во вкладку сессии ${SID.slice(0, 8)}…`);
  } finally {
    await h.stop();
  }
});

test("session.interrupt: app only, only with agentLifecycle=running, Esc to the right tab", async () => {
  const h = await makeHub();
  try {
    const ops = h.fakeBridge();
    let r = await h.core.invoke({ id: "session.interrupt", args: { sessionId: SID }, peer: CLI });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:cli");
    r = await h.core.invoke({ id: "session.interrupt", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:unknown-session");
    assert.deepEqual(await h.core.sessions.register(SID, { pid: 2220, source: "plugin:test", name: "Работа" }), { verified: true });
    r = await h.core.invoke({ id: "session.interrupt", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:no-terminal");
    cmuxSessions(h, [{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    r = await h.core.invoke({ id: "session.interrupt", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:not-running");
    cmuxSessions(h, [{ sessionId: SID, pid: 9999, surfaceId: SURF, workspaceId: WS, agentLifecycle: "running" }]);
    r = await h.core.invoke({ id: "session.interrupt", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:pid-mismatch");
    cmuxSessions(h, [{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "running" }]);
    const { first, final } = await confirmed(h.core, "session.interrupt", { sessionId: SID });
    assert.equal(first.status, 428);
    assert.match(first.body.text, /Прервать текущий ход сессии «Работа» \(как Esc во вкладке\)/);
    assert.equal(final.status, 200);
    assert.equal(final.body.ok, true);
    assert.deepEqual(
      ops.map((o) => [o.op, o.key, o.surfaceId, o.workspaceId]),
      [["send-key", "escape", SURF, WS]],
    );
    // the turn ended between confirmation and the press — Esc is not sent
    const again = await h.core.invoke({ id: "session.interrupt", args: { sessionId: SID }, peer: APP });
    cmuxSessions(h, [{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    const late = await h.core.invoke({ id: "session.interrupt", args: { sessionId: SID }, confirmToken: again.body.token, peer: APP });
    assert.equal(late.body.error, "facts:not-running");
    assert.equal(ops.length, 1);
  } finally {
    await h.stop();
  }
});

test("session.stop: SIGTERM only to a verified interactive session after checking procStart", async () => {
  const h = await makeHub();
  try {
    // a process without Claude Code's signature does not get into the registry — and cannot be stopped
    assert.equal((await h.core.sessions.register(SID2, { pid: 4440, source: "plugin:test" })).verified, false);
    let r = await h.core.invoke({ id: "session.stop", args: { sessionId: SID2 }, peer: APP });
    assert.equal(r.body.error, "facts:unknown-session");

    // a nightly claude -p: the session file is forged as interactive — the process itself decides (argv/terminal), not the file
    const NIGHT = "cccccccc-3333-4333-8333-333333333333";
    await h.core.sessions.register(NIGHT, { pid: 5560, source: "plugin:test" });
    writeFileSync(join(h.claudeHome, "sessions", "5560.json"), JSON.stringify({ pid: 5560, sessionId: NIGHT, kind: "interactive", procStart: procStartString(START) }));
    r = await h.core.invoke({ id: "session.stop", args: { sessionId: NIGHT }, peer: APP });
    assert.equal(r.body.error, "facts:non-interactive:no-tty");

    await h.core.sessions.register(SID, { pid: 2220, source: "plugin:test", name: "Работа" });
    // no session file — refused (closed): interactive sessions always have one
    r = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:no-session-file");
    const file = join(h.claudeHome, "sessions", "2220.json");
    writeFileSync(file, JSON.stringify({ pid: 2220, sessionId: SID2, kind: "interactive", procStart: procStartString(START) }));
    r = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:session-file-mismatch");
    writeFileSync(file, JSON.stringify({ pid: 2220, sessionId: SID, kind: "print", procStart: procStartString(START) }));
    r = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:non-interactive");
    writeFileSync(file, JSON.stringify({ pid: 2220, sessionId: SID, kind: "interactive", procStart: procStartString(START + 600, 0) }));
    r = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, peer: APP });
    assert.equal(r.body.error, "facts:proc-start-mismatch");
    writeFileSync(file, JSON.stringify({ pid: 2220, sessionId: SID, kind: "interactive", procStart: procStartString(START, 1) }));
    r = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, peer: CLI });
    assert.equal(r.body.error, "peer:cli");
    const { first, final } = await confirmed(h.core, "session.stop", { sessionId: SID });
    assert.equal(first.status, 428);
    assert.match(first.body.text, /^Завершить сессию «Работа»\. Продолжить её можно позже: claude --resume /);
    assert.match(first.body.text, new RegExp(`claude --resume ${SID}`));
    assert.equal(final.status, 200);
    assert.equal(final.body.ok, true);
    assert.deepEqual(h.execLog(), [{ file: "/bin/kill", args: ["-TERM", "2220"] }]);
  } finally {
    await h.stop();
  }
});

test("session.stop: pid reused (different start time) — the signal is not sent", async () => {
  const h = await makeHub();
  try {
    await h.core.sessions.register(SID, { pid: 2220, source: "plugin:test" });
    writeFileSync(join(h.claudeHome, "sessions", "2220.json"), JSON.stringify({ pid: 2220, sessionId: SID, kind: "interactive", procStart: procStartString(START, 1) }));
    const t = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, peer: APP });
    assert.equal(t.status, 428, JSON.stringify(t.body));
    h.procs[2220].start = START + 100; // the same pid, already another process
    const r = await h.core.invoke({ id: "session.stop", args: { sessionId: SID }, confirmToken: t.body.token, peer: APP });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.result.error, "pid-reused");
    assert.deepEqual(h.execLog(), []);
  } finally {
    await h.stop();
  }
});

test("session.launch: the prompt is in a 0600 file, not in the journal and not in the confirmation text; waiting for the cmux record", async () => {
  const h = await makeHub();
  try {
    const cwd = h.project;
    const PROMPT = "секретный промпт пользователя 'с кавычками'";
    let r = await h.core.invoke({ id: "session.launch", args: { cwd, name: "Новая", prompt: PROMPT }, peer: APP });
    assert.equal(r.body.error, "facts:bridge-offline");
    let promptSeen = null;
    let modeSeen = null;
    const ops = h.fakeBridge((op) => {
      promptSeen = readFileSync(op.promptFile, "utf8");
      modeSeen = statSync(op.promptFile).mode & 0o777;
      return { ok: true, code: 0, workspaceId: WS };
    });
    for (const [args, err] of [
      [{ cwd, name: "x'; rm -rf ~", prompt: "" }, "facts:bad-name"],
      [{ cwd: "relative", name: "x" }, "facts:bad-cwd"],
      [{ cwd: h.claudeHome, name: "x" }, "facts:forbidden-cwd"],
      [{ cwd: h.home, name: "x" }, "facts:forbidden-cwd"],
    ]) {
      r = await h.core.invoke({ id: "session.launch", args, peer: APP });
      assert.equal(r.body.error, err, JSON.stringify(args));
    }
    r = await h.core.invoke({ id: "session.launch", args: { cwd, name: "Новая", prompt: PROMPT }, peer: CLI });
    assert.equal(r.body.error, "peer:cli");
    const { first, final } = await confirmed(h.core, "session.launch", { cwd, name: "Новая", prompt: PROMPT });
    assert.equal(first.body.level, "confirm-cost");
    assert.ok(!first.body.text.includes("секретный"));
    assert.match(first.body.text, /Remote Control/);
    assert.equal(final.body.ok, true);
    const sid = final.body.result.sessionId;
    assert.match(sid, /^[0-9a-f-]{36}$/);
    assert.equal(ops.length, 1);
    assert.deepEqual(Object.keys(ops[0]).sort(), ["cwd", "expiresAt", "id", "name", "op", "promptFile", "sessionId"]);
    assert.equal(ops[0].promptFile, join(h.home, "launch", `${sid}.prompt`));
    assert.equal(promptSeen, PROMPT);
    assert.equal(modeSeen, 0o600);
    assert.equal(statSync(join(h.home, "launch")).mode & 0o777, 0o700);
    // cmux recorded the session — the event and cleanup of the unread file
    const events = [];
    h.core.on("bridge.launch.registered", (e) => events.push(e));
    cmuxSessions(h, [{ sessionId: sid, pid: 3330, surfaceId: SURF, workspaceId: WS, agentLifecycle: "running" }]);
    await waitFor(() => events.length === 1);
    assert.equal(events[0].surfaceId, SURF);
    assert.ok(!existsSync(ops[0].promptFile));
    assert.ok(!h.journal().includes("секретный"), "the prompt is not in the journal");
    assert.ok(h.journal().includes('"type":"launch-registered"'));
  } finally {
    await h.stop();
  }
});

test("session.launch: the bridge answered with an error — the prompt file is deleted; the bridge did not take the operation — refused on timeout", async () => {
  const h = await makeHub();
  try {
    const cwd = h.project;
    let file = null;
    h.fakeBridge((op) => {
      file = op.promptFile;
      return { ok: false, code: 1, error: "cmux-failed" };
    });
    const { final } = await confirmed(h.core, "session.launch", { cwd, name: "Новая", prompt: "p" });
    assert.equal(final.body.ok, false);
    assert.equal(final.body.result.error, "cmux-failed");
    assert.ok(file && !existsSync(file));
  } finally {
    await h.stop();
  }
});

test("session.launch from a plugin offer is not accepted (only a human enters prompts)", async () => {
  const builtin = tempHome("ah-bi-");
  const h = await makeHub({ builtin });
  try {
    const cwd = h.project;
    const ops = h.fakeBridge();
    placePlugin(builtin, "l.1h.sh", `#!/bin/sh\n# <agenthub.effects>session.launch</agenthub.effects>\necho "L"\necho "---"\necho "Go | effect='session.launch cwd=${cwd} name=Плагин prompt=hi'"\n`);
    await h.core.host.rescan(); // do not wait for FSEvents
    const offer = await waitFor(() => h.core.pluginState("l")?.body.find((b) => b.title === "Go")?.offer);
    // the core passes verifyFacts the id of the offering plugin: refused even before the confirmation window
    const t = await h.core.invoke({ id: offer.id, peer: APP });
    assert.equal(t.status, 409);
    assert.equal(t.body.error, "facts:offer-not-allowed");
    assert.equal(ops.length, 0);
  } finally {
    await h.stop();
    cleanup(builtin);
  }
});

test("bridge channel: an untaken operation is withdrawn and not handed out later; a second bridge — 409 bridge:busy", async () => {
  const h = await makeHub();
  try {
    const bp = { class: "bridge", pid: 777, startSec: 5 };
    assert.equal(h.channel.hello(bp, {}).status, 200);
    assert.equal(h.channel.hello({ class: "bridge", pid: 778, startSec: 6 }, {}).status, 409);
    const res = await h.channel.call({ op: "send-key", key: "escape", surfaceId: SURF, workspaceId: WS });
    assert.equal(res.error, "bridge-pickup-timeout");
    assert.equal(await h.channel.next(bp, 0), null, "a withdrawn operation is not sent to the bridge");
    assert.equal((await h.channel.call({ op: "rm -rf" })).error, "bridge-op-unknown");
    assert.equal(h.channel.result(bp, "nope", { ok: true }).status, 404);
    assert.equal((await h.channel.next({ class: "bridge", pid: 778, startSec: 6 }, 0)).status, 409);
    assert.equal(h.channel.bye(bp).status, 200);
    assert.equal(h.channel.online(), false);
    assert.equal((await h.channel.call({ op: "surface.focus", surfaceId: SURF, workspaceId: WS })).error, "bridge-offline");
  } finally {
    await h.stop();
  }
});

test("procStart: a zone shift by whole hours is allowed, anything else is not", () => {
  assert.equal(procStartMatches(procStartString(START, 0), START), true);
  assert.equal(procStartMatches(procStartString(START, 1), START), true);
  assert.equal(procStartMatches(procStartString(START, -3), START), true);
  assert.equal(procStartMatches(procStartString(START + 600, 0), START), false);
  assert.equal(procStartMatches("мусор", START), null);
});
