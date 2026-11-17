// Process spawns that used to stop the event loop on the daemon's running paths now go through async twins:
// the system languages (Settings.refreshSystem, the minute poll), ps for one process (ttyNameAsync / procStateAsync,
// sysAsync, ttyOfAsync) and the process table for a timeout kill (readPsTable).

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Settings } from "../lib/settings.mjs";
import { defaultSys, procState, procStateAsync, sysAsync, ttyName, ttyNameAsync } from "../lib/peer.mjs";
import { descendantPids, readPsTable } from "../lib/platform.mjs";
import { ttyOf, ttyOfAsync } from "../lib/terminals/_proc.mjs";
import { cleanup, startHub, tempHome } from "./helpers.mjs";

const POSIX = process.platform !== "win32";

test("Settings.refreshSystem: after a background refresh the getters serve its value and stop reading the OS themselves", async () => {
  const dir = tempHome("ah-rs-");
  let t = 1_000_000;
  let syncReads = 0;
  let asyncReads = 0;
  let text = '("de-DE", "ru-RU")';
  try {
    const s = new Settings(join(dir, "settings.json"), { readLanguages: () => (syncReads++, text), readLanguagesAsync: async () => (asyncReads++, text), now: () => t, env: {} });
    // the first value is read synchronously: a daemon needs its language at once
    assert.deepEqual([s.systemLang(), s.systemLocales()], ["en", ["de-DE", "ru-RU"]]);
    assert.deepEqual([syncReads, asyncReads], [1, 0]);
    text = '("ru-RU", "en-US")';
    assert.equal(await s.refreshSystem(), true);
    assert.deepEqual([s.systemLang(), s.systemLocales()], ["ru", ["ru-RU", "en-US"]], "the refreshed value is served right away");
    // a minute and more later: no synchronous read, the last refresh is served
    t += 61_000;
    text = '("fr-FR")';
    assert.deepEqual([s.systemLang(), s.systemLocales()], ["ru", ["ru-RU", "en-US"]]);
    assert.deepEqual([syncReads, asyncReads], [1, 1]);
    // two refreshes at once share one read
    const [a, b] = await Promise.all([s.refreshSystem(), s.refreshSystem()]);
    assert.deepEqual([a, b, asyncReads], [true, true, 2]);
    assert.deepEqual(s.systemLocales(), ["fr-FR"]);
    // an explicit fresh read is still synchronous
    text = '("it-IT")';
    assert.deepEqual(s.systemLocales({ fresh: true }), ["it-IT"]);
    assert.equal(syncReads, 2);
    // the refresher is gone (nothing for five minutes): the getters read for themselves again
    text = '("ru-RU")';
    t += 5 * 60_000 + 1;
    assert.equal(s.systemLang(), "ru");
    assert.equal(syncReads, 3);
  } finally {
    cleanup(dir);
  }
});

test("Settings.refreshSystem: a failed read keeps the previous value; a fixed language has nothing to read", async () => {
  const dir = tempHome("ah-rs-");
  try {
    let fail = false;
    const s = new Settings(join(dir, "a.json"), { readLanguages: () => '("de-DE")', readLanguagesAsync: async () => (fail ? Promise.reject(new Error("no defaults")) : '("ru-RU")'), env: {} });
    assert.equal(s.systemLang(), "en");
    fail = true;
    assert.equal(await s.refreshSystem(), false);
    assert.deepEqual([s.systemLang(), s.systemLocales()], ["en", ["de-DE"]]);
    fail = false;
    assert.equal(await s.refreshSystem(), true);
    assert.deepEqual([s.systemLang(), s.systemLocales()], ["ru", ["ru-RU"]]);
    // only the synchronous reader given (a check): the refresh goes through it
    let reads = 0;
    const one = new Settings(join(dir, "b.json"), { readLanguages: () => (reads++, '("ru-RU")'), env: {} });
    assert.equal(await one.refreshSystem(), true);
    assert.deepEqual([one.systemLang(), reads], ["ru", 1]);
    // a fixed language (test hubs, AGENTHUB_SYSTEM_LANG)
    const fixed = new Settings(join(dir, "c.json"), { detect: () => "en" });
    assert.equal(await fixed.refreshSystem(), false);
    assert.equal(fixed.systemLang(), "en");
  } finally {
    cleanup(dir);
  }
});

test("the daemon's minute language poll refreshes first and then compares: a changed system language is announced", async () => {
  const h = await startHub();
  const events = [];
  h.core.on("event", (e) => events.push(e));
  try {
    assert.equal(typeof h.core.langPoll?.hasRef, "function", "the poll timer is running");
    const before = h.core.lang();
    const other = before === "ru" ? "en" : "ru";
    let refreshed = 0;
    // what refreshSystem does on a live daemon: brings the new value without a synchronous read
    h.core.settings.refreshSystem = async () => {
      refreshed++;
      h.core.settings.detect = () => other;
      h.core.settings.detectLocales = () => [other];
      h.core.settings.sysAt = -Infinity;
      h.core.settings.locsAt = -Infinity;
      return true;
    };
    h.core.settings.setLang("system");
    await h.core.pollLang();
    assert.equal(refreshed, 1);
    assert.equal(h.core.lang(), other);
    assert.ok(events.some((e) => e.type === "settings.changed" && e.lang?.effective === other));
    // a poll that lands while the daemon is stopping changes nothing
    const n = events.length;
    h.core.stopping = true;
    h.core.settings.refreshSystem = async () => {
      h.core.settings.detect = () => before;
      h.core.settings.sysAt = -Infinity;
      return true;
    };
    await h.core.pollLang();
    assert.equal(events.length, n);
    h.core.stopping = false;
  } finally {
    await h.stop();
  }
});

