// The usage service: Claude subscription quota from the Claude Code OAuth token. Doubles only: a fake `security`, our own
// HTTP server on 127.0.0.1, synthetic JSON. The real keychain and api.anthropic.com are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";
import { cleanRows, endpoint, keychainService, tokenFrom, UsageService, USAGE_HOST, USAGE_PATH } from "../lib/services/usage.mjs";
import { buildEnv } from "../lib/runner.mjs";

const TOKEN = "sk-ant-oat01-SYNTHETIC-test-token-0123456789";
const LIMITS = {
  limits: [
    { kind: "session", group: "session", percent: 31, severity: "normal", resets_at: "2026-11-04T12:00:00+00:00", scope: null, is_active: true, extra: "лишнее" },
    { kind: "weekly_all", group: "weekly", percent: 20, severity: "normal", resets_at: "2026-11-09T04:00:00+00:00" },
    { kind: "weekly_scoped", group: "weekly", percent: 3, resets_at: "2026-11-09T04:00:00+00:00", scope: { model: { id: "secret-id", display_name: "ModelX" }, surface: { x: 1 } } },
    { kind: "bad kind!", percent: 1 },
    "не объект",
  ],
  account: { email: "someone@example.com" },
};

// security double: prints JSON with a token only for the expected entry name; calls go to a log (without the value).
function fakeSecurity(dir, { service = "Claude Code-credentials", json } = {}) {
  const log = join(dir, "security.log");
  const out = join(dir, "cred.json");
  writeFileSync(out, json ?? JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "sk-ant-ort01-REFRESH", expiresAt: Date.now() + 3_600_000 } }));
  const p = writePlugin(dir, "security", `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = find-generic-password ] && [ "$3" = "${service}" ] && [ "$4" = -w ]; then cat "${out}"; exit 0; fi\nexit 44\n`);
  return { p, log, out };
}

