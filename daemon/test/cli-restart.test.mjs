// `agenthub restart`: the launchd job is restarted through launchctl (a double here — AGENTHUB_TEST_LAUNCHCTL), the command
// waits for a daemon with another pid, and none of it needs a readable config.json. The real launchctl is never run:
// every case either has the double or is refused before launchctl (lib/launchd.mjs restartLaunchctl).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR } from "../lib/config.mjs";
import { installPlan, LABEL, restartLaunchctl } from "../lib/launchd.mjs";
import { accountHome, liveStateDir } from "../lib/platform.mjs";
import { pidAlive } from "../lib/statefile.mjs";
import { cleanup, curl, onlyDarwin, tempHome, waitFor } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");
const UID = process.getuid?.() ?? 0;

function envFor(home, extra = {}) {
  const e = { ...process.env, AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"), AGENTHUB_SERVICES: "none", AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log"), AGENTHUB_SYSTEM_LANG: "en", ...extra };
  delete e.NODE_OPTIONS;
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

const cli = (args, env) =>
  new Promise((resolve) => {
    execFile(process.execPath, [join(BIN, "agenthub"), ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });

test("restartLaunchctl: the real launchctl only for the account's live directory; a test directory or a fake HOME is refused", () => {
  const account = accountHome() || "/Users/someone";
  const live = liveStateDir({ env: {}, home: account });
  assert.deepEqual(restartLaunchctl(live, { env: {}, userHome: account, account, platform: "darwin" }), { launchctl: "/bin/launchctl" });
  assert.deepEqual(restartLaunchctl("/tmp/ah-x", { env: { AGENTHUB_HOME: "/tmp/ah-x" }, userHome: account, account, platform: "darwin" }), { refuse: "test-home" });
  // HOME=/tmp/fh: "live" by $HOME, but the launchd job belongs to the account, not to that HOME
  assert.deepEqual(restartLaunchctl(liveStateDir({ env: {}, home: "/tmp/fh" }), { env: {}, userHome: "/tmp/fh", account, platform: "darwin" }), { refuse: "test-home" });
  assert.deepEqual(restartLaunchctl("/tmp/ah-x", { env: { AGENTHUB_HOME: "/tmp/ah-x", AGENTHUB_TEST_LAUNCHCTL: "/tmp/lc" }, userHome: account, account, platform: "darwin" }), { launchctl: "/tmp/lc" });
  assert.deepEqual(restartLaunchctl(live, { env: { AGENTHUB_TEST_NO_LAUNCHD: "1", AGENTHUB_TEST_LAUNCHCTL: "/tmp/lc" }, userHome: account, account, platform: "darwin" }), { refuse: "no-launchd" });
  assert.deepEqual(restartLaunchctl(live, { env: {}, userHome: account, account, platform: "linux" }), { refuse: "no-launchd" });
  assert.deepEqual(installPlan({ uid: 501, home: "/tmp/h", launchctl: "/x/launchctl" }).kickstart, ["/x/launchctl", "kickstart", "-k", `gui/501/${LABEL}`]);
});

test("agenthub restart in a test directory without a launchctl double is refused and says how to restart; no launchd — refused too", { skip: onlyDarwin("launchd") }, async () => {
  const home = tempHome("ah-rs-");
  try {
    // a config.json the CLI cannot parse: `restart` does not read it, the other commands name the error
    writeFileSync(join(home, "config.json"), "{ broken", { mode: 0o600 });
    const r = await cli(["restart"], envFor(home, { AGENTHUB_TEST_LAUNCHCTL: undefined }));
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /only the live hub has one/);
    assert.ok(r.stderr.includes(`this is the test directory ${home}`), r.stderr);
    assert.doesNotMatch(r.stderr, /config\.json/);
    assert.ok(!existsSync(join(home, "config.json.bad")), "the CLI leaves no copy of the file");
    const st = await cli(["status"], envFor(home, { AGENTHUB_TEST_LAUNCHCTL: undefined }));
    assert.equal(st.code, 1);
    assert.match(st.stderr, /config\.json/);
    const n = await cli(["restart"], envFor(home, { AGENTHUB_TEST_NO_LAUNCHD: "1", AGENTHUB_TEST_LAUNCHCTL: join(home, "never-run") }));
    assert.equal(n.code, 1);
    assert.match(n.stderr, /this system has no launchd/);
    // the usage line lists the command
    rmSync(join(home, "config.json"));
    assert.match((await cli(["nope"], envFor(home, { AGENTHUB_TEST_LAUNCHCTL: undefined }))).stdout, /\| lang \| restart \| pin-app/);
  } finally {
    cleanup(home);
  }
});

test("agenthub restart with a damaged config.json: kickstart -k, waits for the new daemon's pid, names the damaged file", { skip: onlyDarwin("launchd") }, async () => {
  const home = tempHome("ah-rs-");
  const sock = join(home, "hub.sock");
  const calls = join(home, "launchctl.log");
  const pidFile = join(home, "old.pid");
  const launchctl = join(home, "launchctl");
  writeFileSync(join(home, "config.json"), "{ broken", { mode: 0o600 });
  // the double does what launchd does on `kickstart -k`: kills the running daemon and starts a new one
  writeFileSync(
    launchctl,
    `#!/bin/sh\necho "$*" >> '${calls}'\nif [ "$1" = kickstart ]; then\n  kill -9 "$(cat '${pidFile}')" 2>/dev/null\n  '${process.execPath}' '${join(BIN, "agenthubd")}' >/dev/null 2>&1 &\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  const env = envFor(home, { AGENTHUB_TEST_LAUNCHCTL: launchctl });
  const first = spawn(process.execPath, [join(BIN, "agenthubd")], { env, stdio: "ignore" });
  let second = null;
  try {
    await waitFor(async () => existsSync(sock) && (await curl(sock, "GET", "/health")).status === 200, { timeoutMs: 15_000, label: "the first daemon answers" });
    writeFileSync(pidFile, String(first.pid));
    const r = await cli(["restart"], env);
    second = (await curl(sock, "GET", "/health")).body?.pid ?? null;
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(calls, "utf8"), `kickstart -k gui/${UID}/${LABEL}\n`);
    assert.ok(Number.isInteger(second) && second !== first.pid, "another daemon answers");
    assert.ok(r.stdout.includes(`Hub daemon restarted: pid ${second} (was ${first.pid})`), r.stdout);
    assert.match(r.stdout, /warning: the daemon could not read config\.json/);
    await waitFor(() => first.exitCode !== null || first.signalCode !== null, { timeoutMs: 5000 });
    assert.equal(first.signalCode, "SIGKILL");
  } finally {
    first.kill("SIGKILL");
    second ??= await curl(sock, "GET", "/health").then((x) => x.body?.pid ?? null, () => null);
    if (second) {
      try {
        process.kill(second, "SIGTERM");
      } catch {}
      await waitFor(() => !pidAlive(second), { timeoutMs: 8000 }).catch(() => {
        try {
          process.kill(second, "SIGKILL");
        } catch {}
      });
    }
    cleanup(home);
  }
});

test("agenthub restart: a job that is not loaded is bootstrapped from the installed plist; without the plist — install first; no answer — exit 1", { skip: onlyDarwin("launchd") }, async () => {
  const fakeHome = tempHome("ah-rsh-");
  try {
    const calls = join(fakeHome, "launchctl.log");
    const launchctl = join(fakeHome, "launchctl");
    // like the real launchctl for a job that is not loaded: kickstart fails (113), bootstrap works
    writeFileSync(launchctl, `#!/bin/sh\necho "$*" >> '${calls}'\nif [ "$1" = kickstart ]; then echo 'Could not find service' >&2; exit 113; fi\nexit 0\n`, { mode: 0o755 });
    const env = { ...process.env, HOME: fakeHome, AGENTHUB_TEST_LAUNCHCTL: launchctl, AGENTHUB_INSTALL_WAIT_MS: "400", AGENTHUB_SYSTEM_LANG: "en" };
    delete env.NODE_OPTIONS;
    delete env.AGENTHUB_HOME;
    const target = join(fakeHome, "Library", "LaunchAgents", `${LABEL}.plist`);
    const a = await cli(["restart"], env);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.match(a.stderr, /is not loaded \(Could not find service\)/);
    assert.ok(a.stderr.includes(target));
    assert.match(a.stderr, /agenthub install --apply/);
    assert.equal(readFileSync(calls, "utf8"), `kickstart -k gui/${UID}/${LABEL}\n`);
    mkdirSync(join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(target, "<plist/>\n");
    const b = await cli(["restart"], env);
    assert.equal(b.code, 1, b.stdout + b.stderr);
    assert.match(b.stderr, /did not answer/);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n").slice(1), [`kickstart -k gui/${UID}/${LABEL}`, `bootstrap gui/${UID} ${target}`]);
  } finally {
    cleanup(fakeHome);
  }
});
