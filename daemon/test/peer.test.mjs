// Peer classes on system doubles (process table) + real codesign on system binaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, REPO_DIR } from "../lib/config.mjs";
import { APP_DIAGNOSTIC_ARGS, createPeer, defaultSys } from "../lib/peer.mjs";
import { loadNative } from "../lib/native.mjs";
import { onlyDarwin } from "./helpers.mjs";

const UID = 501;
const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const HOOK = "/Users/u/.claude/plugins/cache/agent-hub/agent-hub/1.0.0/hook/agenthub-hook";
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";

// procs: pid → { ppid, path, argv, uid?, start? }
function fakeSys(procs, { signed = {}, sessions = {}, peerPidByFd = {} } = {}) {
  const calls = { codesign: 0 };
  return {
    calls,
    available: true,
    peerPid: (fd) => peerPidByFd[fd] ?? null,
    peerUid: () => UID,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: procs[pid].uid ?? UID, startSec: procs[pid].start ?? 1000, startUsec: 0, comm: "x" } : null),
    procArgv: (pid) => procs[pid]?.argv ?? null,
    codesignVerify: async (path, req) => {
      calls.codesign++;
      return (signed[path] || []).some((r) => req.includes(r));
    },
    fileId: (path) => `${path}|id`,
    myUid: () => UID,
    readJson: (p) => {
      if (!(p in sessions)) throw new Error("ENOENT");
      return sessions[p];
    },
  };
}

function cfg(over = {}) {
  return {
    ...structuredClone(DEFAULTS),
    claudeHome: "/Users/u/.claude",
    requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aaaa"', claudeCode: DEFAULTS.requirements.claudeCode },
    peer: { ...DEFAULTS.peer, hookPaths: ["/Users/u/.claude/plugins/**/agenthub-hook"] },
    ...over,
  };
}

const SIGNED = { [CLAUDE]: ["com.anthropic.claude-code"], [APP]: ["com.kensei.agenthub"] };

test("app: path inside AgentHub.app and signature per requirements.app", async () => {
  const sys = fakeSys({ 10: { ppid: 1, path: APP } }, { signed: SIGNED, peerPidByFd: { 5: 10 } });
  const peer = createPeer({ config: cfg(), sys });
  const r = await peer.classifyFd(5);
  assert.equal(r.class, "app");
});

test("app with a foreign/ad hoc signature → cli with reason peer:app-signature", async () => {
  const sys = fakeSys({ 10: { ppid: 1, path: APP } }, { signed: {}, peerPidByFd: { 5: 10 } });
  const r = await createPeer({ config: cfg(), sys }).classifyFd(5);
  assert.equal(r.class, "cli");
  assert.equal(r.reason, "peer:app-signature");
});

test("app without requirements.app → cli", async () => {
  const sys = fakeSys({ 10: { ppid: 1, path: APP } }, { signed: SIGNED, peerPidByFd: { 5: 10 } });
  const c = cfg();
  c.requirements.app = null;
  const r = await createPeer({ config: c, sys }).classifyFd(5);
  assert.equal(r.class, "cli");
  assert.equal(r.reason, "peer:app-requirement-missing");
  assert.equal(sys.calls.codesign, 0);
});

test("hook: node agenthub-hook ← sh -c ← signed Claude Code", async () => {
  const procs = {
    300: { ppid: 200, path: "/opt/homebrew/Cellar/node/26/bin/node", argv: ["node", HOOK] },
    200: { ppid: 100, path: "/bin/sh", argv: ["sh", "-c", "agenthub-hook"] },
    100: { ppid: 50, path: CLAUDE },
    50: { ppid: 1, path: "/bin/zsh" },
  };
  const sys = fakeSys(procs, { signed: SIGNED, peerPidByFd: { 7: 300 } });
  const peer = createPeer({ config: cfg(), sys });
  const r = await peer.classifyFd(7);
  assert.equal(r.class, "hook");
  assert.equal(r.claudePid, 100);
});

