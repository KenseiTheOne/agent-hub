// Review fixes of 2026-11-12, part B: background jobs and the runner (B1–B6), the host policy check (B7), external-session
// refusals (B8), the subscribe permission kind (B9), recursive watch in the permission key (B10) and gating registry entries
// that use attributes newer than hub 0.1.2 (B11). System doubles, temp directories only, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { createPeer } from "../lib/peer.mjs";
import { entryContractTooNew, parseIndex } from "../lib/plugins.mjs";
import { CONTRACT_FEATURES, contractFeatures, indexContract, indexPermissions, permissionList, permissionsFromMeta } from "../lib/registry/perms.mjs";
import { consentText } from "../lib/registry/terminal.mjs";
import { runOnce, spawnJob, StreamProcess } from "../lib/runner.mjs";
import { validateArgs } from "../lib/schema.mjs";
import * as interrupt from "../lib/primitives/session.interrupt.mjs";
import * as stopPrim from "../lib/primitives/session.stop.mjs";
import { TerminalService } from "../lib/services/terminal.mjs";
import { cleanup, FILE_MODES, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = { class: "app", pid: 10 };
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const overrides = { requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' } };
// startSec: a fixed start time for every live process, so the hub can tell "the same process" (B3, B4)
const sysAs = ({ startSec = () => 1 } = {}) => ({
  available: true,
  peerPid: () => 10,
  peerUid: () => 501,
  pidPath: (pid) => (pid === 10 ? "/Applications/AgentHub.app/Contents/MacOS/AgentHub" : "/usr/bin/curl"),
  pidInfo: (pid) => (pid === 10 || alive(pid) ? { pid, ppid: 1, uid: 501, startSec: startSec(pid), startUsec: 0 } : null),
  procArgv: () => null,
  codesignVerify: async (p) => p.startsWith("/Applications/AgentHub.app"),
  fileId: (p) => p,
  myUid: () => 501,
  readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
});

// ---------- a streamable plugin with background jobs ----------
// "slowstop": on {"type":"stopping"} the process takes 1.5 s to exit (and ignores SIGTERM) — the window in which the hub has no
// stream process to write to (B1).
const STREAM = `#!/bin/sh
# <agenthub.title>Stream</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
# <agenthub.secrets>s.token — test</agenthub.secrets>
# <agenthub.action id="job" level="immediate" title="Job" background="true">s.sh --action job</agenthub.action>
# <agenthub.action id="long" level="immediate" title="Long" background="true">s.sh --action long</agenthub.action>
# <agenthub.action id="orphan" level="immediate" title="Orphan" background="true">s.sh --action orphan</agenthub.action>
D="$AGENTHUB_PLUGIN_DATA_PATH"
if [ "$1" = "--action" ]; then
  case "$2" in
    job) sleep 0.4; exit 0 ;;
    long) trap 'echo term >> "$D/long.log"; exit 143' TERM; echo start >> "$D/long.log"; i=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; exit 0 ;;
    orphan) D="$D" perl -e 'use POSIX; POSIX::setsid(); open(my $f, ">", "$ENV{D}/gc.pid"); print $f $$; close $f; sleep 20' & sleep 0.2; exit 0 ;;
  esac
fi
trap '' TERM
echo "S | status=ok"; echo "---"; echo "Job | action=job"; echo "Long | action=long"; echo "Orphan | action=orphan"; echo "~~~"
while IFS= read -r line; do
  echo "$AGENTHUB_REFRESH_REASON $line" >> "$D/stdin.log"
  case "$line" in *'"stopping"'*) sleep 1.5; exit 0 ;; esac
done
`;

async function streamHub(extra = {}) {
  const plugins = tempHome("ah-rb-");
  writePlugin(plugins, "s.sh", STREAM);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(), ...extra });
  h.plugins = plugins;
  h.data = join(h.config.paths.pluginData, "s");
  h.offer = (title) => h.core.pluginState("s").body.find((b) => b.title === title).offer;
  // [reason, message] per stdin line, in order
  h.stdin = () =>
    readIf(join(h.data, "stdin.log"))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(" ");
        return [l.slice(0, i), JSON.parse(l.slice(i + 1))];
      });
  await waitFor(() => h.core.pluginState("s")?.body.length);
  return h;
}

