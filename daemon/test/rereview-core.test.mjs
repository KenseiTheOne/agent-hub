// Fixes from the core re-review of 2026-11-12 (tracker tasks 63, 64, 65, 67, 68, 71, 73, 75): a plugin's process group stays
// the plugin's until the run ends (63), the confirmation names the row that was pressed (64), an input action bound to a
// row by arg= (65), no phantom job after a plugin update (67), watch fires under constant writes (68), no dead button for a
// link the hub can't open (71), distinguishable job titles (73), job.cancel from cli on a test hub (75).
// System doubles where the peer class matters, temp directories only, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetaText } from "../lib/meta.mjs";
import { defaultSys } from "../lib/peer.mjs";
import * as runner from "../lib/runner.mjs";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = { class: "app", pid: 10 };
const CLI = { class: "cli", pid: 20 };
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overrides = { requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' } };
const sysAs = (state) => ({
  available: true,
  peerPid: () => (state.who === "app" ? 10 : 20),
  peerUid: () => 501,
  pidPath: (pid) => (pid === 10 ? "/Applications/AgentHub.app/Contents/MacOS/AgentHub" : "/usr/bin/curl"),
  pidInfo: (pid) => ({ pid, ppid: 1, uid: 501, startSec: 1, startUsec: 0 }),
  procArgv: () => null,
  codesignVerify: async (p) => p.startsWith("/Applications/AgentHub.app"),
  fileId: (p) => p,
  myUid: () => 501,
  readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
});

// ---------- 63: the process group stays the plugin's until the run ends ----------
// The leader prints its frame and exits at once; a background subshell stays in the run's process group, holds stdout (so the
// run is not over) and calls the hub 0.6 s later — after the leader is gone.
function lateCaller(title, sock, out) {
  return `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.action id="late" level="immediate" title="Late">late.1h.sh --action late</agenthub.action>
S="\${AGENTHUB_HUB_SOCKET:-${sock}}"
O="${out}"
[ "$1" = "--action" ] && O="${out}.action"
if [ ! -e "$O.started" ]; then
  : > "$O.started"
  ( sleep 0.6
    /usr/bin/curl -s -o /dev/null -w '%{http_code}' --unix-socket "$S" http://hub/state > "$O.state.tmp"; mv "$O.state.tmp" "$O.state"
    /usr/bin/curl -s --unix-socket "$S" http://hub/peer > "$O.peer.tmp"; mv "$O.peer.tmp" "$O.peer" ) &
fi
echo "${title} | status=ok"
echo "---"
echo "Late | action=late"
exit 0
`;
}

test("63: a descendant left in the run's process group after the leader exits is still the plugin's (untrusted: 403; trusted: named on /peer)", { skip: !defaultSys().available && "no peercred addon" }, async () => {
  const work = tempHome("ah-63-");
  const h = await startHub({ env: { AGENTHUB_TEST_TIER: "own" } });
  const h2 = await startHub();
  try {
    // an untrusted (local) plugin on a hub without the test tier: the late call is refused like the plugin's own
    const out = join(work, "loc");
    mkdirSync(h2.config.paths.pluginsLocal, { recursive: true });
    writePlugin(h2.config.paths.pluginsLocal, "late.1h.sh", lateCaller("Loc", h2.sock, out));
    await h2.core.host.rescan();
    await waitFor(() => existsSync(`${out}.peer`), { timeoutMs: 10_000 });
    assert.equal(readFileSync(`${out}.state`, "utf8"), "403", "the late /state call is refused");
    assert.deepEqual(JSON.parse(readFileSync(`${out}.peer`, "utf8")).plugin, { id: "late", trusted: false });
    assert.ok(h2.core.journal.tail(200).some((e) => e.type === "denied" && e.plugin === "late" && e.route === "GET /state"));

    // a test-tier (own, trusted) plugin: a late descendant of an action process is still attributed to the plugin
    const tout = join(work, "own");
    mkdirSync(h.config.paths.pluginsLocal, { recursive: true });
    writePlugin(h.config.paths.pluginsLocal, "late.1h.sh", lateCaller("Own", h.sock, tout));
    await h.core.host.rescan();
    await waitFor(() => existsSync(`${tout}.peer`), { timeoutMs: 10_000 });
    assert.deepEqual(JSON.parse(readFileSync(`${tout}.peer`, "utf8")).plugin, { id: "late", trusted: true });
    const offer = h.core.pluginState("late").body.find((b) => b.title === "Late").offer;
    const r = await h.core.invoke({ id: offer.id, peer: APP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => existsSync(`${tout}.action.peer`), { timeoutMs: 10_000 });
    assert.deepEqual(JSON.parse(readFileSync(`${tout}.action.peer`, "utf8")).plugin, { id: "late", trusted: true });
  } finally {
    await h.stop();
    await h2.stop();
    cleanup(work);
  }
});

test("63: the host keeps a run's group id until the run ends, then forgets it; a plain pid lookup still drops the leader at exit", async () => {
  const plugins = tempHome("ah-63g-");
  const data = tempHome("ah-63d-");
  // the run's leader exits at once; a descendant holds stdout for 1 s
  writePlugin(plugins, "g.1h.sh", `#!/bin/sh\n# <agenthub.title>G</agenthub.title>\nif [ ! -e "${data}/started" ]; then echo $$ > "${data}/started"; ( sleep 1 ) & fi\necho "G | status=ok"\n`);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => readIf(join(data, "started")).trim());
    const pgid = Number(readIf(join(data, "started")).trim());
    await sleep(300);
    assert.equal(h.core.facts.pluginByPid(pgid, { actions: true }), null, "the leader's pid alone is no longer the plugin's (B4)");
    assert.equal(h.core.facts.pluginByPid(pgid, { actions: true, group: true })?.id, "g", "its group still is");
    await waitFor(() => h.core.pluginState("g")?.lastRunAt, { timeoutMs: 5000 });
    assert.equal(h.core.facts.pluginByPid(pgid, { actions: true, group: true }), null, "the run ended: the group is forgotten");
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(data);
  }
});

