// Push: dedup, quiet hours, digest, evening blocker, waiting session, presence (idle time), all on doubles
// for time, idleness, the macOS sender and storage. Nothing goes out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePushConfig } from "../lib/push/config.mjs";
import { PushEngine } from "../lib/push/engine.mjs";
import { memoryStore } from "../lib/push/store.mjs";
import { readFileSync } from "node:fs";
import { parseMetaText } from "../lib/meta.mjs";

const MIN = 60_000;
// Europe/Belgrade in November is UTC+1.
const at = (local) => Date.parse(`${local}:00+01:00`);

// Rules that trusted plugins declare themselves (<agenthub.push> → meta.push; the core puts them into the state of
// built-in and official plugins). Synthetic data shaped like the registry's official plugins.
// Since contract 2, session, background run and evening blocker events are declared by the plugins themselves (kind="plugin"
// is the plugin's own toggle; was is the previous kind, for migrating the toggle).
// the built-in quota plugin's rules come straight from its metadata (not in the core table since contract 2)
const QUOTA_RULES = parseMetaText(readFileSync(new URL("../../plugins/quota/quota.5m.mjs", import.meta.url), "utf8")).meta.push;
const OWN_RULES = {
  quota: QUOTA_RULES,
  "claude-sessions": [{ key: "session-died", label: "Сессия оборвалась посреди работы", kind: "plugin", legacyKind: "runs" }],
  agents: [
    { key: "workflow-failed", label: "Фоновый прогон упал", kind: "plugin", legacyKind: "runs" },
    { key: "workflow-orphaned", label: "Фоновый прогон остался без сессии", kind: "plugin", legacyKind: "runs" },
  ],
  "my-runner": [
    { key: "blocker", label: "Есть блокер", hold: "evening", cooldownMs: 0, kind: "plugin", legacyKind: "night" },
    { key: "run-blocker", label: "Прогоны не запустятся", hold: "evening", cooldownMs: 0 },
    { key: "run-done", label: "Прогоны закончились" },
    { key: "runner-crashed", label: "Раннер упал", quietException: true },
    { key: "tamper-marker", label: "Маркер подмены", quietException: true },
  ],
  // an older plugin still declares macOnly (from when the hub had a second channel): accepted and ignored
  gateway: [{ key: "gateway-silent", label: "Gateway молчит", macOnly: true }],
};

function harness({ start = "2026-11-04T14:00", idleMin = 0, cfg = {}, plugins = {}, store = memoryStore() } = {}) {
  const h = {
    t: at(start),
    idle: idleMin == null ? null : idleMin * MIN,
    mac: [],
    journal: [],
    store,
  };
  const config = resolvePushConfig({ timezone: "Europe/Belgrade", ...cfg });
  h.engine = new PushEngine({
    config,
    now: () => h.t,
    presence: async () => h.idle,
    mac: { notify: (m) => (h.mac.push(m), { notifyId: String(h.mac.length), done: Promise.resolve({ ok: true }) }) },
    lookup: (plugin, bare) =>
      plugins[plugin] ?? { pluginTitle: plugin === "my-runner" ? "Прогоны" : plugin, itemTitle: `пункт ${bare}`, trusted: true, rules: OWN_RULES[plugin] || null },
    store,
    journal: (e) => h.journal.push(e),
  });
  h.set = (local) => (h.t = at(local));
  h.raise = (plugin, key) => h.engine.raised({ plugin, key: `${plugin}:${key}` });
  h.clear = (plugin, key) => h.engine.cleared({ plugin, key: `${plugin}:${key}` });
  h.tick = () => h.engine.tick();
  h.sent = () => h.mac.length;
  return h;
}

