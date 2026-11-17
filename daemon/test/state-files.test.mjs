// Damaged state files (lib/statefile.mjs loadStateJson): a broken or empty config.json, settings.json, jobs.json, streams.json
// or app-pin.json is not silently replaced by defaults — a copy is kept as <file>.bad, the journal gets a state-file-damaged
// line and /state lists the file in damagedFiles. A broken config.json no longer makes the daemon exit (launchd restarted it
// every 10 s forever): it runs on the defaults with the app class, extensions and the terminal bridge closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR, loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { createPeer } from "../lib/peer.mjs";
import { Settings, langForHome } from "../lib/settings.mjs";
import { loadStateJson } from "../lib/statefile.mjs";
import { cleanup, curl, FILE_MODES, tempHome, waitFor } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");
const PIN_A = 'identifier "com.kensei.agenthub" and cdhash H"' + "a".repeat(40) + '"';
const PIN_B = 'identifier "com.kensei.agenthub" and cdhash H"' + "b".repeat(40) + '"';

const sys = () => ({
  available: true,
  peerPid: () => 10,
  peerUid: () => 501,
  pidPath: () => "/usr/bin/curl",
  pidInfo: () => null,
  procArgv: () => null,
  codesignVerify: async () => false,
  fileId: (p) => p,
  myUid: () => 501,
  readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
});
const envFor = (home) => ({ AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "none"), AGENTHUB_SERVICES: "none" });
async function coreOn(home, { tolerant = true } = {}) {
  const config = loadConfig({ env: envFor(home), tolerant });
  const core = new Core({ config, peer: createPeer({ config, sys: sys() }) });
  await core.init({ startPlugins: false });
  return core;
}
const journalOf = (core, type) => core.journal.tail(200).filter((e) => e.type === type);

test("loadStateJson: a missing file is not damage; a broken, empty or non-object one is — a .bad copy and a record, never a throw", () => {
  const dir = tempHome("ah-sf-");
  try {
    const p = join(dir, "x.json");
    assert.deepEqual(loadStateJson(p), { value: undefined, damaged: null });
    writeFileSync(p, '﻿{"a":1}');
    assert.deepEqual(loadStateJson(p), { value: { a: 1 }, damaged: null });
    assert.ok(!existsSync(`${p}.bad`));
    for (const [bytes, why] of [["{ broken", /JSON|property|position/i], ["", /JSON|end/i], ["[1,2]", /./], ["null", /./], ["42", /./]]) {
      writeFileSync(p, bytes, { mode: 0o644 });
      const r = loadStateJson(p, { now: () => new Date("2026-11-17T10:00:00Z") });
      assert.equal(r.value, undefined);
      assert.deepEqual({ ...r.damaged, detail: null }, { file: "x.json", backup: "x.json.bad", detail: null, at: "2026-11-17T10:00:00.000Z" });
      assert.match(r.damaged.detail, why, bytes);
      assert.equal(readFileSync(`${p}.bad`, "utf8"), bytes, "the copy holds the damaged bytes");
      assert.equal(readFileSync(p, "utf8"), bytes, "the file itself is left where it is");
      if (FILE_MODES) assert.equal(statSync(`${p}.bad`).mode & 0o777, 0o600);
    }
    // keepBad: false — a reader that is not the file's owner (a CLI process) reports, but writes nothing
    const q = join(dir, "y.json");
    writeFileSync(q, "{");
    assert.equal(loadStateJson(q, { keepBad: false }).damaged.backup, null);
    assert.ok(!existsSync(`${q}.bad`));
  } finally {
    cleanup(dir);
  }
});

