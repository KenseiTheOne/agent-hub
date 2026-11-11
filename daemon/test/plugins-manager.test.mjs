// Stage 8, the plugin manager in the daemon: signed catalog, install by sha256, plugins.lock, consent on
// permission growth, removal, blocklist, Plugins/local, app-only access. The registry is a temporary directory with
// synthetic plugins; signing keys are generated right here. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { managerFor, PluginManager, unverifiedLabel } from "../lib/plugins.mjs";
import { generateKeyPair, sign } from "../lib/registry/minisign.mjs";
import { packTarGz } from "../lib/registry/tarball.mjs";
import { permissionsFromMeta } from "../lib/registry/perms.mjs";
import { cleanup, curl, FILE_MODES, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
// Synthetic plugins declare the platform the test runs on: the manager does not install a foreign one, the host does not run it.
const PLATFORM_TAG = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;
const UID = process.getuid();
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";

// Every connection comes from the "app" with the pid from state.pid (the app signature is a double).
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

function pluginText({ version = "1.0.0", effects = "open.url", extra = "", line = "Hello | status=ok" } = {}) {
  return `#!/bin/sh
# <agenthub.title>Hello</agenthub.title>
# <agenthub.version>${version}</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>${PLATFORM_TAG}</agenthub.platforms>
# <agenthub.fsRead>~/.config/hello/state.json — показать состояние</agenthub.fsRead>
# <agenthub.effects>${effects}</agenthub.effects>
${extra}
echo "${line}"
echo "---"
echo 'Сайт | effect="open.url https://example.com"'
`;
}

// Publishing the registry into directory dir: archives + index.json (+ a signature with key).
function publish(dir, plugins, { key, generatedAt = new Date().toISOString(), blocklist = [], tamper = null } = {}) {
  mkdirSync(join(dir, "archives"), { recursive: true });
  const entries = [];
  for (const p of plugins) {
    const main = `${p.id}.5m.sh`;
    const files = { [main]: p.text, "README.md": "# r\n", ...(p.files || {}) };
    const gz = packTarGz(Object.entries(files).map(([rel, data]) => ({ path: `${p.id}/${rel}`, data })));
    const meta = parseMetaText(p.text).meta;
    const name = `${p.id}-${meta.version}.tar.gz`;
    writeFileSync(join(dir, "archives", name), gz);
    entries.push({
      id: p.id,
      version: meta.version,
      title: meta.title,
      platforms: meta.platforms,
      type: meta.type,
      ...(p.tier ? { tier: p.tier } : {}),
      official: p.tier === "official",
      archive: `archives/${name}`,
      sha256: sha(gz),
      size: gz.length,
      permissions: p.permissions || permissionsFromMeta(meta),
      ...(p.entry || {}),
    });
  }
  const text = JSON.stringify({ version: 1, generatedAt, plugins: entries, blocklist }, null, 2) + "\n";
  writeFileSync(join(dir, "index.json"), text);
  writeFileSync(join(dir, "index.json.minisig"), sign(Buffer.from(text), key.secretKey));
  if (tamper) tamper(dir, entries);
  return entries;
}

let clock = Date.parse("2026-11-04T10:00:00Z");
const nextTime = () => new Date((clock += 60_000)).toISOString();

async function hubWithRegistry({ key = generateKeyPair(), builtin = null } = {}) {
  const reg = tempHome("ah-reg-");
  const state = { pid: 4242 };
  const h = await startHub({
    pluginsDir: builtin,
    services: "plugins",
    sys: appSys(state),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      services: { plugins: { indexUrl: join(reg, "index.json"), publicKey: key.publicKey, allowNetwork: false } },
    },
  });
  // What the service does via ctx.rescanPlugins (offered to the core): rescan right after editing Plugins/.
  // fs.watch in one process with dozens of daemon launches loses FSEvents events — the tests do not rely on it.
  const rescan = () => h.core.host.rescan();
  managerFor(h.config.paths.home).onChange = rescan;
  const stop = h.stop;
  return Object.assign(h, {
    rescan,
    reg,
    key,
    state,
    call: (method, path, body) => req(h.sock, method, path, body),
    async stop() {
      await stop();
      cleanup(reg);
    },
  });
}

async function installWithConsent(h, id) {
  const r1 = await h.call("POST", "/registry/install", { id });
  assert.equal(r1.status, 428, JSON.stringify(r1.body));
  const r2 = await h.call("POST", "/registry/install", { id, consentToken: r1.body.token });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return { consent: r1.body, result: r2.body };
}

test("install: signed catalog → permissions window with \"why\" → consent → Plugins/<id> and plugins.lock; the core runs it", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    const f = await h.call("POST", "/registry/fetch");
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal(f.body.plugins, 1);
    const cat = await h.call("GET", "/registry/catalog");
    assert.equal(cat.body.plugins[0].id, "hello");
    assert.equal(cat.body.plugins[0].installed, null);
    const { consent, result } = await installWithConsent(h, "hello");
    assert.equal(consent.needsConsent, true);
    assert.deepEqual(
      consent.permissions.find((p) => p.kind === "fsRead"),
      { kind: "fsRead", what: "~/.config/hello/state.json", why: "показать состояние", added: true },
    );
    assert.equal(result.version, "1.0.0");
    const file = join(h.config.paths.plugins, "hello", "hello.5m.sh");
    assert.ok(existsSync(file));
    const lockStat = statSync(h.config.paths.pluginsLock);
    if (FILE_MODES) assert.equal(lockStat.mode & 0o777, 0o600);
    const lock = JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8"));
    assert.equal(lock.plugins.hello.version, "1.0.0");
    assert.deepEqual(lock.plugins.hello.granted.effects, ["open.url"]);
    assert.ok(lock.plugins.hello.files["hello.5m.sh"]);
    const st = await waitFor(() => h.core.pluginState("hello")?.lastRunAt && h.core.pluginState("hello"), { timeoutMs: 8000 });
    assert.equal(st.source, "installed");
    assert.equal(st.trusted, false);
    assert.deepEqual(st.effects, ["open.url"]);
    // a repeated token does not work (one-time)
    const again = await h.call("POST", "/registry/install", { id: "hello", consentToken: consent.token });
    assert.equal(again.status, 403);
    assert.equal(again.body.error, "consent:invalid");
  } finally {
    await h.stop();
  }
});

