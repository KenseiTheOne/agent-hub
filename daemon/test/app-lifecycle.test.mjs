// Daemon and app lifecycle (2026-11-06): "If the hub is dead but the daemon is alive, the daemon restores the hub. Closing the hub
// closes the daemon too." POST /shutdown, app supervision (the app service, lib/app-supervisor.mjs), the plist template
// (KeepAlive.SuccessfulExit=false), the build path in the pin. The real app is never launched: only
// doubles (the test.launch command, the test.processes process table) in temporary directories.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_PATH } from "../lib/native.mjs";
import { DAEMON_DIR, REPO_DIR } from "../lib/config.mjs";
import { LABEL } from "../lib/launchd.mjs";
import { cdhashRequirement, requirementSha, writeAppRequirement } from "../lib/app-pin.mjs";
import { AppSupervisor } from "../lib/app-supervisor.mjs";
import { appBundleProblem, appControl, bundleOfExecutable, liveStateDir, parseProcessList } from "../lib/platform.mjs";
import { isTestHome } from "../lib/services/app.mjs";
import { stopHub } from "../lib/lifecycle.mjs";
import { hookStateFor } from "../lib/hook/cards.mjs";
import { readInstall, writeInstall } from "../lib/hub-update/trial.mjs";
import { cleanup, curl, FIXTURES, req, startHub, tempHome, waitFor, withRepoPlist } from "./helpers.mjs";
import { asApp, childEnv as hookEnv, fakeClaude, runHook, sysDouble, APP_REQ } from "./hook-helpers.mjs";

// Hub notification: the subtitle is the gist (label), the body is the detail; the full text is "subtitle: body"
const bannerText = (c) => (c.args[8] ? `${c.args[8]}: ${c.args[6]}` : c.args[6]);

before(() => {
  if (!existsSync(NATIVE_PATH)) execFileSync(join(REPO_DIR, "scripts", "build-native.sh"), { stdio: "ignore" });
});

const BIN = join(DAEMON_DIR, "bin");
const A = "a".repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- AppSupervisor: pure logic on a fake clock ----------

