// Terminal (contract 3): "read a tab's screen" and "type a line into a tab" of a Claude Code session for trusted
// plugins: the <agenthub.terminal> permission, the terminal service, /terminal/* routes, the terminal layer (cmux adapter), the bridge.
// Everything runs on doubles: the process table and signatures are faked, cmux is a double (it executes argv over a screen
// model), and the bridge is a programmatic channel double with the bridge's real runOp. The real cmux is never called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { createPeer, defaultSys } from "../lib/peer.mjs";
import { lintPlugin, parseTerminalPerm, permissionList, permissionsFromMeta, terminalGrants, terminalTextAllowed } from "../lib/registry/perms.mjs";
import { consentText } from "../lib/registry/terminal.mjs";
import { locate, ADAPTERS, canFocus, tabOf } from "../lib/terminals/index.mjs";
import * as cmuxAdapter from "../lib/terminals/cmux.mjs";
import { routes } from "../lib/routes/terminal.mjs";
import { analyzeScreen, buildArgv, runOp, OPS } from "../../bridge/agenthub-bridge.mjs";
import { BRIDGE_OPS } from "../lib/services/actions.mjs";
import { cleanup, curl, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const SID = "aaaaaaaa-1111-4111-8111-111111111111";
const SID2 = "bbbbbbbb-2222-4222-8222-222222222222";
const SURF = "C0FFEE00-1111-4111-8111-111111111111";
const SURF2 = "C0FFEE00-2222-4222-8222-222222222222";
const WS = "DEADBEEF-2222-4222-8222-222222222222";
const START = 1792600000;
const PEER = { class: "cli", pid: 20 };
const RULE = "─".repeat(60);

// ---------- cmux double: tab screen and argv ----------
// The Claude Code screen: output, the turn line (busy), the input field between rules, the hints line.
function screen(t) {
  return ["● Ответ: секретный текст переписки", t.busy ? "✻ Thinking… (3s · esc to interrupt)" : "", RULE, `> ${t.prompt}`, RULE, "  ? for shortcuts", ""].join("\n");
}
function fakeCmux(tabs) {
  const log = [];
  const exec = async (_cmux, argv) => {
    log.push(argv);
    const s = argv[argv.indexOf("--surface") + 1];
    const t = tabs[s];
    if (!t) return { code: 1, stdout: "" };
    if (argv[0] === "read-screen") return { code: 0, stdout: screen(t) };
    if (argv[0] === "send") {
      t.prompt += argv.at(-1) + (t.typeAlso || "");
      return { code: 0, stdout: "" };
    }
    if (argv[0] === "send-key" && argv.at(-1) === "enter") {
      t.submitted.push(t.prompt);
      t.prompt = "";
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return { exec, log };
}

function fakeSys(procs) {
  return {
    available: true,
    peerPid: () => null,
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: 1, uid: 501, startSec: procs[pid].start ?? START, startUsec: 0, tty: true } : null),
    procArgv: (pid) => procs[pid]?.argv ?? null,
    codesignVerify: async (path, req) => path === CLAUDE && req.includes("com.anthropic.claude-code"),
    fileId: (p) => `${p}|${JSON.stringify(procs)}`,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
    // process state: stopped means Ctrl+Z; fg: false means not in its terminal's foreground group
    procState: (pid) => (procs[pid] ? { stopped: procs[pid].stopped === true, foreground: procs[pid].fg !== false } : null),
  };
}

const TERM_META = ["read-screen — узнать, свободна ли сессия", "send /model /effort — сменить модель и effort"];

async function makeHub({ terminal = {}, plugin = {} } = {}) {
  const home = tempHome("ah-term-");
  const claudeHome = join(home, "claude");
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  const cmuxFile = join(home, "claude-hook-sessions.json");
  const config = loadConfig({
    env: {
      AGENTHUB_HOME: home,
      AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"),
      AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log"),
      AGENTHUB_CLAUDE_HOME: claudeHome,
      AGENTHUB_SERVICES: "actions,terminal",
    },
    overrides: {
      actions: { cmuxHookSessions: cmuxFile },
      services: { actions: { pickupMs: 500, resultMs: 1000 }, terminal },
    },
  });
  const procs = { 2220: { path: CLAUDE, argv: ["claude"] }, 3330: { path: CLAUDE, argv: ["claude"] }, 4440: { path: "/bin/sleep" } };
  const core = new Core({ config, peer: createPeer({ config, sys: fakeSys(procs) }) });
  await core.init();
  // plugin process: pretend pid 20 is a running trusted plugin with the terminal permission
  const pl = { id: "tabs", source: "builtin", granted: null, meta: { net: [], terminal: TERM_META }, ...plugin };
  core.host.pluginByPid = (pid) => (pid === PEER.pid ? pl : null);
  const tabs = { [SURF]: { prompt: "", busy: false, submitted: [] }, [SURF2]: { prompt: "", busy: false, submitted: [] } };
  const cmux = fakeCmux(tabs);
  const channel = core.facts.get("bridge.channel");
  let on = false;
  const h = {
    home,
    core,
    procs,
    tabs,
    cmux,
    pl,
    cmuxFile,
    svc: core.facts.get("terminal.api"),
    journal: () => (existsSync(config.paths.journal) ? readFileSync(config.paths.journal, "utf8") : ""),
    entries: (type) => h.journal().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type),
    hook(entries) {
      const sessions = {};
      for (const e of entries) sessions[e.sessionId] = { lastBody: "СЕКРЕТ", ...e };
      writeFileSync(cmuxFile, JSON.stringify({ version: 1, sessions }));
    },
    // bridge double: the bridge's real runOp over the cmux double
    bridge() {
      const bp = { class: "bridge", pid: 777, startSec: 5 };
      assert.equal(channel.hello(bp, { version: "test" }).status, 200);
      on = true;
      (async () => {
        while (on) {
          const r = await channel.next(bp, 100);
          if (r?.body?.op) channel.result(bp, r.body.op.id, await runOp(r.body.op, { cmux: "/fake/cmux", exec: cmux.exec, settleMs: 0 }));
        }
      })();
    },
    async stop() {
      on = false;
      await core.stop();
      cleanup(home);
    },
  };
  return h;
}