test("ps for one process: the async twins parse like the synchronous functions and never reject", { skip: !POSIX && "no ps" }, async () => {
  const calls = [];
  const exec = async (cmd, args) => (calls.push(args.join(" ")), args.includes("tty=") ? "ttys004\n" : "S+\n");
  assert.equal(await ttyNameAsync(4242, { exec }), "ttys004");
  assert.deepEqual(await procStateAsync(4242, { exec }), { stopped: false, foreground: true });
  assert.deepEqual(calls, ["-o tty= -p 4242", "-o stat= -p 4242"]);
  assert.deepEqual(await procStateAsync(4242, { exec: async () => "T\n" }), { stopped: true, foreground: false });
  assert.equal(await ttyNameAsync(4242, { exec: async () => "??\n" }), null);
  assert.equal(await procStateAsync(4242, { exec: async () => "S+; rm -rf\n" }), null);
  const boom = async () => {
    throw new Error("no ps");
  };
  assert.equal(await ttyNameAsync(4242, { exec: boom }), null);
  assert.equal(await procStateAsync(4242, { exec: boom }), null);
  for (const bad of [0, -1, 1.5, "1", null]) {
    assert.equal(await ttyNameAsync(bad, { exec }), null);
    assert.equal(await procStateAsync(bad, { exec }), null);
  }
  // the real ps: both ways agree about this very process
  assert.deepEqual(await procStateAsync(process.pid), procState(process.pid));
  assert.equal(await ttyNameAsync(process.pid), ttyName(process.pid));
});

test("sysAsync: the real functions get the ps twin, a double is asked itself, its own async function wins", { skip: !POSIX && "no ps" }, async () => {
  const real = defaultSys();
  assert.deepEqual(await sysAsync(real, "procState", process.pid), procState(process.pid));
  assert.equal(await sysAsync(real, "ttyName", process.pid), ttyName(process.pid));
  // a set of doubles that replaces only the synchronous function (tests): no real ps for a made-up pid
  const fake = { ...real, procState: (pid) => (pid === 999_999_1 ? { stopped: false, foreground: true } : null), ttyName: () => "ttys009" };
  assert.deepEqual(await sysAsync(fake, "procState", 999_999_1), { stopped: false, foreground: true });
  assert.equal(await sysAsync(fake, "procState", 5), null);
  assert.equal(await sysAsync(fake, "ttyName", 5), "ttys009");
  assert.equal(await sysAsync({ ...fake, ttyNameAsync: async () => "ttys010" }, "ttyName", 5), "ttys010");
  // nothing to ask, a double that throws
  assert.equal(await sysAsync({}, "procState", 5), null);
  assert.equal(await sysAsync(null, "ttyName", 5), null);
  assert.equal(
    await sysAsync({ procState: () => { throw new Error("boom"); } }, "procState", 5),
    null,
  );
});

test("the hub gives the async forms to services and adapters: ctx.peer.procStateAsync and the processTtyAsync fact", async () => {
  const procs = { 4242: { tty: "ttys009", stat: { stopped: false, foreground: true } } };
  const sys = { ...defaultSys(), ttyName: (pid) => procs[pid]?.tty ?? null, procState: (pid) => procs[pid]?.stat ?? null };
  const h = await startHub({ sys });
  try {
    const { makeCtx } = await import("../lib/ctx.mjs");
    const ctx = makeCtx(h.core, "service:demo");
    assert.deepEqual(await ctx.peer.procStateAsync(4242), { stopped: false, foreground: true });
    assert.equal(await ctx.peer.procStateAsync(1), null);
    assert.deepEqual(ctx.peer.procState(4242), { stopped: false, foreground: true }, "the synchronous form stays");
    const p = h.core.facts.processTtyAsync(4242);
    assert.ok(p instanceof Promise);
    assert.equal(await p, "ttys009");
    assert.equal(await h.core.facts.processTtyAsync(-1), null);
    assert.equal(h.core.facts.processTty(4242), "ttys009", "the synchronous fact stays for adapters that call it");
    // the adapters' helper: the async fact when the hub has it, otherwise the synchronous one
    assert.equal(await ttyOfAsync(4242, h.core.facts), "/dev/ttys009");
    assert.equal(await ttyOfAsync(4242, { processTty: () => "ttys001" }), "/dev/ttys001");
    assert.equal(await ttyOfAsync(4242, { processTtyAsync: async () => "ttys0; rm", processTty: () => "ttys001" }), null);
    assert.equal(await ttyOfAsync(4242, { processTtyAsync: () => Promise.reject(new Error("boom")) }), null);
    assert.equal(await ttyOfAsync(4242, {}), null);
    assert.equal(ttyOf(4242, h.core.facts), "/dev/ttys009");
  } finally {
    await h.stop();
  }
});

test("readPsTable: the process table comes back asynchronously and holds this process under its parent", { skip: !POSIX && "no ps" }, async () => {
  const p = readPsTable();
  assert.ok(p instanceof Promise);
  const table = await p;
  assert.match(table, new RegExp(`(^|\\n)\\s*${process.pid}\\s+${process.ppid}\\s*(\\n|$)`));
  assert.ok(descendantPids(process.ppid, { psOutput: table }).includes(process.pid));
  assert.deepEqual(descendantPids(process.pid, { psOutput: "" }), [], "no table — no descendants");
});
