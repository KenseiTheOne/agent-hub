// OAuth connections (oauth service, lib/oauth.mjs, lib/mcp-client.mjs, /connections routes): everything runs on doubles.
// The authorization server and MCP are our own HTTP on 127.0.0.1 (shaped like the metadata of a real MCP server with OAuth), the
// keychain is a `security` double with a JSON file in a temporary directory. Real services and the real keychain are untouched.
// The connection is declared by the test plugin itself (<agenthub.connection>, contract 2): the core knows nothing about the service.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, curl, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";
import { defaultSys } from "../lib/peer.mjs";
import { denyReason, makeStore, StoreError } from "../lib/services/secrets.mjs";
import { connectorLimits, defFromDeclared, pluginAllowed } from "../lib/services/oauth.mjs";
import { pluginConnections } from "../lib/core.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { discover, OAuthError, parseWwwAuthenticate, pkcePair, startLoopback, urlAllowed, jwtExpMs } from "../lib/oauth.mjs";
import { rateLimitIn, retryAfterMs, sseMessages } from "../lib/mcp-client.mjs";
import { decodeJson, encodeJson, readItemResult, writeItem, writeLine } from "../lib/keychain.mjs";

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";

// ---------- keychain double ----------
function fakeSecurity(dir) {
  const db = join(dir, "keychain.json");
  writeFileSync(db, "{}");
  const p = writePlugin(
    dir,
    "security",
    `#!${process.execPath}
const fs = require("fs");
const db = ${JSON.stringify(db)};
const load = () => JSON.parse(fs.readFileSync(db, "utf8"));
const save = (o) => fs.writeFileSync(db, JSON.stringify(o));
const opt = (a, k) => a[a.indexOf(k) + 1];
const a = process.argv.slice(2);
// argv in full, without cutting after -w: the "values don't end up in argv" check must catch -w too
fs.appendFileSync(db + ".log", a.join(" ") + "\\n");
// keychain failure on test demand: <db>.fail = "find:36" (exit code), "find:hang" (timeout), "delete:36"
const fail = fs.existsSync(db + ".fail") ? fs.readFileSync(db + ".fail", "utf8").trim().split(":") : [];
const op = a[0] === "find-generic-password" ? "find" : a[0] === "delete-generic-password" ? "delete" : a[0] === "-i" ? "write" : "";
if (fail[0] === op && fail[1] === "hang") setTimeout(() => {}, 60_000);
else if (fail[0] === op) process.exit(Number(fail[1]) || 1);
else if (a[0] === "find-generic-password") {
  const v = load()[opt(a, "-s") + "|" + opt(a, "-a")];
  if (v === undefined) process.exit(44);
  process.stdout.write(v + "\\n");
} else if (a[0] === "delete-generic-password") {
  const o = load(); const k = opt(a, "-s") + "|" + opt(a, "-a");
  if (!(k in o)) process.exit(44);
  delete o[k]; save(o);
} else if (a[0] === "-i") {
  let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => {
    let code = 0;
    for (const raw of s.split("\\n").filter(Boolean)) {
      // like the real security -i: a line longer than 4095 chars is cut — the first part runs as a command
      // (with a truncated value), the rest is "unknown command", exit code 1
      for (let i = 0; i < raw.length; i += 4095) {
        const w = raw.slice(i, i + 4095).trim().split(/\\s+/);
        if (w[0] !== "add-generic-password") { code = 1; continue; }
        const o = load(); o[opt(w, "-s") + "|" + opt(w, "-a")] = opt(w, "-w"); save(o);
        fs.appendFileSync(db + ".log", "add " + opt(w, "-s") + " " + opt(w, "-a") + "\\n");
      }
    }
    process.exit(code);
  });
} else process.exit(2);
`,
  );
  return {
    p,
    db,
    read: () => JSON.parse(readFileSync(db, "utf8")),
    write: (o) => writeFileSync(db, JSON.stringify(o)),
    log: () => (existsSync(db + ".log") ? readFileSync(db + ".log", "utf8") : ""),
    fail: (mode) => (mode ? writeFileSync(db + ".fail", mode) : rmSync(db + ".fail", { force: true })),
  };
}

// ---------- MCP server double: metadata, registration, token, MCP ----------
async function fakeMcp(opts = {}) {
  const s = {
    registrations: [],
    codes: new Map(),
    tokens: new Set(),
    refreshTokens: new Set(),
    toolCalls: 0,
    inits: 0,
    mode: "ok", // ok | rate | unauthorized | rate-http | forbidden | tool-error
    tokenLen: 0, // access token length (0 — short); long — like a JWT of several KB
    refreshDown: false, // the token endpoint answers 503 to refresh_token
    expiresIn: 3600,
    issueRefresh: false,
    lastToolArgs: null,
    seq: 0,
    noS256: false,
    ...opts,
  };
  const body = (r) => new Promise((res) => {
    let d = "";
    r.on("data", (c) => (d += c));
    r.on("end", () => res(d));
  });
  const json = (res, status, o, h = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...h });
    res.end(JSON.stringify(o));
  };
  const server = createServer(async (rq, rs) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(rq.url, base);
    const text = await body(rq);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(rs, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"], resource_indicators_supported: true });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(rs, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: s.issueRefresh ? ["authorization_code", "refresh_token"] : ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: s.noS256 ? ["plain"] : ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === "/oauth/register" && rq.method === "POST") {
      const o = JSON.parse(text);
      s.registrations.push(o);
      return json(rs, 200, { client_id: `client-${s.registrations.length}`, redirect_uris: o.redirect_uris, token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/oauth/token" && rq.method === "POST") {
      const f = new URLSearchParams(text);
      s.lastTokenForm = Object.fromEntries(f);
      if (f.get("grant_type") === "authorization_code") {
        const c = s.codes.get(f.get("code"));
        s.codes.delete(f.get("code"));
        const challenge = c && createHash("sha256").update(f.get("code_verifier") || "").digest("base64url");
        if (!c || challenge !== c.challenge || f.get("client_id") !== c.clientId || f.get("redirect_uri") !== c.redirectUri || f.get("resource") !== `${base}/mcp`) return json(rs, 400, { error: "invalid_grant" });
      } else if (f.get("grant_type") === "refresh_token") {
        if (s.refreshDown) return json(rs, 503, { error: "temporarily_unavailable" });
        if (!s.refreshTokens.has(f.get("refresh_token"))) return json(rs, 400, { error: "invalid_grant" });
        s.refreshTokens.delete(f.get("refresh_token"));
        s.refreshed = (s.refreshed || 0) + 1;
      } else return json(rs, 400, { error: "unsupported_grant_type" });
      const at0 = `fake-access-${++s.seq}-SECRETVALUE`;
      const at = s.tokenLen > at0.length ? at0 + "x".repeat(s.tokenLen - at0.length) : at0;
      s.tokens.add(at);
      const out = { access_token: at, token_type: "Bearer", expires_in: s.expiresIn, scope: "read" };
      if (s.issueRefresh) {
        out.refresh_token = `fake-refresh-${s.seq}-SECRETVALUE`;
        s.refreshTokens.add(out.refresh_token);
      }
      return json(rs, 200, out);
    }
    if (url.pathname === "/mcp" && rq.method === "POST") {
      const auth = String(rq.headers.authorization || "");
      const tok = auth.replace(/^Bearer /, "");
      if (s.mode === "forbidden" && s.tokens.has(tok))
        return json(rs, 403, { error: "insufficient_scope" }, { "www-authenticate": `Bearer realm="MCP Server", error="insufficient_scope", scope="read write"` });
      if (!s.tokens.has(tok) || s.mode === "unauthorized")
        return json(rs, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer realm="MCP Server", error="invalid_token", error_description="Bearer token required", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      const m = JSON.parse(text);
      if (m.method === "initialize") {
        s.inits++;
        return json(rs, 200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } } }, { "mcp-session-id": `sess-${s.inits}` });
      }
      if (m.method === "notifications/initialized") {
        rs.writeHead(202);
        return rs.end();
      }
      if (m.method === "tools/call") {
        if (rq.headers["mcp-session-id"] !== `sess-${s.inits}`) return json(rs, 404, { error: "no session" });
        s.toolCalls++;
        s.lastToolArgs = m.params;
        if (s.mode === "rate") return json(rs, 200, { jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: '{"error":"RATE_LIMIT_EXCEEDED","retryAfter":120}' }] } });
        if (s.mode === "rate-http") return json(rs, 429, { error: "too many" }, { "retry-after": "90" });
        if (s.mode === "tool-error") return json(rs, 200, { jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "Error: workspace_id required\nwhen you belong to several workspaces" }] } });
        const payload = { tasks: [{ id: "abc1", name: "Первый тикет", url: "https://tasks.example.com/t/abc1", status: { status: "in progress", color: "#ff00aa" } }], has_more: false };
        // SSE stream response — the way a Streamable HTTP server may answer
        rs.writeHead(200, { "content-type": "text/event-stream" });
        return rs.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } })}\n\n`);
      }
      return json(rs, 200, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    }
    if (url.pathname === "/mcp") return json(rs, 401, {}, { "www-authenticate": `Bearer realm="MCP Server", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    json(rs, 404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // "browser": the user approved access on the authorize page → the code goes to redirect_uri
  s.approve = (authorizeUrl) => {
    const u = new URL(authorizeUrl);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    s.codes.set(code, { challenge: u.searchParams.get("code_challenge"), clientId: u.searchParams.get("client_id"), redirectUri: u.searchParams.get("redirect_uri") });
    return { code, state: u.searchParams.get("state"), redirect: u.searchParams.get("redirect_uri"), iss: base };
  };
  return { s, base, server, close: () => new Promise((r) => server.close(r)) };
}

