// Core gaps from the 2026-11-12 review (third-party plugin prototypes): human input for actions (G1), net="none" (G2),
// community actions and push rules (G3), background jobs (G6), a fresh environment on stream restarts (G8), coalescing
// plugin events (G9), the row in the confirmation text (G10), the test tier (G15), arg in actionResult and the stopping
// notice (G18). System doubles, temp directories only, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { actionLevel, communityPushRules, shownCommand } from "../lib/core.mjs";
import { testTierOf } from "../lib/config.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { lintPlugin, permissionList, permissionsFromMeta } from "../lib/registry/perms.mjs";
import { actionArgv, StreamProcess } from "../lib/runner.mjs";
import { PushEngine } from "../lib/push/engine.mjs";
import { resolvePushConfig } from "../lib/push/config.mjs";
import { memoryStore } from "../lib/push/store.mjs";
import { denyReason } from "../lib/services/secrets.mjs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = { class: "app", pid: 10 };
const CLI = { class: "cli", pid: 20 };
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// ---------- metadata ----------
test("metadata: input= with arg=, maxLength, input-xx; net=none; background; bad values are warnings", () => {
  const { meta, warnings } = parseMetaText(`
# <agenthub.action id="note" level="confirm" input="Note text" input-ru="Текст заметки" maxLength="500" arg="text:^[^\\n]{1,500}$">t.sh --action note {text}</agenthub.action>
# <agenthub.action id="noarg" input="x">t.sh --action noarg</agenthub.action>
# <agenthub.action id="badlen" input="x" maxLength="99999" arg="t:^a$">t.sh</agenthub.action>
# <agenthub.action id="local" level="immediate" net="none">t.sh --action local</agenthub.action>
# <agenthub.action id="netx" net="some">t.sh --action netx</agenthub.action>
# <agenthub.action id="job" background="true">t.sh --action job</agenthub.action>
# <agenthub.action id="jobx" background="yes">t.sh --action jobx</agenthub.action>
`);
  const by = Object.fromEntries(meta.actions.map((a) => [a.id, a]));
  assert.deepEqual(by.note.input, { placeholder: "Note text", maxLength: 500 });
  assert.equal(by.note.i18n.ru.input, "Текст заметки");
  assert.equal(by.noarg, undefined, "input without arg — dropped");
  assert.equal(by.badlen, undefined, "maxLength out of range — dropped");
  assert.equal(by.local.net, "none");
  assert.equal(by.netx.net, undefined, "an unknown net value is ignored (the floor stays)");
  assert.equal(by.job.background, true);
  assert.equal(by.jobx.background, undefined);
  assert.equal(warnings.length, 4, warnings.join("\n"));
});

test("argv of an input action never carries the text: the {name} word is dropped; the confirmation shows the static command", () => {
  const arg = { name: "text", pattern: "^.+$" };
  assert.deepEqual(actionArgv("t.sh --action note {text} --x", arg, null, { input: true }), ["t.sh", "--action", "note", "--x"]);
  assert.deepEqual(actionArgv("t.sh --action note", arg, null, { input: true }), ["t.sh", "--action", "note"]);
  assert.equal(shownCommand("t.sh --action note {text}", arg, "", { input: true }), "t.sh --action note");
});

