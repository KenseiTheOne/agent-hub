// Push: time zones, quiet hours, the "night day", the event table, HIDIdleTime parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBucket, inWindow, localParts, makeClock, parseHM, validTimeZone } from "../lib/push/clock.mjs";
import { buildRules, matchRule } from "../lib/push/rules.mjs";
import { createPresence, parseHidIdle } from "../lib/push/idle.mjs";
import { ignoredKeys, resolvePushConfig } from "../lib/push/config.mjs";

const ms = (iso) => Date.parse(iso);
const Q = { quietStart: parseHM("23:00"), quietEnd: parseHM("08:00"), eveningAt: parseHM("21:00") };

test("one instant — different local times in different zones", () => {
  const t = ms("2026-11-04T22:30:00Z");
  assert.equal(localParts(t, "Europe/Belgrade").minutes, 23 * 60 + 30);
  assert.equal(localParts(t, "America/New_York").minutes, 17 * 60 + 30);
  const tokyo = localParts(t, "Asia/Tokyo");
  assert.equal(tokyo.date, "2026-11-05");
  assert.equal(tokyo.minutes, 7 * 60 + 30);
  assert.equal(makeClock({ tz: "Europe/Belgrade", ...Q }).isQuiet(t), true);
  assert.equal(makeClock({ tz: "America/New_York", ...Q }).isQuiet(t), false);
  assert.equal(makeClock({ tz: "Asia/Tokyo", ...Q }).isQuiet(t), true);
  assert.equal(makeClock({ tz: "UTC", ...Q }).isEvening(t), true);
});

test("midnight is 00, not 24 (hourCycle h23)", () => {
  const p = localParts(ms("2026-11-04T23:05:00Z"), "Europe/Belgrade");
  assert.equal(p.h, 0);
  assert.equal(p.date, "2026-11-05");
});

test("DST transitions: quiet hours end by wall-clock time", () => {
  const c = makeClock({ tz: "Europe/Belgrade", ...Q });
  // 2026-03-29 02:00 → 03:00 (CEST, UTC+2): 06:30Z is 08:30, quiet hours are already over.
  assert.equal(localParts(ms("2026-03-29T06:30:00Z"), "Europe/Belgrade").minutes, 8 * 60 + 30);
  assert.equal(c.isQuiet(ms("2026-03-29T06:30:00Z")), false);
  // The day before (still CET, UTC+1) the same UTC hour is 07:30, quiet hours.
  assert.equal(c.isQuiet(ms("2026-03-28T06:30:00Z")), true);
  // 2026-10-25 03:00 → 02:00 (CET): 06:30Z is 07:30, still quiet; 07:00Z is 08:00, no longer.
  assert.equal(c.isQuiet(ms("2026-10-25T06:30:00Z")), true);
  assert.equal(c.isQuiet(ms("2026-10-25T07:00:00Z")), false);
});

test("windows across midnight and HH:MM parsing", () => {
  assert.equal(inWindow(23 * 60, 23 * 60, 8 * 60), true);
  assert.equal(inWindow(7 * 60 + 59, 23 * 60, 8 * 60), true);
  assert.equal(inWindow(8 * 60, 23 * 60, 8 * 60), false);
  assert.equal(inWindow(22 * 60 + 59, 23 * 60, 8 * 60), false);
  assert.equal(inWindow(12 * 60, 9 * 60, 18 * 60), true);
  assert.equal(inWindow(5, 60, 60), false);
  assert.equal(parseHM("8:05"), 485);
  assert.equal(parseHM("24:00"), null);
  assert.equal(parseHM("ab"), null);
  assert.equal(validTimeZone("Europe/Belgrade"), true);
  assert.equal(validTimeZone("Mars/Base"), false);
});

