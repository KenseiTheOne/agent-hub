// Fixes from review 3 of 2026-11-12 (tracker tasks 79–84), daemon side: offer ids stay stable when one offer sits on rows
// with different texts (79), a plugin's processes stay attributed while it is being stopped and a connection whose process
// is gone gets only the narrow routes (80), the *.key linter rule catches multi-dot names again (81), a stream's process
// group is forgotten once it is empty (82), the throttle notice of a macOnly rule stays on the Mac (83), forced fresh calls
// and the job limit (84). Temp directories and system doubles only, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSys } from "../lib/peer.mjs";
import { lintPlugin, sourceViolations } from "../lib/registry/perms.mjs";
import { groupAlive } from "../lib/platform.mjs";
import { StreamProcess } from "../lib/runner.mjs";
import { routes as connectionRoutes } from "../lib/routes/connections.mjs";
import { resolvePushConfig } from "../lib/push/config.mjs";
import { PushEngine } from "../lib/push/engine.mjs";
import { memoryStore } from "../lib/push/store.mjs";
import { createChannelSet } from "../lib/push/channels.mjs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = { class: "app", pid: 10 };
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_PEERCRED = !defaultSys().available && "no peercred addon";

// ---------- 79: offer ids stay stable across frames ----------

test("79: the same button on a live header line and on a body row — the header offer keeps its id across frames; a confirmation opened on frame 1 runs after frame 2", async () => {
  const plugins = tempHome("ah-79h-");
  // the header text carries a time that changes every frame
  writePlugin(
    plugins,
    "n.sh",
    `#!/bin/sh
# <agenthub.title>Batch</agenthub.title>
# <agenthub.action id="stop" level="confirm" title="Stop the batch">n.sh --action stop</agenthub.action>
[ "$1" = "--action" ] && exit 0
echo "Batch: task t1, $(date +%s)$$ | status=ok action=stop"
echo "---"
echo "Stop | action=stop"
`,
  );
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("n")?.header.length);
    const headerOffer = () => h.core.pluginState("n").header[0].offer;
    const bodyOffer = () => h.core.pluginState("n").body.find((b) => b.title === "Stop").offer;
    const a = headerOffer().id;
    assert.notEqual(a, bodyOffer().id, "two row texts — two offers");
    const r = await h.core.invoke({ id: a, peer: APP });
    assert.equal(r.status, 428);
    assert.match(r.body.row, /^Batch: task t1, /, "the 428 names the header row");
    const text1 = h.core.pluginState("n").header[0].title;
    await h.core.host.get("n").runStandard("Manual");
    assert.notEqual(h.core.pluginState("n").header[0].title, text1, "the header text did change");
    assert.equal(headerOffer().id, a, "the header offer keeps its id");
    const c = await h.core.invoke({ id: a, confirmToken: r.body.token, peer: APP });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    // the body row's offer is stable too, and its 428 names its own row
    const b = bodyOffer().id;
    await h.core.host.get("n").runStandard("Manual");
    assert.equal(bodyOffer().id, b);
    assert.equal((await h.core.invoke({ id: b, peer: APP })).body.row, "Stop");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("79: a second copy of an offer appearing or disappearing doesn't break an open confirmation; a parent row with a live text keeps the child's id", async () => {
  const plugins = tempHome("ah-79c-");
  const work = tempHome("ah-79w-");
  const mode = join(work, "mode");
  writeFileSync(mode, "one");
  writePlugin(
    plugins,
    "s.sh",
    `#!/bin/sh
# <agenthub.title>Split</agenthub.title>
# <agenthub.action id="skip" level="confirm" title="Skip this task tonight" arg="task:^[a-z0-9]{1,16}$">s.sh --action skip {task}</agenthub.action>
[ "$1" = "--action" ] && exit 0
M=$(cat "${mode}")
echo "Split | status=ok"
echo "---"
echo "Task t1 (queued $(date +%s)$$)"
echo "--Skip this task tonight | action=skip arg=t1"
[ "$M" = "two" ] && echo "Skip task t1 | action=skip arg=t1"
[ "$M" = "first" ] && echo "Skip t1 now | action=skip arg=t1"
exit 0
`,
  );
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("s")?.body.length);
    const child = () => h.core.pluginState("s").body.find((x) => x.title === "Skip this task tonight").offer.id;
    const id1 = child();
    const r = await h.core.invoke({ id: id1, peer: APP });
    assert.equal(r.status, 428);
    assert.match(r.body.row, /^Task t1 \(queued /, "a child button named like the action is confirmed with its parent row");
    // the parent row's text changes every frame: the child's id doesn't
    await h.core.host.get("s").runStandard("Manual");
    assert.equal(child(), id1);
    // a second copy appears after it: the first copy keeps the base id, the open confirmation runs
    writeFileSync(mode, "two");
    await h.core.host.get("s").runStandard("Manual");
    assert.equal(child(), id1, "a later copy doesn't move the first one");
    const other = h.core.pluginState("s").body.find((x) => x.title === "Skip task t1").offer.id;
    assert.notEqual(other, id1);
    const r2 = await h.core.invoke({ id: other, peer: APP });
    assert.equal(r2.body.row, "Skip task t1", "the 428 names the clicked row");
    // a token for the second row doesn't act on the first
    assert.equal((await h.core.invoke({ id: id1, confirmToken: r2.body.token, peer: APP })).status, 403);
    const again = await h.core.invoke({ id: id1, peer: APP });
    // the copy disappears again — still the same id, the confirmation runs
    writeFileSync(mode, "one");
    await h.core.host.get("s").runStandard("Manual");
    assert.equal(child(), id1);
    assert.equal((await h.core.invoke({ id: id1, confirmToken: again.body.token, peer: APP })).status, 200);
    // a copy that appears before it in the frame takes the base id: an id opened on the child still runs the same
    // action and arguments (200), never a 404
    const r3 = await h.core.invoke({ id: id1, peer: APP });
    writeFileSync(mode, "first");
    await h.core.host.get("s").runStandard("Manual");
    const c3 = await h.core.invoke({ id: id1, confirmToken: r3.body.token, peer: APP });
    assert.equal(c3.status, 200, JSON.stringify(c3.body));
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(work);
  }
});