// ---------- G2: net="none" ----------
test('net="none": lifts the confirm-cost floor of <agenthub.net> for that action only; cost= still counts', () => {
  const offi = { source: "installed", meta: { net: ["api.example.com — data"] }, granted: { official: true } };
  assert.equal(actionLevel(offi, { level: "immediate" }), "confirm-cost");
  assert.equal(actionLevel(offi, { level: "immediate", net: "none" }), "immediate");
  assert.equal(actionLevel(offi, { level: "immediate", net: "none", cost: "quota" }), "confirm-cost");
  const community = { source: "installed", meta: { net: ["api.example.com — data"] }, granted: {} };
  assert.equal(actionLevel(community, { level: "immediate", net: "none" }), "confirm", "community: the confirm floor stays");
  // linter: immediate + net is accepted with net="none" (a warning for the reviewer); the permission key carries it
  const base = { title: "T", version: "1.0.0", author: { github: "x" }, platforms: ["macos"], effects: [], net: ["api.example.com — data"] };
  const bad = lintPlugin({ id: "p", meta: { ...base, actions: [{ id: "a", level: "immediate", command: "p.sh a" }] }, official: true });
  assert.ok(bad.errors.some((e) => e.includes('id="a"')));
  const ok = lintPlugin({ id: "p", meta: { ...base, actions: [{ id: "a", level: "immediate", command: "p.sh a", net: "none" }] }, official: true });
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.warnings.some((w) => w.includes('net="none"')));
  const keys = permissionList(permissionsFromMeta({ ...base, actions: [{ id: "a", level: "immediate", command: "p.sh a", net: "none" }, { id: "b", level: "confirm", command: "p.sh b" }] })).filter((x) => x.kind === "actions").map((x) => x.key);
  assert.deepEqual(keys, ["actions:a [immediate] p.sh a net=none", "actions:b [confirm] p.sh b"]);
});

// ---------- G3: community ----------
test("linter: community actions are accepted (warnings), immediate is raised; community push rules — only kind=plugin, label only", () => {
  const meta = {
    title: "T",
    version: "1.0.0",
    author: { github: "x" },
    platforms: ["macos"],
    effects: [],
    actions: [{ id: "a", level: "immediate", command: "p.sh a" }],
    push: [
      { key: "done", label: "Done", kind: "plugin" },
      { key: "loud", label: "Loud", kind: "plugin", quietException: true },
      { key: "sec", label: "Sec", kind: "security" },
    ],
  };
  const r = lintPlugin({ id: "p", meta, official: false });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes("immediate")));
  assert.ok(r.warnings.some((w) => w.includes('key="loud"')));
  assert.ok(r.warnings.some((w) => w.includes('key="sec"')));
  assert.deepEqual(communityPushRules([...meta.push, { key: "old", label: "Old", kind: "plugin", legacyKind: "runs", hold: "evening", cooldownMs: 0, awayDelayMs: 1 }]), [
    { key: "done", label: "Done", kind: "plugin", community: true },
    { key: "loud", label: "Loud", kind: "plugin", community: true },
    { key: "old", label: "Old", kind: "plugin", legacyKind: "runs", community: true },
  ]);
});

test("push engine: a community plugin's reviewed rule gives its label and the row text, kind plugin, untrusted limits, no quiet exception", async () => {
  const sent = [];
  const t0 = Date.parse("2026-11-05T02:00:00+01:00"); // quiet hours, the person is away
  const engine = new PushEngine({
    config: resolvePushConfig({ timezone: "Europe/Belgrade" }),
    now: () => t0,
    presence: async () => 60 * 60_000,
    mac: { notify: (m) => (sent.push(m), { notifyId: "1", done: Promise.resolve({ ok: true }) }) },
    lookup: (plugin, bare) => ({ pluginTitle: "Builds", itemTitle: `Build ${bare} failed`, trusted: false, rules: communityPushRules([{ key: "build", label: "Build failed", kind: "plugin", quietException: true }]) }),
    store: memoryStore(),
    journal: () => {},
  });
  await engine.raised({ plugin: "builds", key: "builds:build:42" });
  assert.equal(sent.length, 0, "no quiet-hours exception for community: deferred to the digest");
  assert.equal(engine.digest.length, 1);
  assert.match(engine.digest[0].body, /Build build:42 failed/);
  assert.equal(engine.digest[0].kind, "plugin");
  const rule = engine.ruleFor("build:42", false, communityPushRules([{ key: "build", label: "Build failed", kind: "plugin" }]), "builds");
  assert.equal(rule.label, "Build failed");
  assert.equal(rule.quietException, undefined);
  // an unknown key of the same community plugin — as before: no text
  assert.equal(engine.ruleFor("other", false, communityPushRules([{ key: "build", label: "x", kind: "plugin" }]), "builds").name, "untrusted");
});