test("hook from a shell without Claude among ancestors → peer:no-claude-ancestor", async () => {
  const procs = {
    300: { ppid: 200, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    200: { ppid: 1, path: "/bin/zsh" },
  };
  const r = await createPeer({ config: cfg(), sys: fakeSys(procs, { signed: SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.equal(r.class, "cli");
  assert.equal(r.reason, "peer:no-claude-ancestor");
});

test("hook: Claude more than 4 levels up doesn't count", async () => {
  const procs = {
    306: { ppid: 305, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    305: { ppid: 304, path: "/bin/sh" },
    304: { ppid: 303, path: "/bin/sh" },
    303: { ppid: 302, path: "/bin/sh" },
    302: { ppid: 301, path: "/bin/sh" },
    301: { ppid: 1, path: CLAUDE },
  };
  const r = await createPeer({ config: cfg(), sys: fakeSys(procs, { signed: SIGNED, peerPidByFd: { 7: 306 } }) }).classifyFd(7);
  assert.equal(r.reason, "peer:no-claude-ancestor");
});

test("hook: cmux shim (unsigned bash script) — not Claude", async () => {
  const procs = {
    300: { ppid: 200, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    200: { ppid: 1, path: "/bin/bash", argv: ["bash", "/var/folders/x/cmux-cli-shims/claude"] },
  };
  const r = await createPeer({ config: cfg(), sys: fakeSys(procs, { signed: SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.equal(r.reason, "peer:no-claude-ancestor");
});

test("the hook's session_id is checked against ~/.claude/sessions/<Claude pid>.json", async () => {
  const procs = {
    300: { ppid: 100, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    100: { ppid: 1, path: CLAUDE },
  };
  const sessions = { "/Users/u/.claude/sessions/100.json": { pid: 100, sessionId: "11111111-1111-4111-8111-111111111111" } };
  const peer = createPeer({ config: cfg(), sys: fakeSys(procs, { signed: SIGNED, sessions, peerPidByFd: { 7: 300 } }) });
  const info = await peer.classifyFd(7);
  assert.deepEqual(peer.verifyHookSession(info, "11111111-1111-4111-8111-111111111111"), { ok: true });
  assert.equal(peer.verifyHookSession(info, "22222222-2222-4222-8222-222222222222").reason, "peer:session-mismatch");
  assert.equal(peer.verifyHookSession(info, undefined).reason, "peer:session-mismatch");
  assert.equal(peer.verifyHookSession({ class: "cli" }, "x").reason, "peer:not-hook");
});

test("bridge and others: by script path; everything else — cli", async () => {
  const procs = {
    400: { ppid: 1, path: "/opt/homebrew/bin/node", argv: ["node", "/r/bridge/agenthub-bridge.mjs"] },
    500: { ppid: 1, path: "/usr/bin/curl", argv: ["curl"] },
  };
  const c = cfg();
  c.peer.bridgePaths = ["/r/bridge/agenthub-bridge.mjs"];
  const peer = createPeer({ config: c, sys: fakeSys(procs, { peerPidByFd: { 1: 400, 2: 500 } }) });
  assert.equal((await peer.classifyFd(1)).class, "bridge");
  assert.equal((await peer.classifyFd(2)).class, "cli");
});

test("foreign uid → foreign", async () => {
  const sys = fakeSys({ 10: { ppid: 1, path: "/usr/bin/curl" } }, { peerPidByFd: { 3: 10 } });
  sys.peerUid = () => 0;
  assert.equal((await createPeer({ config: cfg(), sys }).classifyFd(3)).class, "foreign");
});

test("no addon → cli (closed)", async () => {
  const sys = fakeSys({});
  sys.available = false;
  assert.deepEqual(await createPeer({ config: cfg(), sys }).classifyFd(3), { class: "cli", reason: "peer:no-peercred" });
});

test("codesign cache by (pid, start time): a repeat check doesn't call codesign", async () => {
  const procs = { 100: { ppid: 1, path: CLAUDE, start: 5 }, 101: { ppid: 1, path: CLAUDE, start: 6 } };
  const sys = fakeSys(procs, { signed: SIGNED });
  const peer = createPeer({ config: cfg(), sys });
  assert.equal((await peer.verifySigned(100, "claudeCode")).ok, true);
  assert.equal((await peer.verifySigned(100, "claudeCode")).ok, true);
  // another process of the same file — file cache
  assert.equal((await peer.verifySigned(101, "claudeCode")).ok, true);
  assert.equal(sys.calls.codesign, 1);
  // pid reused by another process (new start time, another file) → new check
  procs[100] = { ppid: 1, path: "/bin/sleep", start: 99 };
  assert.equal((await peer.verifySigned(100, "claudeCode")).ok, false);
  assert.equal(sys.calls.codesign, 2);
});

// ---- real codesign on live processes ----
const native = loadNative();

test("real codesign: /bin/sleep — has an Apple signature, but it's not Claude Code", { skip: onlyDarwin("codesign and the peercred addon") || (!native && "no peercred addon") }, async () => {
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const config = cfg({ requirements: { claudeCode: DEFAULTS.requirements.claudeCode, apple: "anchor apple" } });
    const peer = createPeer({ config, sys: defaultSys() });
    const apple = await peer.verifySigned(child.pid, "apple");
    assert.equal(apple.ok, true, "sleep is signed by Apple");
    const cc = await peer.verifySigned(child.pid, "claudeCode");
    assert.equal(cc.ok, false);
    assert.equal(cc.reason, "signature");
    assert.equal((await peer.verifySigned(999_999, "claudeCode")).reason, "no-process");
  } finally {
    child.kill();
  }
});

test("unverified session label: a binary removed by an update is not a \"forgery\"", async () => {
  const { sessionLabel } = await import("../lib/core.mjs");
  assert.equal(sessionLabel("signature"), "подпись не подтверждена");
  assert.match(sessionLabel("no-path"), /Claude Code обновился/);
  assert.equal(sessionLabel("no-path", "en"), "can't verify: Claude Code was updated");
  assert.match(sessionLabel("no-file"), /Claude Code обновился/);
  assert.equal(sessionLabel("no-process"), "процесс завершился");
  assert.equal(sessionLabel("no-peercred"), "подпись не подтверждена");
});

test("no peercred addon → no process info, but the process isn't considered exited", async () => {
  const sys = fakeSys({}, { signed: SIGNED });
  const peer = createPeer({ config: cfg(), sys });
  assert.equal((await peer.verifySigned(100, "claudeCode")).reason, "no-process");
  assert.equal(peer.interactiveProcess(100).reason, "no-process");
  sys.available = false;
  assert.deepEqual(await peer.verifySigned(100, "claudeCode"), { ok: false, pid: 100, reason: "no-peercred" });
  assert.deepEqual(peer.interactiveProcess(100), { ok: false, reason: "no-peercred" });
  assert.equal(sys.calls.codesign, 0);
});

test("shell diagnostic flags: the daemon's list matches QuitPolicy.diagnosticArguments (DaemonLifecycle.swift) plus --probe-peer", () => {
  const swift = readFileSync(join(REPO_DIR, "app", "Sources", "AgentHubKit", "DaemonLifecycle.swift"), "utf8");
  const m = /static let diagnosticArguments: Set<String> = \[([\s\S]*?)\]/.exec(swift);
  assert.ok(m, "list not found in Swift");
  const fromSwift = [...m[1].matchAll(/"(--[a-z-]+)"/g)].map((x) => x[1]).sort();
  assert.ok(fromSwift.length >= 5);
  assert.deepEqual([...APP_DIAGNOSTIC_ARGS].filter((a) => a !== "--probe-peer").sort(), fromSwift);
  assert.ok(APP_DIAGNOSTIC_ARGS.has("--probe-peer"));
});
