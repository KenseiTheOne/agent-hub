// Watching a service cache file via a variable (<agenthub.watch>$AGENTHUB_USAGE_FILE — …): the core substitutes the path
// only for trusted plugins; the plugin restarts right after the cache is written (FileChanged), without waiting for its
// interval. Rename quota.30s.mjs → quota.5m.mjs: `agenthub builtin update` removes the old file from the copy,
// no second quota is left.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR, REPO_DIR } from "../lib/config.mjs";
import { syncBuiltin } from "../lib/builtin-copy.mjs";
import { scanDir, watchPaths } from "../lib/host.mjs";
import { readPluginMeta } from "../lib/meta.mjs";
import { writeCache } from "../lib/services/usage.mjs";
import { cleanup, curl, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

test("watchPaths: $NAME and ${NAME} — from the core's variables for this plugin; no variable — entry skipped", () => {
  const vars = { AGENTHUB_USAGE_FILE: "/h/Cache/usage.json" };
  assert.deepEqual(watchPaths(["$AGENTHUB_USAGE_FILE — кэш квоты"], vars), { paths: ["/h/Cache/usage.json"], skipped: [] });
  assert.deepEqual(watchPaths(["${AGENTHUB_USAGE_FILE}.d — x", "~/.claude/task-runs/batch — y"], vars), { paths: ["/h/Cache/usage.json.d", "~/.claude/task-runs/batch"], skipped: [] });
  assert.deepEqual(watchPaths(["$AGENTHUB_USAGE_FILE — кэш"], {}), { paths: [], skipped: ["AGENTHUB_USAGE_FILE"] });
  // a relative value isn't substituted (watching only the service's absolute path)
  assert.deepEqual(watchPaths(["$AGENTHUB_X"], { AGENTHUB_X: "rel/path" }), { paths: [], skipped: ["AGENTHUB_X"] });
  // the real quota: watches exactly the usage service cache
  const q = readPluginMeta(join(REPO_DIR, "plugins", "quota", "quota.5m.mjs"));
  assert.equal(q.interval, "5m");
  assert.deepEqual(watchPaths(q.meta.watch, vars).paths, ["/h/Cache/usage.json"]);
});

const WATCHER = (title) => `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.watch>$AGENTHUB_USAGE_FILE — кэш квоты записан</agenthub.watch>
echo "run $AGENTHUB_REFRESH_REASON | status=ok"
`;

test("built-in plugin with a watch on $AGENTHUB_USAGE_FILE restarts right after the usage service writes the cache; a local one doesn't", async () => {
  const builtin = tempHome("ahu-b-");
  writePlugin(builtin, "w.5m.sh", WATCHER("W"));
  // the usage service in test mode without a network double: writes the cache with error=no-endpoint, doesn't go to the network
  const h = await startHub({ pluginsDir: builtin, services: "usage", overrides: { services: { usage: { firstDelayMs: 400, backoffCapMs: 300 } } } });
  try {
    const title = (id) => h.core.pluginState(id)?.header?.[0]?.title || "";
    await waitFor(() => title("w") === "run FirstLaunch");
    const cache = join(h.config.paths.pluginCache, "usage.json");
    assert.equal(existsSync(cache), false, "no cache yet — the watch waits for it to appear");
    // a local plugin with the same watch: the core doesn't give it the variable
    writePlugin(h.config.paths.pluginsLocal, "lw.5m.sh", WATCHER("LW"));
    await h.core.host.rescan();
    await waitFor(() => title("lw") === "run FirstLaunch");
    await waitFor(() => title("w") === "run FileChanged", { timeoutMs: 5000 });
    assert.equal(existsSync(cache), true);
    // subsequent writes (atomic, via rename) — runs again
    const at = h.core.pluginState("w").lastRunAt;
    writeCache(cache, { version: 1, rows: [] });
    await waitFor(() => h.core.pluginState("w").lastRunAt !== at && title("w") === "run FileChanged", { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(title("lw"), "run FirstLaunch", "the path isn't substituted for a local plugin — it runs on its interval");
    assert.ok(h.core.journal.tail(2000).some((e) => e.type === "warning" && e.plugin === "lw" && /AGENTHUB_USAGE_FILE/.test(e.detail)), "warning in the log");
  } finally {
    await h.stop();
    cleanup(builtin);
  }
});

// The CLI speaks the hub language, and test mode makes the "system" language ru: these checks read the English CLI
// (a daemon started through run keeps its own language).
function run(args, env) {
  const e = /[\\/]agenthub$/.test(args[0] || "") ? { AGENTHUB_SYSTEM_LANG: "en", ...env } : env;
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: e, timeout: 15_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test("rename quota.30s.mjs → quota.5m.mjs: builtin update removes the old file from the copy, one quota (interval 5m)", async () => {
  const home = tempHome("ahu-");
  const src = tempHome("ahu-src-");
  try {
    // a copy taken before the rename: src has the old name
    cpSync(join(REPO_DIR, "plugins"), src, { recursive: true });
    renameSync(join(src, "quota", "quota.5m.mjs"), join(src, "quota", "quota.30s.mjs"));
    syncBuiltin({ src, home });
    assert.deepEqual(readdirSync(join(home, "Builtin", "quota")).filter((f) => f.endsWith(".mjs")), ["quota.30s.mjs"]);

    // now — as in the repository; agenthub builtin update from the command line
    renameSync(join(src, "quota", "quota.30s.mjs"), join(src, "quota", "quota.5m.mjs"));
    const env = { ...process.env, AGENTHUB_HOME: home, AGENTHUB_SERVICES: "none" };
    delete env.NODE_OPTIONS;
    delete env.AGENTHUB_BUILTIN_PLUGINS;
    const up = await run([join(DAEMON_DIR, "bin", "agenthub"), "builtin", "update", "--from", src], env);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /\+ quota\/quota\.5m\.mjs/);
    assert.match(up.stdout, /- quota\/quota\.30s\.mjs/);
    assert.deepEqual(readdirSync(join(home, "Builtin", "quota")).filter((f) => f.endsWith(".mjs")), ["quota.5m.mjs"]);
    const quotas = scanDir(join(home, "Builtin"), "builtin").plugins.filter((p) => p.id === "quota");
    assert.equal(quotas.length, 1);
    assert.equal(quotas[0].interval, "5m");

    // the daemon on the copy sees one quota
    const h = await startHub({ pluginsDir: join(home, "Builtin") });
    try {
      const st = (await curl(h.sock, "GET", "/state")).body;
      const q = st.plugins.filter((p) => p.id === "quota");
      assert.equal(q.length, 1);
      assert.equal(q[0].interval, "5m");
      assert.match(q[0].file, /quota\.5m\.mjs$/);
    } finally {
      await h.stop();
    }

    // from the real repository: an old copy with quota.30s.mjs → the same result
    const home2 = tempHome("ahu-");
    try {
      mkdirSync(join(home2, "Builtin", "quota"), { recursive: true });
      writeFileSync(join(home2, "Builtin", "quota", "quota.30s.mjs"), "// старая копия\n");
      const r = syncBuiltin({ home: home2 });
      assert.ok(r.removed.includes("quota/quota.30s.mjs"));
      assert.deepEqual(readdirSync(join(home2, "Builtin", "quota")).filter((f) => f.endsWith(".mjs")), ["quota.5m.mjs"]);
    } finally {
      cleanup(home2);
    }
  } finally {
    cleanup(home);
    cleanup(src);
  }
});
