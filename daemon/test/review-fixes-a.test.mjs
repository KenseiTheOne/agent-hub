// Fixes from the 2026-11-12 review, part A: output escaping on cut lines, socket refusal of nested plugin processes,
// test flags vs $HOME, security events in the digest, a bad ntfy URL, the tmux binary. System doubles, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeTitle, FrameSplitter, MAX_DATA_VALUE, MAX_LINE, parseLine, parseOutput, parseParams } from "../lib/output.mjs";

const quoteValue = (v) => `"${String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/["\\|]/g, "\\$&")}"`;

test("A1: a line cut at MAX_LINE inside a quoted value adds no parameters", () => {
  const line = escapeTitle("Build failed") + " | note=" + quoteValue("x href=https://evil.example event=pwned a=" + "a".repeat(MAX_LINE + 4000));
  const out = parseOutput(`h\n---\n${line}`);
  const item = out.body[0];
  assert.equal(item.href, undefined);
  assert.equal(item.event, undefined);
  assert.deepEqual(item.params, {});
  assert.equal(item.title, "Build failed");
  assert.deepEqual(out.events, []);
  assert.ok(out.warnings.length > 0);
  // the same through parseLine directly
  const direct = parseLine(line);
  assert.deepEqual(direct.params, {});
  assert.equal(direct.title, "Build failed");
});

test("A1: an unquoted value can't start with a quote character", () => {
  assert.equal(parseParams('note="x href=https://evil.example').ok, false);
  assert.equal(parseParams("note='x event=pwned").ok, false);
  const { title, params } = parseLine('ok | note="x href=https://evil.example event=pwned');
  assert.deepEqual(params, {});
  assert.equal(title, 'ok | note="x href=https://evil.example event=pwned');
  // ordinary values are untouched
  assert.deepEqual(parseParams("a=b c= d=x\"y").params, { a: "b", c: "", d: 'x"y' });
});

test("A1: a chart line with every data key at its maximum still fits in one line", () => {
  const list = (n, sep) => Array.from({ length: n }, (_, i) => String(i % 10)).join(sep);
  const v = list(MAX_DATA_VALUE / 2, ",");
  const line = `Chart | chart=bars values=${quoteValue(v)} labels=${quoteValue(v)} valueLabels=${quoteValue(v)} tips=${quoteValue(list(MAX_DATA_VALUE / 2, "¦"))} series=${quoteValue(v)} color=red`;
  assert.ok(line.length <= MAX_LINE, `${line.length} > ${MAX_LINE}`);
  const [item] = parseOutput(`h\n---\n${line}`).body;
  assert.equal(item.params.color, "red");
  assert.equal(item.params.values.length, v.length);
});

