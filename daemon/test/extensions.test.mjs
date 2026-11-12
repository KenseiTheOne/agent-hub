// External daemon extensions (G4): <home>/Extensions/{services,routes,primitives,terminals}/*.mjs load only after a human approved
// the file's sha256 through the app-only route; a changed file asks again; names of built-ins are refused; every decision is journaled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, testExtensionsOf } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { createPeer } from "../lib/peer.mjs";
import { startServer } from "../lib/server.mjs";
import { cleanup, req, tempHome, waitFor } from "./helpers.mjs";

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const REQ_APP = 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"';

// Any connection is the state.who process: app (the pinned build) or cli (curl).
function sysAs(state) {
  const procs = { 10: { ppid: 1, path: APP }, 20: { ppid: 1, path: "/usr/bin/curl" } };
  const pidOf = { app: 10, cli: 20 };
  return {
    available: true,
    peerPid: () => pidOf[state.who],
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}

// A hub on a given home (a restart keeps the state directory).
async function hubOn(home, { env = {}, services = "none", state = { who: "app" }, overrides = {} } = {}) {
  const claudeHome = join(home, "claude-home");
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  const config = loadConfig({
    env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"), AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log"), AGENTHUB_CLAUDE_HOME: claudeHome, AGENTHUB_SERVICES: services, ...env },
    overrides: { requirements: { app: REQ_APP }, ...overrides },
  });
  const peer = createPeer({ config, sys: sysAs(state) });
  const core = new Core({ config, peer });
  await core.init();
  const srv = await startServer(core);
  return {
    core,
    sock: config.paths.socket,
    state,
    async close() {
      await srv.close();
      await core.stop();
    },
  };
}

const SRC = {
  "services/ext-demo.mjs": `export const name = "ext-demo";
export async function start(ctx) { try { ctx.facts.provide("ext-demo.ping", () => "pong"); } catch {} }
export async function stop() {}
`,
  "primitives/ext-hello.mjs": `export const name = "ext.hello";
export const level = "immediate";
export const argsSchema = {};
export async function run() { return { ok: true }; }
`,
  "routes/ext-demo.mjs": `export const routes = [{ method: "GET", path: "/ext-demo/hello", peers: ["app", "cli"], handler: async () => ({ status: 200, body: { hello: "world" } }) }];
`,
  "terminals/demo-term.mjs": `export const id = "demo-term";
export const label = "Demo";
export const capabilities = ["focus"];
export const messages = { ru: { "needs-helper": "Установите помощник" }, en: { "needs-helper": "Install the helper" } };
export function locate() { return null; }
export function available() { return { error: "needs-helper", setup: true }; }
export async function focus() { return { ok: true }; }
`,
};

function writeExt(home, path, text, mode = 0o644) {
  const file = join(home, "Extensions", path);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, text);
  chmodSync(file, mode);
  return createHash("sha256").update(text).digest("hex");
}

