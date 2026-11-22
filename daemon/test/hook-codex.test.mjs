// Codex CLI through the same hook path: a real daemon on a socket + the real agenthub-hook, a made-up signed codex
// process as the hook's ancestor (the shared app-server daemon by default), its thread lock "open" in it (lsof double).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_PATH } from "../lib/native.mjs";
import { REPO_DIR } from "../lib/config.mjs";
import { codexMode, AGENTS } from "../lib/hook/agents.mjs";
import { hookStateFor, patchFiles, safeSummary } from "../lib/hook/cards.mjs";
import { pathViolation, writeRisk, writeRiskText } from "../lib/registry/perms.mjs";
import { req, startHub, waitFor } from "./helpers.mjs";
import { APP_REQ, asApp, fakeCodex, runHook, sysDouble } from "./hook-helpers.mjs";

before(() => {
  if (!existsSync(NATIVE_PATH)) execFileSync(join(REPO_DIR, "scripts", "build-native.sh"), { stdio: "ignore" });
});

const T1 = "019a5b2c-1111-7222-8333-444455556666";
const T2 = "019a5b2c-2222-7222-8333-444455556666";
const XPID = 991001;
const XPID2 = 991002;
const SECRET = "SECRET-MARKER-c0d3";

async function hub(hookCfg = {}) {
  const sys = sysDouble();
  asApp(sys);
  const h = await startHub({ sys, services: "hook", overrides: { requirements: { app: APP_REQ }, services: { hook: { sweepMs: 60_000, ...hookCfg } } } });
  h.sys = sys;
  h.st = () => hookStateFor(h.core.facts);
  h.hook = (body, pid = XPID, env) => runHook({ home: h.home, body, claudePid: pid, sys, env });
  h.respond = (args) => req(h.sock, "POST", "/actions/session.respond", { args });
  h.journal = () => readFileSync(h.config.paths.journal, "utf8");
  h.thread = (pid, id, opts) => (h.rollouts[id] = fakeCodex(h, sys, pid, id, opts));
  h.rollouts = {};
  h.start = (id = T1, pid = XPID) => h.hook({ session_id: id, hook_event_name: "SessionStart", source: "startup", transcript_path: h.rollouts[id], cwd: "/x/" + SECRET, model: "gpt-5.5" }, pid);
  return h;
}

// what Codex 0.159.3 sends for a shell command that needs approval
const bash = (h, id = T1, command = `ls ${SECRET}`) => ({
  session_id: id,
  turn_id: "019a5b2c-0000-7000-8000-000000000001",
  transcript_path: h.rollouts[id],
  cwd: "/x/" + SECRET,
  hook_event_name: "PermissionRequest",
  model: "gpt-5.5",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command, description: SECRET },
});

const pendingCard = (h, n = 1) => waitFor(() => h.st().cards.size >= n && [...h.st().cards.values()][n - 1]);
const cardsView = async (h) => (await req(h.sock, "GET", "/hook/cards")).body.cards;

test("codexMode: launch modes from argv", () => {
  const cases = [
    [["codex"], "tui"],
    [["codex", "fix the bug"], "tui"],
    [["codex", "-m", "gpt-5.5", "-c", "x=1", "resume", "--last"], "tui"],
    [["codex", "--no-daemon"], "tui"],
    [["codex", "fork"], "tui"],
    [["codex", "app-server", "--listen", "unix://"], "daemon"],
    // what app-server-daemon/src/backend/pid.rs runs: exactly `--listen unix://`, maybe --remote-control and -c overrides
    [["codex", "app-server", "--remote-control", "--listen", "unix://", "-c", "features.x=true"], "daemon"],
    [["codex", "app-server", "--listen=unix://"], "daemon"],
    // a listener on any other socket path is some other app-server, not the shared daemon
    [["codex", "app-server", "--remote-control", "--listen=unix:///tmp/s"], "app-server"],
    [["codex", "app-server", "--listen", "unix:///tmp/s"], "app-server"],
    [["codex", "app-server", "--listen", "unix://x"], "app-server"],
    [["codex", "app-server", "--listen"], "app-server"],
    [["codex", "app-server"], "app-server"],
    [["codex", "app-server", "--listen", "ws://127.0.0.1:1"], "app-server"],
    [["codex", "app-server", "proxy"], "other"],
    [["codex", "exec", "hi"], "exec"],
    [["codex", "-s", "read-only", "e", "hi"], "exec"],
    [["codex", "review"], "other"],
    [["codex", "mcp-server"], "other"],
    [[], null],
    [null, null],
  ];
  for (const [argv, mode] of cases) assert.equal(codexMode(argv), mode, JSON.stringify(argv));
});