test("dedup: one state, one message; bouncing is suppressed; after the window, again", async () => {
  const h = harness();
  await h.raise("claude-sessions", "session-died:aaa");
  await h.raise("claude-sessions", "session-died:aaa");
  await h.tick();
  assert.equal(h.mac.length, 1);
  // the label goes in the subtitle next to the plugin name, the body is the detail
  assert.equal(h.mac[0].subtitle, "claude-sessions · Сессия оборвалась посреди работы");
  assert.equal(h.mac[0].body, "пункт session-died:aaa");
  await h.clear("claude-sessions", "session-died:aaa");
  h.t += 2 * MIN;
  await h.raise("claude-sessions", "session-died:aaa");
  assert.equal(h.mac.length, 1, "a repeat within 10 min after sending is bouncing");
  assert.ok(h.journal.some((e) => e.type === "push-suppressed"));
  await h.clear("claude-sessions", "session-died:aaa");
  h.t += 15 * MIN;
  await h.raise("claude-sessions", "session-died:aaa");
  assert.equal(h.mac.length, 2, "a new state after the window is a new message");
  // different keys, different messages
  await h.raise("claude-sessions", "session-died:bbb");
  assert.equal(h.mac.length, 3);
});

test("presence: banners are the only channel — at the Mac, away (outside quiet hours) and unknown, all a banner right away", async () => {
  let h = harness({ idleMin: 3 });
  await h.raise("agents", "workflow-failed:wf1");
  assert.equal(h.mac.length, 1);

  h = harness({ idleMin: 30 });
  await h.raise("agents", "workflow-failed:wf1");
  assert.equal(h.mac.length, 1, "away during the day: the banner waits in Notification Center");
  assert.deepEqual([h.mac[0].subtitle, h.mac[0].body], ["agents · Фоновый прогон упал", "пункт workflow-failed:wf1"]);
  assert.ok(h.journal.some((e) => e.type === "push-sent" && e.channel === "mac"));
  assert.ok(!h.journal.some((e) => e.type === "push-fallback"), "no second channel — no fallback");

  h = harness({ idleMin: null });
  await h.raise("agents", "workflow-failed:wf1");
  assert.equal(h.mac.length, 1, "idleness unknown: counts as at the Mac");
});

test("quiet hours, the person away: only urgent ones (quietException) show right away, the rest — one digest banner after quiet hours", async () => {
  const h = harness({ start: "2026-11-05T01:00", idleMin: 120 });
  await h.raise("my-runner", "runner-crashed");
  await h.raise("my-runner", "tamper-marker");
  await h.raise("my-runner", "run-done:20261105");
  await h.raise("quota", "token-lost");
  await h.raise("claude-sessions", "session-died:x");
  assert.equal(h.mac.length, 2);
  assert.match(h.mac[0].subtitle, /Раннер упал/);
  assert.match(h.mac[1].subtitle, /Маркер подмены/);
  assert.equal(h.engine.digest.length, 3);
  assert.equal(h.journal.filter((e) => e.type === "push-deferred").length, 3);
  await h.clear("claude-sessions", "session-died:x");
  h.set("2026-11-05T07:59");
  await h.tick();
  assert.equal(h.mac.length, 2, "no digest before 08:00");
  h.set("2026-11-05T08:00");
  await h.tick();
  assert.equal(h.mac.length, 3, "the digest is one banner");
  const d = h.mac[2];
  assert.equal(d.subtitle, "За ночь: 3");
  assert.equal(d.digest, true);
  assert.equal(d.body, "пункт run-done:20261105; пункт token-lost; пункт session-died:x");
  assert.ok(h.journal.some((e) => e.type === "push-digest" && e.count === 3 && e.channel === "mac"));
  await h.tick();
  assert.equal(h.mac.length, 3, "the digest does not repeat");
  // raised at night and still active in the morning: not sent again
  await h.raise("quota", "token-lost");
  assert.equal(h.mac.length, 3);
});

test("quiet hours but the person is at the Mac: macOS right away; the digest at the Mac is one macOS notification", async () => {
  const h = harness({ start: "2026-11-05T00:30", idleMin: 1 });
  await h.raise("agents", "workflow-orphaned:wf2");
  assert.equal(h.mac.length, 1);
  h.idle = 60 * MIN;
  await h.raise("agents", "workflow-failed:wf3");
  assert.equal(h.engine.digest.length, 1);
  h.set("2026-11-05T09:00");
  h.idle = 0;
  await h.tick();
  assert.equal(h.mac.length, 2);
  assert.equal(h.mac[1].subtitle, "За ночь: 1");
  assert.equal(h.mac[1].digest, true);
});

