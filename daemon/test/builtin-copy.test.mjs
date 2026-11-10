// The copy of built-in plugins in <home>/Builtin (agenthub install --apply, agenthub builtin update), the test-mode
// marker in /state.hub and the plugin author (name before login) — in /state and in the registry catalog.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR, REPO_DIR } from "../lib/config.mjs";
import { cleanAuthor } from "../lib/author.mjs";
import { builtinStatus, MANIFEST, pointConfigAtCopy, syncBuiltin } from "../lib/builtin-copy.mjs";
import { LABEL } from "../lib/launchd.mjs";
import { cleanup, curl, onlyDarwin, startHub, tempHome, waitFor, withRepoPlist, writePlugin } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");
const mode = (p) => (statSync(p).mode & 0o777).toString(8);

// The CLI speaks the hub language, and test mode makes the "system" language ru: these checks read the English CLI
// (a daemon started through run keeps its own language).
function run(args, env) {
  const e = /[\\/]agenthub$/.test(args[0] || "") ? { AGENTHUB_SYSTEM_LANG: "en", ...env } : env;
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: e, timeout: 15_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

function srcTree() {
  const src = tempHome("ah-src-");
  writePlugin(join(src, "alpha"), "alpha.30s.mjs", "// <agenthub.title>A</agenthub.title>\nconsole.log('a')\n", 0o644);
  writePlugin(join(src, "alpha", "fixtures"), "x.json", "{}\n", 0o644);
  writePlugin(src, "beta.1m.sh", "#!/bin/sh\necho b\n", 0o755);
  writeFileSync(join(src, ".gitkeep"), "");
  symlinkSync("/etc/hosts", join(src, "link.txt"));
  return src;
}

test("syncBuiltin: copy with modes 0700/0600/0700, no dot-files or links; repeat — no changes; edit, removal and manifest", () => {
  const src = srcTree();
  const home = tempHome();
  try {
    const r = syncBuiltin({ src, home });
    const dest = join(home, "Builtin");
    assert.equal(r.dest, dest);
    assert.deepEqual(r.added.sort(), ["alpha/alpha.30s.mjs", "alpha/fixtures/x.json", "beta.1m.sh"]);
    assert.deepEqual(r.skipped, ["link.txt"]);
    assert.equal(mode(dest), "700");
    assert.equal(mode(join(dest, "alpha")), "700");
    assert.equal(mode(join(dest, "alpha", "fixtures")), "700");
    assert.equal(mode(join(dest, "alpha", "alpha.30s.mjs")), "600");
    assert.equal(mode(join(dest, "beta.1m.sh")), "700", "executable — 0700");
    assert.equal(existsSync(join(dest, ".gitkeep")), false);
    assert.equal(existsSync(join(dest, "link.txt")), false);
    const man = JSON.parse(readFileSync(join(dest, MANIFEST), "utf8"));
    assert.equal(mode(join(dest, MANIFEST)), "600");
    assert.equal(Object.keys(man.files).length, 3);
    assert.match(man.files["beta.1m.sh"], /^[0-9a-f]{64}$/);

    const mt = statSync(join(dest, "beta.1m.sh")).mtimeMs;
    const again = syncBuiltin({ src, home });
    assert.deepEqual([again.added, again.updated, again.removed], [[], [], []]);
    assert.equal(again.same, 3);
    assert.equal(statSync(join(dest, "beta.1m.sh")).mtimeMs, mt, "an unchanged file is not rewritten — the plugin does not restart");

    writeFileSync(join(src, "alpha", "alpha.30s.mjs"), "// <agenthub.title>A2</agenthub.title>\n");
    rmSync(join(src, "alpha", "fixtures"), { recursive: true });
    const st = builtinStatus({ src, home });
    assert.deepEqual(st.updated, ["alpha/alpha.30s.mjs"]);
    assert.deepEqual(st.removed, ["alpha/fixtures/x.json", "alpha/fixtures/"]);
    const dry = syncBuiltin({ src, home, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.match(readFileSync(join(dest, "alpha", "alpha.30s.mjs"), "utf8"), /<agenthub.title>A</, "--dry-run writes nothing");
    const upd = syncBuiltin({ src, home });
    assert.deepEqual(upd.updated, ["alpha/alpha.30s.mjs"]);
    assert.match(readFileSync(join(dest, "alpha", "alpha.30s.mjs"), "utf8"), /A2/);
    assert.equal(existsSync(join(dest, "alpha", "fixtures")), false);
    assert.equal(mode(join(dest, "alpha", "alpha.30s.mjs")), "600");
  } finally {
    cleanup(src);
    cleanup(home);
  }
});

test("syncBuiltin: a Builtin symlink is rejected; pointConfigAtCopy keeps the other keys, 0600", () => {
  const src = srcTree();
  const home = tempHome();
  const elsewhere = tempHome("ah-else-");
  try {
    symlinkSync(elsewhere, join(home, "Builtin"));
    assert.throws(() => syncBuiltin({ src, home }), /is a link/);
    rmSync(join(home, "Builtin"));
    const cfg = join(home, "config.json");
    writeFileSync(cfg, JSON.stringify({ requirements: { app: "x" }, services: { push: { enabled: false } } }));
    const p1 = pointConfigAtCopy(cfg, join(home, "Builtin"));
    assert.deepEqual(p1, { changed: true, before: null });
    const j = JSON.parse(readFileSync(cfg, "utf8"));
    assert.equal(j.builtinPluginsDir, join(home, "Builtin"));
    assert.equal(j.requirements.app, "x");
    assert.equal(j.services.push.enabled, false);
    assert.equal(mode(cfg), "600");
    assert.equal(pointConfigAtCopy(cfg, join(home, "Builtin")).changed, false);
    writeFileSync(cfg, "{not json");
    assert.throws(() => pointConfigAtCopy(cfg, join(home, "Builtin")), /couldn't be parsed/);
  } finally {
    cleanup(src);
    cleanup(home);
    cleanup(elsewhere);
  }
});

test("agenthub builtin update/status in a temporary AGENTHUB_HOME; the \"(copy)\" marker follows the running daemon, not config.json; the daemon takes plugins from the copy", async () => {
  const src = tempHome("ah-src-");
  const home = tempHome();
  writePlugin(src, "q.1h.sh", "#!/bin/sh\necho 'Квота 1% | status=ok'\n");
  const env = { ...process.env, AGENTHUB_HOME: home, AGENTHUB_SERVICES: "none" };
  delete env.NODE_OPTIONS;
  delete env.AGENTHUB_BUILTIN_PLUGINS;
  const cli = (...a) => run([join(BIN, "agenthub"), ...a], env);
  let hub;
  try {
    const st0 = await cli("builtin", "--from", src);
    assert.match(st0.stdout, /no copy/);
    assert.match(st0.stdout, /repository working tree/, "by default — from the repo, as before");
    assert.equal(st0.code, 1);
    const dry = await cli("builtin", "update", "--dry-run", "--from", src);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(existsSync(join(home, "Builtin")), false);

    // the daemon runs on another directory (like the live one on <repo>/plugins before the switch)
    hub = await startHub({ env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: src } });
    const up = await cli("builtin", "update", "--from", src);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /added: 1/);
    assert.match(up.stdout, /Restart it/);
    // test directory: the hint is our own daemon, not launchctl kickstart of the live hub
    assert.match(up.stdout, /test directory/);
    assert.doesNotMatch(up.stdout, /^\s+launchctl kickstart/m);
    assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).builtinPluginsDir, join(home, "Builtin"));
    // config.json already points at the copy, but the daemon has not been restarted — the check fails
    const stStale = await cli("builtin", "--from", src);
    assert.equal(stStale.code, 1, stStale.stdout);
    assert.match(stStale.stdout, /daemon now:\s+\S+/);
    assert.match(stStale.stdout, /has not switched/);
    const upStale = await cli("builtin", "update", "--from", src);
    assert.doesNotMatch(upStale.stdout, /already runs on the copy/);
    assert.match(upStale.stdout, /Restart it/);
    await hub.stop();
    hub = null;

    // no daemon — "(copy)" in config.json is not confirmation yet
    const stDown = await cli("builtin", "--from", src);
    assert.equal(stDown.code, 1);
    assert.match(stDown.stdout, /not responding/);

    // daemon restarted: config.json points at the copy (AGENTHUB_BUILTIN_PLUGINS not set)
    hub = await startHub({ env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: "" } });
    const st1 = await cli("builtin", "--from", src);
    assert.equal(st1.code, 0, st1.stdout);
    assert.match(st1.stdout, /daemon now:.*\(copy\)/);
    assert.match(st1.stdout, /the copy matches/);
    writeFileSync(join(src, "q.1h.sh"), "#!/bin/sh\necho 'Квота 2% | status=ok'\n");
    const st2 = await cli("builtin", "--from", src);
    assert.equal(st2.code, 1);
    assert.match(st2.stdout, /changed:\s+q\.1h\.sh/);
    const up2 = await cli("builtin", "update", "--from", src);
    assert.match(up2.stdout, /already runs on the copy/);

    await waitFor(async () => /Квота 2%/.test((await curl(hub.sock, "GET", "/state")).body?.plugins?.find((p) => p.id === "q")?.header?.[0]?.title || ""), { timeoutMs: 8000 });
    const st = (await curl(hub.sock, "GET", "/state")).body;
    assert.equal(st.hub.builtin, "copy");
    assert.equal(st.hub.builtinDir, join(home, "Builtin"));
    assert.equal(st.hub.testMode, true);
    const q = st.plugins.find((p) => p.id === "q");
    assert.equal(q.tier, "builtin");
    assert.equal(q.file, join(home, "Builtin", "q.1h.sh"));
  } finally {
    await hub?.stop().catch(() => {});
    cleanup(src);
    cleanup(home);
  }
});