// ---------- 80: processes of a plugin that is being stopped ----------

// A streamable plugin that calls the hub when it is told it is stopping (restart or update); its files are named by its pid.
const stopper = (sock, out) => `#!/bin/sh
# <agenthub.title>Stop</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
S="${sock}"
O="${out}.$$"
echo "Stop | status=ok"
echo "~~~"
while read -r l; do
  case "$l" in *stopping*)
    /usr/bin/curl -s -o /dev/null -w '%{http_code}' --unix-socket "$S" http://hub/state > "$O.stopping.tmp"; mv "$O.stopping.tmp" "$O.stopping"
    /usr/bin/curl -s --unix-socket "$S" http://hub/peer > "$O.peer.tmp"; mv "$O.peer.tmp" "$O.peer"
    exit 0;;
  esac
done
`;

async function stopScenario(h, work) {
  const out = join(work, "o");
  mkdirSync(h.config.paths.pluginsLocal, { recursive: true });
  const file = writePlugin(h.config.paths.pluginsLocal, "stop.sh", stopper(h.sock, out));
  await h.core.host.rescan();
  await waitFor(() => h.core.pluginState("stop")?.pid, { timeoutMs: 8000 });
  const seen = async (pid) => {
    await waitFor(() => existsSync(`${out}.${pid}.peer`), { timeoutMs: 8000 });
    return { state: readIf(`${out}.${pid}.stopping`), peer: JSON.parse(readIf(`${out}.${pid}.peer`)) };
  };
  // 1) a restart of the same instance (language, pause, a secret)
  const p1 = h.core.pluginState("stop").pid;
  await h.core.restartPlugin("stop", "SecretChanged");
  const restart = await seen(p1);
  // 2) the plugin file changes: the old instance is stopped ("updated")
  await waitFor(() => h.core.pluginState("stop")?.pid && h.core.pluginState("stop").pid !== p1, { timeoutMs: 8000 });
  const p2 = h.core.pluginState("stop").pid;
  const t = new Date(Date.now() + 5000);
  utimesSync(file, t, t);
  await h.core.host.rescan();
  const update = await seen(p2);
  return { restart, update };
}

test("80: an untrusted streamable plugin calling the hub while it restarts or is replaced is still the plugin's: 403, named on /peer", { skip: NO_PEERCRED }, async () => {
  const work = tempHome("ah-80u-");
  const h = await startHub();
  try {
    const { restart, update } = await stopScenario(h, work);
    assert.equal(restart.state, "403", "restart: /state refused");
    assert.deepEqual(restart.peer.plugin, { id: "stop", trusted: false });
    assert.equal(update.state, "403", "update: /state refused");
    assert.deepEqual(update.peer.plugin, { id: "stop", trusted: false });
  } finally {
    await h.stop();
    cleanup(work);
  }
});