test("loadConfig: the CLI still refuses a broken config.json; the daemon (tolerant) gets the defaults, fail-closed", () => {
  const home = tempHome("ah-sf-");
  try {
    const cfgPath = join(home, "config.json");
    // what the human had: a pinned app, extensions and the terminal bridge switched off, a service disabled
    writeFileSync(cfgPath, JSON.stringify({ requirements: { app: PIN_A }, plugins: { maxJobsPerPlugin: 1 } }));
    const good = loadConfig({ env: envFor(home), tolerant: true });
    assert.deepEqual([good.requirements.app, good.plugins.maxJobsPerPlugin, good.damagedFiles, good.configDamaged], [PIN_A, 1, [], undefined]);
    assert.equal(good.extensions.enabled, true);

    for (const bytes of ["{ не json", "", "[]"]) {
      writeFileSync(cfgPath, bytes);
      // the command-line tools say so and exit, as before
      if (bytes !== "[]") assert.throws(() => loadConfig({ env: envFor(home) }), /config\.json/);
      const cfg = loadConfig({ env: envFor(home), tolerant: true });
      assert.equal(cfg.configDamaged, true);
      assert.deepEqual(cfg.damagedFiles.map((d) => [d.file, d.backup]), [["config.json", "config.json.bad"]]);
      assert.equal(readFileSync(`${cfgPath}.bad`, "utf8"), bytes);
      assert.equal(readFileSync(cfgPath, "utf8"), bytes, "config.json is the human's to fix: not rewritten");
      // defaults …
      assert.equal(cfg.plugins.maxJobsPerPlugin, 4);
      // … with the parts closed that defaults would open
      assert.equal(cfg.requirements.app, null);
      assert.equal(cfg.extensions.enabled, false);
      assert.equal(cfg.services.terminal.enabled, false);
    }
  } finally {
    cleanup(home);
  }
});

for (const [name, bytes] of [["broken", "{ не json"], ["empty", ""]]) {
  test(`agenthubd with a ${name} config.json starts instead of exiting: a warning, config.json.bad, a journal line, /state.damagedFiles`, async () => {
    const home = tempHome("ah-sf-");
    writeFileSync(join(home, "config.json"), bytes, { mode: 0o600 });
    const env = { ...process.env, ...envFor(home), AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log") };
    delete env.NODE_OPTIONS;
    const d = spawn(process.execPath, [join(BIN, "agenthubd")], { env, stdio: ["ignore", "ignore", "pipe"] });
    d.err = "";
    d.stderr.on("data", (c) => (d.err += c));
    try {
      const sock = join(home, "hub.sock");
      await waitFor(async () => existsSync(sock) && (await curl(sock, "GET", "/health").catch(() => ({}))).status === 200, { timeoutMs: 10_000, label: "the daemon answers" });
      assert.equal(d.exitCode, null, d.err);
      assert.match(d.err, /WARNING: config\.json is damaged \(.+\) — running on the defaults, a copy is kept as config\.json\.bad/);
      assert.doesNotMatch(d.err, /\n\s+at /, "no stack");
      assert.equal(readFileSync(join(home, "config.json.bad"), "utf8"), bytes);
      assert.equal(readFileSync(join(home, "config.json"), "utf8"), bytes);
      const journal = readFileSync(join(home, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const noted = journal.filter((e) => e.type === "state-file-damaged");
      assert.deepEqual(noted.map((e) => [e.file, e.backup]), [["config.json", "config.json.bad"]]);
      const st = await curl(sock, "GET", "/state");
      assert.equal(st.status, 200);
      assert.deepEqual(st.body.damagedFiles.map((x) => [x.file, x.backup, typeof x.detail, typeof x.at]), [["config.json", "config.json.bad", "string", "string"]]);
      assert.equal(st.body.extensions?.enabled, false, "extensions are closed while the config cannot be read");
      d.kill("SIGTERM");
      await waitFor(() => d.exitCode !== null, { timeoutMs: 8000 });
      assert.equal(d.exitCode, 0, d.err);
    } finally {
      d.kill("SIGKILL");
      cleanup(home);
    }
  });
}

test("the daemon with broken settings.json, jobs.json, streams.json and app-pin.json: each kept as .bad, journaled and listed in /state", async () => {
  const home = tempHome("ah-sf-");
  let core;
  try {
    const files = { "settings.json": '{"lang": "en",', "jobs.json": "", "streams.json": "not json", "app-pin.json": "[]" };
    for (const [f, bytes] of Object.entries(files)) writeFileSync(join(home, f), bytes, { mode: 0o600 });
    core = await coreOn(home);
    const listed = core.snapshot().damagedFiles;
    assert.deepEqual(listed.map((d) => d.file).sort(), Object.keys(files).sort());
    for (const d of listed) {
      assert.equal(d.backup, `${d.file}.bad`);
      assert.equal(readFileSync(join(home, d.backup), "utf8"), files[d.file], d.file);
      assert.ok(d.detail && d.at);
    }
    assert.deepEqual(journalOf(core, "state-file-damaged").map((e) => e.file).sort(), Object.keys(files).sort());
    // the daemon went on with the defaults; the files it owns are valid again
    assert.equal(core.settings.get("lang"), "system");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "jobs.json"), "utf8")), { jobs: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(home, "streams.json"), "utf8")), { streams: [] });
    assert.ok(JSON.parse(readFileSync(join(home, "app-pin.json"), "utf8")), "app-pin.json is written anew");
    // the list is a copy: a consumer cannot change the daemon's
    listed.length = 0;
    assert.equal(core.snapshot().damagedFiles.length, 4);
  } finally {
    await core?.stop();
    cleanup(home);
  }
});