test("an update with permission growth is not applied without consent; without growth it is applied right away", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installWithConsent(h, "hello");
    const file = join(h.config.paths.plugins, "hello", "hello.5m.sh");
    const v1 = readFileSync(file, "utf8");
    // v2: a new exec permission and a new effect
    publish(h.reg, [{ id: "hello", text: pluginText({ version: "2.0.0", effects: "open.url,cmux.focus", extra: "# <agenthub.exec>/usr/bin/true — проверка</agenthub.exec>" }) }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const cat = await h.call("GET", "/registry/catalog");
    assert.equal(cat.body.plugins[0].updateAvailable, true);
    assert.deepEqual(cat.body.plugins[0].growth.map((p) => p.kind).sort(), ["effects", "exec"]);
    const r = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(r.status, 428);
    assert.equal(r.body.update, true);
    assert.equal(r.body.fromVersion, "1.0.0");
    assert.deepEqual(r.body.added.map((p) => `${p.kind}:${p.what}`).sort(), ["effects:cmux.focus", "exec:/usr/bin/true"]);
    // no consent — v1 is still on disk and in lock
    assert.equal(readFileSync(file, "utf8"), v1);
    assert.equal(JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")).plugins.hello.version, "1.0.0");
    // a token of another app process is not accepted
    h.state.pid = 4343;
    const other = await h.call("POST", "/registry/install", { id: "hello", consentToken: r.body.token });
    assert.equal(other.status, 403);
    assert.equal(other.body.error, "consent:invalid");
    assert.equal(readFileSync(file, "utf8"), v1);
    h.state.pid = 4242;
    // v1.1 without growth relative to the agreed permissions — installs without a window
    publish(h.reg, [{ id: "hello", text: pluginText({ version: "1.1.0", line: "Hello v1.1 | status=ok" }) }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const up = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.update, true);
    assert.match(readFileSync(file, "utf8"), /1\.1\.0/);
    await waitFor(() => h.core.pluginState("hello")?.header?.[0]?.title === "Hello v1.1", { timeoutMs: 8000 });
  } finally {
    await h.stop();
  }
});

test("a signature with a foreign key is rejected (including a foreign key under the same keyId), the catalog does not change", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: generateKeyPair(), generatedAt: nextTime() });
    const r = await h.call("POST", "/registry/fetch");
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "registry:foreign-key");
    // forgery: our keyId, a foreign signing key
    const alien = generateKeyPair();
    const mineId = JSON.parse(h.key.secretKey).keyId;
    const forged = JSON.stringify({ ...JSON.parse(alien.secretKey), keyId: mineId });
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: { secretKey: forged }, generatedAt: nextTime() });
    const r2 = await h.call("POST", "/registry/fetch");
    assert.equal(r2.status, 422);
    assert.equal(r2.body.error, "registry:signature");
    // editing index.json after signing
    publish(h.reg, [{ id: "hello", text: pluginText() }], {
      key: h.key,
      generatedAt: nextTime(),
      tamper: (dir) => appendFileSync(join(dir, "index.json"), " "),
    });
    assert.equal((await h.call("POST", "/registry/fetch")).body.error, "registry:signature");
    const cat = await h.call("GET", "/registry/catalog");
    assert.deepEqual(cat.body.plugins, []);
    assert.equal((await h.call("POST", "/registry/install", { id: "hello" })).body.error, "registry:no-catalog");
  } finally {
    await h.stop();
  }
});

test("rolling the catalog back to an old generatedAt is rejected; an archive not matching sha256 too", async () => {
  const h = await hubWithRegistry();
  try {
    const newer = nextTime();
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: newer });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: "2020-01-01T00:00:00.000Z" });
    const r = await h.call("POST", "/registry/fetch");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "registry:rollback");
    publish(h.reg, [{ id: "hello", text: pluginText() }], {
      key: h.key,
      generatedAt: nextTime(),
      tamper: (dir, entries) => appendFileSync(join(dir, entries[0].archive), "x"),
    });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    const inst = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(inst.status, 422);
    assert.equal(inst.body.error, "registry:sha256");
    assert.ok(!existsSync(join(h.config.paths.plugins, "hello")));
  } finally {
    await h.stop();
  }
});

test("a third-party plugin with effects=session.stop: the manager does not install it, and the core does not grant the effect even with a planted lock", async () => {
  const h = await hubWithRegistry();
  try {
    const text = pluginText({ effects: "open.url,session.stop", line: "Bad | status=ok" }) + "echo 'Стоп | effect=\"session.stop pid=1\"'\n";
    publish(h.reg, [{ id: "bad", text }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r = await h.call("POST", "/registry/install", { id: "bad" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "registry:lint");
    assert.ok(r.body.errors.some((e) => e.includes("session.stop")), r.body.errors.join("\n"));
    assert.ok(!existsSync(join(h.config.paths.plugins, "bad")));
    // bypassing the manager: plant files and an agreed lock with session.stop — the core holds the ceiling
    const lock = JSON.parse(existsSync(h.config.paths.pluginsLock) ? readFileSync(h.config.paths.pluginsLock, "utf8") : '{"version":1,"plugins":{}}');
    const perms = permissionsFromMeta(parseMetaText(text).meta);
    lock.plugins.bad = { id: "bad", version: "1.0.0", sha256: "0".repeat(64), granted: perms, files: { "bad.5m.sh": sha(Buffer.from(text)) }, disabled: null };
    writeFileSync(h.config.paths.pluginsLock, JSON.stringify(lock), { mode: 0o600 });
    writePlugin(join(h.config.paths.plugins, "bad"), "bad.5m.sh", text, 0o700);
    await h.rescan();
    const st = await waitFor(() => h.core.pluginState("bad")?.lastRunAt && h.core.pluginState("bad"), { timeoutMs: 8000 });
    assert.deepEqual(st.effects, ["open.url"]);
    const stop = st.body.find((b) => b.title === "Стоп");
    assert.ok(stop && !stop.offer, "effect=session.stop must not become an offer");
  } finally {
    await h.stop();
  }
});

test("tampering with an installed plugin's files or a plugin bypassing lock — the core does not run it", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installWithConsent(h, "hello");
    await waitFor(() => h.core.pluginState("hello"), { timeoutMs: 8000 });
    // a permission appended to the file on disk
    appendFileSync(join(h.config.paths.plugins, "hello", "hello.5m.sh"), "# <agenthub.exec>/bin/rm — ой</agenthub.exec>\n");
    await h.rescan();
    await waitFor(() => !h.core.pluginState("hello"), { timeoutMs: 8000 });
    await waitFor(() => h.core.journal.tail(200).some((e) => e.type === "warning" && e.plugin === "hello" && /tampered/.test(e.detail || "")), { timeoutMs: 8000 });
    // a plugin bypassing the manager
    writePlugin(join(h.config.paths.plugins, "rogue"), "rogue.5m.sh", pluginText(), 0o700);
    await h.rescan();
    await waitFor(() => h.core.journal.tail(200).some((e) => e.type === "warning" && e.plugin === "rogue" && /not-in-lock/.test(e.detail || "")), { timeoutMs: 8000 });
    assert.equal(h.core.pluginState("rogue"), null);
  } finally {
    await h.stop();
  }
});

test("blocklist: an installed plugin is disabled (leaves Plugins/), installation is forbidden; removal from the list brings it back", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installWithConsent(h, "hello");
    await waitFor(() => h.core.pluginState("hello"), { timeoutMs: 8000 });
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime(), blocklist: [{ id: "hello", reason: "крадёт токены" }] });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    assert.ok(!existsSync(join(h.config.paths.plugins, "hello")));
    assert.ok(existsSync(join(h.config.paths.home, "Registry", "disabled", "hello", "hello.5m.sh")));
    assert.equal(JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")).plugins.hello.disabled.reason, "blocklist");
    await waitFor(() => !h.core.pluginState("hello"), { timeoutMs: 8000 });
    const r = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "registry:blocklist");
    const cat = await h.call("GET", "/registry/catalog");
    assert.equal(cat.body.plugins[0].blocked, "крадёт токены");
    // removed from the blocklist — the files match lock, the plugin comes back
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    assert.ok(existsSync(join(h.config.paths.plugins, "hello", "hello.5m.sh")));
    await waitFor(() => h.core.pluginState("hello"), { timeoutMs: 8000 });
  } finally {
    await h.stop();
  }
});