test("Codex process check: tui needs a terminal, the daemon has none, exec only when codexModes says so", () => {
  const p = AGENTS.codex.process;
  assert.deepEqual(p({ tty: true }, ["codex"]), { ok: true, mode: "tui" });
  assert.equal(p({ tty: false }, ["codex"]).reason, "no-tty");
  assert.deepEqual(p({ tty: false }, ["codex", "app-server", "--listen", "unix://"]), { ok: true, mode: "daemon" });
  assert.equal(p({ tty: true }, ["codex", "exec", "x"]).reason, "mode-exec");
  assert.deepEqual(p({ tty: false }, ["codex", "exec", "x"], { codexModes: ["exec"] }), { ok: true, mode: "exec" });
  assert.equal(p({ tty: false }, ["codex", "app-server"]).reason, "mode-app-server");
  assert.equal(p({ tty: true }, ["codex", "app-server", "--listen", "unix://"], { codexModes: ["tui"] }).reason, "mode-daemon");
});

test("Codex summaries: command name, network host, apply_patch file names only — never the body", () => {
  assert.equal(safeSummary("Bash", { command: `FOO=1 /usr/bin/git push ${SECRET}` }, "en", "codex"), "Bash: git");
  assert.equal(safeSummary("Bash", { command: "curl x", description: "network-access api.example.com" }, "en", "codex"), "Network: api.example.com");
  assert.equal(safeSummary("Bash", { command: "x", description: `network-access ${SECRET} /etc` }, "en", "codex"), "Network: command");
  const patch = `*** Begin Patch\n*** Update File: src/a.js\n@@\n-${SECRET}\n+${SECRET}\n*** Add File: /Users/x/b.txt\n+${SECRET}\n*** End Patch`;
  const s = safeSummary("apply_patch", { command: patch }, "en", "codex");
  assert.match(s, /^apply_patch: src\/a\.js, /);
  assert.equal(s.includes(SECRET), false);
  assert.equal(patchFiles("no files here"), null);
  assert.equal(patchFiles("*** Add File: a\n*** Add File: b\n*** Add File: c\n*** Delete File: d\n*** Move to: e"), "a, b, c +2");
  assert.equal(safeSummary("write_stdin", { chars: SECRET }, "en", "codex"), "Input to a process terminal");
  assert.equal(safeSummary("request_permissions", { permissions: { network: {}, [SECRET + " x"]: 1 } }, "en", "codex"), "Permissions: network");
  assert.equal(safeSummary("mcp__github__create_issue", { body: SECRET }, "en", "codex"), "MCP github: create_issue");
  // the same tool names from Claude Code keep their meaning
  assert.equal(safeSummary("Bash", { command: "curl x", description: "network-access h" }, "en"), "Bash: curl");
});

test("plugin permissions: Codex conversations are off limits, a write into Codex settings is a loud risk", () => {
  for (const p of [
    "~/.codex/sessions/2026/11/22/rollout-x.jsonl",
    "~/.codex/archived_sessions",
    "~/.codex/history.jsonl",
    "~/.codex/state_5.sqlite",
    "~/.codex/thread_history_1.sqlite",
    "~/.codex/logs_2.sqlite",
    "~/.codex/memories_1.sqlite",
    "~/.codex/goals_1.sqlite-wal",
    "~/.codex/queue_1.sqlite",
    "~/.codex/session_index.jsonl",
  ])
    assert.ok(pathViolation(p), p);
  assert.equal(pathViolation("~/.codex/config.toml"), null);
  for (const p of ["~/.codex/config.toml", "~/.codex/hooks.json", "~/.codex/rules/default.rules", "~/.codex/plugins/cache/x", "~/.agents/skills/x/SKILL.md", "/etc/codex/requirements.toml", "~/proj/.codex/config.toml"])
    assert.equal(writeRisk(p), "codex", p);
  assert.equal(writeRisk("~/.codexx/a"), null);
  assert.match(writeRiskText("codex", "en"), /Codex settings/);
  assert.match(writeRiskText("codex", "ru"), /Codex/);
});