function fakeClock() {
  let t = 1_000_000;
  const timers = new Set();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const h = { at: t + ms, fn };
      timers.add(h);
      return h;
    },
    clearTimer(h) {
      timers.delete(h);
    },
    // advance time, running timers in order (including the ones they schedule)
    async advance(ms, sup) {
      const end = t + ms;
      for (;;) {
        const next = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        t = next.at;
        next.fn();
        if (sup?.checking) await sup.checking;
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

function supWorld({ options = {}, path = "/Apps/AgentHub.app", procs = [], conns = [], verify = true, login = true, expect = false } = {}) {
  const clock = fakeClock();
  const w = { clock, procs: [...procs], conns: [...conns], launches: [], journal: [], events: [], stopping: false, upOnLaunch: false, login, expect, streams: 0, exits: [] };
  w.sup = new AppSupervisor({
    adapter: {
      processes: async () => (w.procs === null ? null : [...w.procs]),
      launch: async (p) => {
        w.launches.push(p);
        if (w.upOnLaunch) w.procs.push(777);
        return { ok: true, code: 0 };
      },
      verify: async () => verify,
    },
    pinned: () => (path ? { path, requirement: "req" } : { why: "no-path" }),
    connections: () => w.conns,
    stopping: () => w.stopping,
    journal: (e) => w.journal.push(e),
    emit: (e) => w.events.push(e),
    options: { restartDelayMs: 2000, verifyMs: 15_000, ...options },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    launchAtLogin: () => w.login,
    streams: () => w.streams,
    expectApp: () => w.expect,
    exit: (reason) => w.exits.push(reason),
    launchAgent: () => w.agent,
  });
  w.agent = "ok";
  w.types = () => w.journal.map((e) => e.type);
  w.gate = () => w.journal.filter((e) => e.type === "app-login-gate").map((e) => e.decision);
  return w;
}

test("supervision: daemon start without the app → launch after a pause; the app is already there (started at its request) → nothing", async () => {
  const w = supWorld();
  w.sup.start();
  await w.clock.advance(1999, w.sup);
  assert.deepEqual(w.launches, [], "nothing before the pause");
  await w.clock.advance(1, w.sup);
  assert.deepEqual(w.launches, ["/Apps/AgentHub.app"]);
  assert.equal(w.journal.find((e) => e.type === "app-launch").reason, "start");

  const v = supWorld({ procs: [4242] });
  v.sup.start();
  await v.clock.advance(60_000, v.sup);
  assert.deepEqual(v.launches, []);
  assert.deepEqual(v.types(), [], "the app is already there: not even an entry is needed");
});

test("supervision: app lost (last connection, no process) → restart after a pause; process alive → nothing", async () => {
  const w = supWorld({ procs: [10], conns: [{ pid: 10 }] });
  w.sup.start();
  await w.clock.advance(5000, w.sup);
  assert.deepEqual(w.launches, []);
  // one of two connections closed: nothing
  w.sup.onPeer({ connected: false, pid: 10, alive: false, count: 1 });
  // the process is alive (re-pin, stream drop): nothing
  w.sup.onPeer({ connected: false, pid: 10, alive: true, count: 0 });
  await w.clock.advance(5000, w.sup);
  assert.deepEqual(w.launches, []);
  // crashed: no connections, no process
  w.conns = [];
  w.procs = [];
  w.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  assert.ok(w.types().includes("app-lost"));
  await w.clock.advance(1999, w.sup);
  assert.deepEqual(w.launches, []);
  await w.clock.advance(1, w.sup);
  assert.deepEqual(w.launches, ["/Apps/AgentHub.app"]);
  const l = w.journal.find((e) => e.type === "app-launch");
  assert.equal(l.reason, "lost");
  assert.equal(l.restarts, 1);
});

test("supervision: the app came back by itself within the delay window (connection or process) → no restart", async () => {
  for (const back of ["connected", "running"]) {
    const w = supWorld();
    w.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
    await w.clock.advance(800, w.sup);
    if (back === "connected") w.conns = [{ pid: 11 }];
    else w.procs = [11];
    await w.clock.advance(5000, w.sup);
    assert.deepEqual(w.launches, [], back);
    assert.equal(w.journal.find((e) => e.type === "app-launch-skipped")?.why, back);
  }
});

test("supervision: at most 3 restarts in 10 min → stop, an app-restart-stopped entry and a push event; the app opened the stream → supervision resumes with a clean window", async () => {
  const w = supWorld();
  // every launch "crashes": the check after verifyMs finds no app, which is a new crash
  w.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  await w.clock.advance(2000 + 3 * 15_000 + 1000, w.sup);
  assert.equal(w.launches.length, 3);
  assert.deepEqual(w.journal.filter((e) => e.type === "app-launch").map((e) => e.reason), ["lost", "verify", "verify"]);
  const stop = w.journal.find((e) => e.type === "app-restart-stopped");
  assert.ok(stop, "limit exhausted: an entry");
  assert.equal(stop.restarts, 3);
  assert.deepEqual(w.events.map((e) => e.type), ["app.restart-stopped"]);
  // after that: no launches and no repeat notifications
  w.sup.onPeer({ connected: false, pid: 12, alive: false, count: 0 });
  await w.clock.advance(60_000, w.sup);
  assert.equal(w.launches.length, 3);
  assert.equal(w.events.length, 1);
  // a one-off app-class connection (--probe-peer: request and exit) does not lift the stop: no resumed, no new push
  for (let i = 0; i < 5; i++) {
    w.sup.onPeer({ connected: true, pid: 50 + i, count: 1 });
    w.sup.onPeer({ connected: false, pid: 50 + i, alive: false, count: 0 });
    await w.clock.advance(3000, w.sup);
  }
  assert.ok(!w.types().includes("app-supervise-resumed"));
  assert.equal(w.events.length, 1, "no repeat notification");
  assert.equal(w.journal.filter((e) => e.type === "app-restart-stopped").length, 1, "and no repeat audit entry either");
  assert.equal(w.launches.length, 3);
  // a human opened the app themselves and it opened the event stream: supervision is back with a clean window
  w.sup.onPeer({ connected: true, stream: true, pid: 13, count: 1 });
  assert.ok(w.types().includes("app-supervise-resumed"));
  // crashed right away (the 10 min window has not passed): still a restart, not a stop
  w.sup.onPeer({ connected: false, pid: 13, alive: false, count: 0 });
  w.upOnLaunch = true;
  await w.clock.advance(3000, w.sup);
  assert.equal(w.launches.length, 4);
  assert.equal(w.events.length, 1);
});

test("supervision: the connection closed with the process alive, then the process vanished without reconnecting → that is a crash", async () => {
  const w = supWorld({ procs: [10], conns: [{ pid: 10 }] });
  w.sup.start();
  await w.clock.advance(5000, w.sup);
  // the stream dropped, the process is alive (waiting to reconnect)
  w.conns = [];
  w.sup.onPeer({ connected: false, pid: 10, alive: true, count: 0 });
  // the process disappeared before reconnecting
  await w.clock.advance(5000, w.sup);
  w.procs = [];
  await w.clock.advance(15_000, w.sup);
  assert.deepEqual(w.launches, ["/Apps/AgentHub.app"]);
  assert.ok(w.journal.some((e) => e.type === "app-lost" && e.later === true));
  assert.equal(w.journal.find((e) => e.type === "app-launch").reason, "lost-later");
  assert.equal(w.journal.find((e) => e.type === "app-launch").restarts, 1, "counts toward the limit");

  // after launch the process came up but never connected and died after the verify check: also noticed
  const v = supWorld();
  v.upOnLaunch = true;
  v.sup.start();
  await v.clock.advance(2000 + 15_000, v.sup);
  assert.equal(v.launches.length, 1);
  await v.clock.advance(20_000, v.sup);
  assert.equal(v.launches.length, 1, "the process exists: nothing");
  v.procs = [];
  await v.clock.advance(15_000, v.sup);
  assert.equal(v.launches.length, 2);
  // connected: no longer watching the process without a connection
  const c = supWorld({ procs: [10], conns: [{ pid: 10 }] });
  c.sup.onPeer({ connected: false, pid: 10, alive: true, count: 0 });
  await c.clock.advance(60_000, c.sup);
  assert.deepEqual(c.launches, []);
  assert.equal(c.clock.pending(), 0, "there is a connection: no pending checks");
});

test("supervision: a temporary skip (ps did not answer, signature mismatch, no bundle) is retried; if it never passes → stop with why", async () => {
  // the signature matched on the second attempt (the bundle was rebuilt and pinned)
  const verdicts = [false, true];
  const w = supWorld();
  w.sup.adapter.verify = async () => verdicts.shift();
  w.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  await w.clock.advance(2000, w.sup);
  assert.deepEqual(w.launches, []);
  assert.equal(w.journal.find((e) => e.type === "app-launch-skipped").why, "pin-mismatch");
  await w.clock.advance(15_000, w.sup);
  assert.deepEqual(w.launches, ["/Apps/AgentHub.app"], "retry after verifyMs");

  // ps failed to read once
  const u = supWorld();
  const ps = [null];
  u.sup.adapter.processes = async () => (ps.length ? ps.shift() : []);
  u.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  await u.clock.advance(2000, u.sup);
  assert.equal(u.journal.find((e) => e.type === "app-launch-skipped").why, "unknown");
  await u.clock.advance(15_000, u.sup);
  assert.equal(u.launches.length, 1);

  // no bundle (a rebuild deleted it): retry; the bundle is back: launch
  let pin = { why: "path-missing" };
  const m = supWorld();
  m.sup.pinned = () => pin;
  m.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  await m.clock.advance(2000, m.sup);
  assert.equal(m.journal.find((e) => e.type === "app-launch-skipped").why, "path-missing");
  pin = { path: "/Apps/AgentHub.app", requirement: "req" };
  await m.clock.advance(15_000, m.sup);
  assert.equal(m.launches.length, 1);

  // never passes: three retries and a stop: one entry, one event with why
  const n = supWorld({ verify: false });
  n.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  await n.clock.advance(2000 + 5 * 15_000, n.sup);
  assert.deepEqual(n.launches, []);
  const stop = n.journal.filter((e) => e.type === "app-restart-stopped");
  assert.equal(stop.length, 1);
  assert.equal(stop[0].why, "pin-mismatch");
  assert.deepEqual(n.events, [{ type: "app.restart-stopped", restarts: 0, windowMs: 600_000, why: "pin-mismatch" }]);
  assert.equal(n.sup.info().why, "pin-mismatch");
  assert.equal(n.clock.pending(), 0);
});

test("supervision: the signature could not be verified (codesign did not answer: null) → no launch, why=verify-error", async () => {
  const w = supWorld({ verify: null });
  w.sup.start();
  await w.clock.advance(5000, w.sup);
  assert.deepEqual(w.launches, []);
  assert.equal(w.journal.find((e) => e.type === "app-launch-skipped").why, "verify-error");
  assert.ok(!w.journal.some((e) => e.type === "app-launch"));
});

test("supervision: supervise:false → nothing; daemon stopping (POST /shutdown) → nothing; a different bundle at the path → no launch", async () => {
  const off = supWorld({ options: { supervise: false } });
  off.sup.start();
  off.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  await off.clock.advance(60_000, off.sup);
  assert.deepEqual(off.launches, []);
  assert.equal(off.clock.pending(), 0);

  const st = supWorld();
  st.stopping = true;
  st.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  st.sup.start();
  await st.clock.advance(60_000, st.sup);
  assert.deepEqual(st.launches, []);

  const mm = supWorld({ verify: false });
  mm.sup.start();
  await mm.clock.advance(5000, mm.sup);
  assert.deepEqual(mm.launches, []);
  assert.equal(mm.journal.find((e) => e.type === "app-launch-skipped").why, "pin-mismatch");

  const np = supWorld({ path: null });
  np.sup.start();
  await np.clock.advance(5000, np.sup);
  assert.deepEqual(np.launches, []);
  assert.equal(np.journal.find((e) => e.type === "app-launch-skipped").why, "no-path");
});

// ---------- "Launch at login" (decision 2026-11-07): the daemon + app pair ----------

test("login with \"Launch at login\" off: the app is not launched, the daemon waits loginGraceMs from start for it and exits (login-off)", async () => {
  const w = supWorld({ login: false });
  w.sup.start();
  await w.clock.advance(2000, w.sup);
  assert.deepEqual(w.launches, []);
  assert.deepEqual(w.gate(), ["wait"]);
  assert.equal(w.journal.find((e) => e.type === "app-login-gate").ms, 28_000, "wait up to 30 s from start, not from the first check");
  await w.clock.advance(27_999, w.sup);
  assert.deepEqual(w.exits, [], "no exit before the deadline");
  await w.clock.advance(1, w.sup);
  assert.deepEqual(w.exits, ["login-off"]);
  assert.deepEqual(w.gate(), ["wait", "exit"]);
  assert.deepEqual(w.launches, [], "the app was never launched");
  // after deciding to exit, supervision does nothing more
  w.sup.onPeer({ connected: false, pid: 10, alive: false, count: 0 });
  await w.clock.advance(60_000, w.sup);
  assert.deepEqual(w.launches, []);
  assert.deepEqual(w.exits, ["login-off"]);
});

test("review: login with the setting off, ps did not answer (unknown): retry until the deadline rather than stay forever; no answer by the deadline: decide by connections", async () => {
  // ps is silent the whole time: retries after verifyMs, exit by 30 s (no connections or streams)
  const w = supWorld({ login: false });
  w.procs = null;
  w.sup.start();
  await w.clock.advance(2000, w.sup);
  assert.deepEqual(w.gate(), ["retry"]);
  await w.clock.advance(15_000, w.sup);
  assert.deepEqual(w.gate(), ["retry", "retry"]);
  assert.equal(w.journal.filter((e) => e.type === "app-login-gate").at(-1).ms, 13_000, "no later than loginGraceMs");
  await w.clock.advance(13_000, w.sup);
  assert.deepEqual(w.exits, ["login-off"]);
  assert.equal(w.clock.pending(), 0);
  assert.deepEqual(w.launches, []);
  // ps answered on the second try: no app means wait until the deadline and exit; an app means stay
  const v = supWorld({ login: false });
  v.procs = null;
  v.sup.start();
  await v.clock.advance(2000, v.sup);
  v.procs = [];
  await v.clock.advance(15_000, v.sup);
  assert.deepEqual(v.gate(), ["retry", "wait"]);
  assert.deepEqual(v.exits, []);
  await v.clock.advance(13_000, v.sup);
  assert.deepEqual(v.exits, ["login-off"]);
  const u = supWorld({ login: false });
  u.procs = null;
  u.sup.start();
  await u.clock.advance(2000, u.sup);
  u.procs = [4242];
  await u.clock.advance(15_000, u.sup);
  assert.deepEqual(u.gate(), ["retry", "stay"]);
  assert.deepEqual(u.exits, []);
  // ps is silent, but the app opened the event stream: stay
  const s = supWorld({ login: false });
  s.procs = null;
  s.streams = 1;
  s.sup.start();
  await s.clock.advance(2000, s.sup);
  assert.deepEqual(s.gate(), ["stay"]);
});

test("review: an old LaunchAgent (KeepAlive true): with the setting off the daemon does not exit (launchd would bring it back) but logs a warning", async () => {
  const w = supWorld({ login: false });
  w.agent = "outdated";
  w.sup.start();
  await w.clock.advance(30_000, w.sup);
  assert.deepEqual(w.exits, [], "exiting would become a start → 30 s → exit loop");
  assert.deepEqual(w.gate(), ["wait", "stay"]);
  assert.equal(w.journal.find((e) => e.type === "app-login-gate" && e.decision === "stay").why, "launch-agent-outdated");
  assert.match(w.journal.find((e) => e.type === "warning").detail, /agenthub install --apply/);
  assert.deepEqual(w.launches, []);
  // no plist (started by hand) or unreadable: exit as usual
  for (const agent of ["missing", "unknown", null]) {
    const v = supWorld({ login: false });
    v.agent = agent;
    v.sup.start();
    await v.clock.advance(30_000, v.sup);
    assert.deepEqual(v.exits, ["login-off"], String(agent));
  }
});

test("review: launchAgentState: KeepAlive {SuccessfulExit:false} is ok, true is outdated, no file is missing; /state.launchAtLogin.launchAgent in test mode follows test.launchAgent", async () => {
  const { launchAgentState, plistXml } = await import("../lib/launchd.mjs");
  const dir = tempHome("ah-la-");
  try {
    const good = join(dir, "good.plist");
    writeFileSync(good, plistXml({}));
    const old = join(dir, "old.plist");
    writeFileSync(old, plistXml({}).replace(/<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/, "<key>KeepAlive</key>\n  <true/>"));
    const crashed = join(dir, "crashed.plist");
    writeFileSync(crashed, plistXml({}).replace(/<key>SuccessfulExit<\/key>\s*<false\/>/, "<key>Crashed</key><true/>"));
    const none = join(dir, "none.plist");
    writeFileSync(none, plistXml({}).replace(/<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/, ""));
    const bin = join(dir, "bin.plist");
    writeFileSync(bin, "bplist00\u0000\u0001");
    assert.deepEqual([good, old, crashed, none, bin, join(dir, "nope.plist")].map(launchAgentState), ["ok", "outdated", "outdated", "ok", "unknown", "missing"]);
    const h = await startHub({ services: "app", configFile: { services: { app: { supervise: false, test: { launchAgent: old } } } } });
    try {
      assert.deepEqual((await req(h.sock, "GET", "/state")).body.launchAtLogin, { setting: true, launchAgent: "outdated" });
      writeFileSync(old, plistXml({}));
      assert.deepEqual((await req(h.sock, "GET", "/settings")).body.launchAtLogin, { setting: true, launchAgent: "ok" });
    } finally {
      await h.stop();
    }
  } finally {
    cleanup(dir);
  }
});

test("daemon started by the app (kickstart) with \"Launch at login\" off: a connection, a process at the pinned path or an event stream means stay; a crashed app is restarted", async () => {
  // the app connected before the first check
  const c = supWorld({ login: false, conns: [{ pid: 10 }] });
  c.sup.start();
  await c.clock.advance(120_000, c.sup);
  assert.deepEqual([c.exits, c.launches, c.gate()], [[], [], ["stay"]]);
  // the process exists but there is no connection yet (waiting for the socket): stay
  const r = supWorld({ login: false, procs: [10] });
  r.sup.start();
  await r.clock.advance(120_000, r.sup);
  assert.deepEqual([r.exits, r.launches], [[], []]);
  assert.equal(r.journal.find((e) => e.type === "app-login-gate").why, "running");
  // an unpinned copy (class cli) holds the event stream: stay too
  const s = supWorld({ login: false });
  s.streams = 1;
  s.sup.start();
  await s.clock.advance(120_000, s.sup);
  assert.deepEqual([s.exits, s.launches], [[], []]);
  assert.equal(s.journal.find((e) => e.type === "app-login-gate").why, "stream");
  // the app connected within the wait window (kickstart, the socket appeared after the first check)
  const l = supWorld({ login: false });
  l.sup.start();
  await l.clock.advance(10_000, l.sup);
  l.conns = [{ pid: 11 }];
  l.procs = [11];
  await l.clock.advance(60_000, l.sup);
  assert.deepEqual([l.exits, l.launches, l.gate()], [[], [], ["wait", "stay"]]);
  // recovery works with the setting off: crashed means restart
  l.conns = [];
  l.procs = [];
  l.upOnLaunch = true;
  l.sup.onPeer({ connected: false, pid: 11, alive: false, count: 0 });
  await l.clock.advance(2000, l.sup);
  assert.deepEqual(l.launches, ["/Apps/AgentHub.app"]);
  assert.equal(l.journal.find((e) => e.type === "app-launch").reason, "lost");
  assert.deepEqual(l.exits, []);
  // crashed within the wait window (before the decision): loss outweighs waiting, so restart rather than exit
  const e = supWorld({ login: false, conns: [{ pid: 12 }] });
  e.upOnLaunch = true;
  e.sup.start();
  e.sup.onPeer({ connected: false, pid: 12, alive: false, count: 0 });
  e.conns = [];
  await e.clock.advance(60_000, e.sup);
  assert.deepEqual(e.launches, ["/Apps/AgentHub.app"]);
  assert.deepEqual(e.exits, []);
});

test("\"Launch at login\": on → the app launches as before; off but the start is awaited by a hub update → also launches; turned on while waiting → launch; without supervision → exit only", async () => {
  const on = supWorld();
  on.upOnLaunch = true;
  on.sup.start();
  await on.clock.advance(60_000, on.sup);
  assert.deepEqual([on.launches, on.exits, on.gate()], [["/Apps/AgentHub.app"], [], []]);
  // a trial run of a new version / a return to the previous one: the app is needed regardless of the setting
  const up = supWorld({ login: false, expect: true });
  up.upOnLaunch = true;
  up.sup.start();
  await up.clock.advance(60_000, up.sup);
  assert.deepEqual([up.launches, up.exits], [["/Apps/AgentHub.app"], []]);
  assert.equal(up.journal.find((e) => e.type === "app-launch").reason, "start");
  // the human turned the setting on while the daemon was waiting
  const t = supWorld({ login: false });
  t.upOnLaunch = true;
  t.sup.start();
  await t.clock.advance(5000, t.sup);
  t.login = true;
  await t.clock.advance(60_000, t.sup);
  assert.deepEqual([t.launches, t.exits], [["/Apps/AgentHub.app"], []]);
  // supervise:false: never launch the app, but the disabled setting still applies: exit
  const ns = supWorld({ login: false, options: { supervise: false } });
  ns.sup.start();
  await ns.clock.advance(60_000, ns.sup);
  assert.deepEqual([ns.launches, ns.exits], [[], ["login-off"]]);
  const ns2 = supWorld({ login: false, options: { supervise: false }, procs: [10] });
  ns2.sup.start();
  await ns2.clock.advance(60_000, ns2.sup);
  assert.deepEqual([ns2.launches, ns2.exits], [[], []]);
  // on and without supervision: nothing is scheduled
  const ns3 = supWorld({ options: { supervise: false } });
  ns3.sup.start();
  assert.equal(ns3.clock.pending(), 0);
  // the daemon is stopping (POST /shutdown): no need to exit a second time
  const st = supWorld({ login: false });
  st.sup.start();
  st.stopping = true;
  await st.clock.advance(60_000, st.sup);
  assert.deepEqual(st.exits, []);
});

test("supervision: bringing the app back after a failed version switch (relaunch) bypasses \"Launch at login\" and does not count as a crash", async () => {
  const w = supWorld({ login: false });
  w.upOnLaunch = true;
  w.sup.schedule("relaunch", 2000);
  await w.clock.advance(2000, w.sup);
  assert.deepEqual(w.launches, ["/Apps/AgentHub.app"]);
  const l = w.journal.find((e) => e.type === "app-launch");
  assert.deepEqual([l.reason, l.restarts], ["relaunch", 0]);
  assert.deepEqual(w.exits, []);
});

// ---------- platform adapter ----------

test("adapter: in test mode the real app is never launched, only the double command; open only outside test mode", async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: "  42 /Apps/AgentHub.app/Contents/MacOS/AgentHub\n 43 /Apps/AgentHub.app/Contents/MacOS/sub/x\n 44 /Other.app/Contents/MacOS/AgentHub\n" };
  };
  const t = appControl({ platform: "darwin", testMode: true, runner });
  assert.deepEqual(await t.launch("/Apps/AgentHub.app"), { ok: false, skipped: "test-mode" });
  assert.equal(await t.verify("/Apps/AgentHub.app", "r"), true);
  assert.equal(calls.length, 0, "neither open nor codesign");
  const d = appControl({ platform: "darwin", testMode: true, test: { launch: ["/tmp/double", "x"] }, runner });
  await d.launch("/Apps/AgentHub.app");
  assert.deepEqual(calls.at(-1), ["/tmp/double", "x", "/Apps/AgentHub.app"]);
  assert.ok(!calls.some((c) => c[0] === "/usr/bin/open"));
  assert.deepEqual(await d.processes("/Apps/AgentHub.app"), [42], "only the executable directly in this bundle's Contents/MacOS");
  // outside test mode: open -g <path>, no shell; test.launch has no effect
  const live = appControl({ platform: "darwin", testMode: false, test: { launch: ["/tmp/double"] }, runner });
  await live.launch("/Apps/AgentHub.app");
  assert.deepEqual(calls.at(-1), ["/usr/bin/open", "-g", "/Apps/AgentHub.app"]);
  await live.verify("/Apps/AgentHub.app", 'identifier "x"');
  assert.deepEqual(calls.at(-1), ["/usr/bin/codesign", "--verify", "--strict", "-R", '=identifier "x"', "/Apps/AgentHub.app"]);
  // there is no Windows app: launching is not supported
  assert.equal(appControl({ platform: "win32", runner }).supported, false);
  assert.deepEqual(parseProcessList("  1 /a b/c\nмусор\n"), [{ pid: 1, path: "/a b/c" }]);
  assert.equal(bundleOfExecutable("/x/Agent Hub.app/Contents/MacOS/AgentHub", { platform: "darwin" }), "/x/Agent Hub.app");
  assert.equal(bundleOfExecutable("/usr/bin/curl", { platform: "darwin" }), null);
});