// ---------- 64: the confirmation names the pressed row ----------
const ROWS = `#!/bin/sh
# <agenthub.title>Rows</agenthub.title>
# <agenthub.action id="ask" level="confirm" title="Ask">r.sh --action ask</agenthub.action>
# <agenthub.action id="ok" level="confirm" title="Approve" arg="id:^r[0-9]{1,3}$">r.sh --action ok</agenthub.action>
[ "$1" = "--action" ] && exit 0
echo "Rows | status=ok"
echo "---"
echo "Thread A: harmless question | action=ask"
echo "Thread B: delete the prod database? | action=ask"
echo "Request r7: wipe the cache"
echo "--Approve | action=ok arg=r7"
echo "Plain | action=ok arg=r8"
`;

test("64: the same action on two rows — two offers, each 428 names its own row; a child button named like the action names its parent row", async () => {
  const plugins = tempHome("ah-64-");
  writePlugin(plugins, "r.sh", ROWS);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("r")?.body.length);
    const body = h.core.pluginState("r").body;
    const a = body.find((b) => b.title.startsWith("Thread A")).offer;
    const b = body.find((x) => x.title.startsWith("Thread B")).offer;
    assert.notEqual(a.id, b.id, "two rows with the same action are two offers");
    const ra = await h.core.invoke({ id: a.id, peer: APP });
    const rb = await h.core.invoke({ id: b.id, peer: APP });
    assert.equal(rb.status, 428);
    assert.equal(rb.body.row, "Thread B: delete the prod database?");
    assert.match(rb.body.text, /delete the prod database/);
    assert.doesNotMatch(rb.body.text, /harmless/);
    assert.equal(ra.body.row, "Thread A: harmless question");
    // each token runs only its own offer
    assert.equal((await h.core.invoke({ id: a.id, confirmToken: rb.body.token, peer: APP })).status, 403);
    assert.equal((await h.core.invoke({ id: b.id, confirmToken: (await h.core.invoke({ id: b.id, peer: APP })).body.token, peer: APP })).status, 200);
    // the child button "Approve" only repeats the action's title: the row is its parent's
    const child = body.find((x) => x.title === "Approve").offer;
    const rc = await h.core.invoke({ id: child.id, peer: APP });
    assert.equal(rc.body.row, "Request r7: wipe the cache");
    assert.match(rc.body.text, /wipe the cache/);
    // a top-level row keeps its own text
    const plain = body.find((x) => x.title === "Plain").offer;
    assert.equal((await h.core.invoke({ id: plain.id, peer: APP })).body.row, "Plain");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("64: an offer on a single row keeps the id it had (sha of plugin, action and args) — banners and open windows keep working", async () => {
  const plugins = tempHome("ah-64b-");
  writePlugin(plugins, "r.sh", ROWS.replace('echo "Thread A: harmless question | action=ask"\n', ""));
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("r")?.body.length);
    const id = h.core.pluginState("r").body.find((x) => x.title.startsWith("Thread B")).offer.id;
    await h.core.host.get("r").runStandard("Manual");
    assert.equal(h.core.pluginState("r").body.find((x) => x.title.startsWith("Thread B")).offer.id, id, "stable across frames");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- 65: an input action bound to a row ----------
const REPLY = (dir) => `#!/bin/sh
# <agenthub.title>Threads</agenthub.title>
# <agenthub.action id="reply" level="immediate" title="Reply" arg="thread:^t[0-9]{1,3}$" input="Your reply" inputPattern="^[^<>]{1,200}$">q.sh --action reply {thread}</agenthub.action>
# <agenthub.action id="ask" level="confirm" title="Ask" arg="thread:^t[0-9]{1,3}$" input="Question" inputPattern="^[a-z ]{1,50}$">q.sh --action ask</agenthub.action>
# <agenthub.action id="old" level="immediate" title="Old" arg="text:^[^<>]{1,50}$" input="Text">q.sh --action old</agenthub.action>
if [ "$1" = "--action" ]; then
  printf '%s\\n' "$*" >> "${dir}/argv.log"
  IFS= read -r line; printf '%s\\n' "$line" >> "${dir}/stdin.log"
  exit 0
fi
echo "Threads | status=ok"
echo "---"
echo "Thread t1: lunch? | action=reply arg=t1"
echo "Thread t2: deploy? | action=reply arg=t2"
echo "Ask t2 | action=ask arg=t2"
echo "Bad | action=reply arg=x9"
echo "No arg | action=reply"
echo "Old with arg | action=old arg=hi"
echo "Old | action=old"
`;

test("65: inputPattern= — arg= binds the row (argv), the typed text goes to stdin and is checked against inputPattern", async () => {
  const plugins = tempHome("ah-65-");
  const dir = tempHome("ah-65d-");
  writePlugin(plugins, "q.sh", REPLY(dir));
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("q")?.body.length);
    const st = h.core.pluginState("q");
    const by = (t) => st.body.find((b) => b.title === t)?.offer || null;
    const t1 = by("Thread t1: lunch?");
    const t2 = by("Thread t2: deploy?");
    assert.ok(t1 && t2);
    assert.notEqual(t1.id, t2.id);
    assert.deepEqual(t2.input, { placeholder: "Your reply", maxLength: 256, pattern: "^[^<>]{1,200}$" });
    assert.equal(t2.label, "Reply t2");
    // a row arg that fails the pattern, a missing one, and arg= on a legacy input action: no button, a warning
    assert.equal(by("Bad"), null);
    assert.equal(by("No arg"), null);
    assert.equal(by("Old with arg"), null);
    assert.ok(by("Old"), "a legacy input action (arg= is the text pattern) still works without a row arg");
    const r = await h.core.invoke({ id: t2.id, input: "ship it, then lunch", peer: APP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => readIf(join(dir, "stdin.log")));
    assert.equal(readIf(join(dir, "argv.log")), "--action reply t2\n", "the row arg is in argv, the text is not");
    assert.equal(readIf(join(dir, "stdin.log")), "ship it, then lunch\n");
    // the text is checked against inputPattern, not against the row arg's pattern
    assert.equal((await h.core.invoke({ id: t1.id, input: "<b>", peer: APP })).body.error, "input:pattern");
    assert.equal((await h.core.invoke({ id: t1.id, peer: APP })).body.error, "input:required");
    const act = h.core.journal.tail(50).filter((e) => e.type === "action" && e.actionId === "reply");
    assert.equal(act.at(-1).inputLength, 19);
    assert.ok(!JSON.stringify(h.core.journal.tail(200)).includes("ship it"), "the text is never journaled");
    // a confirm level: the 428 names the bound arg, carries the field with inputPattern; the open token takes the text
    const ask = by("Ask t2");
    const first = await h.core.invoke({ id: ask.id, peer: APP });
    assert.equal(first.status, 428);
    assert.deepEqual(first.body.input, { placeholder: "Question", maxLength: 256, pattern: "^[a-z ]{1,50}$" });
    assert.match(first.body.text, /q\.sh --action ask t2/);
    const done = await h.core.invoke({ id: ask.id, input: "why now", confirmToken: first.body.token, peer: APP });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    await waitFor(() => readIf(join(dir, "argv.log")).includes("ask"));
    assert.match(readIf(join(dir, "argv.log")), /--action ask t2\n$/);
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(dir);
  }
});

test("65: metadata — inputPattern= must be anchored; with it arg= is optional (no row arg) and becomes the row argument", () => {
  const { meta, warnings } = parseMetaText(`
# <agenthub.action id="a" input="x" arg="t:^t[0-9]$" inputPattern="^[a-z]{1,9}$">t.sh a</agenthub.action>
# <agenthub.action id="b" input="x" inputPattern="^[a-z]{1,9}$">t.sh b</agenthub.action>
# <agenthub.action id="c" input="x" inputPattern="[a-z]+">t.sh c</agenthub.action>
# <agenthub.action id="d" inputPattern="^a$" arg="t:^a$">t.sh d</agenthub.action>
`);
  const by = Object.fromEntries(meta.actions.map((a) => [a.id, a]));
  assert.deepEqual(by.a.input, { placeholder: "x", maxLength: 256, pattern: "^[a-z]{1,9}$" });
  assert.deepEqual(by.a.arg, { name: "t", pattern: "^t[0-9]$" });
  assert.deepEqual(by.b.input, { placeholder: "x", maxLength: 256, pattern: "^[a-z]{1,9}$" });
  assert.equal(by.b.arg, undefined);
  assert.equal(by.c, undefined, "an unanchored inputPattern — dropped");
  assert.ok(by.d && !by.d.input, "inputPattern without input= — a warning, the action stays a plain one");
  assert.equal(warnings.length, 2, warnings.join("\n"));
});

// ---------- 67 + 73: background jobs ----------
const JOBS = (dir) => `#!/bin/sh
# <agenthub.title>Jobs</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
# <agenthub.action id="srv" level="immediate" title="Start dev server" arg="name:^[a-z]{1,9}$" background="true">j.sh --action srv</agenthub.action>
# <agenthub.action id="long" level="immediate" title="Long" background="true">j.sh --action long</agenthub.action>
if [ "$1" = "--action" ]; then
  trap 'exit 143' TERM
  i=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; exit 0
fi
echo "Jobs | status=ok"; echo "---"; echo "Web | action=srv arg=web"; echo "Api | action=srv arg=api"; echo "Long | action=long"; echo "~~~"
while IFS= read -r line; do echo "$line" >> "${dir}/stdin.\$\$.log"; done
`;

test("67: after a plugin update the new process is not told about the jobs being killed; /state lists none of them", async () => {
  const plugins = tempHome("ah-67-");
  const dir = tempHome("ah-67d-");
  const file = writePlugin(plugins, "j.sh", JOBS(dir));
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("j")?.body.length);
    const offer = h.core.pluginState("j").body.find((b) => b.title === "Long").offer;
    const r = await h.core.invoke({ id: offer.id, peer: APP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await waitFor(() => h.core.pluginState("j").jobs.length === 1);
    const firstPid = h.core.pluginState("j").pid;
    appendFileSync(file, "# updated\n");
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("j")?.pid && h.core.pluginState("j").pid !== firstPid, { timeoutMs: 5000 });
    await waitFor(() => readIf(join(dir, `stdin.${h.core.pluginState("j").pid}.log`)).includes('"jobs"'), { timeoutMs: 5000 });
    const msgs = readIf(join(dir, `stdin.${h.core.pluginState("j").pid}.log`)).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(msgs.find((m) => m.type === "jobs").running, [], "the job being killed is not the new process's");
    assert.deepEqual(h.core.pluginState("j").jobs, []);
    // the old job does end (journaled), and nothing about it reaches the new process
    await waitFor(() => h.core.journal.tail(100).some((e) => e.type === "job-exit" && e.cancelled === "plugin-restarted"), { timeoutMs: 6000 });
    await sleep(200);
    assert.deepEqual(h.core.pluginState("j").jobs, []);
    assert.equal(h.core.jobList().length, 0);
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(dir);
  }
});