test("evening blocker: during the day waits for 21:00, in the evening right away, repeats once per night, cleared before 21:00 is not sent", async () => {
  const h = harness({ start: "2026-11-04T14:00", idleMin: 30 });
  await h.raise("my-runner", "run-blocker:unity");
  assert.equal(h.sent(), 0);
  assert.ok(h.journal.some((e) => e.type === "push-held"));
  h.set("2026-11-04T20:59");
  await h.tick();
  assert.equal(h.sent(), 0);
  h.set("2026-11-04T21:00");
  await h.tick();
  assert.equal(h.mac.length, 1);
  assert.deepEqual([h.mac[0].subtitle, h.mac[0].body], ["Прогоны не запустятся", "пункт run-blocker:unity"]);
  h.set("2026-11-04T22:30");
  await h.tick();
  h.set("2026-11-05T02:00");
  await h.tick();
  h.set("2026-11-05T12:00");
  await h.tick();
  assert.equal(h.mac.length, 1, "the same night and the next day before 21:00: no repeats");
  assert.equal(h.engine.digest.length, 0);
  h.set("2026-11-05T21:00");
  await h.tick();
  assert.equal(h.mac.length, 2, "the next evening the blocker is still there: a reminder");

  // cleared before 21:00: stay silent
  const h2 = harness({ start: "2026-11-04T10:00", idleMin: 30 });
  await h2.raise("my-runner", "run-blocker:power");
  h2.set("2026-11-04T18:00");
  await h2.clear("my-runner", "run-blocker:power");
  h2.set("2026-11-04T21:00");
  await h2.tick();
  assert.equal(h2.sent(), 0);

  // appeared after 21:00: right away; at the Mac via macOS
  const h3 = harness({ start: "2026-11-04T22:10", idleMin: 0 });
  await h3.raise("my-runner", "run-blocker:quota");
  assert.equal(h3.mac.length, 1);
  // bouncing in the evening of the same night: no repeat
  await h3.clear("my-runner", "run-blocker:quota");
  h3.t += 30 * MIN;
  await h3.raise("my-runner", "run-blocker:quota");
  await h3.tick();
  assert.equal(h3.mac.length, 1);

  // appeared during quiet hours with the person away: into the digest; again in the evening if not resolved
  const h4 = harness({ start: "2026-11-05T03:00", idleMin: 60 });
  await h4.raise("my-runner", "run-blocker:unity");
  assert.equal(h4.engine.digest.length, 1);
  h4.set("2026-11-05T08:00");
  await h4.tick();
  assert.equal(h4.mac.length, 1);
  assert.equal(h4.mac[0].digest, true);
  h4.set("2026-11-05T21:00");
  await h4.tick();
  assert.equal(h4.mac.length, 2);
});

test("session waiting: at the Mac → a banner right away; away → a banner once back at the Mac or after 5 min, once", async () => {
  const h = harness({ idleMin: 30 });
  await h.raise("claude-sessions", "session-waiting:s1");
  assert.equal(h.sent(), 0, "away: wait first");
  h.t += 4 * MIN;
  await h.tick();
  assert.equal(h.sent(), 0);
  h.t += 1 * MIN;
  await h.tick();
  assert.equal(h.mac.length, 1, "still away after 5 min: the banner goes anyway");
  assert.match(h.mac[0].subtitle, /Сессия ждёт вас/);
  h.t += 10 * MIN;
  await h.tick();
  assert.equal(h.sent(), 1);

  // at the Mac: a banner right away; stepping away later adds nothing
  const h2 = harness({ idleMin: 1 });
  await h2.raise("claude-sessions", "session-waiting:s2");
  assert.equal(h2.mac.length, 1);
  h2.t += 6 * MIN;
  h2.idle = 12 * MIN;
  await h2.tick();
  await h2.tick();
  assert.equal(h2.mac.length, 1);

  // away but back within 5 minutes: the banner when the person is back, once
  const h3 = harness({ idleMin: 30 });
  await h3.raise("claude-sessions", "session-waiting:s3");
  h3.t += 3 * MIN;
  h3.idle = 0;
  await h3.tick();
  assert.equal(h3.mac.length, 1);
  h3.t += 5 * MIN;
  await h3.tick();
  assert.equal(h3.mac.length, 1);

  // answered within 5 minutes: nothing
  const h4 = harness({ idleMin: 30 });
  await h4.raise("claude-sessions", "session-waiting:s4");
  h4.t += 2 * MIN;
  await h4.clear("claude-sessions", "session-waiting:s4");
  h4.t += 10 * MIN;
  await h4.tick();
  assert.equal(h4.sent(), 0);

  // a new request from the same session after an answer is a new message (no bounce window)
  const h5 = harness({ idleMin: 0 });
  await h5.raise("claude-sessions", "session-waiting:s5");
  await h5.clear("claude-sessions", "session-waiting:s5");
  h5.t += MIN;
  await h5.raise("claude-sessions", "session-waiting:s5");
  assert.equal(h5.mac.length, 2);

  // during quiet hours, away for longer than 5 min: not urgent — into the morning digest
  const h6 = harness({ start: "2026-11-05T01:00", idleMin: 60 });
  await h6.raise("claude-sessions", "session-waiting:s6");
  h6.t += 5 * MIN;
  await h6.tick();
  assert.deepEqual([h6.mac.length, h6.engine.digest.length], [0, 1]);
});