test("/state.hub: directory, test mode, where built-ins come from; plugin author — name and login", async () => {
  const pl = tempHome("ah-pl-");
  writePlugin(pl, "t.1h.sh", "#!/bin/sh\n# <agenthub.author.name>Kensei</agenthub.author.name>\n# <agenthub.author.github>KenseiTheOne</agenthub.author.github>\necho 'ok | status=ok'\n");
  const hub = await startHub({ pluginsDir: pl });
  try {
    const st = (await curl(hub.sock, "GET", "/state")).body;
    assert.equal(st.hub.home, hub.home);
    assert.equal(st.hub.testMode, true);
    assert.equal(st.hub.builtin, "custom");
    assert.equal(st.hub.builtinDir, pl);
    // this daemon's CLI — for commands in shell hints (agenthub pin-app)
    assert.equal(st.hub.cli, join(DAEMON_DIR, "bin", "agenthub"));
    const t = st.plugins.find((p) => p.id === "t");
    assert.deepEqual(t.author, { name: "Kensei", github: "KenseiTheOne" });
  } finally {
    await hub.stop();
    cleanup(pl);
  }
  assert.deepEqual(cleanAuthor({ name: " Kensei ", github: "KenseiTheOne" }), { name: "Kensei", github: "KenseiTheOne" });
  assert.deepEqual(cleanAuthor({ name: "a‮b", github: "bad login" }), {});
  assert.deepEqual(cleanAuthor({ github: "-x" }), {});
  assert.deepEqual(cleanAuthor(null), {});
});