test("A1: a streamable line over the byte limit is dropped up to its end, its tail is not a new line", () => {
  const frames = [];
  const s = new FrameSplitter((f, overflow) => frames.push([f, overflow]), 1000, { idleMs: 0 });
  s.push("ok line\n");
  s.push("big | note=\"" + "a".repeat(1500));
  s.push("a".repeat(600) + " href=https://evil.example event=pwned\"\n");
  s.push("after\n~~~\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], "ok line\nafter");
  assert.equal(frames[0][1], true);
  // end() during a skipped line drops the partial tail too
  const f2 = [];
  const s2 = new FrameSplitter((f) => f2.push(f), 1000, { idleMs: 0 });
  s2.push("first\n" + "b".repeat(1500));
  s2.push("tail event=pwned");
  s2.end();
  assert.deepEqual(f2, ["first"]);
});

test("A2: nesting deeper than any fixed limit doesn't hide a plugin process; its process group does too", async () => {
  const { pluginOfPid } = await import("../lib/server.mjs");
  const loc = { id: "loc", trusted: false, tier: null, source: "local" };
  // a chain of 40 wrappers under the plugin process 300, each in a group of its own (only the ppid walk finds it)
  const parents = { 300: 200, 200: process.pid };
  for (let p = 1000; p < 1040; p++) parents[p] = p === 1000 ? 300 : p - 1;
  const groups = { 7000: 300 }; // 7000: reparented to launchd (double fork), still in the plugin's process group
  parents[7000] = 1;
  const core = {
    facts: { pluginByPid: (pid) => (pid === 300 ? loc : null) },
    peer: { sys: { pidInfo: (pid) => (pid in parents ? { ppid: parents[pid], pgid: groups[pid] ?? pid } : null) } },
  };
  assert.equal(pluginOfPid(core, 1039)?.id, "loc");
  assert.equal(pluginOfPid(core, 7000)?.id, "loc");
  assert.equal(pluginOfPid(core, 7000)?.pid, 300);
  // without a group match and outside the tree — a plain client
  groups[7000] = 7000;
  assert.equal(pluginOfPid(core, 7000), null);
});

test("A2: the native pidInfo reports the process group", async (t) => {
  const { defaultSys } = await import("../lib/peer.mjs");
  const sys = defaultSys();
  if (!sys.available) return t.skip("no native addon");
  const { execFileSync } = await import("node:child_process");
  const want = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
  assert.equal(sys.pidInfo(process.pid).pgid, want);
});

test("A3: test flags don't follow $HOME — the account's live directory is never a test hub", async (t) => {
  const { userInfo } = await import("node:os");
  const { join } = await import("node:path");
  const { testExtensionsOf, testTierOf } = await import("../lib/config.mjs");
  const { isLiveStateDir } = await import("../lib/platform.mjs");
  const live = join(userInfo().homedir, "Library", "Application Support", "AgentHub");
  const env = { HOME: "/tmp/agenthub-fake-home", AGENTHUB_HOME: live, AGENTHUB_TEST_TIER: "own", AGENTHUB_TEST_EXTENSIONS: "1" };
  // os.homedir() reads the process's own HOME
  const savedHome = process.env.HOME;
  process.env.HOME = env.HOME;
  t.after(() => (process.env.HOME = savedHome));
  assert.equal(testTierOf(env), null);
  assert.equal(testExtensionsOf(env), false);
  assert.equal(isLiveStateDir(live, { env }), true);
  // a real test directory is still a test hub
  const test = { ...env, AGENTHUB_HOME: "/tmp/agenthub-test-home-x" };
  assert.equal(testTierOf(test), "own");
  assert.equal(testExtensionsOf(test), true);
  assert.equal(isLiveStateDir("/tmp/agenthub-test-home-x", { env: test }), false);
});

test("A4: a security event held for the morning digest reaches only security channels, as kind security", async () => {
  const { PushEngine } = await import("../lib/push/engine.mjs");
  const { resolvePushConfig } = await import("../lib/push/config.mjs");
  const { memoryStore } = await import("../lib/push/store.mjs");
  const { createChannelSet } = await import("../lib/push/channels.mjs");
  const at = (local) => Date.parse(`${local}:00+01:00`);
  let now = at("2026-11-05T01:00");
  const mac = [];
  const posted = [];
  const fetchImpl = async (url, init) => (posted.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200, body: null });
  const set = createChannelSet({
    mac: { notify: (m) => (mac.push(m), { notifyId: String(mac.length), done: Promise.resolve({ ok: true }) }) },
    configured: [
      { id: "phone", type: "webhook", url: "https://plain.example/hook", events: null, security: false },
      { id: "pager", type: "webhook", url: "https://secure.example/hook", events: null, security: true },
    ],
    fetchImpl,
  });
  const engine = new PushEngine({
    config: resolvePushConfig({ timezone: "Europe/Belgrade" }),
    now: () => now,
    presence: async () => 120 * 60_000,
    mac: set,
    lookup: (plugin, bare) => ({ pluginTitle: plugin, itemTitle: `item ${bare}`, trusted: true, rules: [{ key: "run-done", label: "Runs finished" }] }),
    store: memoryStore(),
    journal: () => {},
  });
  await engine.raised({ plugin: "@hub", key: "@hub:app-restart-stopped", why: "x" });
  await engine.raised({ plugin: "runner", key: "runner:run-done" });
  assert.equal(engine.digest.length, 2, "both wait for the morning (no quietException)");
  now = at("2026-11-05T08:00");
  const before = mac.length;
  await engine.tick();
  await new Promise((r) => setTimeout(r, 20));
  // mac: one digest banner with everything, as before
  assert.equal(mac.length, before + 1);
  assert.equal(mac.at(-1).digest, true);
  const secBody = mac.at(-1).body.split("; ")[0];
  const plain = posted.filter((p) => p.url.includes("plain.example"));
  const secure = posted.filter((p) => p.url.includes("secure.example"));
  assert.ok(plain.length >= 1);
  for (const p of plain) {
    assert.notEqual(p.body.kind, "security");
    assert.ok(!p.body.body.includes(secBody), "the plain channel never sees the security item");
  }
  assert.ok(secure.some((p) => p.body.kind === "security" && p.body.body.includes(secBody)), "the security channel gets it as kind security");
});

