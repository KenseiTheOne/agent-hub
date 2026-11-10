// Background plugin update check (lib/registry/updates.mjs): the same fetchCatalog and signature, the list in
// /state.pluginUpdates and the plugins.updates event, one notification per version (also after a restart), permission growth,
// switches (the shell setting — app only, and services.plugins.checkUpdates), backoff when the index is unavailable.
// The registry is a temporary directory with synthetic plugins, the index is signed with a key created right here. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { createPeer } from "../lib/peer.mjs";
import { compareVersions, managerFor } from "../lib/plugins.mjs";
import { generateKeyPair, sign } from "../lib/registry/minisign.mjs";
import { packTarGz } from "../lib/registry/tarball.mjs";
import { permissionsFromMeta } from "../lib/registry/perms.mjs";
import { MAX_TIMER_MS, UpdateChecker } from "../lib/registry/updates.mjs";
import { startServer } from "../lib/server.mjs";
import { cleanup, curl, req, tempHome, waitFor } from "./helpers.mjs";

// Hub notification: the subtitle is the gist (label), the body is the detail; the full text is "subtitle: body"
const bannerText = (c) => (c.args[8] ? `${c.args[8]}: ${c.args[6]}` : c.args[6]);

const sha = (b) => createHash("sha256").update(b).digest("hex");
// Synthetic plugins declare the platform the test runs on: the manager doesn't install a foreign one, the host doesn't run it.
const PLATFORM_TAG = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;
const UID = process.getuid();
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";

function appSys(state) {
  const procs = () => ({ [state.pid]: { ppid: 1, path: state.path || APP } });
  return {
    available: true,
    peerPid: () => state.pid,
    peerUid: () => UID,
    pidPath: (pid) => procs()[pid]?.path ?? null,
    pidInfo: (pid) => (procs()[pid] ? { pid, ppid: 1, uid: UID, startSec: 1000, startUsec: 0, comm: "x" } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => `${p}|id`,
    myUid: () => UID,
    readJson: () => {
      throw new Error("ENOENT");
    },
  };
}

function pluginText({ version, extra = "" }) {
  return `#!/bin/sh
# <agenthub.title>Hello</agenthub.title>
# <agenthub.version>${version}</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>${PLATFORM_TAG}</agenthub.platforms>
# <agenthub.fsRead>~/.config/hello/state.json — показать состояние</agenthub.fsRead>
# <agenthub.effects>open.url</agenthub.effects>
${extra}
echo "Hello ${version} | status=ok"
`;
}

let clock = Date.parse("2026-11-05T10:00:00Z");
const nextTime = () => new Date((clock += 60_000)).toISOString();

function publish(dir, plugins, key) {
  mkdirSync(join(dir, "archives"), { recursive: true });
  const entries = [];
  for (const p of plugins) {
    const gz = packTarGz(Object.entries({ [`${p.id}.5m.sh`]: p.text, "README.md": "# r\n" }).map(([rel, data]) => ({ path: `${p.id}/${rel}`, data })));
    const meta = parseMetaText(p.text).meta;
    const name = `${p.id}-${meta.version}.tar.gz`;
    writeFileSync(join(dir, "archives", name), gz);
    entries.push({ id: p.id, version: meta.version, title: meta.title, ...(p.i18n ? { i18n: p.i18n } : {}), platforms: meta.platforms, type: meta.type, archive: `archives/${name}`, sha256: sha(gz), size: gz.length, permissions: permissionsFromMeta(meta) });
  }
  const text = JSON.stringify({ version: 1, generatedAt: nextTime(), plugins: entries, blocklist: [] }, null, 2) + "\n";
  writeFileSync(join(dir, "index.json"), text);
  writeFileSync(join(dir, "index.json.minisig"), sign(Buffer.from(text), key.secretKey));
}

// A daemon inside the test process on the given state directory: a restart uses the same home.
async function boot(home, { reg, key, services = "plugins,push", plugins = {} }) {
  const state = { pid: 4242 };
  const config = loadConfig({
    env: {
      AGENTHUB_HOME: home,
      AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"),
      AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log"),
      AGENTHUB_CLAUDE_HOME: join(home, "claude-home"),
      AGENTHUB_SERVICES: services,
    },
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      services: {
        plugins: { indexUrl: join(reg, "index.json"), publicKey: key.publicKey, allowNetwork: false, updateCheck: { firstDelayMs: 30, intervalMs: 150, jitterMs: 0, backoffMs: [40, 80] }, ...plugins },
        push: { ackTimeoutMs: 50 },
      },
    },
  });
  const peer = createPeer({ config, sys: appSys(state) });
  const core = new Core({ config, peer });
  await core.init();
  const srv = await startServer(core);
  managerFor(home).onChange = () => core.host.rescan();
  return {
    core,
    config,
    state,
    sock: config.paths.socket,
    call: (method, path, body) => req(config.paths.socket, method, path, body),
    async stop() {
      await srv.close();
      await core.stop();
    },
  };
}

