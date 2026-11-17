// Streamable plugin processes across daemon lives: the live ones are recorded in <home>/streams.json, and a daemon that starts
// after one that died without stopping them (SIGKILL, a crash) stops the leftovers before it starts the plugins again — so a
// plugin never runs twice. The guard is the same as for jobs: only a process that is provably the recorded one is killed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR, loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { loadNative } from "../lib/native.mjs";
import { createPeer } from "../lib/peer.mjs";
import { cleanup, curl, ensureNative, FILE_MODES, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killGroup = (pid) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
};

// startSec: a fixed start time for every live process, so the hub can tell "the same process"
const sysAs = ({ startSec = () => 1 } = {}) => ({
  available: true,
  peerPid: () => 10,
  peerUid: () => 501,
  pidPath: () => "/usr/bin/curl",
  pidInfo: (pid) => (alive(pid) ? { pid, ppid: 1, uid: 501, startSec: startSec(pid), startUsec: 0 } : null),
  procArgv: () => null,
  codesignVerify: async () => false,
  fileId: (p) => p,
  myUid: () => 501,
  readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
});

// A streamable plugin that does not read stdin (so it survives its daemon) and appends its pid to <dir>/pids on every start.
const plugin = (dir) => `#!/bin/sh
# <agenthub.title>Stream</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
echo $$ >> "${dir}/pids"
echo "S | status=ok"; echo "~~~"
while :; do sleep 0.2; done
`;
const pidsOf = (dir) =>
  readIf(join(dir, "pids"))
    .split("\n")
    .filter(Boolean)
    .map(Number);
const streamsOf = (home) => JSON.parse(readFileSync(join(home, "streams.json"), "utf8")).streams;

test("a running streamable process is recorded in <home>/streams.json (0600) and removed when it is gone", async () => {
  const plugins = tempHome("ah-so-");
  writePlugin(plugins, "s.sh", plugin(plugins));
  const h = await startHub({ pluginsDir: plugins, sys: sysAs({ startSec: () => 500 }) });
  try {
    await waitFor(() => pidsOf(plugins).length === 1);
    const [first] = pidsOf(plugins);
    await waitFor(() => existsSync(join(h.home, "streams.json")) && streamsOf(h.home).length === 1);
    assert.deepEqual(streamsOf(h.home), [{ plugin: "s", pid: first, pgid: first, startSec: 500 }]);
    if (FILE_MODES) assert.equal(statSync(join(h.home, "streams.json")).mode & 0o777, 0o600);
    // a restart: the old process leaves the table, the new one enters it
    await h.core.restartPlugin("s", "Manual");
    await waitFor(() => pidsOf(plugins).length === 2);
    const second = pidsOf(plugins)[1];
    await waitFor(() => streamsOf(h.home).length === 1 && streamsOf(h.home)[0].pid === second);
    assert.ok(!alive(first), "the old process is gone");
    // the crash path: a synchronous signal to every streamable group
    h.core.killStreamsSync("SIGKILL");
    await waitFor(() => !alive(second));
    const home = h.home;
    const core = h.core;
    await h.srv.close();
    await core.stop();
    assert.deepEqual(streamsOf(home), [], "a regular stop leaves nothing for the next daemon");
    for (const pid of pidsOf(plugins)) assert.ok(!alive(pid));
    cleanup(home);
  } finally {
    for (const pid of pidsOf(plugins)) killGroup(pid);
    cleanup(plugins);
  }
});

test("on start the daemon stops streamable processes left by a daemon that died — only when pid and start time still match", async () => {
  const home = tempHome("ah-so-");
  // a ignores SIGTERM: the SIGKILL a second later ends it; b — the pid was reused (another start time); c — no start time
  const a = spawn("/bin/sh", ["-c", `trap "" TERM; echo ready > "${home}/a.ready"; while :; do sleep 0.1; done`], { detached: true, stdio: "ignore" });
  const b = spawn("/bin/sleep", ["20"], { detached: true, stdio: "ignore" });
  const c = spawn("/bin/sleep", ["20"], { detached: true, stdio: "ignore" });
  let core;
  try {
    await waitFor(() => existsSync(join(home, "a.ready")));
    writeFileSync(
      join(home, "streams.json"),
      JSON.stringify({
        streams: [
          { plugin: "p", pid: a.pid, pgid: a.pid, startSec: 500 },
          { plugin: "q", pid: b.pid, pgid: b.pid, startSec: 777 },
          { plugin: "r", pid: c.pid, pgid: c.pid, startSec: null },
          { plugin: "gone", pid: 999_999_999, pgid: 999_999_999, startSec: 500 },
          "garbage",
        ],
      }),
      { mode: 0o600 },
    );
    const config = loadConfig({ env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "none"), AGENTHUB_SERVICES: "none" } });
    core = new Core({ config, peer: createPeer({ config, sys: sysAs({ startSec: () => 500 }) }) });
    const t0 = Date.now();
    await core.init({ startPlugins: false });
    // init waited for the leftover: it is gone by the time plugins would start
    assert.ok(!alive(a.pid), "the leftover is gone when init returns");
    assert.ok(Date.now() - t0 >= 900, "SIGTERM first, SIGKILL a second later");
    assert.ok(alive(b.pid), "a process whose start time differs is not touched");
    assert.ok(alive(c.pid), "a record without a start time is not acted on");
    const j = core.journal.tail(50);
    assert.deepEqual(j.filter((e) => e.type === "stream-orphan-killed").map((e) => [e.plugin, e.pid]), [["p", a.pid]]);
    assert.deepEqual(j.filter((e) => e.type === "stream-orphan-skipped").map((e) => [e.plugin, e.pid, e.reason]), [["r", c.pid, "unverified"], [null, null, "unverified"]]);
    assert.deepEqual(streamsOf(home), []);
  } finally {
    for (const p of [a, b, c]) killGroup(p.pid);
    await core?.stop();
    cleanup(home);
  }
});