test("full path: SessionStart from the Codex daemon → card with the verified agent → once → allow; journal without the command", async () => {
  const h = await hub();
  try {
    h.thread(XPID, T1);
    assert.deepEqual((await h.start()).json, {});
    assert.equal(h.st().interactive.get(T1)?.agent, "codex");
    assert.equal(h.st().interactive.get(T1)?.mode, "daemon");
    assert.equal(h.core.sessions.get(T1), null, "not in the Claude Code registry");
    const pending = h.hook(bash(h));
    const card = await pendingCard(h);
    const [view] = await cardsView(h);
    assert.equal(view.agent, "codex");
    assert.equal(view.agentLabel, "Codex");
    assert.equal(view.agentPid, XPID);
    assert.equal(view.claudePid, undefined);
    assert.equal(view.summary, "Bash: ls");
    assert.deepEqual(view.decisions, ["once", "deny", "terminal"]);
    assert.ok(Date.parse(view.expiresAt) - Date.parse(view.createdAt) >= 119_000, "Codex waits codexWaitMs");
    assert.equal((await h.respond({ requestId: card.requestId, decision: "once" })).status, 200);
    const r = await pending;
    assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    const j = h.journal();
    assert.equal(j.includes(SECRET), false, "neither the command nor cwd reaches the journal");
    assert.match(j, new RegExp(`"type":"hook-card".*"agentKind":"codex","agentPid":${XPID}`));
    assert.match(j, /"type":"hook-session".*"agent":"codex".*"interactive":true.*"mode":"daemon"/);
  } finally {
    await h.stop();
  }
});

test("deny → behavior deny with a message; \"decide in terminal\" → {} (Codex asks itself)", async () => {
  const h = await hub();
  try {
    h.thread(XPID, T1);
    await h.start();
    let pending = h.hook(bash(h));
    let card = await pendingCard(h);
    await h.respond({ requestId: card.requestId, decision: "deny" });
    const d = (await pending).json.hookSpecificOutput.decision;
    assert.equal(d.behavior, "deny");
    assert.equal(typeof d.message, "string");
    assert.equal(d.updatedInput, undefined);
    pending = h.hook(bash(h, T1, "ls other"));
    card = await pendingCard(h);
    assert.equal((await h.respond({ requestId: card.requestId, decision: "terminal" })).status, 200);
    assert.deepEqual((await pending).json, {});
    assert.match(h.journal(), /"type":"hook-answer".*"reason":"terminal"/);
    // an "answer" (questions) is never valid for a permission card
    pending = h.hook(bash(h, T1, "ls third"));
    card = await pendingCard(h);
    assert.notEqual((await h.respond({ requestId: card.requestId, decision: "answer", answers: {} })).status, 200);
    await h.respond({ requestId: card.requestId, decision: "terminal" });
    await pending;
  } finally {
    await h.stop();
  }
});

test("no questions for Codex: an AskUserQuestion-shaped request → {} right away, no card", async () => {
  const h = await hub();
  try {
    h.thread(XPID, T1);
    await h.start();
    const r = await h.hook({ ...bash(h), tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "?", header: "h", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }] } });
    assert.deepEqual(r.json, {});
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), /"type":"hook-skip".*"reason":"no-questions"/);
  } finally {
    await h.stop();
  }
});