function execLog(home) {
  const f = join(home, "exec.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const banners = (home, re) => execLog(home).filter((c) => c.file === "/usr/bin/osascript" && re.test(bannerText(c)));
const fetches = (core) => core.journal.tail(1000).filter((e) => e.type === "registry-fetched").length;

async function installWithConsent(h, id) {
  const r1 = await h.call("POST", "/registry/install", { id });
  if (r1.status === 200) return r1.body;
  assert.equal(r1.status, 428, JSON.stringify(r1.body));
  const r2 = await h.call("POST", "/registry/install", { id, consentToken: r1.body.token });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return r2.body;
}

test("background check: downloads the signed index by itself, the update goes to /state.pluginUpdates and an event, permission growth is visible; one notification, also after a restart", async () => {
  const home = tempHome("ahu-");
  const reg = tempHome("ahu-reg-");
  const key = generateKeyPair();
  let h = null;
  try {
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.0.0" }) }], key);
    h = await boot(home, { reg, key });
    // the first check runs by itself (via firstDelay), without POST /registry/fetch
    await waitFor(() => fetches(h.core) >= 1, { timeoutMs: 5000 });
    await installWithConsent(h, "hello");
    let st = (await h.call("GET", "/state")).body;
    assert.equal(st.pluginUpdates.enabled, true);
    assert.deepEqual(st.pluginUpdates.items, []);

    // a new version with a new permission in the registry: the next background check finds it
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.1.0", extra: "# <agenthub.fsRead>~/.config/hello/extra.json — новое право</agenthub.fsRead>" }) }], key);
    await waitFor(async () => (await h.call("GET", "/state")).body.pluginUpdates.items.length === 1, { timeoutMs: 5000 });
    st = (await h.call("GET", "/state")).body;
    const u = st.pluginUpdates.items[0];
    assert.equal(u.id, "hello");
    assert.equal(u.installed, "1.0.0");
    assert.equal(u.version, "1.1.0");
    assert.equal(u.permissionsGrow, true);
    assert.deepEqual(u.added.map((p) => p.what), ["~/.config/hello/extra.json"]);
    assert.equal(st.pluginUpdates.error, null);
    assert.ok(st.pluginUpdates.checkedAt);
    // an SSE event with the list
    assert.ok(h.core.recent.some((e) => e.type === "plugins.updates" && e.pluginUpdates?.items?.[0]?.version === "1.1.0"));
    // one notification "Доступно обновление: Hello 1.1.0" (no shell — an osascript banner)
    await waitFor(() => banners(home, /^Доступно обновление: Hello 1\.1\.0$/).length === 1, { timeoutMs: 5000 });
    const before = fetches(h.core);
    await waitFor(() => fetches(h.core) >= before + 3, { timeoutMs: 5000 });
    assert.equal(banners(home, /Доступно обновление/).length, 1, "later checks don't repeat it");
    // nothing was installed automatically
    assert.equal(managerFor(home).lockEntry("hello").version, "1.0.0");
    const notified = JSON.parse(readFileSync(join(home, "Registry", "updates.json"), "utf8")).notified;
    assert.ok(notified["hello@1.1.0"]);

    // daemon restart on the same directory: this version was already announced
    await h.stop();
    h = await boot(home, { reg, key });
    const n0 = fetches(h.core);
    await waitFor(() => fetches(h.core) >= n0 + 2, { timeoutMs: 5000 });
    assert.equal((await h.call("GET", "/state")).body.pluginUpdates.items.length, 1);
    assert.equal(banners(home, /Доступно обновление/).length, 1, "not repeated after a restart");

    // an even newer version — one notification again
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.2.0" }) }], key);
    await waitFor(() => banners(home, /^Доступно обновление: Hello 1\.2\.0$/).length === 1, { timeoutMs: 5000 });
    st = (await h.call("GET", "/state")).body;
    assert.equal(st.pluginUpdates.items[0].permissionsGrow, false, "1.2.0 adds no permissions");

    // the update goes through the existing manager flow; after it the list is empty
    await installWithConsent(h, "hello");
    await waitFor(async () => (await h.call("GET", "/state")).body.pluginUpdates.items.length === 0);
    assert.ok(h.core.recent.some((e) => e.type === "plugins.updates" && e.pluginUpdates?.items?.length === 0));
  } finally {
    await h?.stop();
    cleanup(home);
    cleanup(reg);
  }
});

test("switch: the shell setting (app only) and services.plugins.checkUpdates=false — no network and no notifications", async () => {
  const home = tempHome("ahu-");
  const reg = tempHome("ahu-reg-");
  const key = generateKeyPair();
  let h = null;
  try {
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.0.0" }) }], key);
    h = await boot(home, { reg, key });
    await waitFor(() => fetches(h.core) >= 1);
    await installWithConsent(h, "hello");
    // cli doesn't change the setting
    h.state.path = "/usr/bin/curl"; // a process not from AgentHub.app → cli
    const c = await curl(h.sock, "PUT", "/settings/plugin-updates", { enabled: false });
    assert.equal(c.status, 403);
    assert.equal(c.body.error, "peer:cli");
    h.state.path = null;
    assert.equal((await h.call("PUT", "/settings/plugin-updates", { enabled: "no" })).status, 400);
    const off = await h.call("PUT", "/settings/plugin-updates", { enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.checkPluginUpdates.setting, false);
    assert.equal(off.body.pluginUpdates.enabled, false);
    assert.equal(off.body.pluginUpdates.nextCheckAt, null);
    assert.ok(h.core.recent.some((e) => e.type === "settings.changed" && e.checkPluginUpdates === false));
    assert.ok(h.core.recent.some((e) => e.type === "plugins.updates" && e.pluginUpdates?.enabled === false));
    assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).checkPluginUpdates, false);
    const n = fetches(h.core);
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.1.0" }) }], key);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(fetches(h.core), n, "turned off — no network access");
    assert.equal(banners(home, /Доступно обновление/).length, 0);
    assert.equal((await h.call("GET", "/settings")).body.checkPluginUpdates.setting, false);
    // turned on — a check after ~firstDelay, a notification
    assert.equal((await h.call("PUT", "/settings/plugin-updates", { enabled: true })).status, 200);
    await waitFor(() => banners(home, /^Доступно обновление: Hello 1\.1\.0$/).length === 1, { timeoutMs: 5000 });
    await h.stop();

    // services.plugins.checkUpdates = false beats the setting
    h = await boot(home, { reg, key, plugins: { checkUpdates: false } });
    const st = (await h.call("GET", "/state")).body.pluginUpdates;
    assert.equal(st.enabled, false);
    assert.equal(st.config, false);
    assert.equal(st.setting, true);
    const m = fetches(h.core);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fetches(h.core), m);
  } finally {
    await h?.stop();
    cleanup(home);
    cleanup(reg);
  }
});