test("repository built-in plugins: author Kensei and login KenseiTheOne", () => {
  for (const f of ["agents/agents.mjs", "claude-sessions/claude-sessions.mjs", "quota/quota.5m.mjs"]) {
    const s = readFileSync(join(REPO_DIR, "plugins", f), "utf8");
    assert.match(s, /<agenthub\.author\.name>Kensei<\/agenthub\.author\.name>/, f);
    assert.match(s, /<agenthub\.author\.github>KenseiTheOne<\/agenthub\.author\.github>/, f);
  }
});

test("install --apply: copy of built-in plugins in the state directory and builtinPluginsDir in config.json before bootstrap", { skip: onlyDarwin("install with launchd (launchctl double)") }, async () => {
  const fakeHome = tempHome("ah-fh-");
  const repoPlist = join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`);
  try {
    await withRepoPlist(repoPlist, async () => {
      const state = join(fakeHome, "Library", "Application Support", "AgentHub");
      const launchctl = join(fakeHome, "launchctl");
      const seen = join(fakeHome, "seen.log");
      // launchctl double: on bootstrap it records whether config.json with the copy already existed
      writeFileSync(launchctl, `#!/bin/sh\nif [ "$1" = bootstrap ]; then cat '${join(state, "config.json")}' > '${seen}' 2>/dev/null; fi\nexit 0\n`, { mode: 0o755 });
      const env = { ...process.env, HOME: fakeHome, AGENTHUB_TEST_LAUNCHCTL: launchctl, AGENTHUB_INSTALL_WAIT_MS: "300" };
      delete env.NODE_OPTIONS;
      delete env.AGENTHUB_HOME;
      delete env.AGENTHUB_BUILTIN_PLUGINS;
      const plan = await run([join(BIN, "agenthub"), "install"], env);
      assert.match(plan.stdout, /copy the built-in plugins/);
      assert.equal(existsSync(join(state, "Builtin")), false, "nothing is copied without --apply");
      const r = await run([join(BIN, "agenthub"), "install", "--apply"], env);
      assert.match(r.stdout, /built-in plugins copied/);
      const dest = join(state, "Builtin");
      assert.equal(mode(dest), "700");
      for (const f of ["agents/agents.mjs", "claude-sessions/claude-sessions.mjs", "quota/quota.5m.mjs"]) {
        assert.equal(readFileSync(join(dest, f), "utf8"), readFileSync(join(REPO_DIR, "plugins", f), "utf8"), f);
        assert.equal(mode(join(dest, f)), "600");
      }
      assert.equal(JSON.parse(readFileSync(seen, "utf8")).builtinPluginsDir, dest, "config.json points at the copy before bootstrap");
    });
  } finally {
    cleanup(fakeHome);
  }
});