test("without a way to read start times nothing is killed", async () => {
  const home = tempHome("ah-so-");
  const a = spawn("/bin/sleep", ["20"], { detached: true, stdio: "ignore" });
  let core;
  try {
    writeFileSync(join(home, "streams.json"), JSON.stringify({ streams: [{ plugin: "p", pid: a.pid, pgid: a.pid, startSec: 500 }] }), { mode: 0o600 });
    const config = loadConfig({ env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "none"), AGENTHUB_SERVICES: "none" } });
    const sys = sysAs();
    sys.pidInfo = () => null;
    core = new Core({ config, peer: createPeer({ config, sys }) });
    await core.init({ startPlugins: false });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(a.pid));
    assert.ok(!core.journal.tail(50).some((e) => e.type === "stream-orphan-killed"));
  } finally {
    killGroup(a.pid);
    await core?.stop();
    cleanup(home);
  }
});

// The whole path with real processes: needs the start time of a process (the peercred addon — macOS).
test("agenthubd killed with SIGKILL: the next daemon stops the surviving streamable process and runs one copy", { skip: !ensureNative() || !loadNative()?.pidInfo ? "needs the peercred addon" : false }, async () => {
  const home = tempHome("ah-so-");
  const plugins = tempHome("ah-so-");
  writePlugin(plugins, "s.sh", plugin(plugins));
  const env = { ...process.env, AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: plugins, AGENTHUB_SERVICES: "none", AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log") };
  delete env.NODE_OPTIONS;
  const start = () => {
    const d = spawn(process.execPath, [join(BIN, "agenthubd")], { env, stdio: ["ignore", "ignore", "pipe"] });
    d.err = "";
    d.stderr.on("data", (ch) => (d.err += ch));
    return d;
  };
  const sock = join(home, "hub.sock");
  const first = start();
  let second = null;
  try {
    await waitFor(() => pidsOf(plugins).length === 1, { timeoutMs: 15_000, label: "the plugin started" });
    const [old] = pidsOf(plugins);
    await waitFor(() => existsSync(join(home, "streams.json")) && streamsOf(home).some((s) => s.pid === old && Number.isFinite(s.startSec)), { timeoutMs: 5000 });
    first.kill("SIGKILL");
    await waitFor(() => first.exitCode !== null || first.signalCode !== null, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alive(old), "the streamable process outlives its daemon");
    assert.equal(streamsOf(home)[0].pid, old, "and is still on record");

    second = start();
    await waitFor(() => pidsOf(plugins).length === 2, { timeoutMs: 15_000, label: "the plugin started again" });
    const fresh = pidsOf(plugins)[1];
    assert.ok(!alive(old), "the old copy was stopped before the new one started");
    assert.ok(alive(fresh));
    await waitFor(async () => (await curl(sock, "GET", "/health").catch(() => ({}))).status === 200, { timeoutMs: 10_000 });
    const journal = readFileSync(join(home, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(journal.filter((e) => e.type === "stream-orphan-killed").map((e) => [e.plugin, e.pid]), [["s", old]]);
    await waitFor(() => streamsOf(home).length === 1 && streamsOf(home)[0].pid === fresh, { timeoutMs: 5000 });

    second.kill("SIGTERM");
    await waitFor(() => second.exitCode !== null, { timeoutMs: 10_000 });
    assert.equal(second.exitCode, 0, second.err);
    assert.ok(!alive(fresh), "a regular stop takes the plugin with it");
    assert.deepEqual(streamsOf(home), []);
  } finally {
    first.kill("SIGKILL");
    second?.kill("SIGKILL");
    for (const pid of pidsOf(plugins)) killGroup(pid);
    cleanup(home);
    cleanup(plugins);
  }
});