test("unavailable index: the daemon lives on, the error is in /state.pluginUpdates.error, backoff; the index is back — the error is cleared", async () => {
  const home = tempHome("ahu-");
  const reg = tempHome("ahu-reg-");
  const key = generateKeyPair();
  let h = null;
  try {
    h = await boot(home, { reg, key, services: "plugins" });
    await waitFor(async () => (await h.call("GET", "/state")).body.pluginUpdates?.error === "registry:not-found", { timeoutMs: 5000 });
    const checks = () => h.core.journal.tail(1000).filter((e) => e.type === "registry-update-check");
    assert.equal(checks()[0].ok, false);
    assert.equal((await h.call("GET", "/health")).status, 200);
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.0.0" }) }], key);
    await waitFor(async () => (await h.call("GET", "/state")).body.pluginUpdates?.error === null, { timeoutMs: 5000 });
    assert.ok(checks().some((e) => e.ok === true));
    // signed with a foreign key — the same check as the button: the catalog is rejected, a signature error
    const other = generateKeyPair();
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.0.1" }) }], other);
    await waitFor(async () => /^registry:/.test((await h.call("GET", "/state")).body.pluginUpdates?.error || ""), { timeoutMs: 5000 });
    assert.equal(managerFor(home).catalog.plugins.get("hello").version, "1.0.0");
  } finally {
    await h?.stop();
    cleanup(home);
    cleanup(reg);
  }
});

