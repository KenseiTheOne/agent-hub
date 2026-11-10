// bin/agenthubd and bin/agenthub as separate processes in a temporary AGENTHUB_HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_DIR } from "../lib/config.mjs";
import { plistXml, localAppRequirement, LABEL } from "../lib/launchd.mjs";
import { generateKeyPair } from "../lib/registry/minisign.mjs";
import { cleanup, curl, FILE_MODES, onlyDarwin, tempHome, waitFor, withRepoPlist, writePlugin } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");

function envFor(home, plugins) {
  const e = { ...process.env, AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: plugins, AGENTHUB_SERVICES: "none", AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log") };
  delete e.NODE_OPTIONS;
  return e;
}

// The CLI speaks the hub language, and test mode makes the "system" language ru: these checks read the English CLI
// (a daemon started through run keeps its own language).
function run(args, env) {
  const e = /[\\/]agenthub$/.test(args[0] || "") ? { AGENTHUB_SYSTEM_LANG: "en", ...env } : env;
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: e, timeout: 15_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test("agenthubd starts in AGENTHUB_HOME, answers on the socket, removes the socket on SIGTERM; agenthub status", async () => {
  const home = tempHome();
  const plugins = tempHome("ah-pl-");
  writePlugin(plugins, "q.1h.sh", "#!/bin/sh\necho 'Квота 42% | status=ok'\necho ---\necho 'неделя'\n");
  const env = envFor(home, plugins);
  const d = spawn(process.execPath, [join(BIN, "agenthubd")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  d.stderr.on("data", (c) => (err += c));
  try {
    const sock = join(home, "hub.sock");
    await waitFor(() => existsSync(sock), { timeoutMs: 8000 });
    await waitFor(async () => (await curl(sock, "GET", "/state")).body?.plugins?.[0]?.lastRunAt, { timeoutMs: 8000 });
    const st = await run([join(BIN, "agenthub"), "status"], env);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /q\s+ok/);
    assert.match(st.stdout, /Квота 42%/);
    const js = JSON.parse((await run([join(BIN, "agenthub"), "status", "--json"], env)).stdout);
    assert.equal(js.plugins[0].id, "q");
    const logs = await run([join(BIN, "agenthub"), "logs", "-n", "5"], env);
    assert.match(logs.stdout, /plugin-add/);
    const es = await run([join(BIN, "agenthub"), "pause"], env);
    assert.equal(es.code, 0, es.stderr);
    assert.match(es.stdout, /^Hub paused — /);
    assert.ok(es.stdout.includes(join(home, "ESTOP")), "where the pause file is — as a full path");
    assert.ok(!es.stdout.includes("{"), "no raw JSON");
    assert.ok(existsSync(join(home, "ESTOP")));
    assert.equal((await run([join(BIN, "agenthub"), "estop", "on"], env)).code, 0, "the old command name works");
    d.kill("SIGTERM");
    await waitFor(() => d.exitCode !== null, { timeoutMs: 6000 });
    assert.equal(d.exitCode, 0, err);
    assert.equal(existsSync(sock), false);
    const down = await run([join(BIN, "agenthub"), "status"], env);
    assert.equal(down.code, 2);
  } finally {
    if (d.exitCode === null) d.kill("SIGKILL");
    cleanup(home);
    cleanup(plugins);
  }
});

test("install without --apply doesn't touch ~/Library/LaunchAgents; the plist is valid and has no NODE_OPTIONS", { skip: onlyDarwin("launchd (LaunchAgent, plutil)") }, async () => {
  const target = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const before = existsSync(target);
  const home = tempHome();
  try {
    // agenthub install writes the launchd/ template into the repository (even without --apply) — under a shared lock (helpers.withRepoPlist)
    await withRepoPlist(join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`), async () => {
      const r = await run([join(BIN, "agenthub"), "install", "--app-cert-sha1", "0123456789abcdef0123456789abcdef01234567"], envFor(home, home));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Nothing installed without --apply/);
      assert.match(r.stdout, /certificate leaf = H"0123456789abcdef0123456789abcdef01234567"/);
      assert.equal(existsSync(target), before);
      assert.equal(existsSync(join(home, "config.json")), false);
      const xml = plistXml();
      assert.ok(!xml.includes("NODE_OPTIONS"));
      assert.match(xml, /\/opt\/homebrew\/bin:/);
      const repoPlist = join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`);
      execFileSync("/usr/bin/plutil", ["-lint", repoPlist], { stdio: "ignore" });
      assert.equal(readFileSync(repoPlist, "utf8"), xml);
      const u = await run([join(BIN, "agenthub"), "uninstall"], envFor(home, home));
      assert.match(u.stdout, /Nothing deleted without --apply/);
      assert.throws(() => localAppRequirement("xyz"));
    });
  } finally {
    cleanup(home);
  }
});

test("install --apply --no-launchd: only config.json (app requirement, registry key and URL), launchd is untouched", async () => {
  const target = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const before = existsSync(target);
  const home = tempHome();
  try {
    // agenthub install writes the launchd/ template into the repository (even without --apply) — under a shared lock (helpers.withRepoPlist)
    await withRepoPlist(join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`), async () => {
      const { publicKey: publicKeyText } = generateKeyPair();
      const pub = join(home, "registry.pub");
      writeFileSync(pub, publicKeyText);
      const bad = join(home, "bad.pub");
      writeFileSync(bad, "не ключ\n");
      const e = await run([join(BIN, "agenthub"), "install", "--apply", "--no-launchd", "--registry-pubkey", bad], envFor(home, home));
      assert.notEqual(e.code, 0);
      assert.equal(existsSync(join(home, "config.json")), false);
      const r = await run(
        [join(BIN, "agenthub"), "install", "--apply", "--no-launchd", "--app-cert-sha1", "0123456789abcdef0123456789abcdef01234567", "--registry-pubkey", pub, "--registry-url", "https://example.invalid/index.json"],
        envFor(home, home),
      );
      assert.equal(r.code, 0, r.stderr);
      const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      assert.match(cfg.requirements.app, /certificate leaf = H"0123456789abcdef0123456789abcdef01234567"/);
      assert.equal(cfg.services.plugins.publicKey, publicKeyText.trim());
      assert.equal(cfg.services.plugins.indexUrl, "https://example.invalid/index.json");
      if (FILE_MODES) assert.equal((statSync(join(home, "config.json")).mode & 0o777).toString(8), "600");
      assert.equal(existsSync(target), before, "LaunchAgents is untouched");
    });
  } finally {
    cleanup(home);
  }
});

test("install --apply: the log directory from the plist is created before bootstrap; the daemon didn't come up — a clear error; ProcessType Standard", { skip: onlyDarwin("launchd (launchctl bootstrap)") }, async () => {
  const fakeHome = tempHome("ah-fh-");
  const repoPlist = join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`);
  try {
    await withRepoPlist(repoPlist, async () => {
      const logs = join(fakeHome, "Library", "Application Support", "AgentHub", "logs");
      const calls = join(fakeHome, "launchctl.log");
      const launchctl = join(fakeHome, "launchctl");
      // launchctl double: like the real launchd, the job won't start without a directory for StandardErrorPath (78)
      writeFileSync(launchctl, `#!/bin/sh\necho "$*" >> '${calls}'\nif [ "$1" = bootstrap ] && [ ! -d '${logs}' ]; then exit 78; fi\nexit 0\n`, { mode: 0o755 });
      const env = { ...process.env, HOME: fakeHome, AGENTHUB_TEST_LAUNCHCTL: launchctl, AGENTHUB_INSTALL_WAIT_MS: "400", AGENTHUB_SERVICES: "none" };
      delete env.NODE_OPTIONS;
      delete env.AGENTHUB_HOME;
      const r = await run([join(BIN, "agenthub"), "install", "--apply"], env);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /did not answer/);
      assert.match(r.stderr, /launchctl print|print gui\//);
      assert.equal((statSync(logs).mode & 0o777).toString(8), "700", "the log directory is created before bootstrap");
      assert.match(readFileSync(calls, "utf8"), /^bootstrap gui\/\d+ /m);
      assert.ok(existsSync(join(fakeHome, "Library", "LaunchAgents", `${LABEL}.plist`)));
      assert.match(plistXml(), /<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
    });
  } finally {
    cleanup(fakeHome);
  }
});

test("CLI language: English by default, Russian when the hub language is ru (settings.json or the system language), AGENTHUB_LANG wins", async () => {
  const home = tempHome("ah-lang-");
  const plugins = tempHome("ah-lang-pl-");
  try {
    const env = envFor(home, plugins);
    const cli = (args, extra = {}) => run([join(BIN, "agenthub"), ...args], { ...env, ...extra });
    // no settings.json: the "system" language decides (run sets it to en for the CLI; test mode alone would mean ru)
    assert.match((await cli(["version"])).stdout, /\(working folder\), plugin contract \d+/);
    assert.match((await cli(["version"], { AGENTHUB_SYSTEM_LANG: "ru" })).stdout, /\(рабочая папка\), контракт плагинов \d+/);
    // an explicit hub language in settings.json beats the system language
    writeFileSync(join(home, "settings.json"), '{"lang":"ru"}\n');
    assert.match((await cli(["version"])).stdout, /контракт плагинов/);
    const usage = await cli(["refresh"]);
    assert.equal(usage.code, 64);
    assert.match(usage.stderr, /agenthub refresh <плагин>/);
    const down = await cli(["status"]);
    assert.equal(down.code, 2);
    assert.match(down.stderr, /^демон не отвечает \(/);
    // AGENTHUB_LANG (set by the daemon for its helper processes) wins over settings.json
    assert.match((await cli(["version"], { AGENTHUB_LANG: "en" })).stdout, /plugin contract/);
    writeFileSync(join(home, "settings.json"), '{"lang":"en"}\n');
    assert.match((await cli(["version"], { AGENTHUB_SYSTEM_LANG: "ru" })).stdout, /plugin contract/);
    assert.match((await cli(["version"], { AGENTHUB_LANG: "ru" })).stdout, /контракт плагинов/);
    // machine output stays the same in both languages
    // (brew — the Homebrew source tree when this CLI runs from a brew keg, docs/hub-updates.md §8b; a working folder — null)
    const vj = JSON.parse((await cli(["version", "--json"], { AGENTHUB_LANG: "ru" })).stdout);
    assert.deepEqual(Object.keys(vj), ["version", "contract", "label", "installed", "brew"]);
    assert.equal(vj.brew, null);
  } finally {
    cleanup(home);
    cleanup(plugins);
  }
});