// A hub with app/cli doubles: who — the class of the next socket connection; tests mostly call core.invoke directly.
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
const overrides = { requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' } };

const COMMUNITY = `#!/bin/sh
# <agenthub.title>Builds</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.net>ci.example.com — build status</agenthub.net>
# <agenthub.action id="retry" level="immediate" title="Retry">builds.1h.sh --action retry</agenthub.action>
# <agenthub.action id="clear" level="immediate" net="none" title="Clear">builds.1h.sh --action clear</agenthub.action>
# <agenthub.push key="build" kind="plugin" quiet="true">Build failed</agenthub.push>
# <agenthub.push key="sec" kind="security">Security</agenthub.push>
[ "$1" = "--action" ] && exit 0
echo "Builds | status=ok"
echo "---"
printf 'Release \\033[31mbuild\\033[0m 42 | action=retry event=build:42\\n'
echo "Clear cache | action=clear"
`;

test("community plugin: actions at confirm (net=none lifts confirm-cost), app only; push rules sanitized; own switch in Settings; the 428 quotes the row", async () => {
  const state = { who: "app" };
  const h = await startHub({ overrides, sys: sysAs(state) });
  try {
    h.core.setPluginPolicy(async () => ({ allowed: true, effects: [] }));
    mkdirSync(join(h.config.paths.plugins, "builds"), { recursive: true });
    writePlugin(join(h.config.paths.plugins, "builds"), "builds.1h.sh", COMMUNITY);
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("builds")?.body.length);
    const st = h.core.pluginState("builds");
    assert.equal(st.tier, "community");
    assert.equal(st.trusted, false);
    assert.deepEqual(st.actions.map((a) => [a.id, a.level, a.net ?? null]), [["retry", "confirm-cost", null], ["clear", "confirm", "none"]]);
    assert.deepEqual(st.pushRules.map((r) => [r.key, r.kind, r.quietException ?? null]), [["build", "plugin", null]]);
    const info = h.core.pluginEventInfo("builds", "build:42");
    assert.equal(info.trusted, false);
    assert.equal(info.pushRules.length, 1);
    assert.match(info.itemTitle, /Release/);
    assert.ok(h.core.notificationsSetting().plugins.some((p) => p.id === "builds" && p.labels.includes("Build failed")));
    const retry = st.body[0].offer;
    assert.equal(retry.appOnly, true);
    assert.equal((await h.core.invoke({ id: retry.id, peer: CLI })).status, 403);
    const first = await h.core.invoke({ id: retry.id, peer: APP });
    assert.equal(first.status, 428);
    // G10: the row is quoted, control characters stripped
    assert.equal(first.body.row, "Release [31mbuild [0m 42");
    assert.match(first.body.text, /Release \[31mbuild \[0m 42/);
    assert.match(first.body.cost, /ci\.example\.com/);
    const done = await h.core.invoke({ id: retry.id, confirmToken: first.body.token, peer: APP });
    assert.equal(done.status, 200);
    assert.equal(done.body.ok, true);
    const clear = await h.core.invoke({ id: st.body[1].offer.id, peer: APP });
    assert.equal(clear.status, 428);
    assert.equal(clear.body.level, "confirm");
    assert.equal(clear.body.cost, null, "net=none: no network cost line");
  } finally {
    await h.stop();
  }
});

// ---------- G1: input ----------
const NOTE = `#!/bin/sh
# <agenthub.title>Notes</agenthub.title>
# <agenthub.action id="note" level="immediate" title="Note" input="Note text" input-en="Note text" input-ru="Текст заметки" maxLength="40" arg="text:^[A-Za-z0-9 .,!?]{1,40}$">notes.1h.sh --action note {text}</agenthub.action>
# <agenthub.action id="ask" level="confirm" title="Ask" input="Question" arg="q:^[A-Za-z0-9 ?]{1,40}$">notes.1h.sh --action ask</agenthub.action>
# <agenthub.action id="plain" level="immediate" title="Plain">notes.1h.sh --action plain</agenthub.action>
D="$AGENTHUB_PLUGIN_DATA_PATH"
if [ "$1" = "--action" ]; then
  cat > "$D/$2.stdin"
  echo "$#" > "$D/$2.argc"
  exit 0
fi
echo "Notes | status=ok"
echo "---"
echo "Write | action=note"
echo "Ask | action=ask"
echo "Plain | action=plain"
echo "Bad | action=note arg=hello"
`;

test("input action: the field in /state, app only, validated, the text on stdin (not argv), the journal has only the length", async () => {
  const plugins = tempHome("ah-in-");
  writePlugin(plugins, "notes.1h.sh", NOTE);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "app" }) });
  try {
    await waitFor(() => h.core.pluginState("notes")?.body.length);
    const st = h.core.pluginState("notes");
    const data = join(h.config.paths.pluginData, "notes");
    assert.deepEqual(st.actions.find((a) => a.id === "note").input, { placeholder: "Текст заметки", maxLength: 40 }, "placeholder in the hub language (ru on a test hub)");
    const note = st.body.find((b) => b.title === "Write").offer;
    assert.deepEqual(note.input, { placeholder: "Текст заметки", maxLength: 40, pattern: "^[A-Za-z0-9 .,!?]{1,40}$" });
    assert.equal(note.appOnly, true, "an input action is app only even for a built-in plugin");
    assert.equal(st.body.find((b) => b.title === "Bad").offer, undefined, "arg= on an input action line is refused");
    assert.equal((await h.core.invoke({ id: note.id, input: "hi", peer: CLI })).status, 403);
    for (const [input, err] of [[undefined, "input:required"], ["", "input:required"], ["-rf", "input:option-like"], ["a\nb", "input:control"], ["x".repeat(41), "input:too-long"], ["<b>", "input:pattern"]]) {
      const r = await h.core.invoke({ id: note.id, input, peer: APP });
      assert.deepEqual([r.status, r.body.error], [400, err], JSON.stringify(input));
    }
    const ok = await h.core.invoke({ id: note.id, input: "Buy milk, 2 l!", peer: APP });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
    assert.equal(readFileSync(join(data, "note.stdin"), "utf8"), "Buy milk, 2 l!\n");
    assert.equal(readFileSync(join(data, "note.argc"), "utf8").trim(), "2", "argv: --action note, without the text");
    const j = h.core.journal.tail(100).find((e) => e.type === "action" && e.actionId === "note");
    assert.equal(j.inputLength, 14);
    assert.ok(!JSON.stringify(h.core.journal.tail(200)).includes("Buy milk"), "the text never reaches the journal");
    // over the socket: POST /actions/:id {"input": …} (the peer is the app double)
    const viaSocket = await req(h.sock, "POST", `/actions/${note.id}`, { input: "Via socket" });
    assert.equal(viaSocket.status, 200, JSON.stringify(viaSocket.body));
    assert.equal(readFileSync(join(data, "note.stdin"), "utf8"), "Via socket\n");
    // a body input for an action without a field is ignored, as before
    const plain = st.body.find((b) => b.title === "Plain").offer;
    assert.equal((await h.core.invoke({ id: plain.id, input: "zzz", peer: CLI })).status, 200);
    assert.equal(readFileSync(join(data, "plain.stdin"), "utf8"), "");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("input action at confirm: the text may be typed in the confirmation sheet (open token) or sent first (bound token)", async () => {
  const plugins = tempHome("ah-in2-");
  writePlugin(plugins, "notes.1h.sh", NOTE);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "app" }) });
  try {
    await waitFor(() => h.core.pluginState("notes")?.body.length);
    const ask = h.core.pluginState("notes").body.find((b) => b.title === "Ask").offer;
    const data = join(h.config.paths.pluginData, "notes");
    // without the text: 428 with the field, the token takes any valid text
    const open = await h.core.invoke({ id: ask.id, peer: APP });
    assert.equal(open.status, 428);
    assert.deepEqual(open.body.input, { placeholder: "Question", maxLength: 256, pattern: "^[A-Za-z0-9 ?]{1,40}$" });
    assert.match(open.body.text, /вводится в этом окне/);
    assert.equal((await h.core.invoke({ id: ask.id, confirmToken: open.body.token, peer: APP })).body.error, "input:required");
    const open2 = await h.core.invoke({ id: ask.id, peer: APP });
    const r = await h.core.invoke({ id: ask.id, input: "Why not", confirmToken: open2.body.token, peer: APP });
    assert.equal(r.status, 200);
    assert.equal(readFileSync(join(data, "ask.stdin"), "utf8"), "Why not\n");
    // with the text: the 428 quotes it, and the token is bound to it
    const bound = await h.core.invoke({ id: ask.id, input: "First", peer: APP });
    assert.equal(bound.status, 428);
    assert.match(bound.body.text, /«First»/);
    assert.equal(bound.body.input, undefined);
    assert.equal((await h.core.invoke({ id: ask.id, input: "Other", confirmToken: bound.body.token, peer: APP })).status, 403);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- G6, G8, G18: streamable with jobs ----------
const STREAM = `#!/bin/sh
# <agenthub.title>Stream</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
# <agenthub.secrets>s.token — test</agenthub.secrets>
# <agenthub.action id="job" level="immediate" title="Long job" background="true">s.sh --action job</agenthub.action>
# <agenthub.action id="quick" level="immediate" title="Quick job" background="true">s.sh --action quick</agenthub.action>
# <agenthub.action id="go" level="immediate" arg="n:^[0-9]{1,3}$">s.sh --action go {n}</agenthub.action>
D="$AGENTHUB_PLUGIN_DATA_PATH"
if [ "$1" = "--action" ]; then
  case "$2" in
    job) trap 'echo term >> "$D/job.log"; exit 143' TERM; echo start >> "$D/job.log"; i=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done; exit 0 ;;
    quick) sleep 0.2; echo "message=finished"; exit 0 ;;
    go) exit 0 ;;
  esac
fi
echo "start $AGENTHUB_REFRESH_REASON tok=$AGENTHUB_SECRET_S_TOKEN" >> "$D/starts.log"
echo "S | status=ok"; echo "---"; echo "Job | action=job"; echo "Quick | action=quick"; echo "Go 5 | action=go arg=5"; echo "~~~"
while IFS= read -r line; do echo "$line" >> "$D/stdin.log"; done
`;

async function streamHub(extra = {}) {
  const plugins = tempHome("ah-st-");
  writePlugin(plugins, "s.sh", STREAM);
  const token = { v: "one" };
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "app" }), ...extra });
  h.core.setSecretsProvider(async () => token.v);
  h.token = token;
  h.plugins = plugins;
  h.data = join(h.config.paths.pluginData, "s");
  h.offer = (title) => h.core.pluginState("s").body.find((b) => b.title === title).offer;
  h.stdinLog = () => readIf(join(h.data, "stdin.log")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  await waitFor(() => h.core.pluginState("s")?.body.length);
  return h;
}

