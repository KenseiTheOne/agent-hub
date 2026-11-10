// Fixes from the 2026-11-05 core review (after background plugin updates and the file-watching quota): what did not
// fit into the individual modules' tests. System doubles, no network, no foreign processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { DAEMON_DIR } from "../lib/config.mjs";
import { shownCommand } from "../lib/core.mjs";
import { Journal } from "../lib/journal.mjs";
import { actionArgv } from "../lib/runner.mjs";
import { BridgeChannel } from "../lib/services/actions.mjs";
import { builtinStatus, syncBuiltin } from "../lib/builtin-copy.mjs";
import { diffPermissions, indexPermissions, lintPlugin, permissionGrowth, permissionsFingerprint, permissionsFromMeta, sourceViolations } from "../lib/registry/perms.mjs";
import { PluginManager } from "../lib/plugins.mjs";
import { loadConfig } from "../lib/config.mjs";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const SID = "11111111-1111-4111-8111-111111111111";

// Double: a connection is the who process (app | cli); pid 40 is a signed Claude Code. codesignDelayMs — the delay
// of the signature check (classifying the peer as app).
function sysAs(state, { codesignDelayMs = 0 } = {}) {
  const procs = {
    10: { ppid: 1, path: APP },
    20: { ppid: 1, path: "/usr/bin/curl" },
    40: { ppid: 1, path: CLAUDE },
    41: { ppid: 1, path: CLAUDE }, // another live signed Claude Code
  };
  const pidOf = { app: 10, cli: 20 };
  return {
    available: true,
    peerPid: () => pidOf[state.who],
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: () => null,
    codesignVerify: async (path) => {
      if (codesignDelayMs) await new Promise((r) => setTimeout(r, codesignDelayMs));
      return path === APP || path === CLAUDE;
    },
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}
const overrides = { requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' } };

const journalOf = (h) => h.core.journal.tail(1000);

// ---------- finding 2: session= lines from untrusted plugins ----------
test("session= from a local plugin does not overwrite the session registry; from a built-in one it does (review: foreign session)", async () => {
  const plugins = tempHome("ah-rc-");
  writePlugin(plugins, "sess.1h.sh", `#!/bin/sh\necho "S | status=ok"\necho ---\necho "Сессия | session=${SID} pid=40 sessionStatus=waiting surfaceId=S1 sessionName=моя"\n`);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "app" }) });
  try {
    await waitFor(() => h.core.sessions.get(SID)?.status === "waiting");
    writePlugin(h.config.paths.pluginsLocal, "evil.1h.sh", `#!/bin/sh\necho "E | status=ok"\necho ---\necho "Чужая | session=${SID} pid=40 sessionStatus=idle surfaceId=S2 sessionName=другая"\n`);
    await h.core.host.rescan();
    const ev = await waitFor(() => h.core.pluginState("evil")?.body.find((b) => b.session)?.session.verified === true && h.core.pluginState("evil"));
    assert.equal(ev.body[0].session.id, SID);
    await new Promise((r) => setTimeout(r, 100));
    const s = h.core.sessions.get(SID);
    assert.equal(s.status, "waiting");
    assert.equal(s.surfaceId, "S1");
    assert.equal(s.name, "моя");
    assert.deepEqual(s.sources, ["plugin:sess"]);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("session= from a local plugin with a foreign id and another live Claude — verified:false, \"bound-elsewhere\" (regression review)", async () => {
  const plugins = tempHome("ah-rc2-");
  writePlugin(plugins, "sess.1h.sh", `#!/bin/sh\necho "S | status=ok"\necho ---\necho "Сессия | session=${SID} pid=40 sessionStatus=waiting"\n`);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "app" }) });
  try {
    await waitFor(() => h.core.sessions.get(SID)?.pid === 40);
    writePlugin(h.config.paths.pluginsLocal, "evil.1h.sh", `#!/bin/sh\necho "E | status=ok"\necho ---\necho "Чужая | session=${SID} pid=41"\necho "Своя | session=22222222-2222-4222-8222-222222222222 pid=41"\n`);
    await h.core.host.rescan();
    const ev = await waitFor(() => {
      const st = h.core.pluginState("evil");
      return st?.body.length === 2 && st.body.every((b) => b.session?.verified !== null && b.session?.verified !== undefined) && st;
    });
    assert.equal(ev.body[0].session.verified, false, "a foreign id behind live pid 40 — not verified");
    assert.ok(ev.body[0].session.label, "with a note");
    assert.equal(ev.body[1].session.verified, true, "own id on a signed pid — verified");
    assert.equal(h.core.sessions.get(SID).pid, 40, "registry untouched");
    assert.equal(journalOf(h).filter((e) => e.type === "session-rebind-denied").length, 0, "the note in the frame does not write to the journal");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- finding 3: hook while paused ----------
test("hub pause: SessionStart/SessionEnd/Stop reach the handlers, PermissionRequest does not; the response is always {} (review)", async () => {
  const h = await startHub({});
  try {
    const seen = [];
    h.core.onHook((body) => (seen.push(body.hook_event_name), { hookSpecificOutput: { decision: "allow" } }));
    writeFileSync(h.config.paths.estop, "x\n");
    for (const ev of ["SessionStart", "PermissionRequest", "Stop", "SessionEnd"]) {
      const a = await h.core.handleHook({ hook_event_name: ev, session_id: SID }, { class: "hook", claudePid: 40 });
      assert.deepEqual(a, {}, ev);
    }
    assert.deepEqual(seen, ["SessionStart", "Stop", "SessionEnd"]);
    const hookLog = journalOf(h).filter((e) => e.type === "hook");
    assert.equal(hookLog.find((e) => e.event === "PermissionRequest").handled, false);
    assert.equal(hookLog.find((e) => e.event === "SessionStart").handled, true);
    // not paused — the handler's response
    h.core.setEstop(false, { class: "app" });
    const a = await h.core.handleHook({ hook_event_name: "PermissionRequest", session_id: SID }, { class: "hook", claudePid: 40 });
    assert.deepEqual(a, { hookSpecificOutput: { decision: "allow" } });
  } finally {
    await h.stop();
  }
});

// ---------- finding 14: watch permissions ----------
test("watch permissions: path up to \" — \", like the core; the linter catches forbidden ones with an explanation; a changed explanation is not growth; old entries match (review)", () => {
  const meta = { title: "t", version: "1.0.0", author: { github: "x" }, platforms: ["macos"], effects: [], actions: [] };
  let lint = lintPlugin({ id: "x", meta: { ...meta, watch: ["~/.claude/./projects — следить"] } });
  assert.ok(lint.errors.some((e) => e.includes("~/.claude/projects")), lint.errors.join("; "));
  lint = lintPlugin({ id: "x", meta: { ...meta, watch: ["~/.claude/sessions — сессии"] } });
  assert.ok(lint.errors.some((e) => e.includes("~/.claude/sessions")), lint.errors.join("; "));
  lint = lintPlugin({ id: "x", meta: { ...meta, watch: ["~/.claude/task-runs/batch — замок"] } });
  assert.deepEqual(lint.errors, []);
  assert.deepEqual(sourceViolations('const p = "~/.claude/./projects"'), ["~/.claude/projects"]);
  assert.deepEqual(sourceViolations('const p = "~/.claude//projects"'), ["~/.claude/projects"]);
  const a = permissionsFromMeta({ watch: ["~/.claude/task-runs/batch — замок и сводки"] });
  const b = permissionsFromMeta({ watch: ["~/.claude/task-runs/batch — другое пояснение"] });
  assert.deepEqual(a.watch, [{ what: "~/.claude/task-runs/batch", why: "замок и сводки" }]);
  assert.deepEqual(diffPermissions(a, b), { added: [], removed: [] });
  // a lock/index entry in the old form (what — the whole string, why: null)
  const old = { watch: [{ what: "~/.claude/task-runs/batch — замок и сводки", why: null }] };
  assert.deepEqual(permissionGrowth(old, b), []);
  assert.equal(permissionsFingerprint(old), permissionsFingerprint(b));
  assert.equal(permissionGrowth(old, permissionsFromMeta({ watch: ["~/other — x"] })).length, 1);
  // the catalog entry stays in the old form (cores before 2026-11-05 compare archive permissions by the whole string), the new core parses it
  const idx = indexPermissions({ watch: ["~/.claude/task-runs/batch  —  замок и сводки"] });
  assert.deepEqual(idx.watch, [{ what: "~/.claude/task-runs/batch — замок и сводки", why: null }]);
  assert.equal(permissionsFingerprint(idx), permissionsFingerprint(b));
});

// ---------- findings 15 and 17: policy and id ----------
test("without the plugins service installed plugins are not admitted (policy:no-manager); ids with \"@\" and \":\" are not loaded (review)", async () => {
  const h = await startHub({});
  try {
    writePlugin(join(h.config.paths.plugins, "foo"), "foo.1h.sh", `#!/bin/sh\n# <agenthub.secrets>foo.token — токен</agenthub.secrets>\necho "F | status=ok"\n`);
    writePlugin(h.config.paths.pluginsLocal, "@hub.1h.sh", `#!/bin/sh\necho "ok | event=app-pin-changed"\n`);
    writePlugin(h.config.paths.pluginsLocal, "quota:week-80.1h.sh", `#!/bin/sh\necho "ok | event=20261116"\n`);
    writePlugin(h.config.paths.pluginsLocal, "Good_Local.v2.1h.sh", `#!/bin/sh\necho "ok | status=ok"\n`);
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("Good_Local.v2")?.lastRunAt);
    assert.equal(h.core.pluginState("foo"), null);
    assert.equal(h.core.pluginState("@hub"), null);
    assert.equal(h.core.pluginState("quota:week-80"), null);
    const warns = journalOf(h).filter((e) => e.type === "warning").map((e) => e.detail);
    assert.ok(warns.some((w) => w.includes("policy:no-manager")), warns.join("\n"));
    assert.ok(warns.some((w) => w.includes("@hub") && w.includes("недопустимый id")));
    assert.ok(warns.some((w) => w.includes("quota:week-80") && w.includes("недопустимый id")));
  } finally {
    await h.stop();
  }
});

