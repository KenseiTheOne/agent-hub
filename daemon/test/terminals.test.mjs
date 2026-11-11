// The terminal layer's adapters (lib/terminals/): which terminal a session runs in (the process table), capability gating
// (terminal:unsupported, <capability>-unsupported), the tmux, iTerm2 and Terminal.app adapters, terminal.focus and its alias
// cmux.focus, /state.sessions[].terminalInfo and /state.terminals.
// Everything runs on doubles: the process table and signatures are faked, and every terminal tool (tmux, osascript) is a
// command double (Core opts.terminalExec) over a screen model. No real terminal is ever touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { Core, effectAllowed, THIRD_PARTY_EFFECTS } from "../lib/core.mjs";
import { createPeer } from "../lib/peer.mjs";
import { lintPlugin } from "../lib/registry/perms.mjs";
import { ADAPTERS, capabilitiesOf, findTab, launchAdapter, locate, supports, tabOf, terminalsInfo } from "../lib/terminals/index.mjs";
import { clearCache, hostOf, hostOfPath, ttyOf } from "../lib/terminals/_proc.mjs";
import { refuseExec } from "../lib/terminals/_exec.mjs";
import * as tmux from "../lib/terminals/tmux.mjs";
import * as iterm2 from "../lib/terminals/iterm2.mjs";
import * as terminalApp from "../lib/terminals/terminal-app.mjs";
import { cleanup, tempHome, waitFor } from "./helpers.mjs";

const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const START = 1792600000;
const S_TMUX = "aaaaaaaa-1111-4111-8111-111111111111";
const S_ITERM = "bbbbbbbb-2222-4222-8222-222222222222";
const S_TERM = "cccccccc-3333-4333-8333-333333333333";
const S_OTHER = "dddddddd-4444-4444-8444-444444444444";
const S_CMUX = "eeeeeeee-5555-4555-8555-555555555555";
const SURF = "C0FFEE00-1111-4111-8111-111111111111";
const WS = "DEADBEEF-2222-4222-8222-222222222222";
const APP = { class: "app", pid: 10 };
const CLI = { class: "cli", pid: 20 };
const PLUGIN_PEER = { class: "cli", pid: 21 };
const TMUX_BIN = "/opt/homebrew/bin/tmux";
const ITERM_SERVER = "/Users/u/Library/Application Support/iTerm2/iTermServer-3.5.4";
const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
const RULE = "─".repeat(60);

// The process table: claude → zsh → (login) → terminal host.
function table() {
  const claude = (ppid, tty) => ({ path: CLAUDE, ppid, tty, argv: ["claude"], isTty: true });
  return {
    2220: claude(2221, "ttys012"),
    2221: { path: "/bin/zsh", ppid: 2222 },
    2222: { path: TMUX_BIN, ppid: 1, argv: ["tmux", "-L", "work", "new-session", "-s", "x"] },
    3330: claude(3331, "ttys013"),
    3331: { path: "/bin/zsh", ppid: 3332 },
    3332: { path: "/usr/bin/login", ppid: 3333 },
    3333: { path: ITERM_SERVER, ppid: 1 },
    4440: claude(4441, "ttys014"),
    4441: { path: "/bin/zsh", ppid: 4442 },
    4442: { path: "/usr/bin/login", ppid: 4443 },
    4443: { path: TERMINAL, ppid: 1 },
    5550: claude(5551, "ttys015"),
    5551: { path: "/bin/zsh", ppid: 5552 },
    5552: { path: "/Applications/Ghostty.app/Contents/MacOS/ghostty", ppid: 1 },
    6660: claude(1, "ttys016"),
    // the tmux client of the session runs in iTerm2
    9100: { path: TMUX_BIN, ppid: 9101, argv: ["tmux", "attach"] },
    9101: { path: "/bin/zsh", ppid: 9102 },
    9102: { path: "/usr/bin/login", ppid: 3333 },
  };
}

