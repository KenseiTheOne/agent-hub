// The key a registry's catalog is verified with is the trust root of everything installed from it, and it sits in
// config.json — a file any process of this user can write. The hub remembers the key in force when the registry was first
// used (Registry/registry-keys.json) and keeps verifying with it: a different key in config.json is refused
// (registry:key-changed), journaled (also in the audit journal), shown in /state.registryKeys, and takes over only after a
// human accepts it — the consent window of the pinned app (POST /registry/key/accept) or `agenthub plugins trust-key`.
// Registries are temporary directories with synthetic plugins; keys are generated here. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { acceptedRegistryKey, PluginManager, registryKeyIdentity } from "../lib/plugins.mjs";
import { generateKeyPair, sign } from "../lib/registry/minisign.mjs";
import { packTarGz } from "../lib/registry/tarball.mjs";
import { permissionsFromMeta } from "../lib/registry/perms.mjs";
import { terminalTrustKey } from "../lib/registry/terminal.mjs";
import { cleanup, req, startHub, tempHome } from "./helpers.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const PLATFORM_TAG = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;
const UID = process.getuid();
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const CURL = "/usr/bin/curl";
const REQ = { app: 'identifier "com.kensei.agenthub"' };

// Every connection comes from one process; its path decides the class: AgentHub.app → app, anything else → cli.
function appSys(state) {
  const procs = () => ({ [state.pid]: { ppid: 1, path: state.path || APP } });
  return {
    available: true,
    peerPid: () => state.pid,
    peerUid: () => UID,
    pidPath: (pid) => procs()[pid]?.path ?? null,
    pidInfo: (pid) => (procs()[pid] ? { pid, ppid: 1, uid: UID, startSec: 1000, startUsec: 0, comm: "x" } : null),
    procArgv: () => state.argv || null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => `${p}|id`,
    myUid: () => UID,
    readJson: () => {
      throw new Error("ENOENT");
    },
  };
}

