// The binding session → process → tab before a line is typed: "could not be determined" is a refusal, not a pass.
// A start time missing in the registry, in the verification or in the terminal's record of the tab means the pid may belong to
// another process than the one the record was written for — send-text answers 409 terminal:binding-unknown and the adapter
// is never asked to type. read-screen still answers (flags only), with bound: false and ready: false.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TerminalService } from "../lib/services/terminal.mjs";
import * as cmux from "../lib/terminals/cmux.mjs";
import { cleanup, tempHome, waitFor } from "./helpers.mjs";

const SID = "aaaaaaaa-1111-4111-8111-111111111111";
const SURF = "C0FFEE00-1111-4111-8111-111111111111";
const WS = "DEADBEEF-2222-4222-8222-222222222222";
const START = 1792600000;
const PEER = { class: "cli", pid: 20 };
const PLUGIN = { id: "p", trusted: true, terminal: ["read-screen — see whether the session is free", "send /model — switch the model"] };

// registry — the start time in the session registry, verified — the one the signature check just saw, target — what the
// adapter's locate returns, terminal — services.terminal of config.json.
function make({ registry = START, verified = START, target = { terminal: "fake", tab: "t1" }, terminal = {} } = {}) {
  const journal = [];
  const typed = [];
  const adapter = {
    id: "fake",
    capabilities: ["read-screen", "send-text"],
    locate: () => ({ target }),
    idle: () => true,
    readScreen: async () => ({ ok: true, promptFound: true, promptEmpty: true, busy: false }),
    sendText: async (_t, text) => {
      typed.push(text);
      return { ok: true };
    },
  };
  const ctx = {
    config: { services: { terminal } },
    facts: { pluginByPid: () => PLUGIN, provide: () => {} },
    estop: () => false,
    journal: { write: (e) => journal.push(e) },
    emit: () => {},
    sessions: { get: (id) => (id === SID ? { sessionId: SID, pid: 2220, startSec: registry, status: "idle" } : null), list: () => [], external: () => null },
    peer: { verifySigned: async () => ({ ok: true, startSec: verified }), procState: () => ({ stopped: false, foreground: true }) },
  };
  const svc = new TerminalService(ctx, { adapters: [adapter] });
  return { svc, journal, typed, send: () => svc.sendText(PEER, { sessionId: SID, text: "/model opus" }), read: () => svc.readScreen(PEER, { sessionId: SID }) };
}

test("send-text: a confirmed binding types the line; read-screen reports bound and ready", async () => {
  // an adapter that takes the tab from the live process itself leaves `bound` out; one that matched its record says true
  for (const target of [{ terminal: "fake", tab: "t1" }, { terminal: "fake", tab: "t1", bound: true }]) {
    const h = make({ target });
    try {
      const r = await h.read();
      assert.deepEqual([r.status, r.body.bound, r.body.ready], [200, true, true]);
      assert.equal((await h.send()).status, 200);
      assert.deepEqual(h.typed, ["/model opus"]);
    } finally {
      h.svc.dispose();
    }
  }
});

test("send-text: the terminal could not match its record of the tab to the process — refused, nothing typed", async () => {
  const h = make({ target: { terminal: "fake", tab: "t1", bound: false } });
  try {
    const r = await h.send();
    assert.deepEqual([r.status, r.body], [409, { error: "terminal:binding-unknown", part: "tab", terminal: "fake" }]);
    assert.deepEqual(h.typed, [], "the adapter was never asked to type");
    assert.deepEqual(h.journal.filter((e) => e.type === "terminal-denied"), [{ type: "terminal-denied", plugin: "p", op: "send-text", sessionId: SID, error: "terminal:binding-unknown", part: "tab" }]);
    assert.equal(h.journal.filter((e) => e.type === "terminal-send").length, 0);
    // the screen flags are still readable, but the tab is not offered for typing
    const read = await h.read();
    assert.deepEqual([read.status, read.body.bound, read.body.ready, read.body.promptEmpty], [200, false, false, true]);
  } finally {
    h.svc.dispose();
  }
});