test("night day: 01:30 Thursday is the same night as 21:00 Wednesday; across a month boundary", () => {
  const tz = "Europe/Belgrade";
  assert.equal(dayBucket(ms("2026-11-04T20:00:00Z"), tz, 480), "2026-11-04"); // 21:00 Wed
  assert.equal(dayBucket(ms("2026-11-05T00:30:00Z"), tz, 480), "2026-11-04"); // 01:30 Thu
  assert.equal(dayBucket(ms("2026-11-05T07:00:00Z"), tz, 480), "2026-11-05"); // 08:00 Thu
  assert.equal(dayBucket(ms("2026-12-01T01:00:00Z"), tz, 480), "2026-11-30");
  assert.equal(dayBucket(ms("2027-01-01T03:00:00Z"), tz, 480), "2026-12-31");
});

test("settings: invalid zone → system zone, invalid hours → defaults; unknown keys are ignored and listed", () => {
  const raw = { timezone: "Nope/Nope", quietStart: "25:00", idleThresholdMs: -5, chat: { enabled: true, keychainService: "x" }, enabled: true };
  const c = resolvePushConfig(raw);
  assert.ok(validTimeZone(c.timezone));
  assert.equal(c.quietStart, 23 * 60);
  assert.equal(c.idleThresholdMs, 10 * 60_000);
  assert.equal(c.chat, undefined, "a key the service doesn't know does not reach the settings");
  assert.deepEqual(ignoredKeys(raw), ["chat"], "enabled and the known keys are not reported");
  assert.deepEqual(ignoredKeys(null), []);
  assert.deepEqual(ignoredKeys([1]), []);
});

test("event table: name, alias, instance suffix, longest match, override", () => {
  const rules = buildRules({ "my-event": { label: "Mine", macOnly: true, hold: "evening" }, "pace-rule": { aliases: ["pace-85"], quietException: true, hold: "nope" }, "quota-week": { aliases: ["quota-week-80"] } });
  assert.equal(matchRule(rules, "my-event").hold, "evening");
  assert.equal(matchRule(rules, "my-event:x").name, "my-event");
  assert.equal(matchRule(rules, "session-waiting:1111-2222").name, "session-waiting");
  assert.equal(matchRule(rules, "quota-week-80").name, "quota-week");
  assert.equal(matchRule(rules, "session-waitingX").name, "default");
  assert.equal(matchRule(rules, "my-event.a").label, "Mine");
  assert.equal(matchRule(rules, "my-event.a").macOnly, true, "macOnly is a rule field again: the Mac banner only (re-review 70)");
  const qp = matchRule(rules, "pace-85:20261109");
  assert.equal(qp.quietException, true);
  assert.equal(qp.hold, undefined, "unknown hold value is dropped");
  assert.equal(matchRule(rules, "something").name, "default");
});

test("HIDIdleTime: parsing synthetic ioreg output and the cache", async () => {
  const sample = `+-o IOHIDSystem  <class IOHIDSystem>\n    | |   "HIDIdleTime" = 125000000000\n    | |   "Other" = 1\n`;
  assert.equal(parseHidIdle(sample), 125_000);
  assert.equal(parseHidIdle("no field"), null);
  let calls = 0;
  let t = 0;
  const exec = async (file, args) => {
    calls++;
    assert.equal(file, "/usr/sbin/ioreg");
    assert.deepEqual(args, ["-c", "IOHIDSystem", "-d", "4"]);
    return { code: 0, stdout: sample };
  };
  const idle = createPresence({ exec, cacheMs: 1000, now: () => t });
  assert.equal(await idle(), 125_000);
  t = 500;
  await idle();
  assert.equal(calls, 1, "ioreg is not called within the cache window");
  t = 2000;
  await idle();
  assert.equal(calls, 2);
  const broken = createPresence({ exec: async () => ({ code: 1, stdout: "" }) });
  assert.equal(await broken(), null);
  const throwing = createPresence({ exec: async () => { throw new Error("x"); } });
  assert.equal(await throwing(), null);
});
