// Built-in plugins the person turns off (settings.json → builtinOff, PUT /settings/builtin-plugins) and plugins held back
// because a declared requirement (<agenthub.requires check="…">) is missing: neither runs, both stay listed
// (/state.builtinPlugins, /state.heldPlugins), the off state survives `agenthub builtin update` and a hub update, and a missing
// requirement that appears starts the plugin without a restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Settings } from "../lib/settings.mjs";
import { syncBuiltin } from "../lib/builtin-copy.mjs";
import { missingRequires } from "../lib/host.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

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
const overrides = { requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' } };

// A built-in that counts its runs in a file next to itself.
const counting = (title, counter) => `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
echo x >> "${counter}"
echo '${title} | status=ok'
`;
const needing = (title, check) => `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.requires name="Tool X" url="https://example.com/tool-x" check="${check}">the program this plugin reads</agenthub.requires>
# <agenthub.requires lang="en" name="Tool X">the program this plugin reads</agenthub.requires>
# <agenthub.requires lang="ru" name="Tool X" title="Программа X">программа, которую читает плагин</agenthub.requires>
echo '${title} | status=ok'
`;

const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0);
const ids = (st) => st.plugins.map((p) => p.id);

test("settings: builtinOff is kept in settings.json, validated, and a garbled value reads as nothing off", () => {
  const dir = tempHome();
  try {
    const path = join(dir, "settings.json");
    const s = new Settings(path, { detect: () => "en" });
    assert.equal(s.builtinEnabled("alpha"), true);
    s.setBuiltinEnabled("alpha", false);
    s.setBuiltinEnabled("beta", false);
    s.setBuiltinEnabled("alpha", false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).builtinOff, ["alpha", "beta"]);
    assert.deepEqual(new Settings(path, { detect: () => "en" }).get("builtinOff"), ["alpha", "beta"]);
    s.setBuiltinEnabled("beta", true);
    assert.deepEqual(new Settings(path, { detect: () => "en" }).get("builtinOff"), ["alpha"]);
    assert.throws(() => s.setBuiltinEnabled("a b", false), (e) => e.code === "args:id:type");
    assert.throws(() => s.setBuiltinEnabled("alpha", "no"), (e) => e.code === "args:enabled:type");
    writeFileSync(path, JSON.stringify({ builtinOff: ["ok", 5, "../x", "a b", "ok"] }));
    assert.deepEqual(new Settings(path, { detect: () => "en" }).get("builtinOff"), ["ok"]);
    writeFileSync(path, JSON.stringify({ builtinOff: "alpha" }));
    assert.deepEqual(new Settings(path, { detect: () => "en" }).get("builtinOff"), []);
  } finally {
    cleanup(dir);
  }
});

test("the off state survives `agenthub builtin update` and an update re-sync: the copy is replaced, settings.json is not touched", async () => {
  const src = tempHome("ah-src-");
  const home = tempHome();
  let h = null;
  try {
    const counter = join(home, "alpha.count");
    writePlugin(src, "alpha.1h.sh", counting("Alpha", counter));
    writePlugin(src, "beta.1h.sh", counting("Beta", join(home, "beta.count")));
    syncBuiltin({ src, home });
    new Settings(join(home, "settings.json"), { detect: () => "en" }).setBuiltinEnabled("alpha", false);
    // a newer hub brings a changed plugin: the copy is updated, the choice stays
    writePlugin(src, "alpha.1h.sh", counting("Alpha 2", counter));
    const r = syncBuiltin({ src, home });
    assert.deepEqual(r.updated, ["alpha.1h.sh"]);
    syncBuiltin({ src, home });
    assert.deepEqual(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).builtinOff, ["alpha"]);
    // a hub started on that copy does not run it, but lists it
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    h = await startHub({ pluginsDir: join(home, "Builtin"), settingsFile: settings });
    await waitFor(() => h.core.pluginState("beta")?.header.length);
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(ids(st), ["beta"]);
    assert.deepEqual(st.builtinPlugins.map((b) => [b.id, b.enabled, b.running, b.held]), [["alpha", false, false, "off"], ["beta", true, true, null]]);
    assert.equal(st.builtinPlugins[0].title, "Alpha 2");
    assert.deepEqual(st.heldPlugins, [{ id: "alpha", source: "builtin", reason: "off", requires: [] }]);
    assert.equal(lines(counter), 0, "never ran");
  } finally {
    await h?.stop();
    cleanup(src);
    cleanup(home);
  }
});