async function ready(h) {
  h.hook([
    { sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" },
    { sessionId: SID2, pid: 3330, surfaceId: SURF2, workspaceId: WS, agentLifecycle: "idle" },
  ]);
  assert.equal((await h.core.sessions.register(SID, { pid: 2220, source: "plugin:test" })).verified, true);
  assert.equal((await h.core.sessions.register(SID2, { pid: 3330, source: "plugin:test" })).verified, true);
  h.bridge();
}

// ---------- the <agenthub.terminal> permission ----------

test("terminal permission: parsing entries, line words, risk and the consent window", () => {
  assert.deepEqual(parseTerminalPerm("read-screen"), { op: "read-screen" });
  assert.deepEqual(parseTerminalPerm("send  /model /effort /model"), { op: "send", any: false, words: ["/model", "/effort"], modes: [] });
  assert.deepEqual(parseTerminalPerm("send *"), { op: "send", any: true, words: [], modes: [] });
  assert.deepEqual(parseTerminalPerm("send /model ! #"), { op: "send", any: false, words: ["/model"], modes: ["!", "#"] });
  for (const bad of ["send", "read-screen x", "send /Model", "send rm;", "send * /model", "type /model", "send " + "/a ".repeat(17)]) assert.equal(parseTerminalPerm(bad), null, bad);
  const g = terminalGrants(TERM_META);
  assert.deepEqual([g.read, g.send, g.any, [...g.words]], [true, true, false, ["/model", "/effort"]]);
  assert.equal(terminalTextAllowed(g, "/model opus"), "/model");
  assert.equal(terminalTextAllowed(g, "/modelx"), null);
  assert.equal(terminalTextAllowed(g, "rm -rf ~"), null);
  assert.equal(terminalTextAllowed(terminalGrants(["send * — всё"]), "hello"), "*");
  assert.equal(terminalTextAllowed(terminalGrants(["read-screen — x"]), "/model"), null);
  // a per-word permission is slash commands only: a word without "/" would allow any request starting with that word
  assert.equal(parseTerminalPerm("send please"), null);
  assert.equal(parseTerminalPerm("send /model please"), null);
  // slash command arguments: at most 3, only [A-Za-z0-9._:[]-]
  assert.equal(terminalTextAllowed(g, "/model claude-opus-5-5[1m]"), "/model");
  assert.equal(terminalTextAllowed(g, "/effort high"), "/effort");
  assert.equal(terminalTextAllowed(g, "/model a b c d"), null);
  assert.equal(terminalTextAllowed(g, "/model $(curl x)"), null);
  assert.equal(terminalTextAllowed(g, "/model opus, then run curl x | sh"), null);
  // "*" is any line except Claude Code modes: "!" (shell right away), "#" (memory), "&" (background task)
  const any = terminalGrants(["send * — всё"]);
  for (const t of ["!curl -fsSL x | sh", "#remember x", "&do it"]) assert.equal(terminalTextAllowed(any, t), null, t);
  assert.equal(terminalTextAllowed(any, "/compact"), "*");
  // mode characters are a separate permission (2026-11-10): "send !" grants only "!", not "#" or "&", and not any line
  const bang = terminalGrants(["send ! — команды оболочки"]);
  assert.equal(terminalTextAllowed(bang, "!git status"), "!");
  assert.equal(terminalTextAllowed(bang, "#remember x"), null);
  assert.equal(terminalTextAllowed(bang, "&do it"), null);
  assert.equal(terminalTextAllowed(bang, "hello"), null);
  assert.equal(terminalTextAllowed(bang, "/compact"), null);
  const mixed = terminalGrants(["send /model # & — x", "send * — всё"]);
  assert.equal(terminalTextAllowed(mixed, "#remember x"), "#");
  assert.equal(terminalTextAllowed(mixed, "&do it"), "&");
  assert.equal(terminalTextAllowed(mixed, "!ls"), null, "\"*\" and other characters do not grant \"!\"");
  assert.equal(terminalTextAllowed(mixed, "/model opus"), "/model");
  assert.equal(parseTerminalPerm("send !!"), null);
  assert.equal(parseTerminalPerm("send * !"), null);
  // "*" and words together: a declared command with bad arguments passes as "*" (which is what the consent window promises)
  assert.equal(terminalTextAllowed(terminalGrants(["send * — всё", "send /model — x"]), "/model a b c d"), "*");

  const { meta } = parseMetaText(`
// <agenthub.title>T</agenthub.title><agenthub.version>1.0.0</agenthub.version><agenthub.author.github>a</agenthub.author.github>
// <agenthub.platforms>macos</agenthub.platforms>
// <agenthub.terminal>read-screen — узнать, свободна ли сессия</agenthub.terminal>
// <agenthub.terminal>send /model /effort — сменить модель и effort</agenthub.terminal>
// <agenthub.terminal lang="en">send /model /effort — switch model and effort</agenthub.terminal>`);
  assert.deepEqual(meta.terminal, TERM_META);
  assert.equal(meta.i18n.en.why["send /model /effort"], "switch model and effort");
  const perms = permissionsFromMeta(meta);
  const list = permissionList(perms).filter((p) => p.kind === "terminal");
  assert.deepEqual(
    list.map((p) => [p.key, p.risk ?? null]),
    [
      ["terminal:read-screen", null],
      ["terminal:send /model /effort", "terminal"],
    ],
  );
  // without the permission there is no terminal field in the permissions (index entries from before contract 3 compare as before)
  assert.equal("terminal" in permissionsFromMeta(parseMetaText("").meta), false);
  // in the terminal window, typing gets a loud line
  const text = consentText({ entry: { id: "t", title: "T", version: "1.0.0", tier: "official", sha256: "0".repeat(64) }, list: permissionList(perms), update: false }, "en");
  assert.match(text, /send \/model \/effort[^\n]*\n {4}!!! [^\n]*Claude Code/);
  assert.match(consentText({ entry: { id: "t", title: "T", version: "1.0.0", tier: "official", sha256: "0".repeat(64) }, list: permissionList(perms), update: false }, "ru"), /send \/model \/effort[^\n]*\n {4}!!! ОПАСНОЕ МЕСТО: набор во вкладки Claude Code/);
  // the mode characters permission (2026-11-10) gets its own, loudest mark; the linter warns about it separately
  const modeMeta = parseMetaText("<agenthub.terminal>send ! — команды оболочки</agenthub.terminal>").meta;
  assert.deepEqual(permissionList(permissionsFromMeta(modeMeta)).filter((p) => p.kind === "terminal").map((p) => [p.key, p.risk]), [["terminal:send !", "terminal-mode"]]);
  const mw = lintPlugin({ id: "t", meta: modeMeta, official: true });
  assert.deepEqual(mw.errors.filter((e) => e.includes("terminal")), []);
  assert.ok(mw.warnings.some((w) => w.includes("<agenthub.terminal>send !") && w.includes("без своих разрешений")));

  // linter: allowed for official plugins (with a reviewer warning), an error for community ones; a malformed entry is an error
  const off = lintPlugin({ id: "t", meta, official: true });
  assert.deepEqual(off.errors, []);
  assert.ok(off.warnings.some((w) => w.includes("<agenthub.terminal>send /model /effort")));
  assert.ok(lintPlugin({ id: "t", meta, official: false }).errors.some((e) => e.includes("<agenthub.terminal>")));
  const bad = parseMetaText("<agenthub.terminal>send rm; — x</agenthub.terminal><agenthub.terminal>read-screen</agenthub.terminal>").meta;
  const be = lintPlugin({ id: "t", meta: bad, official: true }).errors;
  assert.ok(be.some((e) => e.includes("send rm;")));
  assert.ok(be.some((e) => e.includes("read-screen") && e.includes("зачем")));
});

// ---------- bridge: the allowlist grows only by read-screen and send-text ----------

test("bridge: read-screen and send-text have an explicit target, a screen without history, a line without control characters", () => {
  assert.deepEqual(OPS, ["surface.focus", "send-key", "new-workspace", "read-screen", "send-text"]);
  assert.deepEqual(BRIDGE_OPS, OPS);
  assert.deepEqual(buildArgv({ op: "read-screen", surfaceId: SURF, workspaceId: WS }).argvs, [["read-screen", "--workspace", WS, "--surface", SURF]]);
  const b = buildArgv({ op: "send-text", surfaceId: SURF, workspaceId: WS, sessionId: SID, text: "/model opus" });
  assert.deepEqual(b.send, ["send", "--workspace", WS, "--surface", SURF, "--", "/model opus"]);
  assert.deepEqual(b.enter, ["send-key", "--workspace", WS, "--surface", SURF, "enter"]);
  assert.equal(buildArgv({ op: "read-screen", surfaceId: SURF }).error, "bad-workspace");
  assert.equal(buildArgv({ op: "send-text", workspaceId: WS, text: "x" }).error, "bad-surface");
  assert.equal(buildArgv({ op: "read-screen", surfaceId: SURF, workspaceId: WS, scrollback: true }).error, "bad-field:scrollback");
  assert.equal(buildArgv({ op: "read-screen", surfaceId: SURF, workspaceId: WS, lines: 500 }).error, "bad-lines");
  assert.equal(buildArgv({ op: "send-text", surfaceId: SURF, workspaceId: WS, text: "x", key: "enter" }).error, "bad-field:key");
  for (const t of ["a\nb", "a\\nb", "a\rb", "a\tb", "\u001b[A", " x", "x ", "", "x".repeat(201), "привет", "a\u0000"]) {
    assert.equal(buildArgv({ op: "send-text", surfaceId: SURF, workspaceId: WS, text: t }).error, "bad-text", JSON.stringify(t));
  }
  assert.equal(buildArgv({ op: "send-text", surfaceId: SURF, workspaceId: WS, text: "x".repeat(200) }).error, undefined);
  // send-key is still escape only (only send-text presses enter, after checking the field)
  assert.equal(buildArgv({ op: "send-key", key: "enter", surfaceId: SURF, workspaceId: WS }).error, "bad-key");
});

test("bridge: input field signs from the screen, without text; a placeholder and a dialog are not \"empty\"", () => {
  const a = analyzeScreen(screen({ prompt: "", busy: false }));
  assert.deepEqual([a.promptFound, a.promptEmpty, a.busy], [true, true, false]);
  assert.equal(analyzeScreen(screen({ prompt: "", busy: true })).busy, true);
  assert.equal(analyzeScreen(screen({ prompt: "черновик", busy: false })).promptEmpty, false);
  assert.equal(analyzeScreen(screen({ prompt: 'Try "fix lint errors"', busy: false })).promptEmpty, false);
  // an old-style frame and a wrapped long line
  const boxed = ["╭" + "─".repeat(30) + "╮", "│ > /model op │", "│   us        │", "╰" + "─".repeat(30) + "╯"].join("\n");
  assert.deepEqual([analyzeScreen(boxed).promptFound, analyzeScreen(boxed).promptText], [true, "/model op us"]);
  // no field (a permission dialog, a plain shell): promptFound false
  assert.equal(analyzeScreen("$ ls\nfoo\n$ ").promptFound, false);
  assert.equal(analyzeScreen(["│ Do you want to proceed?", "│ ❯ 1. Yes", "│   2. No"].join("\n")).promptFound, false);
});

test("bridge: send-text requires an empty field and no turn in progress, otherwise refused; before Enter the field holds exactly this line", async () => {
  const tabs = { [SURF]: { prompt: "", busy: false, submitted: [] } };
  const { exec, log } = fakeCmux(tabs);
  const op = (text) => ({ op: "send-text", surfaceId: SURF, workspaceId: WS, sessionId: SID, text, expiresAt: Date.now() + 5000 });
  const run = (o) => runOp(o, { cmux: "/fake/cmux", exec, settleMs: 0 });
  let r = await run(op("/model opus"));
  assert.deepEqual(r, { ok: true, code: 0 });
  assert.deepEqual(tabs[SURF].submitted, ["/model opus"]);
  assert.deepEqual(log.map((a) => a[0]), ["read-screen", "send", "read-screen", "send-key"]);
  // a human's draft is left alone
  tabs[SURF].prompt = "мой черновик";
  log.length = 0;
  r = await run(op("/model opus"));
  assert.equal(r.error, "prompt-not-empty");
  assert.deepEqual(log.map((a) => a[0]), ["read-screen"]);
  // a turn is in progress
  tabs[SURF].prompt = "";
  tabs[SURF].busy = true;
  assert.equal((await run(op("/model opus"))).error, "session-busy");
  tabs[SURF].busy = false;
  // someone typed at the same time: Enter is not pressed
  tabs[SURF].typeAlso = "zz";
  log.length = 0;
  r = await run(op("/effort high"));
  assert.equal(r.error, "prompt-mismatch");
  assert.ok(!log.some((a) => a[0] === "send-key"));
  // read-screen returns only the signs
  tabs[SURF].prompt = "";
  r = await runOp({ op: "read-screen", surfaceId: SURF, workspaceId: WS }, { cmux: "/fake/cmux", exec });
  assert.deepEqual(r, { ok: true, code: 0, promptFound: true, promptEmpty: true, busy: false });
  // the Enter deadline (enterBy) passed while the bridge read the screen: Enter is not pressed, the daemon already replied "not sent"
  log.length = 0;
  tabs[SURF].typeAlso = "";
  r = await runOp({ ...op("/model opus"), enterBy: Date.now() - 1 }, { cmux: "/fake/cmux", exec, settleMs: 0 });
  assert.equal(r.error, "deadline");
  assert.ok(!log.some((a) => a[0] === "send-key"));
  assert.equal(buildArgv({ ...op("/x"), enterBy: "soon" }).error, "bad-deadline");
});

test("bridge channel: send-text carries the Enter deadline; a late bridge reply goes to the journal and the audit journal (bridge-op-late)", async () => {
  const h = await makeHub();
  try {
    const channel = h.core.facts.get("bridge.channel");
    const bp = { class: "bridge", pid: 777, startSec: 5 };
    channel.hello(bp, { version: "test" });
    const t0 = Date.now();
    const pending = channel.call({ op: "send-text", surfaceId: SURF, workspaceId: WS, sessionId: SID, text: "/model x" });
    const got = await channel.next(bp, 200);
    const op = got.body.op;
    // pickupMs 500 + resultMs 1000 on the stand: Enter no later than half the remaining wait
    assert.ok(op.enterBy >= t0 + 700 && op.enterBy <= t0 + 1600, String(op.enterBy - t0));
    const res = await pending;
    assert.equal(res.error, "bridge-timeout");
    assert.equal(channel.result(bp, op.id, { ok: true, code: 0 }).status, 200);
    const late = h.entries("bridge-op-late");
    assert.deepEqual([late.length, late[0].op, late[0].ok, late[0].sessionId], [1, "send-text", true, SID]);
    assert.equal(h.core.journal.auditTail(20).filter((e) => e.type === "bridge-op-late").length, 1);
    // the second time it is an unknown operation
    assert.equal(channel.result(bp, op.id, { ok: true }).status, 404);
  } finally {
    await h.stop();
  }
});

// ---------- service and route ----------

test("/terminal/* routes are cli class only (the plugin process is identified by pid)", () => {
  assert.deepEqual(
    routes.map((r) => [r.method, r.path, r.peers]),
    [
      ["POST", "/terminal/read-screen", ["cli"]],
      ["POST", "/terminal/send-text", ["cli"]],
    ],
  );
  assert.deepEqual(ADAPTERS.map((a) => a.id), ["cmux", "tmux", "iterm2", "terminal-app"]);
});

test("send-text: a trusted plugin with the permission types into a free tab; the journal has no text", async () => {
  const h = await makeHub();
  try {
    await ready(h);
    let r = await h.svc.readScreen(PEER, { sessionId: SID });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, sessionId: SID, terminal: "cmux", idle: true, foreground: true, promptFound: true, promptEmpty: true, busy: false, ready: true });
    assert.ok(!JSON.stringify(r.body).includes("секретный"), "screen text does not leave the bridge");
    r = await h.svc.sendText(PEER, { sessionId: SID, text: "/model claude-opus-5-5" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(h.tabs[SURF].submitted, ["/model claude-opus-5-5"]);
    // the tab and workspace are always explicit, and only of its own session
    for (const argv of h.cmux.log) {
      assert.equal(argv[argv.indexOf("--surface") + 1], SURF);
      assert.equal(argv[argv.indexOf("--workspace") + 1], WS);
    }
    const sent = h.entries("terminal-send");
    assert.equal(sent.length, 1);
    assert.deepEqual(
      { ...sent[0], ts: undefined, source: undefined },
      { ...sent[0], ts: undefined, source: undefined, plugin: "tabs", sessionId: SID, surfaceId: SURF, workspaceId: WS, terminal: "cmux", len: 22, head: "/model", ok: true, error: null },
    );
    assert.match(sent[0].sha, /^[0-9a-f]{12}$/);
    // sends also go to the audit journal: a flood of bridge-op from screen reads will not push them out
    assert.equal(h.core.journal.auditTail(50).filter((e) => e.type === "terminal-send").length, 1);
    assert.ok(!h.journal().includes("claude-opus-5-5"), "the line is not in the journal");
    assert.ok(!h.journal().includes("секретный"), "the screen is not in the journal");
  } finally {
    await h.stop();
  }
});

test("refusals: not a plugin, third-party, no permission, foreign word, control characters, pause", async () => {
  const h = await makeHub();
  try {
    await ready(h);
    const send = (body, peer = PEER) => h.svc.sendText(peer, body);
    assert.equal((await send({ sessionId: SID, text: "/model x" }, { class: "cli", pid: 99 })).body.error, "terminal:not-a-plugin");
    // a third-party (community) plugin: no permission even if declared
    h.pl.source = "installed";
    h.pl.granted = { tier: "community" };
    assert.equal((await send({ sessionId: SID, text: "/model x" })).status, 403);
    assert.equal((await send({ sessionId: SID, text: "/model x" })).body.error, "terminal:untrusted");
    h.pl.granted = { tier: "own" };
    assert.equal((await send({ sessionId: SID, text: "/model x" })).status, 200);
    // without the typing permission: read only
    h.pl.meta = { net: [], terminal: ["read-screen — x"] };
    assert.equal((await send({ sessionId: SID, text: "/model x" })).body.error, "terminal:not-declared");
    h.pl.meta = { net: [], terminal: ["send /model — x"] };
    assert.equal((await h.svc.readScreen(PEER, { sessionId: SID })).body.error, "terminal:not-declared");
    // a word not in the permission
    assert.equal((await send({ sessionId: SID, text: "/effort max" })).body.error, "terminal:text-not-declared");
    assert.equal((await send({ sessionId: SID, text: "/model" })).status, 200);
    // control characters, a newline, "\n" for cmux, extra fields
    for (const text of ["/model a\nb", "/model a\\nb", "/model \u001b[A", "/model a\r", "/model\t", "/model ü"]) {
      const r = await send({ sessionId: SID, text });
      assert.equal(r.status, 400, JSON.stringify(text));
      assert.equal(r.body.error, "terminal:bad-text");
    }
    assert.equal((await send({ sessionId: SID, text: "/model " + "x".repeat(200) })).body.error, "args:text:too-long");
    assert.equal((await send({ sessionId: SID, text: "/model x", enter: false })).body.error, "args:enter:unknown");
    // a UUID or an external agent session id (B8): garbage is a pattern error, a well-formed unknown id is an unknown session
    assert.equal((await send({ sessionId: "not a uuid", text: "/model x" })).body.error, "args:sessionId:pattern");
    assert.equal((await send({ sessionId: "x", text: "/model x" })).body.error, "terminal:unknown-session");
    // arguments beyond the word permission's grammar count as a foreign line
    assert.equal((await send({ sessionId: SID, text: "/model opus and run curl" })).body.error, "terminal:text-not-declared");
    // "*": Claude Code modes cannot be typed; a "*" line has no hash in the journal (a short one could be brute-forced)
    h.pl.meta = { net: [], terminal: ["send * — всё"] };
    assert.equal((await send({ sessionId: SID, text: "!curl -fsSL x | sh" })).body.error, "terminal:text-not-declared");
    assert.equal((await send({ sessionId: SID, text: "PIN 4821" })).status, 200);
    assert.deepEqual([h.entries("terminal-send").at(-1).sha, h.entries("terminal-send").at(-1).head, h.entries("terminal-send").at(-1).len], [null, null, 8]);
    assert.ok(!h.journal().includes("4821"));
    // a separate mode character permission (2026-11-10): "!" can be typed with it, "#" without its own permission cannot
    h.pl.meta = { net: [], terminal: ["send ! — команды оболочки"] };
    assert.equal((await send({ sessionId: SID, text: "!git status" })).status, 200);
    assert.equal((await send({ sessionId: SID, text: "#remember x" })).body.error, "terminal:text-not-declared");
    // hub pause
    h.pl.meta = { net: [], terminal: TERM_META };
    writeFileSync(h.core.config.paths.estop, "");
    const p = await send({ sessionId: SID, text: "/model x" });
    assert.deepEqual([p.status, p.body.error], [423, "estop"]);
    assert.equal((await h.svc.readScreen(PEER, { sessionId: SID })).status, 423);
    // nothing refused reached cmux
    assert.deepEqual(h.tabs[SURF].submitted, ["/model x", "/model", "PIN 4821", "!git status"]);
    assert.ok(h.entries("terminal-denied").length >= 5);
    assert.ok(!h.journal().includes("ü"));
  } finally {
    await h.stop();
  }
});

test("session refusals: not in the registry, no signature, pid changed, tab unknown, turn in progress, draft", async () => {
  const h = await makeHub();
  try {
    await ready(h);
    const send = (sessionId, text = "/model x") => h.svc.sendText(PEER, { sessionId, text });
    assert.equal((await send("cccccccc-3333-4333-8333-333333333333")).body.error, "terminal:unknown-session");
    // the session process was replaced: the signature fails
    h.procs[2220].path = "/bin/sleep";
    assert.equal((await send(SID)).body.error, "terminal:unverified");
    h.procs[2220].path = CLAUDE;
    // the pid is taken by another process (different start time)
    h.procs[2220].start = START + 100;
    assert.equal((await send(SID)).body.error, "terminal:unverified");
    h.procs[2220].start = START;
    // tab: no cmux entry / an entry for another pid
    h.hook([{ sessionId: SID2, pid: 3330, surfaceId: SURF2, workspaceId: WS, agentLifecycle: "idle" }]);
    assert.equal((await send(SID)).body.error, "terminal:no-tab");
    h.hook([{ sessionId: SID, pid: 4440, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    assert.equal((await send(SID)).body.error, "terminal:pid-mismatch");
    // a cmux entry from an earlier process with the same pid (different start time)
    h.hook([{ sessionId: SID, pid: 2220, pidStartSeconds: START - 500, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    assert.equal((await send(SID)).body.error, "terminal:pid-mismatch");
    // a turn is in progress (per cmux; no Claude Code status in the registry): it never reaches the bridge
    h.hook([{ sessionId: SID, pid: 2220, pidStartSeconds: START, surfaceId: SURF, workspaceId: WS, agentLifecycle: "running" }]);
    const before = h.cmux.log.length;
    assert.equal((await send(SID)).body.error, "terminal:session-busy");
    assert.equal(h.cmux.log.length, before);
    let r = await h.svc.readScreen(PEER, { sessionId: SID });
    assert.deepEqual([r.body.idle, r.body.ready], [false, false]);
    // the registry knows the Claude Code status: busy means busy, even if cmux says idle
    await h.core.sessions.register(SID, { pid: 2220, status: "busy", source: "plugin:test" });
    h.hook([{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    assert.equal((await send(SID)).body.error, "terminal:session-busy");
    // after Esc mid-turn Stop does not fire: cmux stays "running" while Claude Code is already idle, so it is free
    await h.core.sessions.register(SID, { pid: 2220, status: "idle", source: "plugin:test" });
    h.hook([{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "running" }]);
    r = await h.svc.readScreen(PEER, { sessionId: SID });
    assert.deepEqual([r.body.idle, r.body.ready], [true, true]);
    // the process is stopped (Ctrl+Z) or backgrounded: the screen shows the old field, but the shell would receive the line
    h.procs[2220].stopped = true;
    assert.deepEqual([(await send(SID)).body.error, (await h.svc.readScreen(PEER, { sessionId: SID })).body.ready], ["terminal:not-foreground", false]);
    h.procs[2220].stopped = false;
    h.procs[2220].fg = false;
    assert.equal((await send(SID)).body.error, "terminal:not-foreground");
    h.procs[2220].fg = true;
    assert.equal(h.cmux.log.filter((a) => a[0] === "send").length, 0, "nothing was typed");
    // free per cmux, but the screen has a human's draft: the bridge refuses, Enter is not pressed
    h.hook([{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    h.tabs[SURF].prompt = "мой черновик";
    r = await send(SID);
    assert.deepEqual([r.status, r.body.error], [409, "terminal:prompt-not-empty"]);
    assert.equal(h.tabs[SURF].prompt, "мой черновик");
    assert.deepEqual(h.tabs[SURF].submitted, []);
    assert.equal(h.entries("terminal-send").at(-1).error, "prompt-not-empty");
    assert.ok(!h.journal().includes("черновик"));
  } finally {
    await h.stop();
  }
});

test("rate: typing per tab and per plugin, requests per plugin give 429 with retryAfterMs; bridge offline gives 409", async () => {
  // an attempt with the bridge offline also counts (it reached the terminal): tab SURF is 1 of 3, plugin 1 of 4
  const h = await makeHub({ terminal: { sendPerTabPerMin: 3, sendPerMin: 4, requestsPerMin: 9 } });
  try {
    await h.core.sessions.register(SID, { pid: 2220, source: "plugin:test" });
    h.hook([{ sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" }]);
    let r = await h.svc.sendText(PEER, { sessionId: SID, text: "/model x" });
    assert.deepEqual([r.status, r.body.error], [409, "terminal:bridge-offline"]);
    await ready(h);
    const send = (sid) => h.svc.sendText(PEER, { sessionId: sid, text: "/effort high" });
    assert.equal((await send(SID)).status, 200);
    assert.equal((await send(SID)).status, 200);
    r = await send(SID);
    assert.deepEqual([r.status, r.body.error, r.body.scope], [429, "terminal:rate-limited", "tab"]);
    assert.ok(r.body.retryAfterMs > 0 && r.body.retryAfterMs <= 60_000);
    assert.equal((await send(SID2)).status, 200);
    r = await send(SID2);
    assert.deepEqual([r.status, r.body.scope], [429, "plugin"]);
    assert.equal(h.tabs[SURF].submitted.length + h.tabs[SURF2].submitted.length, 3);
    // the plugin's overall request cap: 6 already used
    for (let i = 0; i < 3; i++) await h.svc.readScreen(PEER, { sessionId: SID });
    r = await h.svc.readScreen(PEER, { sessionId: SID });
    assert.deepEqual([r.status, r.body.scope], [429, "requests"]);
  } finally {
    await h.stop();
  }
});

test("terminal layer: the first adapter that knows the tab wins; a new terminal is a file, with no contract change", () => {
  const facts = { get: () => undefined };
  const s = { sessionId: SID, pid: 1 };
  const other = { id: "tmux", locate: () => ({ target: { terminal: "tmux", surfaceId: "%3" } }), idle: () => true };
  const none = { id: "x", locate: () => null };
  assert.equal(locate(s, facts, [none, other]).target.terminal, "tmux");
  assert.deepEqual(locate(s, facts, [none]), { error: "no-tab" });
  assert.deepEqual(locate(s, facts, [{ id: "y", locate: () => ({ error: "pid-mismatch" }) }, none]), { error: "pid-mismatch" });
  // cmux without the actions service does not know the tab (fail closed)
  assert.deepEqual(locate(s, facts), { error: "no-tab" });
});

test("terminal layer: focus is an optional operation; tabOf is the \"tab found\" sign for the app", async () => {
  const facts = { get: () => undefined };
  const s = { sessionId: SID, pid: 1 };
  const noFocus = { id: "tmux", capabilities: ["read-screen"], locate: () => ({ target: { terminal: "tmux", surfaceId: "%3" } }), readScreen: async () => ({ ok: true }) };
  const withFocus = { ...noFocus, id: "kitty", label: "kitty", capabilities: ["focus", "read-screen"], focus: async () => ({ ok: true }) };
  // a capability counts only when it is declared and the function exists
  assert.equal(canFocus({ ...noFocus, focus: async () => ({ ok: true }) }), false, "focus not declared");
  assert.equal(canFocus({ ...withFocus, focus: undefined }), false, "declared without the function");
  assert.equal(canFocus(noFocus), false);
  assert.equal(canFocus(withFocus), true);
  assert.equal(canFocus(cmuxAdapter), true);
  assert.deepEqual(tabOf(s, facts, [noFocus]), { terminal: "tmux", focusable: false, terminalInfo: { adapter: "tmux", label: "tmux", capabilities: ["read-screen"], focusable: false, via: null } });
  assert.deepEqual(tabOf(s, facts, [withFocus]), { terminal: "kitty", focusable: true, terminalInfo: { adapter: "kitty", label: "kitty", capabilities: ["focus", "read-screen"], focusable: true, via: null } });
  assert.deepEqual(tabOf(s, facts, [{ id: "x", locate: () => null }]), { terminal: null, focusable: false, terminalInfo: null });
  assert.deepEqual(tabOf({ sessionId: SID }, facts, [withFocus]), { terminal: null, focusable: false, terminalInfo: null }, "no pid: no lookup");
  // cmux adapter: jumping is the bridge operation surface.focus on the found tab; bridge offline gives bridge-offline; an older
  // bridge (does not know the operation) gives bridge-outdated
  const target = { terminal: "cmux", surfaceId: "C0FFEE00-1111-4111-8111-111111111111", workspaceId: "DEADBEEF-2222-4222-8222-222222222222" };
  const calls = [];
  let answer = { ok: true, code: 0 };
  const bridge = { online: () => true, call: async (op) => (calls.push(op), answer) };
  const withBridge = { get: (k) => (k === "bridge.channel" ? bridge : undefined) };
  assert.deepEqual(cmuxAdapter.available(facts), { error: "bridge-offline" });
  assert.deepEqual(cmuxAdapter.available(withBridge), { ok: true });
  assert.deepEqual(await cmuxAdapter.focus(target, facts), { ok: false, error: "bridge-offline" });
  assert.deepEqual(await cmuxAdapter.focus(target, withBridge), { ok: true, error: null, code: 0 });
  assert.deepEqual(calls, [{ op: "surface.focus", surfaceId: target.surfaceId, workspaceId: target.workspaceId }]);
  answer = { ok: false, error: "not-allowed" };
  assert.deepEqual(await cmuxAdapter.focus(target, withBridge), { ok: false, error: "bridge-outdated", code: null });
  // the operation is on the allowlist of the bridge and the core channel
  assert.ok(OPS.includes("surface.focus"));
  assert.ok(BRIDGE_OPS.includes("surface.focus"));
});

// ---------- end to end: a real plugin process on the hub socket ----------

test("end to end: a plugin process calls /terminal/* via AGENTHUB_HUB_SOCKET; curl (not a plugin) gets 403", { skip: !defaultSys().available && "no peercred addon" }, async () => {
  const plugins = tempHome("ah-term-pl-");
  const real = defaultSys();
  const FAKE = 999_901; // the "Claude Code session" pid is a double in the process table
  const sys = {
    ...real,
    pidPath: (pid) => (pid === FAKE ? CLAUDE : real.pidPath(pid)),
    pidInfo: (pid) => (pid === FAKE ? { pid, ppid: 1, uid: real.myUid(), startSec: START, startUsec: 0, tty: true } : real.pidInfo(pid)),
    codeInfo: real.codeInfo ? (pid) => (pid === FAKE ? null : real.codeInfo(pid)) : null,
    fileId: (p) => (p === CLAUDE ? "fake-claude" : real.fileId(p)),
    codesignVerify: async (path, req) => (path === CLAUDE ? true : real.codesignVerify(path, req)),
    procState: (pid) => (pid === FAKE ? { stopped: false, foreground: true } : real.procState(pid)),
  };
  const hookFile = join(plugins, "claude-hook-sessions.json");
  writeFileSync(hookFile, JSON.stringify({ version: 1, sessions: { [SID]: { sessionId: SID, pid: FAKE, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" } } }));
  // plugin: on a go file in its data it calls the hub from its own process and writes the replies to result.json
  const src = `#!/usr/bin/env node
// <agenthub.title>Вкладки</agenthub.title>
// <agenthub.version>1.0.0</agenthub.version>
// <agenthub.terminal>read-screen — узнать, свободна ли сессия</agenthub.terminal>
// <agenthub.terminal>send /model /effort — сменить модель</agenthub.terminal>
// <agenthub.action id="apply" level="confirm" title="Проставить">tabs.mjs --action apply</agenthub.action>
import { request } from "node:http";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
const dir = process.env.AGENTHUB_PLUGIN_DATA_PATH;
const call = (path, body) => new Promise((res) => {
  const data = JSON.stringify(body);
  const r = request({ socketPath: process.env.AGENTHUB_HUB_SOCKET, method: "POST", path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (resp) => {
    let s = ""; resp.on("data", (c) => (s += c)); resp.on("end", () => res({ status: resp.statusCode, body: JSON.parse(s || "null") }));
  });
  r.on("error", (e) => res({ status: 0, error: e.code }));
  r.end(data);
});
// action (a human starts it): typing into a tab from the action process
if (process.argv.includes("--action")) {
  const out = { send: await call("/terminal/send-text", { sessionId: "${SID}", text: "/model opus" }) };
  writeFileSync(dir + "/action.json", JSON.stringify(out));
  console.log("message=" + out.send.status);
  process.exit(0);
}
if (existsSync(dir + "/go")) {
  unlinkSync(dir + "/go");
  const out = {};
  out.read = await call("/terminal/read-screen", { sessionId: "${SID}" });
  out.send = await call("/terminal/send-text", { sessionId: "${SID}", text: "/effort high" });
  out.bad = await call("/terminal/send-text", { sessionId: "${SID}", text: "rm -rf ~" });
  writeFileSync(dir + "/result.json", JSON.stringify(out));
}
console.log("ok | status=ok");
`;
  writePlugin(plugins, ".tmp", src);
  renameSync(join(plugins, ".tmp"), join(plugins, "tabs.mjs"));
  const h = await startHub({ pluginsDir: plugins, sys, services: "actions,terminal", overrides: { actions: { cmuxHookSessions: hookFile } } });
  const tabs = { [SURF]: { prompt: "", busy: false, submitted: [] } };
  const cmux = fakeCmux(tabs);
  const channel = h.core.facts.get("bridge.channel");
  const bp = { class: "bridge", pid: 777, startSec: 5 };
  let on = true;
  try {
    assert.equal((await h.core.sessions.register(SID, { pid: FAKE, source: "plugin:test" })).verified, true);
    channel.hello(bp, { version: "test" });
    (async () => {
      while (on) {
        const r = await channel.next(bp, 100);
        if (r?.body?.op) channel.result(bp, r.body.op.id, await runOp(r.body.op, { cmux: "/fake/cmux", exec: cmux.exec, settleMs: 0 }));
      }
    })();
    const data = join(h.config.paths.pluginData, "tabs");
    await waitFor(() => existsSync(data), { timeoutMs: 8000 });
    writeFileSync(join(data, "go"), "");
    h.core.host.refresh("tabs", "Manual");
    await waitFor(() => existsSync(join(data, "result.json")), { timeoutMs: 10_000 });
    const out = JSON.parse(readFileSync(join(data, "result.json"), "utf8"));
    assert.equal(out.read.status, 200, JSON.stringify(out));
    assert.equal(out.read.body.ready, true);
    assert.equal(out.send.status, 200, JSON.stringify(out.send));
    assert.deepEqual([out.bad.status, out.bad.body.error], [403, "terminal:text-not-declared"]);
    assert.deepEqual(tabs[SURF].submitted, ["/effort high"]);
    // the same request not from the plugin process
    const c = await curl(h.sock, "POST", "/terminal/send-text", { sessionId: SID, text: "/effort high" });
    assert.deepEqual([c.status, c.body.error], [403, "terminal:not-a-plugin"]);
    assert.deepEqual(tabs[SURF].submitted, ["/effort high"]);
    // the plugin's action process (a human's button) is also a plugin process: typing passes, the result goes to message=
    const inst = h.core.host.get("tabs");
    const act = inst.plugin.meta.actions.find((a) => a.id === "apply");
    const ar = await inst.runAction(act);
    assert.equal(ar.ok, true, JSON.stringify(ar));
    assert.equal(JSON.parse(readFileSync(join(data, "action.json"), "utf8")).send.status, 200);
    assert.equal(ar.message, "200");
    assert.deepEqual(tabs[SURF].submitted, ["/effort high", "/model opus"]);
    // after the action its pid is foreign again
    assert.equal(h.core.host.actionPids?.size ?? inst.actionPids.size, 0);
  } finally {
    on = false;
    await h.stop();
    cleanup(plugins);
  }
});