test("B1: a job that ends while the streamable process restarts — the new process gets the running list and the jobExit", async () => {
  const h = await streamHub();
  try {
    // the first start already tells the plugin which jobs run (none)
    await waitFor(() => h.stdin().some(([why, m]) => why === "FirstLaunch" && m.type === "jobs"));
    assert.deepEqual(h.stdin().find(([, m]) => m.type === "jobs")[1].running, []);
    const long = await h.core.invoke({ id: h.offer("Long").id, peer: APP });
    const r = await h.core.invoke({ id: h.offer("Job").id, peer: APP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const jobId = r.body.result.job;
    // the restart takes ~1.5 s (the old process lingers); the 0.4 s job ends inside that window
    const restarted = h.core.restartPlugin("s", "SecretChanged");
    await waitFor(() => !h.core.jobList().some((j) => j.id === jobId), { timeoutMs: 4000 });
    await restarted;
    await waitFor(() => h.stdin().some(([why, m]) => why === "SecretChanged" && m.type === "jobExit" && m.job === jobId), { timeoutMs: 5000 });
    const after = h.stdin().filter(([why]) => why === "SecretChanged").map(([, m]) => m);
    const jobs = after.find((m) => m.type === "jobs");
    assert.ok(jobs, "the new process hears which jobs still run");
    assert.deepEqual(jobs.running.map((j) => [j.id, j.actionId]), [[long.body.result.job, "long"]]);
    assert.equal(after.find((m) => m.type === "jobExit").ok, true);
  } finally {
    await h.stop();
    cleanup(h.plugins);
  }
});

test("B2: a job whose descendant escapes with setsid and keeps stdout open still ends; stopJob forces the end of a job that never exits", async () => {
  const h = await streamHub();
  let gc = null;
  try {
    const r = await h.core.invoke({ id: h.offer("Orphan").id, peer: APP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => readIf(join(h.data, "gc.pid")).trim());
    gc = Number(readIf(join(h.data, "gc.pid")).trim());
    // the leader exits after 0.2 s; the grandchild holds stdout for 20 s — the job must end anyway
    await waitFor(() => h.core.jobList().length === 0, { timeoutMs: 4000 });
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "job-exit" && e.job === r.body.result.job && e.ok === true));
    // a job that never reports its exit (a kill that cannot stop it): stopJob ends it as orphaned
    h.core.jobKillGraceMs = 50;
    const fake = { id: "f".repeat(16), plugin: "s", actionId: "long", title: "Fake", startedAt: new Date().toISOString(), pid: 999999, kill: () => false, inst: h.core.host.get("s"), started: Date.now() };
    h.core.jobs.set(fake.id, fake);
    h.core.stopJob(fake, "cancelled");
    await waitFor(() => !h.core.jobs.has(fake.id), { timeoutMs: 2000 });
    const e = h.core.journal.tail(100).find((x) => x.type === "job-exit" && x.job === fake.id);
    assert.equal(e.reason, "orphaned");
    assert.equal(e.cancelled, "cancelled");
  } finally {
    if (gc) {
      try {
        process.kill(gc, "SIGKILL");
      } catch {}
    }
    await h.stop();
    cleanup(h.plugins);
  }
});

test("B3: running jobs are written to <home>/jobs.json (0600) and removed when they end; killJobsSync signals every job", async () => {
  const h = await streamHub();
  try {
    const file = join(h.home, "jobs.json");
    const r = await h.core.invoke({ id: h.offer("Long").id, peer: APP });
    const jobId = r.body.result.job;
    await waitFor(() => readIf(join(h.data, "long.log")).includes("start"));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved.jobs.map((j) => [j.job, j.plugin, j.pid, j.pgid, j.startSec]), [[jobId, "s", r.body.result.pid, r.body.result.pid, 1]]);
    if (FILE_MODES) assert.equal(statSync(file).mode & 0o777, 0o600);
    // what the daemon does in uncaughtException: synchronous SIGTERM to every job group
    h.core.killJobsSync("SIGTERM");
    await waitFor(() => readIf(join(h.data, "long.log")).includes("term"));
    await waitFor(() => h.core.jobList().length === 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).jobs, []);
  } finally {
    await h.stop();
    cleanup(h.plugins);
  }
});