function fakeSys(procs) {
  return {
    available: true,
    peerPid: () => null,
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid ?? 1, uid: 501, startSec: procs[pid].start ?? START, startUsec: 0, tty: procs[pid].isTty === true } : null),
    procArgv: (pid) => procs[pid]?.argv ?? null,
    codesignVerify: async (path, req) => path === CLAUDE && req.includes("com.anthropic.claude-code"),
    fileId: (p) => `${p}|${JSON.stringify(procs)}`,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
    procState: (pid) => (procs[pid] ? { stopped: false, foreground: true } : null),
    ttyName: (pid) => procs[pid]?.tty ?? null,
  };
}

// Facts for the layer without a hub: the process table and a command double.
function factsOf(procs, exec = refuseExec, extra = {}) {
  const sys = fakeSys(procs);
  return {
    processInfo: sys.pidInfo,
    processPath: sys.pidPath,
    processArgv: sys.procArgv,
    processTty: sys.ttyName,
    terminalExec: exec,
    get: () => undefined,
    ...extra,
  };
}

// ---------- terminal doubles ----------
const screen = (t) => ["● reply text", t.busy ? "✻ Thinking… (3s · esc to interrupt)" : "", RULE, `> ${t.prompt}`, RULE, "  ? for shortcuts", ""].join("\n");

// tmux: panes by tty; capture-pane gives the pane screen; send-keys -l types, Enter submits, Escape is recorded.
// osascript: a focus script answers "ok" for a known tty; a launch script answers "ok".
function fakeTerminals() {
  const panes = { "%7": { tty: "/dev/ttys012", session: "$2", prompt: "", busy: false, submitted: [], keys: [] } };
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === iterm2.OSASCRIPT) {
      const argv = args.slice(args.indexOf("--") + 1);
      const script = args.filter((_, i) => args[i - 1] === "-e").join("\n");
      if (script.includes("tty of")) return { code: 0, stdout: ["/dev/ttys013", "/dev/ttys014", "/dev/ttys020"].includes(argv[0]) ? "ok\n" : "no-tab\n" };
      return { code: 0, stdout: "ok\n" };
    }
    const a = args[0] === "-L" || args[0] === "-S" ? args.slice(2) : args;
    const pane = panes[a[a.indexOf("-t") + 1]];
    switch (a[0]) {
      case "list-panes":
        return { code: 0, stdout: Object.entries(panes).map(([id, p]) => `${p.tty}\t${id}\t${p.session}`).join("\n") + "\n" };
      case "list-clients":
        return { code: 0, stdout: "/dev/ttys020\t9100\n" };
      case "capture-pane":
        return pane ? { code: 0, stdout: screen(pane) } : { code: 1, stdout: "" };
      case "send-keys": {
        if (!pane) return { code: 1, stdout: "" };
        const rest = a.slice(a.indexOf("-t") + 2);
        if (rest[0] === "-l") pane.prompt += rest.at(-1) + (pane.typeAlso || "");
        else if (rest[0] === "Enter") {
          pane.submitted.push(pane.prompt);
          pane.prompt = "";
        } else pane.keys.push(rest[0]);
        return { code: 0, stdout: "" };
      }
      case "select-window":
      case "select-pane":
      case "switch-client":
      case "new-window":
        return { code: 0, stdout: "" };
      default:
        return { code: 1, stdout: "" };
    }
  };
  return { exec, calls, panes };
}