// Process table for the terminal guard: pid → { ppid, path, argv }.
function procSys(table) {
  return {
    available: true,
    pidInfo: (pid) => (table[pid] ? { pid, ppid: table[pid].ppid, uid: UID, startSec: 1, startUsec: 0 } : null),
    pidPath: (pid) => table[pid]?.path ?? null,
    procArgv: (pid) => table[pid]?.argv ?? null,
    codeInfo: null,
    codesignVerify: async () => false,
    fileId: (p) => `${p}|id`,
    myUid: () => UID,
    readJson: () => {
      throw new Error("ENOENT");
    },
  };
}
// a human in their own terminal: node ← zsh ← Terminal ← launchd
const HUMAN = { sys: procSys({ 100: { ppid: 50, path: "/usr/local/bin/node", argv: ["node", "agenthub"] }, 50: { ppid: 40, path: "/bin/zsh" }, 40: { ppid: 1, path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" } }), pid: 100, env: {} };
// the agent's Bash tool: node ← zsh ← claude
const AGENT = { sys: procSys({ 100: { ppid: 80, path: "/usr/local/bin/node", argv: ["node", "agenthub"] }, 80: { ppid: 70, path: "/bin/zsh" }, 70: { ppid: 1, path: "/Users/u/.local/share/claude/versions/2.1.0", argv: ["claude"] } }), pid: 100, env: {} };

function pluginText(version = "1.0.0") {
  return `#!/bin/sh
# <agenthub.title>Hello</agenthub.title>
# <agenthub.version>${version}</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>${PLATFORM_TAG}</agenthub.platforms>
# <agenthub.effects>open.url</agenthub.effects>
echo "Hello | status=ok"
`;
}

let clock = Date.parse("2026-11-17T10:00:00Z");
const nextTime = () => new Date((clock += 60_000)).toISOString();

// A registry in directory dir: one plugin "hello" of the given version, the index signed with key.
function publish(dir, key, version = "1.0.0") {
  mkdirSync(join(dir, "archives"), { recursive: true });
  const text = pluginText(version);
  const gz = packTarGz([
    { path: "hello/hello.5m.sh", data: text },
    { path: "hello/README.md", data: "# r\n" },
  ]);
  const meta = parseMetaText(text).meta;
  const name = `hello-${version}.tar.gz`;
  writeFileSync(join(dir, "archives", name), gz);
  const entry = { id: "hello", version, title: meta.title, platforms: meta.platforms, type: meta.type, tier: "community", official: false, archive: `archives/${name}`, sha256: sha(gz), size: gz.length, permissions: permissionsFromMeta(meta) };
  const index = JSON.stringify({ version: 1, generatedAt: nextTime(), plugins: [entry], blocklist: [] }, null, 2) + "\n";
  writeFileSync(join(dir, "index.json"), index);
  writeFileSync(join(dir, "index.json.minisig"), sign(Buffer.from(index), key.secretKey));
}

// The hub reads the registry settings from config.json (as after `agenthub install --registry-url … --registry-pubkey …`),
// so the test changes the key the way any process of the user could: by rewriting the file.
async function setup({ extra = null } = {}) {
  const reg = tempHome("ah-reg-");
  const a = generateKeyPair();
  const state = { pid: 4242 };
  publish(reg, a);
  const file = (publicKey, more = {}) => ({ requirements: REQ, services: { plugins: { indexUrl: join(reg, "index.json"), publicKey, allowNetwork: false, checkUpdates: false, ...(extra ? { registries: [extra] } : {}), ...more } } });
  const h = await startHub({ services: "plugins", sys: appSys(state), overrides: { requirements: REQ }, configFile: file(a.publicKey) });
  const call = (method, path, body) => req(h.sock, method, path, body);
  const t = {
    h,
    reg,
    a,
    state,
    call,
    setKey: (publicKey, more) => writeFileSync(h.config.paths.config, JSON.stringify(file(publicKey, more), null, 2), { mode: 0o600 }),
    pins: () => JSON.parse(readFileSync(join(h.home, "Registry", "registry-keys.json"), "utf8")),
    journal: (type) => h.core.journal.tail(500).filter((e) => e.type === type),
    audit: (type) => h.core.journal.auditTail(200).filter((e) => e.type === type),
    registry: async (name = "default") => (await call("GET", "/registry/catalog")).body.registries.find((r) => r.name === name),
    alerts: async () => (await call("GET", "/state")).body.registryKeys,
    version: async () => (await call("GET", "/registry/catalog")).body.plugins.find((p) => p.id === "hello")?.version ?? null,
    async stop() {
      await h.stop();
      cleanup(reg);
    },
  };
  const f = await call("POST", "/registry/fetch");
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return t;
}

test("first use: the key in force is remembered (0600), journaled in the audit journal and shown with the registry", async () => {
  const t = await setup();
  try {
    const id = registryKeyIdentity(t.a.publicKey);
    assert.match(id.fingerprint, /^[0-9a-f]{32}$/);
    assert.match(id.keyId, /^[0-9A-F]{16}$/);
    const path = join(t.h.home, "Registry", "registry-keys.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const pin = t.pins().registries.default;
    assert.deepEqual([pin.fingerprint, pin.keyId, pin.by, pin.changed], [id.fingerprint, id.keyId, "first-use", null]);
    assert.deepEqual(acceptedRegistryKey(t.h.home), id);
    assert.deepEqual(t.journal("registry-key-pinned").map((e) => [e.registry, e.fingerprint, e.keyId, e.by]), [["default", id.fingerprint, id.keyId, "first-use"]]);
    assert.equal(t.audit("registry-key-pinned").length, 1, "the first use of a key is an audit entry");
    const r = await t.registry();
    assert.deepEqual([r.key, r.keyChanged], [{ keyId: id.keyId, fingerprint: id.fingerprint }, null]);
    assert.deepEqual(await t.alerts(), []);
    assert.equal(await t.version(), "1.0.0");
  } finally {
    await t.stop();
  }
});

test("a different key in config.json is not trusted: the old catalog stays, the new one is refused, journal + /state", async () => {
  const t = await setup();
  try {
    const b = generateKeyPair();
    const [was, now] = [registryKeyIdentity(t.a.publicKey), registryKeyIdentity(b.publicKey)];
    // the attacker's registry content: a newer version signed with their key, and their key in config.json
    publish(t.reg, b, "6.6.6");
    t.setKey(b.publicKey);
    // the catalog verified with the accepted key is still the catalog: nothing is demoted or replaced
    assert.equal(await t.version(), "1.0.0");
    const r = await t.registry();
    assert.deepEqual(r.key, { keyId: was.keyId, fingerprint: was.fingerprint }, "the key in force is the accepted one");
    assert.deepEqual([r.keyChanged.was, r.keyChanged.now], [{ keyId: was.keyId, fingerprint: was.fingerprint }, { keyId: now.keyId, fingerprint: now.fingerprint }]);
    assert.ok(!Number.isNaN(Date.parse(r.keyChanged.since)));
    // registryLabel — null while the default registry is the only one, as in the 428 window
    assert.deepEqual(await t.alerts(), [{ registry: "default", registryLabel: null, trust: "official", was: { keyId: was.keyId, fingerprint: was.fingerprint }, now: { keyId: now.keyId, fingerprint: now.fingerprint }, since: r.keyChanged.since }]);
    // the catalog signed with the new key is refused, with a reason of its own
    const f = await t.call("POST", "/registry/fetch");
    assert.deepEqual([f.status, f.body], [409, { error: "registry:key-changed", registry: "default", was: was.fingerprint, now: now.fingerprint }]);
    assert.equal(await t.version(), "1.0.0");
    // one journal line however many times the registry is read, and it is an audit line
    await t.registry();
    await t.alerts();
    assert.deepEqual(t.journal("registry-key-changed").map((e) => [e.registry, e.was, e.now, e.wasKeyId, e.nowKeyId]), [["default", was.fingerprint, now.fingerprint, was.keyId, now.keyId]]);
    assert.equal(t.audit("registry-key-changed").length, 1);
    // the accepted key is still the one on disk; the change is remembered next to it
    const pin = t.pins().registries.default;
    assert.deepEqual([pin.fingerprint, pin.changed.fingerprint, pin.changed.seenAt], [was.fingerprint, now.fingerprint, r.keyChanged.since]);
    // an install still goes by the catalog the accepted key signed: its version, its archive hash
    const w = await t.call("POST", "/registry/install", { id: "hello" });
    assert.equal(w.status, 428, JSON.stringify(w.body));
    const done = await t.call("POST", "/registry/install", { id: "hello", consentToken: w.body.token });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(readFileSync(join(t.h.config.paths.plugins, "hello", "hello.5m.sh"), "utf8"), /<agenthub\.version>1\.0\.0</, "nothing of the new key's content reached Plugins/");
    assert.equal(JSON.parse(readFileSync(t.h.config.paths.pluginsLock, "utf8")).plugins.hello.version, "1.0.0");
  } finally {
    await t.stop();
  }
});

test("accepting the new key: app only, a 428 window with both fingerprints, a single-use token bound to pid and key", async () => {
  const t = await setup();
  try {
    const b = generateKeyPair();
    const [was, now] = [registryKeyIdentity(t.a.publicKey), registryKeyIdentity(b.publicKey)];
    // nothing to accept while the keys agree
    assert.deepEqual((await t.call("POST", "/registry/key/accept", { registry: "default" })).body, { error: "registry:key-unchanged", registry: "default" });
    publish(t.reg, b, "2.0.0");
    t.setKey(b.publicKey);
    assert.equal((await t.alerts()).length, 1);
    // a CLI-class process cannot open the window, let alone accept
    t.state.path = CURL;
    assert.equal((await t.call("POST", "/registry/key/accept", { registry: "default" })).status, 403);
    t.state.path = APP;
    assert.equal((await t.call("POST", "/registry/key/accept", {})).body.error, "args:registry:required");
    assert.deepEqual([(await t.call("POST", "/registry/key/accept", { registry: "nope" })).status, (await t.call("POST", "/registry/key/accept", { registry: "nope" })).body.error], [404, "registry:unknown-registry"]);
    // the window
    const w = await t.call("POST", "/registry/key/accept", { registry: "default" });
    assert.equal(w.status, 428, JSON.stringify(w.body));
    const { token, since, ...sheet } = w.body;
    assert.deepEqual(sheet, { error: "consent-required", needsConsent: true, expiresInMs: 120000, kind: "registry-key", registry: "default", registryLabel: sheet.registryLabel, trust: "official", was: { keyId: was.keyId, fingerprint: was.fingerprint }, now: { keyId: now.keyId, fingerprint: now.fingerprint } });
    assert.ok(token && since);
    // a token from another process, a made-up token: refused; the first one is spent by the attempt
    t.state.pid = 5151;
    assert.deepEqual((await t.call("POST", "/registry/key/accept", { registry: "default", consentToken: token })).body, { error: "consent:invalid" });
    t.state.pid = 4242;
    assert.equal((await t.call("POST", "/registry/key/accept", { registry: "default", consentToken: token })).status, 403, "single-use");
    assert.equal((await t.call("POST", "/registry/key/accept", { registry: "default", consentToken: "x".repeat(24) })).status, 403);
    assert.equal(t.pins().registries.default.fingerprint, was.fingerprint);
    // a token given for key B does not accept key C that replaced it in the meantime
    const c = generateKeyPair();
    const w2 = await t.call("POST", "/registry/key/accept", { registry: "default" });
    t.setKey(c.publicKey);
    assert.equal((await t.call("POST", "/registry/key/accept", { registry: "default", consentToken: w2.body.token })).status, 403);
    assert.equal(t.pins().registries.default.fingerprint, was.fingerprint);
    t.setKey(b.publicKey);
    // the human agrees
    const w3 = await t.call("POST", "/registry/key/accept", { registry: "default" });
    assert.equal(w3.status, 428);
    const ok = await t.call("POST", "/registry/key/accept", { registry: "default", consentToken: w3.body.token });
    assert.deepEqual([ok.status, ok.body], [200, { ok: true, registry: "default", key: { keyId: now.keyId, fingerprint: now.fingerprint }, fetched: true }]);
    const pin = t.pins().registries.default;
    assert.deepEqual([pin.fingerprint, pin.by, pin.previous, pin.changed], [now.fingerprint, "app", was.fingerprint, null]);
    assert.deepEqual(await t.alerts(), []);
    assert.equal((await t.registry()).keyChanged, null);
    assert.equal(await t.version(), "2.0.0", "the catalog the new key signs is in force");
    const line = t.audit("registry-key-accepted");
    assert.deepEqual(line.map((e) => [e.registry, e.was, e.now, e.via, e.pid]), [["default", was.fingerprint, now.fingerprint, "app", 4242]]);
    assert.ok(t.journal("registry-key-consent-requested").length >= 3);
    assert.equal((await t.call("POST", "/registry/key/accept", { registry: "default" })).body.error, "registry:key-unchanged");
  } finally {
    await t.stop();
  }
});

test("a diagnostic shell run sees the key window but accepts nothing: its token is not recorded, the human's window stays", async () => {
  const t = await setup();
  const DIAG = [APP, "--snapshot-consent", "/tmp/x.png"];
  const asHuman = () => Object.assign(t.state, { pid: 4242, argv: null });
  const asDiag = () => Object.assign(t.state, { pid: 4343, argv: DIAG });
  try {
    const b = generateKeyPair();
    const [was, now] = [registryKeyIdentity(t.a.publicKey), registryKeyIdentity(b.publicKey)];
    // nothing to show while the keys agree — the same answer as for the app
    asDiag();
    assert.deepEqual((await t.call("POST", "/registry/key/accept", { registry: "default" })).body, { error: "registry:key-unchanged", registry: "default" });
    asHuman();
    publish(t.reg, b, "2.0.0");
    t.setKey(b.publicKey);
    const human = await t.call("POST", "/registry/key/accept", { registry: "default" });
    assert.equal(human.status, 428, JSON.stringify(human.body));
    // the snapshot: the same body, another token
    asDiag();
    const snap = await t.call("POST", "/registry/key/accept", { registry: "default" });
    assert.equal(snap.status, 428, JSON.stringify(snap.body));
    const { token: snapToken, ...sheet } = snap.body;
    const { token: humanToken, ...humanSheet } = human.body;
    assert.deepEqual(sheet, humanSheet);
    assert.deepEqual([sheet.kind, sheet.was.fingerprint, sheet.now.fingerprint], ["registry-key", was.fingerprint, now.fingerprint]);
    assert.ok(typeof snapToken === "string" && snapToken.length >= 20 && snapToken !== humanToken);
    // a diagnostic run with a token — its own or the human's — is refused before anything is looked up
    for (const consentToken of [snapToken, humanToken]) {
      const r = await t.call("POST", "/registry/key/accept", { registry: "default", consentToken });
      assert.deepEqual([r.status, r.body.error], [403, "peer:diagnostic"]);
    }
    // everything else that changes something stays closed for it
    assert.deepEqual([(await t.call("POST", "/registry/fetch")).status, (await t.call("POST", "/registry/remove", { id: "hello" })).status], [403, 403]);
    assert.equal(t.pins().registries.default.fingerprint, was.fingerprint);
    assert.equal((await t.alerts()).length, 1);
    // the snapshot's token accepts nothing, whoever sends it
    t.state.pid = 5151;
    t.state.argv = null;
    assert.deepEqual((await t.call("POST", "/registry/key/accept", { registry: "default", consentToken: snapToken })).body, { error: "consent:invalid" });
    assert.equal(t.pins().registries.default.fingerprint, was.fingerprint);
    // the human's window was neither reset nor spent by the snapshot
    asHuman();
    const ok = await t.call("POST", "/registry/key/accept", { registry: "default", consentToken: humanToken });
    assert.deepEqual([ok.status, ok.body.ok, ok.body.key], [200, true, { keyId: now.keyId, fingerprint: now.fingerprint }]);
    assert.equal(t.pins().registries.default.fingerprint, now.fingerprint);
    // the journal tells the snapshot's request from the human's
    assert.deepEqual(t.journal("registry-key-consent-requested").map((e) => [e.pid, e.preview ?? null]), [[4242, null], [4343, true]]);
    assert.deepEqual(t.audit("registry-key-accepted").map((e) => e.pid), [4242]);
  } finally {
    await t.stop();
  }
});

test("putting the accepted key back clears the state; something that is not a key cannot be accepted", async () => {
  const t = await setup();
  try {
    const was = registryKeyIdentity(t.a.publicKey);
    t.setKey("not a key at all");
    const r = await t.registry();
    assert.deepEqual([r.keyChanged.was.fingerprint, r.keyChanged.now], [was.fingerprint, null]);
    assert.deepEqual((await t.call("POST", "/registry/key/accept", { registry: "default" })).body, { error: "registry:key-format", registry: "default" });
    assert.equal(await t.version(), "1.0.0", "the accepted key still verifies the catalog");
    // the same registry content keeps arriving while the file is wrong
    publish(t.reg, t.a, "1.1.0");
    assert.equal((await t.call("POST", "/registry/fetch")).status, 200);
    assert.equal(await t.version(), "1.1.0");
    t.setKey(t.a.publicKey);
    assert.equal((await t.registry()).keyChanged, null);
    assert.deepEqual(await t.alerts(), []);
    assert.deepEqual(t.journal("registry-key-restored").map((e) => [e.registry, e.fingerprint]), [["default", was.fingerprint]]);
    assert.equal(t.pins().registries.default.changed, null);
    assert.equal(t.journal("registry-key-accepted").length, 0);
  } finally {
    await t.stop();
  }
});

test("each registry has its own accepted key: a change in one does not touch the other", async () => {
  const regB = tempHome("ah-regb-");
  const kb = generateKeyPair();
  const t = await setup({ extra: { name: "extra", indexUrl: join(regB, "index.json"), publicKey: kb.publicKey, trust: "community" } });
  try {
    assert.deepEqual(Object.keys(t.pins().registries).sort(), ["default", "extra"]);
    const b = generateKeyPair();
    publish(t.reg, b, "9.9.9");
    t.setKey(b.publicKey);
    assert.deepEqual((await t.alerts()).map((x) => [x.registry, x.registryLabel, x.trust]), [["default", "default", "official"]]);
    // the same label as in the window the app opens for it
    assert.equal((await t.call("POST", "/registry/key/accept", { registry: "default" })).body.registryLabel, "default");
    assert.equal((await t.registry("extra")).keyChanged, null);
    assert.equal(t.pins().registries.extra.fingerprint, registryKeyIdentity(kb.publicKey).fingerprint);
    // with two registries a fetch answers per registry
    const f = await t.call("POST", "/registry/fetch");
    const res = f.status === 200 ? f.body.registries.find((x) => x.name === "default") : f.body;
    assert.equal(res.error, "registry:key-changed", JSON.stringify(f.body));
  } finally {
    await t.stop();
    cleanup(regB);
  }
});

test("the accepted key outlives the daemon: a new manager over the same home still refuses, without a second journal line", async () => {
  const t = await setup();
  try {
    const b = generateKeyPair();
    publish(t.reg, b, "3.0.0");
    t.setKey(b.publicKey);
    assert.equal((await t.alerts()).length, 1);
    const config = loadConfig({ env: { AGENTHUB_HOME: t.h.home, AGENTHUB_BUILTIN_PLUGINS: join(t.h.home, "no-builtin"), AGENTHUB_SERVICES: "none" } });
    const lines = [];
    const fresh = new PluginManager({ config, journal: { write: (e) => lines.push(e) } });
    await fresh.init({ cleanTemp: "stale" });
    assert.deepEqual(fresh.registryKeyAlerts().map((x) => x.now.fingerprint), [registryKeyIdentity(b.publicKey).fingerprint]);
    assert.equal(fresh.source("default").publicKey, registryKeyIdentity(t.a.publicKey).key);
    await assert.rejects(fresh.fetchCatalog(), (e) => e.code === "registry:key-changed");
    assert.equal(lines.filter((e) => e.type === "registry-key-changed" || e.type === "registry-key-pinned").length, 0, "the change was journaled once, when it was first seen");
  } finally {
    await t.stop();
  }
});

test("agenthub plugins trust-key: a human in a terminal only, typing the start of the new fingerprint", async () => {
  const t = await setup();
  try {
    const b = generateKeyPair();
    const now = registryKeyIdentity(b.publicKey);
    const config = () => loadConfig({ env: { AGENTHUB_HOME: t.h.home, AGENTHUB_BUILTIN_PLUGINS: join(t.h.home, "no-builtin"), AGENTHUB_SERVICES: "none" } });
    const word = now.fingerprint.slice(0, 8);
    await assert.rejects(terminalTrustKey({ config: config(), ask: async () => word, out: () => {}, isTTY: true, ...HUMAN }), /registry:key-unchanged/);
    publish(t.reg, b, "4.0.0");
    t.setKey(b.publicKey);
    await assert.rejects(terminalTrustKey({ config: config(), ask: async () => word, out: () => {}, isTTY: false, ...HUMAN }), /terminal:no-tty/);
    await assert.rejects(terminalTrustKey({ config: config(), ask: async () => word, out: () => {}, isTTY: true, ...AGENT }), /terminal:agent/);
    await assert.rejects(terminalTrustKey({ config: config(), registry: "nope", ask: async () => word, out: () => {}, isTTY: true, ...HUMAN }), /registry:unknown-registry/);
    const out = [];
    const no = await terminalTrustKey({ config: config(), ask: async () => "yes", out: (s) => out.push(s), isTTY: true, ...HUMAN });
    assert.deepEqual(no, { ok: false, registry: "default", declined: true });
    assert.ok(out.join("\n").includes(now.fingerprint) && out.join("\n").includes(registryKeyIdentity(t.a.publicKey).fingerprint), "both fingerprints are printed before the question");
    assert.equal(t.pins().registries.default.fingerprint, registryKeyIdentity(t.a.publicKey).fingerprint);
    assert.equal(t.journal("registry-key-declined").length, 1);
    const ok = await terminalTrustKey({ config: config(), ask: async () => ` ${word.toUpperCase()} `, out: () => {}, isTTY: true, ...HUMAN });
    assert.deepEqual([ok.ok, ok.registry, ok.key.fingerprint, ok.fetched], [true, "default", now.fingerprint, true]);
    assert.deepEqual([t.pins().registries.default.fingerprint, t.pins().registries.default.by], [now.fingerprint, "terminal"]);
    // the running daemon sees the accepted key (the file changed) without a restart
    assert.deepEqual(await t.alerts(), []);
    assert.equal(await t.version(), "4.0.0");
    assert.ok(t.audit("registry-key-accepted").some((e) => e.via === "terminal"));
  } finally {
    await t.stop();
  }
});