test("B3: on start the daemon kills job groups left by a crashed daemon — only when pid and start time still match", async () => {
  const home = tempHome("ah-rb3-");
  const a = spawn("/bin/sleep", ["20"], { detached: true, stdio: "ignore" });
  const b = spawn("/bin/sleep", ["20"], { detached: true, stdio: "ignore" });
  let core;
  try {
    writeFileSync(
      join(home, "jobs.json"),
      JSON.stringify({ jobs: [
        { job: "a".repeat(16), plugin: "p", actionId: "x", pid: a.pid, pgid: a.pid, startSec: 500 },
        // b: another start time — the pid was reused by an unrelated process, it is left alone
        { job: "b".repeat(16), plugin: "p", actionId: "x", pid: b.pid, pgid: b.pid, startSec: 777 },
      ] }),
      { mode: 0o600 },
    );
    const config = loadConfig({ env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "none"), AGENTHUB_SERVICES: "none" } });
    core = new Core({ config, peer: createPeer({ config, sys: sysAs({ startSec: () => 500 }) }) });
    await core.init({ startPlugins: false });
    await waitFor(() => !alive(a.pid), { timeoutMs: 4000 });
    assert.ok(alive(b.pid), "a process whose start time differs is not touched");
    const j = core.journal.tail(50);
    assert.ok(j.some((e) => e.type === "job-orphan-killed" && e.pid === a.pid && e.plugin === "p"));
    assert.ok(!j.some((e) => e.type === "job-orphan-killed" && e.pid === b.pid));
    assert.deepEqual(JSON.parse(readFileSync(join(home, "jobs.json"), "utf8")).jobs, []);
  } finally {
    for (const c of [a, b]) {
      try {
        process.kill(c.pid, "SIGKILL");
      } catch {}
    }
    await core?.stop();
    cleanup(home);
  }
});

test("B4: a run's pid stops being attributed as soon as the process exits, even while a descendant keeps stdout open", async () => {
  const dir = tempHome("ah-rb4-");
  try {
    // standard run: the leader writes its pid and exits; a background sleep holds stdout for 2 s
    const script = writePlugin(dir, "p.sh", `#!/bin/sh\necho $$ > "${dir}/pid"\nsleep 2 &\necho A\nexit 0\n`);
    const pids = new Set();
    const run = runOnce(["/bin/sh", script], { env: { PATH: "/usr/bin:/bin" }, cwd: dir, onSpawn: (_k, pid) => pids.add(pid), onLeaderExit: (pid) => pids.delete(pid) });
    await waitFor(() => readIf(join(dir, "pid")).trim() && !alive(Number(readIf(join(dir, "pid")).trim())));
    assert.equal(pids.size, 0, "the pid is dropped on exit, not on close");
    await run;
    // streamable: the same — pid is null once the leader exited
    const s2 = writePlugin(dir, "q.sh", `#!/bin/sh\necho $$ > "${dir}/qpid"\nsleep 2 &\necho A\necho "~~~"\nexit 0\n`);
    const sp = new StreamProcess(["/bin/sh", s2], { env: { PATH: "/usr/bin:/bin" }, cwd: dir, onFrame: () => {} });
    sp.start();
    await waitFor(() => readIf(join(dir, "qpid")).trim() && !alive(Number(readIf(join(dir, "qpid")).trim())));
    await waitFor(() => sp.pid === null, { timeoutMs: 1000 });
    await sp.stop();
    // a job: after the leader exited, kill() no longer signals its (possibly reused) group
    let exited = null;
    const job = spawnJob(["/bin/sh", "-c", "exit 0"], { env: { PATH: "/usr/bin:/bin" }, cwd: dir, onLeaderExit: () => (exited = true), onExit: () => {} });
    await waitFor(() => exited);
    assert.equal(job.kill("SIGTERM"), false);
  } finally {
    cleanup(dir);
  }
});

