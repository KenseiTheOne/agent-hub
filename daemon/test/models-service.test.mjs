// The models service: the Claude models of this sign-in from the Claude Code OAuth token. Doubles only: a fake
// `security`, our own HTTP server on 127.0.0.1, synthetic JSON. The real keychain and api.anthropic.com are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";
import { cleanModels, ENV_NAME, MODELS_PATH, ModelsService } from "../lib/services/models.mjs";
import { endpoint, USAGE_HOST } from "../lib/services/usage.mjs";

const TOKEN = "sk-ant-oat01-SYNTHETIC-test-token-0123456789";
const LIST = {
  data: [
    { type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2", created_at: "2026-11-09T18:30:00Z", extra: "dropped" },
    { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "not a date" },
    { type: "model", id: "claude-opus-4-5-20251101", display_name: "x".repeat(61) },
    { type: "model", id: "claude-fable-5-2", display_name: "a repeat" },
    { type: "model", id: "gpt-9" },
    { type: "model", id: "claude-bad id" },
    "not an object",
  ],
  has_more: false,
  first_id: "claude-fable-5-2",
};

function fakeSecurity(dir, { json } = {}) {
  const out = join(dir, "cred.json");
  writeFileSync(out, json ?? JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "sk-ant-ort01-REFRESH", expiresAt: Date.now() + 3_600_000 } }));
  return { p: writePlugin(dir, "security", `#!/bin/sh\nif [ "$1" = find-generic-password ] && [ "$3" = "Claude Code-credentials" ] && [ "$4" = -w ]; then cat "${out}"; exit 0; fi\nexit 44\n`), out };
}