function get(url) {
  return new Promise((resolve) => {
    const r = request(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.code }));
    r.end();
  });
}

// The test process is the "app" (class app via the signature double), other processes as is (the plugin is cli).
function appSelfSys() {
  const real = defaultSys();
  return {
    ...real,
    pidPath: (pid) => (pid === process.pid ? APP : real.pidPath(pid)),
    codeInfo: null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => (p === APP ? "app|id" : real.fileId(p)),
    readJson: () => {
      throw new Error("ENOENT");
    },
    writeJson: () => {},
  };
}

// Client plugin: declares a connection (<agenthub.connection>, contract 2), calls POST /connections/<id>/mcp via
// AGENTHUB_HUB_SOCKET and prints only a summary (no token).
function mcpPlugin(dir, { id = "tix", net = "mcp.example.com — тикеты через хаб", url = "https://mcp.example.com/mcp" } = {}) {
  return writePlugin(
    dir,
    `${id}.1h.mjs`,
    `#!/usr/bin/env node
// <agenthub.title>Tix</agenthub.title>
${net ? `// <agenthub.net>${net}</agenthub.net>` : ""}
// <agenthub.connection id="${id}" type="mcp" url="${url}" scope="read" title="Tix" tools="get_user,filter_tasks,get_task" interval="15m" budget="100">тикеты, назначенные вам</agenthub.connection>
// <agenthub.connection lang="en" id="${id}" title="Tix">tickets assigned to you</agenthub.connection>
import { request } from "node:http";
const sock = process.env.AGENTHUB_HUB_SOCKET;
if (!sock) { console.log("no-socket | status=unknown"); process.exit(0); }
const data = JSON.stringify({ tool: "filter_tasks", args: { assignees: ["me"], include_closed: false } });
const r = request({ socketPath: sock, path: "/connections/${id}/mcp", method: "POST", headers: { Host: "hub", "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
  let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => {
    let o = {}; try { o = JSON.parse(s); } catch {}
    let n = "-"; try { n = JSON.parse(o.result.content[0].text).tasks.length; } catch {}
    console.log(\`http=\${res.statusCode} err=\${o.error || "none"} ok=\${o.ok} n=\${n} why=\${o.why || "-"} fresh=\${o.fresh} pending=\${Boolean(o.pending)} | status=ok\`);
  });
});
r.on("error", (e) => console.log("conn-error " + e.code));
r.end(data);
`,
  );
}

const header = (h, id) => h.core.pluginState(id)?.header?.[0]?.title || "";

// ---------- modules ----------
test("PKCE S256, state, WWW-Authenticate parsing, URL checks", () => {
  const p = pkcePair();
  assert.equal(p.method, "S256");
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.challenge, createHash("sha256").update(p.verifier).digest("base64url"));
  const w = parseWwwAuthenticate('Bearer realm="MCP Server", error="invalid_token", error_description="Bearer token required", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"');
  assert.equal(w.scheme, "bearer");
  assert.equal(w.params.error, "invalid_token");
  assert.equal(w.params.resource_metadata, "https://mcp.example.com/.well-known/oauth-protected-resource/mcp");
  const hosts = ["mcp.example.com"];
  assert.equal(urlAllowed("https://mcp.example.com/oauth/token", { hosts }), true);
  assert.equal(urlAllowed("http://mcp.example.com/oauth/token", { hosts }), false, "https only");
  assert.equal(urlAllowed("https://evil.example/oauth/token", { hosts }), false);
  assert.equal(urlAllowed("https://mcp.example.com:8443/x", { hosts }), false);
  assert.equal(urlAllowed("https://user:pw@mcp.example.com/x", { hosts }), false);
  assert.equal(urlAllowed("http://127.0.0.1:5000/x", { hosts }), false, "loopback only in test mode");
  assert.equal(urlAllowed("http://127.0.0.1:5000/x", { hosts, loopback: true }), true);
  const jwt = `x.${Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url")}.y`;
  assert.equal(jwtExpMs(jwt), 2000000000 * 1000);
  assert.deepEqual(decodeJson(encodeJson({ a: "б\"c" })), { a: "б\"c" });
  assert.match(encodeJson({ a: 1 }), /^[A-Za-z0-9_-]+$/, "goes to security -i without quotes or spaces");
});

test("MCP limit: RATE_LIMIT_EXCEEDED and retryAfter (seconds, ms, epoch), SSE", () => {
  const now = 1_800_000_000_000;
  assert.equal(rateLimitIn("all good", now), null);
  assert.deepEqual(rateLimitIn('{"error":"RATE_LIMIT_EXCEEDED","retryAfter":120}', now), { retryAfterMs: 120_000 });
  assert.deepEqual(rateLimitIn('{"code":"RATE_LIMIT_EXCEEDED"}', now), { retryAfterMs: null });
  assert.equal(retryAfterMs(3_600_000, now), 3_600_000, "milliseconds");
  assert.equal(retryAfterMs(now / 1000 + 600, now), 600_000, "epoch seconds");
  assert.equal(retryAfterMs(now + 300_000, now), 300_000, "epoch ms");
  assert.equal(retryAfterMs(5, now), 60_000, "at least a minute");
  assert.equal(retryAfterMs(999_999_999, now), 24 * 3600_000, "at most a day");
  assert.deepEqual(sseMessages('event: message\ndata: {"id":1}\n\n: ping\n\ndata: {"id":2}\n\n'), [{ id: 1 }, { id: 2 }]);
});

test("secrets service: oauth entries are never handed to plugins", () => {
  assert.equal(denyReason({ source: "builtin", id: "x" }, "oauth.tix.token"), "reserved");
  assert.equal(denyReason({ source: "installed", id: "oauth" }, "oauth.tix.token"), "reserved", "not even to a plugin with id oauth");
  assert.equal(denyReason({ source: "installed", id: "tix" }, "tix.token"), null, "a personal token works as before");
});

test("server discovery: metadata via WWW-Authenticate; without S256 or with a foreign resource — refused", async () => {
  const f = await fakeMcp();
  try {
    const m = await discover(`${f.base}/mcp`, { hosts: [], loopback: true });
    assert.equal(m.issuer, f.base);
    assert.equal(m.tokenEndpoint, `${f.base}/oauth/token`);
    assert.deepEqual(m.grantTypes, ["authorization_code"]);
    assert.equal(m.issParam, true);
    assert.deepEqual(m.scopes, ["read", "write"]);
    await assert.rejects(discover(`${f.base}/mcp`, { hosts: [] }), (e) => e instanceof OAuthError && e.reason === "resource-url", "loopback is not accepted in live mode");
    await assert.rejects(discover(`${f.base}/other`, { hosts: [], loopback: true }), (e) => e.code === "discovery");
    f.s.noS256 = true;
    await assert.rejects(discover(`${f.base}/mcp`, { hosts: [], loopback: true }), (e) => e.reason === "no-s256");
  } finally {
    await f.close();
  }
});

test("code receiver: 127.0.0.1 only, foreign state rejected, single receipt, iss checked, expiry", async () => {
  const lb = await startLoopback({ state: "S1", issuer: "http://iss", requireIss: true, timeoutMs: 5000, page: (k) => k });
  assert.match(lb.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  assert.equal((await get(`${lb.redirectUri}?code=x&state=WRONG&iss=http://iss`)).status, 400);
  assert.equal((await get(`http://127.0.0.1:${lb.port}/other`)).status, 404);
  assert.equal((await get(`${lb.redirectUri}?code=c1&state=S1&iss=http://iss`)).text, "ok");
  assert.deepEqual((await lb.result).code, "c1");
  // a second receipt is not accepted: the browser connection is still alive — 410, a new one — connection refused
  assert.ok([0, 410].includes((await get(`${lb.redirectUri}?code=c2&state=S1&iss=http://iss`)).status), "single receipt");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await get(`${lb.redirectUri}?code=c3&state=S1&iss=http://iss`)).status, 0, "the port is closed after receipt");

  const lb2 = await startLoopback({ state: "S2", issuer: "http://iss", requireIss: true, timeoutMs: 5000, page: (k, c) => `${k}:${c}` });
  assert.equal((await get(`${lb2.redirectUri}?code=c&state=S2`)).text, "error:iss-mismatch", "the server declared iss — not accepted without it");
  await assert.rejects(lb2.result, (e) => e.code === "iss-mismatch");

  const lb3 = await startLoopback({ state: "S3", timeoutMs: 5000, page: (k, c) => `${k}:${c}` });
  assert.equal((await get(`${lb3.redirectUri}?error=access_denied&state=S3`)).text, "error:denied");
  await assert.rejects(lb3.result, (e) => e.code === "denied");

  const lb4 = await startLoopback({ state: "S4", timeoutMs: 100, page: () => "" });
  await assert.rejects(lb4.result, (e) => e.code === "timeout");
});

// ---------- the whole service ----------
async function hubWith({ f, plugins, extraOauth = {} }) {
  const bin = tempHome("ah-ksec-");
  const sec = fakeSecurity(bin);
  const h = await startHub({
    pluginsDir: plugins,
    services: "oauth,secrets",
    sys: appSelfSys(),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      services: { secrets: { securityPath: sec.p }, oauth: { tix: { resource: `${f.base}/mcp`, hosts: [], intervalMs: 300, callWaitMs: 3000, loginTimeoutMs: 10_000, ...extraOauth } } },
    },
  });
  return { h, sec, bin };
}

function noSecrets(h, sec) {
  const journal = readFileSync(h.config.paths.journal, "utf8");
  for (const leak of ["SECRETVALUE", "code-", "fake-refresh"]) assert.doesNotMatch(journal, new RegExp(leak), `log without ${leak}`);
  assert.doesNotMatch(sec.log(), /SECRETVALUE|base64|eyJ/, "values don't end up in security argv");
}

test(`plugin connection: login, MCP calls on behalf of the plugin with an interval, limit, expiry, re-login, "Disconnect"`, async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins });
  const events = [];
  h.core.on("event", (e) => events.push(JSON.stringify(e)));
  try {
    // before login: state in /state, the plugin gets 409 not-connected
    const st0 = await waitFor(async () => {
      const r = await req(h.sock, "GET", "/connections");
      return r.body?.connections?.[0]?.state === "disconnected" ? r.body.connections[0] : null;
    });
    assert.equal(st0.plugin, "tix");
    assert.equal(st0.title, "Tix");
    assert.deepEqual(st0.tools, ["get_user", "filter_tasks", "get_task"]);
    assert.equal(st0.intervalMs, 300);
    assert.match(await waitFor(() => header(h, "tix").includes("http=") && header(h, "tix")), /http=409 err=oauth:not-connected/);
    assert.equal((await req(h.sock, "GET", "/state")).body.connections[0].state, "disconnected");

    // cli can't start a login or disconnect, and a non-plugin can't call MCP
    assert.equal((await curl(h.sock, "POST", "/connections/tix/connect")).status, 403);
    assert.equal((await curl(h.sock, "POST", "/connections/tix/disconnect")).status, 403);
    const nonPlugin = await curl(h.sock, "POST", "/connections/tix/mcp", { tool: "filter_tasks" });
    assert.equal(nonPlugin.status, 403);
    assert.equal(nonPlugin.body.error, "mcp:not-a-plugin");
    assert.equal((await req(h.sock, "POST", "/connections/nope/connect")).status, 404);

    // login
    const c1 = await req(h.sock, "POST", "/connections/tix/connect");
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    assert.equal(c1.body.connection.state, "connecting");
    const au = new URL(c1.body.authorizeUrl);
    assert.equal(`${au.origin}${au.pathname}`, `${f.base}/oauth/authorize`);
    assert.equal(au.searchParams.get("code_challenge_method"), "S256");
    assert.equal(au.searchParams.get("scope"), "read");
    assert.equal(au.searchParams.get("resource"), `${f.base}/mcp`);
    assert.match(au.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    assert.equal(f.s.registrations.length, 1);
    const reg = f.s.registrations[0];
    assert.equal(reg.token_endpoint_auth_method, "none");
    assert.deepEqual(reg.grant_types, ["authorization_code"], "refresh_token not declared by the server — we don't ask for it");
    assert.deepEqual(reg.redirect_uris, [au.searchParams.get("redirect_uri")]);
    // a foreign state is not accepted, the login keeps waiting
    const a = f.s.approve(c1.body.authorizeUrl);
    assert.equal((await get(`${a.redirect}?code=${a.code}&state=forged&iss=${encodeURIComponent(a.iss)}`)).status, 400);
    const page = await get(`${a.redirect}?code=${a.code}&state=${a.state}&iss=${encodeURIComponent(a.iss)}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Tix подключён к Agent Hub/);
    const st1 = (await req(h.sock, "GET", "/connections")).body.connections[0];
    assert.equal(st1.state, "connected");
    assert.equal(st1.scope, "read");
    assert.equal(st1.refresh, false);
    assert.ok(st1.expiresAt);
    // token and registration — only in the keychain (double), as base64url JSON
    const kc = sec.read();
    assert.deepEqual(Object.keys(kc).sort(), ["agent-hub.oauth|tix.client", "agent-hub.oauth|tix.token"]);
    assert.match(decodeJson(kc["agent-hub.oauth|tix.token"]).accessToken, /^fake-access-1/);
    assert.equal(decodeJson(kc["agent-hub.oauth|tix.client"]).clientId, "client-1");

    // the plugin gets the result; a second run within the interval comes from service memory, without calling the service.
    // The connect itself reruns the plugin, so its result is awaited here instead of a manual refresh: a manual refresh
    // would race that rerun and, landing within the interval, read the cached answer (fresh=false).
    const out = await waitFor(() => /http=200/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 });
    assert.match(out, /ok=true n=1 why=interval fresh=true/);
    assert.equal(f.s.toolCalls, 1);
    assert.deepEqual(f.s.lastToolArgs, { name: "filter_tasks", arguments: { assignees: ["me"], include_closed: false } });
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /fresh=false/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /ok=true n=1 why=interval/);
    assert.equal(f.s.toolCalls, 1, "within the interval — from service memory");

    // limit: interval passed → call → RATE_LIMIT_EXCEEDED, retryAfter 120 s → backoff, reason in the reply
    await new Promise((r) => setTimeout(r, 350));
    f.s.mode = "rate";
    h.core.host.refresh("tix", "Manual");
    const rl = await waitFor(() => /why=rate-limit/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 });
    assert.match(rl, /ok=true n=1/, "the previous result stays");
    const st2 = (await req(h.sock, "GET", "/connections")).body.connections[0];
    assert.equal(st2.why, "rate-limit");
    const wait = Date.parse(st2.nextAt) - Date.now();
    assert.ok(wait > 100_000 && wait <= 121_000, `expected ~120 s, got ${wait}`);
    const calls = f.s.toolCalls;
    h.core.host.refresh("tix", "Manual");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(f.s.toolCalls, calls, "the service isn't called during backoff");
    const persisted = JSON.parse(readFileSync(join(h.config.paths.pluginCache, "oauth-tix.json"), "utf8"));
    assert.equal(persisted.backoff.reason, "rate-limit");
    assert.doesNotMatch(JSON.stringify(persisted), /SECRETVALUE|Первый/, "the service file holds only timestamps");

    // revocation: 401 → expired (no refresh token), the plugin gets 409 oauth:expired
    const conn = h.core.facts.get("oauth.api").get("tix");
    conn.persist.backoff = null;
    conn.cache.clear();
    f.s.mode = "unauthorized";
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /oauth:expired/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /http=409/);
    assert.equal((await req(h.sock, "GET", "/connections")).body.connections[0].state, "expired");

    // re-login: same client and same port (the port is free) — no new registration
    f.s.mode = "ok";
    const c2 = await req(h.sock, "POST", "/connections/tix/connect");
    assert.equal(c2.status, 200);
    assert.equal(new URL(c2.body.authorizeUrl).searchParams.get("redirect_uri"), au.searchParams.get("redirect_uri"));
    assert.equal(f.s.registrations.length, 1);
    // "Cancel" restores the previous state
    assert.equal((await req(h.sock, "POST", "/connections/tix/cancel")).body.connection.state, "expired");
    const c3 = await req(h.sock, "POST", "/connections/tix/connect");
    const a3 = f.s.approve(c3.body.authorizeUrl);
    assert.equal((await get(`${a3.redirect}?code=${a3.code}&state=${a3.state}&iss=${encodeURIComponent(a3.iss)}`)).status, 200);
    assert.equal((await req(h.sock, "GET", "/connections")).body.connections[0].state, "connected");
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /http=200 err=none ok=true/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /n=1/);

    // "Disconnect" — both entries deleted, state disconnected, the plugin gets 409 again
    const d = await req(h.sock, "POST", "/connections/tix/disconnect");
    assert.equal(d.status, 200);
    assert.equal(d.body.connection.state, "disconnected");
    assert.deepEqual(sec.read(), {});
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /not-connected/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /http=409/);

    noSecrets(h, sec);
    assert.doesNotMatch(events.join("\n"), /SECRETVALUE|code_verifier|fake-refresh/, "bus and SSE carry no tokens");
    assert.ok(events.some((e) => e.includes('"connections.changed"')));
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("token refresh: with a refresh token we refresh quietly; invalid_grant — expired", async () => {
  const f = await fakeMcp({ issueRefresh: true, expiresIn: 30 }); // expiry < a minute — refresh before the call
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body?.connections?.[0]?.state === "disconnected");
    const c = await req(h.sock, "POST", "/connections/tix/connect");
    assert.deepEqual(f.s.registrations[0].grant_types, ["authorization_code", "refresh_token"]);
    const a = f.s.approve(c.body.authorizeUrl);
    await get(`${a.redirect}?code=${a.code}&state=${a.state}&iss=${encodeURIComponent(a.iss)}`);
    assert.equal((await req(h.sock, "GET", "/connections")).body.connections[0].refresh, true);
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /http=200/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /ok=true n=1/);
    assert.equal(f.s.refreshed, 1, "an expiring token is refreshed before the call");
    assert.equal(f.s.lastTokenForm.resource, `${f.base}/mcp`);
    // rotation: a new refresh token in the keychain
    assert.match(decodeJson(sec.read()["agent-hub.oauth|tix.token"]).refreshToken, /^fake-refresh-2/);
    // refresh token revoked → expired
    f.s.refreshTokens.clear();
    const conn = h.core.facts.get("oauth.api").get("tix");
    conn.cache.clear();
    await new Promise((r) => setTimeout(r, 350));
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /oauth:expired/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /http=409/);
    assert.equal((await req(h.sock, "GET", "/connections")).body.connections[0].state, "expired");
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("MCP call: only the plugin that declared the connection, with network access to its host, and a tool from the allowlist; 429 → backoff", async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins, { id: "nonet", net: null });
  writePlugin(
    plugins,
    "badtool.1h.mjs",
    `#!/usr/bin/env node
// <agenthub.net>mcp.example.com — тест</agenthub.net>
import { request } from "node:http";
const data = JSON.stringify({ tool: "create_task", args: { name: "x" } });
const r = request({ socketPath: process.env.AGENTHUB_HUB_SOCKET, path: "/connections/tix/mcp", method: "POST", headers: { Host: "hub", "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => { let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => console.log("http=" + res.statusCode + " " + s.slice(0, 60).replace(/[|]/g, "/"))); });
r.end(data);
`,
  );
  mcpPlugin(plugins, { id: "tix" });
  const { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body?.connections?.[0]?.state === "disconnected");
    const c = await req(h.sock, "POST", "/connections/tix/connect");
    const a = f.s.approve(c.body.authorizeUrl);
    await get(`${a.redirect}?code=${a.code}&state=${a.state}&iss=${encodeURIComponent(a.iss)}`);
    for (const id of ["nonet", "badtool"]) h.core.host.refresh(id, "Manual");
    // the core doesn't accept a connection without its host in <agenthub.net> at all: it's not listed, a call gives 404
    assert.match(await waitFor(() => /http=404/.test(header(h, "nonet")) && header(h, "nonet"), { timeoutMs: 8000 }), /not-found/);
    assert.ok(h.core.journal.tail(200).some((e) => e.type === "connection-rejected" && e.plugin === "nonet" && e.why === "net"));
    assert.deepEqual((await req(h.sock, "GET", "/connections")).body.connections.map((x) => x.id), ["tix"]);
    // another plugin with the same network doesn't get to use another plugin's connection
    assert.match(await waitFor(() => /http=403/.test(header(h, "badtool")) && header(h, "badtool"), { timeoutMs: 8000 }), /mcp:not-owner/);
    // the own plugin — only tools from the declared allowlist
    const conn = h.core.facts.get("oauth.api").get("tix");
    assert.deepEqual(await conn.call({ id: "tix" }, "create_task", { name: "x" }), { status: 403, body: { error: "mcp:tool-not-allowed" } });
    f.s.mode = "rate-http";
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /http=200/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /ok=false .*why=rate-limit/);
    const st = (await req(h.sock, "GET", "/connections")).body.connections[0];
    const wait = Date.parse(st.nextAt) - Date.now();
    assert.ok(wait > 60_000 && wait <= 91_000, `Retry-After 90 s, got ${wait}`);
    assert.equal(st.calls24h, 1);
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("no keychain (test mode without a double): the connection is unavailable, login doesn't start", async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const h = await startHub({
    pluginsDir: plugins,
    services: "oauth,secrets",
    sys: appSelfSys(),
    overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' }, services: { oauth: { tix: { resource: `${f.base}/mcp`, hosts: [] } } } },
  });
  try {
    const st = await waitFor(async () => (await req(h.sock, "GET", "/connections")).body?.connections?.[0]);
    assert.equal(st.state, "unavailable");
    assert.equal(st.keychain, false);
    const r = await req(h.sock, "POST", "/connections/tix/connect");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "oauth:no-keychain");
    assert.equal(f.s.registrations.length, 0);
  } finally {
    await h.stop();
    await f.close();
    cleanup(plugins);
  }
});

test("daily budget: after dailyBudget − 4 calls in 24 h the service waits, reason budget; the counter is on disk", async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins, extraOauth: { dailyBudget: 5 } }); // limit — 1 call per day
  try {
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body?.connections?.[0]?.state === "disconnected");
    const c = await req(h.sock, "POST", "/connections/tix/connect");
    const a = f.s.approve(c.body.authorizeUrl);
    await get(`${a.redirect}?code=${a.code}&state=${a.state}&iss=${encodeURIComponent(a.iss)}`);
    // the connect itself reruns the plugin; its result is awaited (a manual refresh here would race it and read the cache).
    // The very first call exhausted the budget: the reply is fresh, but the next one is in a day, reason budget
    assert.match(await waitFor(() => /http=200 err=none ok=true/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /why=budget fresh=true/);
    await new Promise((r) => setTimeout(r, 350)); // interval passed
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /fresh=false/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /ok=true n=1 why=budget fresh=false/);
    assert.equal(f.s.toolCalls, 1);
    const st = (await req(h.sock, "GET", "/connections")).body.connections[0];
    assert.equal(st.why, "budget");
    assert.equal(st.calls24h, 1);
    assert.ok(Date.parse(st.nextAt) - Date.now() > 23 * 3600_000);
    const persisted = JSON.parse(readFileSync(join(h.config.paths.pluginCache, "oauth-tix.json"), "utf8"));
    assert.equal(persisted.calls.length, 1, "the call mark is saved to disk");
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

// ---------- review 2026-11-09: long values, keychain failures, 403, tool errors, refresh, "Disconnect" ----------
async function login(h, f) {
  const c = await req(h.sock, "POST", "/connections/tix/connect");
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const a = f.s.approve(c.body.authorizeUrl);
  const page = await get(`${a.redirect}?code=${a.code}&state=${a.state}&iss=${encodeURIComponent(a.iss)}`);
  assert.equal(page.status, 200);
  return (await req(h.sock, "GET", "/connections")).body.connections[0];
}
const conn0 = async (h) => (await req(h.sock, "GET", "/connections")).body.connections[0];

test("keychain: security -i line ≤ 4095 — a long value isn't written as one line; storage splits it into parts", async () => {
  const dir = tempHome("ah-kclong-");
  const sec = fakeSecurity(dir);
  try {
    // without calling security: a truncated value would overwrite the previous entry
    sec.write({ "agent-hub.oauth|tix.token": "OLDVALUE" });
    const r = await writeItem(sec.p, "agent-hub.oauth", "tix.token", "B".repeat(4100));
    assert.deepEqual(r, { ok: false, error: "too-large" });
    assert.equal(sec.read()["agent-hub.oauth|tix.token"], "OLDVALUE", "the previous entry is intact");
    assert.equal(sec.log(), "", "security was not called");
    // exactly at the line limit: command prefix + value = 4095 — passes
    const prefix = writeLine("agent-hub.oauth", "tix.token", "").length;
    assert.deepEqual(await writeItem(sec.p, "agent-hub.oauth", "tix.token", "C".repeat(4095 - prefix)), { ok: true });
    assert.equal(sec.read()["agent-hub.oauth|tix.token"].length, 4095 - prefix);

    // storage: a ~8 KB token (a JWT of several KB) → parts + header; reading assembles the same value
    const journal = [];
    const store = makeStore({ journal: { write: (e) => journal.push(e) } }, sec.p, 5000);
    const big = { accessToken: `${"j".repeat(8000)}-SECRETVALUE`, refreshToken: null, expiresAt: 1, scope: "read", obtainedAt: 1 };
    assert.equal((await store.set("tix.token", big)).ok, true);
    const kc = sec.read();
    assert.match(kc["agent-hub.oauth|tix.token"], /^parts_a_\d+_/);
    assert.ok(kc["agent-hub.oauth|tix.token.a1"] && kc["agent-hub.oauth|tix.token.a3"]);
    assert.deepEqual(await store.get("tix.token"), big);
    // overwrite: a new generation (b), parts of the previous one (a) deleted; a short value — one entry, parts removed
    const big2 = { ...big, accessToken: `${"k".repeat(6000)}-SECRETVALUE` };
    assert.equal((await store.set("tix.token", big2)).ok, true);
    assert.match(sec.read()["agent-hub.oauth|tix.token"], /^parts_b_/);
    assert.ok(!Object.keys(sec.read()).some((k) => k.endsWith(".a1")), "parts of the previous generation are deleted");
    assert.deepEqual(await store.get("tix.token"), big2);
    assert.equal((await store.set("tix.token", { accessToken: "short" })).ok, true);
    assert.deepEqual(Object.keys(sec.read()), ["agent-hub.oauth|tix.token"]);
    assert.deepEqual(await store.get("tix.token"), { accessToken: "short" });
    // "Disconnect" deletes both the header and the parts
    await store.set("tix.token", big);
    assert.equal((await store.delete("tix.token")).ok, true);
    assert.deepEqual(sec.read(), {});
    assert.doesNotMatch(JSON.stringify(journal), /SECRETVALUE|jjjj/, "the log gets only the entry name and the outcome");
    assert.doesNotMatch(sec.log(), /SECRETVALUE|jjjj|eyJ/, "values don't end up in security argv");
  } finally {
    cleanup(dir);
  }
});

test(`keychain: writeItem with a keychain path — only an existing file (otherwise security -i writes to login); a read failure ≠ "no entry"`, async () => {
  const dir = tempHome("ah-kcpath-");
  const sec = fakeSecurity(dir);
  try {
    const r = await writeItem(sec.p, "agent-hub.oauth", "tix.token", "abc", { keychain: join(dir, "nonexistent.keychain-db") });
    assert.deepEqual(r, { ok: false, error: "no-keychain-file" });
    assert.equal(sec.log(), "", "security was not called");
    // read: code 44 — missing, another code or a timeout — error
    assert.deepEqual(await readItemResult(sec.p, "agent-hub.oauth", "tix.token"), { missing: true });
    sec.fail("find:36");
    assert.deepEqual(await readItemResult(sec.p, "agent-hub.oauth", "tix.token"), { error: "exit-36" });
    sec.fail("find:hang");
    assert.deepEqual(await readItemResult(sec.p, "agent-hub.oauth", "tix.token", { timeoutMs: 300 }), { error: "timeout" });
    const store = makeStore({ journal: { write() {} } }, sec.p, 300);
    await assert.rejects(store.get("tix.token"), (e) => e instanceof StoreError && e.code === "timeout");
  } finally {
    cleanup(dir);
  }
});

test(`keychain failure: at startup — not "not connected" but re-read; during a call — not expired and no failure mark`, async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const bin = tempHome("ah-ksec-");
  const sec = fakeSecurity(bin);
  // a login already happened: the token is in the keychain, the server knows it
  const tok = "fake-access-pre-SECRETVALUE";
  f.s.tokens.add(tok);
  sec.write({ "agent-hub.oauth|tix.token": encodeJson({ accessToken: tok, refreshToken: null, expiresAt: Date.now() + 3600_000, scope: "read", obtainedAt: Date.now() }) });
  sec.fail("find:36"); // the keychain is locked at startup
  const h = await startHub({
    pluginsDir: plugins,
    services: "oauth,secrets",
    sys: appSelfSys(),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      services: { secrets: { securityPath: sec.p, timeoutMs: 500 }, oauth: { tix: { resource: `${f.base}/mcp`, hosts: [], intervalMs: 300, callWaitMs: 3000, reloadMs: 300 } } },
    },
  });
  try {
    const st0 = await waitFor(async () => {
      const c = await conn0(h);
      return c?.error === "keychain-read" ? c : null;
    });
    assert.equal(st0.state, "unknown", "a temporary keychain failure is not disconnected");
    assert.match(await waitFor(() => header(h, "tix").includes("http=") && header(h, "tix"), { timeoutMs: 8000 }), /http=200 err=oauth:keychain-read/);
    // the keychain came back — the service re-read it by itself, without restarting the daemon
    sec.fail(null);
    const st1 = await waitFor(async () => {
      const c = await conn0(h);
      return c?.state === "connected" ? c : null;
    }, { timeoutMs: 8000 });
    assert.equal(st1.error, null);
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /http=200 err=none ok=true/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /n=1/);

    // failure during a call: backoff error, state connected, no login-failure mark on disk
    await new Promise((r) => setTimeout(r, 350));
    sec.fail("find:hang");
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /err=oauth:keychain-read/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /http=200 err=oauth:keychain-read ok=true n=1 why=error/);
    const st2 = await conn0(h);
    assert.equal(st2.state, "connected");
    assert.equal(st2.why, "error");
    const persisted = JSON.parse(readFileSync(join(h.config.paths.pluginCache, "oauth-tix.json"), "utf8"));
    assert.equal(persisted.authFailedAt, null, "no \"expired\" after a restart");
    sec.fail(null);
    noSecrets(h, sec);
  } finally {
    sec.fail(null);
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test(`403 insufficient_scope is not "login expired": mcp:forbidden, one-hour backoff; a tool error is not a successful refresh`, async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await conn0(h))?.state === "disconnected");
    await login(h, f);
    f.s.mode = "forbidden";
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /http=200/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /err=mcp:forbidden ok=false .*why=forbidden/);
    const st = await conn0(h);
    assert.equal(st.state, "connected", "not expired: re-login with the same scope won't help");
    assert.equal(st.error, "forbidden");
    assert.equal(st.errorReason, "insufficient_scope");
    assert.ok(Date.parse(st.nextAt) - Date.now() > 50 * 60_000, "backoff is an hour");

    // tool error: the service text reaches the plugin, lastOkAt is not set, reason tool-error
    const conn = h.core.facts.get("oauth.api").get("tix");
    conn.persist.backoff = null;
    f.s.mode = "tool-error";
    const r = await conn.call({ id: "tix" }, "filter_tasks", { assignees: ["me"], include_closed: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "mcp:tool-error");
    assert.equal(r.body.errorText, "Error: workspace_id required when you belong to several workspaces");
    assert.equal(r.body.why, "tool-error");
    const st2 = await conn0(h);
    assert.equal(st2.lastOkAt, null, "isError is not \"updated\"");
    assert.equal(st2.why, "tool-error");
    // a repeated request during backoff — the same error text from service memory, the service isn't called
    const calls = f.s.toolCalls;
    const r2 = await conn.call({ id: "tix" }, "filter_tasks", { assignees: ["me"], include_closed: false });
    assert.equal(r2.body.errorText, r.body.errorText);
    assert.equal(f.s.toolCalls, calls);
    // the service answers again: error and forbidden are cleared
    conn.persist.backoff = null;
    f.s.mode = "ok";
    const r3 = await conn.call({ id: "tix" }, "filter_tasks", { assignees: ["me"], include_closed: false });
    assert.equal(r3.body.ok, true);
    assert.equal(r3.body.error, undefined);
    assert.equal((await conn0(h)).error, null);
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("token refresh: a network failure or 5xx is not expired, the refresh token is intact; a long login token is stored in parts", async () => {
  const f = await fakeMcp({ issueRefresh: true, expiresIn: 3600, tokenLen: 6000 });
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await conn0(h))?.state === "disconnected");
    const st = await login(h, f);
    assert.equal(st.state, "connected", "the long token is written (previously truncated with exit 1)");
    assert.match(sec.read()["agent-hub.oauth|tix.token"], /^parts_/);
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /http=200/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /err=none ok=true n=1/);
    // 401 → refresh → 503 from the authorization server: the login is intact, backoff error
    await new Promise((r) => setTimeout(r, 350));
    f.s.refreshDown = true;
    f.s.mode = "unauthorized";
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /err=oauth:refresh/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /http=200 .*why=error/);
    const st2 = await conn0(h);
    assert.equal(st2.state, "connected");
    assert.equal(f.s.refreshTokens.size, 1, "the refresh token is not consumed");
    // the server came back — quiet refresh
    f.s.refreshDown = false;
    f.s.mode = "ok";
    const conn = h.core.facts.get("oauth.api").get("tix");
    conn.persist.backoff = null;
    conn.cache.clear();
    conn.session.reset();
    f.s.tokens.clear(); // the old access token was revoked: 401 → refresh
    h.core.host.refresh("tix", "Manual");
    assert.match(await waitFor(() => /err=none ok=true/.test(header(h, "tix")) && header(h, "tix"), { timeoutMs: 8000 }), /fresh=true/);
    assert.equal(f.s.refreshed, 1);
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test(`"Disconnect" with a deletion failure: state unchanged, error keychain-delete; the discovery reason goes to errorReason`, async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await conn0(h))?.state === "disconnected");
    await login(h, f);
    sec.fail("delete:36");
    const d = await req(h.sock, "POST", "/connections/tix/disconnect");
    assert.equal(d.status, 500);
    assert.equal(d.body.error, "oauth:keychain-delete");
    assert.equal(d.body.connection.state, "connected", "the login stayed in the keychain — not \"not connected\"");
    assert.equal(d.body.connection.error, "keychain-delete");
    assert.ok(sec.read()["agent-hub.oauth|tix.token"], "the token is in place");
    sec.fail(null);
    const d2 = await req(h.sock, "POST", "/connections/tix/disconnect");
    assert.equal(d2.status, 200);
    assert.equal(d2.body.connection.state, "disconnected");
    assert.equal(d2.body.connection.error, null);
    assert.deepEqual(sec.read(), {});

    // the server changed its login settings: reason in the reply and in the connection state
    f.s.noS256 = true;
    const c = await req(h.sock, "POST", "/connections/tix/connect");
    assert.equal(c.status, 502);
    assert.equal(c.body.error, "oauth:discovery");
    assert.equal(c.body.reason, "no-s256");
    assert.equal(c.body.connection.errorReason, "no-s256");
  } finally {
    sec.fail(null);
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

// ---------- contract 2: the plugin declares the connection ----------
test("connection declaration: trusted plugin only, its own id, host from <agenthub.net>; core limits", () => {
  const meta = (extra = "", net = "mcp.example.com — x") =>
    parseMetaText(`// <agenthub.net>${net}</agenthub.net>\n// <agenthub.connection url="https://mcp.example.com/mcp" scope="read" tools="a,b" interval="1m" budget="10000">x</agenthub.connection>\n${extra}`).meta;
  const pl = (id, source, granted = {}, m = meta()) => ({ id, source, granted, meta: m });
  // without id — the plugin id; built-in and own plugins are trusted
  assert.deepEqual(pluginConnections(pl("tix", "builtin")).list.map((c) => [c.id, c.plugin, c.host]), [["tix", "tix", "mcp.example.com"]]);
  assert.equal(pluginConnections(pl("tix", "installed", { tier: "own" })).list.length, 1);
  // community and local — no connections
  assert.equal(pluginConnections(pl("tix", "installed", { tier: "community" })).list.length, 0);
  assert.equal(pluginConnections(pl("tix", "local")).list.length, 0);
  // host not in the plugin's network — refused; a foreign id — refused
  assert.deepEqual(pluginConnections(pl("tix", "builtin", {}, meta("", "other.example.com — y"))).rejected, [{ id: "tix", why: "net" }]);
  const foreign = parseMetaText(`// <agenthub.net>mcp.example.com — x</agenthub.net>\n// <agenthub.connection id="other" url="https://mcp.example.com/mcp" tools="a">x</agenthub.connection>\n// <agenthub.connection id="tix-extra" url="https://mcp.example.com/mcp" tools="a">x</agenthub.connection>\n// <agenthub.connection id="tix.extra" url="https://mcp.example.com/mcp" tools="a">x</agenthub.connection>`).meta;
  const r = pluginConnections(pl("tix", "builtin", {}, foreign));
  // "tix-extra" is another plugin's id: this way plugin tix can't take plugin tix-extra's connection
  assert.deepEqual(r.rejected, [{ id: "other", why: "id" }, { id: "tix-extra", why: "id" }]);
  assert.deepEqual(r.list.map((c) => c.id), ["tix.extra"], "\"<plugin id>.<name>\" is its own");
  // the plugin id isn't valid as a keychain entry name (starts with a digit) — a connection without its own id is rejected right away
  assert.deepEqual(pluginConnections(pl("1pass", "builtin")).rejected, [{ id: "1pass", why: "id" }]);
  // tier — for logins predating contract 2 (pinned only for builtin/official)
  assert.deepEqual([pluginConnections(pl("tix", "builtin")).list[0].tier, pluginConnections(pl("tix", "installed", { tier: "own" })).list[0].tier, pluginConnections(pl("tix", "installed", { official: true, tier: "official" })).list[0].tier], ["builtin", "own", "official"]);
  // parsing: only https on a regular host, the allowlist is mandatory
  for (const bad of ['url="http://mcp.example.com/mcp" tools="a"', 'url="https://u:p@mcp.example.com/mcp" tools="a"', 'url="https://mcp.example.com:8443/mcp" tools="a"', 'url="https://mcp.example.com/mcp"', 'url="https://mcp.example.com/mcp" tools="a" type="rest"', 'url="https://mcp.example.com/mcp" tools="a" budget="0"']) {
    const { meta: m, warnings } = parseMetaText(`// <agenthub.connection ${bad}>x</agenthub.connection>`);
    assert.equal(m.connections.length, 0, bad);
    assert.ok(warnings.some((w) => /^connection/.test(w)), bad);
  }
  // core limits: interval no shorter than 5 min and no longer than a day, budget 1…10000; in test mode it may be shorter
  const d = defFromDeclared("tix", "Tix", pluginConnections(pl("tix", "builtin")).list[0]);
  assert.deepEqual(connectorLimits(d), { intervalMs: 5 * 60_000, dailyBudget: 10_000 });
  assert.deepEqual(connectorLimits({ ...d, intervalMs: 3 * 86_400_000, dailyBudget: 100 }), { intervalMs: 86_400_000, dailyBudget: 100 });
  assert.deepEqual(connectorLimits(d, { intervalMs: 300, dailyBudget: 5 }, { live: false }), { intervalMs: 300, dailyBudget: 5 });
  assert.equal(d.title, "Tix", "without title= — the plugin title");
  // only the plugin that declared the connection can call it
  const c = { def: d };
  assert.equal(pluginAllowed({ id: "tix", trusted: true, net: ["mcp.example.com — x"] }, c), null);
  assert.equal(pluginAllowed({ id: "other", trusted: true, net: ["mcp.example.com — x"] }, c), "mcp:not-owner");
  assert.equal(pluginAllowed({ id: "tix", trusted: false, net: ["mcp.example.com — x"] }, c), "mcp:untrusted");
});

test("a connection lives with its plugin: gone — gone, back — the login from the keychain is in place; a foreign token URL — new login", async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oplug-");
  const file = mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await conn0(h))?.state === "disconnected");
    await login(h, f);
    assert.equal((await conn0(h)).state, "connected");
    // a plugin restart (plugin.removed with restart) is not a removal: the connection and login stay
    h.core.emit({ type: "plugin.removed", plugin: "tix", restart: true });
    assert.equal(h.core.facts.get("oauth.api").get("tix").orphan, false);
    // plugin removed — the login in the keychain is intact, the connection is "orphaned": only "Disconnect", no login or calls
    const { renameSync } = await import("node:fs");
    renameSync(file, join(bin, "tix.1h.mjs.off"));
    await h.core.host.rescan();
    const orphan = await waitFor(async () => (await conn0(h))?.orphan === true ? await conn0(h) : null, { timeoutMs: 8000 });
    assert.equal(orphan.state, "connected");
    assert.equal(orphan.title, "Tix");
    assert.equal((await req(h.sock, "POST", "/connections/tix/connect")).body.error, "oauth:orphan");
    assert.ok(sec.read()["agent-hub.oauth|tix.token"], "the login isn't deleted with the plugin");
    // it's back — "Connected" again without a new login
    renameSync(join(bin, "tix.1h.mjs.off"), file);
    await h.core.host.rescan();
    await waitFor(async () => (await conn0(h))?.state === "connected", { timeoutMs: 8000 });
    assert.equal(f.s.registrations.length, 1);
    // the token was issued for a different URL (the plugin changed url) — it isn't sent to this URL
    const t = decodeJson(sec.read()["agent-hub.oauth|tix.token"]);
    assert.equal(t.resource, `${f.base}/mcp`, "the token remembers the resource URL");
    sec.write({ ...sec.read(), "agent-hub.oauth|tix.token": encodeJson({ ...t, resource: "https://elsewhere.example.com/mcp" }) });
    const conn = h.core.facts.get("oauth.api").get("tix");
    await conn.load();
    assert.equal(conn.state, "disconnected");
    assert.ok(h.core.journal.tail(200).some((e) => e.type === "oauth-resource-changed" && e.connector === "tix"));
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

// ---------- core cleanup review (2026-11-10) ----------
test(`orphaned connection: after a daemon restart it's found via Cache/oauth-<id>.json; "Disconnect" removes the login and the row; the plugin is back — a regular connection`, async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-oorph-");
  const file = mcpPlugin(plugins);
  let { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await conn0(h))?.state === "disconnected");
    await login(h, f);
    assert.ok(existsSync(join(h.config.paths.pluginCache, "oauth-tix.json")));
    const cache = JSON.parse(readFileSync(join(h.config.paths.pluginCache, "oauth-tix.json"), "utf8"));
    assert.deepEqual([cache.plugin, cache.title], ["tix", "Tix"], "the counters file holds who declared it and the title, no tokens");
    // plugin removed, daemon restarted: the connection shows as orphaned
    const { renameSync } = await import("node:fs");
    renameSync(file, join(bin, "tix.1h.mjs.off"));
    await h.core.host.rescan();
    await waitFor(async () => (await conn0(h))?.orphan === true, { timeoutMs: 8000 });
    // it's back — a regular connection again with the previous login
    renameSync(join(bin, "tix.1h.mjs.off"), file);
    await h.core.host.rescan();
    await waitFor(async () => { const c = await conn0(h); return c && !c.orphan && c.state === "connected"; }, { timeoutMs: 8000 });
    renameSync(file, join(bin, "tix.1h.mjs.off"));
    await h.core.host.rescan();
    await waitFor(async () => (await conn0(h))?.orphan === true, { timeoutMs: 8000 });
    // as after a daemon restart: the connection isn't in memory — it's found via the counters file and the keychain
    const svc = h.core.facts.get("oauth.api");
    svc.drop("tix", { quiet: true });
    await svc.load();
    const again = await conn0(h);
    assert.deepEqual([again.id, again.orphan, again.state, again.title, again.plugin], ["tix", true, "connected", "Tix", "tix"]);
    // "Disconnect" on an orphan — login deleted, no row
    const d = await req(h.sock, "POST", "/connections/tix/disconnect");
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(sec.read()["agent-hub.oauth|tix.token"], undefined);
    assert.deepEqual((await req(h.sock, "GET", "/connections")).body.connections, []);
    assert.ok(!existsSync(join(h.config.paths.pluginCache, "oauth-tix.json")));
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("login predating contract 2 (no resource URL): built-in/official — pinned to the declared URL; own — not accepted; removal with data deletes the login", async () => {
  const f = await fakeMcp();
  const plugins = tempHome("ah-olegacy-");
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins });
  try {
    await waitFor(async () => (await conn0(h))?.state === "disconnected");
    await login(h, f);
    const t = decodeJson(sec.read()["agent-hub.oauth|tix.token"]);
    const { resource, ...legacy } = t;
    const conn = h.core.facts.get("oauth.api").get("tix");
    // built-in plugin: the previous login is accepted and immediately pinned to the URL
    sec.write({ ...sec.read(), "agent-hub.oauth|tix.token": encodeJson(legacy) });
    await conn.load();
    assert.equal(conn.state, "connected");
    assert.equal(decodeJson(sec.read()["agent-hub.oauth|tix.token"]).resource, `${f.base}/mcp`);
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "oauth-resource-pinned" && e.stored === true));
    // the same id on an own plugin (e.g. after removing the official one): it doesn't inherit the previous login
    sec.write({ ...sec.read(), "agent-hub.oauth|tix.token": encodeJson(legacy) });
    conn.def.tier = "own";
    await conn.load();
    assert.equal(conn.state, "disconnected");
    assert.equal(decodeJson(sec.read()["agent-hub.oauth|tix.token"]).resource, undefined, "a foreign login is not pinned");
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "oauth-resource-unknown" && e.connector === "tix"));
    // removing a plugin "with data" (plugins.removed, purge) deletes the login of its connections
    conn.def.tier = "builtin";
    sec.write({ ...sec.read(), "agent-hub.oauth|tix.token": encodeJson(t) });
    await conn.load();
    h.core.emit({ type: "plugins.removed", plugin: "tix", purge: true });
    await waitFor(() => sec.read()["agent-hub.oauth|tix.token"] === undefined && !h.core.facts.get("oauth.api").get("tix"));
    assert.ok(h.core.journal.tail(100).some((e) => e.type === "connection-purged" && e.ok === true));
    noSecrets(h, sec);
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("a daily budget above 500 works: at least as many call marks as the budget are kept", async () => {
  const plugins = tempHome("ah-obud-");
  const f = await fakeMcp();
  mcpPlugin(plugins);
  const { h, sec, bin } = await hubWith({ f, plugins, extraOauth: { dailyBudget: 1000 } });
  try {
    const conn = await waitFor(() => h.core.facts.get("oauth.api")?.get("tix"));
    assert.equal(conn.dailyBudget, 1000);
    const now = Date.now();
    conn.persist.calls = Array.from({ length: 1000 }, (_, i) => now - 60_000 - i);
    conn.savePersist();
    // re-read the file (restart) — all 1000 marks are in place, the budget is exhausted
    assert.equal(conn.loadPersist().calls.length, 1000);
    assert.equal(conn.gate(now).why, "budget");
  } finally {
    await h.stop();
    await f.close();
    cleanup(bin);
    cleanup(plugins);
  }
});