test("adapter: the app process is confirmed by the real executable path (proc_pidpath), not argv[0] from ps", async () => {
  // ps sees three "AgentHub" in the bundle: the real one (42), a spoofed argv[0] of another program (43), a vanished one (44)
  const runner = async () => ({ code: 0, stdout: " 42 /Apps/AgentHub.app/Contents/MacOS/AgentHub\n 43 /Apps/AgentHub.app/Contents/MacOS/AgentHub\n 44 /Apps/AgentHub.app/Contents/MacOS/AgentHub\n" });
  const exe = { 42: "/Apps/AgentHub.app/Contents/MacOS/AgentHub", 43: "/bin/sleep" };
  const live = appControl({ platform: "darwin", runner, pidPath: (pid) => exe[pid] ?? null });
  assert.deepEqual(await live.processes("/Apps/AgentHub.app"), [42]);
});

// A directory for a "good" bundle that does not depend on TMPDIR: with TMPDIR inside /tmp (TMPDIR=/tmp/x) everything
// tempHome creates lies under the world-writable /tmp, and any bundle there is legitimately path-unsafe. On macOS, the user's
// private temp directory (getconf DARWIN_USER_TEMP_DIR: /var/folders/…/T, 0700, ours only), otherwise
// tmpdir() if there are no world-writable directories above it, otherwise the tests directory.
function safeTempHome(prefix) {
  const bases = [];
  try {
    const d = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (d) bases.push(d);
  } catch {}
  bases.push(tmpdir(), join(DAEMON_DIR, "test"));
  for (const b of bases) {
    let real;
    try {
      real = realpathSync(b);
    } catch {
      continue;
    }
    let ok = true;
    for (let p = real; ; ) {
      const st = statSync(p);
      if ((st.uid !== process.getuid() && st.uid !== 0) || (st.mode & 0o022) !== 0) {
        ok = false;
        break;
      }
      const up = dirname(p);
      if (up === p) break;
      p = up;
    }
    if (ok) return realpathSync(mkdtempSync(join(real, prefix)));
  }
  throw new Error("no directory without world-writable ancestors: nowhere to check a \"good\" bundle");
}

