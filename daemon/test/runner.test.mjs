import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildEnv, nextCron, parseCron, runOnce, splitCommand, StreamProcess, Watcher } from "../lib/runner.mjs";
import { cleanup, tempHome, waitFor, writePlugin } from "./helpers.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Windows environment: USERPROFILE = the plugin's HOME and system paths (SystemRoot etc.), nothing else passes", () => {
  const sysEnv = { SystemRoot: "C:\\Windows", windir: "C:\\Windows", COMSPEC: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", TEMP: "C:\\T", APPDATA: "C:\\A", SECRET_TOKEN: "s" };
  const env = buildEnv({ pluginId: "p", dataPath: "D", cachePath: "C", reason: "Schedule", home: "C:\\Users\\x", platform: "win32", sysEnv });
  assert.equal(env.USERPROFILE, "C:\\Users\\x");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.COMSPEC, sysEnv.COMSPEC);
  assert.ok(!("APPDATA" in env) && !("SECRET_TOKEN" in env));
  const mac = buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Schedule", home: "/Users/x", platform: "darwin", sysEnv });
  assert.ok(!("USERPROFILE" in mac) && !("SystemRoot" in mac));
});

test("environment is cleaned: only the base set, AGENTHUB_*, OS_* and secrets", () => {
  process.env.AGENTHUB_TEST_LEAK = "must-not-leak";
  const env = buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Schedule", os: { OS_PLATFORM: "darwin", FOO: "x" }, secrets: { "clickup.token": "s3" }, home: "/Users/x" });
  delete process.env.AGENTHUB_TEST_LEAK;
  assert.deepEqual(Object.keys(env).sort(), [
    "AGENTHUB_LANG",
    "AGENTHUB_LOCALE",
    "AGENTHUB_PAUSED",
    "AGENTHUB_PLUGIN_CACHE_PATH",
    "AGENTHUB_PLUGIN_DATA_PATH",
    "AGENTHUB_PLUGIN_ID",
    "AGENTHUB_REFRESH_REASON",
    "AGENTHUB_SECRET_CLICKUP_TOKEN",
    "HOME",
    "LANG",
    "OS_PLATFORM",
    "PATH",
    "TMPDIR",
    "USER",
  ]);
  assert.ok(!("NODE_OPTIONS" in env));
  assert.equal(env.PATH.split(":")[0], "/Users/x/.local/bin");
  assert.equal(env.AGENTHUB_LANG, "ru", "default language is ru");
  assert.equal(buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Schedule", lang: "en", home: "/Users/x" }).AGENTHUB_LANG, "en");
  assert.equal(buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Schedule", lang: "de", home: "/Users/x" }).AGENTHUB_LANG, "ru", "only ru|en");
  // G14: the system preferred languages for plugin content, canonical BCP-47, malformed ones dropped; a service cannot override them
  const loc = buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Schedule", locale: ["de_DE", "pt-br", "bad tag", "en-US"], extra: { AGENTHUB_LOCALE: "xx" }, home: "/Users/x" });
  assert.equal(loc.AGENTHUB_LOCALE, "de-DE,pt-BR,en-US");
  assert.equal(loc.AGENTHUB_LANG, "ru", "the hub UI language stays ru | en");
  assert.equal(buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Schedule", locale: [], home: "/Users/x" }).AGENTHUB_LOCALE, "", "no system list — empty, still present");
  // contract 3: the hub pause flag is always present, 0 or 1
  assert.equal(env.AGENTHUB_PAUSED, "0", "not paused — explicit 0");
  assert.equal(buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Paused", paused: true, home: "/Users/x" }).AGENTHUB_PAUSED, "1");
  // a service cannot override the pause flag
  assert.equal(buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Schedule", extra: { AGENTHUB_PAUSED: "0" }, paused: true, home: "/Users/x" }).AGENTHUB_PAUSED, "1");
});

test("standard: timeout kills the whole process group", async () => {
  const dir = tempHome();
  try {
    const pidFile = join(dir, "child.pid");
    const p = writePlugin(dir, "slow.1m.sh", `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nsleep 30\n`);
    const r = await runOnce(["/bin/sh", p], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 400 });
    assert.equal(r.timedOut, true);
    const child = Number(execFileSync("/bin/cat", [pidFile], { encoding: "utf8" }).trim());
    await waitFor(() => !alive(child), { timeoutMs: 2000 });
  } finally {
    cleanup(dir);
  }
});

test("standard: output, exit code, size limit", async () => {
  const ok = await runOnce(["/bin/sh", "-c", "echo hi; exit 3"], { env: { PATH: "/usr/bin:/bin" } });
  assert.equal(ok.stdout, "hi\n");
  assert.equal(ok.code, 3);
  const big = await runOnce(["/bin/sh", "-c", "yes | head -c 100000"], { env: { PATH: "/usr/bin:/bin" }, maxBytes: 1000 });
  assert.equal(big.overflow, true);
  const missing = await runOnce(["/nonexistent/x"], { env: {} });
  assert.ok(missing.error);
});

test("streamable: frames from stdout and NDJSON into stdin, stop kills the process", async () => {
  const dir = tempHome();
  try {
    const p = writePlugin(
      dir,
      "s.mjs",
      `import { createInterface } from "node:readline";
process.stdout.write("Start | status=ok\\n~~~\\n");
createInterface({ input: process.stdin }).on("line", (l) => process.stdout.write("Got " + JSON.parse(l).type + "\\n~~~\\n"));
setInterval(() => {}, 1e9);`,
    );
    const frames = [];
    const sp = new StreamProcess([process.execPath, p], { env: { PATH: "/usr/bin:/bin" }, cwd: dir, onFrame: (f) => frames.push(f) });
    sp.start();
    await waitFor(() => frames.length >= 1);
    assert.equal(frames[0], "Start | status=ok");
    assert.ok(sp.write({ type: "fileChanged", path: "/x" }));
    await waitFor(() => frames.length >= 2);
    assert.equal(frames[1], "Got fileChanged");
    const pid = sp.pid;
    await sp.stop();
    await waitFor(() => !alive(pid));
  } finally {
    cleanup(dir);
  }
});

test("streamable: a crashed process is restarted", async () => {
  const dir = tempHome();
  try {
    const p = writePlugin(dir, "c.mjs", `process.stdout.write("Run\\n~~~\\n"); setTimeout(() => process.exit(1), 50);`);
    let starts = 0;
    const sp = new StreamProcess([process.execPath, p], { env: {}, cwd: dir, onStart: () => starts++ });
    sp.backoffMs = 50;
    sp.start();
    await waitFor(() => starts >= 2, { timeoutMs: 4000 });
    await sp.stop();
  } finally {
    cleanup(dir);
  }
});

test("watch: a change to a file matching the mask fires the callback", async () => {
  const dir = tempHome();
  try {
    mkdirSync(join(dir, "sessions"));
    const seen = [];
    const w = new Watcher([`${dir}/sessions/*.json — сессии`], (paths) => seen.push(...paths), { debounceMs: 50 });
    w.start();
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(dir, "sessions", "1.key"), "x");
    writeFileSync(join(dir, "sessions", "123.json"), "{}");
    await waitFor(() => seen.some((p) => p.endsWith("123.json")), { timeoutMs: 3000 });
    assert.ok(!seen.some((p) => p.endsWith(".key")));
    w.close();
  } finally {
    cleanup(dir);
  }
});

test("cron: next run", () => {
  const from = new Date(2026, 10, 4, 10, 7, 30); // Wed 4 Nov 2026 10:07:30
  assert.deepEqual(nextCron("*/5 * * * *", from), new Date(2026, 10, 4, 10, 10));
  assert.deepEqual(nextCron("0 21 * * *", from), new Date(2026, 10, 4, 21, 0));
  assert.deepEqual(nextCron("30 4 * * 1", from), new Date(2026, 10, 9, 4, 30)); // the next Monday
  assert.deepEqual(nextCron("0 0 1 1 *", from), new Date(2027, 0, 1, 0, 0));
  assert.throws(() => parseCron("* * *"));
  assert.throws(() => parseCron("61 * * * *"));
});

test("an action command is parsed without a shell", () => {
  assert.deepEqual(splitCommand(`node batch-run.mjs check`), ["node", "batch-run.mjs", "check"]);
  assert.deepEqual(splitCommand(`/bin/echo "a b" 'c d' e\\ f`), ["/bin/echo", "a b", "c d", "e f"]);
  assert.deepEqual(splitCommand(`echo $(rm -rf /) ; ls`), ["echo", "$(rm", "-rf", "/)", ";", "ls"]);
  assert.deepEqual(splitCommand("cat ~/x", "/H"), ["cat", "/H/x"]);
  assert.throws(() => splitCommand(`echo "abc`));
});