function journal(home) {
  return readFileSync(join(home, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const itemOf = (st, path) => st.extensions.items.find((i) => i.path === path);

test("extensions: listed as pending and not loaded until the app approves the exact sha256; then all four kinds load at once", async () => {
  const home = tempHome("ah-ext-");
  const sums = Object.fromEntries(Object.entries(SRC).map(([p, s]) => [p, writeExt(home, p, s)]));
  const h = await hubOn(home, { services: "ext-demo" });
  try {
    let st = (await req(h.sock, "GET", "/state")).body;
    assert.equal(st.extensions.enabled, true);
    assert.match(st.extensions.consent, /полными правами/, "the consent text says it is code with full rights (hub language)");
    assert.equal(st.extensions.pending, 4);
    for (const p of Object.keys(SRC)) {
      const it = itemOf(st, p);
      assert.equal(it.status, "pending", p);
      assert.equal(it.loaded, false);
      assert.equal(it.sha256, sums[p]);
    }
    assert.equal(h.core.facts.get("ext-demo.ping"), undefined, "an unapproved service does not run");
    assert.ok(!st.primitives.some((p) => p.name === "ext.hello"));
    assert.equal((await req(h.sock, "GET", "/ext-demo/hello")).status, 404);
    assert.ok(!st.terminals.adapters.some((a) => a.id === "demo-term"));
    const denied = journal(home).filter((e) => e.type === "extension-denied");
    assert.deepEqual(denied.map((e) => e.path).sort(), Object.keys(SRC).sort());
    assert.ok(denied.every((e) => e.status === "pending"));

    // not the app — refused; a wrong digest — 409 with the current one
    h.state.who = "cli";
    assert.equal((await req(h.sock, "POST", "/extensions/approve", { path: "services/ext-demo.mjs", sha256: sums["services/ext-demo.mjs"] })).status, 403);
    assert.equal((await req(h.sock, "GET", "/extensions")).status, 200, "cli may read the list");
    h.state.who = "app";
    const wrong = await req(h.sock, "POST", "/extensions/approve", { path: "services/ext-demo.mjs", sha256: "0".repeat(64) });
    assert.equal(wrong.status, 409);
    assert.deepEqual(wrong.body, { error: "extensions:changed", sha256: sums["services/ext-demo.mjs"] });
    assert.equal((await req(h.sock, "POST", "/extensions/approve", { path: "../x.mjs", sha256: "0".repeat(64) })).status, 400);
    assert.equal((await req(h.sock, "POST", "/extensions/approve", { path: "services/none.mjs", sha256: "0".repeat(64) })).status, 404);

    for (const p of Object.keys(SRC)) {
      const r = await req(h.sock, "POST", "/extensions/approve", { path: p, sha256: sums[p] });
      assert.equal(r.status, 200, p);
      assert.equal(r.body.item.status, "approved");
      assert.equal(r.body.item.loaded, true, p);
    }
    assert.equal(h.core.facts.get("ext-demo.ping"), "pong");
    assert.deepEqual((await req(h.sock, "GET", "/ext-demo/hello")).body, { hello: "world" });
    st = (await req(h.sock, "GET", "/state")).body;
    assert.ok(st.primitives.some((p) => p.name === "ext.hello"));
    assert.equal((await req(h.sock, "POST", "/actions/ext.hello", {})).status, 200, "an extension primitive is called like a built-in one");
    const term = st.terminals.adapters.find((a) => a.id === "demo-term");
    assert.deepEqual(
      { source: term.source, available: term.available, reason: term.reason, needsSetup: term.needsSetup, reasonText: term.reasonText, messages: term.messages },
      { source: "extension", available: false, reason: "needs-helper", needsSetup: true, reasonText: "Установите помощник", messages: { "needs-helper": "Установите помощник" } },
    );
    assert.equal(st.extensions.pending, 0);
    const approvals = JSON.parse(readFileSync(join(home, "Registry", "ext-approvals.json"), "utf8"));
    assert.equal(approvals.files["services/ext-demo.mjs"].sha256, sums["services/ext-demo.mjs"]);
    const j = journal(home);
    assert.equal(j.filter((e) => e.type === "extension-approved").length, 4);
    assert.equal(j.filter((e) => e.type === "extension-load").length, 4);
  } finally {
    await h.close();
  }

  // a restart: approved files load by themselves (routes too); a changed file is "changed" and does not load
  const changed = writeExt(home, "services/ext-demo.mjs", SRC["services/ext-demo.mjs"] + "// edited\n");
  const h2 = await hubOn(home, { services: "ext-demo" });
  try {
    const st = (await req(h2.sock, "GET", "/state")).body;
    assert.equal(itemOf(st, "routes/ext-demo.mjs").status, "approved");
    assert.equal(itemOf(st, "routes/ext-demo.mjs").loaded, true);
    assert.deepEqual((await req(h2.sock, "GET", "/ext-demo/hello")).body, { hello: "world" });
    const svc = itemOf(st, "services/ext-demo.mjs");
    assert.equal(svc.status, "changed");
    assert.equal(svc.loaded, false);
    assert.equal(svc.sha256, changed);
    assert.equal(h2.core.facts.get("ext-demo.ping"), undefined);
    assert.ok(journal(home).some((e) => e.type === "extension-denied" && e.path === "services/ext-demo.mjs" && e.status === "changed"));
    // approved again — loads right away
    const r = await req(h2.sock, "POST", "/extensions/approve", { path: "services/ext-demo.mjs", sha256: changed });
    assert.equal(r.body.item.loaded, true);
    assert.equal(h2.core.facts.get("ext-demo.ping"), "pong");
    // revoke: the module keeps running until a restart, the item says so
    const rv = await req(h2.sock, "POST", "/extensions/revoke", { path: "services/ext-demo.mjs" });
    assert.equal(rv.status, 200);
    assert.equal(rv.body.item.status, "revoked", "a revoked module still loaded is not \"changed\"");
    assert.equal(rv.body.item.restartRequired, true);
  } finally {
    await h2.close();
    cleanup(home);
  }
});

test("extensions: a name of a built-in is refused; an approval written into the file while the daemon runs grants nothing; unsafe files", async () => {
  const home = tempHome("ah-ext-");
  writeExt(home, "primitives/dup.mjs", `export const name = "open.url"; export const level = "immediate"; export async function run() { return { ok: true }; }\n`);
  writeExt(home, "routes/dup.mjs", `export const routes = [{ method: "GET", path: "/state", peers: ["cli"], handler: async () => ({ status: 200, body: { evil: true } }) }];\n`);
  writeExt(home, "terminals/dup.mjs", `export const id = "cmux"; export function locate() { return null; }\n`);
  writeExt(home, "services/dup.mjs", `export const name = "push"; export async function start() {}\n`);
  writeExt(home, "services/loose.mjs", `export async function start() {}\n`, 0o666);
  const h = await hubOn(home, { env: { AGENTHUB_TEST_EXTENSIONS: "1" }, services: "dup,loose" });
  try {
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.equal(st.extensions.testAutoApprove, true);
    for (const p of ["primitives/dup.mjs", "routes/dup.mjs", "terminals/dup.mjs", "services/dup.mjs"]) {
      const it = itemOf(st, p);
      assert.equal(it.status, "error", p);
      assert.equal(it.error, "name-taken", p);
      assert.equal(it.loaded, false);
      assert.ok(it.errorText);
    }
    assert.notEqual((await req(h.sock, "GET", "/state")).body.evil, true, "the built-in route still answers");
    const loose = itemOf(st, "services/loose.mjs");
    assert.equal(loose.error, "unsafe-file");
    const r = await req(h.sock, "POST", "/extensions/approve", { path: "services/loose.mjs", sha256: "0".repeat(64) });
    assert.deepEqual([r.status, r.body.error], [409, "extensions:unsafe-file"]);
    assert.ok(journal(home).filter((e) => e.type === "extension-error" && e.error === "name-taken").length >= 4);
  } finally {
    await h.close();
  }
  // without the test flag: a hand-written approval while running is not honoured (memory and file must agree)
  const text = `export const name = "late"; export async function start(ctx) { try { ctx.facts.provide("late.ran", () => true); } catch {} }\n`;
  const h2 = await hubOn(home, { services: "late" });
  try {
    const sum = writeExt(home, "services/late.mjs", text);
    mkdirSync(join(home, "Registry"), { recursive: true });
    writeFileSync(join(home, "Registry", "ext-approvals.json"), JSON.stringify({ version: 1, files: { "services/late.mjs": { sha256: sum, approvedAt: null } } }));
    const st = (await req(h2.sock, "GET", "/extensions")).body;
    assert.equal(st.items.find((i) => i.path === "services/late.mjs").status, "pending");
    assert.equal(h2.core.facts.get("late.ran"), undefined);
  } finally {
    await h2.close();
    cleanup(home);
  }
});

test("extensions: the test auto-approval works only with AGENTHUB_HOME away from the live directory; extensions.enabled=false skips the folder", async () => {
  assert.equal(testExtensionsOf({ AGENTHUB_TEST_EXTENSIONS: "1" }), false, "no AGENTHUB_HOME — the live hub");
  assert.equal(testExtensionsOf({ AGENTHUB_TEST_EXTENSIONS: "1", AGENTHUB_HOME: "/tmp/ah-x" }, "/tmp/ah-x"), true);
  assert.equal(testExtensionsOf({ AGENTHUB_HOME: "/tmp/ah-x" }, "/tmp/ah-x"), false);
  const home = tempHome("ah-ext-");
  writeExt(home, "routes/off.mjs", SRC["routes/ext-demo.mjs"]);
  const h = await hubOn(home, { env: { AGENTHUB_TEST_EXTENSIONS: "1" }, overrides: { extensions: { enabled: false } } });
  try {
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual([st.extensions.enabled, st.extensions.items.length], [false, 0]);
    assert.equal((await req(h.sock, "GET", "/ext-demo/hello")).status, 404);
  } finally {
    await h.close();
    cleanup(home);
  }
});

test("extensions: a file added while the daemon runs shows up as pending (extensions.changed event)", async () => {
  const home = tempHome("ah-ext-");
  mkdirSync(join(home, "Extensions", "routes"), { recursive: true, mode: 0o700 });
  const h = await hubOn(home);
  const events = [];
  h.core.on("extensions.changed", (ev) => events.push(ev));
  try {
    writeExt(home, "routes/new.mjs", SRC["routes/ext-demo.mjs"]);
    h.core.extensions.rescan();
    const ev = await waitFor(() => events.find((e) => e.extensions.items.some((i) => i.path === "routes/new.mjs")));
    assert.equal(ev.extensions.items[0].status, "pending");
  } finally {
    await h.close();
    cleanup(home);
  }
});

// Review 2026-11-12 (C4): a revoked module that still runs has its own status, is not "changed" and is not counted as pending.
test("extensions: revoke → status revoked (restartRequired), not pending; changed only on a sha mismatch with the approval", async () => {
  const home = tempHome("ah-ext-");
  const sum = writeExt(home, "services/ext-demo.mjs", SRC["services/ext-demo.mjs"]);
  const h = await hubOn(home, { services: "ext-demo" });
  try {
    assert.equal((await req(h.sock, "POST", "/extensions/approve", { path: "services/ext-demo.mjs", sha256: sum })).body.item.loaded, true);
    const rv = await req(h.sock, "POST", "/extensions/revoke", { path: "services/ext-demo.mjs" });
    assert.deepEqual([rv.body.item.status, rv.body.item.loaded, rv.body.item.restartRequired, rv.body.item.approvedSha256], ["revoked", true, true, null]);
    let st = (await req(h.sock, "GET", "/extensions")).body;
    assert.equal(st.pending, 0, "a revoked module asks for nothing");
    // approved again with the same bytes: approved, the running module is the approved one
    const again = await req(h.sock, "POST", "/extensions/approve", { path: "services/ext-demo.mjs", sha256: sum });
    assert.deepEqual([again.body.item.status, again.body.item.restartRequired], ["approved", false]);
    // the file changes under an approval: changed (sha mismatch), pending again
    writeExt(home, "services/ext-demo.mjs", SRC["services/ext-demo.mjs"] + "// v2\n");
    st = (await req(h.sock, "GET", "/extensions")).body;
    assert.deepEqual([st.items[0].status, st.items[0].restartRequired, st.pending], ["changed", true, 1]);
  } finally {
    await h.close();
    cleanup(home);
  }
});

// Review 2026-11-12 (C5): two approvals at once load the module once.
test("extensions: two concurrent approvals load and start an extension once", async () => {
  const home = tempHome("ah-ext-");
  const text = `let n = 0;
export const name = "ext-slow";
export async function start(ctx) { n++; await new Promise((r) => setTimeout(r, 100)); try { ctx.facts.provide("ext-slow.starts", () => n); } catch {} }
`;
  const sum = writeExt(home, "services/ext-slow.mjs", text);
  const psum = writeExt(home, "primitives/ext-once.mjs", SRC["primitives/ext-hello.mjs"].replace("ext.hello", "ext.once"));
  const h = await hubOn(home, { services: "ext-slow" });
  try {
    const [a, b] = await Promise.all([h.core.extensions.approve("services/ext-slow.mjs", sum), h.core.extensions.approve("services/ext-slow.mjs", sum)]);
    assert.deepEqual([a.item.status, b.item.status], ["approved", "approved"]);
    assert.equal(h.core.facts.get("ext-slow.starts"), 1, "start ran once");
    assert.equal(h.core.services.filter((s) => s.name === "ext-slow").length, 1);
    const [c, d] = await Promise.all([h.core.extensions.approve("primitives/ext-once.mjs", psum), h.core.extensions.approve("primitives/ext-once.mjs", psum)]);
    assert.deepEqual([c.item.status, d.item.status, c.item.error, d.item.error], ["approved", "approved", null, null], "no name-taken from a second load");
    const loads = journal(home).filter((e) => e.type === "extension-load");
    assert.equal(loads.filter((e) => e.path === "services/ext-slow.mjs").length, 1);
    assert.equal(loads.filter((e) => e.path === "primitives/ext-once.mjs").length, 1);
    assert.ok(!journal(home).some((e) => e.type === "extension-error"));
  } finally {
    await h.close();
    cleanup(home);
  }
});