test("removal: files, the lock entry and the cache go away; the core removes the plugin", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installWithConsent(h, "hello");
    await waitFor(() => h.core.pluginState("hello"), { timeoutMs: 8000 });
    const r = await h.call("POST", "/registry/remove", { id: "hello" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!existsSync(join(h.config.paths.plugins, "hello")));
    assert.equal(JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")).plugins.hello, undefined);
    await waitFor(() => !h.core.pluginState("hello"), { timeoutMs: 8000 });
    assert.equal((await h.call("POST", "/registry/remove", { id: "hello" })).status, 404);
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "plugin-removed-by-user" && e.plugin === "hello"));
  } finally {
    await h.stop();
  }
});

test("Plugins/local: \"unverified\", effects only open.*", async () => {
  const h = await hubWithRegistry();
  try {
    writePlugin(h.config.paths.pluginsLocal, "dev.5m.sh", pluginText({ effects: "open.url,cmux.focus,session.stop" }));
    await h.rescan();
    const st = await waitFor(() => h.core.pluginState("dev")?.lastRunAt && h.core.pluginState("dev"), { timeoutMs: 8000 });
    assert.equal(st.source, "local");
    assert.deepEqual(st.effects, ["open.url"]);
    const inst = await h.call("GET", "/registry/installed");
    const dev = inst.body.local.find((p) => p.id === "dev");
    assert.equal(dev.label, unverifiedLabel());
    assert.deepEqual(dev.effectsCeiling, ["open.*"]);
  } finally {
    await h.stop();
  }
});

test("install and removal are app-only: curl gets 403 peer:cli, reading the catalog is allowed", async () => {
  const h = await hubWithRegistry();
  try {
    h.state.path = "/usr/bin/curl"; // any process not from AgentHub.app → cli
    for (const [m, p, b] of [
      ["POST", "/registry/install", { id: "hello" }],
      ["POST", "/registry/remove", { id: "hello" }],
      ["POST", "/registry/fetch", undefined],
    ]) {
      const r = await curl(h.sock, m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.body.error, "peer:cli");
    }
    assert.equal((await curl(h.sock, "GET", "/registry/catalog")).status, 200);
    assert.equal((await curl(h.sock, "GET", "/registry/installed")).status, 200);
  } finally {
    await h.stop();
  }
});

test("ESTOP: install — 423", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    writeFileSync(h.config.paths.estop, "test\n");
    const r = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(r.status, 423);
  } finally {
    await h.stop();
  }
});

test("a builtin plugin's id cannot be installed", async () => {
  const builtin = tempHome("ah-bi-");
  writePlugin(builtin, "hello.1h.sh", "#!/bin/sh\necho 'B | status=ok'\n");
  const h = await hubWithRegistry({ builtin });
  try {
    publish(h.reg, [{ id: "hello", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "registry:id-taken");
  } finally {
    await h.stop();
    cleanup(builtin);
  }
});

test("permissions in the archive wider than in the index — rejected", async () => {
  const h = await hubWithRegistry();
  try {
    const text = pluginText({ extra: "# <agenthub.net>api.example.com — статус</agenthub.net>" });
    publish(h.reg, [{ id: "hello", text, permissions: permissionsFromMeta(parseMetaText(pluginText()).meta) }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "registry:archive-permissions");
  } finally {
    await h.stop();
  }
});

test("an archive with a dot file or paths differing only in case — rejected", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "hello", text: pluginText(), files: { ".hidden": "x" } }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(r.status, 422);
    assert.match(r.body.detail, /dot-файл/);
    publish(h.reg, [{ id: "hello", text: pluginText(), files: { "lib/A.txt": "a", "lib/a.txt": "b" } }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r2 = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(r2.status, 422);
    assert.match(r2.body.detail, /регистра/);
  } finally {
    await h.stop();
  }
});

test("startup: whatever sits in Plugins/ bypassing lock goes to quarantine; the saved catalog is re-verified", async () => {
  const home = tempHome("ah-mgr-");
  try {
    const key = generateKeyPair();
    const config = loadConfig({ env: { AGENTHUB_HOME: home }, overrides: { services: { plugins: { publicKey: key.publicKey } } } });
    mkdirSync(join(config.paths.plugins, "rogue"), { recursive: true });
    writeFileSync(join(config.paths.plugins, "rogue", "rogue.5m.sh"), pluginText());
    writeFileSync(join(config.paths.plugins, "loose.5m.sh"), pluginText());
    mkdirSync(join(config.paths.pluginsLocal), { recursive: true });
    writeFileSync(join(config.paths.pluginsLocal, "dev.5m.sh"), pluginText());
    // a saved catalog signed with a foreign key
    mkdirSync(join(home, "Registry"), { recursive: true });
    const text = JSON.stringify({ version: 1, generatedAt: nextTime(), plugins: [] });
    writeFileSync(join(home, "Registry", "index.json"), text);
    writeFileSync(join(home, "Registry", "index.json.minisig"), sign(Buffer.from(text), generateKeyPair().secretKey));
    const m = new PluginManager({ config });
    await m.init();
    assert.equal(m.catalog, null);
    assert.equal(m.catalogError, "registry:foreign-key");
    const moved = m.reconcile();
    assert.deepEqual(moved.sort(), ["loose", "rogue"]);
    assert.ok(!existsSync(join(config.paths.plugins, "rogue")));
    assert.ok(!existsSync(join(config.paths.plugins, "loose.5m.sh")));
    assert.ok(existsSync(join(config.paths.pluginsLocal, "dev.5m.sh")), "Plugins/local is left alone");
  } finally {
    cleanup(home);
  }
});

// Official plugin: the tier only from the signed index; actions are the declared ones, with an argument matching the pattern.
const OFFICIAL_TEXT = `#!/bin/sh
# <agenthub.title>Off</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>${PLATFORM_TAG}</agenthub.platforms>
# <agenthub.effects>open.url</agenthub.effects>
# <agenthub.action id="skip" level="confirm" arg="taskId:^[A-Za-z0-9;_-]{1,40}$" title="Пропустить задачу">off.5m.sh --action skip {taskId}</agenthub.action>
# <agenthub.action id="stop" level="confirm" title="Остановить">off.5m.sh --action stop</agenthub.action>
# <agenthub.push key="thing-broke" quiet="true">Что-то сломалось</agenthub.push>
if [ "$1" = "--action" ]; then
  printf '%s\\n' "$@" > "$AGENTHUB_PLUGIN_DATA_PATH/argv.txt"
  if [ "$2" = "stop" ]; then echo ok; exit 0; fi
  if [ "$AGENTHUB_LANG" = "en" ]; then echo "message=Another run holds the task"; else echo "message=Задачу держит другой прогон"; fi
  echo "reason=demo-refused"
  exit 3
fi
echo "Off | status=ok"
echo "---"
echo "Пропустить | action=skip arg=T-1;echo"
echo "Ключ | action=skip arg=-rf"
echo "Без аргумента | action=skip"
echo "Остановить | action=stop"
`;

test("official from the signed index: tier official, actions with an argument — 428 to the app, 403 to cli, argv without a shell", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "off", text: OFFICIAL_TEXT, tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const cat = await h.call("GET", "/registry/catalog");
    assert.equal(cat.body.plugins[0].tier, "official");
    await installWithConsent(h, "off");
    const lock = JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8"));
    assert.equal(lock.plugins.off.tier, "official");
    const inst = await h.call("GET", "/registry/installed");
    assert.deepEqual([inst.body.installed[0].tier, inst.body.installed[0].removable], ["official", true]);
    const st = await waitFor(() => h.core.pluginState("off")?.lastRunAt && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st.source, st.tier, st.trusted], ["installed", "official", true]);
    assert.deepEqual(st.actions.map((a) => [a.id, a.level, a.arg?.name ?? null]), [["skip", "confirm", "taskId"], ["stop", "confirm", null]]);
    assert.deepEqual(st.pushRules.map((r) => r.key), ["thing-broke"], "push rules are kept for a trusted plugin");
    const offers = st.body.filter((i) => i.offer).map((i) => i.title);
    assert.deepEqual(offers, ["Пропустить", "Остановить"], "arg=-rf and a missing arg are not offers");
    const skip = st.body.find((i) => i.title === "Пропустить").offer;
    assert.equal(skip.kind, "action");
    assert.equal(skip.label, "Пропустить задачу T-1;echo");
    const journal = readFileSync(h.config.paths.journal, "utf8");
    assert.match(journal, /action=skip: arg option-like/);
    assert.match(journal, /action=skip: arg required/);

    // cli: does not even get a confirmation token
    h.state.path = "/usr/bin/curl";
    const denied = await curl(h.sock, "POST", `/actions/${skip.id}`, {});
    assert.deepEqual([denied.status, denied.body.error], [403, "peer:cli"]);
    h.state.path = APP;
    // app: 428, the core writes the text (plugin tier, command, argument); arguments from the body are not accepted
    const c = await h.call("POST", `/actions/${skip.id}`, { args: { taskId: "evil" } });
    assert.equal(c.status, 428);
    assert.equal(c.body.level, "confirm");
    assert.match(c.body.text, /^«Off» \(официальный плагин\) просит: «Пропустить задачу» для T-1;echo\. Выполнится: off\.5m\.sh --action skip T-1;echo$/);
    const done = await h.call("POST", `/actions/${skip.id}`, { confirmToken: c.body.token });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.ok, done.body.result.code, done.body.result.reason], [false, 3, "demo-refused"]);
    // contract 2: the plugin writes the refusal explanation itself in the hub language (message=), the core passes it as is
    assert.equal(done.body.result.message, h.core.lang() === "en" ? "Another run holds the task" : "Задачу держит другой прогон");
    const argv = readFileSync(join(h.config.paths.pluginData, "off", "argv.txt"), "utf8").trim().split("\n");
    assert.deepEqual(argv, ["--action", "skip", "T-1;echo"], "the argument is a single argv element, no shell");
    // an action without an argument
    const stop = st.body.find((i) => i.title === "Остановить").offer;
    const c2 = await h.call("POST", `/actions/${stop.id}`, {});
    const d2 = await h.call("POST", `/actions/${stop.id}`, { confirmToken: c2.body.token });
    assert.equal(d2.body.ok, true);
    assert.deepEqual(readFileSync(join(h.config.paths.pluginData, "off", "argv.txt"), "utf8").trim().split("\n"), ["--action", "stop"]);
    // the token is bound to the offer: the skip token does not fit stop
    const c3 = await h.call("POST", `/actions/${skip.id}`, {});
    const wrong = await h.call("POST", `/actions/${stop.id}`, { confirmToken: c3.body.token });
    assert.deepEqual([wrong.status, wrong.body.error], [403, "confirm:invalid"]);
  } finally {
    await h.stop();
  }
});

