// /state sections that services register themselves (ctx.provideState → core.provideState): the fixed slots keep their
// place and are null without the service, a new section goes after the core's keys, the two setting sections take the
// service's fields on top of the core's, a name belongs to the one who registered it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICE_STATE_SLOTS } from "../lib/core.mjs";
import { makeCtx } from "../lib/ctx.mjs";
import { msg } from "../lib/i18n.mjs";
import { req, startHub } from "./helpers.mjs";

// The order the shell and the docs know (docs/api.md GET /state). `peer` is there for a socket request only.
const STATE_KEYS = [
  "version", "contract", "now", "pid", "estop", "status", "waitingSessions", "severity", "plugins", "sessions", "externalSessions",
  "primitives", "appPin", "lang", "pluginUpdates", "ownPlugins", "registryKeys", "hubUpdate", "launchAtLogin", "notifications",
  "idle", "connections", "hub", "bridge", "terminals", "extensions", "damagedFiles", "limits", "hook",
];

test("/state: the key order is fixed; service sections are null and the setting sections are the core's own without services", async () => {
  const h = await startHub();
  try {
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(Object.keys(st), [...STATE_KEYS, "peer", "seq"]);
    assert.deepEqual(Object.keys(h.core.snapshot()), [...STATE_KEYS, "seq"]);
    for (const k of SERVICE_STATE_SLOTS) assert.equal(st[k], null, k);
    assert.deepEqual(Object.keys(st.launchAtLogin), ["setting"]);
    assert.deepEqual(st.notifications.channels, []);
    assert.equal(Object.keys(st.notifications).at(-1), "channels");
  } finally {
    await h.stop();
  }
});

test("ctx.provideState: a slot is filled in place, a new section goes after hook, null removes it, a failing provider gives null", async () => {
  const h = await startHub();
  try {
    const a = makeCtx(h.core, "service:a");
    assert.equal(typeof a.provideState, "function");
    let n = 0;
    a.provideState("idle", () => ({ calls: ++n }));
    a.provideState("demoSection", () => ({ x: 1 }));
    a.provideState("zeta", () => undefined);
    a.provideState("broken", () => {
      throw new Error("boom");
    });
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(Object.keys(st), [...STATE_KEYS, "demoSection", "zeta", "broken", "peer", "seq"], "new sections: after hook, in registration order");
    assert.deepEqual(st.idle, { calls: 1 }, "asked once per snapshot");
    assert.deepEqual(st.demoSection, { x: 1 });
    assert.equal(st.zeta, null, "undefined is null");
    assert.equal(st.broken, null, "a provider that throws does not break /state");
    // the same owner replaces its section; null removes it
    a.provideState("demoSection", () => [1, 2]);
    assert.deepEqual(h.core.snapshot().demoSection, [1, 2]);
    for (const k of ["demoSection", "zeta", "broken", "idle"]) a.provideState(k, null);
    const after = h.core.snapshot();
    assert.deepEqual(Object.keys(after), [...STATE_KEYS, "seq"]);
    assert.equal(after.idle, null);
  } finally {
    await h.stop();
  }
});

test("ctx.provideState: a section belongs to the one who registered it; core keys and bad names are refused", async () => {
  const h = await startHub();
  try {
    const a = makeCtx(h.core, "service:a");
    const b = makeCtx(h.core, "service:b");
    a.provideState("demoSection", () => "a");
    assert.throws(() => b.provideState("demoSection", () => "b"), { message: msg("err.state.taken", { name: "demoSection", owner: "service:a" }) });
    assert.throws(() => b.provideState("demoSection", null), /demoSection.*service:a/, "another service cannot remove it either");
    assert.equal(h.core.snapshot().demoSection, "a");
    // a slot is owned the same way
    a.provideState("bridge", () => ({ online: false }));
    assert.throws(() => b.provideState("bridge", () => null), /bridge.*service:a/);
    // the core's own keys and names that are not a plain identifier
    for (const bad of ["version", "plugins", "sessions", "hub", "limits", "hook", "peer", "seq", "", "Upper", "with-dash", "a.b", "__proto__", "x".repeat(41), 7, null]) {
      assert.throws(() => a.provideState(bad, () => 1), { message: msg("err.state.name", { name: String(bad) }) }, String(bad));
    }
    assert.throws(() => a.provideState("okName", "not a function"), { message: msg("err.state.name", { name: "okName" }) });
    assert.equal("okName" in h.core.snapshot(), false);
    // removed by its owner — free for another one
    a.provideState("demoSection", null);
    b.provideState("demoSection", () => "b");
    assert.equal(h.core.snapshot().demoSection, "b");
  } finally {
    await h.stop();
  }
});

test("ctx.provideState: launchAtLogin and notifications take the service's fields on top of the core's (in /state and /settings)", async () => {
  const h = await startHub();
  try {
    const a = makeCtx(h.core, "service:a");
    a.provideState("launchAtLogin", () => ({ launchAgent: { loaded: true } }));
    a.provideState("notifications", () => ({ channels: [{ id: "c1", type: "demo", label: "Demo", security: false, events: null }] }));
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(Object.keys(st), [...STATE_KEYS, "peer", "seq"], "the setting sections keep their place");
    assert.deepEqual(st.launchAtLogin, { setting: h.core.settings.launchAtLogin, launchAgent: { loaded: true } });
    assert.deepEqual(st.notifications.channels, [{ id: "c1", type: "demo", label: "Demo", security: false, events: null }]);
    assert.equal(Object.keys(st.notifications).at(-1), "channels", "the field stays where the core had it");
    assert.deepEqual(h.core.launchAtLoginSetting(), st.launchAtLogin);
    assert.deepEqual(h.core.notificationsSetting().channels, st.notifications.channels);
    // a provider that returns nothing, a non-object or throws adds nothing
    a.provideState("launchAtLogin", () => null);
    a.provideState("notifications", () => {
      throw new Error("boom");
    });
    const st2 = h.core.snapshot();
    assert.deepEqual(st2.launchAtLogin, { setting: h.core.settings.launchAtLogin });
    assert.deepEqual(st2.notifications.channels, []);
    a.provideState("launchAtLogin", () => ["not", "fields"]);
    assert.deepEqual(h.core.snapshot().launchAtLogin, { setting: h.core.settings.launchAtLogin });
  } finally {
    await h.stop();
  }
});

test("built-in services register their sections through ctx.provideState (no section is assembled in the core)", async () => {
  const h = await startHub({ services: "idle,actions" });
  try {
    const owners = Object.fromEntries([...h.core.stateProviders].map(([k, v]) => [k, v.owner]));
    assert.deepEqual(owners, { bridge: "service:actions", idle: "service:idle" });
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(Object.keys(st), [...STATE_KEYS, "peer", "seq"]);
    assert.equal(typeof st.idle, "object");
    assert.notEqual(st.idle, null);
    assert.equal(st.bridge.online, false);
    assert.deepEqual(Object.keys(st.bridge), ["online", "since", "version", "command", "home", "defaultHome"]);
    for (const k of ["pluginUpdates", "ownPlugins", "registryKeys", "hubUpdate", "connections"]) assert.equal(st[k], null, k);
  } finally {
    await h.stop();
  }
});
