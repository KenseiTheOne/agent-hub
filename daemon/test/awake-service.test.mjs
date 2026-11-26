// "Keep the Mac awake with the lid closed" in the daemon: /state.awake, the `awake` event, POST /awake, the battery
// guard with its fixed threshold and what a stop does to the flag. The system is a JSON double
// (AGENTHUB_TEST_AWAKE_FILE): no test runs sudo, pmset or ioreg.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopHub } from "../lib/lifecycle.mjs";
import { BATTERY_THRESHOLD } from "../lib/services/awake.mjs";
import { AUDIT_TYPES } from "../lib/journal.mjs";
import { cleanup, curl, ensureNative, onlyDarwin, req, startHub, tempHome, waitFor } from "./helpers.mjs";
import { APP_REQ, asApp, sysDouble } from "./hook-helpers.mjs";

before(() => {
  ensureNative();
});

const skip = onlyDarwin("the peer class comes from the peercred addon");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = 30;

// A hub whose awake service looks at a double. The test process is the app (req); curl is a real cli peer.
// double: null — a test directory without the double.
async function hub({ double = {}, services = "awake", settingsFile = null, cfg = {} } = {}) {
  const dir = tempHome("ah-awk-");
  const file = join(dir, "awake.json");
  if (double) writeFileSync(file, JSON.stringify({ flag: false, granted: true, lid: true, charge: 80, onBattery: false, ...double }));
  const sys = sysDouble();
  asApp(sys);
  const h = await startHub({
    sys,
    services,
    settingsFile,
    env: double ? { AGENTHUB_TEST_AWAKE_FILE: file } : {},
    overrides: { requirements: { app: APP_REQ }, services: { awake: { pollMs: POLL, idlePollMs: POLL, ...cfg } } },
  });
  h.read = () => JSON.parse(readFileSync(file, "utf8"));
  h.patch = (d) => writeFileSync(file, JSON.stringify({ ...h.read(), ...d }));
  h.awake = async () => (await req(h.sock, "GET", "/state")).body.awake;
  h.journal = (type) => h.core.journal.tail(500).filter((e) => e.type === type);
  h.events = (type) => h.core.recent.filter((e) => e.type === type);
  h.end = async () => {
    await h.stop();
    cleanup(dir);
  };
  return h;
}

test("awake: on and off from the app and from the command line — the flag, /state, the event and the journal", { skip }, async () => {
  const h = await hub();
  try {
    assert.deepEqual(await h.awake(), { supported: true, granted: true, on: false, onBattery: false, charge: 80, threshold: 10 });
    assert.deepEqual(h.events("awake"), [], "the first look is not a change");

    const on = await req(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([on.status, on.body], [200, { awake: { supported: true, granted: true, on: true, onBattery: false, charge: 80, threshold: 10 } }]);
    assert.equal(h.read().flag, true);
    assert.deepEqual(await h.awake(), on.body.awake);
    const ev = h.events("awake");
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].awake, on.body.awake);
    const j = h.journal("awake-set");
    assert.equal(j.length, 1);
    assert.deepEqual([j[0].on, j[0].peer, j[0].pid], [true, "app", process.pid]);
    assert.ok(h.core.journal.auditTail(20).some((e) => e.type === "awake-set"), "a switch is an audit record");

    // asking for what already is — no command, no journal line, no event
    assert.equal((await req(h.sock, "POST", "/awake", { on: true })).status, 200);
    assert.equal(h.journal("awake-set").length, 1);
    assert.equal(h.events("awake").length, 1);

    // the command line switches too
    const off = await curl(h.sock, "POST", "/awake", { on: false });
    assert.deepEqual([off.status, off.body.awake.on], [200, false]);
    assert.equal(h.read().flag, false);
    assert.deepEqual(h.journal("awake-set").map((e) => [e.on, e.peer]), [
      [true, "app"],
      [false, "cli"],
    ]);
    assert.equal(h.events("awake").length, 2);
    const again = await curl(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([again.status, again.body.awake.on], [200, true]);
    assert.deepEqual((await curl(h.sock, "GET", "/awake")).body.awake.on, true);

    // the body
    for (const bad of [{}, { on: "yes" }, { on: 1 }, { on: null }]) {
      const r = await req(h.sock, "POST", "/awake", bad);
      assert.deepEqual([r.status, r.body.error], [400, "args:on:type"], JSON.stringify(bad));
    }
    assert.equal((await req(h.sock, "POST", "/awake")).status, 400);
    assert.ok(AUDIT_TYPES.has("awake-set") && AUDIT_TYPES.has("awake-low-battery"));
  } finally {
    await h.end();
  }
});