test("80: a trusted (test-tier own) plugin keeps its trust through a restart; an instance on its way out (updated) counts as untrusted", { skip: NO_PEERCRED }, async () => {
  const work = tempHome("ah-80t-");
  const h = await startHub({ env: { AGENTHUB_TEST_TIER: "own" } });
  try {
    const { restart, update } = await stopScenario(h, work);
    assert.equal(restart.state, "200");
    assert.deepEqual(restart.peer.plugin, { id: "stop", trusted: true });
    assert.equal(update.state, "403");
    assert.deepEqual(update.peer.plugin, { id: "stop", trusted: false });
  } finally {
    await h.stop();
    cleanup(work);
  }
});

test("80: jobs of a removed instance stay attributed (as untrusted) until they exit; then they are forgotten", async () => {
  const plugins = tempHome("ah-80j-");
  const marks = tempHome("ah-80m-");
  const file = writePlugin(
    plugins,
    "j.sh",
    `#!/bin/sh
# <agenthub.title>Jobs</agenthub.title>
# <agenthub.action id="long" level="immediate" title="Long" background="true">j.sh --action long</agenthub.action>
if [ "$1" = "--action" ]; then trap '' TERM; : > "${marks}/$$"; i=0; while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; exit 0; fi
echo "Jobs | status=ok"; echo "---"; echo "Long | action=long"
`,
  );
  const h = await startHub({ pluginsDir: plugins });
  h.core.jobKillGraceMs = 800;
  try {
    await waitFor(() => h.core.pluginState("j")?.body.length);
    const r = await h.core.invoke({ id: h.core.pluginState("j").body.find((b) => b.title === "Long").offer.id, peer: APP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pid = r.body.result.pid;
    // the job ignores SIGTERM from here on
    await waitFor(() => existsSync(join(marks, String(pid))));
    assert.equal(h.core.facts.pluginByPid(pid, { actions: true })?.trusted, true);
    rmSync(file);
    await h.core.host.rescan();
    assert.equal(h.core.host.get("j"), null, "the plugin is gone");
    const f = h.core.facts.pluginByPid(pid, { actions: true });
    assert.equal(f?.id, "j", "its job being killed is still the plugin's");
    assert.equal(f.trusted, false, "on its way out: untrusted");
    assert.equal(f.action?.id, "long");
    assert.equal(h.core.facts.pluginByPid(pid, { actions: true, group: true })?.id, "j", "its group too");
    await sleep(300);
    assert.equal(h.core.facts.pluginByPid(pid, { actions: true })?.id, "j", "still there while it ignores SIGTERM");
    await waitFor(() => h.core.journal.tail(100).some((e) => e.type === "job-exit"), { timeoutMs: 6000 });
    assert.equal(h.core.facts.pluginByPid(pid, { actions: true, group: true }), null);
    assert.equal(h.core.host.leaving.size, 0, "nothing left");
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(marks);
  }
});

test("80: a connection whose process was gone when it was classified (peer:no-process) gets only /health and /peer", async () => {
  const sys = {
    available: true,
    peerPid: () => 4242,
    peerUid: () => 501,
    pidPath: () => null,
    pidInfo: () => null,
    procArgv: () => null,
    codesignVerify: async () => false,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
  const h = await startHub({ sys });
  try {
    const s = await req(h.sock, "GET", "/state");
    assert.deepEqual([s.status, s.body.error], [403, "peer:no-process"]);
    assert.ok(h.core.journal.tail(50).some((e) => e.type === "denied" && e.error === "peer:no-process" && e.route === "GET /state"));
    assert.equal((await req(h.sock, "GET", "/health")).status, 200);
    const p = await req(h.sock, "GET", "/peer");
    assert.deepEqual([p.status, p.body.reason], [200, "peer:no-process"]);
  } finally {
    await h.stop();
  }
});

// ---------- 81: the *.key linter rule ----------

test("81: *.key flags multi-dot file names again; SF Symbol names in sfimage= and symbol= pass", () => {
  for (const t of [
    'readFileSync("example.com.key")',
    'const k = "tls.server.key";',
    "readFileSync(`${host}.local.key`)",
    'spawn("tool", ["--key-file=my.site.key"])',
    'exec("tool --key-file=my.site.key")',
    "open('wildcard.mydomain.io.key')",
    'readFileSync("server.key")',
    'read("sfimage=x/../server.key")',
  ])
    assert.deepEqual(sourceViolations(t), ["*.key"], t);
  for (const t of ["sfimage=person.badge.key", 'echo "Keys | sfimage=person.badge.key"', "console.log(`Keys | sfimage=person.badge.key color=red`)", "<agenthub.icon symbol=\"lock.rectangle.key\">", "Label(symbol: x, symbol='key.fill.key')"])
    assert.deepEqual(sourceViolations(t), [], t);
  const meta = { title: "t", version: "1.0.0", author: { github: "x" }, platforms: ["macos"], effects: [], actions: [] };
  assert.ok(lintPlugin({ id: "x", meta, source: 'readFileSync("tls.server.key")\n' }).errors.some((e) => e.includes("*.key")));
  assert.ok(!lintPlugin({ id: "x", meta, source: 'echo "Keys | sfimage=person.badge.key"\n' }).errors.some((e) => e.includes("*.key")));
});

// ---------- 82: a stream's process group that has no member left ----------

test("82: a streamable process whose leader exited and whose last group member left (setsid) loses its group id although stdout stays open", { skip: process.platform === "win32" && "POSIX groups" }, async () => {
  const dir = tempHome("ah-82-");
  const holderPid = join(dir, "holder.pid");
  // the leader starts a holder in a new session (detached: setsid) that inherits stdout, prints a frame and exits
  const leader = join(dir, "leader.mjs");
  writeFileSync(
    leader,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
writeFileSync(${JSON.stringify(holderPid)}, String(c.pid));
c.unref();
process.stdout.write("x | status=ok\\n\\x1e");
setTimeout(() => process.exit(0), 100);
`,
  );
  let closed = false;
  const sp = new StreamProcess([process.execPath, leader], { env: { PATH: process.env.PATH }, cwd: dir, onFrame: () => {}, onExit: () => (closed = true) });
  try {
    sp.start();
    const pgid = sp.groupId;
    assert.ok(Number.isInteger(pgid));
    await waitFor(() => readIf(holderPid).trim() && sp.pid === null, { timeoutMs: 5000 });
    await sleep(100);
    assert.equal(closed, false, "stdout is still held: no 'close'");
    assert.equal(groupAlive(pgid), false, "the group is empty");
    assert.equal(sp.groupId, null, "so it is no longer the plugin's group");
  } finally {
    await sp.stop();
    const hp = Number(readIf(holderPid).trim());
    if (hp > 1) {
      try {
        process.kill(hp, "SIGKILL");
      } catch {}
    }
    cleanup(dir);
  }
});

test("82: groupAlive — a live detached child's group is alive; null and pid 1 never are", () => {
  assert.equal(groupAlive(1), false, "never pid 1");
  assert.equal(groupAlive(null), false);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: "ignore" });
  try {
    assert.equal(groupAlive(child.pid), true);
  } finally {
    process.kill(-child.pid, "SIGKILL");
  }
});

// ---------- 83: the throttle notice of a macOnly rule ----------

async function throttled(rule) {
  const sent = [];
  const phone = [];
  const mac = { notify: (m) => (sent.push(m), { notifyId: String(sent.length), done: Promise.resolve({ ok: true }) }) };
  const set = createChannelSet({ mac, configured: [] });
  set.register({ id: "phone", label: "Phone", send: (p) => (phone.push(p), { ok: true }) });
  const t = Date.parse("2026-11-04T14:00:00+01:00");
  const engine = new PushEngine({
    config: resolvePushConfig({ timezone: "Europe/Belgrade" }),
    now: () => t,
    presence: async () => 0,
    mac: set,
    store: memoryStore(),
    journal: () => {},
    lookup: () => ({ pluginTitle: "Mail", itemTitle: "Subject: salary review", trusted: true, rules: [rule] }),
  });
  for (let i = 0; i < 25; i++) await engine.raised({ plugin: "mail", key: `mail:new:${i}` });
  await sleep(50);
  return { mac: sent.filter((m) => m.key === "mail:push-throttled"), phone: phone.filter((p) => p.key === "mail:push-throttled") };
}

test("83: the 'notifications muted' notice of a macOnly rule goes to the Mac only; an ordinary rule's goes to the extra channels too", async () => {
  const only = await throttled({ key: "new", label: "New mail", macOnly: true });
  assert.equal(only.mac.length, 1, "the Mac banner is there");
  assert.equal(only.mac[0].macOnly, true);
  assert.equal(only.phone.length, 0, "nothing on the phone");
  const plain = await throttled({ key: "new", label: "New mail" });
  assert.equal(plain.phone.length, 1);
});

// ---------- 84: forced fresh calls and the job limit ----------

test("84: /http and /mcp — a foreground action is always fresh (even \"fresh\": false); a background job follows the cache unless it asks", async () => {
  const calls = [];
  const c = {
    def: { plugin: "p", hosts: ["api.example.com"] },
    call: async (pl, tool, args, opts) => (calls.push({ kind: "mcp", fresh: opts.fresh }), { status: 200, body: {} }),
    httpRequest: async (pl, body) => (calls.push({ kind: "http", fresh: body.fresh }), { status: 200, body: {} }),
  };
  let who = null;
  const ctx = { facts: { get: () => ({ get: () => c }), pluginByPid: () => who }, journal: { write: () => {} } };
  const route = (p) => connectionRoutes.find((r) => r.path === p).handler;
  const base = { id: "p", trusted: true, net: ["api.example.com — api"] };
  const go = async (pl, path, body) => {
    who = pl;
    calls.length = 0;
    const r = await route(path)({ params: { id: "x" }, body, ctx, peer: { pid: 99 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return calls[0].fresh;
  };
  const action = { ...base, action: { id: "read", net: null } };
  const job = { ...base, action: { id: "poll", net: null, job: true } };
  assert.equal(await go(action, "/connections/:id/http", { path: "/x", fresh: false }), true, "/http: an explicit false is overridden");
  assert.equal(await go(action, "/connections/:id/http", { path: "/x" }), true);
  assert.equal(await go(action, "/connections/:id/mcp", { tool: "t", fresh: false }), true);
  assert.equal(await go(job, "/connections/:id/http", { path: "/x" }), undefined, "a job's read is not forced fresh");
  assert.equal(await go(job, "/connections/:id/http", { path: "/x", fresh: true }), true);
  assert.equal(await go(job, "/connections/:id/mcp", { tool: "t" }), false);
  assert.equal(await go(job, "/connections/:id/mcp", { tool: "t", fresh: true }), true);
  assert.equal(await go(base, "/connections/:id/mcp", { tool: "t" }), false, "a run: the cache");
});

test("84: after a plugin update, jobs of the old instance being killed don't count toward the new instance's limit; a job pid is marked job in the fact", async () => {
  const plugins = tempHome("ah-84-");
  const marks = tempHome("ah-84m-");
  const file = writePlugin(
    plugins,
    "j.sh",
    `#!/bin/sh
# <agenthub.title>Jobs</agenthub.title>
# <agenthub.action id="long" level="immediate" title="Long" background="true">j.sh --action long</agenthub.action>
if [ "$1" = "--action" ]; then trap '' TERM; : > "${marks}/$$"; i=0; while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; exit 0; fi
echo "Jobs | status=ok"; echo "---"; echo "Long | action=long"
`,
  );
  const h = await startHub({ pluginsDir: plugins, overrides: { plugins: { maxJobsPerPlugin: 1 } } });
  h.core.jobKillGraceMs = 3000;
  try {
    await waitFor(() => h.core.pluginState("j")?.body.length);
    const press = () => h.core.invoke({ id: h.core.pluginState("j").body.find((b) => b.title === "Long").offer.id, peer: APP });
    const r = await press();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => existsSync(join(marks, String(r.body.result.pid))));
    assert.equal(h.core.facts.pluginByPid(r.body.result.pid, { actions: true })?.action?.job, true, "a job, not a foreground action");
    assert.deepEqual([(await press()).status, (await press()).body.error], [409, "facts:jobs-limit"], "the limit holds for the live instance");
    appendFileSync(file, "# updated\n");
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("j")?.body.length);
    assert.deepEqual(h.core.pluginState("j").jobs, [], "the new instance lists no job");
    assert.equal(h.core.jobList().length, 1, "the old job is still being killed");
    const again = await press();
    assert.equal(again.status, 200, JSON.stringify(again.body));
    for (const j of h.core.jobList()) h.core.cancelJob(j.id);
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(marks);
  }
});