async function fakeApi({ status = 200, body = LIST } = {}) {
  const seen = [];
  const state = { status, body };
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(typeof state.body === "string" ? state.body : JSON.stringify(state.body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}${MODELS_PATH}`, seen, state, close: () => new Promise((r) => srv.close(r)) };
}

const modelsCfg = (extra) => ({ services: { models: { firstDelayMs: 10, intervalMs: 100, backoffCapMs: 100, ...extra } } });

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const read = (file) => existsSync(file) && JSON.parse(readFileSync(file, "utf8"));

test("cleanModels: id, display name and release date only; foreign ids, repeats and junk are dropped; not a list — null", () => {
  assert.deepEqual(cleanModels(LIST), [
    { id: "claude-fable-5-2", name: "Claude Fable 5.2", created_at: "2026-11-09T18:30:00Z" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-opus-4-5-20251101" },
  ]);
  assert.equal(cleanModels({ limits: [] }), null);
  assert.equal(cleanModels([]), null);
  assert.equal(cleanModels(null), null);
  assert.equal(cleanModels({ data: Array.from({ length: 500 }, (_, i) => ({ id: `claude-x-${i}` })) }).length, 200);
});

test("endpoint for models: live — only https://api.anthropic.com/v1/models; test — only a loopback double", () => {
  assert.deepEqual(endpoint({}, false, MODELS_PATH), { proto: "https:", host: USAGE_HOST, port: 443, path: "/v1/models?limit=1000" });
  assert.equal(endpoint({ url: "https://example.com/v1/models" }, true, MODELS_PATH), null);
  assert.equal(endpoint({ url: "http://127.0.0.1:9/v1/models?limit=1000" }, true, MODELS_PATH).path, "/v1/models?limit=1000");
});

test("models service: token from the keychain → one GET /v1/models → Cache/models.json 0600 with the list only; the token stays nowhere", async () => {
  const bin = tempHome("ah-mdl-");
  const sec = fakeSecurity(bin);
  const api = await fakeApi();
  const h = await startHub({ services: "models", overrides: modelsCfg({ securityPath: sec.p, url: api.url }) });
  try {
    const file = join(h.home, "Cache", "models.json");
    const cache = await waitFor(() => read(file), { timeoutMs: 5000 });
    assert.equal(cache.error, null);
    assert.equal(typeof cache.fetched_at, "number");
    assert.deepEqual(cache.models.map((m) => m.id), ["claude-fable-5-2", "claude-opus-5-5", "claude-opus-4-5-20251101"]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const r0 = api.seen[0];
    assert.equal(r0.method, "GET");
    assert.equal(r0.url, "/v1/models?limit=1000");
    assert.equal(r0.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(r0.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(r0.headers["anthropic-version"], "2023-06-01");
    // trusted plugins get the path; an unverified one doesn't
    assert.equal(h.core.pluginEnvFor({ source: "builtin" })[ENV_NAME], file);
    assert.equal(h.core.pluginEnvFor({ source: "local" })[ENV_NAME], undefined);
    // repeat on interval; the journal and the bus — only when the outcome or the list changes
    await waitFor(() => api.seen.length >= 3, { timeoutMs: 5000 });
    const journal = readFileSync(h.config.paths.journal, "utf8");
    assert.equal((journal.match(/"models-fetch"/g) || []).length, 1);
    for (const f of walk(h.home)) {
      const text = readFileSync(f, "utf8");
      assert.ok(!text.includes(TOKEN) && !text.includes("REFRESH"), `token in ${f}`);
    }
    // a new model appears in the list → the cache follows and the change is journaled
    api.state.body = { data: [{ id: "claude-fable-5-3", display_name: "Claude Fable 5.3" }, ...LIST.data] };
    await waitFor(() => read(file)?.models?.[0]?.id === "claude-fable-5-3", { timeoutMs: 5000 });
    assert.equal((readFileSync(h.config.paths.journal, "utf8").match(/"models-fetch"/g) || []).length, 2);
  } finally {
    await h.stop();
    await api.close();
    cleanup(bin);
  }
});

test("models service: an error or a broken reply keeps the previous list and names a code; signed out — the list is erased and nothing is requested", async () => {
  const bin = tempHome("ah-mdl-");
  const sec = fakeSecurity(bin);
  const api = await fakeApi();
  const h = await startHub({ services: "models", overrides: modelsCfg({ securityPath: sec.p, url: api.url }) });
  try {
    const file = join(h.home, "Cache", "models.json");
    await waitFor(() => read(file)?.models?.length === 3, { timeoutMs: 5000 });
    for (const [state, code] of [
      [{ status: 429, body: { error: { message: "secret text" } } }, "http-429"],
      [{ status: 200, body: "{not json" }, "bad-response"],
      [{ status: 200, body: { data: [] } }, "bad-response"],
      [{ status: 200, body: { limits: [] } }, "bad-response"],
    ]) {
      Object.assign(api.state, state);
      const c = await waitFor(() => (read(file)?.error === code ? read(file) : null), { timeoutMs: 5000 });
      assert.equal(c.models.length, 3, code);
      assert.equal(typeof c.retry_at, "number", code);
      assert.ok(!JSON.stringify(c).includes("secret text"));
      Object.assign(api.state, { status: 200, body: LIST });
      await waitFor(() => read(file)?.error === null, { timeoutMs: 5000 });
    }
    // an expired token is not refreshed: the list stays
    writeFileSync(sec.out, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() - 1000 } }));
    const exp = await waitFor(() => (read(file)?.error === "token-expired" ? read(file) : null), { timeoutMs: 5000 });
    assert.equal(exp.models.length, 3);
    // signed out
    writeFileSync(sec.out, "{}");
    const out = await waitFor(() => (read(file)?.error === "no-token" ? read(file) : null), { timeoutMs: 5000 });
    assert.deepEqual(out.models, []);
    const n = api.seen.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(api.seen.length, n, "no requests without a token");
  } finally {
    await h.stop();
    await api.close();
    cleanup(bin);
  }
});

test("models service: test mode without doubles — no keychain, no network; services.models.enabled=false — no service and no variable", async () => {
  const h = await startHub({ services: "models", overrides: modelsCfg({}) });
  try {
    const file = join(h.home, "Cache", "models.json");
    const cache = await waitFor(() => read(file));
    assert.equal(cache.error, "no-endpoint");
    assert.deepEqual(cache.models, []);
  } finally {
    await h.stop();
  }
  const h2 = await startHub({ services: "models", overrides: { services: { models: { enabled: false } } } });
  try {
    assert.deepEqual(Object.keys(h2.core.pluginEnvFor({ source: "builtin" })), ["AGENTHUB_HUB_SOCKET"]);
  } finally {
    await h2.stop();
  }
});

test("models service: a fresh cache or a running backoff from the previous daemon run — the API isn't hit again at start", async () => {
  const home = tempHome("ah-mdl-");
  const ctx = (cfg) => ({ config: { testMode: true, services: { models: cfg }, paths: { pluginCache: home }, claudeHome: home }, journal: { write() {} }, emit() {}, providePluginEnv() {} });
  const file = join(home, "models.json");
  try {
    const now = Date.now() / 1000;
    writeFileSync(file, JSON.stringify({ version: 1, fetched_at: now - 10, error: null, models: [{ id: "claude-opus-5-5" }] }));
    const fresh = new ModelsService(ctx({ intervalMs: 60_000, firstDelayMs: 10 })).firstDelay();
    assert.ok(fresh > 40_000 && fresh <= 60_000, String(fresh));
    writeFileSync(file, JSON.stringify({ version: 1, fetched_at: null, error: "http-429", retry_at: now + 30, models: [] }));
    const backoff = new ModelsService(ctx({ firstDelayMs: 10 })).firstDelay();
    assert.ok(backoff > 20_000 && backoff <= 30_000, String(backoff));
    writeFileSync(file, "garbage");
    assert.equal(new ModelsService(ctx({ firstDelayMs: 10 })).firstDelay(), 10);
  } finally {
    cleanup(home);
  }
});