test("a healthy home: damagedFiles is an empty list and nothing is journaled; a CLI reader of a broken settings.json writes no .bad", async () => {
  const home = tempHome("ah-sf-");
  let core;
  try {
    writeFileSync(join(home, "config.json"), "{}");
    writeFileSync(join(home, "settings.json"), '{"lang":"en"}');
    core = await coreOn(home);
    assert.deepEqual(core.snapshot().damagedFiles, []);
    assert.equal(journalOf(core, "state-file-damaged").length, 0);
    assert.equal(core.settings.get("lang"), "en");
    await core.stop();
    core = null;
    writeFileSync(join(home, "settings.json"), "{");
    assert.ok(["ru", "en"].includes(langForHome(home)));
    const s = new Settings(join(home, "settings.json"));
    assert.equal(s.damaged.file, "settings.json");
    assert.ok(!existsSync(join(home, "settings.json.bad")));
  } finally {
    await core?.stop();
    cleanup(home);
  }
});

test("app pin and a damaged config.json: no false 'pin changed' — the comparison waits until the file can be read again", async () => {
  const home = tempHome("ah-sf-");
  const cfgPath = join(home, "config.json");
  let core;
  try {
    // a daemon life with pin A: app-pin.json remembers it
    writeFileSync(cfgPath, JSON.stringify({ requirements: { app: PIN_A } }));
    core = await coreOn(home);
    assert.equal(core.appPin.current(), PIN_A);
    await core.stop();
    const pinState = readFileSync(join(home, "app-pin.json"), "utf8");
    const changesBefore = core.journal.tail(200).filter((e) => e.type === "app-requirement-changed").length;

    // config.json gets damaged; the daemon starts on the closed defaults
    writeFileSync(cfgPath, '{"requirements": {"app": ');
    core = await coreOn(home);
    assert.equal(core.appPin.current(), null, "the app class is closed");
    assert.equal(journalOf(core, "app-requirement-changed").length, changesBefore, "'no requirement' is not recorded as a change of the pin");
    assert.equal(readFileSync(join(home, "app-pin.json"), "utf8"), pinState, "app-pin.json keeps the pin last seen");
    assert.equal(core.appPin.check("poll"), false, "still unreadable: nothing happens");
    assert.equal(core.appPin.current(), null);

    // the human repairs the file with the same pin: it is in effect again, silently
    writeFileSync(cfgPath, JSON.stringify({ requirements: { app: PIN_A } }));
    core.appPin.check("poll");
    assert.equal(core.appPin.current(), PIN_A);
    assert.equal(journalOf(core, "app-requirement-changed").length, changesBefore);
    await core.stop();

    // … or with another pin: that is a change, recorded once
    writeFileSync(cfgPath, "{");
    core = await coreOn(home);
    writeFileSync(cfgPath, JSON.stringify({ requirements: { app: PIN_B } }));
    assert.equal(core.appPin.check("poll"), true);
    assert.equal(core.appPin.current(), PIN_B);
    assert.equal(journalOf(core, "app-requirement-changed").length, changesBefore + 1);
  } finally {
    await core?.stop();
    cleanup(home);
  }
});
