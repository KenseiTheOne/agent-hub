// Session effort in the core registry (sessionEffort= / sessionUltracode= from the plugin) and the cmux bridge state in /state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";

function sys() {
  const procs = { 40: { ppid: 1, path: CLAUDE }, 41: { ppid: 1, path: CLAUDE }, 20: { ppid: 1, path: "/usr/bin/curl" } };
  return {
    available: true,
    peerPid: () => 20,
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === CLAUDE,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}

const PLUGIN = `#!/bin/sh
echo "S | status=ok"
echo "---"
echo "A | session=11111111-1111-4111-8111-111111111111 pid=40 sessionStatus=busy sessionEffort=xhigh sessionUltracode=true"
echo "B | session=22222222-2222-4222-8222-222222222222 pid=41 sessionStatus=idle sessionEffort=ultra sessionUltracode=maybe"
`;

test("session registry: effort and ultracode from plugin output — known levels only; in /state.sessions", async () => {
  const plugins = tempHome("ah-ef-");
  writePlugin(plugins, "s.1h.sh", PLUGIN);
  const h = await startHub({ pluginsDir: plugins, sys: sys() });
  try {
    const list = await waitFor(() => (h.core.sessionList().length === 2 ? h.core.sessionList() : null));
    const a = list.find((s) => s.pid === 40);
    const b = list.find((s) => s.pid === 41);
    assert.equal(a.effort, "xhigh");
    assert.equal(a.ultracode, true);
    assert.equal(b.effort, null);
    assert.equal(b.ultracode, null);
    const st = await req(h.sock, "GET", "/state");
    assert.equal(st.body.sessions.find((s) => s.pid === 40).effort, "xhigh");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("/state.bridge: actions service — online:false, bridge command and directory; bridge stopped polling → bridge.disconnected (stale)", async () => {
  const h = await startHub({ services: "actions", overrides: { services: { actions: { staleMs: 150, watchMs: 30 } } } });
  try {
    const st = await req(h.sock, "GET", "/state");
    assert.equal(st.body.bridge.online, false);
    assert.match(st.body.bridge.command, /bridge\/agenthub-bridge$/);
    assert.equal(st.body.bridge.home, h.home);
    assert.equal(st.body.bridge.defaultHome, false);
    const events = [];
    h.core.on("event", (e) => events.push(e));
    const ch = h.core.facts.get("bridge.channel");
    const peer = { class: "bridge", pid: 777, startSec: 5 };
    assert.equal(ch.hello(peer, { version: "1" }).status, 200);
    const on = await req(h.sock, "GET", "/state");
    assert.equal(on.body.bridge.online, true);
    assert.equal(on.body.bridge.version, "1");
    assert.ok(events.some((e) => e.type === "bridge.connected"));
    await waitFor(() => events.find((e) => e.type === "bridge.disconnected" && e.reason === "stale"), { timeoutMs: 3000 });
    const off = await req(h.sock, "GET", "/state");
    assert.equal(off.body.bridge.online, false);
    // polling again — online again, connected event (resumed)
    await ch.next(peer, 0);
    assert.ok(events.some((e) => e.type === "bridge.connected" && e.reason === "resumed"));
    assert.match(readFileSync(h.config.paths.journal, "utf8"), /"bridge-stale"/);
  } finally {
    await h.stop();
  }
  // without the actions service — bridge: null
  const h2 = await startHub();
  try {
    assert.equal((await req(h2.sock, "GET", "/state")).body.bridge, null);
  } finally {
    await h2.stop();
  }
});