async function makeHub({ launch = "auto", plugin = {} } = {}) {
  const home = tempHome("ah-terms-");
  const claudeHome = join(home, "claude");
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  const cmuxFile = join(home, "claude-hook-sessions.json");
  const config = loadConfig({
    env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"), AGENTHUB_CLAUDE_HOME: claudeHome, AGENTHUB_SERVICES: "actions,terminal" },
    overrides: {
      actions: { cmuxHookSessions: cmuxFile, launch: { registerTimeoutMs: 3000, pollMs: 50 } },
      services: { actions: { pickupMs: 300, resultMs: 1000 }, terminal: { launch } },
    },
  });
  const procs = table();
  const term = fakeTerminals();
  const core = new Core({ config, peer: createPeer({ config, sys: fakeSys(procs) }), terminalExec: term.exec });
  await core.init();
  const pl = { id: "tabs", source: "builtin", granted: null, meta: { net: [], terminal: ["read-screen — why", "send /model — why"] }, ...plugin };
  core.host.pluginByPid = (pid) => (pid === PLUGIN_PEER.pid ? pl : null);
  clearCache();
  const project = tempHome("ah-terms-proj-");
  const h = {
    home,
    project,
    config,
    core,
    term,
    cmuxFile,
    svc: core.facts.get("terminal.api"),
    journal: () => (existsSync(config.paths.journal) ? readFileSync(config.paths.journal, "utf8") : ""),
    async register(sid, pid, status = "idle") {
      assert.equal((await core.sessions.register(sid, { pid, source: "plugin:test", status })).verified, true);
    },
    async stop() {
      await core.stop();
      cleanup(home);
      cleanup(project);
    },
  };
  return h;
}

async function confirmed(core, id, args, peer = APP) {
  const first = await core.invoke({ id, args, peer });
  if (first.status !== 428) return { first, final: first };
  return { first, final: await core.invoke({ id, args, confirmToken: first.body.token, peer }) };
}

// ---------- detection ----------

test("detection: the nearest terminal among the process's ancestors — tmux, iTerm2 (iTermServer), Terminal.app; other hosts stop the walk", () => {
  clearCache();
  const f = factsOf(table());
  assert.deepEqual(hostOf(2220, f), { id: "tmux", pid: 2222, path: TMUX_BIN });
  assert.equal(hostOf(3330, f).id, "iterm2");
  assert.equal(hostOf(4440, f).id, "terminal-app");
  assert.equal(hostOf(5550, f).id, "ghostty", "a host without an adapter is still the nearest one");
  assert.equal(hostOf(6660, f), null, "no terminal among the ancestors");
  assert.equal(hostOf(9100, f).id, "iterm2", "a tmux client runs in iTerm2");
  assert.equal(hostOfPath("/Applications/iTerm.app/Contents/MacOS/iTerm2"), "iterm2");
  assert.equal(hostOfPath("/Applications/cmux.app/Contents/MacOS/cmux"), "cmux");
  assert.equal(hostOfPath("/usr/local/Cellar/tmux/3.5a/bin/tmux"), "tmux");
  assert.equal(hostOfPath("/usr/bin/login"), null);
  // without the process facts — nothing (no lookup outside the hub)
  assert.equal(hostOf(2220, { get: () => undefined }), null);
  assert.equal(ttyOf(2220, f), "/dev/ttys012");
  assert.equal(ttyOf(2220, { processTty: () => "??" }), null);
  assert.equal(ttyOf(2220, { processTty: () => "ttys0; rm" }), null);
});

test("adapter selection: each session goes to the adapter of its terminal; cmux keeps its own tabs; unknown hosts get none", () => {
  clearCache();
  const f = factsOf(table());
  const pick = (pid) => {
    const r = locate({ sessionId: S_OTHER, pid }, f);
    return r.error ? r.error : r.adapter.id;
  };
  assert.equal(pick(2220), "tmux");
  assert.equal(pick(3330), "iterm2");
  assert.equal(pick(4440), "terminal-app");
  assert.equal(pick(5550), "no-tab");
  assert.equal(pick(6660), "no-tab");
  // tmux target: the server binary and its socket from the server's argv
  const t = locate({ sessionId: S_OTHER, pid: 2220 }, f).target;
  assert.deepEqual(t, { terminal: "tmux", tab: "pid:2220", pid: 2220, bin: TMUX_BIN, socket: ["-L", "work"] });
  assert.deepEqual(tmux.socketArgs(["tmux", "-S", "/tmp/s", "new"]), ["-S", "/tmp/s"]);
  assert.deepEqual(tmux.socketArgs(["tmux", "new", "-L", "x"]), [], "flags of the command are not the server's");
  assert.deepEqual(tmux.socketArgs(["tmux", "-L", "a b"]), [], "an odd socket name — the default socket");
  // capabilities as declared by each adapter
  assert.deepEqual(
    ADAPTERS.map((a) => [a.id, capabilitiesOf(a)]),
    [
      ["cmux", ["focus", "read-screen", "send-text", "send-esc", "launch"]],
      ["tmux", ["focus", "read-screen", "send-text", "send-esc", "launch"]],
      ["iterm2", ["focus", "launch"]],
      ["terminal-app", ["focus", "launch"]],
    ],
  );
  assert.equal(supports(iterm2, "send-text"), false);
  assert.deepEqual(tabOf({ sessionId: S_OTHER, pid: 3330 }, f), {
    terminal: "iterm2",
    focusable: true,
    terminalInfo: { adapter: "iterm2", label: "iTerm2", capabilities: ["focus", "launch"], focusable: true, via: null },
  });
});