// Manager double: schedule, backoff, "notify once" without a daemon.
function fakeMgr({ fail = () => null, items = () => [] } = {}) {
  const m = {
    opts: { checkUpdates: true, updateCheck: { firstDelayMs: 5, intervalMs: 1000, jitterMs: 0, backoffMs: [10, 20, 40] } },
    calls: 0,
    configured: () => true,
    pluginUpdates: () => items(),
    async fetchCatalog() {
      m.calls++;
      const e = fail(m.calls);
      if (e) throw Object.assign(new Error(e), { code: e });
      return {};
    },
  };
  return m;
}

test(`UpdateChecker: backoff 10 → 20 → 40 → 40 ms on network errors, the interval after success; "id@version" — once`, async () => {
  const home = tempHome("ahu-");
  try {
    const delays = [];
    const mgr = fakeMgr({ fail: (n) => (n <= 4 ? "registry:fetch" : null), items: () => [{ id: "a", installed: "1.0.0", version: "1.1.0", permissionsGrow: false }] });
    const events = [];
    const c = new UpdateChecker({ mgr, home, emit: (e) => events.push(e), testMode: true, random: () => 0 });
    const orig = c.schedule.bind(c);
    c.schedule = (ms) => delays.push(ms); // no timers: we call every check ourselves
    c.start();
    assert.deepEqual(delays, [5]);
    for (let i = 0; i < 5; i++) await c.check("timer");
    assert.deepEqual(delays.slice(1), [10, 20, 40, 40, 1000]);
    assert.equal(c.info().error, null);
    const ups = events.filter((e) => e.type === "plugins.update-available");
    assert.equal(ups.length, 1, "one notification even though there were five checks");
    assert.deepEqual([ups[0].plugin, ups[0].version], ["a", "1.1.0"]);
    // a new instance (restart) reads updates.json
    const events2 = [];
    const c2 = new UpdateChecker({ mgr, home, emit: (e) => events2.push(e), testMode: true });
    c2.schedule = () => {};
    await c2.check("timer");
    assert.equal(events2.filter((e) => e.type === "plugins.update-available").length, 0);
    c.schedule = orig;
    c.stop();
    // outside test mode — no more than once an hour
    const live = new UpdateChecker({ mgr, home, testMode: false });
    assert.equal(live.timing().intervalMs, 3_600_000);
    assert.equal(live.timing().firstDelayMs, 10_000);
  } finally {
    cleanup(home);
  }
});

test("hub language change: a plugins.updates event with the title in the new language (the shell doesn't re-read /state)", async () => {
  const home = tempHome("ahu-");
  const reg = tempHome("ahu-reg-");
  const key = generateKeyPair();
  let h = null;
  try {
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.0.0" }) }], key);
    // one background check, the next one not soon: the event on a language change isn't from a regular check
    h = await boot(home, { reg, key, services: "plugins", plugins: { updateCheck: { firstDelayMs: 30, intervalMs: 600_000, jitterMs: 0, backoffMs: [600_000] } } });
    assert.equal((await h.call("PUT", "/settings/lang", { lang: "ru" })).status, 200);
    await waitFor(() => fetches(h.core) >= 1);
    await installWithConsent(h, "hello");
    publish(reg, [{ id: "hello", text: pluginText({ version: "1.1.0" }), i18n: { en: { title: "Hi" } } }], key);
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    await waitFor(async () => (await h.call("GET", "/state")).body.pluginUpdates.items[0]?.title === "Hello", { timeoutMs: 5000 });
    const last = () => h.core.recent.filter((e) => e.type === "plugins.updates").at(-1)?.pluginUpdates?.items?.[0]?.title;
    assert.equal(last(), "Hello");
    assert.equal((await h.call("PUT", "/settings/lang", { lang: "en" })).status, 200);
    await waitFor(() => last() === "Hi", { timeoutMs: 2000 });
    assert.equal((await h.call("PUT", "/settings/lang", { lang: "ru" })).status, 200);
    await waitFor(() => last() === "Hello", { timeoutMs: 2000 });
  } finally {
    await h?.stop();
    cleanup(home);
    cleanup(reg);
  }
});

