// Fixes from the 2026-11-04 review (security / correctness / platform lenses): what did not fit into the tests
// of individual modules. System doubles, no network, no running of foreign processes.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { DEFAULTS } from "../lib/config.mjs";
import { createPeer, defaultSys, isPrintArgv, requirementIdentity } from "../lib/peer.mjs";
import { actionLevel } from "../lib/core.mjs";
import { wallTimer } from "../lib/host.mjs";
import { FrameSplitter } from "../lib/output.mjs";
import { cleanup, startHub, tempHome, waitFor } from "./helpers.mjs";

const UID = 501;
const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const CC_REQ = DEFAULTS.requirements.claudeCode;
const APP_REQ = 'identifier "com.kensei.agenthub" and certificate leaf = H"aaaa"';
const CODE = (cdhash, extra = {}) => ({ flags: 0x22010301, cdhash, identity: "com.anthropic.claude-code", teamId: "Q6L2SF6YDW", ...extra });

// Double: the process table + the core's signature info (codeInfo) + codesign by pid/path.
function sysWith(procs, { verdicts = {}, files = {}, store = null } = {}) {
  const calls = [];
  return {
    calls,
    available: true,
    peerPid: () => null,
    peerUid: () => UID,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: 1, uid: UID, startSec: procs[pid].start ?? 1000, startUsec: 0, tty: procs[pid].tty ?? false } : null),
    procArgv: (pid) => procs[pid]?.argv ?? null,
    codeInfo: (pid) => procs[pid]?.code ?? null,
    codesignVerify: async (target, req) => {
      calls.push(String(target));
      const v = verdicts[String(target)];
      return typeof v === "function" ? v(req) : v ?? false;
    },
    fileId: (p) => files[p] ?? `${p}|id`,
    myUid: () => UID,
    readJson: (p) => {
      if (!store || !(p in store)) throw new Error("ENOENT");
      return JSON.parse(store[p]);
    },
    writeJson: (p, v) => {
      if (store) store[p] = JSON.stringify(v);
    },
  };
}

const cfg = (home = "/tmp/ah-home") => ({ ...structuredClone(DEFAULTS), paths: { home }, requirements: { app: APP_REQ, claudeCode: CC_REQ } });

test("signature: verdict by the running process's cdhash; a file rewritten in place (new cdhash) is checked again", async () => {
  const procs = { 10: { path: CLAUDE, code: CODE("a".repeat(40)) } };
  const sys = sysWith(procs, { verdicts: { 10: true, 11: { ok: false, definite: true } } });
  const peer = createPeer({ config: cfg(), sys });
  assert.equal((await peer.verifySigned(10, "claudeCode")).ok, true);
  assert.equal((await peer.verifySigned(10, "claudeCode")).ok, true);
  assert.deepEqual(sys.calls, ["10"], "the second time — from the cache by cdhash");
  // the same path, a different binary (ad hoc, its own cdhash) — the cache does not apply
  procs[11] = { path: CLAUDE, code: CODE("b".repeat(40), { flags: 0x22010303, teamId: null }) };
  const r = await peer.verifySigned(11, "claudeCode");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature");
  assert.deepEqual(sys.calls, ["10", "11"]);
});

test("signature: the version file was deleted by an update — accepted by a cdhash that already passed the requirement (also after a daemon restart)", async () => {
  const store = {};
  const cd = "c".repeat(40);
  const procs = { 10: { path: CLAUDE, code: CODE(cd) }, 20: { path: null, code: CODE(cd), start: 2000 } };
  const sys = sysWith(procs, { verdicts: { 10: true, 20: { ok: false, definite: true, missing: true } }, store });
  const peer = createPeer({ config: cfg(), sys });
  assert.equal((await peer.verifySigned(10, "claudeCode")).ok, true);
  const r = await peer.verifySigned(20, "claudeCode");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.by, "process", "the same cdhash is already in this daemon's cache (Claude Code has no bundle, cache by cdhash)");
  // a new daemon: the in-memory cache is empty, no version file — by the saved list of verified cdhashes
  const peer2 = createPeer({ config: cfg(), sys });
  const r2 = await peer2.verifySigned(20, "claudeCode");
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.by, "cdhash");
  // an unknown cdhash without a file — not accepted
  procs[30] = { path: null, code: CODE("d".repeat(40)) };
  sys.codesignVerify = async () => ({ ok: false, definite: true, missing: true });
  assert.equal((await peer2.verifySigned(30, "claudeCode")).reason, "no-path");
  // ad hoc with the same cdhash and "the same" Team ID in the kernel — no (CS_ADHOC)
  procs[31] = { path: null, code: CODE(cd, { flags: 0x22010303 }) };
  assert.equal((await peer2.verifySigned(31, "claudeCode")).ok, false);
});