test("launch terminal: the setting, otherwise the terminal of most sessions, otherwise the first installed (tmux only by setting or sessions)", () => {
  const none = () => false;
  const only = (...paths) => (p) => paths.includes(p);
  assert.equal(launchAdapter({}, { prefer: "iterm2", exists: none }).adapter.id, "iterm2");
  assert.equal(launchAdapter({}, { prefer: "nope", exists: none }), null);
  const sessions = [{ terminal: "tmux" }, { terminal: "tmux" }, { terminal: "cmux" }];
  assert.deepEqual(launchAdapter({}, { sessions, exists: none }).adapter.id, "tmux");
  assert.equal(launchAdapter({}, { sessions, exists: none }).why, "sessions");
  assert.equal(launchAdapter({}, { sessions: [{ terminal: "cmux" }, { terminal: "iterm2" }], exists: none }).adapter.id, "cmux", "a tie — adapter order");
  assert.equal(launchAdapter({}, { exists: only("/Applications/iTerm.app", ...terminalApp.APP_PATHS) }).adapter.id, "iterm2");
  assert.equal(launchAdapter({}, { exists: only(...tmux.BIN_PATHS, ...terminalApp.APP_PATHS) }).adapter.id, "terminal-app", "an installed tmux is not picked by itself");
  assert.equal(launchAdapter({}, { exists: none }), null);
  // Settings → Terminal: every adapter with its capabilities, availability and session count
  const info = terminalsInfo({ get: () => undefined }, { sessions, exists: only("/Applications/cmux.app") });
  assert.deepEqual(info.launch, { adapter: "tmux", why: "sessions" });
  const cmuxRow = info.adapters.find((a) => a.id === "cmux");
  assert.deepEqual(cmuxRow, { id: "cmux", label: "cmux", capabilities: ["focus", "read-screen", "send-text", "send-esc", "launch"], via: "bridge", installed: true, available: false, reason: "bridge-offline", sessions: 1 });
  assert.equal(info.adapters.find((a) => a.id === "tmux").sessions, 2);
});

// ---------- adapters on command doubles ----------