test("macOnly from an older plugin is ignored (night, away — the digest); a third-party plugin: without its own text", async () => {
  const h = harness({
    idleMin: 60,
    plugins: { evil: { pluginTitle: "Evil", itemTitle: "секрет: hunter2", trusted: false, rules: [{ key: "run-blocker", label: "Чужой ярлык", quietException: true }] } },
  });
  await h.raise("gateway", "gateway-silent");
  assert.equal(h.mac.length, 1);
  await h.raise("evil", "run-blocker");
  assert.equal(h.mac.length, 2);
  assert.equal(h.mac[1].body, "Событие «run-blocker»", "a foreign plugin does not get the hub label and does not pass its own text or rules");
  assert.equal(h.mac[1].subtitle, "Evil");
  // at night with the person away macOnly no longer bypasses the digest: it means nothing now
  const n = harness({ start: "2026-11-05T02:00", idleMin: 60 });
  await n.raise("gateway", "gateway-silent");
  assert.deepEqual([n.mac.length, n.engine.digest.length], [0, 1]);
  assert.equal(n.engine.ruleFor("gateway-silent", true, OWN_RULES.gateway, "gateway").macOnly, undefined);
  assert.equal(n.engine.ruleFor("x", false, null, "evil").macOnly, undefined);
});

test("quota: once a week", async () => {
  const h = harness({ idleMin: 0 });
  await h.raise("quota", "week-80");
  await h.clear("quota", "week-80");
  h.t += 2 * 24 * 60 * MIN;
  await h.raise("quota", "week-80");
  assert.equal(h.mac.length, 1);
  await h.clear("quota", "week-80");
  h.t += 6 * 24 * 60 * MIN;
  await h.tick();
  await h.raise("quota", "week-80");
  assert.equal(h.mac.length, 2);
});

test("quota: a new week's alert arrives even if less than 7 days passed since the last one (key with the reset date)", async () => {
  const h = harness({ idleMin: 0 });
  await h.raise("quota", "week-80:20261109"); // the week with reset on Mon 2026-11-09
  assert.equal(h.mac.length, 1);
  await h.clear("quota", "week-80:20261109");
  h.t += 6 * 24 * 60 * MIN; // 6 days later it is already the next quota week
  await h.tick();
  await h.raise("quota", "week-80:20261116");
  assert.equal(h.mac.length, 2);
  // the same week again (bouncing) is not sent
  await h.clear("quota", "week-80:20261116");
  h.t += 60 * MIN;
  await h.tick();
  await h.raise("quota", "week-80:20261116");
  assert.equal(h.mac.length, 2);
});

test("restart: what was sent does not repeat; what is not raised again is cleared after a pause", async () => {
  const store = memoryStore();
  const h = harness({ store, idleMin: 0 });
  await h.raise("agents", "workflow-failed:wf1");
  await h.raise("agents", "workflow-failed:wf2");
  assert.equal(h.mac.length, 2);
  const h2 = harness({ store, idleMin: 0, start: "2026-11-04T14:05" });
  h2.engine.load();
  await h2.raise("agents", "workflow-failed:wf1");
  assert.equal(h2.mac.length, 0, "the same key after a restart: no repeat");
  h2.set("2026-11-04T14:20");
  await h2.tick();
  const wf2 = h2.engine.entries.get("agents:workflow-failed:wf2");
  assert.equal(wf2.active, false, "not raised after the restart counts as cleared");
  assert.equal(h2.engine.entries.get("agents:workflow-failed:wf1").active, true);
  // the digest queue survives a restart
  const s3 = memoryStore();
  const h3 = harness({ store: s3, idleMin: 60, start: "2026-11-05T02:00" });
  await h3.raise("agents", "workflow-failed:n");
  const h4 = harness({ store: s3, idleMin: 60, start: "2026-11-05T08:30" });
  h4.engine.load();
  await h4.tick();
  assert.equal(h4.mac.length, 1);
  assert.equal(h4.mac[0].subtitle, "За ночь: 1");
});