test("signature: a cdhash verdict does not carry over to another process with the same cdhash (a bundle copy with a different Info.plist)", async () => {
  const cd = "f".repeat(40);
  const ADHOC_APP = { flags: 0x3, cdhash: cd, identity: "com.kensei.agenthub", teamId: null };
  const procs = { 10: { path: APP, code: ADHOC_APP }, 12: { path: "/tmp/copy/AgentHub.app/Contents/MacOS/AgentHub", code: ADHOC_APP, start: 2000 } };
  // codesign --verify --strict by pid also checks the bundle seal: it does not match for the copy
  const sys = sysWith(procs, { verdicts: { 10: true, 12: { ok: false, definite: true } } });
  const appReq = `identifier "com.kensei.agenthub" and cdhash H"${cd}"`;
  const peer = createPeer({ config: { ...cfg(), requirements: { app: appReq, claudeCode: CC_REQ } }, sys });
  assert.equal((await peer.verifySigned(10, "app")).ok, true);
  const r = await peer.verifySigned(12, "app");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature");
  assert.deepEqual(sys.calls, ["10", "12"]);
  // the same process — from the cache
  assert.equal((await peer.verifySigned(10, "app")).ok, true);
  assert.deepEqual(sys.calls, ["10", "12"]);
});

test("signature: a failure of the check itself (timeout, EAGAIN) is not cached", async () => {
  const procs = { 10: { path: CLAUDE, code: CODE("e".repeat(40)) } };
  let n = 0;
  const sys = sysWith(procs, { verdicts: { 10: () => (++n === 1 ? { ok: false, definite: false } : true) } });
  const peer = createPeer({ config: cfg(), sys });
  assert.equal((await peer.verifySigned(10, "claudeCode")).reason, "verify-error");
  assert.equal((await peer.verifySigned(10, "claudeCode")).ok, true, "a repeated check, not a cached refusal");
  // the path without the addon (by file) — the same
  const procs2 = { 10: { path: CLAUDE } };
  let m = 0;
  const sys2 = sysWith(procs2, { verdicts: { [CLAUDE]: () => (++m === 1 ? { ok: false, definite: false } : true) } });
  sys2.codeInfo = null;
  const peer2 = createPeer({ config: cfg(), sys: sys2 });
  assert.equal((await peer2.verifySigned(10, "claudeCode")).reason, "verify-error");
  assert.equal((await peer2.verifySigned(10, "claudeCode")).ok, true);
});

test("signature by file (without the addon): fileId includes ctime — an in-place write with the old mtime and size changes the key", () => {
  const dir = tempHome("ah-fid-");
  try {
    const f = join(dir, "bin");
    writeFileSync(f, "AAAA");
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    const st = statSync(f);
    const before = defaultSys().fileId(f);
    // the same length, a restored mtime (like `touch -m -r`)
    const wait = Date.now() + 20;
    while (Date.now() < wait);
    writeFileSync(f, "BBBB");
    utimesSync(f, 1_700_000_000, 1_700_000_000);
    assert.equal(statSync(f).mtimeMs, st.mtimeMs);
    assert.equal(statSync(f).size, st.size);
    assert.notEqual(defaultSys().fileId(f), before);
  } finally {
    cleanup(dir);
  }
});

test("app with --probe-action in argv is not app (peer:app-probe); the argv of a nightly claude -p is recognized", async () => {
  const procs = { 10: { path: APP, argv: [APP, "--probe-action", "session.respond"] }, 11: { path: APP, argv: [APP] } };
  const sys = sysWith(procs, { verdicts: { [APP]: true } });
  sys.codeInfo = null;
  const peer = createPeer({ config: cfg(), sys });
  const r = await peer.classifyPid(10);
  assert.equal(r.class, "cli");
  assert.equal(r.reason, "peer:app-probe");
  assert.equal((await peer.classifyPid(11)).class, "app");
  for (const a of [["claude", "-p", "x"], ["claude", "--print"], ["claude", "--output-format=json"], ["claude", "-cp", "x"], ["claude", "--input-format", "stream-json"]]) assert.equal(isPrintArgv(a), true, a.join(" "));
  for (const a of [["claude"], ["claude", "--resume", "id"], ["claude", "-c"], ["claude", "fix -p bug"]]) assert.equal(isPrintArgv(a), false, a.join(" "));
  assert.deepEqual(requirementIdentity(CC_REQ), { id: "com.anthropic.claude-code", team: "Q6L2SF6YDW" });
});