test("send-text: no process start time in the registry or in the verification — refused, nothing typed", async () => {
  for (const opts of [{ registry: null }, { verified: null }, { registry: null, verified: null }]) {
    const h = make(opts);
    try {
      const r = await h.send();
      assert.deepEqual([r.status, r.body], [409, { error: "terminal:binding-unknown", part: "process" }], JSON.stringify(opts));
      assert.deepEqual(h.typed, []);
      const read = await h.read();
      assert.deepEqual([read.status, read.body.bound, read.body.ready], [200, false, false]);
    } finally {
      h.svc.dispose();
    }
  }
});

test("terminal-denied carries the part of terminal:binding-unknown, in the first line and in the counted one; other refusals have none", async () => {
  const denied = (h) => h.journal.filter((e) => e.type === "terminal-denied");
  const line = (part, more = {}) => ({ type: "terminal-denied", plugin: "p", op: "send-text", sessionId: SID, error: "terminal:binding-unknown", part, ...more });
  // the process half: one line at once, the repeats of the window in one more — both say which half
  const h = make({ registry: null, terminal: { deniedWindowMs: 120 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await h.send()).body.part, "process");
    assert.deepEqual(denied(h), [line("process")]);
    await waitFor(() => denied(h).length === 2, { timeoutMs: 3000, stepMs: 20 });
    assert.deepEqual(denied(h)[1], line("process", { repeats: 2 }));
  } finally {
    h.svc.dispose();
  }
  // the tab half
  const t = make({ target: { terminal: "fake", tab: "t1", bound: false }, terminal: { deniedWindowMs: 120 } });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await t.send()).body.part, "tab");
    assert.deepEqual(denied(t), [line("tab")]);
    await waitFor(() => denied(t).length === 2, { timeoutMs: 3000, stepMs: 20 });
    assert.deepEqual(denied(t)[1], line("tab", { repeats: 1 }));
  } finally {
    t.svc.dispose();
  }
  // a refusal with another reason has no part
  const u = make({ verified: START + 100 });
  try {
    assert.equal((await u.send()).body.error, "terminal:unverified");
    assert.deepEqual(denied(u).map((e) => [e.error, "part" in e]), [["terminal:unverified", false]]);
  } finally {
    u.svc.dispose();
  }
});

test("send-text: a different start time stays terminal:unverified (the pid belongs to another process)", async () => {
  const h = make({ verified: START + 100 });
  try {
    assert.equal((await h.send()).body.error, "terminal:unverified");
    assert.equal((await h.read()).body.error, "terminal:unverified");
    assert.deepEqual(h.typed, []);
  } finally {
    h.svc.dispose();
  }
});

test("cmux adapter: bound only when both start times are known and equal; a different one is pid-mismatch", () => {
  const home = tempHome("ah-bind-");
  try {
    const file = join(home, "claude-hook-sessions.json");
    const facts = { get: (k) => (k === "actions.config" ? { cmuxHookSessions: file } : null) };
    const entry = (extra) => writeFileSync(file, JSON.stringify({ version: 1, sessions: { [SID]: { sessionId: SID, pid: 2220, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle", ...extra } } }));
    const session = { sessionId: SID, pid: 2220, startSec: START };
    entry({ pidStartSeconds: START });
    assert.equal(cmux.locate(session, facts).target.bound, true);
    entry({ pidStartSeconds: START + 1 });
    assert.equal(cmux.locate(session, facts).target.bound, true, "a one-second difference is rounding");
    // the entry has no start time (an older cmux): the tab is known, the binding is not
    entry({});
    const loose = cmux.locate(session, facts).target;
    assert.deepEqual([loose.surfaceId, loose.bound], [SURF, false]);
    // the session has none
    entry({ pidStartSeconds: START });
    assert.equal(cmux.locate({ sessionId: SID, pid: 2220, startSec: null }, facts).target.bound, false);
    // an entry left from an earlier process with the same pid
    entry({ pidStartSeconds: START - 500 });
    assert.deepEqual(cmux.locate(session, facts), { error: "pid-mismatch" });
  } finally {
    cleanup(home);
  }
});
