// Peer classes on system doubles (process table) + real codesign on system binaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("hook from a shell without a signed agent among ancestors → peer:no-agent-ancestor", async () => {
  const procs = {
    300: { ppid: 200, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    200: { ppid: 1, path: "/bin/zsh" },
  };
  const r = await createPeer({ config: cfg(), sys: fakeSys(procs, { signed: SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.equal(r.class, "cli");
  assert.equal(r.reason, "peer:no-agent-ancestor");
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
  assert.equal(r.reason, "peer:no-agent-ancestor");
});

test("hook: cmux shim (unsigned bash script) — not Claude", async () => {
  const procs = {
    300: { ppid: 200, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    200: { ppid: 1, path: "/bin/bash", argv: ["bash", "/var/folders/x/cmux-cli-shims/claude"] },
  };
  const r = await createPeer({ config: cfg(), sys: fakeSys(procs, { signed: SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.equal(r.reason, "peer:no-agent-ancestor");
});

test("the hook's session_id is checked against ~/.claude/sessions/<Claude pid>.json", async () => {
  const procs = {
    300: { ppid: 100, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    100: { ppid: 1, path: CLAUDE },
  };
  const sessions = { "/Users/u/.claude/sessions/100.json": { pid: 100, sessionId: "11111111-1111-4111-8111-111111111111" } };
  const peer = createPeer({ config: cfg(), sys: fakeSys(procs, { signed: SIGNED, sessions, peerPidByFd: { 7: 300 } }) });
  const info = await peer.classifyFd(7);
  assert.deepEqual(await peer.verifyHookSession(info, "11111111-1111-4111-8111-111111111111"), { ok: true });
  assert.equal((await peer.verifyHookSession(info, "22222222-2222-4222-8222-222222222222")).reason, "peer:session-mismatch");
  assert.equal((await peer.verifyHookSession(info, undefined)).reason, "peer:session-mismatch");
  assert.equal((await peer.verifyHookSession({ class: "cli" }, "x")).reason, "peer:not-hook");
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

// --- Codex CLI (lib/hook/agents.mjs): the same hook class with a signed codex ancestor, a different session proof

const CODEX = "/opt/homebrew/Caskroom/codex/0.159.3/codex";
const CODEX_HOOK = "/Users/u/.codex/plugins/cache/agent-hub/agent-hub/0.1.13/hook/agenthub-hook";
const THREAD = "019a5b2c-1111-7222-8333-444455556666";
const codexCfg = (over = {}) =>
  cfg({
    requirements: { ...cfg().requirements, codex: DEFAULTS.requirements.codex },
    peer: { ...DEFAULTS.peer, hookPaths: ["/Users/u/.claude/plugins/**/agenthub-hook", "/Users/u/.codex/plugins/**/agenthub-hook"] },
    ...over,
  });
const CODEX_SIGNED = { ...SIGNED, [CODEX]: ['identifier "codex"'] };

test("hook: agenthub-hook ← $SHELL -lc ← signed codex → class hook, agent codex, no claudePid", async () => {
  const procs = {
    300: { ppid: 200, path: "/opt/homebrew/bin/node", argv: ["node", CODEX_HOOK] },
    200: { ppid: 100, path: "/bin/zsh", argv: ["/bin/zsh", "-lc", "agenthub-hook"] },
    100: { ppid: 1, path: CODEX, argv: ["codex", "app-server", "--listen", "unix://"] },
  };
  const r = await createPeer({ config: codexCfg(), sys: fakeSys(procs, { signed: CODEX_SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.equal(r.class, "hook");
  assert.equal(r.agent, "codex");
  assert.equal(r.agentPid, 100);
  assert.equal(r.claudePid, undefined, "claudePid stays Claude Code's: consumers that read it never see a codex pid");
  // the Claude Code case carries both
  const c = await createPeer({ config: codexCfg(), sys: fakeSys({ 300: { ppid: 100, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] }, 100: { ppid: 1, path: CLAUDE } }, { signed: CODEX_SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.deepEqual([c.agent, c.agentPid, c.claudePid], ["claude", 100, 100]);
});

test("hook: a codex binary with another signature, or without requirements.codex → peer:no-agent-ancestor", async () => {
  const procs = {
    300: { ppid: 100, path: "/opt/homebrew/bin/node", argv: ["node", CODEX_HOOK] },
    100: { ppid: 1, path: CODEX },
  };
  const unsigned = await createPeer({ config: codexCfg(), sys: fakeSys(procs, { signed: SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.equal(unsigned.reason, "peer:no-agent-ancestor");
  const c = codexCfg();
  c.requirements.codex = null;
  const off = await createPeer({ config: c, sys: fakeSys(procs, { signed: CODEX_SIGNED, peerPidByFd: { 7: 300 } }) }).classifyFd(7);
  assert.equal(off.reason, "peer:no-agent-ancestor");
});

test("Codex session proof: the thread lock open in the codex ancestor + transcript_path = that thread's rollout under sessions/", async () => {
  const home = mkdtempSync(join(tmpdir(), "ah-codex-"));
  try {
    const codexHome = join(home, "codex");
    const day = join(codexHome, "sessions", "2026", "11", "22");
    mkdirSync(day, { recursive: true });
    mkdirSync(join(codexHome, "thread-writer-locks"));
    const lock = join(codexHome, "thread-writer-locks", `${THREAD}.lock`);
    writeFileSync(lock, "");
    const rollout = join(day, `rollout-2026-11-22T10-00-00-${THREAD}.jsonl`);
    const procs = {
      300: { ppid: 100, path: "/opt/homebrew/bin/node", argv: ["node", CODEX_HOOK] },
      100: { ppid: 1, path: CODEX },
    };
    let holders = [100];
    let lsof = 0;
    const sys = {
      ...fakeSys(procs, { signed: CODEX_SIGNED, peerPidByFd: { 7: 300 } }),
      fileHolders: async (p) => {
        lsof++;
        return p === lock ? holders : [];
      },
    };
    const peer = createPeer({ config: codexCfg({ codexHome, peer: { ...codexCfg().peer, hookSessionCacheMs: 0 } }), sys });
    const info = await peer.classifyFd(7);
    const v = (sid, transcript_path = rollout) => peer.verifyHookSession(info, sid, { transcript_path });
    assert.deepEqual(await v(THREAD), { ok: true });
    // the rollout file may not exist yet (Codex writes it with the first record): its directory is resolved
    assert.deepEqual(await v(THREAD, join(codexHome, "sessions", "2026", "11", "23", `rollout-2026-11-23T00-00-00-${THREAD}.jsonl`)), { ok: true });
    // another thread's id, a non-UUID, a foreign rollout name, a path outside sessions/, "..", a link out of sessions/
    const OTHER = "019a5b2c-9999-7222-8333-444455556666";
    assert.equal((await v(OTHER, join(day, `rollout-2026-11-22T10-00-00-${OTHER}.jsonl`))).reason, "peer:no-session-file", "no lock file for that thread");
    assert.equal((await v("../../etc/x")).reason, "peer:session-mismatch");
    // only the lowercase spelling Codex itself prints: the same thread in uppercase is another name — refused
    assert.equal((await v(THREAD.toUpperCase(), join(day, `rollout-2026-11-22T10-00-00-${THREAD.toUpperCase()}.jsonl`))).reason, "peer:session-mismatch");
    assert.equal((await v(THREAD, join(day, `rollout-2026-11-22T10-00-00-${THREAD.toUpperCase()}.jsonl`))).reason, "peer:session-mismatch");
    assert.equal((await v(THREAD, join(day, `rollout-2026-11-22T10-00-00-${OTHER}.jsonl`))).reason, "peer:session-mismatch");
    assert.equal((await v(THREAD, join(home, `rollout-2026-11-22T10-00-00-${THREAD}.jsonl`))).reason, "peer:session-mismatch");
    assert.equal((await v(THREAD, `${day}/../22/rollout-2026-11-22T10-00-00-${THREAD}.jsonl`)).reason, "peer:session-mismatch");
    assert.equal((await v(THREAD, "sessions/rollout-x-" + THREAD + ".jsonl")).reason, "peer:session-mismatch", "relative");
    assert.equal((await v(THREAD, null)).reason, "peer:session-mismatch", "no transcript_path");
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(codexHome, "sessions", "link"));
    assert.equal((await v(THREAD, join(codexHome, "sessions", "link", `rollout-2026-11-22T10-00-00-${THREAD}.jsonl`))).reason, "peer:session-mismatch");
    // the lock is held by another process (another codex hosts the thread) / lsof failed
    holders = [555];
    assert.equal((await v(THREAD)).reason, "peer:session-mismatch");
    holders = null;
    assert.equal((await v(THREAD)).reason, "peer:no-session-file");
    // a lock that is a link, not a file
    holders = [100];
    rmSync(lock);
    symlinkSync(rollout, lock);
    assert.equal((await v(THREAD)).reason, "peer:no-session-file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex session proof: a positive answer is cached for a single-session launch (TUI), never for the shared daemon; a negative one never", async () => {
  const home = mkdtempSync(join(tmpdir(), "ah-codex-"));
  try {
    const codexHome = join(home, "codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    mkdirSync(join(codexHome, "thread-writer-locks"));
    writeFileSync(join(codexHome, "thread-writer-locks", `${THREAD}.lock`), "");
    const rollout = join(codexHome, "sessions", `rollout-2026-11-22T10-00-00-${THREAD}.jsonl`);
    for (const [argv, cached] of [
      [["codex"], true],
      [["codex", "app-server", "--listen", "unix://"], false],
      [["codex", "app-server"], false],
      [null, false],
    ]) {
      const procs = { 300: { ppid: 100, path: "/opt/homebrew/bin/node", argv: ["node", CODEX_HOOK] }, 100: { ppid: 1, path: CODEX, argv } };
      let holders = [];
      let lsof = 0;
      const sys = { ...fakeSys(procs, { signed: CODEX_SIGNED, peerPidByFd: { 7: 300 } }), fileHolders: async () => (lsof++, holders) };
      const peer = createPeer({ config: codexCfg({ codexHome }), sys });
      const info = await peer.classifyFd(7);
      const v = async () => (await peer.verifyHookSession(info, THREAD, { transcript_path: rollout })).ok;
      assert.equal(await v(), false);
      assert.equal(await v(), false);
      assert.equal(lsof, 2);
      holders = [100];
      assert.equal(await v(), true);
      assert.equal(await v(), true);
      assert.equal(lsof, cached ? 3 : 4, JSON.stringify(argv));
      // a thread closed (lock released) in the shared daemon is refused right away
      holders = [];
      assert.equal(await v(), cached, JSON.stringify(argv));
      // the cache never skips the rollout check
      assert.equal((await peer.verifyHookSession(info, THREAD, { transcript_path: "/tmp/x.jsonl" })).ok, false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("lsof wrapper: the pids that have the file open; none → []; a failure → null", async () => {
  const sys = defaultSys();
  const dir = mkdtempSync(join(tmpdir(), "ah-lsof-"));
  try {
    const f = join(dir, "x.lock");
    writeFileSync(f, "");
    assert.deepEqual(await sys.fileHolders(f), []);
    const fd = openSync(f, "r");
    try {
      assert.deepEqual(await sys.fileHolders(f), [process.pid]);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
