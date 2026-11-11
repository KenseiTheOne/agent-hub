// "Settings → Notifications": master switch, per-kind switches, quiet hours from settings.json, security
// exceptions. The engine runs on time, idle and sender doubles; the service in a real core (AGENTHUB_HOME in a
// temporary directory, external programs are not run — exec.log). Nothing goes out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePushConfig } from "../lib/push/config.mjs";
import { PushEngine } from "../lib/push/engine.mjs";
import { applyPatch, defaultPrefs, effectiveQuiet, kindAllowed, normPrefs, pluginToggle } from "../lib/push/prefs.mjs";
import { DEFAULT_RULES, KINDS, kindOf, matchRule, pluginRules } from "../lib/push/rules.mjs";
import { memoryStore } from "../lib/push/store.mjs";
import { parseMetaText, parsePushRule } from "../lib/meta.mjs";
import { cleanup, curl, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const MIN = 60_000;
const at = (local) => Date.parse(`${local}:00+01:00`); // Europe/Belgrade in November is UTC+1

// Rules as metadata parsing returns them (parsePushRule): old contract 1 kinds (kind="night"/"runs") arrive
// as kind "plugin" with legacyKind — the plugin's own switch, which a turned-off old kind turns off.
const OWN = {
  "my-runner": [
    { key: "unity-open", label: "Прогоны не запустятся", hold: "evening", cooldownMs: 0, kind: "plugin", legacyKind: "night" },
    { key: "run-done", label: "Прогоны закончились", kind: "plugin", legacyKind: "night" },
    { key: "tamper", label: "Маркер подмены", quietException: true, kind: "security" },
  ],
  hermes: [{ key: "job-failed", label: "Hermes: задача упала", kind: "plugin", legacyKind: "runs" }],
  clickup: [{ key: "auth-failed", label: "ClickUp: токен не принят" }],
  quota: [
    { key: "week-80", label: "Квота: неделя ≥ 80%", cooldownMs: 7 * 86_400_000, kind: "problems" },
    { key: "token-lost", label: "Квота не обновляется", kind: "problems" },
  ],
  // a third-party plugin declared "security" — the service does not take its rules (trusted: false)
  weird: [{ key: "boom", label: "Срочно", kind: "security" }],
};

function harness({ start = "2026-11-04T14:00", idleMin = 0, prefs = null, quiet = null, cfg = {} } = {}) {
  const h = { t: at(start), idle: idleMin * MIN, mac: [], journal: [] };
  h.engine = new PushEngine({
    config: resolvePushConfig({ timezone: "Europe/Belgrade", ...cfg }),
    now: () => h.t,
    presence: async () => h.idle,
    mac: { notify: (m) => (h.mac.push(m), { notifyId: String(h.mac.length), done: Promise.resolve({ ok: true }) }) },
    lookup: (plugin, bare) => ({ pluginTitle: plugin, itemTitle: `пункт ${bare}`, trusted: plugin !== "weird", rules: OWN[plugin] || null }),
    store: memoryStore(),
    journal: (e) => h.journal.push(e),
    prefs,
    quiet,
  });
  h.set = (local) => (h.t = at(local));
  h.raise = (plugin, key) => h.engine.raised({ plugin, key: `${plugin}:${key}` });
  h.clear = (plugin, key) => h.engine.cleared({ plugin, key: `${plugin}:${key}` });
  h.tick = () => h.engine.tick();
  h.muted = () => h.journal.filter((e) => e.type === "push-muted");
  return h;
}

// Turn off kinds; old contract 1 kinds (night, runs) — as in settings.json before migration (kinds.<kind> = false).
const off = (...kinds) => ({ ...defaultPrefs(), kinds: { ...defaultPrefs().kinds, ...Object.fromEntries(kinds.map((k) => [k, false])) } });
// Turn off plugins' own switches (contract 2).
const offPlugins = (...ids) => ({ ...defaultPrefs(), plugins: Object.fromEntries(ids.map((id) => [id, false])) });

test("kinds: core table, plugin rules, fallback to the table, untrusted is \"other\"", () => {
  const kind = (bare, own = null, trusted = true) => {
    const mine = own ? matchRule(pluginRules(own), bare) : null;
    const rule = mine && mine.name !== "default" ? mine : matchRule(DEFAULT_RULES, bare);
    return kindOf(rule, { trusted, bare });
  };
  assert.equal(kind("waiting:abc"), "sessions");
  assert.equal(kind("approvals-paused"), "sessions");
  // contract 2: the core table has no runs, interrupted sessions or blockers — plugins declare them
  assert.equal(kind("died:abc"), "other");
  assert.equal(kind("wf-failed-wf_1"), "other");
  assert.equal(kind("blocker:x"), "other");
  assert.equal(kind("wf-failed-wf_1", [{ key: "wf-failed", kind: "plugin", legacyKind: "runs" }]), "plugin");
  assert.equal(kind("plugin-update:my-runner:0.5.0"), "updates");
  assert.equal(kind("hub-update:0.4.0"), "updates");
  assert.equal(kind("hub-update-failed:0.4.0"), "updates");
  assert.equal(kind("plugin-own-updated:mine:1.2.0"), "updates", "an own plugin updated from its folder — the same switch as other updates");
  assert.equal(kind("source-broken"), "problems");
  // quota is declared by the builtin quota plugin with its own tags — the core table does not have it
  assert.equal(kind("week-80:20261108"), "other");
  assert.equal(kind("week-80:20261108", OWN.quota), "problems");
  assert.equal(kind("token-lost", OWN.quota), "problems");
  assert.equal(kind("plugin-error"), "problems");
  assert.equal(kind("что-то-своё"), "other");
  for (const k of ["app-pin-changed", "app-pin-path-changed", "app-restart-stopped", "hub-update-tag-moved:0.4.0", "plugin-own-unexpected:mine"]) assert.equal(kind(k), "security", k);
  // plugin: kind from the tag; no kind — the kind of the shared-table rule with the same key
  assert.equal(kind("run-done:20261104", OWN["my-runner"]), "plugin");
  assert.equal(kind("tamper", OWN["my-runner"]), "security");
  assert.equal(kind("job-failed-abc", OWN.hermes), "plugin");
  assert.equal(kind("auth-failed", OWN.clickup), "problems");
  // untrusted is always "other", and it cannot declare "security"
  assert.equal(kind("boom", OWN.weird, false), "other");
  assert.equal(kind("app-pin-changed", null, false), "other");
  // every core rule has a kind
  for (const r of DEFAULT_RULES) assert.ok(KINDS.includes(r.kind) || r.kind === "security", r.name);
});

test("meta: kind in <agenthub.push> — only known kinds; config.json does not set the kind", () => {
  assert.equal(parsePushRule({ key: "tamper", kind: "security" }, "Маркер").kind, "security");
  assert.equal(parsePushRule({ key: "x" }, "X").kind, undefined);
  assert.match(parsePushRule({ key: "x", kind: "loud" }, "X"), /kind must be/);
  // old contract 1 kinds are a deprecated synonym for "the plugin's own switch" (the linter warns, parsing does not)
  assert.deepEqual(parsePushRule({ key: "x", kind: "night" }, "X"), { key: "x", label: "X", kind: "plugin", legacyKind: "night" });
  assert.deepEqual(parsePushRule({ key: "x", kind: "plugin", was: "runs" }, "X"), { key: "x", label: "X", kind: "plugin", legacyKind: "runs", wasDeclared: true });
  assert.match(parsePushRule({ key: "x", kind: "problems", was: "runs" }, "X"), /was only with kind="plugin"/);
  assert.match(parsePushRule({ key: "x", kind: "plugin", was: "loud" }, "X"), /was must be/);
  const { meta, warnings } = parseMetaText(`# <agenthub.push key="run-done" kind="night">Прогоны закончились</agenthub.push>\n# <agenthub.push key="run-done" lang="en">Runs finished</agenthub.push>\n# <agenthub.push key="bad" kind="урра">x</agenthub.push>`);
  assert.deepEqual(meta.push.map((r) => [r.key, r.kind, r.legacyKind]), [["run-done", "plugin", "night"]]);
  assert.equal(meta.push[0].labels.en, "Runs finished");
  assert.ok(warnings.some((w) => /kind/.test(w)));
  // an override from config.json (services.push.rules) does not change the kind
  const h = harness({ cfg: { rules: { "app-pin-changed": { kind: "other", macOnly: true }, "run-done": { kind: "security" } } } });
  const rule = h.engine.ruleFor("app-pin-changed", true, null, "@hub");
  assert.equal(rule.kind, "security");
  assert.equal(h.engine.ruleFor("run-done", true, OWN["my-runner"], "my-runner").kind, "plugin");
});

test("prefs: normalization, partial edit, quiet hours from config.json until the first edit", () => {
  assert.deepEqual(normPrefs(null), defaultPrefs());
  // the old kinds.night = false (settings.json before contract 2) is migrated into legacy, not lost
  assert.deepEqual(normPrefs({ enabled: "no", kinds: { night: false, runs: true, security: false, bogus: false }, plugins: { hermes: false, "Bad Id": false, x: "no" }, quiet: { enabled: true, start: "7:5", end: "08:00" } }), {
    enabled: true,
    kinds: { ...defaultPrefs().kinds },
    plugins: { hermes: false },
    legacy: { night: false },
    migrated: {},
    legacyFor: null,
    quiet: null,
  });
  // an already migrated value stays on repeated normalization (settings.json rewritten)
  assert.deepEqual(normPrefs(normPrefs({ kinds: { runs: false } })).legacy, { runs: false });
  assert.deepEqual(effectiveQuiet(defaultPrefs(), {}), { enabled: true, start: "23:00", end: "08:00", from: "default" });
  assert.deepEqual(effectiveQuiet(defaultPrefs(), { quietStart: "22:30" }), { enabled: true, start: "22:30", end: "08:00", from: "config" });
  // the first quiet hours edit goes on top of the effective ones (from config.json)
  let r = applyPatch(defaultPrefs(), { quiet: { end: "7:00" } }, { quietStart: "22:30" });
  assert.deepEqual(r.prefs.quiet, { enabled: true, start: "22:30", end: "07:00" });
  assert.deepEqual(effectiveQuiet(r.prefs, { quietStart: "01:00" }), { enabled: true, start: "22:30", end: "07:00", from: "settings" });
  r = applyPatch(r.prefs, { enabled: false, kinds: { updates: false } });
  assert.equal(r.prefs.enabled, false);
  assert.equal(r.prefs.kinds.updates, false);
  assert.equal(r.prefs.quiet.start, "22:30", "the rest is untouched");
  for (const [patch, code] of [
    [null, "args:body:type"],
    [{}, "args:body:keys"],
    [{ volume: 3 }, "args:body:keys"],
    [{ enabled: 1 }, "args:enabled:type"],
    [{ kinds: { security: false } }, "args:kinds:enum"],
    [{ kinds: { night: false } }, "args:kinds:enum"],
    [{ kinds: { updates: "off" } }, "args:kinds:type"],
    [{ plugins: { "Bad Id": false } }, "args:plugins:id"],
    [{ plugins: { hermes: "off" } }, "args:plugins:type"],
    [{ plugins: [] }, "args:plugins:type"],
    [{ kinds: [] }, "args:kinds:type"],
    [{ quiet: { start: "25:00" } }, "args:quiet:time"],
    [{ quiet: { start: "08:00" } }, "args:quiet:empty"],
    [{ quiet: { enabled: "yes" } }, "args:quiet:type"],
    [{ quiet: { volume: 1 } }, "args:quiet:keys"],
  ]) assert.equal(applyPatch(defaultPrefs(), patch).error, code, JSON.stringify(patch));
  // security exceptions pass even with the master switch "off"
  assert.equal(kindAllowed({ ...defaultPrefs(), enabled: false }, "security"), true);
  assert.equal(kindAllowed({ ...defaultPrefs(), enabled: false }, "sessions"), false);
  assert.equal(kindAllowed(off("other"), "что-то"), false, "an unknown kind is treated as \"other\"");
  // the plugin's own switch: an explicit choice; without one — per the old kind from the plugin's rules
  r = applyPatch(defaultPrefs(), { plugins: { hermes: false } });
  assert.deepEqual(r.prefs.plugins, { hermes: false });
  assert.equal(kindAllowed(r.prefs, "plugin", { plugin: "hermes", rules: OWN.hermes }), false);
  assert.equal(kindAllowed(r.prefs, "plugin", { plugin: "my-runner", rules: OWN["my-runner"] }), true);
  const legacy = normPrefs(off("night"));
  assert.equal(pluginToggle(legacy, "my-runner", OWN["my-runner"]), false, "a turned-off \"night\" turns off the plugin whose rules declared it");
  assert.equal(pluginToggle(legacy, "hermes", OWN.hermes), true, "but a plugin with a different old kind is not affected");
  assert.equal(pluginToggle({ ...legacy, plugins: { "my-runner": true } }, "my-runner", OWN["my-runner"]), true, "a human's explicit choice beats migration");
  assert.equal(kindAllowed({ ...legacy, enabled: false }, "plugin", { plugin: "hermes", rules: OWN.hermes }), false, "the master switch also silences plugin switches");
});

test("turned-off kind: no banner, no digest; push-muted in the journal; other kinds as usual", async () => {
  const h = harness({ prefs: off("updates", "night") });
  await h.raise("@hub", "plugin-own-updated:mine:1.0.0");
  assert.deepEqual(h.muted().map((e) => [e.key, e.kind]), [["@hub:plugin-own-updated:mine:1.0.0", "updates"]], "\"Hub and plugin updates\" off — no \"Plugin updated\" either");
  h.journal.length = 0;
  await h.raise("@hub", "plugin-update:my-runner:0.5.0");
  await h.raise("my-runner", "run-done:20261104");
  assert.equal(h.mac.length, 0);
  assert.deepEqual(h.muted().map((e) => [e.key, e.kind, e.reason]), [
    ["@hub:plugin-update:my-runner:0.5.0", "updates", "kind"],
    ["my-runner:run-done:20261104", "plugin", "kind"],
  ]);
  assert.ok(!JSON.stringify(h.muted()).includes("пункт"), "no text in the journal");
  await h.raise("claude-sessions", "waiting:abc");
  assert.equal(h.mac.length, 1, "sessions are on");
  await h.clear("claude-sessions", "waiting:abc");
  // stepped away: a turned-off kind stays silent too
  h.idle = 30 * MIN;
  await h.raise("hermes", "job-failed-1");
  assert.equal(h.mac.length, 2, "runs are on → a banner");
  await h.raise("my-runner", "run-done:20261105");
  assert.equal(h.mac.length, 2);
  // at night a turned-off kind does not go into the digest
  h.set("2026-11-05T01:00");
  await h.raise("my-runner", "run-done:20261106");
  await h.raise("quota", "week-80:20261108");
  h.set("2026-11-05T08:01");
  await h.tick();
  assert.equal(h.mac.length, 3);
  assert.equal(h.mac[2].subtitle, "За ночь: 1");
  assert.ok(!/run-done/.test(h.mac[2].body));
});

test("master switch: everything is silent except security exceptions; turned-off events do not consume the rate limit", async () => {
  const h = harness({ prefs: { ...defaultPrefs(), enabled: false }, cfg: { maxPerPluginPerMin: 2 } });
  for (let i = 0; i < 5; i++) await h.raise("hermes", `job-failed-${i}`);
  await h.raise("claude-sessions", "waiting:abc");
  assert.equal(h.mac.length, 0, "not a single banner, and no \"muted for a minute\" either");
  assert.ok(h.muted().every((e) => e.reason === "all"));
  for (const k of ["app-pin-changed", "app-pin-path-changed", "app-restart-stopped", "hub-update-tag-moved:0.4.0"]) await h.raise("@hub", k);
  await h.raise("my-runner", "tamper");
  assert.equal(h.mac.length, 5, "security exceptions arrive");
  assert.ok(h.mac.slice(0, 4).every((m) => m.bannerAlways === true), "hub events bypass the shell, as before");
  // turned on — the next raise of the same plugin follows the usual rules (the limit is not used up)
  h.engine.setPrefs(defaultPrefs());
  await h.raise("hermes", "job-failed-10");
  await h.raise("hermes", "job-failed-11");
  assert.equal(h.mac.length, 7);
});

test("kind turned off after raising: the evening blocker and the waiting session do not arrive; turned on — the old ones are not resent", async () => {
  const h = harness({ start: "2026-11-04T14:00" });
  await h.raise("my-runner", "unity-open:Game");
  assert.equal(h.mac.length, 0, "during the day the blocker waits for the evening");
  h.engine.setPrefs(off("night"));
  h.set("2026-11-04T21:05");
  await h.tick();
  assert.equal(h.mac.length, 0, "by evening the kind is off — did not arrive");
  assert.equal(h.muted().length, 1);
  h.engine.setPrefs(defaultPrefs());
  h.set("2026-11-04T21:30");
  await h.tick();
  // raised while the kind was on: turning it off during the wait does not silence it forever — turned on before sending, it goes out
  assert.equal(h.mac.length, 1, "turned on before sending — the blocker arrives");
  assert.equal(h.muted().length, 1, "push-muted — once per \"off\"");
  // waiting session: on the Mac — right away; stepped away and turned off before the delayed banner — it does not go out
  h.idle = 30 * MIN;
  h.set("2026-11-05T10:00");
  await h.raise("claude-sessions", "waiting:s1");
  h.engine.setPrefs(off("sessions"));
  h.set("2026-11-05T10:10");
  await h.tick();
  assert.equal(h.mac.length, 1, "only the blocker from before");
  // raised while off and cleared — a new state after turning on arrives
  h.idle = 0;
  await h.raise("hermes", "job-failed-x");
  h.engine.setPrefs(off("runs"));
  await h.clear("hermes", "job-failed-x");
  h.t += 20 * MIN;
  await h.raise("hermes", "job-failed-x");
  const before = h.mac.length;
  h.engine.setPrefs(defaultPrefs());
  await h.clear("hermes", "job-failed-x");
  h.t += 20 * MIN;
  await h.raise("hermes", "job-failed-x");
  assert.equal(h.mac.length, before + 1);
});

test("digest: kind turned off overnight — its items do not go out in the morning; everything off — no digest", async () => {
  const h = harness({ start: "2026-11-05T01:00", idleMin: 30 });
  await h.raise("my-runner", "run-done:1");
  await h.raise("hermes", "job-failed-1");
  assert.equal(h.engine.digest.length, 2);
  h.engine.setPrefs(off("night"));
  h.set("2026-11-05T08:01");
  await h.tick();
  assert.equal(h.mac.length, 1);
  assert.equal(h.mac[0].subtitle, "За ночь: 1");
  assert.ok(h.journal.some((e) => e.type === "push-muted" && e.key === "digest" && e.count === 1));
  const h2 = harness({ start: "2026-11-05T01:00", idleMin: 30 });
  await h2.raise("hermes", "job-failed-1");
  h2.engine.setPrefs({ ...defaultPrefs(), enabled: false });
  h2.set("2026-11-05T08:01");
  await h2.tick();
  assert.equal(h2.mac.length, 0);
  assert.equal(h2.engine.digest.length, 0, "the queue does not build up until turned on");
});

test("quiet hours from \"Settings\": custom bounds, turned off — a banner right away at night; the evening blocker does not wait at night", async () => {
  const h = harness({ start: "2026-11-04T22:15", idleMin: 30, quiet: { enabled: true, start: "22:00", end: "07:00" } });
  await h.raise("hermes", "job-failed-1");
  assert.equal(h.mac.length, 0, "22:15 — already quiet hours (22:00)");
  assert.equal(h.engine.digest.length, 1);
  h.set("2026-11-05T07:01");
  await h.tick();
  assert.equal(h.mac.length, 1, "digest — after 07:00");
  // quiet hours turned off — right away at night
  h.engine.setPrefs(defaultPrefs(), { enabled: false, start: "22:00", end: "07:00" });
  h.set("2026-11-06T02:00");
  await h.raise("hermes", "job-failed-2");
  assert.equal(h.mac.length, 2);
  // an evening blocker raised at night with quiet hours off does not wait for the next evening
  await h.raise("my-runner", "unity-open:Game");
  assert.equal(h.mac.length, 3);
  // without "Settings" — config.json (quietStart/quietEnd), as before
  const c = harness({ start: "2026-11-04T22:15", idleMin: 30, cfg: { quietStart: "22:00", quietEnd: "07:00" } });
  await c.raise("hermes", "job-failed-1");
  assert.equal(c.mac.length, 0);
});

// ---------- service in the core: PUT /settings/notifications, /state, events ----------

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
function sysAs(state) {
  const procs = { 10: { ppid: 1, path: APP }, 20: { ppid: 1, path: "/usr/bin/curl" } };
  const pidOf = { app: 10, cli: 20 };
  return {
    available: true,
    peerPid: () => pidOf[state.who],
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}
function execLog(home) {
  const f = join(home, "exec.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const BATCH = () => `#!/bin/sh
# <agenthub.title>Прогоны</agenthub.title>
# <agenthub.push key="run-done" kind="night">Прогоны закончились</agenthub.push>
# <agenthub.push key="tamper" quiet="true" kind="security">Маркер подмены</agenthub.push>
# <agenthub.push key="tamper" lang="en">Tamper marker</agenthub.push>
F="$(dirname "$0")/batch-ev.txt"
echo "Прогоны | status=ok"
echo "---"
if [ -f "$F" ]; then cat "$F"; fi
`;

test("service: only app writes the setting, /state and /settings show it, a turned-off kind is silent, security is not", async () => {
  const plugins = tempHome("ah-pn-");
  writePlugin(plugins, "batch.1s.sh", BATCH());
  const state = { who: "app" };
  const h = await startHub({
    pluginsDir: plugins,
    services: "none",
    sys: sysAs(state),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' },
      services: { push: { ackTimeoutMs: 100, quietStart: "22:30" } },
    },
  });
  try {
    const st0 = (await req(h.sock, "GET", "/state")).body.notifications;
    assert.equal(st0.enabled, true);
    assert.deepEqual(Object.keys(st0.kinds), KINDS);
    const { timezone: tz0, ...q0 } = st0.quiet;
    assert.deepEqual(q0, { enabled: true, start: "22:30", end: "08:00", from: "config" });
    assert.ok(typeof tz0 === "string" && tz0, "the quiet hours timezone is in the response");
    assert.equal(st0.awayAfterMs, 10 * MIN, "the \"stepped away\" threshold comes from push settings");
    assert.equal("telegram" in st0, false, "one channel — macOS banners: no channel flag in the response");
    assert.deepEqual(st0.security.filter((s) => s.plugin === "@hub").map((s) => s.key), ["app-pin-changed", "app-pin-path-changed", "app-restart-stopped", "hub-update-tag-moved", "hub-update-suspect", "plugin-own-unexpected"]);
    await waitFor(async () => (await req(h.sock, "GET", "/settings")).body.notifications.security.some((s) => s.plugin === "batch" && s.key === "tamper"));
    const tamper = (await req(h.sock, "GET", "/settings")).body.notifications.security.find((s) => s.key === "tamper");
    assert.deepEqual(tamper, { key: "tamper", plugin: "batch", pluginTitle: "Прогоны", label: "Маркер подмены" });

    // cli — 403, input errors — 400
    state.who = "cli";
    const denied = await req(h.sock, "PUT", "/settings/notifications", { enabled: false });
    assert.equal(denied.status, 403);
    state.who = "app";
    assert.equal((await req(h.sock, "PUT", "/settings/notifications", { kinds: { security: false } })).body.error, "args:kinds:enum");
    assert.equal((await req(h.sock, "PUT", "/settings/notifications", { quiet: { start: "08:00" } })).body.error, "args:quiet:empty");

    // the plugin's "own switch" row comes from its kind="plugin" rules (here — the deprecated kind="night")
    await waitFor(async () => (await req(h.sock, "GET", "/settings")).body.notifications.plugins.length === 1);
    assert.deepEqual((await req(h.sock, "GET", "/settings")).body.notifications.plugins, [{ id: "batch", title: "Прогоны", on: true, labels: ["Прогоны закончились"] }]);
    assert.equal((await req(h.sock, "PUT", "/settings/notifications", { kinds: { night: false } })).body.error, "args:kinds:enum", "the core does not know the old kind");
    const ok = await req(h.sock, "PUT", "/settings/notifications", { plugins: { batch: false }, quiet: { end: "07:30" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.notifications.plugins[0].on, false);
    assert.equal(ok.body.notifications.kinds.night, undefined);
    assert.deepEqual({ ...ok.body.notifications.quiet, timezone: undefined }, { enabled: true, start: "22:30", end: "07:30", from: "settings", timezone: undefined });
    const file = JSON.parse(readFileSync(join(h.home, "settings.json"), "utf8"));
    assert.deepEqual(file.notifications.quiet, { enabled: true, start: "22:30", end: "07:30" });
    assert.deepEqual(file.pluginNotifications.plugins, { batch: false }, "own switches are under a separate key (the old core keeps it too)");
    assert.equal(file.notifications.plugins, undefined);
    assert.ok(h.core.recent.some((e) => e.type === "settings.changed" && e.notifications?.plugins?.[0]?.on === false));
    const jr = (await req(h.sock, "GET", "/journal?limit=50")).body;
    const entries = Array.isArray(jr) ? jr : jr.entries || [];
    assert.ok(entries.some((e) => e.type === "settings-changed" && e.key === "notifications"));

    // the push service picks up the setting from settings.json and its changes
    h.core.config.servicesFilter = "push";
    await h.core.startServices(join(import.meta.dirname, "..", "lib", "services"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(plugins, "batch-ev.txt"), "Прогоны закончились: 5 задач | event=run-done:1\n");
    await h.core.host.refresh("batch", "Manual");
    await waitFor(() => h.core.recent.some((e) => e.type === "event.raised" && e.key === "batch:run-done:1"));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!execLog(h.home).some((c) => c.file === "/usr/bin/osascript"), "turned-off kind — no banner, no osascript");
    assert.ok(!h.core.recent.some((e) => e.type === "push.notify"));
    // journal: a push-muted entry with the kind, without the event text
    const jr2 = (await req(h.sock, "GET", "/journal?limit=200")).body;
    const muted = (Array.isArray(jr2) ? jr2 : jr2.entries || []).find((e) => e.type === "push-muted");
    assert.equal(muted?.key, "batch:run-done:1");
    assert.equal(muted?.kind, "plugin");
    assert.ok(!JSON.stringify(muted).includes("5 задач"));
    // the popover (plugin state) still shows the event
    assert.ok((await req(h.sock, "GET", "/state")).body.plugins.find((p) => p.id === "batch").events.includes("run-done:1"));

    // everything off — the security exception still arrives
    assert.equal((await req(h.sock, "PUT", "/settings/notifications", { enabled: false })).status, 200);
    writeFileSync(join(plugins, "batch-ev.txt"), "Найден маркер подмены | event=tamper\n");
    await h.core.host.refresh("batch", "Manual");
    await waitFor(() => h.core.recent.some((e) => e.type === "push.notify" && e.key === "batch:tamper"));
    h.core.emit({ type: "app.restart-stopped", restarts: 3, windowMs: 600_000 });
    await waitFor(() => execLog(h.home).some((c) => c.file === "/usr/bin/osascript" && /перезапуск остановлен/.test(c.args[8] || "")));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("service: config.json without quiet hours — 23:00–08:00 by default; curl (cli) does not change the setting", async () => {
  const h = await startHub({ services: "none" });
  try {
    const n = (await req(h.sock, "GET", "/settings")).body.notifications;
    const { timezone, ...q } = n.quiet;
    assert.deepEqual(q, { enabled: true, start: "23:00", end: "08:00", from: "default" });
    assert.equal(timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, "without services.push.timezone — the system timezone");
    const c = await curl(h.sock, "PUT", "/settings/notifications", { enabled: false });
    assert.equal(c.status, 403);
    assert.equal((await req(h.sock, "GET", "/settings")).body.notifications.enabled, true);
  } finally {
    await h.stop();
  }
});

// ---------- review 2026-11-09 ----------
test("turned off for one tick while the event was waiting to be sent, and turned on — it arrives (evening blocker, waiting session)", async () => {
  const h = harness({ start: "2026-11-04T14:00" });
  await h.raise("my-runner", "unity-open:Game");
  h.engine.setPrefs({ ...defaultPrefs(), enabled: false });
  h.set("2026-11-04T15:00");
  await h.tick();
  h.engine.setPrefs(defaultPrefs());
  h.set("2026-11-04T15:01");
  await h.tick();
  h.set("2026-11-04T21:00");
  await h.tick();
  assert.equal(h.mac.length, 1, "by the time of sending everything is on — the blocker arrives");
  assert.equal(h.muted().length, 1, "the turned-off tick is recorded once");

  const s = harness({ start: "2026-11-05T14:00", idleMin: 30 });
  await s.raise("claude-sessions", "waiting:s1");
  s.engine.setPrefs({ ...defaultPrefs(), enabled: false });
  s.set("2026-11-05T14:01");
  await s.tick();
  s.engine.setPrefs(defaultPrefs());
  s.set("2026-11-05T14:02");
  await s.tick();
  s.set("2026-11-05T14:10");
  await s.tick();
  assert.equal(s.mac.length, 1, "the human stepped away for longer than 5 min — the delayed banner goes out");
  // raised while off — not resent after turning on either (as before)
  const q = harness({ start: "2026-11-04T14:00", prefs: off("night") });
  await q.raise("my-runner", "unity-open:Game");
  q.engine.setPrefs(defaultPrefs());
  q.set("2026-11-04T21:00");
  await q.tick();
  assert.equal(q.mac.length, 0);
});

test("security exceptions: config.json does not override hold, awayDelayMs, cooldownMs, label and does not intercept via an alias", async () => {
  const cases = [
    { "app-pin-changed": { hold: "evening" } },
    { "app-pin-changed": { awayDelayMs: 3600_000 } },
    { "app-pin-changed": { label: "Всё хорошо" } },
    { zzz: { aliases: ["hub-update-tag-moved:1"], hold: "evening" } },
  ];
  for (const rules of cases) {
    const h = harness({ start: "2026-11-04T14:00", idleMin: 30, prefs: { ...defaultPrefs(), enabled: false }, cfg: { rules } });
    const key = rules.zzz ? "hub-update-tag-moved:1.2.3" : "app-pin-changed";
    await h.raise("@hub", key);
    await h.clear("@hub", key);
    h.set("2026-11-05T14:00");
    await h.tick();
    assert.equal(h.mac.length, 1, `arrived with ${JSON.stringify(rules)}`);
    assert.ok(!JSON.stringify(h.mac).includes("Всё хорошо"), "the label is not replaced");
    assert.ok(!h.journal.some((e) => e.type === "push-held"));
  }
  // cooldown "for years" — the second re-pin still arrives
  const c = harness({ start: "2026-11-04T14:00", cfg: { rules: { "app-pin-changed": { cooldownMs: 1e12 } } } });
  await c.raise("@hub", "app-pin-changed");
  await c.clear("@hub", "app-pin-changed");
  c.t += MIN;
  await c.raise("@hub", "app-pin-changed");
  assert.equal(c.mac.length, 2);
  assert.ok(c.mac.every((m) => m.bannerAlways === true));
  // an ordinary config.json rule still overrides
  const o = harness({ start: "2026-11-04T14:00", cfg: { rules: { "plugin-error": { hold: "evening" } } } });
  await o.raise("hermes", "plugin-error");
  assert.equal(o.mac.length, 0, "not security — hold from config.json applies");
});

test("a plugin event with a core rule key (app-restart-stopped) is not a security exception: no bannerAlways and no hub label", async () => {
  const h = harness({ start: "2026-11-04T14:00", prefs: { ...defaultPrefs(), enabled: false } });
  await h.raise("hermes", "app-restart-stopped");
  assert.equal(h.mac.length, 0, "everything off — the plugin does not break through with a core kind");
  const h2 = harness({ start: "2026-11-04T14:00" });
  await h2.raise("hermes", "app-restart-stopped");
  assert.equal(h2.mac.length, 1);
  assert.notEqual(h2.mac[0].bannerAlways, true);
  assert.doesNotMatch(h2.mac[0].body, /перезапуск остановлен/, "the plugin does not get the hub label");
  assert.equal(kindOf({ name: "default" }, { bare: "app-restart-stopped", hub: false }), "other");
  assert.equal(kindOf({ name: "default" }, { bare: "app-restart-stopped", hub: true }), "security");
  // a trusted plugin's own kind="security" rule is still an exception
  const h3 = harness({ start: "2026-11-04T14:00", prefs: { ...defaultPrefs(), enabled: false } });
  await h3.raise("my-runner", "tamper");
  assert.equal(h3.mac.length, 1);
});

test("quiet hours starting before evening (20:00–08:00): the evening window does not stretch to a full day — the blocker waits during the day", async () => {
  for (const [start, end] of [["20:00", "08:00"], ["19:30", "07:00"], ["23:00", "08:00"]]) {
    const h = harness({ start: "2026-11-04T12:00", quiet: { enabled: true, start, end } });
    await h.raise("my-runner", "unity-open:Game");
    assert.equal(h.mac.length, 0, `${start}–${end}: at 12:00 the blocker waits`);
    h.set("2026-11-04T23:30");
    await h.tick();
    assert.equal(h.mac.length, 1, `${start}–${end}: at night it goes out`);
  }
});

test("config.json with quietStart == quietEnd (no quiet hours): shown as off, can be turned off and the start changed", () => {
  const cfg = { quietStart: "00:00", quietEnd: "00:00" };
  assert.deepEqual(effectiveQuiet(defaultPrefs(), cfg), { enabled: false, start: "23:00", end: "08:00", from: "config" });
  const off1 = applyPatch(defaultPrefs(), { quiet: { enabled: false } }, cfg);
  assert.ok(off1.prefs, JSON.stringify(off1));
  assert.equal(off1.prefs.quiet.enabled, false);
  const st = applyPatch(defaultPrefs(), { quiet: { start: "01:00" } }, cfg);
  assert.deepEqual(st.prefs.quiet, { enabled: false, start: "01:00", end: "08:00" }, "not a 23-hour 01:00–00:00 window");
  assert.equal(applyPatch(defaultPrefs(), { quiet: { enabled: true, start: "02:00", end: "02:00" } }, cfg).error, "args:quiet:empty");
  // engine: no quiet hours at 03:00 — stepped away, a banner right away (no digest)
  const h = harness({ start: "2026-11-05T03:00", idleMin: 30, quiet: effectiveQuiet(defaultPrefs(), cfg) });
  return h.raise("hermes", "job-failed-1").then(() => assert.equal(h.mac.length, 1));
});

test("digest from a file before 2026-11-09 (item without kind): a security exception does not drop out with notifications off", async () => {
  const h = harness({ start: "2026-11-05T08:30", prefs: { ...defaultPrefs(), enabled: false } });
  h.engine.digest.push({ key: "@hub:app-restart-stopped", subtitle: "", body: "Agent Hub падает", at: at("2026-11-05T02:00") });
  h.engine.digest.push({ key: "hermes:job-failed-1", subtitle: "hermes", body: "задача упала", at: at("2026-11-05T02:00") });
  await h.tick();
  assert.equal(h.mac.length, 1, "the security item went out");
  assert.match(h.mac[0].body, /Agent Hub падает/);
  assert.doesNotMatch(h.mac[0].body, /задача упала/, "the rest is still off");
});

test("a hub update failure due to a tampering sign is a security exception (hub-update-suspect), \"Updates\" do not silence it", async () => {
  const h = harness({ start: "2026-11-04T14:00", prefs: off("updates") });
  await h.raise("@hub", "hub-update-failed:0.3.0");
  assert.equal(h.mac.length, 0, "an ordinary failure — from the turned-off \"Updates\"");
  await h.raise("@hub", "hub-update-suspect:0.3.0");
  assert.equal(h.mac.length, 1);
  assert.equal(h.mac[0].bannerAlways, true);
  assert.equal(kindOf(matchRule(DEFAULT_RULES, "hub-update-suspect:0.3.0"), {}), "security");
});

test("the system timezone changed (travel) — quiet hours are computed in the new zone without restarting the service", async () => {
  const h = harness({ start: "2026-11-05T16:00", idleMin: 30 }); // 16:00 in Belgrade = 00:00 in Tokyo
  h.engine.setTimeZone("Asia/Tokyo");
  await h.raise("hermes", "job-failed-1");
  assert.equal(h.mac.length, 0, "it is night in Tokyo — into the digest");
  assert.equal(h.engine.digest.length, 1);
  assert.ok(h.journal.some((e) => e.type === "push-timezone" && e.timezone === "Asia/Tokyo"));
  const b = harness({ start: "2026-11-05T16:00", idleMin: 30 });
  await b.raise("hermes", "job-failed-1");
  assert.equal(b.mac.length, 1, "it is day in Belgrade — right away");
});

// ---------- contract 2: migrating turned-off "Night" and "Agent runs" into plugin switches ----------
test("settings migration: kinds.night/runs = false from settings.json turn off switches of plugins whose rules declared them", async () => {
  const plugins = tempHome("ah-pmig-");
  // deprecated kind="night" (contract 1), new kind="plugin" was="runs" and kind="plugin" without migration
  writePlugin(plugins, "nightly.1h.sh", `#!/bin/sh\n# <agenthub.title>Ночной</agenthub.title>\n# <agenthub.push key="done" kind="night">Готово</agenthub.push>\necho "x | status=ok"\n`);
  writePlugin(plugins, "jobs.1h.sh", `#!/bin/sh\n# <agenthub.title>Задачи</agenthub.title>\n# <agenthub.push key="job-failed" kind="plugin" was="runs">Задача упала</agenthub.push>\necho "x | status=ok"\n`);
  writePlugin(plugins, "fresh.1h.sh", `#!/bin/sh\n# <agenthub.title>Новый</agenthub.title>\n# <agenthub.push key="ping" kind="plugin">Пинг</agenthub.push>\necho "x | status=ok"\n`);
  writePlugin(plugins, "chosen.1h.sh", `#!/bin/sh\n# <agenthub.title>Выбранный</agenthub.title>\n# <agenthub.push key="x" kind="runs">X</agenthub.push>\necho "x | status=ok"\n`);
  // contract 1 settings.json: "Night" and "Agent runs" are off, "chosen" already has an explicit choice
  const settingsFile = { lang: "ru", notifications: { enabled: true, kinds: { sessions: true, runs: false, night: false, updates: true }, plugins: { chosen: true } } };
  const h = await startHub({ pluginsDir: plugins, services: "none", settingsFile });
  const home = h.home;
  try {
    const rows = await waitFor(async () => {
      const n = (await req(h.sock, "GET", "/state")).body.notifications;
      return n.plugins.length === 4 ? n.plugins : null;
    });
    const on = Object.fromEntries(rows.map((r) => [r.id, r.on]));
    assert.deepEqual(on, { nightly: false, jobs: false, fresh: true, chosen: true });
    // core kinds — only shared ones; no old kinds in the response
    assert.deepEqual(Object.keys((await req(h.sock, "GET", "/state")).body.notifications.kinds), KINDS);
    // the migration is pinned by an explicit choice: the plugin may change kind="night" to kind="plugin" without was= — the choice survives
    const file = await waitFor(() => {
      const f = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
      return f.pluginNotifications?.plugins?.nightly === false && f.pluginNotifications?.plugins?.jobs === false && f.pluginNotifications?.legacyFor ? f : null;
    });
    // rollback to a contract 1 core: turned-off old kinds are where the old core reads them
    assert.equal(file.notifications.kinds.runs, false);
    assert.equal(file.notifications.kinds.night, false);
    assert.equal(file.notifications.legacy, undefined);
    assert.equal(file.pluginNotifications.plugins.chosen, true, "migration does not touch a human's explicit choice");
    assert.equal(file.pluginNotifications.plugins.fresh, undefined);
    // migration is one-off: it applies to plugins installed at the first scan
    assert.deepEqual([...file.pluginNotifications.legacyFor].sort(), ["chosen", "fresh", "jobs", "nightly"]);
    // the "turned off by migration" mark stays until the human touches the switch
    assert.deepEqual(file.pluginNotifications.migrated, { nightly: ["night"], jobs: ["runs"] });
    assert.deepEqual(rows.filter((r) => r.legacy).map((r) => r.id).sort(), ["jobs", "nightly"]);
    const st = await waitFor(async () => {
      const n = (await req(h.sock, "GET", "/state")).body.notifications;
      return n.plugins.find((r) => r.id === "nightly")?.legacy ? n : null;
    });
    assert.equal(st.plugins.find((r) => r.id === "chosen").legacy, undefined);
    const { applyPatch } = await import("../lib/push/prefs.mjs");
    const { prefsFromFile, normPrefs: norm, pluginToggle } = await import("../lib/push/prefs.mjs");
    const touched = applyPatch(norm(prefsFromFile(file)), { plugins: { nightly: false } }).prefs;
    assert.deepEqual(touched.migrated, { jobs: ["runs"] }, "the human chose themselves — the mark is cleared");
    assert.ok(h.core.journal.tail(200).some((e) => e.type === "settings-migrated" && e.plugin === "nightly"));
    // a plugin installed after migration is not turned off by the old setting, even with was=
    const later = norm(prefsFromFile(file));
    assert.equal(pluginToggle(later, "late", [{ key: "k", kind: "plugin", legacyKind: "night" }]), true);
    assert.equal(pluginToggle(later, "nightly", [{ key: "done", kind: "plugin", legacyKind: "night" }]), false);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("a plugin's own switch: when off it silences only that plugin's kind=plugin rules — immediately and in the digest", async () => {
  const h = harness({ prefs: offPlugins("hermes") });
  await h.raise("hermes", "job-failed-1");
  assert.equal(h.mac.length, 0);
  assert.deepEqual(h.muted().map((e) => [e.key, e.kind]), [["hermes:job-failed-1", "plugin"]]);
  await h.raise("my-runner", "run-done:1");
  assert.equal(h.mac.length, 1, "another plugin's switch is untouched");
  await h.raise("hermes", "source-broken");
  assert.equal(h.mac.length, 2, "a shared core kind of the same plugin follows its own switch");
  // at night the item goes into the digest, and by morning the switch was turned off — it is not there in the morning
  const d = harness({ start: "2026-11-05T01:00", idleMin: 30 });
  await d.raise("hermes", "job-failed-2");
  await d.raise("my-runner", "run-done:2");
  assert.equal(d.engine.digest.length, 2);
  d.engine.setPrefs(offPlugins("my-runner"));
  d.set("2026-11-05T08:01");
  await d.tick();
  assert.equal(d.mac.length, 1);
  assert.equal(d.mac[0].subtitle, "За ночь: 1");
  assert.ok(!/run-done/.test(d.mac[0].body));
});

test("settings migration survives a hub rollback to a contract 1 core and back", async () => {
  const { normPrefs: norm, prefsFromFile, prefsToFile, pluginToggle } = await import("../lib/push/prefs.mjs");
  // v2 migrated the turned-off runs/night and pinned the switches
  const v2 = norm({ kinds: { runs: false, night: false }, plugins: { hermes: false, nr: false, chosen: true }, migrated: { hermes: ["runs"], nr: ["night"] }, legacyFor: ["hermes", "nr", "chosen"] });
  const file = { lang: "ru", ...prefsToFile(v2) };
  // old core: Settings.load merges the top level ({...data, ...d}), normPrefs v1 takes only enabled/kinds/quiet
  const v1Kinds = { sessions: true, runs: true, night: true, updates: true, problems: true, other: true };
  for (const k of Object.keys(v1Kinds)) if (typeof file.notifications.kinds[k] === "boolean") v1Kinds[k] = file.notifications.kinds[k];
  assert.equal(v1Kinds.runs, false, "the old core sees \"Runs\" as off — they do not ring");
  assert.equal(v1Kinds.night, false);
  // the old core saves settings (the human edits quiet hours): notifications in its own form, the rest as it was
  const afterV1 = { ...file, notifications: { enabled: true, kinds: v1Kinds, quiet: { enabled: true, start: "22:00", end: "08:00" } } };
  const back = norm(prefsFromFile(afterV1));
  assert.equal(pluginToggle(back, "hermes", [{ kind: "plugin", legacyKind: "runs" }]), false, "after updating again the choice survives");
  assert.equal(pluginToggle(back, "chosen", []), true);
  assert.deepEqual(back.migrated, { hermes: ["runs"], nr: ["night"] });
  // in the old hub the human turned "Runs" back on — the migration result for runs is cleared, the explicit choice and night stay
  const reenabled = norm(prefsFromFile({ ...afterV1, notifications: { ...afterV1.notifications, kinds: { ...v1Kinds, runs: true } } }));
  assert.equal(reenabled.plugins.hermes, undefined);
  assert.equal(pluginToggle(reenabled, "hermes", [{ kind: "plugin", legacyKind: "runs" }]), true);
  assert.equal(reenabled.plugins.nr, false);
  assert.equal(reenabled.plugins.chosen, true);
});
