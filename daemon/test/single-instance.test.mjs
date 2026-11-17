// One daemon per state directory (lib/instance.mjs): a second agenthubd on a home that has a live daemon exits before
// core.init() and touches nothing — the live daemon's jobs keep running and jobs.json keeps its content.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR } from "../lib/config.mjs";
import { acquireInstanceLock, claimHome, instanceLockPath, processStartKey } from "../lib/instance.mjs";
import { loadNative } from "../lib/native.mjs";
import { pidAlive } from "../lib/statefile.mjs";
import { cleanup, curl, tempHome, waitFor } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");

function envFor(home) {
  const e = { ...process.env, AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"), AGENTHUB_SERVICES: "none", AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log") };
  delete e.NODE_OPTIONS;
  return e;
}

function startDaemon(home) {
  const d = spawn(process.execPath, [join(BIN, "agenthubd")], { env: envFor(home), stdio: ["ignore", "ignore", "pipe"] });
  d.err = "";
  d.stderr.on("data", (c) => (d.err += c));
  return d;
}

const runDaemon = (home) =>
  new Promise((resolve) => {
    execFile(process.execPath, [join(BIN, "agenthubd")], { env: envFor(home), timeout: 20_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });

const journalTypes = (home) =>
  readFileSync(join(home, "journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).type);

test("a second agenthubd on a home with a live daemon exits 1 and leaves its jobs, jobs.json and journal alone", async () => {
  const home = tempHome("ah-one-");
  const first = startDaemon(home);
  // stands in for a background job of the live daemon: its own process group, recorded in jobs.json exactly as the daemon does
  const job = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const sock = join(home, "hub.sock");
    await waitFor(() => existsSync(sock), { timeoutMs: 10_000 });
    await waitFor(async () => (await curl(sock, "GET", "/health")).status === 200, { timeoutMs: 10_000 });
    const startSec = loadNative()?.pidInfo(job.pid)?.startSec ?? null;
    const jobs = JSON.stringify({ jobs: [{ job: "j1", plugin: "p", actionId: "a", pid: job.pid, pgid: job.pid, startSec }] }) + "\n";
    writeFileSync(join(home, "jobs.json"), jobs, { mode: 0o600 });
    const before = { journal: readFileSync(join(home, "journal.jsonl"), "utf8"), files: readdirSync(home).sort() };

    const second = await runDaemon(home);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /демон уже работает с этим каталогом \(pid \d+\)|a daemon is already running on this directory \(pid \d+\)/);
    assert.ok(second.stderr.includes(String(first.pid)), "names the live daemon's pid");
    assert.doesNotMatch(second.stderr, /\n\s+at /, "no stack");
    // give a wrongly sent SIGTERM time to land
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(readFileSync(join(home, "jobs.json"), "utf8"), jobs, "jobs.json is not rewritten");
    assert.ok(pidAlive(job.pid) && job.exitCode === null && job.signalCode === null, "the live daemon's job is not killed");
    assert.equal(readFileSync(join(home, "journal.jsonl"), "utf8"), before.journal, "the second daemon wrote nothing to the journal");
    assert.deepEqual(readdirSync(home).sort(), before.files, "no new files in the home");
    assert.equal(journalTypes(home).filter((t) => t === "start").length, 1);
    // the live daemon is still the one answering, and its lock is still its own
    assert.equal((await curl(sock, "GET", "/health")).status, 200);
    assert.equal(JSON.parse(readFileSync(instanceLockPath(home), "utf8")).pid, first.pid);

    first.kill("SIGTERM");
    await waitFor(() => first.exitCode !== null, { timeoutMs: 8000 });
    assert.equal(first.exitCode, 0, first.err);
    assert.ok(!existsSync(instanceLockPath(home)), "a regular exit releases the lock");
  } finally {
    first.kill("SIGKILL");
    try {
      process.kill(-job.pid, "SIGKILL");
    } catch {}
    cleanup(home);
  }
});

test("a daemon killed with SIGKILL leaves its lock behind; the next one takes the home over", async () => {
  const home = tempHome("ah-one-");
  const first = startDaemon(home);
  let second = null;
  try {
    const sock = join(home, "hub.sock");
    await waitFor(() => existsSync(sock), { timeoutMs: 10_000 });
    await waitFor(async () => (await curl(sock, "GET", "/health")).status === 200, { timeoutMs: 10_000 });
    first.kill("SIGKILL");
    await waitFor(() => first.exitCode !== null || first.signalCode !== null, { timeoutMs: 5000 });
    assert.equal(JSON.parse(readFileSync(instanceLockPath(home), "utf8")).pid, first.pid, "the lock of the killed daemon stays");
    second = startDaemon(home);
    await waitFor(() => existsSync(instanceLockPath(home)) && JSON.parse(readFileSync(instanceLockPath(home), "utf8")).pid === second.pid, { timeoutMs: 10_000 });
    await waitFor(async () => (await curl(sock, "GET", "/health").catch(() => ({}))).status === 200, { timeoutMs: 10_000 });
    assert.equal(journalTypes(home).filter((t) => t === "start").length, 2);
    second.kill("SIGTERM");
    await waitFor(() => second.exitCode !== null, { timeoutMs: 8000 });
    assert.equal(second.exitCode, 0, second.err);
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGKILL");
    cleanup(home);
  }
});

test("instance lock: held by a live process; a dead holder, a reused pid and an abandoned half-written lock are taken over", () => {
  const home = tempHome("ah-lock-");
  try {
    const mine = acquireInstanceLock(home);
    assert.equal(mine.ok, true);
    const rec = JSON.parse(readFileSync(instanceLockPath(home), "utf8"));
    assert.equal(rec.pid, process.pid);
    assert.ok(rec.startSec !== null || rec.lstart !== null, "the start time is recorded");
    // the same live process holds it
    assert.deepEqual(acquireInstanceLock(home), { ok: false, pid: process.pid });
    mine.release();
    assert.ok(!existsSync(instanceLockPath(home)));

    // the holder is gone
    writeFileSync(instanceLockPath(home), JSON.stringify({ pid: 999_999_999, startSec: 1, lstart: null }) + "\n");
    const afterDead = acquireInstanceLock(home);
    assert.equal(afterDead.ok, true, "a dead holder's lock is removed");
    afterDead.release();

    // the pid is alive but belongs to another process now (another start time)
    const real = processStartKey(process.pid);
    writeFileSync(instanceLockPath(home), JSON.stringify({ pid: process.pid, startSec: real.startSec === null ? null : real.startSec - 100, lstart: real.lstart === null ? null : "Thu Jan 1 00:00:00 1970" }) + "\n");
    const afterReuse = acquireInstanceLock(home);
    assert.equal(afterReuse.ok, true, "a reused pid is not the daemon");
    afterReuse.release();

    // start times unknown on both sides: a live pid counts as the holder (refusing is the safe side)
    writeFileSync(instanceLockPath(home), JSON.stringify({ pid: process.pid, startSec: null, lstart: null }) + "\n");
    assert.deepEqual(acquireInstanceLock(home, { tries: 2 }), { ok: false, pid: process.pid });

    // a lock that never got its record: fresh — someone is writing it; old — abandoned
    writeFileSync(instanceLockPath(home), "");
    assert.equal(acquireInstanceLock(home, { tries: 2 }).ok, false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(instanceLockPath(home), old, old);
    const afterEmpty = acquireInstanceLock(home);
    assert.equal(afterEmpty.ok, true);
    // release() removes only its own lock
    writeFileSync(instanceLockPath(home), JSON.stringify({ pid: 1, startSec: 1 }) + "\n");
    afterEmpty.release();
    assert.ok(existsSync(instanceLockPath(home)), "a lock someone else took is not removed");
  } finally {
    cleanup(home);
  }
});

test("claimHome: a live socket without a lock (a daemon that does not write one) is also a refusal, and the lock is given back", async () => {
  const home = tempHome("ah-claim-");
  const { createServer } = await import("node:net");
  const srv = createServer(() => {});
  try {
    await new Promise((res) => srv.listen(join(home, "hub.sock"), res));
    const r = await claimHome(home);
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "socket" });
    assert.ok(!existsSync(instanceLockPath(home)), "the lock is released");
    await new Promise((res) => srv.close(res));
    // a dead socket file is not a daemon
    writeFileSync(join(home, "hub.sock"), "");
    const ok = await claimHome(home);
    assert.equal(ok.ok, true);
    ok.release();
  } finally {
    srv.close(() => {});
    cleanup(home);
  }
});
