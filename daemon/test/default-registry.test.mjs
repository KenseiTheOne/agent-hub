// The built-in registry: a hub whose config.json names no registry uses the official catalog and its key
// (lib/registry/default-registry.mjs), so a fresh install has a catalog without editing files. Anything the human wrote
// wins; a test hub gets it only on request. No network: nothing here fetches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REGISTRY } from "../lib/registry/default-registry.mjs";
import { parsePublicKey } from "../lib/registry/minisign.mjs";
import { PluginManager, registryKeyIdentity, registrySources, withDefaultRegistry } from "../lib/plugins.mjs";
import { loadConfig } from "../lib/config.mjs";
import { cleanup, tempHome } from "./helpers.mjs";

test("the built-in registry: an https index address and a minisign key that parses", () => {
  assert.match(DEFAULT_REGISTRY.indexUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/index\/index\.json$/);
  assert.equal(parsePublicKey(DEFAULT_REGISTRY.publicKey).keyIdHex, "D092435A6EE94FFB");
  assert.equal(registryKeyIdentity(DEFAULT_REGISTRY.publicKey).fingerprint.length, 32);
});

test("withDefaultRegistry: filled in only when the human named no registry of their own", () => {
  const filled = withDefaultRegistry({ allowNetwork: false });
  assert.deepEqual(filled, { allowNetwork: false, ...DEFAULT_REGISTRY });
  assert.deepEqual(registrySources(filled).list, [{ name: "default", ...DEFAULT_REGISTRY, trust: "official" }]);
  assert.deepEqual(withDefaultRegistry(undefined), { ...DEFAULT_REGISTRY });
  // other registries stay, the built-in one comes first
  const extra = { registries: [{ name: "team", indexUrl: "https://team.example/index.json", publicKey: "k" }] };
  assert.deepEqual(registrySources(withDefaultRegistry(extra)).list.map((r) => r.name), ["default", "team"]);
  // the human's word wins: either key present (even empty), a registry called "default", or the switch
  for (const own of [
    { indexUrl: "https://mine.example/index.json" },
    { publicKey: "untrusted comment: x\nRWQ" },
    { indexUrl: null },
    { publicKey: "" },
    { registries: [{ name: "default", indexUrl: "https://mine.example/index.json", publicKey: "k" }] },
    { defaultRegistry: false },
  ]) {
    assert.equal(withDefaultRegistry(own), own, JSON.stringify(own));
  }
});

test("withDefaultRegistry: a test hub gets the built-in registry only with defaultRegistry = true", () => {
  const plain = {};
  assert.equal(withDefaultRegistry(plain, { testMode: true }), plain);
  assert.equal(withDefaultRegistry({ defaultRegistry: true }, { testMode: true }).indexUrl, DEFAULT_REGISTRY.indexUrl);
  assert.equal(withDefaultRegistry({ defaultRegistry: true, indexUrl: "https://mine.example/i.json" }, { testMode: true }).indexUrl, "https://mine.example/i.json");
});

test("PluginManager: a test hub has no registry by itself; with defaultRegistry = true the catalog is configured with the built-in key", () => {
  const home = tempHome("ah-defreg-");
  try {
    const env = { ...process.env, AGENTHUB_HOME: home };
    const bare = new PluginManager({ config: loadConfig({ env }) });
    assert.equal(bare.configured(), false);
    assert.deepEqual(bare.sources(), []);
    const mgr = new PluginManager({ config: loadConfig({ env, overrides: { services: { plugins: { defaultRegistry: true, allowNetwork: false } } } }) });
    assert.equal(mgr.configured(), true);
    const [src] = mgr.sources();
    assert.equal(src.name, "default");
    assert.equal(src.trust, "official");
    assert.equal(src.indexUrl, DEFAULT_REGISTRY.indexUrl);
    assert.equal(registryKeyIdentity(src.publicKey).keyId, "D092435A6EE94FFB");
  } finally {
    cleanup(home);
  }
});