test("UpdateChecker: a repeated error with the same code — an event with a new nextCheckAt; turning off clears the error", async () => {
  const home = tempHome("ahu-");
  try {
    const mgr = fakeMgr({ fail: () => "registry:fetch" });
    mgr.opts.updateCheck = { firstDelayMs: 5, intervalMs: 3_600_000, jitterMs: 0, backoffMs: [600_000, 900_000] };
    const events = [];
    let setting = true;
    const c = new UpdateChecker({ mgr, home, emit: (e) => events.push(e), setting: () => setting, testMode: true, random: () => 0 });
    const ups = () => events.filter((e) => e.type === "plugins.updates");
    await c.check("timer");
    await c.check("timer");
    assert.equal(ups().length, 2, "the same error, but the next check is at a different time");
    assert.notEqual(ups()[0].pluginUpdates.nextCheckAt, ups()[1].pluginUpdates.nextCheckAt);
    assert.equal(ups()[1].pluginUpdates.error, "registry:fetch");
    assert.equal(ups()[1].pluginUpdates.nextCheckAt, c.info().nextCheckAt);
    setting = false;
    c.settingChanged();
    const off = ups().at(-1).pluginUpdates;
    assert.deepEqual([off.enabled, off.error, off.nextCheckAt], [false, null, null]);
    // turned on — backoff from the start
    setting = true;
    c.settingChanged();
    await c.check("timer");
    assert.equal(c.failures, 1);
    c.stop();
  } finally {
    cleanup(home);
  }
});

test("UpdateChecker: an interval above the setTimeout limit (30 days) doesn't turn into 1 ms — one check, no TimeoutOverflowWarning", async () => {
  const home = tempHome("ahu-");
  const warnings = [];
  const onWarn = (w) => warnings.push(w.name);
  process.on("warning", onWarn);
  try {
    const mgr = fakeMgr();
    const DAY = 24 * 3_600_000;
    mgr.opts.updateCheck = { firstDelayMs: 10_000, intervalMs: 30 * DAY, jitterMs: 40 * DAY, backoffMs: [45 * DAY], unconfiguredMs: 50 * DAY };
    const c = new UpdateChecker({ mgr, home, testMode: false, random: () => 1 });
    const t0 = Date.now();
    await c.check("timer");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mgr.calls, 1, "one check, not a loop");
    const left = c.nextAt - t0;
    assert.ok(left >= 70 * DAY - 1000 && left <= 90 * DAY + 1000, `next one in ${left} ms`);
    assert.ok(c.timer, "the timer is armed (in MAX_TIMER_MS chunks)");
    // capped at 90 days
    mgr.opts.updateCheck = { intervalMs: 1e12 };
    assert.equal(c.timing().intervalMs, 90 * DAY);
    assert.ok(MAX_TIMER_MS < 25 * DAY);
    // an error with a huge backoff — also no loop
    mgr.calls = 0;
    const m2 = fakeMgr({ fail: () => "registry:fetch" });
    m2.opts.updateCheck = { intervalMs: 80 * DAY, backoffMs: [60 * DAY] };
    const c2 = new UpdateChecker({ mgr: m2, home, testMode: false, random: () => 0 });
    await c2.check("timer");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(m2.calls, 1);
    c.stop();
    c2.stop();
    assert.ok(!warnings.includes("TimeoutOverflowWarning"), warnings.join(","));
  } finally {
    process.off("warning", onWarn);
    cleanup(home);
  }
});

test("compareVersions: numeric, as in the shell", () => {
  assert.equal(compareVersions("0.4.0", "0.3.9"), 1);
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.2.1", "0.10.0"), -1);
});

test("compareVersions: semver pre-releases, like the shell's PluginVersion.compare", () => {
  // Order from semver.org: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 <
  // 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
    "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(compareVersions(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
  // updating from a beta to a release is newer (previously "0" vs "0-beta" as strings gave -1)
  assert.equal(compareVersions("1.3.0", "1.3.0-beta.1"), 1);
  assert.equal(compareVersions("1.3.0-beta.1", "1.2.9"), 1);
  assert.equal(compareVersions("1.0.0+build.7", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.1+x", "1.0.0-rc.1"), 0);
});