test("the tier is not from metadata: <agenthub.tier>official on community is third-party, without actions; removing the official one removes it", async () => {
  const h = await hubWithRegistry();
  try {
    const text = OFFICIAL_TEXT.replace("# <agenthub.title>Off</agenthub.title>", "# <agenthub.title>Off</agenthub.title>\n# <agenthub.tier>official</agenthub.tier>");
    // the manager will not install community with actions (linter) — we put it bypassing the manager, like a planted lock
    publish(h.reg, [{ id: "off", text, tier: "community" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r = await h.call("POST", "/registry/install", { id: "off" });
    assert.deepEqual([r.status, r.body.error], [422, "registry:lint"]);
    const perms = permissionsFromMeta(parseMetaText(text).meta);
    const lock = { version: 1, plugins: { off: { id: "off", version: "1.0.0", sha256: "0".repeat(64), granted: perms, files: { "off.5m.sh": sha(Buffer.from(text)) }, disabled: null } } };
    writeFileSync(h.config.paths.pluginsLock, JSON.stringify(lock), { mode: 0o600 });
    writePlugin(join(h.config.paths.plugins, "off"), "off.5m.sh", text, 0o700);
    await h.rescan();
    const st = await waitFor(() => h.core.pluginState("off")?.lastRunAt && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st.tier, st.trusted, st.official], ["community", false, false]);
    assert.deepEqual(st.actions, []);
    assert.deepEqual(st.pushRules, []);
    assert.ok(!st.body.some((i) => i.offer), "actions are unavailable to a third-party plugin");
    // tier official written into lock bypassing the manager does not make it official: the catalog calls off community
    lock.plugins.off.tier = "official";
    lock.plugins.off.official = true;
    writeFileSync(h.config.paths.pluginsLock, JSON.stringify(lock), { mode: 0o600 });
    await h.rescan();
    await new Promise((r) => setTimeout(r, 300));
    const st2 = h.core.pluginState("off");
    assert.deepEqual([st2.tier, st2.trusted, st2.actions.length], ["community", false, 0]);
    const inst = await h.call("GET", "/registry/installed");
    assert.equal(inst.body.installed[0].tier, "community", "the manager shows the same tier as the policy");
    const rm = await h.call("POST", "/registry/remove", { id: "off" });
    assert.equal(rm.status, 200);
    await h.rescan();
    await waitFor(() => !h.core.pluginState("off"), { timeoutMs: 8000 });
  } finally {
    await h.stop();
  }
});

test("index: tier and official do not conflict; tier outside official|community — rejected", async () => {
  const { parseIndex } = await import("../lib/plugins.mjs");
  const base = { id: "x", version: "1.0.0", sha256: "a".repeat(64), archive: "archives/x.tgz", size: 1, permissions: {} };
  const idx = (e) => JSON.stringify({ version: 1, generatedAt: "2026-11-04T00:00:00Z", plugins: [{ ...base, ...e }] });
  assert.equal(parseIndex(idx({ tier: "official", official: true })).plugins.get("x").tier, "official");
  assert.equal(parseIndex(idx({ official: true })).plugins.get("x").tier, "official", "an old index without tier");
  assert.equal(parseIndex(idx({})).plugins.get("x").tier, "community");
  assert.throws(() => parseIndex(idx({ tier: "builtin" })), /index-entry/);
  assert.throws(() => parseIndex(idx({ tier: "official", official: false })), /index-entry/);
  assert.throws(() => parseIndex(idx({ tier: "community", official: true })), /index-entry/);
});

// Process table for claudeAncestor: pid → { ppid, path, argv }.
function procSys(table, { signed = () => false } = {}) {
  return {
    available: true,
    pidInfo: (pid) => (table[pid] ? { pid, ppid: table[pid].ppid, uid: UID, startSec: 1, startUsec: 0 } : null),
    pidPath: (pid) => table[pid]?.path ?? null,
    procArgv: (pid) => table[pid]?.argv ?? null,
    codeInfo: null,
    codesignVerify: async (path) => signed(path),
    fileId: (p) => `${p}|id`,
    myUid: () => UID,
    readJson: () => {
      throw new Error("ENOENT");
    },
  };
}
// a human in their own terminal: node ← zsh ← Terminal ← launchd
const HUMAN = { sys: procSys({ 100: { ppid: 50, path: "/usr/local/bin/node", argv: ["node", "agenthub"] }, 50: { ppid: 40, path: "/bin/zsh" }, 40: { ppid: 1, path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" } }), pid: 100, env: {} };

test("install from the terminal (agenthub plugins install): the same manager, an index signed with the test key, TTY and typing the id only", async () => {
  const { terminalInstall, terminalRemove } = await import("../lib/registry/terminal.mjs");
  const key = generateKeyPair();
  const reg = tempHome("ah-reg-");
  const home = tempHome("ah-term-");
  try {
    const config = loadConfig({
      env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"), AGENTHUB_SERVICES: "none" },
      overrides: { services: { plugins: { indexUrl: join(reg, "index.json"), publicKey: key.publicKey, allowNetwork: false } } },
    });
    publish(reg, [{ id: "off", text: OFFICIAL_TEXT, tier: "official" }], { key, generatedAt: nextTime() });
    const out = [];
    await assert.rejects(terminalInstall({ config, id: "off", ask: async () => "off", out: (t) => out.push(t), isTTY: false, ...HUMAN }), /terminal:no-tty/);
    const no = await terminalInstall({ config, id: "off", ask: async () => "yes", out: (t) => out.push(t), isTTY: true, ...HUMAN });
    assert.equal(no.declined, true);
    assert.ok(!existsSync(join(config.paths.plugins, "off")));
    assert.match(out.join("\n"), /Install "Off" 1\.0\.0 \(official/);
    assert.match(out.join("\n"), /action: skip \[confirm\] off\.5m\.sh --action skip \{taskId\} \{taskId:\^\[A-Za-z0-9;_-\]\{1,40\}\$\}/);
    const ok = await terminalInstall({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, ...HUMAN });
    assert.equal(ok.ok, true);
    const lock = JSON.parse(readFileSync(config.paths.pluginsLock, "utf8"));
    assert.equal(lock.plugins.off.tier, "official");
    assert.ok(existsSync(join(config.paths.plugins, "off", "off.5m.sh")));
    // a foreign key — rejected even before the permissions window
    const other = generateKeyPair();
    publish(reg, [{ id: "off", text: OFFICIAL_TEXT, tier: "official" }], { key: other, generatedAt: nextTime() });
    await assert.rejects(terminalInstall({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, ...HUMAN }), /registry:/);
    const rm = await terminalRemove({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, ...HUMAN });
    assert.equal(rm.ok, true);
    assert.ok(!existsSync(join(config.paths.plugins, "off")));
  } finally {
    cleanup(reg);
    cleanup(home);
  }
});

// ---------- review of the migration pass: the tier comes from the currently verified catalog ----------

const offText = ({ version = "1.0.0", stop = 'level="confirm" title="Остановить">off.5m.sh --action stop' } = {}) => `#!/bin/sh
# <agenthub.title>Off</agenthub.title>
# <agenthub.version>${version}</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>${PLATFORM_TAG}</agenthub.platforms>
# <agenthub.effects>open.url</agenthub.effects>
# <agenthub.action id="stop" ${stop}</agenthub.action>
if [ "$1" = "--action" ]; then printf '%s\\n' "$@" > "$AGENTHUB_PLUGIN_DATA_PATH/argv.txt"; echo ok; exit 0; fi
echo "Off ${version} | status=ok"
echo "---"
echo "Остановить | action=stop"
`;

async function installAny(h, id) {
  const r1 = await h.call("POST", "/registry/install", { id });
  if (r1.status === 200) return r1.body;
  assert.equal(r1.status, 428, JSON.stringify(r1.body));
  const r2 = await h.call("POST", "/registry/install", { id, consentToken: r1.body.token });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return r2.body;
}

test("downgrading official → community in a new signed index removes actions from the installed copy; consent window — catalog-changed", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "off", text: offText(), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installAny(h, "off");
    const st = await waitFor(() => h.core.pluginState("off")?.lastRunAt && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st.tier, st.trusted, st.actions.length], ["official", true, 1]);
    // the owner removed off from official.json: the same archive, tier community, the index is newer and signed
    publish(h.reg, [{ id: "off", text: offText(), tier: "community" }], { key: h.key, generatedAt: nextTime() });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    const st2 = await waitFor(() => h.core.pluginState("off")?.tier === "community" && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st2.trusted, st2.official, st2.actions, st2.pushRules], [false, false, [], []]);
    const inst = await h.call("GET", "/registry/installed");
    assert.equal(inst.body.installed[0].tier, "community");
    // the consent window is open for official, while the catalog changed the tier of the same archive meanwhile
    await h.call("POST", "/registry/remove", { id: "off" });
    publish(h.reg, [{ id: "off", text: offText(), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r1 = await h.call("POST", "/registry/install", { id: "off" });
    assert.equal(r1.status, 428);
    publish(h.reg, [{ id: "off", text: offText(), tier: "community" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const r2 = await h.call("POST", "/registry/install", { id: "off", consentToken: r1.body.token });
    assert.deepEqual([r2.status, r2.body.error], [409, "registry:catalog-changed"]);
  } finally {
    await h.stop();
  }
});

test("official = only what the signed catalog lists now: delisted → community, journaled once; fetch or signature failures keep the last verified state; back in the catalog → official", async () => {
  const h = await hubWithRegistry();
  const mgr = managerFor(h.config.paths.home);
  const lines = (type) => h.core.journal.tail(3000).filter((e) => e.type === type && e.plugin === "off");
  const tiers = join(h.config.paths.home, "Registry", "tiers.json");
  try {
    publish(h.reg, [{ id: "off", text: offText(), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installAny(h, "off");
    const st = await waitFor(() => h.core.pluginState("off")?.lastRunAt && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st.tier, st.trusted, st.actions.length], ["official", true, 1]);

    // the registry can't be reached (no index) or answers with a broken signature: the last verified catalog stays
    const goodIndex = readFileSync(join(h.reg, "index.json"));
    const goodSig = readFileSync(join(h.reg, "index.json.minisig"));
    writeFileSync(join(h.reg, "index.json.minisig"), "untrusted comment: x\nRWQ=\n");
    assert.notEqual((await h.call("POST", "/registry/fetch")).status, 200);
    const { rmSync } = await import("node:fs");
    rmSync(join(h.reg, "index.json"));
    assert.notEqual((await h.call("POST", "/registry/fetch")).status, 200);
    // a half-written pair on disk (another process replaced index.json, the signature is not there yet) — the same
    writeFileSync(join(h.config.paths.home, "Registry", "index.json.minisig"), "untrusted comment: x\nRWQ=\n");
    await h.rescan();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.core.pluginState("off").tier, "official", "no verified change — no downgrade");
    assert.equal(lines("plugin-tier-lowered").length, 0);
    writeFileSync(join(h.config.paths.home, "Registry", "index.json.minisig"), goodSig);
    writeFileSync(join(h.reg, "index.json"), goodIndex);
    writeFileSync(join(h.reg, "index.json.minisig"), goodSig);

    // the owner removed it from the catalog (official.json and the plugin list): a newer signed index without the id
    publish(h.reg, [], { key: h.key, generatedAt: nextTime() });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    const st2 = await waitFor(() => h.core.pluginState("off")?.tier === "community" && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st2.trusted, st2.official, st2.actions, st2.pushRules], [false, false, [], []], "permissions and actions as for community");
    const inst = (await h.call("GET", "/registry/installed")).body.installed[0];
    assert.deepEqual([inst.tier, inst.official, inst.officialPending, inst.label], ["community", false, false, null], "just the tier it has now, no special label");
    const low = lines("plugin-tier-lowered");
    assert.equal(low.length, 1);
    assert.deepEqual([low[0].version, low[0].from, low[0].to, low[0].reason], ["1.0.0", "official", "community", "not-in-catalog"]);
    // more checks and a daemon restart (the mark is read from Registry/tiers.json): no second line
    await h.rescan();
    mgr.lowered = null;
    await h.rescan();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lines("plugin-tier-lowered").length, 1);
    assert.ok(JSON.parse(readFileSync(tiers, "utf8")).lowered.off);

    // back in the catalog as official (the same archive): official again, one line
    publish(h.reg, [{ id: "off", text: offText(), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    await waitFor(() => h.core.pluginState("off")?.tier === "official", { timeoutMs: 8000 });
    await h.rescan();
    assert.equal(lines("plugin-tier-restored").length, 1);
    assert.equal(JSON.parse(readFileSync(tiers, "utf8")).lowered.off, undefined);
    // listed as community (official.json without it) — lowered again, reason "community"; removal forgets the mark
    publish(h.reg, [{ id: "off", text: offText(), tier: "community" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await waitFor(() => lines("plugin-tier-lowered").length === 2, { timeoutMs: 8000 });
    assert.equal(lines("plugin-tier-lowered")[1].reason, "community");
    await h.call("POST", "/registry/remove", { id: "off" });
    assert.equal(JSON.parse(readFileSync(tiers, "utf8")).lowered.off, undefined);
  } finally {
    await h.stop();
  }
});

test("a new version of an official plugin in the catalog does not downgrade the installed one: Registry/attest evidence; a tier downgrade and tampered evidence — community", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "off", text: offText(), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installAny(h, "off");
    const st = await waitFor(() => h.core.pluginState("off")?.lastRunAt && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st.tier, st.trusted, st.actions.length], ["official", true, 1]);
    const attest = join(h.config.paths.home, "Registry", "attest", "off.json");
    assert.ok(!existsSync(attest), "while the catalog itself signs the installed version, no evidence is needed");

    // 1.1.0 is out (same permissions): the catalog updated, the installed 1.0.0 itself is still official
    publish(h.reg, [{ id: "off", text: offText({ version: "1.1.0" }), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    assert.ok(existsSync(attest) && existsSync(attest + ".minisig"), "the previous signed index is saved");
    await h.rescan();
    await new Promise((r) => setTimeout(r, 300));
    const st2 = h.core.pluginState("off");
    assert.deepEqual([st2.tier, st2.trusted, st2.actions.length], ["official", true, 1], "before the update — as before");
    let inst = (await h.call("GET", "/registry/installed")).body.installed[0];
    assert.deepEqual([inst.version, inst.tier, inst.officialPending, inst.updateAvailable], ["1.0.0", "official", false, true]);
    // yet another new version — the evidence is the same (1.0.0 is in it), the tier does not change
    publish(h.reg, [{ id: "off", text: offText({ version: "1.2.0" }), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    assert.equal((await h.call("GET", "/registry/installed")).body.installed[0].tier, "official");

    // tampered evidence (the signature does not match) — community
    const good = readFileSync(attest);
    writeFileSync(attest, good.toString("utf8").replace('"generatedAt"', '"generatedAt" ').replace(/\n$/, "\n\n"));
    await h.rescan();
    await waitFor(() => h.core.pluginState("off")?.tier === "community", { timeoutMs: 8000 });
    writeFileSync(attest, good);
    await h.rescan();
    await waitFor(() => h.core.pluginState("off")?.tier === "official", { timeoutMs: 8000 });

    // the registry owner downgraded the id to community — the old version's evidence does not bring officialness back
    publish(h.reg, [{ id: "off", text: offText({ version: "1.2.0" }), tier: "community" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const st3 = await waitFor(() => h.core.pluginState("off")?.tier === "community" && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st3.trusted, st3.actions], [false, []]);
    inst = (await h.call("GET", "/registry/installed")).body.installed[0];
    assert.equal(inst.tier, "community");

    // updating to a new version removes the evidence; so does removal
    publish(h.reg, [{ id: "off", text: offText({ version: "1.3.0" }), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installAny(h, "off");
    assert.ok(!existsSync(attest), "the current catalog signs the new version");
    assert.equal((await h.call("GET", "/registry/installed")).body.installed[0].tier, "official");
    publish(h.reg, [{ id: "off", text: offText({ version: "1.4.0" }), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    assert.ok(existsSync(attest));
    await h.call("POST", "/registry/remove", { id: "off" });
    assert.ok(!existsSync(attest) && !existsSync(attest + ".minisig"));
  } finally {
    await h.stop();
  }
});

test("a plugins.lock entry bypassing the manager does not grant official: neither without a catalog nor with sha256 from the catalog and its own files", async () => {
  const h = await hubWithRegistry();
  try {
    const text = offText();
    const perms = permissionsFromMeta(parseMetaText(text).meta);
    const forge = (sum, body) => {
      writeFileSync(h.config.paths.pluginsLock, JSON.stringify({ version: 1, plugins: { off: { id: "off", version: "1.0.0", sha256: sum, tier: "official", official: true, granted: perms, files: { "off.5m.sh": sha(Buffer.from(body)) }, disabled: null } } }), { mode: 0o600 });
      writePlugin(join(h.config.paths.plugins, "off"), "off.5m.sh", body, 0o700);
    };
    // 1. there is no catalog at all
    forge("f".repeat(64), text);
    await h.rescan();
    const st = await waitFor(() => h.core.pluginState("off")?.lastRunAt && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.equal((await h.call("GET", "/registry/catalog")).body.plugins.length, 0);
    assert.deepEqual([st.tier, st.trusted, st.actions.length], ["community", false, 0]);
    assert.ok(!st.body.some((i) => i.offer?.kind === "action"));
    // 2. the catalog calls off official, lock copied its sha256, but the files are its own (with a copy of the real archive next to them)
    const [entry] = publish(h.reg, [{ id: "off", text, tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    const evil = text.replace('echo "Off 1.0.0 | status=ok"', 'echo "Off 1.0.0 | status=ok" # подмена');
    forge(entry.sha256, evil);
    mkdirSync(join(h.config.paths.home, "Registry", "archives"), { recursive: true });
    writeFileSync(join(h.config.paths.home, "Registry", "archives", "off.tar.gz"), readFileSync(join(h.reg, entry.archive)));
    await h.rescan();
    await waitFor(() => h.core.pluginState("off")?.body?.length, { timeoutMs: 8000 });
    const st2 = h.core.pluginState("off");
    assert.deepEqual([st2.tier, st2.trusted, st2.actions.length], ["community", false, 0], "the files are not the archive contents from the index");
  } finally {
    await h.stop();
  }
});

test("install from the terminal with a running daemon: the catalog on disk is newer than the daemon's memory — official right away", async () => {
  const { terminalInstall } = await import("../lib/registry/terminal.mjs");
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "off", text: offText(), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    // the daemon did not download the catalog: there is no catalog in its memory
    assert.equal((await h.call("GET", "/registry/catalog")).body.plugins.length, 0);
    const r = await terminalInstall({ config: h.config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, ...HUMAN });
    assert.equal(r.ok, true);
    await h.rescan();
    const st = await waitFor(() => h.core.pluginState("off")?.lastRunAt && h.core.pluginState("off"), { timeoutMs: 8000 });
    assert.deepEqual([st.tier, st.trusted, st.actions.length], ["official", true, 1]);
  } finally {
    await h.stop();
  }
});

test("a v1 confirmation token does not execute the v2 command: a plugin update while the window is open — confirm:invalid", async () => {
  const h = await hubWithRegistry();
  try {
    publish(h.reg, [{ id: "off", text: offText(), tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installAny(h, "off");
    const st = await waitFor(() => h.core.pluginState("off")?.body?.some((i) => i.offer) && h.core.pluginState("off"), { timeoutMs: 8000 });
    const o1 = st.body.find((i) => i.offer).offer;
    const c1 = await h.call("POST", `/actions/${o1.id}`, {});
    assert.equal(c1.status, 428);
    assert.equal(c1.body.level, "confirm");
    const v2 = offText({ version: "1.1.0", stop: 'level="confirm-cost" cost="дорого" title="Остановить">off.5m.sh --action stop --hard' });
    publish(h.reg, [{ id: "off", text: v2, tier: "official" }], { key: h.key, generatedAt: nextTime() });
    await h.call("POST", "/registry/fetch");
    await installAny(h, "off");
    await h.rescan();
    const st2 = await waitFor(() => h.core.pluginState("off")?.body?.[0]?.title?.includes("1.1.0") && h.core.pluginState("off"), { timeoutMs: 8000 }).catch(() => h.core.pluginState("off"));
    const o2 = st2.body.find((i) => i.offer).offer;
    assert.equal(o2.id, o1.id, "the offer has the same id");
    const done = await h.call("POST", `/actions/${o2.id}`, { confirmToken: c1.body.token });
    assert.deepEqual([done.status, done.body.error], [403, "confirm:invalid"]);
    assert.ok(!existsSync(join(h.config.paths.pluginData, "off", "argv.txt")), "the v2 command was not executed");
    const c2 = await h.call("POST", `/actions/${o2.id}`, {});
    assert.deepEqual([c2.status, c2.body.level], [428, "confirm-cost"]);
    assert.match(c2.body.text, /--action stop --hard/);
  } finally {
    await h.stop();
  }
});

test("agenthub plugins install|remove from under Claude Code — rejected: ancestor by name, by signature, CLAUDECODE, pty via script", async () => {
  const { terminalInstall, terminalRemove, claudeAncestor } = await import("../lib/registry/terminal.mjs");
  const key = generateKeyPair();
  const reg = tempHome("ah-reg-");
  const home = tempHome("ah-term-");
  try {
    const config = loadConfig({
      env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"), AGENTHUB_SERVICES: "none" },
      overrides: {
        requirements: { claudeCode: 'identifier "com.anthropic.claude-code"' },
        services: { plugins: { indexUrl: join(reg, "index.json"), publicKey: key.publicKey, allowNetwork: false } },
      },
    });
    publish(reg, [{ id: "off", text: offText(), tier: "official" }], { key, generatedAt: nextTime() });
    // the agent's Bash tool: node ← script (pty) ← zsh ← claude (native build) ← cmux
    const agent = procSys({
      100: { ppid: 90, path: "/usr/local/bin/node", argv: ["node", "agenthub", "plugins", "install"] },
      90: { ppid: 80, path: "/usr/bin/script", argv: ["script", "-q", "/dev/null"] },
      80: { ppid: 70, path: "/bin/zsh" },
      70: { ppid: 60, path: "/Users/u/.local/share/claude/versions/2.1.0", argv: ["claude"] },
      60: { ppid: 1, path: "/Applications/cmux.app/Contents/MacOS/cmux" },
    });
    assert.deepEqual(await claudeAncestor({ config, sys: agent, pid: 100, env: {} }), { pid: 70, by: "name" });
    await assert.rejects(terminalInstall({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, sys: agent, pid: 100, env: {} }), /terminal:agent/);
    // a renamed binary, but with Claude Code's signature
    const signed = procSys({ 100: { ppid: 70, path: "/usr/local/bin/node" }, 70: { ppid: 1, path: "/opt/x/agent" } }, { signed: (p) => p === "/opt/x/agent" });
    assert.deepEqual(await claudeAncestor({ config, sys: signed, pid: 100, env: {} }), { pid: 70, by: "signature" });
    // a Claude Code variable in the environment
    await assert.rejects(terminalInstall({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, sys: HUMAN.sys, pid: 100, env: { CLAUDECODE: "1" } }), /terminal:agent/);
    // ancestors cannot be determined — rejected
    await assert.rejects(terminalInstall({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, sys: { available: false }, pid: 100, env: {} }), /terminal:no-ancestry/);
    assert.ok(!existsSync(join(config.paths.plugins, "off")), "nothing installed");
    // a human installs; an agent cannot remove
    assert.equal((await terminalInstall({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, ...HUMAN })).ok, true);
    await assert.rejects(terminalRemove({ config, id: "off", ask: async () => "off", out: () => {}, isTTY: true, sys: agent, pid: 100, env: {} }), /terminal:agent/);
    assert.ok(existsSync(join(config.paths.plugins, "off", "off.5m.sh")));
  } finally {
    cleanup(reg);
    cleanup(home);
  }
});

test("permissions window in the hub language: \"why\" from the archive's lang variants, for watch separate from the path; keys and \"new\" are the same", async () => {
  const h = await hubWithRegistry();
  try {
    const text = pluginText({
      extra: `# <agenthub.fsRead lang="en">~/.config/hello/state.json — show the state</agenthub.fsRead>
# <agenthub.watch>~/.config/hello — состояние меняется здесь</agenthub.watch>
# <agenthub.watch lang="en">~/.config/hello — the state changes here</agenthub.watch>`,
    });
    publish(h.reg, [{ id: "hello", text }], { key: h.key, generatedAt: nextTime() });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    const ru = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(ru.status, 428);
    assert.deepEqual(ru.body.permissions.find((p) => p.kind === "watch"), { kind: "watch", what: "~/.config/hello", why: "состояние меняется здесь", added: true });
    h.core.setLang("en", { class: "app", pid: 1 });
    const en = await h.call("POST", "/registry/install", { id: "hello" });
    assert.equal(en.status, 428);
    assert.deepEqual(en.body.permissions.find((p) => p.kind === "fsRead"), { kind: "fsRead", what: "~/.config/hello/state.json", why: "show the state", added: true });
    assert.deepEqual(en.body.permissions.find((p) => p.kind === "watch"), { kind: "watch", what: "~/.config/hello", why: "the state changes here", added: true });
    // consenting to the English window installs the same permission set
    const done = await h.call("POST", "/registry/install", { id: "hello", consentToken: en.body.token });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const lock = JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8"));
    assert.equal(lock.plugins.hello.granted.fsRead[0].why, "показать состояние", "lock has the permissions as in the archive, untranslated");
  } finally {
    await h.stop();
  }
});

test("the registry connects without restarting the daemon: a services.plugins entry in config.json → catalog configured; the hint is the CLI with a full path", async () => {
  const key = generateKeyPair();
  const reg = tempHome("ah-reg-");
  const h = await startHub({ services: "plugins", sys: appSys({ pid: 4242 }), overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' } } });
  try {
    let cat = await req(h.sock, "GET", "/registry/catalog");
    assert.equal(cat.body.configured, false);
    assert.deepEqual(cat.body.missing, ["index-url", "public-key"]);
    assert.match(cat.body.connect.cli, /\/daemon\/bin\/agenthub$/);
    assert.ok(existsSync(cat.body.connect.cli));
    assert.equal(cat.body.connect.home, h.home);
    assert.equal(cat.body.connect.defaultHome, false);
    publish(reg, [{ id: "hello", text: pluginText() }], { key, generatedAt: nextTime() });
    // what `agenthub install --registry-url … --registry-pubkey … --apply --no-launchd` writes
    writeFileSync(h.config.paths.config, JSON.stringify({ requirements: { app: 'identifier "com.kensei.agenthub"' }, services: { plugins: { indexUrl: join(reg, "index.json"), publicKey: key.publicKey } } }, null, 2), { mode: 0o600 });
    cat = await req(h.sock, "GET", "/registry/catalog");
    assert.equal(cat.body.configured, true);
    assert.deepEqual(cat.body.missing, []);
    const f = await req(h.sock, "POST", "/registry/fetch");
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.equal((await req(h.sock, "GET", "/registry/catalog")).body.plugins[0].id, "hello");
    assert.ok(h.core.journal.tail(50).some((e) => e.type === "registry-config-changed" && e.indexUrl && e.publicKey));
    // the key removed from the file — the registry is not connected again (rather than staying as before until a restart)
    writeFileSync(h.config.paths.config, JSON.stringify({ requirements: { app: 'identifier "com.kensei.agenthub"' }, services: { plugins: { indexUrl: join(reg, "index.json") } } }, null, 2), { mode: 0o600 });
    cat = await req(h.sock, "GET", "/registry/catalog");
    assert.deepEqual([cat.body.configured, cat.body.missing], [false, ["public-key"]]);
  } finally {
    await h.stop();
    cleanup(reg);
  }
});

// ---------- contract 2: "hub too old", icon from the index ----------
test("contract: the plugin needs a contract newer than the hub — the catalog marks \"hub too old\", install gives a clear refusal, not a linter error", async () => {
  const { CONTRACT_VERSION } = await import("../lib/meta.mjs");
  const h = await hubWithRegistry();
  try {
    const next = CONTRACT_VERSION + 1;
    publish(
      h.reg,
      [
        // newer than the hub: both in the index and in the archive
        { id: "future", text: pluginText({ extra: `# <agenthub.contract>${next}</agenthub.contract>` }), entry: { contract: next, icon: { symbol: "sparkles", color: "#30D158" } } },
        // the index does not name the contract (old build-index), but the archive requires a newer one — rejected based on the archive
        { id: "sneaky", text: pluginText({ extra: `# <agenthub.contract>${next}</agenthub.contract>` }) },
        // own contract — installs; an invalid icon in the index does not break the entry
        { id: "today", text: pluginText({ extra: `# <agenthub.contract>${CONTRACT_VERSION}</agenthub.contract>\n# <agenthub.icon symbol="moon" color="#5E5CE6"></agenthub.icon>` }), entry: { contract: CONTRACT_VERSION, icon: { symbol: "Bad Symbol!", color: "red" } } },
      ],
      { key: h.key, generatedAt: nextTime() },
    );
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    const cat = (await h.call("GET", "/registry/catalog")).body.plugins;
    const by = Object.fromEntries(cat.map((p) => [p.id, p]));
    assert.deepEqual(by.future.needsHub, { need: next, have: CONTRACT_VERSION });
    assert.deepEqual(by.future.icon, { symbol: "sparkles", color: "#30D158" });
    assert.equal(by.future.contract, next);
    assert.equal(by.today.needsHub, undefined);
    assert.equal(by.today.icon, null, "an invalid index icon — no icon, the entry is intact");
    for (const id of ["future", "sneaky"]) {
      const r = await h.call("POST", "/registry/install", { id });
      assert.equal(r.status, 409, `${id}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "registry:hub-too-old");
      assert.equal(r.body.need, next, JSON.stringify(r.body));
      assert.equal(r.body.have, CONTRACT_VERSION);
      assert.equal(existsSync(join(h.config.paths.plugins, id)), false);
    }
    assert.ok(h.core.journal.tail(200).some((e) => e.type === "registry-rejected" && e.plugin === "sneaky" && e.error === "registry:hub-too-old"));
    // own contract: consent window with the icon from the archive metadata
    const r1 = await h.call("POST", "/registry/install", { id: "today" });
    assert.equal(r1.status, 428, JSON.stringify(r1.body));
    assert.deepEqual(r1.body.icon, { symbol: "moon", color: "#5E5CE6" });
    // /state and /health report the core's contract version
    assert.equal((await h.call("GET", "/state")).body.contract, CONTRACT_VERSION);
    assert.equal((await h.call("GET", "/health")).body.contract, CONTRACT_VERSION);
  } finally {
    await h.stop();
  }
});

test("contract: a version that needs a newer hub is not \"update available\"; an unparseable contract in an index entry does not break the catalog", async () => {
  const { CONTRACT_VERSION } = await import("../lib/meta.mjs");
  const h = await hubWithRegistry();
  try {
    const next = CONTRACT_VERSION + 1;
    publish(h.reg, [{ id: "today", text: pluginText() }], { key: h.key, generatedAt: nextTime() });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    await installWithConsent(h, "today");
    publish(
      h.reg,
      [
        { id: "today", text: pluginText({ version: "1.1.0", extra: `# <agenthub.contract>${next}</agenthub.contract>` }), entry: { contract: next } },
        // a future build-index writes contract as a non-integer — the entry is marked "hub too old", the catalog is intact
        { id: "odd", text: pluginText(), entry: { contract: "2.1" } },
      ],
      { key: h.key, generatedAt: nextTime() },
    );
    const f = await h.call("POST", "/registry/fetch");
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.deepEqual(managerFor(h.config.paths.home).pluginUpdates(), [], "an update the hub will not install is not offered (no notification, no button)");
    const by = Object.fromEntries((await h.call("GET", "/registry/catalog")).body.plugins.map((p) => [p.id, p]));
    assert.deepEqual(by.today.needsHub, { need: next, have: CONTRACT_VERSION }, "the catalog says \"hub too old\"");
    assert.deepEqual(by.odd.needsHub, { need: null, have: CONTRACT_VERSION });
    const r = await h.call("POST", "/registry/install", { id: "odd" });
    assert.equal(r.body.error, "registry:hub-too-old");
  } finally {
    await h.stop();
  }
});