// api.anthropic.com double: returns LIMITS or the code from status; remembers requests (method, path, headers).
async function fakeApi({ status = 200, body = LIMITS } = {}) {
  const seen = [];
  const state = { status, body };
  const srv = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(typeof state.body === "string" ? state.body : JSON.stringify(state.body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}/api/oauth/usage`, seen, state, close: () => new Promise((r) => srv.close(r)) };
}

const usageCfg = (extra) => ({ services: { usage: { firstDelayMs: 10, intervalMs: 100, backoffCapMs: 100, ...extra } } });

test("keychainService: like Claude Code — suffix sha256(NFC(dir))[:8] with CLAUDE_CONFIG_DIR", () => {
  assert.equal(keychainService({}), "Claude Code-credentials");
  const dir = "/Users/x/.claude-work";
  const h = createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  assert.equal(keychainService({ configDir: dir }), `Claude Code-credentials-${h}`);
  // CLAUDE_SECURESTORAGE_CONFIG_DIR takes precedence; empty — the default entry
  assert.equal(keychainService({ configDir: dir, secureDir: "" }), "Claude Code-credentials");
  const nfd = "/Users/x/Projé";
  const nfc = "/Users/x/Projé";
  assert.equal(keychainService({ secureDir: nfd }), keychainService({ secureDir: nfc }));
});

test("tokenFrom: token, expired (not refreshed), no token; cleanRows — safe fields only", () => {
  const now = Date.parse("2026-11-05T10:00:00Z");
  assert.deepEqual(tokenFrom(JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: now + 120_000 } }), now), { token: "t" });
  assert.deepEqual(tokenFrom(JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: now + 30_000 } }), now), { error: "token-expired" });
  assert.deepEqual(tokenFrom("{oops", now), { error: "no-token" });
  assert.deepEqual(tokenFrom(JSON.stringify({ claudeAiOauth: {} }), now), { error: "no-token" });
  const rows = cleanRows(LIMITS);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["group", "kind", "percent", "resets_at", "severity"]);
  assert.deepEqual(rows[2].scope, { model: { display_name: "ModelX" } });
  assert.doesNotMatch(JSON.stringify(rows), /secret-id|example\.com|лишнее|surface/);
  assert.equal(cleanRows({ nope: 1 }), null);
});

test("endpoint: live — only https://api.anthropic.com; test — only a loopback double", () => {
  assert.deepEqual(endpoint({ url: "http://127.0.0.1:1/x" }, false), { proto: "https:", host: USAGE_HOST, port: 443, path: USAGE_PATH });
  assert.equal(endpoint({ url: "https://evil.example/api" }, true), null);
  assert.equal(endpoint({}, true), null);
  assert.deepEqual(endpoint({ url: "http://127.0.0.1:8080/api/oauth/usage" }, true), { proto: "http:", host: "127.0.0.1", port: 8080, path: "/api/oauth/usage" });
  assert.deepEqual(endpoint({ live: true, url: "http://127.0.0.1:1/x" }, true).host, USAGE_HOST);
});

test("usage service: token from the keychain → GET with usage.py headers → Cache/usage.json 0600 with rows only; the token stays nowhere", async () => {
  const bin = tempHome("ah-usb-");
  const sec = fakeSecurity(bin);
  const api = await fakeApi();
  const h = await startHub({ services: "usage", overrides: usageCfg({ securityPath: sec.p, url: api.url }) });
  try {
    const file = join(h.home, "Cache", "usage.json");
    const cache = await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")), { timeoutMs: 5000 });
    assert.equal(cache.error, null);
    assert.equal(typeof cache.fetched_at, "number");
    assert.deepEqual(cache.rows.map((r) => r.kind), ["session", "weekly_all", "weekly_scoped"]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // the request is the same as in usage.py
    const r0 = api.seen[0];
    assert.equal(r0.method, "GET");
    assert.equal(r0.url, "/api/oauth/usage");
    assert.equal(r0.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(r0.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(r0.headers["content-type"], "application/json");
    assert.match(readFileSync(sec.log, "utf8"), /^find-generic-password -s Claude Code-credentials -w$/m);
    // repeat on interval
    await waitFor(() => api.seen.length >= 2, { timeoutMs: 5000 });
    // the token is neither in the cache, nor in the log, nor in the hub directory
    const journal = readFileSync(h.config.paths.journal, "utf8");
    assert.match(journal, /"usage-fetch"/);
    for (const f of walk(h.home)) {
      const text = readFileSync(f, "utf8");
      assert.ok(!text.includes(TOKEN) && !text.includes("REFRESH"), `token in ${f}`);
    }
    // the log — only when the outcome changes
    assert.equal((journal.match(/"usage-fetch"/g) || []).length, 1);
  } finally {
    await h.stop();
    await api.close();
    cleanup(bin);
  }
});

test("usage service: no token — no requests, rows of the previous account are erased; expired — not refreshed, rows stay", async () => {
  const bin = tempHome("ah-usn-");
  const sec = fakeSecurity(bin, { service: "другая запись" });
  const api = await fakeApi();
  const h = await startHub({ services: "usage", overrides: usageCfg({ securityPath: sec.p, url: api.url }) });
  try {
    const file = join(h.home, "Cache", "usage.json");
    const cache = await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")));
    assert.equal(cache.error, "no-token");
    assert.deepEqual(cache.rows, []);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(api.seen.length, 0, "no network access without a token");
  } finally {
    await h.stop();
  }
  // expired: rows from the last success stay, no requests, the refresh token isn't used
  const sec2 = fakeSecurity(bin, { json: JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "sk-ant-ort01-REFRESH", expiresAt: Date.now() - 1000 } }) });
  const h2 = await startHub({ services: "usage", overrides: usageCfg({ securityPath: sec2.p, url: api.url, firstDelayMs: 400 }) });
  try {
    const file = join(h2.home, "Cache", "usage.json");
    // the last success (before the service's first attempt: firstDelayMs 400)
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(h2.home, "Cache"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, fetched_at: 1, error: null, rows: [{ kind: "weekly_all", percent: 5 }] }));
    const cache = await waitFor(() => {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return j.error === "token-expired" ? j : null;
    });
    assert.deepEqual(cache.rows, [{ kind: "weekly_all", percent: 5 }]);
    assert.equal(api.seen.length, 0);
  } finally {
    await h2.stop();
    await api.close();
    cleanup(bin);
  }
});

test("usage service: HTTP 429 and a broken reply → an error code without text, previous rows stay", async () => {
  const bin = tempHome("ah-use-");
  const sec = fakeSecurity(bin);
  const api = await fakeApi();
  const h = await startHub({ services: "usage", overrides: usageCfg({ securityPath: sec.p, url: api.url }) });
  try {
    const file = join(h.home, "Cache", "usage.json");
    await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")).rows.length === 3);
    api.state.status = 429;
    api.state.body = { error: { message: `rate limited for ${TOKEN}` } };
    const c429 = await waitFor(() => {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return j.error === "http-429" ? j : null;
    });
    assert.equal(c429.rows.length, 3);
    api.state.status = 200;
    api.state.body = "<html>не JSON</html>";
    const bad = await waitFor(() => {
      const j = JSON.parse(readFileSync(file, "utf8"));
      return j.error === "bad-response" ? j : null;
    });
    assert.equal(bad.rows.length, 3);
    assert.doesNotMatch(readFileSync(file, "utf8") + readFileSync(h.config.paths.journal, "utf8"), /rate limited|html|sk-ant/);
  } finally {
    await h.stop();
    await api.close();
    cleanup(bin);
  }
});

test("usage service: test mode without doubles — no keychain, no network; services.usage.enabled=false — no service and no variable", async () => {
  const h = await startHub({ services: "usage", overrides: usageCfg({}) });
  try {
    const file = join(h.home, "Cache", "usage.json");
    const cache = await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, "utf8")));
    assert.equal(cache.error, "no-endpoint");
    assert.equal(h.core.pluginEnvFor({ source: "builtin" }).AGENTHUB_USAGE_FILE, file);
  } finally {
    await h.stop();
  }
  const h2 = await startHub({ services: "usage", overrides: { services: { usage: { enabled: false } } } });
  try {
    // no service variable; a trusted plugin always gets the hub socket (contract 3)
    assert.deepEqual(Object.keys(h2.core.pluginEnvFor({ source: "builtin" })), ["AGENTHUB_HUB_SOCKET"]);
  } finally {
    await h2.stop();
  }
});

test("AGENTHUB_USAGE_FILE: builtin and official only; not for third-party and local; names taken by the core aren't overridden", async () => {
  const plugins = tempHome("ah-usp-");
  writePlugin(plugins, "probe.1h.sh", `#!/bin/sh\necho "file=\${AGENTHUB_USAGE_FILE:-none}"\n`);
  const h = await startHub({ pluginsDir: plugins, services: "usage", overrides: usageCfg({}) });
  try {
    const title = await waitFor(() => h.core.pluginState("probe")?.header[0]?.title);
    assert.equal(title, `file=${join(h.home, "Cache", "usage.json")}`);
    const file = join(h.home, "Cache", "usage.json");
    assert.equal(h.core.pluginEnvFor({ source: "installed", granted: { official: true } }).AGENTHUB_USAGE_FILE, file);
    assert.deepEqual(h.core.pluginEnvFor({ source: "installed", granted: { official: false } }), {});
    assert.deepEqual(h.core.pluginEnvFor({ source: "local" }), {});
    assert.throws(() => h.core.setPluginEnv("AGENTHUB_LANG", "x"));
    assert.throws(() => h.core.setPluginEnv("PATH", "x"));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
  const env = buildEnv({ pluginId: "p", dataPath: "/d", cachePath: "/c", reason: "Manual", extra: { AGENTHUB_USAGE_FILE: "/u", AGENTHUB_PLUGIN_ID: "evil", AGENTHUB_SECRET_X: "s", HOME: "/x" } });
  assert.equal(env.AGENTHUB_USAGE_FILE, "/u");
  assert.equal(env.AGENTHUB_PLUGIN_ID, "p");
  assert.equal(env.AGENTHUB_SECRET_X, undefined);
  assert.notEqual(env.HOME, "/x");
});

test("usage service → built-in quota: header from the hub cache (end-to-end run through the daemon)", { timeout: 30_000 }, async () => {
  const bin = tempHome("ah-usq-");
  const sec = fakeSecurity(bin);
  const api = await fakeApi({
    body: { limits: [{ kind: "weekly_all", group: "weekly", percent: 42, severity: "normal", resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }] },
  });
  const { resolve: res, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { cpSync } = await import("node:fs");
  const only = tempHome("ah-usqp-");
  cpSync(res(dirname(fileURLToPath(import.meta.url)), "../../plugins/quota"), join(only, "quota"), { recursive: true });
  const h = await startHub({ pluginsDir: only, services: "usage", overrides: usageCfg({ securityPath: sec.p, url: api.url, intervalMs: 60_000 }) });
  try {
    await waitFor(() => existsSync(join(h.home, "Cache", "usage.json")) && JSON.parse(readFileSync(join(h.home, "Cache", "usage.json"), "utf8")).rows.length === 1);
    await h.core.host.refresh("quota", "Manual");
    const st = await waitFor(() => (h.core.pluginState("quota")?.header[0]?.params?.tile === "42%" ? h.core.pluginState("quota") : null), { timeoutMs: 10_000 });
    assert.match(st.header[0].title, /^Неделя 42%/);
  } finally {
    await h.stop();
    await api.close();
    cleanup(bin);
    cleanup(only);
  }
});

// A service without a daemon: its own ctx (cache directory, log and bus — in memory).
function bareService(dir, usage) {
  const journal = [];
  const ctx = {
    config: { testMode: true, claudeHome: join(dir, "claude"), paths: { pluginCache: join(dir, "Cache") }, services: { usage } },
    journal: { write: (e) => journal.push(e) },
    emit: () => {},
    providePluginEnv: () => {},
  };
  return { svc: new UsageService(ctx), journal, file: join(dir, "Cache", "usage.json") };
}

test("usage service: backoff after 429 survives a restart — new instances don't hit the API before retry_at", async () => {
  const bin = tempHome("ah-usr-");
  const sec = fakeSecurity(bin);
  const api = await fakeApi({ status: 429, body: { error: "slow down" } });
  try {
    const cfg = { securityPath: sec.p, url: api.url, firstDelayMs: 10 };
    const a = bareService(bin, cfg);
    const delay = await a.svc.tick();
    assert.equal(delay, 900_000);
    const cache = JSON.parse(readFileSync(a.file, "utf8"));
    assert.equal(cache.error, "http-429");
    assert.ok(Math.abs(cache.retry_at - (cache.checked_at + 900)) < 1, "retry_at = attempt + 429 backoff");
    assert.equal(api.seen.length, 1);
    // three "daemon restarts" in a row: each waits for the end of the backoff, not 10 ms
    for (let i = 0; i < 3; i++) {
      const b = bareService(bin, cfg);
      const first = b.svc.firstDelay();
      assert.ok(first > 890_000 && first <= 900_000, `firstDelay=${first}`);
      b.svc.start();
      b.svc.stop();
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(api.seen.length, 1, "restarts don't hit the API");
    // backoff is over — the first request again after firstDelay; a distant/broken retry_at is capped at an hour
    writeFileSync(a.file, JSON.stringify({ ...cache, retry_at: Date.now() / 1000 - 5 }));
    assert.equal(bareService(bin, cfg).svc.firstDelay(), 10);
    writeFileSync(a.file, JSON.stringify({ ...cache, retry_at: Date.now() / 1000 + 10 * 86_400 }));
    assert.equal(bareService(bin, cfg).svc.firstDelay(), 3_600_000);
    // no token / expired — the network isn't touched, retry_at isn't written
    const c = bareService(bin, { securityPath: join(bin, "nope"), url: api.url });
    await c.svc.tick();
    const noTok = JSON.parse(readFileSync(c.file, "utf8"));
    assert.equal(noTok.error, "no-token");
    assert.equal(noTok.retry_at, undefined);
  } finally {
    await api.close();
    cleanup(bin);
  }
});

test("usage service: an overall request deadline — a byte-by-byte reply doesn't hang tick", { timeout: 15_000 }, async () => {
  const bin = tempHome("ah-usd-");
  const sec = fakeSecurity(bin);
  const conns = [];
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    const t = setInterval(() => res.write(" "), 100);
    conns.push({ t, res });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { svc, file } = bareService(bin, { securityPath: sec.p, url: `http://127.0.0.1:${srv.address().port}/api/oauth/usage`, timeoutMs: 800 });
    const t0 = Date.now();
    await svc.tick();
    const took = Date.now() - t0;
    // Without the overall deadline the drip never ends and tick runs into the 15 s test timeout; 8 s leaves room for a
    // loaded machine (the fake `security` spawn alone can take seconds during a full parallel run).
    assert.ok(took < 8000, `tick hung for ${took} ms`);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).error, "timeout");
  } finally {
    for (const c of conns) {
      clearInterval(c.t);
      c.res.destroy();
    }
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
    cleanup(bin);
  }
});

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) out.push(...walk(p));
    else if (n.isFile()) out.push(p);
  }
  return out;
}