test("session proof: a lock held by another process, a foreign rollout, a non-UUID id → 403 → {}", async () => {
  const h = await hub();
  try {
    h.thread(XPID, T1, { holder: XPID2 }); // another codex hosts the thread
    h.thread(XPID2, T2);
    assert.deepEqual((await h.hook(bash(h))).json, {});
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), new RegExp(`"type":"hook-denied","agent":"codex","agentPid":${XPID},"error":"peer:session-mismatch"`));
    // T2's own process cannot pass T2's rollout off as T1 either
    assert.deepEqual((await h.hook({ ...bash(h, T2), session_id: T1 }, XPID2)).json, {});
    assert.deepEqual((await h.hook({ ...bash(h, T2), session_id: "../../x" }, XPID2)).json, {});
    assert.equal(h.st().interactive.size, 0);
    // a hook without a signed codex (or claude) among its ancestors is not a hook at all
    const orphan = await runHook({ home: h.home, body: bash(h, T2) });
    assert.deepEqual(orphan.json, {});
    assert.equal(h.st().cards.size, 0);
  } finally {
    await h.stop();
  }
});

test("codex exec gets no card by default; services.hook.codexModes can opt it in", async () => {
  const exec = ["codex", "exec", "-s", "read-only", "hi"];
  const h = await hub();
  try {
    h.thread(XPID, T1, { argv: exec, tty: true });
    assert.deepEqual((await h.start()).json, {});
    assert.equal(h.st().interactive.size, 0);
    assert.match(h.journal(), /"type":"hook-session".*"reason":"proc:mode-exec"/);
    const r = await h.hook(bash(h));
    assert.deepEqual(r.json, {});
    assert.ok(r.ms < 10_000);
    assert.equal(h.st().cards.size, 0);
  } finally {
    await h.stop();
  }
  const h2 = await hub({ codexModes: ["tui", "daemon", "exec"] });
  try {
    h2.thread(XPID, T1, { argv: exec, tty: false });
    const pending = h2.hook(bash(h2)); // lazy registration: no SessionStart (the hub restarted mid-session)
    const card = await pendingCard(h2);
    await h2.respond({ requestId: card.requestId, decision: "once" });
    assert.equal((await pending).json.hookSpecificOutput.decision.behavior, "allow");
    assert.equal(h2.st().interactive.get(T1)?.mode, "exec");
  } finally {
    await h2.stop();
  }
});

test("a TUI without a terminal is not interactive; one daemon hosts several threads; UserPromptSubmit registers; SessionEnd ends", async () => {
  const h = await hub();
  try {
    h.thread(XPID2, T2, { argv: ["codex"], tty: false });
    await h.start(T2, XPID2);
    assert.equal(h.st().interactive.size, 0);
    assert.match(h.journal(), /"reason":"proc:no-tty"/);
    // the daemon: two threads at once, the first registered by UserPromptSubmit (no SessionStart seen)
    h.thread(XPID, T1);
    h.thread(XPID, T2);
    h.sys.holders.set(join(h.codexHome, "thread-writer-locks", `${T2}.lock`), [XPID]);
    assert.deepEqual((await h.hook({ session_id: T1, hook_event_name: "UserPromptSubmit", transcript_path: h.rollouts[T1], prompt: SECRET })).json, {});
    await waitFor(() => h.st().interactive.has(T1));
    await h.start(T2, XPID);
    assert.equal(h.st().interactive.get(T1)?.pid, XPID);
    assert.equal(h.st().interactive.get(T2)?.pid, XPID, "a second thread does not replace the first");
    assert.equal(h.journal().includes(SECRET), false, "the prompt never reaches the hub");
    await h.hook({ session_id: T1, hook_event_name: "SessionEnd", transcript_path: h.rollouts[T1], reason: "exit" });
    await waitFor(() => !h.st().interactive.has(T1));
    assert.equal(h.st().interactive.has(T2), true);
    assert.equal(h.st().ended.has(T1), false, "a Codex SessionEnd never closes a session for good: the lock does");
    // a real SessionEnd drops the thread's lock: its later hooks fail the proof → {}
    h.sys.holders.set(join(h.codexHome, "thread-writer-locks", `${T1}.lock`), []);
    const r = await h.hook(bash(h, T1));
    assert.deepEqual(r.json, {});
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), new RegExp(`"type":"hook-denied","agent":"codex","agentPid":${XPID},"error":"peer:session-mismatch"`));
  } finally {
    await h.stop();
  }
});

