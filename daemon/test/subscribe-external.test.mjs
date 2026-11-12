// Plugin event subscriptions (G11: <agenthub.subscribe>, {"type":"event"} and {"type":"eventSnapshot"} on stdin, the row title
// in event.raised, the initiating plugin in the action journal) and non-Claude agent sessions (G13: agentSession= lines,
// /state.externalSessions, session.focus only). System doubles, temp directories only, no network, no real terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetaText, parseSubscription } from "../lib/meta.mjs";
import { diffPermissions, lintPlugin, permissionList, permissionsFromMeta } from "../lib/registry/perms.mjs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = { class: "app", pid: 10 };
const CLI = { class: "cli", pid: 20 };
const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const overrides = { requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' } };

// A system double: who — the class of the next socket connection; alive — pids of live processes with their start time;
// an "agent" process 4242 runs under iTerm2 (its parent 4241) on ttys009.
function sysDouble(state) {
  return {
    available: true,
    peerPid: () => (state.who === "app" ? 10 : 20),
    peerUid: () => 501,
    pidPath: (pid) => (pid === 10 ? "/Applications/AgentHub.app/Contents/MacOS/AgentHub" : pid === 4241 ? "/Applications/iTerm.app/Contents/MacOS/iTerm2" : "/usr/bin/curl"),
    pidInfo: (pid) => {
      if (state.alive.has(pid)) return { pid, ppid: pid === 4242 ? 4241 : 1, uid: 501, startSec: state.alive.get(pid), startUsec: 0 };
      // processes the test doesn't model (plugin runs, the peer) are alive with start 1
      return pid >= 4000 && pid < 5000 ? null : { pid, ppid: 1, uid: 501, startSec: 1, startUsec: 0 };
    },
    procArgv: () => null,
    ttyName: (pid) => (pid === 4242 ? "ttys009" : null),
    codesignVerify: async (p) => p.startsWith("/Applications/AgentHub.app"),
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}

// ---------- metadata, permissions, linter ----------
test("subscribe: metadata grammar, permission keys (growth needs consent), linter rules", () => {
  assert.deepEqual(parseSubscription("builds:failed — why"), { plugin: "builds", prefix: "failed" });
  assert.deepEqual(parseSubscription("builds:"), { plugin: "builds", prefix: "" });
  assert.deepEqual(parseSubscription("*:deploy"), { plugin: "*", prefix: "deploy" });
  for (const bad of ["builds", "a b:c", ":x", "x:y z", "@hub:x"]) assert.equal(parseSubscription(bad), null, bad);
  const { meta } = parseMetaText(`
# <agenthub.type>streamable</agenthub.type>
# <agenthub.subscribe>builds:failed — restart failed builds</agenthub.subscribe>
# <agenthub.subscribe lang="ru">builds:failed — перезапуск</agenthub.subscribe>
`);
  assert.deepEqual(meta.subscribe, ["builds:failed — restart failed builds"]);
  assert.equal(meta.i18n.ru.why["builds:failed"], "перезапуск");
  const perms = permissionsFromMeta(meta);
  assert.deepEqual(perms.subscribe, [{ what: "builds:failed", why: "restart failed builds" }]);
  assert.ok(permissionList(perms).some((p) => p.key === "subscribe:builds:failed"));
  assert.equal(permissionsFromMeta({}).subscribe, undefined, "no tag — the permission set is unchanged");
  // adding a subscription in an update is permission growth (a new consent window)
  const grown = diffPermissions(perms, permissionsFromMeta({ ...meta, subscribe: [...meta.subscribe, "*:deploy — deploys"] }));
  assert.deepEqual(grown.added.map((p) => p.key), ["subscribe:*:deploy"]);

  const base = { title: "T", version: "1.0.0", author: { github: "x" }, platforms: ["macos"], effects: [], type: "streamable" };
  const ok = lintPlugin({ id: "p", meta: { ...base, subscribe: ["builds:failed — why"] }, official: true });
  assert.deepEqual(ok.errors, []);
  assert.ok(!ok.warnings.some((w) => w.includes("subscribe")));
  const wild = lintPlugin({ id: "p", meta: { ...base, subscribe: ["*: — everything"] }, official: true, lang: "en" });
  assert.deepEqual(wild.errors, []);
  assert.ok(wild.warnings.some((w) => w.includes("events of every plugin")));
  const community = lintPlugin({ id: "p", meta: { ...base, subscribe: ["builds:failed — why"] }, official: false, lang: "en" });
  assert.deepEqual(community.errors, []);
  assert.ok(community.warnings.some((w) => w.includes("the core ignores them")));
  const standard = lintPlugin({ id: "p", meta: { ...base, type: "standard", subscribe: ["builds:failed — why"] }, official: true, lang: "en" });
  assert.ok(standard.warnings.some((w) => w.includes("streamable")));
  const bad = lintPlugin({ id: "p", meta: { ...base, subscribe: ["builds — why", "x:y"] }, official: true, lang: "en" });
  assert.ok(bad.errors.some((e) => e.includes("expected")));
  assert.ok(bad.errors.some((e) => e.includes('no "— why"')), "a subscription needs its why");
  const many = lintPlugin({ id: "p", meta: { ...base, subscribe: Array.from({ length: 17 }, (_, i) => `p${i}: — w`) }, official: true, lang: "en" });
  assert.ok(many.errors.some((e) => e.includes("at most 16")));
});

// ---------- delivery ----------
const SRC = `#!/bin/sh
# <agenthub.title>Src</agenthub.title>
F="$AGENTHUB_PLUGIN_DATA_PATH/out.txt"
echo "Src | status=ok"; echo "---"
[ -f "$F" ] && cat "$F"
exit 0
`;
const SUB = `#!/bin/sh
# <agenthub.title>Sub</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
# <agenthub.subscribe>src:fail — react to failures</agenthub.subscribe>
# <agenthub.subscribe>*:all — everything starting with all</agenthub.subscribe>
D="$AGENTHUB_PLUGIN_DATA_PATH"
echo "Sub | status=ok"; echo "---"; echo "Own | event=all-mine"; echo "~~~"
while IFS= read -r line; do echo "$line" >> "$D/stdin.log"; done
`;

test("subscriptions: snapshot on start and restart, raised/cleared with the row title, prefix and wildcard (not self), event.raised carries the title", async () => {
  const plugins = tempHome("ah-sub-");
  writePlugin(plugins, "src.sh", SRC);
  writePlugin(plugins, "sub.sh", SUB);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysDouble({ who: "app", alive: new Map() }) });
  try {
    const srcData = join(h.config.paths.pluginData, "src");
    const subLog = () => readIf(join(h.config.paths.pluginData, "sub", "stdin.log")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const raised = [];
    h.core.on("event", (e) => e.type === "event.raised" && raised.push(e));
    await waitFor(() => h.core.pluginState("src")?.lastRunAt && h.core.pluginState("sub")?.body.length);
    await waitFor(() => subLog().some((m) => m.type === "eventSnapshot"));
    assert.deepEqual(subLog().find((m) => m.type === "eventSnapshot").events, [], "its own all-mine is not delivered through *:");
    mkdirSync(srcData, { recursive: true });
    writeFileSync(join(srcData, "out.txt"), "Build 42 \\| main failed | event=fail:42\nAll good | event=ok:1\nRelease | event=all-x\n");
    h.core.host.refresh("src", "Manual");
    await waitFor(() => subLog().filter((m) => m.type === "event").length >= 2);
    const events = subLog().filter((m) => m.type === "event");
    assert.deepEqual(
      events.map((m) => [m.plugin, m.key, m.state, m.title]),
      [
        ["src", "fail:42", "raised", "Build 42 | main failed"],
        ["src", "all-x", "raised", "Release"],
      ],
    );
    // the SSE event carries the sanitized row title too
    assert.equal(raised.find((e) => e.key === "src:fail:42")?.title, "Build 42 | main failed");
    // a subscriber restart: the snapshot carries what is raised now
    assert.equal(await h.core.restartPlugin("sub", "SecretChanged"), true);
    await waitFor(() => subLog().filter((m) => m.type === "eventSnapshot").length === 2);
    const snap = subLog().filter((m) => m.type === "eventSnapshot")[1].events;
    assert.deepEqual(snap.map((e) => [e.plugin, e.key, e.state, e.title]).sort(), [
      ["src", "all-x", "raised", "Release"],
      ["src", "fail:42", "raised", "Build 42 | main failed"],
    ]);
    // cleared
    writeFileSync(join(srcData, "out.txt"), "Release | event=all-x\n");
    h.core.host.refresh("src", "Manual");
    await waitFor(() => subLog().some((m) => m.type === "event" && m.state === "cleared"));
    const cleared = subLog().filter((m) => m.type === "event" && m.state === "cleared");
    assert.deepEqual(cleared.map((m) => [m.plugin, m.key, m.title]), [["src", "fail:42", undefined]]);
    assert.ok(!subLog().some((m) => m.key === "ok:1"), "a key outside the prefixes is not delivered");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("subscriptions are ignored (with a journal warning) for untrusted and standard plugins; actions pressed by a plugin process name it in the journal", async () => {
  const h = await startHub({ overrides, sys: sysDouble({ who: "app", alive: new Map() }) });
  try {
    const meta = { type: "streamable", subscribe: ["src:fail — x"] };
    assert.deepEqual(h.core.subscriptionsFor({ id: "loc", source: "local", granted: {}, meta }), []);
    assert.deepEqual(h.core.subscriptionsFor({ id: "std", source: "builtin", granted: {}, meta: { ...meta, type: "standard" } }), []);
    assert.deepEqual(h.core.subscriptionsFor({ id: "ok", source: "builtin", granted: {}, meta: { ...meta, subscribe: ["src:fail — x", "src:fail", "bad entry"] } }), [{ plugin: "src", prefix: "fail" }]);
    const j = readIf(h.config.paths.journal);
    assert.match(j, /"plugin":"loc"[^\n]*subscribe/);
    assert.match(j, /"plugin":"std"[^\n]*streamable/);
    assert.match(j, /"plugin":"ok"[^\n]*bad entry/);
    // G11: an action asked by a plugin process (the server binds peer.plugin) — the journal names the plugin
    await h.core.invoke({ id: "session.focus", args: { sessionId: "nope" }, peer: { ...CLI, plugin: { id: "auto", trusted: true } } });
    const denied = readIf(h.config.paths.journal).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "action-denied");
    assert.equal(denied.at(-1).byPlugin, "auto");
    await h.core.invoke({ id: "session.focus", args: { sessionId: "nope" }, peer: CLI });
    const last = readIf(h.config.paths.journal).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "action-denied").at(-1);
    assert.equal(last.byPlugin, undefined);
  } finally {
    await h.stop();
  }
});

// ---------- non-Claude agent sessions ----------
const AGENTS = `#!/bin/sh
# <agenthub.title>Agents</agenthub.title>
# <agenthub.effects>session.focus</agenthub.effects>
F="$AGENTHUB_PLUGIN_DATA_PATH/out.txt"
echo "Agents | status=ok"; echo "---"
[ -f "$F" ] && cat "$F"
exit 0
`;
const EXT_UUID = "0b9c6a1e-4f8d-4c2b-9a7e-1d2c3b4a5f60";

test("agentSession=: a trusted plugin registers a kind external session; /state.externalSessions, not /state.sessions; only focus works", async () => {
  const plugins = tempHome("ah-ext-");
  writePlugin(plugins, "agents.sh", AGENTS);
  writePlugin(plugins, "other.sh", AGENTS.replace("Agents", "Other"));
  const state = { who: "cli", alive: new Map([[4242, 77], [4243, 78]]) };
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysDouble(state) });
  try {
    const out = (id, text) => {
      const d = join(h.config.paths.pluginData, id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "out.txt"), text);
      h.core.host.refresh(id, "Manual");
    };
    const events = [];
    h.core.on("event", (e) => e.type === "sessions.external" && events.push(e));
    await waitFor(() => h.core.pluginState("agents")?.lastRunAt && h.core.pluginState("other")?.lastRunAt);
    out("agents", `Refactor | agentSession=cx-1 pid=4242 agent=codex agentName="Refactor auth" effect="session.focus cx-1"\nOther | agentSession=${EXT_UUID} pid=4243\nGone | agentSession=cx-dead pid=4999\nBad | agentSession="a b" pid=4242\n`);
    await waitFor(() => h.core.externalSessions().length === 2);
    const st = await req(h.sock, "GET", "/state");
    assert.equal(st.status, 200);
    assert.deepEqual(st.body.sessions, [], "Claude session consumers see nothing new");
    const ext = st.body.externalSessions.find((s) => s.sessionId === "cx-1");
    assert.equal(ext.kind, "external");
    assert.equal(ext.agent, "codex");
    assert.equal(ext.name, "Refactor auth");
    assert.equal(ext.owner, "agents");
    assert.equal(ext.pid, 4242);
    assert.equal(ext.startSec, 77);
    assert.equal(ext.terminal, "iterm2", "the terminal layer finds the tab by the pid");
    assert.equal(ext.focusable, true);
    assert.equal(h.core.facts.sessions().length, 0);
    assert.ok(events.length >= 1 && events.at(-1).sessions.length === 2);
    // the row offer: session.focus <external id> is accepted by the primitive's pattern
    const row = h.core.pluginState("agents").body.find((b) => b.title === "Refactor");
    assert.equal(row.offer?.primitive, "session.focus");
    const j = readIf(h.config.paths.journal);
    assert.match(j, /agentSession=cx-dead[^\n]*4999/, "a pid with no process is refused (journal warning)");
    assert.match(j, /agentSession=a b/);

    // focus: immediate, cli too — the adapter is asked (osascript with the tab's tty goes to the test exec log)
    let r = await h.core.invoke({ id: "session.focus", args: { sessionId: "cx-1" }, peer: CLI });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.terminal, "iterm2");
    assert.ok(readIf(join(h.home, "exec.log")).includes("ttys009"), "the adapter switched by the tty of the agent's process");
    // interrupt and stop refuse with a clear code; app only, so ask as the app
    for (const id of ["session.interrupt", "session.stop"]) {
      r = await h.core.invoke({ id, args: { sessionId: EXT_UUID }, peer: APP });
      assert.equal(r.body.error, "facts:external-session", id);
    }
    // the terminal service lookup refuses it as well
    assert.ok(h.core.sessions.external(EXT_UUID));
    assert.equal(h.core.sessions.get(EXT_UUID), null);

    // another trusted plugin cannot take a live id
    out("other", "Steal | agentSession=cx-1 pid=4243\n");
    await waitFor(() => /"plugin":"other"[^\n]*agentSession=cx-1[^\n]*agents/.test(readIf(h.config.paths.journal)));
    assert.equal(h.core.externalSession("cx-1").owner, "agents");

    // the pid died (or was reused: another start time) — the entry goes
    state.alive.set(4243, 999);
    assert.equal(h.core.externalSession(EXT_UUID), null);
    assert.deepEqual(h.core.externalSessions().map((s) => s.sessionId), ["cx-1"]);
    // the line disappears — the entry goes
    out("agents", "Nothing\n");
    await waitFor(() => h.core.externalSessions().length === 0);
    r = await h.core.invoke({ id: "session.focus", args: { sessionId: "cx-1" }, peer: CLI });
    assert.equal(r.body.error, "facts:unknown-session");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("agentSession= from an untrusted plugin, without a pid or with a bad id is refused; a removed plugin's sessions go", async () => {
  const state = { who: "cli", alive: new Map([[4242, 5]]) };
  const h = await startHub({ overrides, sys: sysDouble(state) });
  try {
    const local = { id: "loc", source: "local", granted: {}, meta: {} };
    const trusted = { id: "tr", source: "builtin", granted: {}, meta: {} };
    assert.equal(h.core.noteExternal(local, { agentSession: "x", pid: "4242" }).id, null);
    assert.equal(h.core.noteExternal(trusted, { agentSession: "x" }).id, null);
    assert.equal(h.core.noteExternal(trusted, { agentSession: "x", pid: "1" }).id, null);
    assert.equal(h.core.noteExternal(trusted, { agentSession: "-x", pid: "4242" }).id, null);
    assert.equal(h.core.noteExternal(trusted, { agentSession: "x", pid: String(process.pid) }).id, null, "never the daemon itself");
    assert.deepEqual(h.core.noteExternal(trusted, { agentSession: "x", pid: "4242", agent: "Bad Kind", agentName: "a\u0007b" }), { id: "x", changed: true });
    assert.deepEqual(h.core.externalSession("X"), { sessionId: "x", pid: 4242, startSec: 5, kind: "external", agent: null, name: "a b", owner: "tr", updatedAt: h.core.externalSession("x").updatedAt });
    assert.equal(h.core.noteExternal(trusted, { agentSession: "x", pid: "4242", agent: "Bad Kind", agentName: "a\u0007b" }).changed, false, "the same line again is no change");
    assert.equal(h.core.dropExternal("tr", new Set()), true);
    assert.equal(h.core.externalSessions().length, 0);
  } finally {
    await h.stop();
  }
});