test("73: jobs of one action carry their arg in the title; the same title twice gets the start time", async () => {
  const plugins = tempHome("ah-73-");
  const dir = tempHome("ah-73d-");
  writePlugin(plugins, "j.sh", JOBS(dir));
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("j")?.body.length);
    const offer = (t) => h.core.pluginState("j").body.find((b) => b.title === t).offer;
    for (const t of ["Web", "Api", "Long", "Long"]) assert.equal((await h.core.invoke({ id: offer(t).id, peer: APP })).status, 200);
    await waitFor(() => h.core.pluginState("j").jobs.length === 4);
    const titles = h.core.pluginState("j").jobs.map((j) => j.title);
    assert.ok(titles.includes("Start dev server web") && titles.includes("Start dev server api"), titles.join(" / "));
    const longs = titles.filter((t) => t.startsWith("Long"));
    assert.equal(longs.length, 2);
    assert.equal(new Set(titles).size, 4, `distinguishable: ${titles.join(" / ")}`);
    assert.match(longs[1], /^Long \(\d{2}:\d{2}:\d{2}\)$/);
    for (const j of h.core.jobList()) h.core.cancelJob(j.id);
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(dir);
  }
});

// ---------- 75: job.cancel from cli on a test hub ----------
test("75: on a test hub cli may press job.cancel for a test-tier plugin's job; not for other jobs, not on a hub without the test tier", async () => {
  const dir = tempHome("ah-75d-");
  const builtin = tempHome("ah-75b-");
  writePlugin(builtin, "j.sh", JOBS(dir));
  for (const tier of ["own", null]) {
    const h = await startHub({ pluginsDir: builtin, overrides, sys: sysAs({ who: "cli" }), env: tier ? { AGENTHUB_TEST_TIER: tier } : {} });
    try {
      mkdirSync(h.config.paths.pluginsLocal, { recursive: true });
      writePlugin(h.config.paths.pluginsLocal, "loc.sh", JOBS(dir).replace("<agenthub.title>Jobs", "<agenthub.title>Loc").replaceAll("j.sh", "loc.sh"));
      await h.core.host.rescan();
      await waitFor(() => h.core.pluginState("j")?.body.length);
      const bj = await h.core.invoke({ id: h.core.pluginState("j").body.find((b) => b.title === "Long").offer.id, peer: APP });
      assert.equal(bj.status, 200);
      if (tier) {
        await waitFor(() => h.core.pluginState("loc")?.body.length);
        const lj = await h.core.invoke({ id: h.core.pluginState("loc").body.find((b) => b.title === "Long").offer.id, peer: CLI });
        assert.equal(lj.status, 200, JSON.stringify(lj.body));
        const c = await h.core.invoke({ id: "job.cancel", args: { job: lj.body.result.job }, peer: CLI });
        assert.equal(c.status, 200, JSON.stringify(c.body));
        await waitFor(() => !h.core.jobList().some((j) => j.id === lj.body.result.job), { timeoutMs: 5000 });
      }
      // a builtin plugin's job: app only, test hub or not
      const d = await h.core.invoke({ id: "job.cancel", args: { job: bj.body.result.job }, peer: CLI });
      assert.equal(d.status, 403, JSON.stringify(d.body));
      assert.equal((await h.core.invoke({ id: "job.cancel", args: { job: "0123456789abcdef" }, peer: CLI })).status, 403, "an unknown job: the peer check comes first");
      assert.equal((await h.core.invoke({ id: "job.cancel", args: { job: bj.body.result.job }, peer: APP })).status, 200);
    } finally {
      for (const j of h.core.jobList()) h.core.cancelJob(j.id);
      await h.stop();
    }
  }
  cleanup(dir);
  cleanup(builtin);
});