test("session registry: a live session's session_id does not move to another pid; after it dies — it moves", async () => {
  const procs = { 10: { path: CLAUDE, start: 100 }, 20: { path: CLAUDE, start: 200 } };
  const sys = sysWith(procs, { verdicts: { [CLAUDE]: true } });
  sys.codeInfo = null;
  const h = await startHub({ sys });
  try {
    const sid = "11111111-1111-4111-8111-111111111111";
    assert.equal((await h.core.sessions.register(sid, { pid: 10, source: "plugin:x" })).verified, true);
    const r = await h.core.sessions.register(sid, { pid: 20, source: "plugin:y" });
    assert.equal(r.verified, false);
    assert.equal(r.reason, "bound-elsewhere");
    assert.equal(h.core.sessions.get(sid).pid, 10);
    delete procs[10];
    assert.equal((await h.core.sessions.register(sid, { pid: 20, source: "plugin:y" })).verified, true);
    assert.equal(h.core.sessions.get(sid).pid, 20);
  } finally {
    await h.stop();
  }
});

test("session registry: a field passed by the plugin as null is cleared (the previous frame's status does not stick)", async () => {
  const procs = { 10: { path: CLAUDE } };
  const sys = sysWith(procs, { verdicts: { [CLAUDE]: true } });
  sys.codeInfo = null;
  const h = await startHub({ sys });
  try {
    const sid = "22222222-2222-4222-8222-222222222222";
    await h.core.sessions.register(sid, { pid: 10, source: "plugin:s", status: "waiting", waitingFor: "permission prompt", surfaceId: "S" });
    assert.equal(h.core.waitingCount(), 1);
    await h.core.sessions.register(sid, { pid: 10, source: "plugin:s", status: null, waitingFor: null, surfaceId: null });
    const s = h.core.sessions.get(sid);
    assert.equal(s.status, null);
    assert.equal(s.waitingFor, null);
    assert.equal(h.core.waitingCount(), 0);
    // the hook does not pass status — the previous value stays
    await h.core.sessions.register(sid, { pid: 10, source: "plugin:s", status: "busy" });
    await h.core.sessions.register(sid, { pid: 10, source: "hook", interactive: true });
    assert.equal(h.core.sessions.get(sid).status, "busy");
  } finally {
    await h.stop();
  }
});

const fakePlugin = (id, meta = {}) => ({
  id,
  source: "builtin",
  file: `/x/${id}.mjs`,
  interval: "30s",
  meta: { type: "standard", title: id, version: "1", effects: [], actions: [], secrets: [], net: [], schedule: null, ...meta },
  granted: { allowed: true, effects: [], actions: false },
});

test("a plugin failure does not clear its known events: no repeated push on recovery", async () => {
  const h = await startHub();
  try {
    const pl = fakePlugin("s");
    h.core.pluginAdded(pl);
    const ev = [];
    h.core.on("event", (e) => (e.type === "event.raised" || e.type === "event.cleared") && ev.push(`${e.type === "event.raised" ? "+" : "-"}${e.key}`));
    h.core.applyFrame("s", "S | status=wait\n---\nЖдёт | event=session-waiting:abc\n");
    h.core.pluginFailed("s", "timeout");
    h.core.applyFrame("s", "S | status=wait\n---\nЖдёт | event=session-waiting:abc\n");
    assert.deepEqual(ev, ["+s:session-waiting:abc", "+s:plugin-error", "-s:plugin-error"]);
  } finally {
    await h.stop();
  }
});

test("an action of a non-builtin plugin: non-official — no lower than confirm, with network — confirm-cost; the core writes the cost", async () => {
  const off = fakePlugin("o", { net: ["api.example.com — данные"] });
  off.source = "installed";
  assert.equal(actionLevel(off, { level: "immediate" }), "confirm-cost");
  assert.equal(actionLevel(off, { level: "confirm" }), "confirm-cost");
  const noNet = { ...off, meta: { ...off.meta, net: [] } };
  assert.equal(actionLevel(noNet, { level: "immediate" }), "confirm");
  assert.equal(actionLevel({ ...off, source: "builtin" }, { level: "immediate" }), "immediate");
  // 2026-11-09: official without network — as declared (immediate too), with network — no lower than confirm-cost
  assert.equal(actionLevel({ ...noNet, granted: { ...noNet.granted, official: true } }, { level: "immediate" }), "immediate");
  assert.equal(actionLevel({ ...off, granted: { ...off.granted, official: true } }, { level: "immediate" }), "confirm-cost");
  const h = await startHub();
  try {
    h.core.pluginMeta.set("o", off);
    const d = h.core.describeTarget({ kind: "action", level: "confirm-cost", offer: { pluginId: "o", action: { id: "run", command: "node x.mjs run", cost: "нет" } } });
    assert.match(d.cost, /^Команда может выходить в сеть: api\.example\.com/);
    assert.match(d.cost, /По словам плагина: нет$/);
  } finally {
    await h.stop();
  }
});