test("PUT /settings/builtin-plugins: app only, journaled; off — stopped and not run again (no frames), files kept; on — runs again", async () => {
  const plugins = tempHome("ah-pl-");
  const state = { who: "app" };
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(state) });
  const counter = join(h.home, "alpha.count");
  try {
    writePlugin(plugins, "alpha.1h.sh", counting("Alpha", counter));
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("alpha")?.header.length);
    const dataDir = join(h.config.paths.pluginData, "alpha");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "keep.json"), "{}");

    // cli cannot turn it off; bad bodies; an id that is not a built-in
    state.who = "cli";
    assert.equal((await req(h.sock, "PUT", "/settings/builtin-plugins", { id: "alpha", enabled: false })).status, 403);
    state.who = "app";
    assert.equal((await req(h.sock, "PUT", "/settings/builtin-plugins", { id: "alpha", enabled: "no" })).status, 400);
    assert.equal((await req(h.sock, "PUT", "/settings/builtin-plugins", { enabled: false })).status, 400);
    const unknown = await req(h.sock, "PUT", "/settings/builtin-plugins", { id: "nope", enabled: false });
    assert.deepEqual([unknown.status, unknown.body.error], [404, "builtin:unknown"]);

    const seen = [];
    h.core.on("settings.changed", (ev) => ev.builtinPlugins && seen.push(ev.builtinPlugins));
    const off = await req(h.sock, "PUT", "/settings/builtin-plugins", { id: "alpha", enabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.builtinPlugins.map((b) => [b.id, b.enabled, b.running, b.held]), [["alpha", false, false, "off"]]);
    assert.equal(seen.length, 1);
    assert.equal(h.core.pluginState("alpha"), null, "no section");
    assert.ok(!h.core.host.instances.has("alpha"));
    const j = h.core.journal.tail(50);
    assert.ok(j.some((e) => e.type === "settings-changed" && e.key === "builtinPlugins" && e.plugin === "alpha" && e.value === false && e.peer === "app"));
    assert.ok(j.some((e) => e.type === "plugin-held" && e.plugin === "alpha" && e.reason === "off"));
    assert.ok(!j.some((e) => e.type === "warning" && e.plugin === "alpha"), "held is not a refusal");
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, "settings.json"), "utf8")).builtinOff, ["alpha"]);
    assert.ok(existsSync(join(plugins, "alpha.1h.sh")) && existsSync(join(dataDir, "keep.json")), "files and PluginData stay");
    assert.deepEqual((await req(h.sock, "GET", "/settings")).body.builtinPlugins.map((b) => b.enabled), [false]);

    // rescans, a refresh request and an edit of the file do not bring it back
    const runs = lines(counter);
    await h.core.host.rescan();
    assert.equal(h.core.host.refresh("alpha", "Manual"), false);
    writePlugin(plugins, "alpha.1h.sh", counting("Alpha edited", counter));
    await h.core.host.rescan();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lines(counter), runs, "no run while off");
    assert.equal(h.core.pluginState("alpha"), null);
    assert.equal(h.core.journal.tail(100).filter((e) => e.type === "plugin-held" && e.plugin === "alpha").length, 1, "journaled once");

    // on — the same request again (idempotent), then on
    assert.equal((await req(h.sock, "PUT", "/settings/builtin-plugins", { id: "alpha", enabled: false })).status, 200);
    assert.equal(seen.length, 1, "no change — no event");
    const on = await req(h.sock, "PUT", "/settings/builtin-plugins", { id: "alpha", enabled: true });
    assert.deepEqual(on.body.builtinPlugins.map((b) => [b.enabled, b.running, b.held]), [[true, true, null]]);
    await waitFor(() => h.core.pluginState("alpha")?.header.length);
    await waitFor(() => lines(counter) > runs);
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, "settings.json"), "utf8")).builtinOff, []);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("a turned-off sessions plugin does not make the idle verdict \"don't know about sessions\"", async () => {
  const plugins = tempHome("ah-pl-");
  // the hub's sessions source (lib/idle.mjs) that is unsure of itself: an "unknown" line while it runs
  writePlugin(plugins, "claude-sessions.1h.sh", `#!/bin/sh
# <agenthub.title>Сессии</agenthub.title>
echo 'Сессии | status=unknown why="no sessions directory"'
`);
  const state = { who: "app" };
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(state), services: "idle" });
  try {
    await waitFor(() => h.core.snapshot().idle?.items.some((i) => i.kind === "unknown" && i.source === "sessions"));
    const r = await req(h.sock, "PUT", "/settings/builtin-plugins", { id: "claude-sessions", enabled: false });
    assert.equal(r.status, 200);
    await waitFor(() => !h.core.snapshot().idle?.items.some((i) => i.kind === "unknown"));
    const v = h.core.snapshot().idle;
    assert.equal(v.verdict, "quiet");
    assert.ok(v.checked.includes("Сессии"));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("requirements: missingRequires looks in the plugins' HOME", () => {
  const home = tempHome();
  try {
    const { meta } = parseMetaText(needing("Gamma", "~/.tool-x"));
    assert.deepEqual(missingRequires(meta, home).map((r) => r.name), ["Tool X"]);
    mkdirSync(join(home, ".tool-x"));
    assert.deepEqual(missingRequires(meta, home), []);
    assert.deepEqual(missingRequires(parseMetaText("# <agenthub.title>G</agenthub.title>").meta, home), []);
  } finally {
    cleanup(home);
  }
});

test("a plugin whose requirement is missing is held back (any source): listed with its declared requirement, started once it appears, stopped when it goes", async () => {
  const plugins = tempHome("ah-pl-");
  const phome = tempHome("ah-phome-");
  writePlugin(plugins, "gamma.1h.sh", needing("Gamma", "~/.tool-x"));
  writePlugin(plugins, "delta.1h.sh", counting("Delta", join(phome, "delta.count")));
  const h = await startHub({ pluginsDir: plugins, env: { AGENTHUB_PLUGIN_HOME: phome, AGENTHUB_SYSTEM_LANG: "ru" } });
  try {
    await waitFor(() => h.core.pluginState("delta")?.header.length);
    // a local plugin with the same kind of requirement is held the same way
    writePlugin(h.config.paths.pluginsLocal, "eps.1h.sh", needing("Eps", "~/.tool-x"));
    await h.core.host.rescan();
    let st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(ids(st), ["delta"]);
    const g = st.builtinPlugins.find((b) => b.id === "gamma");
    assert.deepEqual([g.enabled, g.running, g.held], [true, false, "requires"]);
    // the requirement's declared name and note, in the hub language
    assert.deepEqual(g.requires, [{ name: "Программа X", url: "https://example.com/tool-x", note: "программа, которую читает плагин", check: "~/.tool-x", present: false }]);
    assert.deepEqual(st.heldPlugins.map((x) => [x.id, x.source, x.reason]), [["eps", "local", "requires"], ["gamma", "builtin", "requires"]]);
    const j = h.core.journal.tail(100);
    assert.ok(j.some((e) => e.type === "plugin-held" && e.plugin === "gamma" && e.reason === "requires" && e.requires[0] === "Tool X"));
    assert.ok(!j.some((e) => e.type === "warning" && (e.plugin === "gamma" || e.plugin === "eps")), "not a refusal");
    await h.core.host.rescan();
    assert.equal(h.core.journal.tail(100).filter((e) => e.type === "plugin-held" && e.plugin === "gamma").length, 1, "journaled once");

    // the program appears: both start without a restart or a manual rescan (the requirement watch)
    const events = [];
    h.core.on("plugins.held", (ev) => events.push(ev));
    mkdirSync(join(phome, ".tool-x"));
    await waitFor(() => h.core.pluginState("gamma")?.header.length && h.core.pluginState("eps")?.header.length, { timeoutMs: 10_000 });
    st = (await req(h.sock, "GET", "/state")).body;
    assert.deepEqual(st.heldPlugins, []);
    assert.equal(st.builtinPlugins.find((b) => b.id === "gamma").requires[0].present, true);
    assert.ok(events.some((e) => Array.isArray(e.heldPlugins) && e.heldPlugins.length === 0));

    // it goes away: the next scan stops them and holds them again
    rmSync(join(phome, ".tool-x"), { recursive: true });
    await h.core.host.rescan();
    assert.equal(h.core.pluginState("gamma"), null);
    assert.equal(h.core.pluginState("eps"), null);
    assert.deepEqual(h.core.heldPluginList().map((x) => x.id), ["eps", "gamma"]);

    // turned off wins over a missing requirement: the reason is "off"
    h.core.settings.setBuiltinEnabled("gamma", false);
    await h.core.host.rescan();
    assert.equal(h.core.builtinPluginList().find((b) => b.id === "gamma").held, "off");
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(phome);
  }
});

test("built-in plugins of this repo declare what they need: Claude ones Claude Code (~/.claude), Codex ones Codex (~/.codex)", () => {
  const repo = join(import.meta.dirname, "..", "..", "plugins");
  const want = { agents: "~/.claude", "claude-sessions": "~/.claude", quota: "~/.claude", spend: "~/.claude", "codex-sessions": "~/.codex", "codex-quota": "~/.codex", "codex-spend": "~/.codex" };
  for (const [dir, check] of Object.entries(want)) {
    const file = ["", ".5m"].map((s) => join(repo, dir, `${dir}${s}.mjs`)).find(existsSync);
    const { meta, warnings } = parseMetaText(readFileSync(file, "utf8"));
    assert.deepEqual(warnings, [], dir);
    assert.deepEqual(meta.requires.map((r) => r.check), [check], dir);
    assert.ok(meta.i18n.en.requires[meta.requires[0].name].note, `${dir}: an English note`);
  }
});