test("bundle path: only ours and not writable by others; /tmp only in test mode; Windows is not supported", () => {
  const dir = safeTempHome("ah-abp-");
  try {
    const app = join(dir, "AgentHub.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    assert.equal(appBundleProblem(app, { platform: "darwin" }), null);
    assert.equal(appBundleProblem(join(dir, "Nope.app"), { platform: "darwin" }), "path-missing");
    assert.equal(appBundleProblem(join(dir, "AgentHub"), { platform: "darwin" }), "path-missing");
    assert.equal(appBundleProblem(app, { platform: "win32" }), "unsupported");
    // the directory above the bundle is world-writable: an outsider could replace the build
    const open = join(dir, "open");
    mkdirSync(join(open, "AgentHub.app"), { recursive: true });
    chmodSync(open, 0o777);
    assert.equal(appBundleProblem(join(open, "AgentHub.app"), { platform: "darwin" }), "path-unsafe");
    assert.equal(appBundleProblem(join(open, "AgentHub.app"), { platform: "darwin", testMode: true }), "path-unsafe", "without sticky, even in test mode");
    // /tmp (sticky, world-writable): the live hub refuses, test mode allows
    const tmp = join("/tmp", `ah-abp-${process.pid}`);
    mkdirSync(join(tmp, "AgentHub.app"), { recursive: true });
    try {
      assert.equal(appBundleProblem(join(tmp, "AgentHub.app"), { platform: "darwin" }), "path-unsafe");
      assert.equal(appBundleProblem(join(tmp, "AgentHub.app"), { platform: "darwin", testMode: true }), null);
    } finally {
      cleanup(tmp);
    }
    // realpath is checked: a symlink from a good place to a bundle in a world-writable directory does not help
    symlinkSync(join(open, "AgentHub.app"), join(dir, "Link.app"));
    assert.equal(appBundleProblem(join(dir, "Link.app"), { platform: "darwin" }), "path-unsafe");
  } finally {
    cleanup(dir);
  }
});

test("test copy: the default directory comes from the same environment (LOCALAPPDATA, XDG_STATE_HOME) without AGENTHUB_HOME", () => {
  const win = { LOCALAPPDATA: "D:\\Profiles\\u\\Local", AGENTHUB_HOME: "D:\\x" };
  const live = liveStateDir({ env: win, platform: "win32" });
  assert.ok(live.startsWith("D:\\Profiles\\u\\Local"), live);
  assert.equal(isTestHome(live, { env: win, platform: "win32" }), false, "a live daemon on Windows is not a test copy");
  const lin = { XDG_STATE_HOME: "/data/state" };
  assert.equal(isTestHome("/data/state/agenthub", { env: lin, platform: "linux" }), false);
  assert.equal(isTestHome("/tmp/ah-x", { env: lin, platform: "linux" }), true);
  assert.equal(isTestHome(liveStateDir({ env: {}, platform: "darwin" }), { env: { AGENTHUB_HOME: "/tmp/x" }, platform: "darwin" }), false);
});

// ---------- the app service in the daemon (system doubles) ----------

// World: a bundle double in a temporary directory, processes as pid → path; state.who is who is on the socket.
function appWorld(dir) {
  const app = join(dir, "AgentHub.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const exe = join(app, "Contents", "MacOS", "AgentHub");
  const procs = new Map([[20, { path: "/usr/bin/curl" }]]);
  const state = { who: 20 };
  const sys = {
    available: true,
    peerPid: () => state.who,
    peerUid: () => 501,
    pidPath: (pid) => procs.get(pid)?.path ?? null,
    pidInfo: (pid) => (procs.has(pid) ? { pid, ppid: 1, uid: 501, startSec: 1, startUsec: 0, tty: false } : null),
    procArgv: (pid) => procs.get(pid)?.argv ?? null,
    codeInfo: (pid) => (procs.get(pid)?.cdhash ? { flags: 0x3, cdhash: procs.get(pid).cdhash, identity: "com.kensei.agenthub", teamId: null } : null),
    codesignVerify: async (target, requirement) => {
      const p = procs.get(Number(target));
      return Boolean(p?.cdhash) && requirement === cdhashRequirement(p.cdhash);
    },
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
    writeJson: () => {},
  };
  const launchLog = join(dir, "launch.log");
  const procFile = join(dir, "procs.txt");
  writeFileSync(procFile, "");
  // launch double: writes the bundle path to the log; with UP=1 it also "launches" a process (a row in the process table).
  // It does not exit right away (like open): the app-launch journal entry appears only after it exits, so a test
  // that waits for the double's file rather than the journal entry fails on this.
  const double = join(dir, "launch-double.sh");
  writeFileSync(double, `#!/bin/sh\necho "$1" >> '${launchLog}'\nif [ -f '${dir}/UP' ]; then echo "4242 $1/Contents/MacOS/AgentHub" >> '${procFile}'; fi\nsleep 0.3\n`, { mode: 0o755 });
  return {
    app,
    exe,
    procs,
    state,
    sys,
    procFile,
    launches: () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split("\n").filter(Boolean) : []),
    up: (on = true) => (on ? writeFileSync(join(dir, "UP"), "") : cleanup(join(dir, "UP"))),
    // the app process: a pid with the executable in the bundle (in the sys double's table and in the "ps" file)
    spawnApp(pid, { argv = null, at = exe } = {}) {
      procs.set(pid, { path: at, cdhash: A, argv });
      appendFileSync(procFile, `${pid} ${at}\n`);
    },
    killApp(pid) {
      procs.delete(pid);
      writeFileSync(procFile, readFileSync(procFile, "utf8").split("\n").filter((l) => l && !l.startsWith(`${pid} `)).map((l) => l + "\n").join(""));
    },
    config: (extra = {}) => ({
      requirements: { app: cdhashRequirement(A) },
      appPin: { requirementSha: requirementSha(cdhashRequirement(A)), by: "agenthub pin-app", path: app },
      services: { app: { restartDelayMs: 150, verifyMs: 400, test: { launch: [double], processes: procFile }, ...extra } },
    }),
  };
}

// An SSE stream on behalf of the current state.who: an app-class connection until it is closed.
function openStream(sock) {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath: sock, path: "/events", agent: false }, (res) => {
      res.on("data", () => {});
      resolve({ close: () => r.destroy(), res });
    });
    r.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    r.end();
  });
}