test("tmux: focus selects the pane by tty and raises the window of the client's terminal; screen flags only; typing follows the bridge protocol", async () => {
  clearCache();
  const term = fakeTerminals();
  const f = factsOf(table(), term.exec);
  const t = locate({ sessionId: S_OTHER, pid: 2220 }, f).target;
  assert.deepEqual(await tmux.focus(t, f), { ok: true });
  const tm = term.calls.filter((c) => c[0] === TMUX_BIN).map((c) => c.slice(1));
  assert.deepEqual(tm, [
    ["-L", "work", "list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_id}"],
    ["-L", "work", "select-window", "-t", "%7"],
    ["-L", "work", "select-pane", "-t", "%7"],
    ["-L", "work", "switch-client", "-t", "%7"],
    ["-L", "work", "list-clients", "-t", "$2", "-F", "#{client_tty}\t#{client_pid}"],
  ]);
  // the client runs in iTerm2: its session on the client's tty comes to the front
  const osa = term.calls.find((c) => c[0] === iterm2.OSASCRIPT);
  assert.deepEqual(osa.slice(-2), ["--", "/dev/ttys020"]);
  assert.ok(!osa.slice(0, -1).join(" ").includes("ttys020"), "the tty is an argument, not part of the script");

  const pane = term.panes["%7"];
  const r = await tmux.readScreen(t, f, {});
  assert.deepEqual(r, { ok: true, promptFound: true, promptEmpty: true, busy: false });
  assert.ok(!JSON.stringify(r).includes("reply text"));
  assert.deepEqual(await tmux.sendText(t, "/model opus", f, { settleMs: 0 }), { ok: true });
  assert.deepEqual(pane.submitted, ["/model opus"]);
  const typed = term.calls.find((c) => c.includes("-l"));
  assert.deepEqual(typed.slice(-3), ["-l", "--", "/model opus"], "literal typing, the line after --");
  // a draft in the field — refused before typing; someone typed meanwhile — no Enter
  pane.prompt = "draft";
  assert.deepEqual(await tmux.sendText(t, "/model x", f, { settleMs: 0 }), { ok: false, error: "prompt-not-empty" });
  pane.prompt = "";
  pane.busy = true;
  assert.deepEqual(await tmux.sendText(t, "/model x", f, { settleMs: 0 }), { ok: false, error: "session-busy" });
  pane.busy = false;
  pane.typeAlso = "!";
  assert.deepEqual(await tmux.sendText(t, "/model x", f, { settleMs: 0 }), { ok: false, error: "prompt-mismatch" });
  assert.deepEqual(pane.submitted, ["/model opus"]);
  pane.prompt = "";
  pane.typeAlso = "";
  assert.deepEqual(await tmux.sendKey(t, "escape", f), { ok: true });
  assert.deepEqual(pane.keys, ["Escape"]);
  assert.deepEqual(await tmux.sendKey(t, "enter", f), { ok: false, error: "bad-key" });
  // a session whose tty has no pane
  const other = { ...t, pid: 6660 };
  assert.deepEqual(await tmux.focus(other, f), { ok: false, error: "no-tab" });
  // a failing tool
  const broken = factsOf(table(), async () => ({ code: 1, stdout: "" }));
  assert.deepEqual(await tmux.readScreen(t, broken, {}), { ok: false, error: "tmux-failed" });
});

test("iTerm2 and Terminal.app: focus by the tab's tty through osascript argv; launch quotes the command; no screen, typing or Esc", async () => {
  clearCache();
  const term = fakeTerminals();
  const f = factsOf(table(), term.exec);
  const it = locate({ sessionId: S_OTHER, pid: 3330 }, f);
  assert.deepEqual(await it.adapter.focus(it.target, f), { ok: true });
  assert.deepEqual(term.calls.at(-1).slice(-2), ["--", "/dev/ttys013"]);
  assert.ok(term.calls.at(-1).join("\n").includes('tell application "iTerm2"'));
  const ta = locate({ sessionId: S_OTHER, pid: 4440 }, f);
  assert.deepEqual(await ta.adapter.focus(ta.target, f), { ok: true });
  assert.ok(term.calls.at(-1).join("\n").includes('tell application "Terminal"'));
  assert.deepEqual(term.calls.at(-1).slice(-2), ["--", "/dev/ttys014"]);
  // osascript says the tab is gone
  assert.deepEqual(await iterm2.focusTty("/dev/ttys099", f), { ok: false, error: "no-tab" });
  for (const a of [iterm2, terminalApp]) {
    assert.equal(a.readScreen, undefined);
    assert.equal(a.sendText, undefined);
    assert.equal(a.sendKey, undefined);
  }
  // the launch command: every value single-quoted, the cwd's quote escaped
  const cmd = iterm2.launchCommand({ cwd: "/Users/u/it's here", name: "Work 1", sessionId: S_OTHER, promptFile: "/h/launch/x.prompt" }, "/hub/bridge/launch.sh");
  assert.equal(cmd, ` cd '/Users/u/it'\\''s here' && exec '/hub/bridge/launch.sh' '${S_OTHER}' 'Work 1' '/h/launch/x.prompt'`);
  // test mode without a double: nothing runs
  const refused = factsOf(table());
  assert.deepEqual(await iterm2.focus(it.target, refused), { ok: false, error: "terminal-test-mode" });
});