test("B5: two presses at once cannot start more jobs than maxJobsPerPlugin", async () => {
  const h = await streamHub({ overrides: { ...overrides, plugins: { maxJobsPerPlugin: 1 } } });
  try {
    // a slow keychain makes the race window wide: both presses pass the check before either job is in the table
    h.core.setSecretsProvider(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return null;
    });
    const id = h.offer("Long").id;
    const rs = await Promise.all([h.core.invoke({ id, peer: APP }), h.core.invoke({ id, peer: APP })]);
    const started = rs.filter((r) => typeof r.body?.result?.job === "string");
    assert.equal(started.length, 1, JSON.stringify(rs.map((r) => r.body)));
    assert.equal(h.core.jobList().length, 1);
    const refused = rs.find((r) => r !== started[0]);
    assert.ok(refused.body.error === "facts:jobs-limit" || refused.body.result?.error === "jobs-limit", JSON.stringify(refused.body));
  } finally {
    await h.stop();
    cleanup(h.plugins);
  }
});

test("B6: a streamable process that doesn't read stdin — writes over 1 MB of backlog are dropped and reported once", async () => {
  const dir = tempHome("ah-rb6-");
  try {
    const script = writePlugin(dir, "p.sh", `#!/bin/sh\necho A\necho "~~~"\nsleep 20\n`);
    let backlog = 0;
    const sp = new StreamProcess(["/bin/sh", script], { env: { PATH: "/usr/bin:/bin" }, cwd: dir, onFrame: () => {}, onBacklog: () => backlog++ });
    sp.start();
    await waitFor(() => sp.pid);
    const big = { type: "event", text: "x".repeat(64 * 1024) };
    let refused = 0;
    for (let i = 0; i < 40; i++) if (!sp.write(big)) refused++;
    assert.ok(refused > 0, "writes past the limit are refused");
    assert.ok(sp.child.stdin.writableLength <= 1024 * 1024 + 70 * 1024, `bounded: ${sp.child.stdin.writableLength}`);
    assert.equal(backlog, 1, "reported once per backlog");
    await sp.stop();
  } finally {
    cleanup(dir);
  }
});

test("B6: the core journals a stdin backlog once per episode", async () => {
  const h = await startHub({ overrides, sys: sysAs() });
  try {
    h.core.stdinBacklog("p");
    h.core.stdinBacklog("p");
    assert.equal(h.core.journal.tail(20).filter((e) => e.type === "stdin-backlog" && e.plugin === "p").length, 1);
  } finally {
    await h.stop();
  }
});