// ---------- finding 16: bridge while paused ----------
test("bridge: an operation queued before the pause is not handed to the bridge; enabling the pause clears the queue (review)", async () => {
  let estop = false;
  const journal = [];
  const handlers = new Map();
  const ctx = {
    estop: () => estop,
    journal: { write: (e) => journal.push(e) },
    emit: () => {},
    on: (t, fn) => handlers.set(t, fn),
    off: () => {},
    config: {},
  };
  const peer = { pid: 7, startSec: 1 };
  const ch = new BridgeChannel(ctx, { pickupMs: 2000 });
  ch.hello(peer, { version: "1" });
  // in the queue, the bridge is not in a long poll
  const p1 = ch.call({ op: "send-key", surfaceId: "s" });
  estop = true;
  const got = await ch.next(peer, 0);
  assert.equal(got, null, "while paused the operation is not handed out");
  assert.deepEqual(await p1, { ok: false, error: "estop" });
  // while paused a new operation is refused immediately
  assert.deepEqual(await ch.call({ op: "surface.focus", surfaceId: "s" }), { ok: false, error: "estop" });
  // dropQueued (on the estop on event) clears what was not picked up
  estop = false;
  const p2 = ch.call({ op: "send-key", surfaceId: "s" });
  ch.dropQueued("estop");
  assert.deepEqual(await p2, { ok: false, error: "estop" });
  assert.equal(ch.queue.length, 0);
  ch.close();
});