test("codexWaitMs: an unanswered Codex card times out into {} (Codex then asks in the terminal)", async () => {
  const h = await hub({ codexWaitMs: 300, waitMs: 60_000 });
  try {
    h.thread(XPID, T1);
    await h.start();
    const r = await h.hook(bash(h));
    assert.deepEqual(r.json, {});
    assert.ok(r.ms >= 250 && r.ms < 20_000, `waited ${r.ms} ms`);
    assert.match(h.journal(), /"type":"hook-cancel".*"reason":"timeout"/);
  } finally {
    await h.stop();
  }
});

test("the card names a plugin-reported Codex session (external) and takes its name", async () => {
  const h = await hub();
  try {
    h.thread(XPID, T1);
    await h.start();
    // what core.noteExternal keeps for a plugin's `agentSession=<id> pid=<pid> agent=codex` line (the id's case may differ)
    h.core.externalMap.set(T1.toUpperCase(), { sessionId: T1.toUpperCase(), pid: XPID, startSec: 1000, kind: "external", agent: "codex", name: "fix tests", owner: "p", updatedAt: Date.now() });
    const pending = h.hook(bash(h));
    const card = await pendingCard(h);
    const [view] = await cardsView(h);
    assert.equal(view.external, true);
    assert.equal(view.sessionName, "fix tests");
    await h.respond({ requestId: card.requestId, decision: "terminal" });
    await pending;
  } finally {
    await h.stop();
  }
});

// --- one process, many threads: a tool command of one thread sends hooks naming another thread of the same daemon

const lockOf = (h, id) => join(h.codexHome, "thread-writer-locks", `${id}.lock`);
async function twoThreads(h) {
  h.thread(XPID, T1);
  h.thread(XPID, T2);
  await h.start(T1);
  await h.start(T2);
  assert.equal(h.st().interactive.size, 2);
}

test("shared daemon: Stop / SessionEnd / UserPromptSubmit naming T2 from the same pid neither cancel T2's card nor end T2", async () => {
  const h = await hub();
  try {
    await twoThreads(h);
    const pending = h.hook(bash(h, T2));
    const card = await pendingCard(h);
    assert.equal(card.sessionId, T2);
    for (const ev of ["Stop", "SessionEnd", "UserPromptSubmit"]) {
      assert.deepEqual((await h.hook({ session_id: T2, hook_event_name: ev, transcript_path: h.rollouts[T2], reason: "other" })).json, {});
    }
    assert.equal(h.st().cards.has(card.requestId), true, "the card still waits");
    assert.equal(h.st().interactive.has(T2), true, "a session with a pending card is not forgotten");
    assert.equal(h.st().ended.has(T2), false);
    assert.equal(/"type":"hook-cancel"/.test(h.journal()), false);
    // the card is still answerable, and the answer goes to the hook that asked
    assert.equal((await h.respond({ requestId: card.requestId, decision: "once" })).status, 200);
    assert.equal((await pending).json.hookSpecificOutput.decision.behavior, "allow");
    // without cards SessionEnd forgets the session (a later request registers it lazily again — nothing is ended)
    await h.hook({ session_id: T2, hook_event_name: "SessionEnd", transcript_path: h.rollouts[T2], reason: "other" });
    await waitFor(() => !h.st().interactive.has(T2));
    assert.equal(h.st().ended.has(T2), false);
    assert.equal(h.st().interactive.has(T1), true);
  } finally {
    await h.stop();
  }
});