test("state from a build that still had a second channel: an entry marked sentTg counts as delivered", async () => {
  const store = memoryStore();
  store.save({ version: 1, entries: [{ key: "agents:workflow-failed:old", plugin: "agents", bare: "workflow-failed:old", trusted: true, active: true, raisedAt: at("2026-11-04T13:00"), lastSentAt: at("2026-11-04T13:00"), sentMac: false, sentTg: true, queued: false, msg: { subtitle: "x", body: "y" } }], digest: [], lastDigestAt: null });
  const h = harness({ store, idleMin: 0 });
  h.engine.load();
  assert.equal(h.engine.entries.get("agents:workflow-failed:old").sentTg, undefined);
  await h.raise("agents", "workflow-failed:old");
  await h.tick();
  assert.equal(h.mac.length, 0, "already delivered before the update: no second banner");
});

test("time zone from settings: the same moment is quiet in Belgrade and not quiet in New York", async () => {
  const t = Date.parse("2026-11-04T23:30:00Z"); // 00:30 Belgrade, 18:30 New York
  for (const [tz, expectNow] of [["Europe/Belgrade", 0], ["America/New_York", 1]]) {
    const h = harness({ idleMin: 60, cfg: { timezone: tz } });
    h.t = t;
    await h.raise("agents", "workflow-failed:z");
    assert.equal(h.mac.length, expectNow, tz);
    assert.equal(h.engine.digest.length, 1 - expectNow, tz);
  }
});

test("text: control characters are stripped, length is limited; the journal has no text", async () => {
  const h = harness({
    idleMin: 60,
    plugins: { p: { pluginTitle: "P\nlug", itemTitle: "строка\u0000\nдва" + "x".repeat(500), trusted: true } },
  });
  await h.raise("p", "plugin-error");
  assert.equal(h.mac.length, 1);
  const { subtitle, body } = h.mac[0];
  assert.equal(subtitle, "P lug · Плагин перестал работать");
  assert.ok(body.startsWith("строка два"));
  assert.ok(body.length <= 160);
  for (const e of h.journal) {
    for (const v of Object.values(e)) assert.ok(!String(v).includes("строка"), "the item text does not reach the journal");
  }
});

test("invalid events are ignored", async () => {
  const h = harness();
  await h.engine.raised({ plugin: "a", key: "b:c" });
  await h.engine.raised({ plugin: "a", key: "a:" });
  await h.engine.raised({});
  await h.engine.cleared({ key: "нет" });
  assert.equal(h.sent(), 0);
});