test("install --apply in test mode (AGENTHUB_HOME) does not copy built-in plugins", async () => {
  const home = tempHome();
  try {
    // agenthub install writes the launchd/ template into the repository (even without --apply) — under a shared lock (helpers.withRepoPlist)
    await withRepoPlist(join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`), async () => {
      const env = { ...process.env, AGENTHUB_HOME: home };
      delete env.NODE_OPTIONS;
      const r = await run([join(BIN, "agenthub"), "install", "--apply", "--no-launchd", "--registry-url", "https://example.invalid/index.json"], env);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(existsSync(join(home, "Builtin")), false);
      assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).builtinPluginsDir, undefined);
    });
  } finally {
    cleanup(home);
  }
});

test("install --apply with launchd and AGENTHUB_HOME on another directory — refused: launchd is not touched, no copy is made", { skip: onlyDarwin("install with launchd (launchctl double)") }, async () => {
  const fakeHome = tempHome("ah-fh-");
  const other = join(fakeHome, "other");
  const repoPlist = join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`);
  try {
    await withRepoPlist(repoPlist, async () => {
      const launchctl = join(fakeHome, "launchctl");
      const seen = join(fakeHome, "seen.log");
      writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> '${seen}'\nexit 0\n`, { mode: 0o755 });
      const env = { ...process.env, HOME: fakeHome, AGENTHUB_HOME: other, AGENTHUB_TEST_LAUNCHCTL: launchctl, AGENTHUB_INSTALL_WAIT_MS: "300" };
      delete env.NODE_OPTIONS;
      delete env.AGENTHUB_BUILTIN_PLUGINS;
      // the plan (without --apply) is shown with a warning, the install — refused
      const plan = await run([join(BIN, "agenthub"), "install"], env);
      assert.equal(plan.code, 0, plan.stderr);
      assert.match(plan.stderr, /test directory/);
      assert.match(plan.stdout, /--apply will refuse/);
      assert.doesNotMatch(plan.stdout, /copy the built-in plugins/);
      const r0 = await run([join(BIN, "agenthub"), "install", "--apply"], env);
      assert.equal(r0.code, 2, r0.stdout);
      assert.match(r0.stderr, /test directory/);
      assert.match(r0.stderr, /env -u AGENTHUB_HOME/);
      assert.equal(existsSync(seen), false, "launchctl was not called");
      assert.equal(existsSync(join(fakeHome, "Library", "LaunchAgents")), false, "plist not written to LaunchAgents");
      assert.equal(existsSync(join(fakeHome, "Library", "Application Support", "AgentHub")), false);
      assert.equal(existsSync(other), false);

      // an AGENTHUB_HOME equal to the live directory is the live hub itself: the copy is made
      const live = join(fakeHome, "Library", "Application Support", "AgentHub");
      const r = await run([join(BIN, "agenthub"), "install", "--apply"], { ...env, AGENTHUB_HOME: live });
      assert.match(r.stdout, /built-in plugins copied/);
      assert.equal(JSON.parse(readFileSync(join(live, "config.json"), "utf8")).builtinPluginsDir, join(live, "Builtin"));
      assert.match(readFileSync(seen, "utf8"), /bootstrap/);
    });
  } finally {
    cleanup(fakeHome);
  }
});
