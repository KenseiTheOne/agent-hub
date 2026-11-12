// S2: processes of untrusted plugins (and their children) on hub.sock get only GET /health and GET /peer; trusted
// plugins keep the cli view. The plugin is found by the peer pid or its ancestors (the pluginByPid fact).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSys } from "../lib/peer.mjs";
import { pluginOfPid, PLUGIN_ANCESTOR_DEPTH } from "../lib/server.mjs";
import { cleanup, curl, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

test("pluginOfPid: the peer itself, a child or a grandchild of a plugin process; not above the daemon; depth-limited", () => {
  const parents = { 500: 400, 400: 300, 300: 200, 200: process.pid, 900: 1 };
  const plugins = { 300: { id: "loc", trusted: false, tier: null, source: "local" } };
  const calls = [];
  const core = {
    facts: { pluginByPid: (pid, opts) => (calls.push(opts), plugins[pid] || null) },
    peer: { sys: { pidInfo: (pid) => (pid in parents ? { ppid: parents[pid] } : null) } },
  };
  assert.deepEqual(pluginOfPid(core, 300), { id: "loc", trusted: false, tier: null, source: "local", pid: 300 });
  assert.deepEqual(pluginOfPid(core, 500)?.pid, 300);
  assert.equal(pluginOfPid(core, 500, { depth: 1 }), null);
  assert.equal(pluginOfPid(core, 200), null, "a direct child of the daemon that isn't a plugin");
  assert.equal(pluginOfPid(core, 900), null);
  assert.equal(pluginOfPid(core, null), null);
  assert.ok(calls.every((o) => o.actions === true), "plugin actions count as plugin processes");
  // a loop in the process table doesn't hang
  const loop = { facts: { pluginByPid: () => null }, peer: { sys: { pidInfo: (pid) => ({ ppid: pid === 10 ? 11 : 10 }) } } };
  assert.equal(pluginOfPid(loop, 10), null);
  assert.ok(PLUGIN_ANCESTOR_DEPTH >= 2);
});

// A shell plugin that calls the hub with curl (a child process) and writes the answers to a file.
function callerScript(title, sock, out) {
  const calls = [
    ["GET", "/health"],
    ["GET", "/peer"],
    ["GET", "/state"],
    ["GET", "/journal"],
    ["POST", "/actions/x"],
    ["POST", "/plugins/x/refresh"],
    ["POST", "/estop"],
  ];
  const lines = calls.map(([m, p]) => `printf '%s %s %s\\n' ${m} ${p} "$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' -X ${m} --unix-socket "$S" http://hub${p})" >> "${out}.tmp"`);
  return `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
S="\${AGENTHUB_HUB_SOCKET:-${sock}}"
if [ ! -e "${out}" ]; then
  rm -f "${out}.tmp"
${lines.map((l) => "  " + l).join("\n")}
  /usr/bin/curl -s --unix-socket "$S" http://hub/peer > "${out}.peer"
  mv "${out}.tmp" "${out}"
fi
echo "ok | status=ok"
`;
}

const answers = (path) => Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((l) => { const [m, p, c] = l.split(" "); return [`${m} ${p}`, Number(c)]; }));

test("end to end: an untrusted (local) plugin's child gets 403 peer:untrusted-plugin except /health and /peer; a builtin one — the cli view", { skip: !defaultSys().available && "no peercred addon" }, async () => {
  const builtin = tempHome("ah-s2-b-");
  const work = tempHome("ah-s2-w-");
  const trustedOut = join(work, "trusted.txt");
  writePlugin(builtin, "trusted.1h.sh", callerScript("Trusted", "/nonexistent", trustedOut));
  const h = await startHub({ pluginsDir: builtin, services: "actions" });
  try {
    await waitFor(() => existsSync(trustedOut), { timeoutMs: 10_000 });
    const t = answers(trustedOut);
    assert.equal(t["GET /health"], 200);
    assert.equal(t["GET /state"], 200, JSON.stringify(t));
    assert.equal(t["GET /journal"], 200);
    assert.notEqual(t["POST /actions/x"], 403, "a trusted plugin's process passes the peer check (the offer doesn't exist)");
    assert.equal(JSON.parse(readFileSync(`${trustedOut}.peer`, "utf8")).plugin.trusted, true);

    // the local plugin doesn't get AGENTHUB_HUB_SOCKET: it knows the path anyway
    const localOut = join(work, "local.txt");
    h.core.setPluginPolicy?.(async () => null);
    mkdirSync(h.config.paths.pluginsLocal, { recursive: true });
    writePlugin(h.config.paths.pluginsLocal, "loc.1h.sh", callerScript("Loc", h.sock, localOut));
    await h.core.host.rescan();
    await waitFor(() => existsSync(localOut), { timeoutMs: 10_000 });
    const l = answers(localOut);
    assert.deepEqual(l, {
      "GET /health": 200,
      "GET /peer": 200,
      "GET /state": 403,
      "GET /journal": 403,
      "POST /actions/x": 403,
      "POST /plugins/x/refresh": 403,
      "POST /estop": 403,
    });
    const peer = JSON.parse(readFileSync(`${localOut}.peer`, "utf8"));
    assert.deepEqual([peer.class, peer.plugin], ["cli", { id: "loc", trusted: false }]);
    // journaled: one entry per route (the rate limit is per plugin and route)
    const denied = h.core.journal.tail(500).filter((e) => e.type === "denied" && e.plugin === "loc");
    assert.ok(denied.length >= 5, JSON.stringify(denied));
    assert.ok(denied.every((e) => e.error === "peer:untrusted-plugin" && e.peer === "cli"));
    assert.ok(denied.some((e) => e.route === "GET /state"));
    assert.equal(h.core.estop(), false, "estop wasn't turned on");
    // the same requests not from a plugin process: the plain cli view
    const c = await curl(h.sock, "GET", "/state");
    assert.equal(c.status, 200);
    assert.equal((await curl(h.sock, "GET", "/peer")).body.plugin, null);
  } finally {
    await h.stop();
    cleanup(builtin);
    cleanup(work);
  }
});