test("policy: actions for an installed plugin only with official from lock (signed index), not from metadata", async () => {
  const h = await startHub();
  try {
    const pl = { ...fakePlugin("off", { actions: [{ id: "a", level: "confirm", command: "x" }], extra: { official: "true" } }), source: "installed" };
    h.core.setPluginPolicy(async () => ({ allowed: true, effects: [] }));
    assert.equal((await h.core.policyFor(pl)).actions, false, "official in metadata does not grant actions");
    h.core.setPluginPolicy(async () => ({ allowed: true, effects: [], official: true }));
    const p = await h.core.policyFor(pl);
    assert.equal(p.actions, true);
    assert.equal(p.official, true);
    const local = { ...pl, source: "local" };
    assert.equal((await h.core.policyFor(local)).actions, false, "local — never");
  } finally {
    await h.stop();
  }
});

test("SSE: a subscriber that stopped reading is disconnected at the buffer limit (daemon memory does not grow)", async () => {
  const h = await startHub({ overrides: { sse: { maxBuffer: 64 * 1024, maxStallMs: 60_000, graceMs: 200 } } });
  try {
    let res;
    const r = request({ socketPath: h.sock, path: "/events", headers: { host: "hub" } }, (x) => {
      res = x;
      x.pause(); // stopped reading
    });
    r.end();
    await waitFor(() => res);
    const big = "x".repeat(16 * 1024);
    for (let i = 0; i < 400; i++) h.core.emit({ type: "test.big", data: big });
    await waitFor(() => h.core.journal.tail(50).some((e) => e.type === "sse-drop"), 5000);
    r.destroy();
  } finally {
    await h.stop();
  }
});

test("wall-clock schedule: system sleep does not shift a \"09:00\" run by the sleep duration", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-04T23:00:00Z") });
  try {
    let fired = 0;
    const h = wallTimer(Date.now() + 10 * 3_600_000, () => fired++);
    // the Mac slept for 7 h: the wall clock moved forward, the monotonic timers stood still
    mock.timers.setTime(Date.now() + 7 * 3_600_000);
    mock.timers.tick(3 * 3_600_000 + 60_000);
    assert.equal(fired, 1, "fired around 09:00 by the clock, not after 10 h of timer run time");
    h.cancel();
  } finally {
    mock.timers.reset();
  }
});

test("SwiftBar-style streamable \"~~~, then a frame\": the frame is delivered after silence, without the next ~~~", async () => {
  const frames = [];
  const s = new FrameSplitter((f) => frames.push(f), 1024 * 1024, { idleMs: 30 });
  s.push("~~~\nX | status=wait\n---\nждёт\n");
  assert.equal(frames.length, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(frames, ["X | status=wait\n---\nждёт"]);
  // the next ~~~ does not duplicate the same frame
  s.push("~~~\n");
  assert.equal(frames.length, 1);
  // the "frame, then ~~~" style — right on ~~~
  s.push("Y | status=ok\n~~~\n");
  assert.deepEqual(frames, ["X | status=wait\n---\nждёт", "Y | status=ok"]);
  s.end();
  assert.equal(frames.length, 2);
});

// clickup is an official registry plugin: the same check lives in agent-hub-plugins/plugins/clickup/test/.
test("agents: pid liveness without /bin/ps (kill(pid, 0) — works on Windows too)", async () => {
  const A = await import("../../plugins/agents/agents.mjs");
  for (const mod of [A]) {
    const alive = mod.pidsAlive([process.pid, 99_999_999, 0, -1]);
    assert.deepEqual([...alive], [process.pid]);
  }
  // Since agents 1.1.1 /bin/ps is only an additional procStart check (the pid is not taken by another process): without a start
  // time (ps failure, Windows) liveness is still by kill(pid, 0).
  assert.deepEqual([...A.pidsAlive([process.pid], new Map([[process.pid, "Thu Jan  1 00:00:00 2015"]]), { psStarts: () => new Map() })], [process.pid]);
  // On Windows /bin/ps is not called at all: "/bin/ps" there is a path from the root of the current directory's drive, any user can
  // put a file there (docs/windows.md, A1). This cannot be checked by behavior on a Mac (ps exists, and on Windows
  // without ps.exe it would also be empty) — hence a text check; remove it together with the A15 port.
  assert.match(readFileSync(new URL("../../plugins/agents/agents.mjs", import.meta.url), "utf8"), /if \(!pids\.length \|\| process\.platform === "win32"\) return out;/);
  // and the behavior: our own process start time ≈ now − uptime
  const started = A.psStartsUtc([process.pid]).get(process.pid);
  if (process.platform === "win32") assert.equal(started, undefined);
  else assert.ok(Math.abs(started - (Date.now() / 1000 - process.uptime())) <= 2, String(started));
});