// ---------- 68: watch under constant writes ----------
test("68: a watched file written every 100 ms still fires at least every maxWaitMs; a single write — once after the debounce", async () => {
  assert.equal(runner.WATCH_MAX_WAIT_MS, 2000);
  const dir = tempHome("ah-68-");
  const log = join(dir, "dev.log");
  writeFileSync(log, "");
  const calls = [];
  const w = new runner.Watcher([join(dir, "*.log")], (paths) => calls.push({ at: Date.now(), paths }), { debounceMs: 300, maxWaitMs: 800 });
  w.start();
  try {
    await sleep(100);
    const start = Date.now();
    while (Date.now() - start < 2600) {
      appendFileSync(log, "line\n");
      await sleep(100);
    }
    const during = calls.filter((c) => c.at - start < 2600);
    assert.ok(during.length >= 2, `fired ${during.length} times while writes went on`);
    assert.ok(during.every((c) => c.paths.includes(log)));
    await sleep(500);
    const n = calls.length;
    appendFileSync(log, "one\n");
    await sleep(500);
    assert.equal(calls.length, n + 1, "a lone write: one call");
  } finally {
    w.close();
    cleanup(dir);
  }
});

// ---------- 71: a link the hub can't open gets no button ----------
const LINKS = `#!/bin/sh
# <agenthub.title>Links</agenthub.title>
# <agenthub.effects>open.url</agenthub.effects>
echo "Links | status=ok"
echo "---"
echo "Mail | href=message://%3cid@mail.example%3e"
echo "Mail 2 | effect=\\"open.url message://x\\""
echo "Creds | href=https://user:pw@example.com/"
echo "Web | href=https://example.com/a"
`;

test("71: href= / effect=open.url with a scheme the hub won't open is refused at parse time with a warning — no dead button", async () => {
  const plugins = tempHome("ah-71-");
  writePlugin(plugins, "l.sh", LINKS);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("l")?.body.length);
    const by = (t) => h.core.pluginState("l").body.find((b) => b.title === t);
    assert.equal(by("Mail").offer, undefined);
    assert.equal(by("Mail 2").offer, undefined);
    assert.equal(by("Creds").offer, undefined);
    assert.equal(by("Web").offer.primitive, "open.url");
    const w = h.core.journal.tail(200).filter((e) => e.type === "warning" && e.plugin === "l").map((e) => e.detail);
    // one text for both message:// rows: the journal keeps a repeated warning once
    assert.equal(w.filter((d) => d.startsWith("open.url") && d.includes("(scheme)")).length, 1, JSON.stringify(w));
    assert.ok(w.some((d) => d.includes("(credentials-in-url)")), JSON.stringify(w));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});
