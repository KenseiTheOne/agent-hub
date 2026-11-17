// /state.limits and /state.hook: the plugin action time limit and what the hub knows about the Claude Code hook
// (lib/hook/seen.mjs — the time of the last verified hook event, kept across daemon restarts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { HOOK_INSTALL_COMMAND, HOOK_SEEN_FILE, HookSeen } from "../lib/hook/seen.mjs";
import { createPeer } from "../lib/peer.mjs";
import { cleanup, FILE_MODES, req, startHub, tempHome } from "./helpers.mjs";

const REPO = join(import.meta.dirname, "..", "..");

test("/state.limits.actionTimeoutMs is the effective plugin action limit: the default, then config.json", async () => {
  const h = await startHub();
  try {
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(st.limits, { actionTimeoutMs: 30000 });
    assert.equal(st.limits.actionTimeoutMs, h.config.plugins.actionTimeoutMs);
  } finally {
    await h.stop();
  }
  const h2 = await startHub({ configFile: { plugins: { actionTimeoutMs: 4321 } } });
  try {
    assert.deepEqual((await req(h2.sock, "GET", "/state")).body.limits, { actionTimeoutMs: 4321 });
  } finally {
    await h2.stop();
  }
});

test("/state.hook: no events — installed false with a reason; a hook event sets lastEventAt and survives a restart", async () => {
  const h = await startHub();
  const file = join(h.home, HOOK_SEEN_FILE);
  const kept = tempHome("ah-seen-");
  try {
    assert.deepEqual((await req(h.sock, "GET", "/state")).body.hook, { installed: false, lastEventAt: null, reason: "no-events", installCommand: HOOK_INSTALL_COMMAND });
    assert.equal(existsSync(file), false, "nothing is written until an event comes");
    const before = Date.now();
    // what POST /hook calls once the peer and the session id are verified (lib/server.mjs)
    assert.deepEqual(await h.core.handleHook({ hook_event_name: "PreToolUse", session_id: "s1" }, { class: "hook", claudePid: 1 }), {});
    const hook = (await req(h.sock, "GET", "/state")).body.hook;
    assert.deepEqual(Object.keys(hook), ["installed", "lastEventAt", "installCommand"]);
    assert.equal(hook.installCommand, HOOK_INSTALL_COMMAND);
    assert.equal(hook.installed, true);
    assert.ok(Date.parse(hook.lastEventAt) >= before - 1 && Date.parse(hook.lastEventAt) <= Date.now());
    // the first event is written at once, later ones within a minute are not (a hook event comes with every tool call)
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, lastEventAt: hook.lastEventAt });
    if (FILE_MODES) assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    await new Promise((r) => setTimeout(r, 5));
    await h.core.handleHook({ hook_event_name: "Stop", session_id: "s1" }, { class: "hook", claudePid: 1 });
    const later = h.core.snapshot().hook.lastEventAt;
    assert.ok(later > hook.lastEventAt);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).lastEventAt, hook.lastEventAt, "throttled");
    // a regular stop writes the last one; the next daemon on that home starts from it
    await h.core.stop();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).lastEventAt, later);
    writeFileSync(join(kept, HOOK_SEEN_FILE), readFileSync(file));
    const config = loadConfig({ env: { AGENTHUB_HOME: kept, AGENTHUB_BUILTIN_PLUGINS: join(kept, "no-builtin"), AGENTHUB_SERVICES: "none" } });
    const core = new Core({ config, peer: createPeer({ config }) });
    await core.init({ startPlugins: false });
    try {
      assert.deepEqual(core.snapshot().hook, { installed: true, lastEventAt: later, installCommand: HOOK_INSTALL_COMMAND });
    } finally {
      await core.stop();
    }
  } finally {
    await h.srv.close();
    cleanup(h.home);
    cleanup(kept);
  }
});

test("HookSeen: writes are throttled with a trailing write; an unreadable file counts as no events", async () => {
  const home = tempHome("ah-seen-");
  const path = join(home, HOOK_SEEN_FILE);
  try {
    let now = Date.parse("2026-11-17T10:00:00.000Z");
    const seen = new HookSeen(path, { minWriteMs: 40, now: () => now });
    seen.note();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).lastEventAt, "2026-11-17T10:00:00.000Z");
    now += 10;
    seen.note();
    now += 10;
    seen.note();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).lastEventAt, "2026-11-17T10:00:00.000Z");
    assert.equal(seen.info().lastEventAt, "2026-11-17T10:00:00.020Z");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).lastEventAt, "2026-11-17T10:00:00.020Z", "the trailing write");
    assert.deepEqual(new HookSeen(path).load().info(), { installed: true, lastEventAt: "2026-11-17T10:00:00.020Z", installCommand: HOOK_INSTALL_COMMAND });
    for (const bad of ["", "{", "[]", '{"lastEventAt":17}', '{"lastEventAt":"yesterday"}', '{"lastEventAt":"2026-13-45T99:00:00Z"}']) {
      writeFileSync(path, bad);
      assert.deepEqual(new HookSeen(path).load().info(), { installed: false, lastEventAt: null, reason: "no-events", installCommand: HOOK_INSTALL_COMMAND }, bad);
    }
    // flush with nothing new writes nothing
    const idle = new HookSeen(join(home, "none.json"));
    idle.flush();
    assert.equal(existsSync(join(home, "none.json")), false);
  } finally {
    cleanup(home);
  }
});

test("/state.hook.installCommand is the permanent install the hook's README gives, for the marketplace and plugin this repository declares", () => {
  // the two commands of claude-plugin/README.md ("Permanently"), joined; the comment after the first is not part of it
  const readme = readFileSync(join(REPO, "claude-plugin", "README.md"), "utf8");
  const lines = readme.split("\n").map((l) => l.replace(/\s+#.*$/, "").trim());
  const [add, install] = HOOK_INSTALL_COMMAND.split(" && ");
  assert.ok(lines.includes(add), add);
  assert.ok(lines.includes(install), install);
  assert.equal(lines.indexOf(install), lines.indexOf(add) + 1, "one after the other, in one block");
  // the names in it are the ones the manifests declare
  const market = JSON.parse(readFileSync(join(REPO, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(REPO, "claude-plugin", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(install, `claude plugin install ${plugin.name}@${market.name}`);
  assert.ok(market.plugins.some((p) => p.name === plugin.name));
});