const journalTypes = (h) => h.core.journal.tail(500).map((e) => e.type);

test("app service: app lost → restart via the double at the pinned build path; came back by itself → no restart", async () => {
  const dir = tempHome("ah-sup-");
  const w = appWorld(dir);
  w.spawnApp(10);
  const h = await startHub({ sys: w.sys, services: "app", configFile: w.config() });
  try {
    // the daemon started with the app alive: nothing
    await sleep(400);
    assert.deepEqual(w.launches(), []);
    w.state.who = 10;
    const s = await openStream(h.sock);
    await waitFor(() => h.core.appConnections().length === 1);
    assert.equal(h.core.appConnections()[0].pid, 10);
    // the app was killed: no process, the connection is gone
    w.killApp(10);
    s.close();
    await waitFor(() => journalTypes(h).includes("app-lost"));
    w.up();
    // wait for the journal entry, not the double's file: the entry appears only after the double exits
    await waitFor(() => journalTypes(h).includes("app-launch"), { timeoutMs: 3000 });
    assert.deepEqual(w.launches(), [w.app]);
    const launch = h.core.journal.tail(100).find((e) => e.type === "app-launch");
    assert.equal(launch.reason, "lost");
    assert.equal(launch.ok, true);
    // the check after launch: the process exists, nothing more
    await sleep(700);
    assert.equal(w.launches().length, 1);

    // app 11 connected and crashed, but came back by itself within the delay window (new process 12)
    cleanup(w.procFile);
    writeFileSync(w.procFile, "");
    w.spawnApp(11);
    w.state.who = 11;
    const s2 = await openStream(h.sock);
    await waitFor(() => h.core.appConnections().some((c) => c.pid === 11));
    w.killApp(11);
    s2.close();
    await waitFor(() => h.core.journal.tail(100).filter((e) => e.type === "app-lost").length === 2);
    w.spawnApp(12);
    w.state.who = 12;
    const s3 = await openStream(h.sock);
    await sleep(500);
    assert.equal(w.launches().length, 1, "came back by itself: no restart");
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "app-launch-skipped" && (e.why === "connected" || e.why === "running")));
    s3.close();
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("app service: daemon start without the app → launch; supervise:false → nothing", async () => {
  const dir = tempHome("ah-sus-");
  const w = appWorld(dir);
  w.up();
  const h = await startHub({ sys: w.sys, services: "app", configFile: w.config() });
  try {
    // the wait time is not what is tested (launch after restartDelayMs 150 ms): under load (parallel test
    // files, a swift build nearby) 3 s was not enough
    await waitFor(() => journalTypes(h).includes("app-launch"), { timeoutMs: 10_000 });
    assert.deepEqual(w.launches(), [w.app]);
    assert.equal(h.core.journal.tail(100).find((e) => e.type === "app-launch").reason, "start");
  } finally {
    await h.stop();
    cleanup(dir);
  }
  const dir2 = tempHome("ah-suo-");
  const w2 = appWorld(dir2);
  const h2 = await startHub({ sys: w2.sys, services: "app", configFile: w2.config({ supervise: false }) });
  try {
    await sleep(600);
    assert.deepEqual(w2.launches(), []);
    assert.ok(h2.core.journal.tail(100).some((e) => e.type === "app-supervise" && e.on === false));
  } finally {
    await h2.stop();
    cleanup(dir2);
  }
});

test("app service: test mode without a double leaves the real app alone: launch skipped, no external programs", async () => {
  const dir = tempHome("ah-sut-");
  const w = appWorld(dir);
  const cfg = w.config();
  delete cfg.services.app.test.launch;
  const h = await startHub({ sys: w.sys, services: "app", configFile: cfg });
  try {
    await waitFor(() => journalTypes(h).includes("app-launch-skipped"), { timeoutMs: 3000 });
    const skip = h.core.journal.tail(100).find((e) => e.type === "app-launch-skipped");
    assert.equal(skip.why, "test-mode");
    assert.equal(skip.path, w.app);
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "app-supervise" && e.testMode === true && e.launch === false));
    assert.equal(existsSync(join(h.home, "exec.log")), false, "neither open nor codesign");
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("app service: supervision ignores a diagnostic launch of the pinned build (--probe-peer, snapshots), so its exit is not a crash", async () => {
  const dir = tempHome("ah-sud-");
  const w = appWorld(dir);
  w.spawnApp(10);
  const h = await startHub({ sys: w.sys, services: "app", configFile: w.config() });
  try {
    await sleep(300);
    // the live app 10 is running but not connected; diagnostic process 30 of the same build
    w.spawnApp(30, { argv: [w.exe, "--snapshot-panel", "/tmp/x.png", "--quit-after-snapshot"] });
    w.state.who = 30;
    assert.equal((await req(h.sock, "GET", "/peer")).body.class, "app", "the class is the same: the pin check works");
    const s = await openStream(h.sock);
    await sleep(100);
    assert.equal(h.core.appConnections().length, 0, "supervision does not count the diagnostic launch connection");
    w.killApp(30);
    s.close();
    await sleep(500);
    assert.ok(!journalTypes(h).includes("app-lost"));
    assert.deepEqual(w.launches(), []);
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("app service: without appPin.path the app is not restarted, neither from the last connection's bundle nor otherwise; the journal has why=no-path (decision 2026-11-07)", async () => {
  const dir = tempHome("ah-sus2-");
  const w = appWorld(dir);
  const cfg = w.config();
  delete cfg.appPin.path;
  w.spawnApp(10);
  const h = await startHub({ sys: w.sys, services: "app", configFile: cfg });
  try {
    // the real app holds the event stream (previously its bundle became the fallback path)
    w.state.who = 10;
    const s = await openStream(h.sock);
    await waitFor(() => h.core.appConnections().some((c) => c.stream));
    await sleep(200);
    assert.ok(!journalTypes(h).includes("app-path-seen"), "there is no fallback path anymore");
    // crashed: no restart, an entry with the reason
    w.state.who = 20;
    w.up();
    w.killApp(10);
    s.close();
    await waitFor(() => journalTypes(h).includes("app-lost"));
    await waitFor(() => h.core.journal.tail(100).some((e) => e.type === "app-launch-skipped" && e.reason === "lost" && e.why === "no-path"), { timeoutMs: 3000 });
    await sleep(600);
    assert.deepEqual(w.launches(), [], "no launch without a pinned path");
    assert.ok(!journalTypes(h).includes("app-launch"));
    // /state shows the pin without a path; from it the app draws the "run agenthub pin-app" banner
    const st = h.core.snapshot({ class: "app" });
    assert.equal(st.appPin?.path ?? null, null);
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("pin: an appPin.path change with the same requirement: journal and audit, event, push; the path is in /state", async () => {
  const dir = tempHome("ah-spp-");
  const w = appWorld(dir);
  const cfg = w.config({ supervise: false });
  cfg.services.push = { ackTimeoutMs: 100 };
  const h = await startHub({ sys: w.sys, services: "push", configFile: cfg });
  try {
    await waitFor(() => h.core.appPin?.info().path === w.app);
    assert.equal(h.core.snapshot({ class: "app" }).appPin.path, w.app);
    const other = join(dir, "elsewhere", "AgentHub.app");
    mkdirSync(other, { recursive: true });
    const c = JSON.parse(readFileSync(h.config.paths.config, "utf8"));
    c.appPin.path = other;
    writeFileSync(h.config.paths.config, JSON.stringify(c), { mode: 0o600 });
    await waitFor(() => journalTypes(h).includes("app-pin-path-changed"), { timeoutMs: 8000 });
    const e = h.core.journal.tail(100).find((x) => x.type === "app-pin-path-changed");
    assert.equal(e.old, w.app);
    assert.equal(e.new, other);
    assert.ok(h.core.journal.auditTail(50).some((x) => x.type === "app-pin-path-changed"), "and in the audit journal");
    assert.ok(h.core.recent.some((x) => x.type === "app-pin.path-changed" && x.appPin?.path === other), "an SSE event with the new path");
    assert.equal(h.core.snapshot({ class: "app" }).appPin.path, other);
    const execLog = () => (existsSync(join(h.home, "exec.log")) ? readFileSync(join(h.home, "exec.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
    const osa = await waitFor(() => execLog().find((x) => x.file === "/usr/bin/osascript" && x.args.some((a) => /Демон теперь запускает/.test(a))));
    assert.ok(osa.args.some((a) => a.includes(other)));
    // the same path again: no new entry
    writeFileSync(h.config.paths.config, JSON.stringify(c) + "\n", { mode: 0o600 });
    h.core.appPin.check("test");
    assert.equal(h.core.journal.tail(100).filter((x) => x.type === "app-pin-path-changed").length, 1);
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("app service: the app crashes right after launch → 3 restarts, stop, a crash push, journal and audit", async () => {
  const dir = tempHome("ah-sul-");
  const w = appWorld(dir);
  w.spawnApp(10);
  const cfg = w.config({ restartDelayMs: 50, verifyMs: 150 });
  cfg.services.push = { ackTimeoutMs: 100 };
  const h = await startHub({ sys: w.sys, services: "app,push", configFile: cfg });
  try {
    w.state.who = 10;
    const s = await openStream(h.sock);
    await waitFor(() => h.core.appConnections().length === 1);
    w.killApp(10);
    s.close();
    await waitFor(() => journalTypes(h).includes("app-restart-stopped"), { timeoutMs: 5000 });
    assert.equal(w.launches().length, 3);
    const stop = h.core.journal.tail(200).find((e) => e.type === "app-restart-stopped");
    assert.equal(stop.restarts, 3);
    assert.ok(h.core.journal.auditTail(50).some((e) => e.type === "app-restart-stopped"), "and in the audit journal");
    const execLog = () => (existsSync(join(h.home, "exec.log")) ? readFileSync(join(h.home, "exec.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
    // the first banner is about the pin at start (the test directory sees requirements.app for the first time); the one we need follows
    const osa = await waitFor(() => execLog().find((c) => c.file === "/usr/bin/osascript" && /падает/.test(bannerText(c))));
    assert.match(bannerText(osa), /^Agent Hub падает — перезапуск остановлен: 3 перезапуска за 10 мин\./);
    assert.equal(h.core.recent.some((e) => e.type === "push.notify" && e.key === "@hub:app-restart-stopped"), false, "no app: the banner goes straight to osascript");
    await sleep(400);
    assert.equal(w.launches().length, 3, "no more launches after the stop");
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("app service in the daemon: \"Launch at login\" off, no app → app-login-gate exit and a normal stop (stop reason=login-off), the app was not launched", async () => {
  const dir = tempHome("ah-lgx-");
  const w = appWorld(dir);
  w.up();
  const h = await startHub({
    sys: w.sys,
    services: "app",
    configFile: (home) => {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ launchAtLogin: false }), { mode: 0o600 });
      return w.config({ loginGraceMs: 900 });
    },
  });
  let called = null;
  h.core.shutdownHandler = (reason) => {
    called = reason;
    return stopHub({ srv: h.srv, core: h.core, reason });
  };
  try {
    await waitFor(() => called === "login-off", { timeoutMs: 4000 });
    await waitFor(() => !existsSync(h.sock));
    const j = h.core.journal.tail(100);
    assert.deepEqual(j.filter((e) => e.type === "app-login-gate").map((e) => e.decision), ["wait", "exit"]);
    assert.ok(j.some((e) => e.type === "stop" && e.reason === "login-off"));
    assert.deepEqual(w.launches(), []);
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("app service in the daemon: \"Launch at login\" off, daemon started by the app: it stays; only app writes the setting (PUT /settings/launch-at-login), /settings and /state show it", async () => {
  const dir = tempHome("ah-lgs-");
  const w = appWorld(dir);
  w.spawnApp(10); // the app is running and connecting (kickstart → waiting for the socket)
  const h = await startHub({
    sys: w.sys,
    services: "app",
    configFile: (home) => {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ launchAtLogin: false }), { mode: 0o600 });
      return w.config({ loginGraceMs: 500 });
    },
  });
  let called = null;
  h.core.shutdownHandler = (reason) => {
    called = reason;
  };
  try {
    w.state.who = 10;
    const s = await openStream(h.sock);
    await sleep(900);
    assert.equal(called, null, "the app is here: the daemon does not exit");
    assert.deepEqual(w.launches(), []);
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "app-login-gate" && e.decision === "stay"));
    // read: /settings and /state (app and cli)
    assert.deepEqual((await req(h.sock, "GET", "/settings")).body.launchAtLogin, { setting: false });
    assert.deepEqual((await req(h.sock, "GET", "/state")).body.launchAtLogin, { setting: false });
    w.state.who = 20;
    assert.deepEqual((await curl(h.sock, "GET", "/settings")).body.launchAtLogin, { setting: false });
    // write: cli gets 403, app gets 200, settings.json, journal, event
    const denied = await curl(h.sock, "PUT", "/settings/launch-at-login", { enabled: true });
    assert.deepEqual([denied.status, denied.body.error], [403, "peer:cli"]);
    w.state.who = 10;
    assert.equal((await req(h.sock, "PUT", "/settings/launch-at-login", { enabled: "yes" })).status, 400);
    const ok = await req(h.sock, "PUT", "/settings/launch-at-login", { enabled: true });
    assert.deepEqual([ok.status, ok.body.launchAtLogin], [200, { setting: true }]);
    assert.equal(JSON.parse(readFileSync(join(h.home, "settings.json"), "utf8")).launchAtLogin, true);
    assert.ok(h.core.journal.tail(50).some((e) => e.type === "settings-changed" && e.key === "launchAtLogin" && e.value === true && e.peer === "app"));
    assert.ok(h.core.recent.some((e) => e.type === "settings.changed" && e.launchAtLogin === true));
    s.close();
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("app service in the daemon: \"Launch at login\" off but the daemon was started by a trial run of a new hub version: the app is launched (otherwise the update would roll back)", async () => {
  const dir = tempHome("ah-lgu-");
  const w = appWorld(dir);
  w.up();
  const h = await startHub({
    sys: w.sys,
    services: "app,hub-update",
    configFile: (home) => {
      writeFileSync(join(home, "settings.json"), JSON.stringify({ launchAtLogin: false }), { mode: 0o600 });
      const now = Date.now();
      writeInstall(home, { phase: "trial", op: "install", label: "0.2.0", from: "0.1.0", startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 3_600_000).toISOString() });
      const cfg = w.config({ loginGraceMs: 400 });
      cfg.services.hubUpdate = { test: { self: "0.2.0" }, updateCheck: { firstDelayMs: 3_600_000 } };
      return cfg;
    },
  });
  let called = null;
  h.core.shutdownHandler = (reason) => {
    called = reason;
  };
  try {
    assert.equal(h.core.facts.get("hub.update.startVerdict"), "confirm-wait");
    // the wait time is not what is tested (launch after restartDelayMs 150 ms): under load (parallel test
    // files, a swift build nearby) 3 s was not enough
    await waitFor(() => journalTypes(h).includes("app-launch"), { timeoutMs: 10_000 });
    assert.deepEqual(w.launches(), [w.app]);
    assert.equal(h.core.journal.tail(100).find((e) => e.type === "app-launch").reason, "start");
    await sleep(600);
    assert.equal(called, null);
    assert.ok(!journalTypes(h).includes("app-login-gate"));
    assert.equal(readInstall(h.home).phase, "trial");
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("agenthubd: \"Launch at login\" off, the app did not show up → exit with code 0 (launchd with SuccessfulExit=false will not restart it), stop reason=login-off", async () => {
  const dir = tempHome("ah-lgr-");
  const home = join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const w = appWorld(dir);
  w.up();
  const cfg = w.config({ restartDelayMs: 100, loginGraceMs: 700 });
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ launchAtLogin: false }), { mode: 0o600 });
  const env = hookEnv({ AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(dir, "none"), AGENTHUB_SERVICES: "app", AGENTHUB_TEST_EXEC_LOG: join(dir, "exec.log") });
  const d = spawn(process.execPath, [join(BIN, "agenthubd")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  d.stderr.on("data", (c) => (err += c));
  try {
    await waitFor(() => d.exitCode !== null, { timeoutMs: 8000 });
    assert.equal(d.exitCode, 0, err);
    assert.match(err, /"Launch at login" is off and the app did not show up: shutting down/);
    const j = readFileSync(join(home, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(j.some((e) => e.type === "app-login-gate" && e.decision === "exit"));
    assert.ok(j.some((e) => e.type === "stop" && e.reason === "login-off"));
    assert.deepEqual(w.launches(), []);
    assert.equal(existsSync(join(home, "hub.sock")), false);
  } finally {
    if (d.exitCode === null) d.kill("SIGKILL");
    cleanup(dir);
  }
});

// ---------- POST /shutdown ----------

test("POST /shutdown: from app → 202 and a normal stop (journal and audit); from cli → 403; closing connections during shutdown is not a crash", async () => {
  const dir = tempHome("ah-shd-");
  const w = appWorld(dir);
  w.spawnApp(10);
  const h = await startHub({ sys: w.sys, services: "app", configFile: w.config() });
  try {
    let called = null;
    h.core.shutdownHandler = (reason) => {
      called = reason;
      return stopHub({ srv: h.srv, core: h.core, reason });
    };
    w.state.who = 20;
    const cli = await req(h.sock, "POST", "/shutdown");
    assert.equal(cli.status, 403);
    assert.equal(cli.body.error, "peer:cli");
    assert.equal(called, null);
    w.state.who = 10;
    const s = await openStream(h.sock);
    await waitFor(() => h.core.appConnections().length === 1);
    // the real order: the app got 202 and quit before the daemon closed connections (the app service is still
    // running), which is not a crash
    let release;
    const gate = new Promise((r) => (release = r));
    h.core.shutdownHandler = async (reason) => {
      called = reason;
      await gate;
      return stopHub({ srv: h.srv, core: h.core, reason });
    };
    const r = await req(h.sock, "POST", "/shutdown");
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { ok: true, stopping: true });
    await waitFor(() => called === "shutdown");
    w.killApp(10);
    s.close();
    await waitFor(() => h.core.appConnections().length === 0);
    await sleep(500); // restartDelayMs 150: without the stopping() guard there would be app-lost and a launch here
    assert.deepEqual(w.launches(), []);
    assert.ok(!journalTypes(h).includes("app-lost"), "while the daemon is stopping, a vanished app is not a crash");
    release();
    await waitFor(() => !existsSync(h.sock));
    await sleep(300);
    assert.deepEqual(w.launches(), []);
    const j = h.core.journal.tail(100);
    assert.ok(j.some((e) => e.type === "shutdown-requested" && e.peer === "app" && e.pid === 10));
    assert.ok(j.some((e) => e.type === "stop" && e.reason === "shutdown"));
    assert.ok(!j.some((e) => e.type === "app-lost"));
    assert.ok(h.core.journal.auditTail(20).some((e) => e.type === "shutdown-requested"));
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("POST /shutdown: a pending PermissionRequest hook gets {} right away (Claude Code asks in the terminal), a new hook without the daemon also gets {}", async () => {
  const sys = sysDouble();
  asApp(sys);
  const h = await startHub({ sys, services: "hook", overrides: { requirements: { app: APP_REQ }, services: { hook: { sweepMs: 60_000 } } } });
  const SID = "44444444-4444-4444-8444-444444444444";
  const CPID = 990011;
  try {
    h.core.shutdownHandler = (reason) => stopHub({ srv: h.srv, core: h.core, reason });
    fakeClaude(h, sys, CPID, SID);
    await runHook({ home: h.home, body: { session_id: SID, hook_event_name: "SessionStart", source: "startup" }, claudePid: CPID, sys });
    const pending = runHook({ home: h.home, body: { session_id: SID, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }, claudePid: CPID, sys });
    await waitFor(() => hookStateFor(h.core.facts)?.cards.size === 1);
    const t0 = Date.now();
    assert.equal((await req(h.sock, "POST", "/shutdown")).status, 202);
    const r = await pending;
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, {});
    assert.ok(Date.now() - t0 < 3000, `the hook answered in ${Date.now() - t0} ms`);
    await waitFor(() => !existsSync(h.sock));
    const late = await runHook({ home: h.home, body: { session_id: SID, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }, claudePid: CPID, sys, env: { AGENTHUB_HOOK_DEBUG: "1" } });
    assert.deepEqual(late.json, {});
    assert.equal(late.code, 0);
    assert.match(late.err, /daemon is not running/);
    assert.ok(late.ms < 2000, `without the daemon, right away (${late.ms} ms)`);
  } finally {
    await h.stop();
  }
});

// ---------- real daemon, real codesign: /shutdown → code 0 ----------

function buildApp(dir) {
  const app = join(dir, "AgentHub.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const exe = join(app, "Contents", "MacOS", "AgentHub");
  execFileSync("/usr/bin/clang", ["-O1", "-o", exe, join(FIXTURES, "native", "client.c")]);
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.kensei.agenthub</string>
<key>CFBundleExecutable</key><string>AgentHub</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  execFileSync("/usr/bin/codesign", ["--force", "--options", "runtime", "-s", "-", "-i", "com.kensei.agenthub", app], { stdio: "ignore" });
  return { app, exe };
}

function runClient(exe, sock, method, path) {
  return new Promise((resolve, reject) => {
    execFile(exe, [sock, method, path, ""], { timeout: 10_000 }, (err, out) => {
      if (err) return reject(err);
      let body = null;
      try {
        body = JSON.parse(out.slice(out.indexOf("\r\n\r\n") + 4));
      } catch {}
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(out)?.[1]), body });
    });
  });
}

test("agenthubd: POST /shutdown from the pinned build → 202 and exit with code 0 (launchd will not restart it); curl → 403; pin-app writes the build path", async () => {
  const dir = tempHome("ah-shr-");
  const home = join(dir, "home");
  const plugins = join(dir, "plugins");
  mkdirSync(plugins);
  const { app, exe } = buildApp(dir);
  const env = hookEnv({ AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: plugins, AGENTHUB_SERVICES: "none", AGENTHUB_TEST_EXEC_LOG: join(dir, "exec.log") });
  const pin = spawnSync(process.execPath, [join(BIN, "agenthub"), "pin-app", app], { encoding: "utf8", env: { ...env, AGENTHUB_SYSTEM_LANG: "en" } });
  assert.equal(pin.status, 0, pin.stderr);
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(cfg.appPin.path, app, "the build path is for restarts by the daemon");
  // a pin from before 2026-11-06 (no path): re-running pin-app for the same build adds the path and leaves the requirement alone
  delete cfg.appPin.path;
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
  const again = spawnSync(process.execPath, [join(BIN, "agenthub"), "pin-app", app], { encoding: "utf8", env: { ...env, AGENTHUB_SYSTEM_LANG: "en" } });
  assert.match(again.stdout, /restart path written/);
  const cfg2 = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(cfg2.appPin.path, app);
  assert.equal(cfg2.requirements.app, cfg.requirements.app);
  assert.equal(cfg2.appPin.pinnedAt, cfg.appPin.pinnedAt);

  const d = spawn(process.execPath, [join(BIN, "agenthubd")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  d.stderr.on("data", (c) => (err += c));
  const sock = join(home, "hub.sock");
  try {
    await waitFor(() => existsSync(sock), { timeoutMs: 8000 });
    assert.equal((await runClient(exe, sock, "GET", "/peer")).body.class, "app");
    const c = await curl(sock, "POST", "/shutdown");
    assert.equal(c.status, 403);
    assert.equal(c.body.error, "peer:cli");
    assert.equal(d.exitCode, null, "the daemon is alive");
    const r = await runClient(exe, sock, "POST", "/shutdown");
    assert.equal(r.status, 202);
    await waitFor(() => d.exitCode !== null, { timeoutMs: 8000 });
    assert.equal(d.exitCode, 0, err);
    assert.equal(existsSync(sock), false);
    assert.match(err, /POST \/shutdown from the app: shutting down/);
    const audit = readFileSync(join(home, "journal-audit.jsonl"), "utf8");
    assert.match(audit, /"type":"shutdown-requested".*"peer":"app"/);
  } finally {
    if (d.exitCode === null) d.kill("SIGKILL");
    cleanup(dir);
  }
});

test("pin-app: the path is a realpath; a copy of the same build in another directory announces the path change; a bundle in a world-writable directory is refused", () => {
  const dir = tempHome("ah-ppc-");
  try {
    const home = join(dir, "home");
    const { app } = buildApp(dir);
    const env = hookEnv({ AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(dir, "none"), AGENTHUB_SERVICES: "none" });
    const run = (p) => spawnSync(process.execPath, [join(BIN, "agenthub"), "pin-app", p], { encoding: "utf8", env: { ...env, AGENTHUB_SYSTEM_LANG: "en" } });
    const cfg = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    // via a symlink: the real path is written
    symlinkSync(app, join(dir, "Link.app"));
    const first = run(join(dir, "Link.app"));
    assert.equal(first.status, 0, first.stderr);
    assert.equal(cfg().appPin.path, app);
    // a copy of the same build (same cdhash) in another directory: the path changes, and this is reported
    const other = join(dir, "elsewhere");
    mkdirSync(other);
    execFileSync("/bin/cp", ["-R", app, other]);
    const moved = run(join(other, "AgentHub.app"));
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /path:\s+was .*AgentHub\.app, will be .*elsewhere\/AgentHub\.app/);
    assert.match(moved.stdout, /app-pin-path-changed/);
    assert.equal(cfg().appPin.path, join(other, "AgentHub.app"));
    // the directory above the bundle is world-writable: do not pin
    const open = join(dir, "open");
    mkdirSync(open);
    execFileSync("/bin/cp", ["-R", app, open]);
    chmodSync(open, 0o777);
    const bad = run(join(open, "AgentHub.app"));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /path-unsafe/);
    assert.equal(cfg().appPin.path, join(other, "AgentHub.app"), "the path is untouched");
  } finally {
    cleanup(dir);
  }
});

// ---------- plist template ----------

test("agenthub install --apply in /tmp: KeepAlive = {SuccessfulExit: false}: a crash restarts, a normal exit does not", async () => {
  const fakeHome = tempHome("ah-plk-");
  const repoPlist = join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`);
  try {
    await withRepoPlist(repoPlist, async () => {
      const launchctl = join(fakeHome, "launchctl");
      writeFileSync(launchctl, `#!/bin/sh\necho "$*" >> '${join(fakeHome, "launchctl.log")}'\nexit 0\n`, { mode: 0o755 });
      const env = { ...process.env, HOME: fakeHome, AGENTHUB_TEST_LAUNCHCTL: launchctl, AGENTHUB_INSTALL_WAIT_MS: "300", AGENTHUB_SERVICES: "none" };
      delete env.NODE_OPTIONS;
      delete env.AGENTHUB_HOME;
      spawnSync(process.execPath, [join(BIN, "agenthub"), "install", "--apply"], { env, encoding: "utf8" });
      const target = join(fakeHome, "Library", "LaunchAgents", `${LABEL}.plist`);
      assert.ok(existsSync(target), "the plist is installed into the temporary HOME");
      execFileSync("/usr/bin/plutil", ["-lint", target], { stdio: "ignore" });
      const ka = JSON.parse(execFileSync("/usr/bin/plutil", ["-extract", "KeepAlive", "json", "-o", "-", target], { encoding: "utf8" }));
      assert.deepEqual(ka, { SuccessfulExit: false });
      const ral = execFileSync("/usr/bin/plutil", ["-extract", "RunAtLoad", "raw", "-o", "-", target], { encoding: "utf8" }).trim();
      assert.equal(ral, "true");
      assert.equal(readFileSync(repoPlist, "utf8"), readFileSync(target, "utf8"), "the template in the repo is the same");
    });
  } finally {
    cleanup(fakeHome);
  }
});

test("pin-app: writeAppRequirement puts the path into appPin together with the requirement", () => {
  const dir = tempHome("ah-pp-");
  try {
    const p = join(dir, "config.json");
    writeAppRequirement(p, cdhashRequirement(A), { by: "agenthub pin-app", path: "/Apps/AgentHub.app" });
    const c = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(c.appPin.path, "/Apps/AgentHub.app");
    assert.equal(c.appPin.requirementSha, requirementSha(cdhashRequirement(A)));
  } finally {
    cleanup(dir);
  }
});
