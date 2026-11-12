// <agenthub.watch> on the plugin's own directories ($AGENTHUB_PLUGIN_DATA_PATH, $AGENTHUB_PLUGIN_CACHE_PATH) for any tier,
// "~" against the plugins' HOME (AGENTHUB_PLUGIN_HOME on a test bench) and recursive="true" (subdirectories too).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchPaths } from "../lib/host.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { Watcher } from "../lib/runner.mjs";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

test("meta: recursive=\"true\" on <agenthub.watch> is remembered per entry; the entry itself is unchanged", () => {
  const { meta, warnings } = parseMetaText(`
# <agenthub.watch recursive="true">~/notes — any note changed</agenthub.watch>
# <agenthub.watch>~/flat.json — the flat file</agenthub.watch>
# <agenthub.watch recursive="yes">~/other — not "true": not recursive</agenthub.watch>
`);
  assert.deepEqual(warnings, []);
  assert.deepEqual(meta.watch, ["~/notes — any note changed", "~/flat.json — the flat file", "~/other — not \"true\": not recursive"]);
  assert.deepEqual(meta.watchRecursive, ["~/notes — any note changed"]);
});

test("watchPaths: own directories are substituted; recursive entries come back as { path, recursive }", () => {
  const vars = { AGENTHUB_PLUGIN_DATA_PATH: "/h/PluginData/p", AGENTHUB_PLUGIN_CACHE_PATH: "/h/Cache/Plugins/p" };
  const entries = ["$AGENTHUB_PLUGIN_DATA_PATH/inbox — new files", "${AGENTHUB_PLUGIN_CACHE_PATH} — anything in the cache", "$AGENTHUB_USAGE_FILE — not given"];
  assert.deepEqual(watchPaths(entries, vars, { recursive: [entries[1]] }), {
    paths: ["/h/PluginData/p/inbox", { path: "/h/Cache/Plugins/p", recursive: true }],
    skipped: ["AGENTHUB_USAGE_FILE"],
  });
  // without the option — strings, as before
  assert.deepEqual(watchPaths(entries.slice(0, 2), vars).paths, ["/h/PluginData/p/inbox", "/h/Cache/Plugins/p"]);
});

test("Watcher: a recursive entry sees a file in a subdirectory, a mask matches the file name; a flat one does not", async () => {
  const dir = tempHome("ah-wrec-");
  const deep = join(dir, "deep");
  const flat = join(dir, "flat");
  mkdirSync(join(deep, "sub"), { recursive: true });
  mkdirSync(join(flat, "sub"), { recursive: true });
  const seen = [];
  const w = new Watcher([{ path: join(deep, "*.json"), recursive: true }, flat], (paths) => seen.push(...paths), { debounceMs: 50 });
  w.start();
  try {
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(deep, "sub", "a.json"), "1");
    writeFileSync(join(deep, "sub", "a.txt"), "1");
    await waitFor(() => seen.some((p) => p.endsWith("a.json")), { timeoutMs: 5000 });
    writeFileSync(join(flat, "sub", "b.json"), "1");
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!seen.some((p) => p.endsWith("a.txt")), "the mask filters by file name");
    assert.ok(!seen.some((p) => p.endsWith("b.json")), "a non-recursive directory does not see its subdirectories");
  } finally {
    w.close();
    cleanup(dir);
  }
});

const WATCHER = (title, watch) => `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
${watch}
echo "run $AGENTHUB_REFRESH_REASON | status=ok"
`;

test("a local plugin watches its own data directory (recursively) and a path under the plugins' HOME", async () => {
  const pluginHome = tempHome("ah-phome-");
  mkdirSync(join(pluginHome, ".tool"), { recursive: true });
  const h = await startHub({ env: { AGENTHUB_PLUGIN_HOME: pluginHome } });
  try {
    const title = (id) => h.core.pluginState(id)?.header?.[0]?.title || "";
    // local ("unverified") tier: service variables are not given, the plugin's own directories are
    writePlugin(h.config.paths.pluginsLocal, "own.1h.sh", WATCHER("Own", `# <agenthub.watch recursive="true">$AGENTHUB_PLUGIN_DATA_PATH — a job file in any subfolder</agenthub.watch>`));
    writePlugin(h.config.paths.pluginsLocal, "home.1h.sh", WATCHER("Home", `# <agenthub.watch>~/.tool/state.json — the tool state</agenthub.watch>`));
    await h.core.host.rescan();
    await waitFor(() => title("own") === "run FirstLaunch" && title("home") === "run FirstLaunch", { timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    const data = join(h.config.paths.pluginData, "own");
    mkdirSync(join(data, "jobs"), { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(data, "jobs", "1.json"), "{}");
    await waitFor(() => title("own") === "run FileChanged", { timeoutMs: 8000 });
    writeFileSync(join(pluginHome, ".tool", "state.json"), "{}");
    await waitFor(() => title("home") === "run FileChanged", { timeoutMs: 8000 });
    assert.ok(!h.core.journal.tail(2000).some((e) => e.type === "warning" && e.plugin === "own" && /AGENTHUB_PLUGIN_DATA_PATH/.test(e.detail || "")), "no 'variable not given' warning");
  } finally {
    await h.stop();
    cleanup(pluginHome);
  }
});