test("background job: own process, listed in plugins[].jobs and runningActions, survives a stream restart, jobExit on stdin, cancel via job.cancel", async () => {
  const h = await streamHub();
  try {
    const events = [];
    h.core.on("event", (e) => e.type.startsWith("job.") && events.push(e));
    const r = await h.core.invoke({ id: h.offer("Job").id, peer: APP });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const jobId = r.body.result.job;
    assert.match(jobId, /^[0-9a-f]{16}$/);
    assert.ok(Number.isInteger(r.body.result.pid));
    const jobs = h.core.pluginState("s").jobs;
    assert.deepEqual(jobs.map((j) => [j.id, j.actionId, j.title]), [[jobId, "job", "Long job"]]);
    assert.ok(h.core.facts.runningActions().some((a) => a.job === jobId && a.background === true));
    await waitFor(() => readIf(join(h.data, "job.log")).includes("start"));
    // the action result goes to the stream at once, with the job id
    await waitFor(() => h.stdinLog().some((m) => m.type === "actionResult" && m.job === jobId));
    // a stream restart (language, pause, secret) does not touch the job
    h.token.v = "two";
    assert.equal(await h.core.restartPlugin("s", "SecretChanged"), true);
    await waitFor(() => readIf(join(h.data, "starts.log")).includes("start SecretChanged tok=two"));
    assert.ok(h.stdinLog().some((m) => m.type === "stopping" && m.reason === "restart" && m.cause === "SecretChanged"), "the plugin was told why it stops");
    assert.equal(h.core.pluginState("s").jobs.length, 1, "the job survived the restart");
    assert.ok(!readIf(join(h.data, "job.log")).includes("term"));
    // cancel: app only, the job gets SIGTERM; the plugin hears jobExit
    assert.equal((await h.core.invoke({ id: "job.cancel", args: { job: jobId }, peer: CLI })).status, 403);
    const c = await h.core.invoke({ id: "job.cancel", args: { job: jobId }, peer: APP });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await waitFor(() => h.stdinLog().some((m) => m.type === "jobExit" && m.job === jobId));
    const exit = h.stdinLog().find((m) => m.type === "jobExit");
    assert.equal(exit.cancelled, "cancelled");
    assert.equal(exit.ok, false);
    assert.ok(readIf(join(h.data, "job.log")).includes("term"));
    assert.deepEqual(h.core.pluginState("s").jobs, []);
    assert.deepEqual(events.map((e) => e.type), ["job.started", "job.exited"]);
    const j = h.core.journal.tail(200);
    assert.ok(j.some((e) => e.type === "job-start" && e.job === jobId));
    assert.ok(j.some((e) => e.type === "job-exit" && e.job === jobId && e.cancelled === "cancelled"));
    assert.ok(j.some((e) => e.type === "action" && e.job === jobId && e.background === true));
    assert.equal((await h.core.invoke({ id: "job.cancel", args: { job: jobId }, peer: APP })).body.error, "facts:no-job");
  } finally {
    await h.stop();
    cleanup(h.plugins);
  }
});

