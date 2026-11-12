// G19: several plugin registries. services.plugins.registries: [{name, indexUrl, publicKey, trust}] next to the old scalar
// indexUrl/publicKey (= the registry "default", trust official). Each registry is verified with its own key; a community
// registry never makes a plugin official; the same id in two registries — the earlier one wins in the catalog, an installed
// plugin follows the registry it came from; a registry's blocklist applies to its own plugins, an official one's — to all.
// Registries are temporary directories with synthetic plugins; keys are generated here. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetaText } from "../lib/meta.mjs";
import { managerFor, registryLabel, registrySources } from "../lib/plugins.mjs";
import { generateKeyPair, sign } from "../lib/registry/minisign.mjs";
import { packTarGz } from "../lib/registry/tarball.mjs";
import { permissionsFromMeta } from "../lib/registry/perms.mjs";
import { cleanup, req, startHub, tempHome, waitFor } from "./helpers.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const PLATFORM_TAG = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;
const UID = process.getuid();
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";

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

function pluginText(title, version = "1.0.0") {
  return `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.version>${version}</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>${PLATFORM_TAG}</agenthub.platforms>
# <agenthub.effects>open.url</agenthub.effects>
echo "${title} | status=ok"
`;
}

function publish(dir, plugins, { key, generatedAt, blocklist = [] }) {
  mkdirSync(join(dir, "archives"), { recursive: true });
  const entries = [];
  for (const p of plugins) {
    const gz = packTarGz([
      { path: `${p.id}/${p.id}.5m.sh`, data: p.text },
      { path: `${p.id}/README.md`, data: "# r\n" },
    ]);
    const meta = parseMetaText(p.text).meta;
    const name = `${p.id}-${meta.version}.tar.gz`;
    writeFileSync(join(dir, "archives", name), gz);
    entries.push({ id: p.id, version: meta.version, title: meta.title, platforms: meta.platforms, type: meta.type, tier: p.tier || "community", official: p.tier === "official", archive: `archives/${name}`, sha256: sha(gz), size: gz.length, permissions: permissionsFromMeta(meta) });
  }
  const text = JSON.stringify({ version: 1, generatedAt, plugins: entries, blocklist }, null, 2) + "\n";
  writeFileSync(join(dir, "index.json"), text);
  writeFileSync(join(dir, "index.json.minisig"), sign(Buffer.from(text), key.secretKey));
}

let clock = Date.parse("2026-11-12T10:00:00Z");
const nextTime = () => new Date((clock += 60_000)).toISOString();

async function hubWithRegistries() {
  const a = { dir: tempHome("ah-rega-"), key: generateKeyPair() };
  const b = { dir: tempHome("ah-regb-"), key: generateKeyPair() };
  const state = { pid: 4242 };
  const h = await startHub({
    services: "plugins",
    sys: appSys(state),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      services: {
        plugins: {
          indexUrl: join(a.dir, "index.json"),
          publicKey: a.key.publicKey,
          registries: [{ name: "extra", indexUrl: join(b.dir, "index.json"), publicKey: b.key.publicKey, trust: "community" }],
          allowNetwork: false,
        },
      },
    },
  });
  managerFor(h.config.paths.home).onChange = () => h.core.host.rescan();
  const stop = h.stop;
  return Object.assign(h, {
    a,
    b,
    call: (method, path, body) => req(h.sock, method, path, body),
    async stop() {
      await stop();
      cleanup(a.dir);
      cleanup(b.dir);
    },
  });
}

async function installWithConsent(h, id) {
  const r1 = await h.call("POST", "/registry/install", { id });
  assert.equal(r1.status, 428, JSON.stringify(r1.body));
  const r2 = await h.call("POST", "/registry/install", { id, consentToken: r1.body.token });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return r1.body;
}

test("registry config: the scalar pair is \"default\" (official), registries[] follow; invalid entries are skipped", () => {
  assert.deepEqual(registrySources({ indexUrl: "https://r.example/index.json", publicKey: "K" }).list, [{ name: "default", indexUrl: "https://r.example/index.json", publicKey: "K", trust: "official" }]);
  const r = registrySources({
    indexUrl: "https://r.example/index.json",
    publicKey: "K",
    registries: [
      { name: "team", indexUrl: "https://t.example/index.json", publicKey: "T" },
      { name: "corp", indexUrl: "https://c.example/index.json", publicKey: "C", trust: "official" },
      { name: "default", indexUrl: "https://x.example/index.json", publicKey: "X" },
      { name: "Bad Name", indexUrl: "https://x.example/index.json", publicKey: "X" },
      { name: "nokey", indexUrl: "https://x.example/index.json" },
      { name: "weird", indexUrl: "https://x.example/index.json", publicKey: "X", trust: "root" },
      "nope",
    ],
  });
  assert.deepEqual(r.list.map((x) => [x.name, x.trust]), [["default", "official"], ["team", "community"], ["corp", "official"]]);
  assert.deepEqual(r.errors.map((e) => e.error), ["duplicate", "name", "publicKey", "trust", "type"]);
  assert.deepEqual(registrySources({ registries: [{ name: "only", indexUrl: "/x/index.json", publicKey: "K", trust: "official" }] }).list.map((x) => x.name), ["only"], "the array form alone works");
  assert.equal(registryLabel("default", [{ name: "default" }]), null, "single default registry — no suffix");
  assert.equal(registryLabel("default", [{ name: "default" }, { name: "extra" }]), "default");
});