// ---------- finding 18: install from the terminal ----------
test("manager: commit while paused — 423; CLI init (\"stale\") does not touch the daemon's fresh staging/trash (review)", async () => {
  const home = tempHome("ah-rcm-");
  try {
    const config = loadConfig({ env: { AGENTHUB_HOME: home, AGENTHUB_SERVICES: "none" } });
    let estop = false;
    const mgr = new PluginManager({ config, estop: () => estop });
    await mgr.init();
    const fresh = join(home, "Registry", "staging", "demo-abcd");
    mkdirSync(fresh, { recursive: true });
    const old = join(home, "Registry", "trash", "old-1");
    mkdirSync(old, { recursive: true });
    const past = new Date(Date.now() - 3600_000);
    utimesSync(old, past, past);
    await new PluginManager({ config }).init({ cleanTemp: "stale" });
    assert.ok(existsSync(fresh), "the daemon's fresh install is intact");
    assert.ok(!existsSync(old), "the old leftover is removed");
    estop = true;
    assert.throws(() => mgr.commit({ id: "x", entry: {}, files: [], perms: {}, archive: Buffer.alloc(0) }, { pid: 1 }), (e) => e.status === 423 && e.code === "estop");
  } finally {
    cleanup(home);
  }
});

// ---------- findings 19 and 27: journal ----------
test("journal: plugin warnings — no more than 20 per minute; pause audit in a separate file; tail reads .1 after rotation (review)", async () => {
  const h = await startHub({});
  try {
    h.core.setEstop(true, { class: "cli", pid: 1 });
    for (let i = 0; i < 200; i++) h.core.warn("flood", `неизвестный status «z${i}»`);
    let warns = journalOf(h).filter((e) => e.type === "warning" && e.plugin === "flood");
    assert.equal(warns.length, 20);
    // a minute has passed — one "suppressed: 180" record and we let them through again
    h.core.warnRate.get("flood").since -= 61_000;
    h.core.warn("flood", "ещё одно");
    warns = journalOf(h).filter((e) => e.type === "warning" && e.plugin === "flood");
    assert.equal(warns.at(-2).suppressed, 180);
    assert.equal(warns.at(-1).detail, "ещё одно");
    const audit = h.core.journal.auditTail(10);
    assert.ok(audit.some((e) => e.type === "estop-set" && e.on === true));
    assert.ok(!audit.some((e) => e.type === "warning"));
  } finally {
    await h.stop();
  }
  const dir = tempHome("ah-rcj-");
  try {
    const j = new Journal(join(dir, "journal.jsonl"), { maxBytes: 2000 });
    for (let i = 0; i < 40; i++) j.write({ type: "x", n: i });
    j.write({ type: "app-requirement-changed", from: "a", to: "b" });
    const tail = j.tail(30);
    assert.equal(tail.length, 30, "after rotation the missing ones come from journal.jsonl.1");
    assert.equal(tail.at(-1).type, "app-requirement-changed");
    assert.deepEqual(tail.slice(0, -1).map((e) => e.n), Array.from({ length: 29 }, (_, k) => 11 + k));
    assert.equal(j.auditTail(5).length, 1);
    assert.ok(existsSync(join(dir, "journal-audit.jsonl")));
  } finally {
    cleanup(dir);
  }
});