test("core keys are in the table rules; plugin (and built-in) events come from their metadata; plugin rules take precedence", async () => {
  const { buildRules, matchRule, pluginRules, DEFAULT_RULES } = await import("../lib/push/rules.mjs");
  const rules = buildRules();
  const cases = {
    "waiting:11111111-1111-4111-8111-111111111111": "session-waiting",
    "auth-failed": "auth-failed",
    "source-broken": "source-broken",
  };
  for (const [key, rule] of Object.entries(cases)) assert.equal(matchRule(rules, key).name, rule, key);
  // the quota is declared by the built-in quota plugin with its own tags (once a week, "failures and warnings"), not by the core table
  for (const key of ["week-80:20261109", "pace-85:20261109", "token-lost"]) assert.equal(matchRule(rules, key).name, "default", key);
  const q = pluginRules(QUOTA_RULES);
  assert.deepEqual(["week-80:20261109", "pace-85:20261109", "token-lost"].map((k) => [matchRule(q, k).name, matchRule(q, k).kind, matchRule(q, k).cooldownMs ?? null]), [["week-80", "problems", 7 * 24 * 60 * MIN], ["pace-85", "problems", 7 * 24 * 60 * MIN], ["token-lost", "problems", null]]);
  assert.equal(matchRule(rules, "something-else").name, "default");
  // contract 2: runs, dead sessions and evening blockers are declared by plugins and are not in the core table
  for (const key of ["died:x", "wf-failed-wf_1", "wf-orphaned-wf_1", "blocker:unity"]) assert.equal(matchRule(rules, key).name, "default", key);
  // the core table knows nothing about plugins: no names and no per-plugin kinds
  assert.ok(!JSON.stringify(DEFAULT_RULES).match(/night|hermes|clickup|runner|"runs"|workflow|blocker/i));
  assert.ok(DEFAULT_RULES.every((r) => ["sessions", "updates", "problems", "other", "security"].includes(r.kind)));
  const own = pluginRules([{ key: "unity-open", label: "Прогоны не запустятся", hold: "evening", cooldownMs: 0 }, { key: "bad key!" }, { key: "job-failed", label: "x".repeat(200) }]);
  assert.deepEqual(own.map((r) => r.name), ["unity-open", "job-failed"]);
  assert.equal(matchRule(own, "unity-open:Game").hold, "evening");
  assert.equal(matchRule(own, "job-failed-bbbb33334444").label.length, 80);
  // a trusted plugin with its own rule: label and hold from the rule; without a rule, the shared table
  const h = harness({ start: "2026-11-04T14:00", idleMin: 0, plugins: { nr: { pluginTitle: "Прогоны", itemTitle: "Unity", trusted: true, rules: [{ key: "unity-open", label: "Прогоны не запустятся", hold: "evening", cooldownMs: 0 }] } } });
  await h.raise("nr", "unity-open:Game");
  assert.equal(h.sent(), 0, "hold=evening from the plugin rule");
  await h.raise("nr", "source-broken");
  assert.match(h.mac[0].subtitle, /^Прогоны · Плагин не может прочитать данные/);
  assert.equal(h.mac[0].body, "Unity");
  h.set("2026-11-04T21:00");
  await h.tick();
  assert.equal(h.mac[1].subtitle, "Прогоны не запустятся");
  assert.equal(h.mac[1].body, "Unity");
});

// Migration pass review: official plugin rules live in their metadata, but the user's services.push.rules
// has the last word ("<plugin>:<name>" or "<name>").
test("a user override on top of a plugin rule: by \"<plugin>:<name>\" only that plugin, by \"<name>\" every plugin; macOnly is not a field", async () => {
  let h = harness({ idleMin: 0, cfg: { rules: { "gateway:gateway-silent": { label: "Мой ярлык", macOnly: false } } } });
  assert.equal(h.engine.ruleFor("gateway-silent", true, OWN_RULES.gateway, "other").label, "Gateway молчит", "another plugin is not affected");
  await h.raise("gateway", "gateway-silent");
  assert.match(h.mac[0].subtitle, /Мой ярлык/);
  assert.equal(h.engine.ruleFor("gateway-silent", true, OWN_RULES.gateway, "gateway").macOnly, undefined, "macOnly from config.json is ignored");
  h = harness({ idleMin: 0, cfg: { rules: { "gateway-silent": { label: "Общий ярлык" } } } });
  await h.raise("gateway", "gateway-silent");
  assert.match(h.mac[0].subtitle, /Общий ярлык/);
});