test("shared daemon: an identical request from another connection does not supersede the waiting card", async () => {
  const h = await hub();
  try {
    await twoThreads(h);
    const first = h.hook(bash(h, T2));
    const c1 = await pendingCard(h, 1);
    const second = h.hook(bash(h, T2));
    const c2 = await pendingCard(h, 2);
    assert.notEqual(c1.requestId, c2.requestId);
    assert.equal(h.st().cards.has(c1.requestId), true, "the first card is not replaced");
    assert.equal(/"reason":"superseded"/.test(h.journal()), false);
    await h.respond({ requestId: c1.requestId, decision: "deny" });
    await h.respond({ requestId: c2.requestId, decision: "terminal" });
    assert.equal((await first).json.hookSpecificOutput.decision.behavior, "deny");
    assert.deepEqual((await second).json, {});
  } finally {
    await h.stop();
  }
});

test("shared daemon: at most maxPendingPerProcess cards per process, on top of maxPending", async () => {
  const h = await hub({ maxPendingPerProcess: 2 });
  try {
    await twoThreads(h);
    const p1 = h.hook(bash(h, T1, "ls a"));
    await pendingCard(h, 1);
    const p2 = h.hook(bash(h, T2, "ls b"));
    await pendingCard(h, 2);
    const r = await h.hook(bash(h, T1, "ls c"));
    assert.deepEqual(r.json, {});
    assert.equal(h.st().cards.size, 2);
    assert.match(h.journal(), /"type":"hook-skip".*"reason":"too-many-process"/);
    // another codex process still gets its own cards
    h.thread(XPID2, "019a5b2c-3333-7222-8333-444455556666");
    const T3 = "019a5b2c-3333-7222-8333-444455556666";
    await h.start(T3, XPID2);
    const p3 = h.hook(bash(h, T3, "ls d"), XPID2);
    await pendingCard(h, 3);
    for (const c of [...h.st().cards.values()]) await h.respond({ requestId: c.requestId, decision: "terminal" });
    await Promise.all([p1, p2, p3]);
  } finally {
    await h.stop();
  }
});

test("session id spelling: an uppercase thread id is refused (403), even with its lock held", async () => {
  const h = await hub();
  try {
    const UP = T1.toUpperCase();
    h.thread(XPID, T1);
    // the lock file under the uppercase name exists and is held too: the spelling alone decides
    h.thread(XPID, UP);
    const r = await h.hook({ ...bash(h, UP), transcript_path: h.rollouts[UP] });
    assert.deepEqual(r.json, {});
    assert.equal(h.st().cards.size, 0);
    assert.equal(h.st().interactive.size, 0);
    assert.match(h.journal(), /"type":"hook-denied","agent":"codex".*"error":"peer:session-mismatch"/);
  } finally {
    await h.stop();
  }
});

test("subagent: root session_id + agent_id + the subagent's rollout → a subagent card of the root session; without the root's lock → 403", async () => {
  const h = await hub();
  try {
    h.thread(XPID, T1); // root
    h.thread(XPID, T2); // a thread-spawn subagent of T1 in the same process
    await h.start(T1);
    const sub = { ...bash(h, T1, "ls sub"), agent_id: T2, agent_type: "default", transcript_path: h.rollouts[T2] };
    const pending = h.hook(sub);
    const card = await pendingCard(h);
    const [view] = await cardsView(h);
    assert.equal(view.sessionId, T1);
    assert.equal(view.subagent, true);
    await h.respond({ requestId: card.requestId, decision: "terminal" });
    assert.deepEqual((await pending).json, {});
    // the root thread is not hosted here (its lock held elsewhere) → no proof
    h.sys.holders.set(lockOf(h, T1), [XPID2]);
    assert.deepEqual((await h.hook({ ...sub, tool_input: { command: "ls x" } })).json, {});
    assert.equal(h.st().cards.size, 0);
    // a subagent rollout that is not agent_id's → no proof
    h.sys.holders.set(lockOf(h, T1), [XPID]);
    assert.deepEqual((await h.hook({ ...sub, tool_input: { command: "ls y" }, transcript_path: h.rollouts[T1] })).json, {});
    assert.equal(h.st().cards.size, 0);
    assert.equal((h.journal().match(/"type":"hook-denied"/g) || []).length, 2);
  } finally {
    await h.stop();
  }
});