test("background job: ends by itself → jobExit with message; at most maxJobsPerPlugin at once; removing the plugin kills its jobs", async () => {
  const h = await streamHub({ overrides: { ...overrides, plugins: { maxJobsPerPlugin: 2 } } });
  try {
    const q = await h.core.invoke({ id: h.offer("Quick").id, peer: APP });
    await waitFor(() => h.stdinLog().some((m) => m.type === "jobExit" && m.job === q.body.result.job));
    const exit = h.stdinLog().find((m) => m.type === "jobExit");
    assert.deepEqual([exit.ok, exit.code, exit.message, exit.actionId], [true, 0, "finished", "quick"]);
    const a = await h.core.invoke({ id: h.offer("Job").id, peer: APP });
    const b = await h.core.invoke({ id: h.offer("Job").id, peer: APP });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const c = await h.core.invoke({ id: h.offer("Job").id, peer: APP });
    assert.deepEqual([c.status, c.body.error], [409, "facts:jobs-limit"]);
    const pids = h.core.jobList().map((j) => j.pid);
    // the plugin file disappears: the plugin is removed, its jobs are stopped
    rmSync(join(h.plugins, "s.sh"));
    await h.core.host.rescan();
    await waitFor(() => h.core.jobList().length === 0, 5000);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), "the job process is gone");
    assert.ok(h.core.journal.tail(200).some((e) => e.type === "job-exit" && e.cancelled === "plugin-removed"));
  } finally {
    await h.stop();
    cleanup(h.plugins);
  }
});