test("event flood from a plugin: notification and entry limits, one file write per batch, the event loop stays free (review)", async () => {
  let saves = 0;
  const base = memoryStore();
  const store = { ...base, save: (o) => (saves++, base.save(o)) };
  const h = harness({ store, plugins: { evil: { trusted: false, pluginTitle: "evil" } } });
  let timerFired = false;
  setTimeout(() => (timerFired = true), 0);
  const all = [];
  for (let i = 0; i < 300; i++) all.push(h.raise("evil", `k:${i}`));
  await Promise.all(all);
  assert.ok(timerFired, "the timer fired while the queue ran: the queue yields the event loop");
  // 5 regular notifications (third-party plugin) + one "muted"
  assert.equal(h.mac.length, 6);
  assert.match(h.mac[5].body, /приглушены/);
  assert.ok(h.journal.some((e) => e.type === "push-throttled" && e.plugin === "evil"));
  // no more active entries than the limit can be kept: extra keys are not remembered
  assert.ok(h.engine.entries.size <= 100, `entries: ${h.engine.entries.size}`);
  assert.ok(h.journal.some((e) => e.type === "push-dropped" && e.reason === "too-many-keys"));
  assert.equal(h.journal.filter((e) => e.type === "push-dropped").length, 1, "refusals within a minute: one entry");
  assert.ok(saves <= 3, `file writes: ${saves}`);
  // cleared ones are pushed out by new ones; after a minute, regular notifications again
  for (let i = 0; i < 100; i++) await h.clear("evil", `k:${i}`);
  h.t += 61 * MIN;
  await h.raise("evil", "fresh");
  assert.equal(h.mac.length, 7);
  assert.ok(h.engine.entries.size <= 100);
  // hub events have no per-plugin limits
  for (let i = 0; i < 30; i++) await h.engine.raised({ plugin: "@hub", key: `@hub:plugin-update:p${i}:1.0.0` });
  assert.equal(h.mac.length, 37);
});

test("\"no room for an entry\" refusals do not flood the journal: one entry per minute and a summary with a count (regression review)", async () => {
  const h = harness({ plugins: { evil: { trusted: false, pluginTitle: "evil" } } });
  for (let i = 0; i < 100; i++) await h.raise("evil", `k:${i}`);
  // 10 frames of 300 new unique event= with 100 keys raised
  for (let f = 0; f < 10; f++) for (let i = 0; i < 300; i++) await h.raise("evil", `n:${f}:${i}`);
  const drops = () => h.journal.filter((e) => e.type === "push-dropped");
  assert.equal(drops().length, 1);
  assert.equal(h.engine.entries.size, 100);
  // a minute passed: one summary with a count on the tick
  h.t += 61 * MIN;
  await h.tick();
  assert.equal(drops().length, 2);
  assert.equal(drops()[1].dropped, 2999);
  await h.tick();
  assert.equal(drops().length, 2, "the summary does not repeat");
  // a new minute: again one entry for the first refusal
  await h.raise("evil", "again");
  assert.equal(drops().length, 3);
  assert.equal(drops()[2].dropped, undefined);
});

test("plugin push: the name and phrase do not repeat; the label without \"<plugin>:\", the detail as the body, the label in the subtitle", async () => {
  const h = harness({
    plugins: {
      hermes: { pluginTitle: "Hermes", itemTitle: "demo: утренний итог — упала, следующая 05.11 09:30", trusted: true, rules: [{ key: "job-failed", label: "Hermes: задача упала" }, { key: "ticker-silent", label: "Hermes: расписание остановилось" }] },
      quota: { pluginTitle: "Квота", itemTitle: "При таком темпе 85% наступит вс 08.11 12:36 — раньше сброса", trusted: true, rules: QUOTA_RULES },
      "claude-sessions": { pluginTitle: "Сессии", itemTitle: "Game — Level editor — ждёт вас · меньше минуты", trusted: true },
    },
  });
  await h.raise("hermes", "job-failed:demo");
  assert.deepEqual([h.mac[0].subtitle, h.mac[0].body], ["Hermes · задача упала", "demo: утренний итог — упала, следующая 05.11 09:30"]);
  await h.raise("quota", "pace-85");
  assert.deepEqual([h.mac[1].subtitle, h.mac[1].body], ["Квота", "При таком темпе 85% наступит вс 08.11 12:36 — раньше сброса"], "the detail already says the same, so no label");
  await h.raise("claude-sessions", "session-waiting:aaa");
  assert.deepEqual([h.mac[2].subtitle, h.mac[2].body], ["Сессии", "Game — Level editor — ждёт вас · меньше минуты"]);
  const { stripTitle, saysSame } = await import("../lib/push/engine.mjs");
  assert.equal(stripTitle("Hermes: расписание остановилось", "Hermes"), "расписание остановилось");
  assert.equal(stripTitle("Hermes:", "Hermes"), "Hermes:", "an empty remainder keeps the label as is");
  assert.ok(saysSame("расписание остановилось", "Профиль demo-bot: расписание остановилось (отклик 4 мин назад)"));
  assert.ok(!saysSame("задача упала", "demo: утренний итог — упала"));
});
