// The terminal service in the journal: routine sends are not audit events, and a refusal repeated over and over is written
// once and then counted — one line per window instead of one per request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AUDIT_TYPES, Journal } from "../lib/journal.mjs";
import { TerminalService } from "../lib/services/terminal.mjs";
import * as terminalService from "../lib/services/terminal.mjs";
import { cleanup, tempHome, waitFor } from "./helpers.mjs";

const SID = "aaaaaaaa-1111-4111-8111-111111111111";
const SID2 = "bbbbbbbb-2222-4222-8222-222222222222";
const PEER = { class: "cli", pid: 20 };

function makeCtx({ plugin = { id: "p", trusted: true, terminal: [] }, terminal = {} } = {}) {
  const journal = [];
  const ctx = {
    config: { services: { terminal } },
    facts: { pluginByPid: () => plugin, provide: () => {} },
    estop: () => false,
    journal: { write: (e) => journal.push(e) },
    emit: () => {},
    sessions: { get: () => null, list: () => [], external: () => null },
  };
  return { ctx, journal };
}
const denied = (journal) => journal.filter((e) => e.type === "terminal-denied");

test("audit journal: terminal-send is not an audit type (it would fill the 1 MB file in hours); rare events are", () => {
  assert.ok(!AUDIT_TYPES.has("terminal-send"));
  assert.ok(!AUDIT_TYPES.has("terminal-denied"));
  for (const t of ["estop-set", "app-requirement-changed", "app-pin-path-changed", "shutdown-requested", "bridge-op-late"]) assert.ok(AUDIT_TYPES.has(t), t);
  const dir = tempHome("ah-tj-");
  try {
    const j = new Journal(join(dir, "journal.jsonl"));
    for (let i = 0; i < 30; i++) j.write({ type: "terminal-send", plugin: "p", len: 5, ok: true });
    j.write({ type: "estop-set", on: true });
    assert.equal(j.tail(100).filter((e) => e.type === "terminal-send").length, 30, "sends stay in the main journal");
    assert.deepEqual(j.auditTail(100).map((e) => e.type), ["estop-set"]);
  } finally {
    cleanup(dir);
  }
});

test("terminal-denied: the first refusal is journaled at once, repeats are counted into one line per window", async () => {
  // the plugin declared no terminal permission: every request is refused with terminal:not-declared
  const { ctx, journal } = makeCtx({ terminal: { deniedWindowMs: 150 } });
  const svc = new TerminalService(ctx);
  try {
    for (let i = 0; i < 40; i++) assert.equal((await svc.readScreen(PEER, { sessionId: SID })).body.error, "terminal:not-declared");
    assert.deepEqual(denied(journal), [{ type: "terminal-denied", plugin: "p", op: "read-screen", sessionId: SID, error: "terminal:not-declared" }], "one line for 40 refusals");
    // another session, another operation — different refusals, each written at once
    await svc.readScreen(PEER, { sessionId: SID2 });
    await svc.sendText(PEER, { sessionId: SID, text: "x" });
    await svc.sendText(PEER, { sessionId: SID, text: "x" });
    assert.deepEqual(denied(journal).map((e) => [e.op, e.sessionId, e.repeats ?? null]), [["read-screen", SID, null], ["read-screen", SID2, null], ["send-text", SID, null]]);
    // the window ends: the counts go out without waiting for another request, a refusal with no repeats adds nothing
    await waitFor(() => denied(journal).length === 5, { timeoutMs: 3000, stepMs: 20 });
    assert.deepEqual(
      denied(journal).slice(3).map((e) => [e.op, e.sessionId, e.error, e.repeats]),
      [["read-screen", SID, "terminal:not-declared", 39], ["send-text", SID, "terminal:not-declared", 1]],
    );
    // a new window starts with a plain line again
    await svc.readScreen(PEER, { sessionId: SID });
    assert.equal(denied(journal).length, 6);
    assert.equal(denied(journal).at(-1).repeats, undefined);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(denied(journal).length, 6, "nothing more without repeats");
  } finally {
    svc.dispose();
  }
});

test("terminal-denied: a request-rate refusal is one line per plugin per window, with the count after it", async () => {
  const { ctx, journal } = makeCtx({ plugin: { id: "p", trusted: true, terminal: ["read-screen — x"] }, terminal: { requestsPerMin: 2, deniedWindowMs: 60_000 } });
  const svc = new TerminalService(ctx);
  try {
    for (let i = 0; i < 12; i++) await svc.readScreen(PEER, { sessionId: i % 2 ? SID : SID2 });
    const rate = denied(journal).filter((e) => e.error === "terminal:rate-limited");
    assert.equal(rate.length, 1, JSON.stringify(denied(journal)));
    // the service stops: what was counted so far is written
    svc.dispose();
    const after = denied(journal).filter((e) => e.error === "terminal:rate-limited");
    assert.deepEqual(after.map((e) => e.repeats ?? 0), [0, 9]);
  } finally {
    svc.dispose();
  }
});

test("terminal-denied: more different refusals than the table holds are written uncollapsed, none is lost", async () => {
  const { ctx, journal } = makeCtx({ terminal: { deniedWindowMs: 60_000 } });
  const svc = new TerminalService(ctx);
  try {
    const sid = (i) => `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`;
    for (let i = 0; i < 520; i++) await svc.readScreen(PEER, { sessionId: sid(i) });
    assert.equal(denied(journal).length, 520);
    assert.equal(svc.denied.size, 500);
  } finally {
    svc.dispose();
  }
});

test("terminal service stop() flushes the counted refusals", async () => {
  const { ctx, journal } = makeCtx({ terminal: { deniedWindowMs: 60_000 } });
  // the service instance is reachable through the fact it provides
  let svc = null;
  ctx.facts.provide = (_name, fn) => (svc = fn());
  await terminalService.start(ctx);
  for (let i = 0; i < 3; i++) await svc.readScreen(PEER, { sessionId: SID });
  assert.equal(denied(journal).length, 1);
  await terminalService.stop(ctx);
  assert.deepEqual(denied(journal).map((e) => e.repeats ?? 0), [0, 2]);
});