test("pause stops background jobs; actionResult carries arg; the daemon stopping kills a job", async () => {
  const h = await streamHub();
  try {
    await h.core.invoke({ id: h.offer("Go 5").id, peer: APP });
    await waitFor(() => h.stdinLog().some((m) => m.type === "actionResult" && m.actionId === "go"));
    assert.equal(h.stdinLog().find((m) => m.actionId === "go").arg, "5");
    const r = await h.core.invoke({ id: h.offer("Job").id, peer: APP });
    await waitFor(() => readIf(join(h.data, "job.log")).includes("start"));
    h.core.setEstop(true, APP);
    await waitFor(() => h.core.jobList().length === 0, 5000);
    assert.ok(h.core.journal.tail(200).some((e) => e.type === "job-exit" && e.job === r.body.result.job && e.cancelled === "paused"));
    h.core.setEstop(false, APP);
    await waitFor(() => h.stdinLog().length && h.core.pluginState("s")?.pid);
  } finally {
    await h.stop();
    cleanup(h.plugins);
  }
});

test("StreamProcess: an automatic restart after an exit builds the environment again; stop(reason) sends stopping before SIGTERM", async () => {
  const dir = tempHome("ah-sp-");
  try {
    const script = writePlugin(dir, "p.sh", `#!/bin/sh\necho "env $X" >> "${dir}/log"\necho "A"\necho "~~~"\nwhile IFS= read -r l; do echo "$l" >> "${dir}/in"; [ -f "${dir}/die" ] && exit 1; done\n`);
    let n = 0;
    const sp = new StreamProcess(["/bin/sh", script], { env: { PATH: "/usr/bin:/bin", X: "first" }, envFn: async () => ({ PATH: "/usr/bin:/bin", X: `fresh${++n}` }), cwd: dir, onFrame: () => {} });
    sp.start();
    await waitFor(() => readIf(join(dir, "log")).includes("env first"));
    // the process exits: the restart (after the 1 s backoff) takes the new environment
    writePlugin(dir, "die", "");
    sp.write({ type: "x" });
    await waitFor(() => readIf(join(dir, "log")).includes("env fresh1"), 5000);
    rmSync(join(dir, "die"));
    await sp.stop("removed");
    assert.match(readIf(join(dir, "in")), /\{"type":"stopping","reason":"removed"\}/);
  } finally {
    cleanup(dir);
  }
});