test("two registries: per-registry signatures, community trust caps the tier, shadowed ids, pinned installs, scoped blocklists", async () => {
  const h = await hubWithRegistries();
  try {
    publish(h.a.dir, [{ id: "hello", text: pluginText("Hello"), tier: "official" }], { key: h.a.key, generatedAt: nextTime() });
    // the extra registry claims "official" for its plugin and also lists hello
    publish(h.b.dir, [{ id: "wx", text: pluginText("Wx"), tier: "official" }, { id: "hello", text: pluginText("Hello B", "9.0.0") }], { key: h.b.key, generatedAt: nextTime() });
    const f = await h.call("POST", "/registry/fetch");
    assert.equal(f.status, 200, JSON.stringify(f.body));
    assert.deepEqual(f.body.registries.map((r) => [r.name, r.ok]), [["default", true], ["extra", true]]);
    assert.ok(existsSync(join(h.config.paths.home, "Registry", "index.json")), "the default registry keeps the old files");
    assert.ok(existsSync(join(h.config.paths.home, "Registry", "sources", "extra", "index.json")));

    const cat = (await h.call("GET", "/registry/catalog")).body;
    assert.deepEqual(cat.registries.map((r) => [r.name, r.trust, r.label, r.plugins, r.error]), [["default", "official", "default", 1, null], ["extra", "community", "extra", 2, null]]);
    assert.equal(cat.registries[1].tierLabel, "плагин сообщества · extra");
    const hello = cat.plugins.find((p) => p.id === "hello");
    assert.equal(hello.registry, "default", "the earlier registry wins");
    assert.equal(hello.version, "1.0.0");
    assert.equal(hello.tierLabel, "официальный плагин · default");
    const wx = cat.plugins.find((p) => p.id === "wx");
    assert.deepEqual([wx.registry, wx.tier, wx.official, wx.capped, wx.registryLabel], ["extra", "community", false, true, "extra"]);
    assert.deepEqual(cat.shadowed, [{ id: "hello", registry: "extra", by: "default" }]);
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "registry-shadowed" && e.plugin === "hello"));

    // install from the extra registry: the lock remembers it, the consent window names it
    const consent = await installWithConsent(h, "wx");
    assert.deepEqual([consent.registry, consent.registryLabel, consent.tier], ["extra", "extra", "community"]);
    const lock = JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8"));
    assert.equal(lock.plugins.wx.registry, "extra");
    assert.equal(lock.plugins.wx.tier, "community");
    await installWithConsent(h, "hello");
    assert.equal(JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")).plugins.hello.registry, "default");
    const inst = (await h.call("GET", "/registry/installed")).body.installed;
    assert.deepEqual(inst.find((p) => p.id === "wx") && [inst.find((p) => p.id === "wx").registry, inst.find((p) => p.id === "wx").tier], ["extra", "community"]);
    assert.equal(inst.find((p) => p.id === "hello").tier, "official");
    // /state: the registry of an installed plugin
    const wxSt = await waitFor(async () => (await h.call("GET", "/state")).body.plugins.find((p) => p.id === "wx"), { timeoutMs: 8000 });
    assert.deepEqual([wxSt.registry, wxSt.registryLabel, wxSt.tier], ["extra", "extra", "community"]);

    // a newer wx in the default (earlier) registry does not take over the installed wx: updates follow its own registry
    publish(h.a.dir, [{ id: "hello", text: pluginText("Hello"), tier: "official" }, { id: "wx", text: pluginText("Wx A", "5.0.0"), tier: "official" }], { key: h.a.key, generatedAt: nextTime() });
    publish(h.b.dir, [{ id: "wx", text: pluginText("Wx", "1.1.0"), tier: "official" }, { id: "hello", text: pluginText("Hello B", "9.0.0") }], { key: h.b.key, generatedAt: nextTime() });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    const mgr = managerFor(h.config.paths.home);
    const ups = mgr.pluginUpdates();
    assert.deepEqual(ups.map((u) => [u.id, u.version, u.registry]), [["wx", "1.1.0", "extra"]], "hello 9.0.0 from extra is not an update of hello from default");
    const cat2 = (await h.call("GET", "/registry/catalog")).body;
    assert.equal(cat2.plugins.find((p) => p.id === "wx").registry, "extra", "an installed plugin is shown from its own registry");
    assert.equal(cat2.plugins.find((p) => p.id === "wx").version, "1.1.0");

    // blocklists: the community registry can't block a plugin of the default registry; the official one blocks any
    publish(h.b.dir, [{ id: "wx", text: pluginText("Wx", "1.1.0"), tier: "official" }], { key: h.b.key, generatedAt: nextTime(), blocklist: [{ id: "hello", reason: "nope" }] });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    assert.equal(JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")).plugins.hello.disabled, null);
    publish(h.a.dir, [{ id: "hello", text: pluginText("Hello"), tier: "official" }], { key: h.a.key, generatedAt: nextTime(), blocklist: [{ id: "wx", reason: "malware" }] });
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    assert.equal(JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")).plugins.wx.disabled?.reason, "blocklist");

    // a registry signed with a foreign key fails alone: the other one still works
    publish(h.b.dir, [{ id: "wx", text: pluginText("Wx", "1.2.0") }], { key: h.a.key, generatedAt: nextTime() });
    const f3 = await h.call("POST", "/registry/fetch");
    assert.equal(f3.status, 200, JSON.stringify(f3.body));
    assert.deepEqual(f3.body.registries.map((r) => [r.name, r.ok, r.error || null]), [["default", true, null], ["extra", false, "registry:foreign-key"]]);
    assert.equal((await h.call("GET", "/registry/catalog")).body.plugins.find((p) => p.id === "wx").version, "1.1.0", "the last verified catalog of extra stays");
  } finally {
    await h.stop();
  }
});