test("B7: a new registry label reaches a running plugin without restarting it", async () => {
  const plugins = tempHome("ah-rb7-");
  const label = { v: null };
  const h = await startHub({ overrides, sys: sysAs() });
  try {
    h.core.setPluginPolicy(async () => ({ allowed: true, effects: [], tier: "community", registry: "main", registryLabel: label.v }));
    writePlugin(join(h.config.paths.plugins, "c"), "c.1h.sh", `#!/bin/sh\necho "C | status=ok"\n`);
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("c")?.lastRunAt);
    const inst = h.core.host.get("c");
    assert.equal(h.core.pluginState("c").registryLabel, null);
    label.v = "Main";
    await h.core.host.rescan();
    assert.equal(h.core.pluginState("c").registryLabel, "Main");
    assert.equal(h.core.host.get("c"), inst, "the same instance keeps running");
    assert.equal(inst.plugin.granted.registryLabel, "Main");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- B8 ----------
test("B8: session.interrupt / session.stop accept an external session id and refuse it with facts:external-session", () => {
  const facts = { session: () => null, sessions: () => [], externalSession: (id) => (id === "cx-1" ? { sessionId: "cx-1", pid: 4242, kind: "external" } : null), get: () => null };
  for (const prim of [interrupt, stopPrim]) {
    assert.equal(validateArgs(prim.argsSchema, { sessionId: "cx-1" }).error, undefined, prim.name);
    assert.deepEqual(prim.verifyFacts({ sessionId: "cx-1" }, facts), { ok: false, reason: "external-session" });
    assert.equal(validateArgs(prim.argsSchema, { sessionId: "a b" }).error, "args:sessionId:pattern");
  }
});

test("B8: the terminal service refuses an external session with terminal:external-session, not a pattern error", async () => {
  const journal = [];
  const ctx = {
    config: { services: {} },
    facts: { pluginByPid: () => ({ id: "p", trusted: true, terminal: ["send * — x", "read-screen — x"] }) },
    estop: () => false,
    journal: { write: (e) => journal.push(e) },
    emit: () => {},
    sessions: { get: () => null, list: () => [], external: (id) => (id === "cx-1" ? { sessionId: "cx-1" } : null) },
  };
  const svc = new TerminalService(ctx);
  const r = await svc.sendText({ class: "cli", pid: 20 }, { sessionId: "cx-1", text: "hello" });
  assert.deepEqual([r.status, r.body.error], [409, "terminal:external-session"]);
  const g = await svc.sendText({ class: "cli", pid: 20 }, { sessionId: "a b", text: "hello" });
  assert.equal(g.body.error, "args:sessionId:pattern");
});

// ---------- B9 ----------
test("B9: the CLI consent names the subscribe kind; the index checks the shape of permissions.subscribe", () => {
  const prep = { entry: { tier: "official", title: "T", version: "1.0.0", sha256: "a".repeat(64) }, fromVersion: null, list: permissionList({ subscribe: [{ what: "builds:failed", why: "react" }] }) };
  assert.match(consentText(prep, "en"), /subscription: builds:failed — react/);
  assert.match(consentText(prep, "ru"), /подписка: builds:failed — react/);
  const index = (subscribe) => JSON.stringify({ version: 1, generatedAt: "2026-11-12T00:00:00Z", plugins: [{ id: "x", version: "1.0.0", sha256: "a".repeat(64), archive: "x.tgz", size: 1, permissions: { subscribe } }] });
  assert.equal(parseIndex(index([{ what: "a:b", why: "w" }])).plugins.size, 1);
  assert.throws(() => parseIndex(index("a:b")), (e) => e.code === "registry:index-entry");
  assert.throws(() => parseIndex(index([{ what: 5 }])), (e) => e.code === "registry:index-entry");
});

// ---------- B10 ----------
test('B10: recursive="true" on <agenthub.watch> is part of the permission key', () => {
  const head = "# <agenthub.title>T</agenthub.title>\n";
  const flat = parseMetaText(head + "# <agenthub.watch>~/data — why</agenthub.watch>\n").meta;
  const deep = parseMetaText(head + '# <agenthub.watch recursive="true">~/data — why</agenthub.watch>\n').meta;
  const key = (perms) => permissionList(perms).find((p) => p.kind === "watch");
  assert.equal(key(permissionsFromMeta(flat)).key, "watch:~/data");
  assert.equal(key(permissionsFromMeta(deep)).key, "watch:~/data recursive");
  assert.equal(key(permissionsFromMeta(deep)).why, "why");
  // the index (old watch form) gives the same key
  assert.equal(key(indexPermissions(deep)).key, "watch:~/data recursive");
  // the linter still checks the path itself
  assert.equal(permissionsFromMeta(deep).watch[0].what, "~/data");
});

// ---------- B11 ----------
test("B11: index entries using attributes newer than hub 0.1.2 carry an object contract; this hub honors known features", () => {
  const head = "# <agenthub.title>T</agenthub.title>\n# <agenthub.contract>3</agenthub.contract>\n";
  const plain = parseMetaText(head + '# <agenthub.action id="a" level="confirm">t.sh</agenthub.action>\n').meta;
  assert.equal(indexContract(plain, { official: true }), 3, "nothing new: a plain integer, as before");
  assert.equal(indexContract(parseMetaText("# <agenthub.title>T</agenthub.title>\n").meta), undefined, "no tag, no features — no field");
  const bg = parseMetaText(head + '# <agenthub.action id="a" level="confirm" background="true" net="none">t.sh</agenthub.action>\n').meta;
  assert.deepEqual(contractFeatures(bg, { official: true }), ["background", "net-none"]);
  assert.deepEqual(indexContract(bg, { official: true }), { version: 3, features: ["background", "net-none"] });
  // a community plugin with actions: hub 0.1.2's linter refused them
  assert.deepEqual(contractFeatures(plain, { official: false }), ["community-actions"]);
  for (const f of ["input", "subscribe", "http-connection", "watch-recursive"]) assert.ok(CONTRACT_FEATURES.includes(f), f);

  const entry = (contract) => ({ id: "x", version: "1.0.0", sha256: "a".repeat(64), archive: "x.tgz", size: 1, permissions: {}, contract });
  const index = (...plugins) => JSON.stringify({ version: 1, generatedAt: "2026-11-12T00:00:00Z", plugins: plugins.map((p, i) => ({ ...p, id: `x${i}` })) });
  const cat = parseIndex(index(entry({ version: 3, features: ["background", "net-none"] }), entry({ version: 3, features: ["teleport"] }), entry({ version: 9, features: [] }), entry(3), entry({ version: "3" })));
  const [known, unknownFeature, newer, integer, bad] = [...cat.plugins.values()];
  assert.equal(known.contract, 3);
  assert.deepEqual(known.contractFeatures, ["background", "net-none"]);
  assert.equal(entryContractTooNew(known), null, "this hub knows every feature");
  assert.deepEqual(entryContractTooNew(unknownFeature), { need: null, have: 3, features: ["teleport"] });
  assert.deepEqual(entryContractTooNew(newer), { need: 9, have: 3 });
  assert.equal(entryContractTooNew(integer), null);
  assert.deepEqual(entryContractTooNew(bad), { need: null, have: 3 });
  // hub 0.1.2 accepts only an integer contract: anything else is "contractUnknown" → "Needs a newer hub" (registry:hub-too-old)
  assert.ok(!Number.isInteger(indexContract(bg, { official: true })));
});

// Re-review 65 (registry side): an action with inputPattern= gates its index entry on hubs that know the feature.
test("contract feature input-pattern: an action with inputPattern= adds it next to input; known to this hub", () => {
  const head = "# <agenthub.title>T</agenthub.title>\n# <agenthub.contract>3</agenthub.contract>\n";
  const both = parseMetaText(head + '# <agenthub.action id="reply" level="confirm" input="Reply" inputPattern="^[^<>]{1,500}$" arg="row:^[a-z0-9]{1,16}$">t.sh --reply {row}</agenthub.action>\n').meta;
  assert.ok(both.actions[0].input?.pattern, "the parser keeps the pattern");
  assert.deepEqual(contractFeatures(both, { official: true }), ["input", "input-pattern"]);
  assert.deepEqual(indexContract(both, { official: true }), { version: 3, features: ["input", "input-pattern"] });
  const plain = parseMetaText(head + '# <agenthub.action id="reply" level="confirm" input="Reply" arg="text:^[^<>]{1,500}$">t.sh --reply</agenthub.action>\n').meta;
  assert.deepEqual(contractFeatures(plain, { official: true }), ["input"]);
  assert.ok(CONTRACT_FEATURES.includes("input-pattern"));
});
