// How old a signed catalog may be. The signature says who built the index, not that it is the current one: a frozen or
// replayed copy hides a newer release or a blocklist entry. Two local protections:
//   - the optional signed top-level field expiresAt (ISO 8601): past it the catalog is still read (tiers, blocklist) but
//     nothing is installed or updated from it — 409 registry:expired; an index without the field is journaled
//     (registry-no-expiry) and has no such limit; a field that is not a date is a build error;
//   - never older than the last accepted catalog: on fetch and for the signed pair on disk (registry:rollback).
// Registries are temporary directories with synthetic plugins; keys are generated here. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../lib/config.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { parseIndex, PluginManager } from "../lib/plugins.mjs";
import { generateKeyPair, sign } from "../lib/registry/minisign.mjs";
import { packTarGz } from "../lib/registry/tarball.mjs";
import { permissionsFromMeta } from "../lib/registry/perms.mjs";
import { cleanup, req, startHub, tempHome } from "./helpers.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const PLATFORM_TAG = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;
const UID = process.getuid();
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const HOUR = 3_600_000;

// Every connection comes from the "app" (the app signature is a double).
function appSys(state) {
  const procs = () => ({ [state.pid]: { ppid: 1, path: APP } });
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

// generatedAt is in the past and grows with every publish; expiresAt is relative to the real clock (the hub compares it
// with Date.now()).
let clock = Date.now() - 24 * HOUR;
const nextTime = () => new Date((clock += 60_000)).toISOString();
const inMs = (ms) => new Date(Date.now() + ms).toISOString();

// A registry in directory dir: the plugin "hello" of the given version; top — extra signed top-level fields of the index.
function publish(dir, key, { version = "1.0.0", top = {}, blocklist = [], generatedAt = nextTime() } = {}) {
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
  const index = JSON.stringify({ version: 1, generatedAt, ...top, plugins: [entry], blocklist }, null, 2) + "\n";
  const sig = sign(Buffer.from(index), key.secretKey);
  writeFileSync(join(dir, "index.json"), index);
  writeFileSync(join(dir, "index.json.minisig"), sig);
  return { index, sig, generatedAt };
}

async function setup() {
  const reg = tempHome("ah-reg-");
  const key = generateKeyPair();
  const h = await startHub({
    services: "plugins",
    sys: appSys({ pid: 4242 }),
    overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' }, services: { plugins: { indexUrl: join(reg, "index.json"), publicKey: key.publicKey, allowNetwork: false, checkUpdates: false } } },
  });
  const call = (method, path, body) => req(h.sock, method, path, body);
  return {
    h,
    reg,
    key,
    call,
    fetch: () => call("POST", "/registry/fetch"),
    journal: (type) => h.core.journal.tail(500).filter((e) => e.type === type),
    registry: async () => (await call("GET", "/registry/catalog")).body.registries[0],
    async install() {
      const w = await call("POST", "/registry/install", { id: "hello" });
      if (w.status !== 428) return w;
      return call("POST", "/registry/install", { id: "hello", consentToken: w.body.token });
    },
    installedVersion: () => (existsSync(h.config.paths.pluginsLock) ? JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")).plugins.hello?.version ?? null : null),
    async stop() {
      await h.stop();
      cleanup(reg);
    },
  };
}

test("index format: expiresAt is optional, a date when present; anything else is a build error", () => {
  const idx = (top) => JSON.stringify({ version: 1, generatedAt: "2026-11-17T00:00:00Z", ...top, plugins: [] });
  assert.equal(parseIndex(idx({})).expiresAt, null);
  assert.equal(parseIndex(idx({ expiresAt: "2026-12-01T00:00:00Z" })).expiresAt, "2026-12-01T00:00:00Z");
  assert.equal(parseIndex(idx({ expiresAt: null })).expiresAt, null, "null reads as absent");
  for (const bad of ["soon", "", 1795000000, { at: "2026-12-01T00:00:00Z" }, "2026-12-01T00:00:00Z".padEnd(80, " ")]) {
    assert.throws(() => parseIndex(idx({ expiresAt: bad })), (e) => e.code === "registry:index-expiresAt" && e.status === 422, JSON.stringify(bad));
  }
  // an unknown top-level field next to it is still ignored (what an older hub does with expiresAt)
  assert.equal(parseIndex(idx({ somethingNew: 1 })).generatedAt, "2026-11-17T00:00:00Z");
});

test("a catalog within its signed date: installs as usual, nothing in the journal about freshness", async () => {
  const t = await setup();
  try {
    const expiresAt = inMs(48 * HOUR);
    publish(t.reg, t.key, { top: { expiresAt } });
    const f = await t.fetch();
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.deepEqual([f.body.registries[0].expiresAt, f.body.registries[0].expired], [expiresAt, false]);
    const r = await t.registry();
    assert.deepEqual([r.expiresAt, r.expired], [expiresAt, false]);
    assert.equal((await t.install()).status, 200);
    assert.equal(t.installedVersion(), "1.0.0");
    assert.deepEqual([t.journal("registry-no-expiry").length, t.journal("registry-expired").length], [0, 0]);
  } finally {
    await t.stop();
  }
});

test("an index without expiresAt: accepted as before, journaled once per registry", async () => {
  const t = await setup();
  try {
    const first = publish(t.reg, t.key);
    assert.equal((await t.fetch()).status, 200);
    publish(t.reg, t.key, { version: "1.1.0" });
    assert.equal((await t.fetch()).status, 200);
    await t.fetch();
    const r = await t.registry();
    assert.deepEqual([r.expiresAt, r.expired], [null, false]);
    assert.deepEqual(t.journal("registry-no-expiry").map((e) => [e.registry, e.generatedAt]), [["default", first.generatedAt]]);
    assert.equal((await t.install()).status, 200, "no date — no limit: the format is a contract with the registry's signer");
    assert.equal(t.installedVersion(), "1.1.0");
  } finally {
    await t.stop();
  }
});

test("a catalog past its signed date: read for tiers and the blocklist, nothing installs or updates from it", async () => {
  const t = await setup();
  try {
    publish(t.reg, t.key, { top: { expiresAt: inMs(48 * HOUR) } });
    assert.equal((await t.fetch()).status, 200);
    assert.equal((await t.install()).status, 200);
    // the registry is frozen at a newer release whose date has passed (a replayed copy, or an abandoned mirror)
    const expiresAt = inMs(-HOUR);
    publish(t.reg, t.key, { version: "2.0.0", top: { expiresAt } });
    const f = await t.fetch();
    assert.equal(f.status, 200, "not older than the one in hand — it is still the newest list the hub can get");
    assert.deepEqual([f.body.registries[0].expiresAt, f.body.registries[0].expired], [expiresAt, true]);
    const r = await t.registry();
    assert.deepEqual([r.expiresAt, r.expired], [expiresAt, true]);
    const cat = await t.call("GET", "/registry/catalog");
    assert.equal(cat.body.plugins.find((p) => p.id === "hello").version, "2.0.0", "the catalog is still shown");
    // the update is refused before any window
    const up = await t.call("POST", "/registry/install", { id: "hello" });
    assert.deepEqual([up.status, up.body], [409, { error: "registry:expired", registry: "default", expiresAt }]);
    assert.equal(t.installedVersion(), "1.0.0");
    assert.deepEqual(t.journal("registry-expired").map((e) => [e.registry, e.expiresAt]), [["default", expiresAt]], "one journal line per catalog");
    // its blocklist still applies: an expired list can take away, it cannot give
    publish(t.reg, t.key, { version: "2.0.0", top: { expiresAt: inMs(-HOUR / 2) }, blocklist: [{ id: "hello", reason: "malware" }] });
    assert.equal((await t.fetch()).status, 200);
    const inst = await t.call("GET", "/registry/installed");
    assert.equal(inst.body.installed.find((p) => p.id === "hello").disabled, "blocklist", JSON.stringify(inst.body.installed));
    // a fresh catalog from the registry lifts the refusal
    publish(t.reg, t.key, { version: "2.0.0", top: { expiresAt: inMs(48 * HOUR) } });
    assert.equal((await t.fetch()).status, 200);
    assert.equal((await t.registry()).expired, false);
    assert.equal((await t.install()).status, 200);
    assert.equal(t.installedVersion(), "2.0.0");
  } finally {
    await t.stop();
  }
});

test("the date passes between the consent window and the answer: the token does not install", async () => {
  const t = await setup();
  try {
    publish(t.reg, t.key, { top: { expiresAt: inMs(400) } });
    assert.equal((await t.fetch()).status, 200);
    const w = await t.call("POST", "/registry/install", { id: "hello" });
    assert.equal(w.status, 428, JSON.stringify(w.body));
    await sleep(600);
    const r = await t.call("POST", "/registry/install", { id: "hello", consentToken: w.body.token });
    assert.deepEqual([r.status, r.body.error], [409, "registry:expired"]);
    assert.equal(t.installedVersion(), null);
  } finally {
    await t.stop();
  }
});

test("rollback: an older signed catalog is refused on fetch and when put back on disk", async () => {
  const t = await setup();
  try {
    const old = publish(t.reg, t.key, { blocklist: [] });
    assert.equal((await t.fetch()).status, 200);
    const cur = publish(t.reg, t.key, { version: "1.1.0", blocklist: [{ id: "hello", reason: "malware" }] });
    assert.equal((await t.fetch()).status, 200);
    // the "server" serves the older pair again
    writeFileSync(join(t.reg, "index.json"), old.index);
    writeFileSync(join(t.reg, "index.json.minisig"), old.sig);
    const f = await t.fetch();
    assert.deepEqual([f.status, f.body], [409, { error: "registry:rollback", have: cur.generatedAt, got: old.generatedAt, registry: "default" }]);
    // a local process puts the older pair into the hub's own cache: the signature is valid, the catalog is not accepted
    writeFileSync(join(t.h.home, "Registry", "index.json"), old.index);
    writeFileSync(join(t.h.home, "Registry", "index.json.minisig"), old.sig);
    const config = loadConfig({ env: { AGENTHUB_HOME: t.h.home, AGENTHUB_BUILTIN_PLUGINS: join(t.h.home, "no-builtin"), AGENTHUB_SERVICES: "none" }, overrides: { services: { plugins: { indexUrl: join(t.reg, "index.json"), publicKey: t.key.publicKey, allowNetwork: false, checkUpdates: false } } } });
    const lines = [];
    const fresh = new PluginManager({ config, journal: { write: (e) => lines.push(e) } });
    await fresh.init({ cleanTemp: "stale" });
    assert.equal(fresh.catalog, null);
    assert.equal(fresh.catalogError, "registry:rollback");
    assert.deepEqual(lines.filter((e) => e.type === "registry-cache-rejected").map((e) => [e.registry, e.error]), [["default", "registry:rollback"]]);
    // the current pair back on disk is accepted
    writeFileSync(join(t.h.home, "Registry", "index.json"), cur.index);
    writeFileSync(join(t.h.home, "Registry", "index.json.minisig"), cur.sig);
    const again = new PluginManager({ config, journal: { write: () => {} } });
    await again.init({ cleanTemp: "stale" });
    assert.equal(again.catalogError, null);
    assert.equal(again.catalog.plugins.get("hello").version, "1.1.0");
  } finally {
    await t.stop();
  }
});