// ---------- finding 20: plugin restart by the host ----------
test("plugin restart (file mtime changed): raised events are neither cleared nor raised again (review)", async () => {
  const plugins = tempHome("ah-rce-");
  const file = writePlugin(plugins, "w.1h.sh", `#!/bin/sh\necho "W | status=wait"\necho ---\necho "Ждёт | event=waiting:abc"\n`);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("w")?.events.includes("waiting:abc"));
    const bus = [];
    h.core.on("event", (ev) => {
      if (ev.type === "event.raised" || ev.type === "event.cleared") bus.push(`${ev.type} ${ev.key}`);
    });
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("w")?.lastRunAt);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(bus, [], "neither a clear nor a re-raise");
    assert.deepEqual(h.core.pluginState("w").events, ["waiting:abc"]);
    // but a removed plugin clears its events
    cleanup(file);
    await h.core.host.rescan();
    assert.deepEqual(bus, ["event.cleared w:waiting:abc"]);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- findings 21, 25, 26: host ----------
test("a plugin killed by a signal is a failure (signal SIGSEGV), not a frame from partial output (review)", async () => {
  const plugins = tempHome("ah-rcs-");
  writePlugin(plugins, "seg.1h.sh", `#!/bin/sh\necho "Всё в порядке | status=ok"\nkill -SEGV $$\n`);
  const h = await startHub({ pluginsDir: plugins });
  try {
    const st = await waitFor(() => h.core.pluginState("seg")?.lastRunAt && h.core.pluginState("seg"));
    assert.equal(st.status, "error");
    assert.equal(st.error, "signal SIGSEGV");
    assert.ok(st.events.includes("plugin-error"));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("host: a stop while waiting for secrets — the process does not start; not-executable does not start on refresh (review)", async () => {
  const plugins = tempHome("ah-rch-");
  const marker = join(plugins, "ran.txt");
  writePlugin(plugins, "sec.1h.sh", `#!/bin/sh\n# <agenthub.secrets>sec.token — токен</agenthub.secrets>\necho run >> "${marker}"\necho "S | status=ok"\n`);
  writePlugin(plugins, "tool.1h.rb", `puts "x"\n`, 0o644);
  const h = await startHub({ pluginsDir: plugins, overrides: { plugins: { rescanIntervalMs: 0 } } });
  try {
    await waitFor(() => h.core.pluginState("tool")?.error === "not-executable");
    await waitFor(() => existsSync(marker));
    // secrets answer in 300 ms; refresh, then stop in the middle of waiting
    h.core.setSecretsProvider(() => new Promise((r) => setTimeout(() => r("v"), 300)));
    const inst = h.core.host.get("sec");
    const before = readFileSync(marker, "utf8").split("\n").filter(Boolean).length;
    inst.refresh("Manual");
    await new Promise((r) => setTimeout(r, 50));
    await inst.stop();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(readFileSync(marker, "utf8").split("\n").filter(Boolean).length, before, "the plugin did not start after stop");
    const ar = await inst.runAction({ id: "a", command: "sec.1h.sh --x" });
    assert.deepEqual(ar, { ok: false, error: "stopped" });
    // not-executable: refresh does not change the diagnosis and does not arm the timer
    const tool = h.core.host.get("tool");
    assert.equal(h.core.host.refresh("tool", "Manual"), true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.core.pluginState("tool").error, "not-executable");
    assert.equal(tool.timer, null);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- finding 23: SSE closed before subscribing ----------
test("SSE: the client closed the connection during classification — no subscriber is left behind (review)", async () => {
  const h = await startHub({ overrides, sys: sysAs({ who: "app" }, { codesignDelayMs: 300 }) });
  try {
    const before = h.core.bus.listenerCount("event");
    for (let i = 0; i < 5; i++) {
      const r = request({ socketPath: h.sock, path: "/events", agent: false });
      r.on("error", () => {});
      r.end();
      setTimeout(() => r.destroy(), 20);
    }
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(h.core.bus.listenerCount("event"), before);
  } finally {
    await h.stop();
  }
});

// ---------- finding 24: replay buffer ----------
test("Last-Event-ID buffer: a plugin event without a state snapshot; on replay — the current state (review)", async () => {
  const plugins = tempHome("ah-rcb-");
  writePlugin(plugins, "big.1h.sh", `#!/bin/sh\necho "B | status=ok"\n`);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("big")?.lastRunAt);
    const from = h.core.seq;
    h.core.applyFrame("big", `Кадр | status=wait\n---\n${"x".repeat(5000)}`);
    const rec = h.core.recent.at(-1);
    assert.equal(rec.type, "plugin");
    assert.equal(rec.plugin, undefined);
    assert.ok(JSON.stringify(rec).length < 1000);
    const replay = h.core.eventsSince(from);
    assert.equal(replay.at(-1).plugin.id, "big");
    assert.equal(replay.at(-1).plugin.status, "wait");
    assert.equal(replay.at(-1).pluginRef, undefined);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("Last-Event-ID buffer: on replay one plugin event per id — the latest, without N identical copies (regression review)", async () => {
  const plugins = tempHome("ah-rcb2-");
  writePlugin(plugins, "big.1h.sh", `#!/bin/sh\necho "B | status=ok"\n`);
  writePlugin(plugins, "small.1h.sh", `#!/bin/sh\necho "S | status=ok"\n`);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("big")?.lastRunAt && h.core.pluginState("small")?.lastRunAt);
    const from = h.core.seq;
    for (let i = 0; i < 50; i++) h.core.applyFrame("big", `Кадр ${i} | status=wait\n---\n${"x".repeat(20_000)}`);
    h.core.applyFrame("small", `S2 | status=error`);
    h.core.applyFrame("big", `Последний | status=block\n---\n${"y".repeat(20_000)}`);
    const replay = h.core.eventsSince(from);
    const big = replay.filter((e) => e.type === "plugin" && e.plugin.id === "big");
    assert.equal(big.length, 1);
    assert.equal(big[0].plugin.status, "block");
    assert.equal(replay.at(-1).id, h.core.seq, "the last replay id is the current one");
    assert.equal(replay.filter((e) => e.type === "plugin" && e.plugin.id === "small").length, 1);
    assert.ok(JSON.stringify(replay).length < 200_000, `replay: ${JSON.stringify(replay).length} bytes`);
    // events of other types from the tail are not lost and come in order
    const ids = replay.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- finding 28: confirmation text ----------
test("confirmation text is the same argv that will run: quotes around the {slot}, arguments with spaces (review)", () => {
  const arg = { name: "taskId", pattern: "^[A-Z]+-\\d+$" };
  assert.deepEqual(actionArgv('my-runner.30s.mjs --action skip "{taskId}"', arg, "ABC-1"), ["my-runner.30s.mjs", "--action", "skip", "ABC-1"]);
  assert.equal(shownCommand('my-runner.30s.mjs --action skip "{taskId}"', arg, "ABC-1"), "my-runner.30s.mjs --action skip ABC-1");
  assert.equal(shownCommand('x.sh "a b" --k', null, ""), "x.sh 'a b' --k");
  assert.equal(shownCommand("x.sh --action skip", arg, "T-1;echo"), "x.sh --action skip T-1;echo");
  assert.equal(shownCommand('x.sh "unclosed', null, ""), 'x.sh "unclosed');
});

// ---------- finding 29: built-in copy ----------
test("built-in copy: .DS_Store and .tmp-<pid> leftovers are not \"removed from the repository\"; update removes the leftovers (review)", () => {
  const src = tempHome("ah-rcbs-");
  const home = tempHome("ah-rcbh-");
  try {
    writePlugin(join(src, "q"), "q.5m.sh", "#!/bin/sh\necho q\n");
    syncBuiltin({ src, home });
    const dest = join(home, "Builtin");
    writeFileSync(join(dest, "q", ".DS_Store"), "x");
    writeFileSync(join(dest, "q", ".q.5m.sh.tmp-12345"), "half");
    const st = builtinStatus({ src, home });
    assert.deepEqual(st.removed, []);
    assert.deepEqual([...st.added, ...st.updated], []);
    syncBuiltin({ src, home });
    assert.ok(!existsSync(join(dest, "q", ".q.5m.sh.tmp-12345")));
    assert.ok(existsSync(join(dest, "q", ".DS_Store")), "foreign dot-files are left alone");
  } finally {
    cleanup(src);
    cleanup(home);
  }
});

// ---------- finding 30: agenthub lang without the daemon ----------
test("agenthub lang without the daemon — \"daemon unreachable\" and code 2, no stack trace (review)", async () => {
  const home = tempHome("ah-rcl-");
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTHUB_HOME: home, AGENTHUB_SERVICES: "none", AGENTHUB_SYSTEM_LANG: "en" };
    const r = await new Promise((resolve) =>
      execFile(process.execPath, [join(DAEMON_DIR, "bin", "agenthub"), "lang"], { env, timeout: 15_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr })),
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /daemon unreachable/);
    assert.doesNotMatch(r.stderr, /triggerUncaughtException|at /);
  } finally {
    cleanup(home);
  }
});