test("awake: without the rule the switch is refused (409 awake:not-granted) — also for a flag someone set by hand; the rule appearing is noticed", { skip }, async () => {
  const h = await hub({ double: { granted: false }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    assert.deepEqual(await h.awake(), { supported: true, granted: false, on: false, onBattery: false, charge: 80, threshold: 10 });
    const r = await req(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([r.status, r.body.error, r.body.awake.granted, r.body.awake.on], [409, "awake:not-granted", false, false]);
    assert.equal(h.read().flag, false);
    assert.deepEqual(h.journal("awake-set"), []);

    // the flag was turned on in a terminal: shown as on, and the hub cannot turn it off
    h.patch({ flag: true });
    const st = await req(h.sock, "GET", "/awake");
    assert.deepEqual([st.status, st.body.awake.on, st.body.awake.granted], [200, true, false]);
    assert.equal(h.events("awake").at(-1).awake.on, true);
    const off = await curl(h.sock, "POST", "/awake", { on: false });
    assert.deepEqual([off.status, off.body.error, off.body.awake.on], [409, "awake:not-granted", true]);
    assert.equal(h.read().flag, true);

    // `agenthub awake grant` installed the rule and asked for a fresh look: the switch works at once
    h.patch({ granted: true });
    const n = h.events("awake").length;
    assert.equal((await curl(h.sock, "GET", "/awake")).body.awake.granted, true);
    assert.equal(h.events("awake").length, n + 1);
    assert.equal(h.events("awake").at(-1).awake.granted, true);
    assert.equal((await req(h.sock, "POST", "/awake", { on: false })).status, 200);
    assert.equal(h.read().flag, false);

    // the rule was removed behind the hub's back: the next switch finds out by itself
    h.patch({ granted: false });
    const gone = await req(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([gone.status, gone.body.error], [409, "awake:not-granted"]);
    assert.equal((await h.awake()).granted, false);
  } finally {
    await h.end();
  }
});

test("awake: a Mac without a lid — supported: false, 409 awake:unsupported; a test directory without the double runs nothing", { skip }, async () => {
  const desk = await hub({ double: { lid: false, flag: true, granted: true, charge: null, onBattery: null } });
  try {
    assert.deepEqual(await desk.awake(), { supported: false, granted: false, on: false, onBattery: null, charge: null, threshold: 10 });
    const r = await req(desk.sock, "POST", "/awake", { on: false });
    assert.deepEqual([r.status, r.body.error], [409, "awake:unsupported"]);
    assert.equal(desk.read().flag, true, "nothing was switched");
  } finally {
    await desk.end();
  }

  const bare = await hub({ double: null });
  try {
    assert.equal(bare.config.testAwakeFile, null);
    assert.deepEqual(await bare.awake(), { supported: false, granted: false, on: false, onBattery: null, charge: null, threshold: 10 });
    const r = await req(bare.sock, "POST", "/awake", { on: true });
    assert.deepEqual([r.status, r.body.error], [409, "awake:unsupported"]);
    const svc = bare.core.facts.get("awake.api");
    assert.equal(svc.ctl.mode, "off");
    assert.equal(svc.timer, null, "nothing to poll");
    assert.deepEqual(bare.journal("awake-set"), []);
  } finally {
    await bare.end();
  }
});

test("awake: the service is off — 503 awake:disabled, no /state.awake", { skip }, async () => {
  const h = await hub({ services: "none" });
  try {
    assert.equal((await req(h.sock, "GET", "/state")).body.awake, undefined);
    for (const [method, body] of [["GET"], ["POST", { on: true }]]) {
      const r = await req(h.sock, method, "/awake", body);
      assert.deepEqual([r.status, r.body.error], [503, "awake:disabled"]);
    }
    assert.equal(h.read().flag, false);
  } finally {
    await h.end();
  }
});

test("awake: on the battery below the threshold the hub returns sleep — journal, event, and it never turns the flag back on", { skip }, async () => {
  const h = await hub({ double: { onBattery: true, charge: 50 } });
  try {
    assert.equal((await req(h.sock, "POST", "/awake", { on: true })).status, 200);
    // above the threshold, and exactly at it, nothing happens
    await sleep(POLL * 5);
    h.patch({ charge: 10 });
    await waitFor(async () => (await h.awake()).charge === 10);
    await sleep(POLL * 5);
    assert.equal(h.read().flag, true);
    assert.deepEqual(h.journal("awake-low-battery"), []);

    h.patch({ charge: 9 });
    await waitFor(() => h.read().flag === false, { label: "the guard turned the flag off" });
    await waitFor(() => h.journal("awake-low-battery").length === 1);
    const j = h.journal("awake-low-battery")[0];
    assert.deepEqual([j.charge, j.threshold], [9, 10]);
    assert.ok(h.core.journal.auditTail(20).some((e) => e.type === "awake-low-battery"));
    const low = h.events("awake.low-battery");
    assert.equal(low.length, 1);
    assert.deepEqual([low[0].charge, low[0].threshold], [9, 10]);
    assert.deepEqual(await h.awake(), { supported: true, granted: true, on: false, onBattery: true, charge: 9, threshold: 10 });
    assert.equal(h.events("awake").at(-1).awake.on, false);
    // the switch by the guard is not a human's awake-set
    assert.deepEqual(h.journal("awake-set").map((e) => e.on), [true]);

    // charged again: the flag stays off
    h.patch({ charge: 90, onBattery: false });
    await waitFor(async () => (await h.awake()).charge === 90);
    await sleep(POLL * 5);
    assert.equal(h.read().flag, false);
    assert.equal(h.journal("awake-low-battery").length, 1);
    assert.equal(h.events("awake.low-battery").length, 1);
  } finally {
    await h.end();
  }
});

test("awake: on the charger the threshold does not act; unplugged below it — sleep returns at the next check", { skip }, async () => {
  const h = await hub({ double: { onBattery: false, charge: 5 } });
  try {
    assert.equal((await req(h.sock, "POST", "/awake", { on: true })).status, 200);
    await sleep(POLL * 6);
    assert.equal(h.read().flag, true);
    // an unknown source or charge is not "on the battery below the threshold" either
    h.patch({ onBattery: null });
    await waitFor(async () => (await h.awake()).onBattery === null);
    h.patch({ onBattery: true, charge: null });
    await waitFor(async () => (await h.awake()).onBattery === true);
    await sleep(POLL * 4);
    assert.equal(h.read().flag, true);
    assert.deepEqual(h.journal("awake-low-battery"), []);

    h.patch({ charge: 5 });
    await waitFor(() => h.read().flag === false, { label: "unplugged below the threshold" });
    await waitFor(() => h.journal("awake-low-battery").length === 1);
    assert.deepEqual([h.journal("awake-low-battery")[0].charge, h.journal("awake-low-battery")[0].threshold], [5, 10]);
  } finally {
    await h.end();
  }
});

test("awake: turned on while already below the threshold on the battery — sleep returns right away", { skip }, async () => {
  const h = await hub({ double: { onBattery: true, charge: 9 }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    const r = await req(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([r.status, r.body.awake.on], [200, false]);
    assert.equal(h.read().flag, false);
    assert.deepEqual(h.journal("awake-set").map((e) => e.on), [true]);
    assert.equal(h.journal("awake-low-battery").length, 1);
  } finally {
    await h.end();
  }
});

test("awake: the flag is already on when the daemon starts — it is shown and guarded from the first check", { skip }, async () => {
  // above the threshold: picked up as on, the guard keeps watching
  const h = await hub({ double: { flag: true, onBattery: true, charge: 60 } });
  try {
    assert.deepEqual(await h.awake(), { supported: true, granted: true, on: true, onBattery: true, charge: 60, threshold: 10 });
    assert.deepEqual(h.journal("awake-set"), [], "the daemon did not switch anything");
    h.patch({ charge: 8 });
    await waitFor(() => h.read().flag === false);
    await waitFor(() => h.journal("awake-low-battery").length === 1);
  } finally {
    await h.end();
  }

  // below the threshold already (the daemon was down while the battery drained): returned at start
  const low = await hub({ double: { flag: true, onBattery: true, charge: 7 }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    assert.equal(low.read().flag, false);
    assert.deepEqual(await low.awake(), { supported: true, granted: true, on: false, onBattery: true, charge: 7, threshold: 10 });
    assert.deepEqual([low.journal("awake-low-battery")[0].charge, low.journal("awake-low-battery")[0].threshold], [7, 10]);
    assert.equal(low.events("awake.low-battery").length, 1);
  } finally {
    await low.end();
  }

  // on, below the threshold, but no rule: the hub cannot return sleep — one journal line, not one per check
  const stuck = await hub({ double: { flag: true, granted: false, onBattery: true, charge: 7 } });
  try {
    await sleep(POLL * 6);
    assert.equal(stuck.read().flag, true);
    assert.deepEqual(await stuck.awake(), { supported: true, granted: false, on: true, onBattery: true, charge: 7, threshold: 10 });
    assert.deepEqual(stuck.journal("awake-low-battery"), []);
    const failed = stuck.journal("awake-failed");
    assert.equal(failed.length, 1);
    assert.deepEqual([failed[0].on, failed[0].reason, failed[0].granted], [false, "low-battery", false]);
  } finally {
    await stuck.end();
  }
});

test("awake: sudo refuses the switch — 409 awake:not-granted and granted: false at once, until the rule file changes", { skip }, async () => {
  // the probe says yes (a rule for another account, an unrelated password-free entry), the switch itself wants a password
  const h = await hub({ double: { refuse: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    assert.equal((await h.awake()).granted, true, "nothing says otherwise before the first switch");
    const r = await req(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([r.status, r.body.error, r.body.awake.granted, r.body.awake.on], [409, "awake:not-granted", false, false]);
    assert.equal(h.read().flag, false);
    assert.deepEqual(h.journal("awake-set"), []);
    const failed = h.journal("awake-failed");
    assert.deepEqual([failed.length, failed[0].on, failed[0].reason, failed[0].refused, failed[0].granted, failed[0].peer], [1, true, "set", true, false, "app"]);
    assert.equal(h.events("awake").at(-1).awake.granted, false, "the switch in the app follows");
    // a fresh look does not bring the rights back — the probe would say yes again — and no command is run for nothing
    assert.equal((await req(h.sock, "GET", "/awake")).body.awake.granted, false);
    const again = await req(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([again.status, again.body.error], [409, "awake:not-granted"]);
    assert.equal(h.journal("awake-failed").length, 1);
    // the rule is replaced (`agenthub awake grant`): asked again, and it works
    h.patch({ refuse: false });
    assert.equal((await req(h.sock, "GET", "/awake")).body.awake.granted, true);
    assert.equal((await req(h.sock, "POST", "/awake", { on: true })).status, 200);
    assert.equal(h.read().flag, true);
  } finally {
    await h.end();
  }
});

test("awake: what cannot be read is unknown, not \"off\" — a failed lid read is asked again soon and keeps the last answer; so does the flag", { skip }, async () => {
  // the lid cannot be read at start while the flag is on and the battery is low: the next look comes at the short
  // interval, not at the idle one, and the guard acts as soon as the lid answers
  const late = await hub({ double: { lid: null, flag: true, onBattery: true, charge: 5 }, cfg: { pollMs: POLL, idlePollMs: 600_000 } });
  try {
    assert.equal((await late.awake()).supported, false, "nothing is known yet");
    assert.equal(late.core.facts.get("awake.api").hasLid, null);
    await sleep(POLL * 4);
    assert.equal(late.read().flag, true);
    late.patch({ lid: true });
    await waitFor(() => late.read().flag === false, { timeoutMs: 5000, label: "asked again at the short interval" });
    await waitFor(() => late.journal("awake-low-battery").length === 1);
  } finally {
    await late.end();
  }

  const h = await hub({ double: { flag: true } });
  try {
    assert.deepEqual([(await h.awake()).supported, (await h.awake()).on], [true, true]);
    // ioreg fails later: the Mac still has its lid
    h.patch({ lid: null });
    await sleep(POLL * 5);
    assert.deepEqual([(await h.awake()).supported, (await h.awake()).on], [true, true]);
    // pmset -g fails: the flag is what it was
    h.patch({ lid: true, blind: true, flag: false });
    await sleep(POLL * 5);
    assert.equal((await h.awake()).on, true);
    h.patch({ blind: false });
    await waitFor(async () => (await h.awake()).on === false);
  } finally {
    await h.end();
  }
});

test("awake: the guard cannot see the power source or the charge while the flag is on — one journal warning per run of such reads, and the flag stays", { skip }, async () => {
  const blindLines = (h) => h.journal("warning").filter((e) => /low-battery guard is not watching/.test(e.detail));
  const h = await hub({ double: { flag: true, onBattery: true, charge: 50 } });
  try {
    await sleep(POLL * 4);
    assert.deepEqual(blindLines(h), []);
    h.patch({ onBattery: null });
    await waitFor(() => blindLines(h).length === 1, { label: "the fail-open is visible" });
    await sleep(POLL * 6);
    // on the battery with a charge that cannot be read — the same run
    h.patch({ onBattery: true, charge: null });
    await waitFor(async () => (await h.awake()).onBattery === true);
    await sleep(POLL * 6);
    assert.equal(blindLines(h).length, 1, "not one line per check");
    assert.equal(h.read().flag, true, "an unknown charge never trips the guard");
    // readable again, then lost again — a new run, a new line
    h.patch({ charge: 50 });
    await waitFor(async () => (await h.awake()).charge === 50);
    await sleep(POLL * 3);
    h.patch({ onBattery: null });
    await waitFor(() => blindLines(h).length === 2);
  } finally {
    await h.end();
  }

  // the flag is off: nothing to guard, nothing to say; on the charger the charge does not matter
  const idle = await hub({ double: { onBattery: null, charge: null } });
  try {
    await sleep(POLL * 5);
    idle.patch({ flag: true, onBattery: false });
    await waitFor(async () => (await idle.awake()).on === true);
    await sleep(POLL * 4);
    assert.deepEqual(blindLines(idle), []);
  } finally {
    await idle.end();
  }
});

test("awake: after the guard trips, success is the command plus a definite flag read — an unreadable flag is not a failure; a command that failed with the flag still on is", { skip }, async () => {
  const h = await hub({ double: { flag: true, onBattery: true, charge: 50 } });
  try {
    // the charge drops, and from this moment the flag cannot be read back
    h.patch({ blind: true, charge: 5 });
    await waitFor(() => h.read().flag === false, { label: "the guard switched the flag" });
    await waitFor(() => h.journal("awake-low-battery").length === 1, { label: "the journal line is not swallowed" });
    assert.equal(h.events("awake.low-battery").length, 1, "the notification goes out");
    assert.deepEqual(h.journal("awake-failed"), []);
    assert.equal((await h.awake()).on, false);
    await sleep(POLL * 5);
    assert.equal(h.journal("awake-low-battery").length, 1);
  } finally {
    await h.end();
  }

  // the command fails and the flag reads as still on: that is a failure — said once, and nothing is reported as done
  const bad = await hub({ double: { flag: true, onBattery: true, charge: 5, fail: true } });
  try {
    await sleep(POLL * 6);
    assert.equal(bad.read().flag, true);
    const failed = bad.journal("awake-failed");
    assert.deepEqual([failed.length, failed[0].on, failed[0].reason, failed[0].granted, failed[0].code], [1, false, "low-battery", true, 1]);
    assert.deepEqual(bad.journal("awake-low-battery"), []);
    assert.deepEqual(bad.events("awake.low-battery"), []);
    // the cause is gone: the next check returns sleep
    bad.patch({ fail: false });
    await waitFor(() => bad.read().flag === false);
    await waitFor(() => bad.journal("awake-low-battery").length === 1);
  } finally {
    await bad.end();
  }
});

test("awake: the command failed — 500 awake:failed, the switch stays where it was", { skip }, async () => {
  const h = await hub({ double: { fail: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    const r = await req(h.sock, "POST", "/awake", { on: true });
    assert.deepEqual([r.status, r.body.error, r.body.awake.on, r.body.awake.granted], [500, "awake:failed", false, true]);
    assert.equal(h.read().flag, false);
    assert.equal((await h.awake()).on, false);
    assert.deepEqual(h.journal("awake-set"), []);
    const failed = h.journal("awake-failed");
    assert.deepEqual([failed.length, failed[0].on, failed[0].reason, failed[0].peer, failed[0].refused], [1, true, "set", "app", undefined]);
    assert.deepEqual(h.events("awake"), []);
    assert.equal((await h.awake()).granted, true, "pmset failing is not a missing rule");
    // the cause is gone: the same request works
    h.patch({ fail: false });
    assert.equal((await req(h.sock, "POST", "/awake", { on: true })).status, 200);
    assert.equal(h.read().flag, true);
  } finally {
    await h.end();
  }
});

test("awake: a final exit returns sleep — the app quitting (POST /shutdown), also when a SIGTERM stop has already begun, and login-off; a restart for an update and a plain stop leave the flag alone", { skip }, async () => {
  // the human quits
  const quit = await hub({ double: { flag: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    quit.core.shutdownHandler = (reason) => stopHub({ srv: quit.srv, core: quit.core, reason });
    assert.equal((await curl(quit.sock, "POST", "/shutdown")).status, 403);
    assert.equal(quit.read().flag, true);
    assert.equal((await req(quit.sock, "POST", "/shutdown")).status, 202);
    await waitFor(() => quit.journal("stop").length === 1, { label: "the daemon stopped" });
    assert.equal(quit.read().flag, false, "sleep is back before the daemon is gone");
    const j = quit.journal("awake-set");
    assert.deepEqual([j.length, j[0].on, j[0].peer, j[0].reason, j[0].stop], [1, false, "hub", "quit", "shutdown"]);
    assert.equal(quit.journal("shutdown-requested").length, 1);
  } finally {
    await quit.end();
  }

  // launch at login is off and the app never showed up (the app service → ctx.lifecycle.stop("login-off")): nobody is
  // left to guard the battery here either
  const loginOff = await hub({ double: { flag: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    loginOff.core.shutdownHandler = (reason) => stopHub({ srv: loginOff.srv, core: loginOff.core, reason });
    loginOff.core.runShutdown("login-off");
    await waitFor(() => loginOff.journal("stop").length === 1, { label: "the daemon stopped" });
    assert.equal(loginOff.journal("stop")[0].reason, "login-off");
    assert.equal(loginOff.read().flag, false);
    assert.deepEqual(loginOff.journal("awake-set").map((e) => [e.on, e.peer, e.reason, e.stop]), [[false, "hub", "quit", "login-off"]]);
    assert.deepEqual(loginOff.journal("shutdown-requested"), [], "nobody asked: the daemon decided");
  } finally {
    await loginOff.end();
  }

  // a logout: launchd's SIGTERM reached the daemon first — the stop has begun (lib/lifecycle.mjs sets core.stopping) —
  // and the app's request is handled after that: sleep is still returned, and the request is journaled
  const late = await hub({ double: { flag: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    // bin/agenthubd: a stop is already running, a second reason starts nothing
    late.core.shutdownHandler = () => {};
    late.core.stopping = true;
    assert.equal((await req(late.sock, "POST", "/shutdown")).status, 202);
    await waitFor(() => late.journal("awake-set").length === 1, { label: "sleep returned during the stop" });
    assert.equal(late.read().flag, false);
    assert.deepEqual(late.journal("awake-set").map((e) => [e.on, e.reason, e.stop]), [[false, "quit", "shutdown"]]);
    assert.equal(late.journal("shutdown-requested").length, 1);
    // asked again — announced once
    assert.equal((await req(late.sock, "POST", "/shutdown")).status, 202);
    assert.equal(late.journal("shutdown-requested").length, 1);
    // nothing turns the flag back on behind a final exit
    const svc = late.core.facts.get("awake.api");
    const back = await svc.set(true, { class: "app", pid: process.pid });
    assert.equal(back.error, "awake:failed");
    assert.equal(late.read().flag, false);
    // the stop itself goes on to its end, and the services wait for the quit
    await stopHub({ srv: late.srv, core: late.core, reason: "SIGTERM" });
    assert.equal(late.journal("stop")[0].reason, "SIGTERM");
    assert.equal(late.read().flag, false);
  } finally {
    await late.end();
  }

  // the request first, SIGTERM right behind it: the stop waits for the quit — the journal has the switch before `stop`
  const both = await hub({ double: { flag: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    both.core.shutdownHandler = () => {};
    assert.equal((await req(both.sock, "POST", "/shutdown")).status, 202);
    await stopHub({ srv: both.srv, core: both.core, reason: "SIGTERM" });
    assert.equal(both.read().flag, false);
    const types = both.core.journal.tail(500).map((e) => e.type);
    assert.ok(types.indexOf("awake-set") >= 0 && types.indexOf("awake-set") < types.indexOf("stop"), types.join(" "));
  } finally {
    await both.end();
  }

  // quitting without the rule: nothing the hub can do — a journal line, no hang
  const noRule = await hub({ double: { flag: true, granted: false }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    noRule.core.shutdownHandler = (reason) => stopHub({ srv: noRule.srv, core: noRule.core, reason });
    assert.equal((await req(noRule.sock, "POST", "/shutdown")).status, 202);
    await waitFor(() => noRule.journal("stop").length === 1);
    assert.equal(noRule.read().flag, true);
    assert.deepEqual(noRule.journal("awake-failed").map((e) => [e.on, e.reason, e.stop, e.granted]), [[false, "quit", "shutdown", false]]);
  } finally {
    await noRule.end();
  }

  // a hub update: the app asks for /shutdown out of habit while the daemon restarts itself — the flag stays
  const update = await hub({ double: { flag: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    update.core.shutdownHandler = (reason) => stopHub({ srv: update.srv, core: update.core, reason });
    update.core.beginUpdate();
    assert.equal((await req(update.sock, "POST", "/shutdown")).status, 202);
    await sleep(200);
    assert.deepEqual(update.journal("stop"), [], "the update, not the request, stops the daemon");
    update.core.runShutdown("update");
    await waitFor(() => update.journal("stop").length === 1);
    assert.equal(update.journal("stop")[0].reason, "update");
    assert.equal(update.read().flag, true);
    assert.deepEqual(update.journal("awake-set"), []);
    assert.deepEqual(update.journal("shutdown-requested"), [], "a habit, not a request to quit");
  } finally {
    await update.end();
  }

  // SIGTERM (`agenthub restart`, launchd): the same stop without the request
  const term = await hub({ double: { flag: true }, cfg: { pollMs: 60_000, idlePollMs: 60_000 } });
  try {
    await stopHub({ srv: term.srv, core: term.core, reason: "SIGTERM" });
    assert.equal(term.read().flag, true);
    assert.deepEqual(term.journal("awake-set"), []);
  } finally {
    await term.end();
  }
});

test("awake: the threshold is one fixed value, 10 % — not a setting: no key in settings.json or GET /settings, no route, a leftover key is ignored", { skip }, async () => {
  assert.equal(BATTERY_THRESHOLD, 10);
  // a settings.json written by an earlier build still has the key; the charge is below that old number and above 10
  const h = await hub({ double: { flag: true, onBattery: true, charge: 30 }, settingsFile: { awakeBatteryThreshold: 40, launchAtLogin: true } });
  try {
    assert.deepEqual(await h.awake(), { supported: true, granted: true, on: true, onBattery: true, charge: 30, threshold: 10 });
    await sleep(POLL * 6);
    assert.equal(h.read().flag, true, "the old number does not act");
    assert.deepEqual(h.journal("awake-low-battery"), []);
    assert.deepEqual(h.journal("warning"), [], "ignored silently");
    for (const ask of [req, curl]) {
      const got = await ask(h.sock, "GET", "/settings");
      assert.equal(got.status, 200);
      assert.ok(!("awakeBatteryThreshold" in got.body), JSON.stringify(Object.keys(got.body)));
    }
    assert.equal(h.core.settings.get("awakeBatteryThreshold"), undefined, "plugins and services do not see it either");
    // the route is gone, for the app as for anyone
    for (const ask of [req, curl]) {
      const put = await ask(h.sock, "PUT", "/settings/awake-threshold", { percent: 30 });
      assert.deepEqual([put.status, put.body.error], [404, "not-found"]);
    }
    assert.ok(!h.core.journal.tail(100).some((e) => e.type === "settings-changed"));
    // an event shaped like the old "threshold changed" moves nothing
    h.core.emit({ type: "settings.changed", awakeBatteryThreshold: 40 });
    await sleep(POLL * 4);
    assert.equal(h.read().flag, true);
    assert.equal((await h.awake()).threshold, 10);
    assert.deepEqual(h.events("awake"), []);
    // …and the real threshold is where it was
    h.patch({ charge: 9 });
    await waitFor(() => h.read().flag === false);
    await waitFor(() => h.journal("awake-low-battery").length === 1);
    assert.deepEqual([h.journal("awake-low-battery")[0].charge, h.journal("awake-low-battery")[0].threshold], [9, 10]);
  } finally {
    await h.end();
  }
});