test("A5: a bad percent escape in an ntfy URL rejects that channel only; the rest of the set works", async () => {
  const { createChannelSet, parseChannelConfig } = await import("../lib/push/channels.mjs");
  const raw = [
    { type: "ntfy", url: "https://ntfy.example/bad%E0%A4%A" },
    { type: "webhook", url: "https://hook.example/x", id: "hook" },
  ];
  const parsed = parseChannelConfig(raw);
  assert.deepEqual(parsed.invalid, [{ index: 0, reason: "ntfy-topic" }]);
  assert.deepEqual(parsed.channels.map((c) => c.id), ["hook"]);
  // a channel that slipped through (an older config shape) doesn't take the whole set down
  const journal = [];
  const posted = [];
  const set = createChannelSet({
    mac: null,
    configured: [{ id: "ntfy-1", type: "ntfy", url: "https://ntfy.example/bad%E0%A4%A", events: null, security: false }, parsed.channels[0]],
    journal: (e) => journal.push(e),
    fetchImpl: async (url) => (posted.push(url), { ok: true, status: 200 }),
  });
  assert.deepEqual(set.list().map((c) => c.id), ["mac", "hook"]);
  assert.ok(journal.some((e) => e.type === "push-channel-invalid" && e.channel === "ntfy-1"));
  const r = set.notify({ title: "Agent Hub", subtitle: "s", body: "b", key: "p:k", kind: "other" });
  await r.all;
  assert.deepEqual(posted, ["https://hook.example/x"]);
});

test("A6: the tmux adapter runs only a known tmux binary, never the ancestor's own executable path", async () => {
  const tmux = await import("../lib/terminals/tmux.mjs");
  const { clearCache } = await import("../lib/terminals/_proc.mjs");
  const procs = {
    100: { ppid: 200 }, // claude
    200: { ppid: 300 }, // shell
    300: { ppid: 1 },
  };
  const facts = (path) => ({
    processInfo: (pid) => (pid in procs ? { ...procs[pid], startSec: pid } : null),
    processPath: (pid) => (pid === 300 ? path : `/bin/p${pid}`),
    processArgv: () => ["tmux"],
  });
  const session = { pid: 100 };
  // an ancestor named like tmux but living anywhere: not run
  clearCache();
  assert.equal(tmux.locate(session, facts("/tmp/x/tmux-evil"), { realpath: (p) => p }), null);
  // a Homebrew Cellar path that is where a known tmux link points: run the known path
  clearCache();
  const cellar = "/opt/homebrew/Cellar/tmux/3.5a/bin/tmux";
  const real = (p) => (p === "/opt/homebrew/bin/tmux" ? cellar : p);
  assert.equal(tmux.locate(session, facts(cellar), { realpath: real })?.target.bin, "/opt/homebrew/bin/tmux");
  // a known path as is
  clearCache();
  assert.equal(tmux.locate(session, facts("/usr/local/bin/tmux"), { realpath: () => null })?.target.bin, "/usr/local/bin/tmux");
});

test("A2 end to end: a double-forked child of a local plugin (reparented to launchd) is still that plugin by its process group", async (t) => {
  const { defaultSys } = await import("../lib/peer.mjs");
  if (!defaultSys().available) return t.skip("no peercred addon");
  const { existsSync, mkdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { cleanup, startHub, tempHome, waitFor, writePlugin } = await import("./helpers.mjs");
  const builtin = tempHome("ah-a2-b-");
  const work = tempHome("ah-a2-w-");
  const h = await startHub({ pluginsDir: builtin, services: "actions" });
  try {
    h.core.setPluginPolicy?.(async () => null);
    mkdirSync(h.config.paths.pluginsLocal, { recursive: true });
    const out = join(work, "state.txt");
    // ( … & ) — the subshell exits at once, the background part is reparented to launchd; the run itself lives on
    writePlugin(
      h.config.paths.pluginsLocal,
      "fork.1h.sh",
      `#!/bin/sh
# <agenthub.title>Fork</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
if [ ! -e "${out}" ]; then
  ( /bin/sh -c 'sleep 0.3; P=$(/bin/ps -o ppid= -p $$ | tr -d " "); C=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" --unix-socket "${h.sock}" http://hub/state); echo "$P $C" > "${out}.tmp"; mv "${out}.tmp" "${out}"' & )
  sleep 2
fi
echo "ok | status=ok"
`,
    );
    await h.core.host.rescan();
    await waitFor(() => existsSync(out), { timeoutMs: 10_000 });
    const [ppid, code] = readFileSync(out, "utf8").trim().split(" ");
    assert.equal(ppid, "1", "the caller left the plugin's process tree");
    assert.equal(code, "403");
  } finally {
    await h.stop();
    cleanup(builtin);
    cleanup(work);
  }
});