// ---------- G9: coalescing ----------
test("plugin events: at most one per 250 ms per plugin, the latest state arrives; the frame after an action goes out at once", async () => {
  const plugins = tempHome("ah-co-");
  writePlugin(plugins, "c.1h.sh", `#!/bin/sh\n# <agenthub.action id="go" level="immediate">/usr/bin/true</agenthub.action>\necho "C | status=ok"\necho "---"\necho "Go | action=go"\n`);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "app" }) });
  try {
    await waitFor(() => h.core.pluginState("c")?.body.length);
    // the first frames (add + first run) may still have a trailing event pending: let it go and the interval pass
    await new Promise((r) => setTimeout(r, 700));
    const seen = [];
    h.core.on("plugin", (e) => e.plugin.id === "c" && seen.push({ at: Date.now(), title: e.plugin.header[0]?.title }));
    for (let i = 0; i < 50; i++) h.core.applyFrame("c", `F${i} | status=ok\n---\nGo | action=go`);
    assert.equal(seen.length, 1, "the first change after a quiet period goes out at once");
    assert.equal(seen[0].title, "F0");
    await waitFor(() => seen.length === 2, 2000);
    assert.equal(seen[1].title, "F49", "the trailing event carries the latest state");
    assert.ok(seen[1].at - seen[0].at >= 200);
    // an action: the plugin's next frame is not held back by the interval
    const offer = h.core.pluginState("c").body[0].offer;
    const t0 = Date.now();
    const r = await h.core.invoke({ id: offer.id, peer: CLI });
    assert.equal(r.status, 200);
    h.core.applyFrame("c", `After | status=ok\n---\nGo | action=go`);
    assert.equal(seen.at(-1).title, "After");
    assert.ok(seen.at(-1).at - t0 < 1000);
    const before = seen.length;
    h.core.applyFrame("c", `After2 | status=ok`);
    assert.equal(seen.length, before, "only the first frame after the action skips the interval");
    // a quiet period → at once again (the unchanged state is not sent at all)
    await new Promise((r) => setTimeout(r, 300));
    const n = seen.length;
    h.core.applyFrame("c", `After2 | status=ok`);
    assert.equal(seen.length, n);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- G15: test tier ----------
test("AGENTHUB_TEST_TIER=own: only with a non-default AGENTHUB_HOME; a local plugin gets own, cli may press its actions", async () => {
  assert.equal(testTierOf({ AGENTHUB_TEST_TIER: "own" }), null, "no AGENTHUB_HOME — the live hub");
  assert.equal(testTierOf({ AGENTHUB_TEST_TIER: "official", AGENTHUB_HOME: "/tmp/x" }, "/tmp/x"), null);
  // secrets: a test-tier local plugin gets its own <id>.* keys; a plain local one — none
  assert.equal(denyReason({ id: "loc", source: "local", granted: { tier: "own", testTier: true } }, "loc.token"), null);
  assert.equal(denyReason({ id: "loc", source: "local", granted: { tier: "own", testTier: true } }, "other.token"), "foreign-namespace");
  assert.equal(denyReason({ id: "loc", source: "local", granted: { tier: "local" } }, "loc.token"), "untrusted");
  const LOCAL = `#!/bin/sh\n# <agenthub.action id="go" level="immediate">/usr/bin/true</agenthub.action>\n# <agenthub.action id="ask" level="confirm">/usr/bin/true</agenthub.action>\n# <agenthub.push key="done" kind="security">Done</agenthub.push>\necho "L | status=ok"\necho "---"\necho "Go | action=go"\necho "Ask | action=ask"\n`;
  for (const tier of ["own", null]) {
    const h = await startHub({ overrides, sys: sysAs({ who: "cli" }), env: tier ? { AGENTHUB_TEST_TIER: tier } : {} });
    try {
      assert.equal(h.config.testTier, tier);
      mkdirSync(h.config.paths.pluginsLocal, { recursive: true });
      writePlugin(h.config.paths.pluginsLocal, "loc.1h.sh", LOCAL);
      await h.core.host.rescan();
      await waitFor(() => h.core.pluginState("loc")?.body.length);
      const st = h.core.pluginState("loc");
      if (tier) {
        assert.deepEqual([st.tier, st.trusted, st.testTier], ["own", true, true]);
        assert.equal(st.pushRules.length, 1);
        const go = st.body[0].offer;
        assert.equal((await h.core.invoke({ id: go.id, peer: CLI })).status, 200, "cli presses a test-tier action");
        const ask = st.body[1].offer;
        const first = await h.core.invoke({ id: ask.id, peer: CLI });
        assert.equal(first.status, 428);
        // another curl (another pid) confirms it: the test-tier token is not bound to the pid
        assert.equal((await h.core.invoke({ id: ask.id, confirmToken: first.body.token, peer: { class: "cli", pid: 21 } })).status, 200);
      } else {
        assert.deepEqual([st.tier, st.trusted, st.actions.length], ["local", false, 0]);
      }
    } finally {
      await h.stop();
    }
  }
});