// ---------- primitives through the core ----------

test("session.focus: tmux, iTerm2 and Terminal.app sessions; a host without an adapter — no-terminal; /state carries terminalInfo", async () => {
  const h = await makeHub();
  try {
    await h.register(S_TMUX, 2220);
    await h.register(S_ITERM, 3330);
    await h.register(S_TERM, 4440);
    await h.register(S_OTHER, 5550);
    const st = h.core.snapshot();
    const by = Object.fromEntries(st.sessions.map((s) => [s.sessionId, s]));
    assert.equal(by[S_TMUX].terminal, "tmux", "contract 3: terminal stays the adapter id");
    assert.equal(by[S_TMUX].focusable, true);
    assert.deepEqual(by[S_ITERM].terminalInfo, { adapter: "iterm2", label: "iTerm2", capabilities: ["focus", "launch"], focusable: true, via: null });
    assert.deepEqual([by[S_OTHER].terminal, by[S_OTHER].focusable, by[S_OTHER].terminalInfo], [null, false, null]);
    assert.deepEqual(st.terminals.adapters.map((a) => [a.id, a.sessions]), [["cmux", 0], ["tmux", 1], ["iterm2", 1], ["terminal-app", 1]]);
    for (const sid of [S_TMUX, S_ITERM, S_TERM]) {
      const r = await h.core.invoke({ id: "session.focus", args: { sessionId: sid }, peer: CLI });
      assert.equal(r.status, 200, `${sid}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, true);
    }
    const r = await h.core.invoke({ id: "session.focus", args: { sessionId: S_OTHER }, peer: CLI });
    assert.equal(r.body.error, "facts:no-terminal");
    assert.ok(h.term.calls.some((c) => c.includes("select-pane")));
    assert.equal(h.term.calls.filter((c) => c[0] === iterm2.OSASCRIPT).length, 3, "iTerm2, Terminal and the tmux client's iTerm2 window");
  } finally {
    await h.stop();
  }
});

test("session.interrupt: Esc where the terminal supports it — tmux by the registry status; iTerm2 refuses esc-unsupported", async () => {
  const h = await makeHub();
  try {
    await h.register(S_TMUX, 2220, "idle");
    await h.register(S_ITERM, 3330, "busy");
    let r = await h.core.invoke({ id: "session.interrupt", args: { sessionId: S_ITERM }, peer: APP });
    assert.equal(r.body.error, "facts:esc-unsupported");
    r = await h.core.invoke({ id: "session.interrupt", args: { sessionId: S_TMUX }, peer: APP });
    assert.equal(r.body.error, "facts:not-running", "tmux knows no turns: the registry says idle");
    await h.register(S_TMUX, 2220, "busy");
    const { first, final } = await confirmed(h.core, "session.interrupt", { sessionId: S_TMUX });
    assert.equal(first.status, 428);
    assert.equal(final.status, 200, JSON.stringify(final.body));
    assert.equal(final.body.ok, true);
    assert.deepEqual(h.term.panes["%7"].keys, ["Escape"]);
  } finally {
    await h.stop();
  }
});

test("session.launch: the chosen terminal opens the tab (Terminal.app via osascript), the launch is tracked by the core registry", async () => {
  const h = await makeHub({ launch: "terminal-app" });
  try {
    const events = [];
    h.core.bus.on("event", (e) => events.push(e));
    const project = join(h.project, "project dir");
    mkdirSync(project);
    const args = { cwd: project, name: "Launch test", prompt: "secret prompt text" };
    const { first, final } = await confirmed(h.core, "session.launch", args);
    assert.equal(first.status, 428);
    assert.match(first.body.text, /new Terminal tab|новая вкладка Terminal/);
    assert.equal(final.status, 200, JSON.stringify(final.body));
    assert.equal(final.body.result.terminal, "terminal-app");
    const call = h.term.calls.find((c) => c[0] === iterm2.OSASCRIPT);
    assert.ok(call.join("\n").includes("do script"));
    const cmd = call.at(-1);
    assert.ok(cmd.includes("'Launch test'") && cmd.includes(`'${project}'`) && cmd.includes("launch.sh"), cmd);
    assert.ok(!JSON.stringify(h.term.calls).includes("secret prompt"), "the prompt goes only in the 0600 file");
    assert.ok(!h.journal().includes("secret prompt"));
    // the session appears in the core registry → registered (pretend launch.sh started claude as pid 4440)
    await h.core.sessions.register(final.body.result.sessionId, { pid: 4440, source: "hook" });
    await waitFor(() => h.journal().includes('"type":"launch-registered"'));
    assert.match(h.journal(), /"type":"launch-registered"[^\n]*"terminal":"terminal-app"/);
  } finally {
    await h.stop();
  }
});

test("session.launch: no terminal can open a tab — no-launch-terminal; cmux without the bridge — bridge-offline as before", async () => {
  let h = await makeHub({ launch: "kitty" });
  try {
    const r = await h.core.invoke({ id: "session.launch", args: { cwd: h.project, name: "x" }, peer: APP });
    assert.equal(r.body.error, "facts:no-launch-terminal");
  } finally {
    await h.stop();
  }
  h = await makeHub({ launch: "cmux" });
  try {
    const r = await h.core.invoke({ id: "session.launch", args: { cwd: h.project, name: "x" }, peer: APP });
    assert.equal(r.body.error, "facts:bridge-offline");
  } finally {
    await h.stop();
  }
});

test("terminal.focus and its alias cmux.focus: the same tab through the layer; the effects ceiling treats them as one name", async () => {
  const h = await makeHub();
  try {
    writeFileSync(h.cmuxFile, JSON.stringify({ version: 1, sessions: { [S_CMUX]: { sessionId: S_CMUX, pid: 7770, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" } } }));
    let r = await h.core.invoke({ id: "terminal.focus", args: { surfaceId: SURF }, peer: CLI });
    assert.equal(r.body.error, "facts:bridge-offline");
    r = await h.core.invoke({ id: "cmux.focus", args: { surfaceId: SURF }, peer: CLI });
    assert.equal(r.body.error, "facts:bridge-offline");
    // a fake bridge answers surface.focus
    const ch = h.core.facts.get("bridge.channel");
    const bp = { class: "bridge", pid: 777, startSec: 5 };
    ch.hello(bp, { version: "test" });
    const ops = [];
    let on = true;
    (async () => {
      while (on) {
        const n = await ch.next(bp, 100);
        if (n?.body?.op) {
          ops.push(n.body.op.op);
          ch.result(bp, n.body.op.id, { ok: true, code: 0 });
        }
      }
    })();
    try {
      for (const id of ["terminal.focus", "cmux.focus"]) {
        r = await h.core.invoke({ id, args: { surfaceId: SURF, workspaceId: WS }, peer: CLI });
        assert.equal(r.status, 200, `${id}: ${JSON.stringify(r.body)}`);
        assert.deepEqual([r.body.ok, r.body.result.terminal], [true, "cmux"]);
      }
      assert.deepEqual(ops, ["surface.focus", "surface.focus"]);
      r = await h.core.invoke({ id: "terminal.focus", args: { surfaceId: "11111111-1111-4111-8111-999999999999" }, peer: CLI });
      assert.equal(r.body.error, "facts:unknown-surface");
    } finally {
      on = false;
    }
    const en = h.core.primitives.get("terminal.focus").describe({ surfaceId: SURF }, h.core.facts, "en").text;
    assert.equal(en, `Switch to terminal tab ${SURF.slice(0, 8)}…`);
  } finally {
    await h.stop();
  }
  // alias in <agenthub.effects>: either name allows the other; both are under the third-party ceiling
  assert.equal(effectAllowed("terminal.focus", ["cmux.focus"]), true);
  assert.equal(effectAllowed("cmux.focus", ["terminal.focus"]), true);
  assert.equal(effectAllowed("session.focus", ["cmux.focus"]), false);
  assert.ok(THIRD_PARTY_EFFECTS.includes("terminal.focus") && THIRD_PARTY_EFFECTS.includes("cmux.focus"));
  // the registry lint marks cmux.focus deprecated, terminal.focus passes clean
  const lint = (effects) => lintPlugin({ id: "x", meta: { effects, name: "x" }, lang: "en" });
  assert.ok(lint(["cmux.focus"]).warnings.some((w) => w.includes("cmux.focus") && w.includes("deprecated")));
  assert.ok(!lint(["terminal.focus"]).warnings.some((w) => w.includes("deprecated")));
  assert.ok(!lint(["terminal.focus"]).errors.some((e) => e.includes("terminal.focus")));
});

test("findTab: no adapter with findTab knows the tab — unknown-surface; an adapter's refusal stops the search", () => {
  const a = { id: "a", findTab: () => null };
  const b = { id: "b", findTab: () => ({ error: "bridge-offline" }) };
  const c = { id: "c", findTab: () => ({ target: { terminal: "c", tab: "1" } }) };
  assert.deepEqual(findTab({ surfaceId: SURF }, {}, [a]), { error: "unknown-surface" });
  assert.deepEqual(findTab({ surfaceId: SURF }, {}, [b, c]), { error: "bridge-offline" });
  assert.equal(findTab({ surfaceId: SURF }, {}, [a, c]).adapter.id, "c");
});

// ---------- /terminal/* routes through the adapters ----------

test("/terminal/*: tmux sessions read and type through tmux; iTerm2 sessions — 409 terminal:unsupported naming the terminal and capability", async () => {
  const h = await makeHub();
  try {
    await h.register(S_TMUX, 2220, "idle");
    await h.register(S_ITERM, 3330, "idle");
    let r = await h.svc.readScreen(PLUGIN_PEER, { sessionId: S_TMUX });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.terminal, r.body.ready], ["tmux", true]);
    r = await h.svc.sendText(PLUGIN_PEER, { sessionId: S_TMUX, text: "/model opus" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(h.term.panes["%7"].submitted, ["/model opus"]);
    const sent = h.journal().split("\n").filter((l) => l.includes('"type":"terminal-send"')).map((l) => JSON.parse(l));
    assert.deepEqual([sent[0].terminal, sent[0].tab, sent[0].surfaceId], ["tmux", "pid:2220", null]);
    r = await h.svc.readScreen(PLUGIN_PEER, { sessionId: S_ITERM });
    assert.deepEqual([r.status, r.body], [409, { error: "terminal:unsupported", terminal: "iterm2", capability: "read-screen" }]);
    r = await h.svc.sendText(PLUGIN_PEER, { sessionId: S_ITERM, text: "/model opus" });
    assert.deepEqual([r.status, r.body.error, r.body.capability], [409, "terminal:unsupported", "send-text"]);
    assert.ok(h.journal().includes('"error":"terminal:unsupported"'));
  } finally {
    await h.stop();
  }
});

test("a test hub without a command double never starts a terminal tool", async () => {
  const home = tempHome("ah-terms-real-");
  try {
    const config = loadConfig({ env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "nb"), AGENTHUB_SERVICES: "none" } });
    const core = new Core({ config, peer: createPeer({ config, sys: fakeSys(table()) }) });
    assert.equal(core.terminalExec, refuseExec);
    assert.deepEqual(await core.facts.terminalExec("/usr/bin/osascript", ["-e", "beep"]), { code: -1, stdout: "", timedOut: false, refused: "test-mode" });
  } finally {
    cleanup(home);
  }
});
