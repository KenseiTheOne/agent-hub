// type="http" connections (G7): OAuth 2.1 with a pre-registered public client (no secret, no dynamic registration) + PKCE,
// tokens in the keychain double, and the hub proxying the plugin's HTTP requests to the declared API hosts with the bearer
// token. The authorization server and the API are one HTTP double on 127.0.0.1 (test mode substitutes the declared https
// endpoints); the keychain is a `security` double with a JSON file. Nothing real is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, curl, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";
import { defaultSys } from "../lib/peer.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { pluginConnections } from "../lib/core.mjs";
import { lintPlugin, permissionsFromMeta } from "../lib/registry/perms.mjs";
import { normalizeHttpRequest, requestHeaderAllowed, responseHeaderAllowed } from "../lib/oauth.mjs";

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";

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
fs.appendFileSync(db + ".log", a.join(" ") + "\\n");
if (a[0] === "find-generic-password") {
  const v = load()[opt(a, "-s") + "|" + opt(a, "-a")];
  if (v === undefined) process.exit(44);
  process.stdout.write(v + "\\n");
} else if (a[0] === "delete-generic-password") {
  const o = load(); const k = opt(a, "-s") + "|" + opt(a, "-a");
  if (!(k in o)) process.exit(44);
  delete o[k]; save(o);
} else if (a[0] === "-i") {
  let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => {
    for (const raw of s.split("\\n").filter(Boolean)) {
      const w = raw.trim().split(/\\s+/);
      if (w[0] !== "add-generic-password") continue;
      const o = load(); o[opt(w, "-s") + "|" + opt(w, "-a")] = opt(w, "-w"); save(o);
    }
    process.exit(0);
  });
} else process.exit(2);
`,
  );
  return { p, read: () => JSON.parse(readFileSync(db, "utf8")), log: () => readFileSync(db + ".log", "utf8") };
}

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

// The service double: /oauth/token (code + PKCE for the pre-registered client "pub-client", refresh) and the API under /v1/.
async function fakeService() {
  const s = { codes: new Map(), tokens: new Set(), refreshTokens: new Set(), seq: 0, gets: 0, posts: [], seen: [], tokenForms: [], refreshed: 0, rejectAll: false, rate: false, down: false };
  const json = (res, status, o, h = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...h });
    res.end(JSON.stringify(o));
  };
  const server = createServer((rq, rs) => {
    let text = "";
    rq.on("data", (c) => (text += c));
    rq.on("end", () => {
      const url = new URL(rq.url, "http://127.0.0.1");
      if (url.pathname === "/oauth/token" && rq.method === "POST") {
        const f = Object.fromEntries(new URLSearchParams(text));
        s.tokenForms.push(f);
        if (f.client_id !== "pub-client" || "client_secret" in f || "resource" in f) return json(rs, 400, { error: "invalid_client" });
        if (f.grant_type === "authorization_code") {
          const c = s.codes.get(f.code);
          s.codes.delete(f.code);
          if (!c || createHash("sha256").update(f.code_verifier || "").digest("base64url") !== c.challenge || f.redirect_uri !== c.redirectUri) return json(rs, 400, { error: "invalid_grant" });
        } else if (f.grant_type === "refresh_token") {
          if (!s.refreshTokens.has(f.refresh_token)) return json(rs, 400, { error: "invalid_grant" });
          s.refreshTokens.delete(f.refresh_token);
          s.refreshed++;
          s.rejectAll = false;
        } else return json(rs, 400, { error: "unsupported_grant_type" });
        const at = `api-access-${++s.seq}-SECRETVALUE`;
        const rt = `api-refresh-${s.seq}-SECRETVALUE`;
        s.tokens.add(at);
        s.refreshTokens.add(rt);
        return json(rs, 200, { access_token: at, token_type: "bearer", expires_in: 3600, refresh_token: rt, scope: "read write" });
      }
      const tok = String(rq.headers.authorization || "").replace(/^Bearer /, "");
      s.seen.push({ method: rq.method, path: url.pathname, query: url.search, headers: rq.headers });
      if (!s.tokens.has(tok) || s.rejectAll) return json(rs, 401, { error: "invalid_token" });
      if (s.rate) return json(rs, 429, { error: "slow down" }, { "retry-after": "120" });
      if (s.down) return json(rs, 502, { error: "bad gateway" });
      if (url.pathname === "/v1/items" && rq.method === "GET") return json(rs, 200, { n: ++s.gets, q: url.searchParams.get("q") }, { etag: `"e${s.gets}"`, "x-ratelimit-remaining": "99", "set-cookie": "sid=SECRETCOOKIE" });
      if (url.pathname === "/v1/items" && rq.method === "POST") {
        s.posts.push({ body: text, ct: rq.headers["content-type"], ver: rq.headers["x-github-api-version"] });
        return json(rs, 201, { created: true });
      }
      if (url.pathname === "/v1/missing") return json(rs, 404, { error: "no such item" });
      if (url.pathname === "/v1/redirect") {
        rs.writeHead(302, { location: "https://elsewhere.example/landing" });
        return rs.end();
      }
      if (url.pathname === "/v1/big") {
        rs.writeHead(200, { "content-type": "text/plain" });
        return rs.end("x".repeat(300 * 1024));
      }
      if (url.pathname === "/v1/bin") {
        rs.writeHead(200, { "content-type": "image/png" });
        return rs.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
      }
      json(rs, 404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  s.approve = (authorizeUrl) => {
    const u = new URL(authorizeUrl);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    s.codes.set(code, { challenge: u.searchParams.get("code_challenge"), redirectUri: u.searchParams.get("redirect_uri") });
    return { code, state: u.searchParams.get("state"), redirect: u.searchParams.get("redirect_uri") };
  };
  return { s, base, close: () => new Promise((r) => server.close(r)) };
}

// The plugin: declares the http connection and, on every run, sends the requests from reqFile through the hub,
// writing the replies to outFile.
function httpPlugin(dir, { reqFile, outFile, net = ["auth.example.com — вход", "api.example.com — данные"] }) {
  return writePlugin(
    dir,
    "apix.1h.mjs",
    `#!/usr/bin/env node
// <agenthub.title>Api X</agenthub.title>
${net.map((n) => `// <agenthub.net>${n}</agenthub.net>`).join("\n")}
// <agenthub.connection type="http" client_id="pub-client" authorize="https://auth.example.com/oauth/authorize?access_type=offline" token="https://auth.example.com/oauth/token" hosts="api.example.com" scope="read write" methods="GET,POST" paths="/v1/" interval="1h" title="Api X">данные сервиса</agenthub.connection>
import { request } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const sock = process.env.AGENTHUB_HUB_SOCKET;
let list = [];
try { list = JSON.parse(readFileSync(${JSON.stringify(reqFile)}, "utf8")); } catch {}
const call = (path, b) => new Promise((resolve) => {
  const data = JSON.stringify(b);
  const r = request({ socketPath: sock, path, method: "POST", headers: { Host: "hub", "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
    let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => { let o = null; try { o = JSON.parse(s); } catch {} resolve({ status: res.statusCode, body: o }); });
  });
  r.on("error", (e) => resolve({ status: 0, error: e.code }));
  r.end(data);
});
const out = [];
for (const x of list) out.push(await call(x.route || "/connections/apix/http", x.body));
writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(out));
console.log("done " + list.length + " " + Date.now() + " | status=ok");
`,
  );
}

test("http connection: declaration, permission line, linter, request checks", () => {
  const { meta, warnings } = parseMetaText(`// <agenthub.net>auth.example.com — вход</agenthub.net>
// <agenthub.net>api.example.com — данные</agenthub.net>
// <agenthub.connection id="p" type="http" client_id="pub-client" authorize="https://auth.example.com/authorize" token="https://auth.example.com/token" hosts="api.example.com" methods="get,post" paths="/v1/,/v2/x" port="53682">why</agenthub.connection>
// <agenthub.connection id="p.bad" type="http" client_id="pub-client" authorize="http://auth.example.com/a" token="https://auth.example.com/token" hosts="api.example.com">x</agenthub.connection>
// <agenthub.connection id="p.bad2" type="http" client_id="has space" authorize="https://auth.example.com/a" token="https://auth.example.com/token" hosts="api.example.com">x</agenthub.connection>
// <agenthub.connection id="p.bad3" type="http" client_id="c" authorize="https://auth.example.com/a" token="https://auth.example.com/token">x</agenthub.connection>
// <agenthub.connection id="p.bad4" type="http" client_id="c" authorize="https://auth.example.com/a" token="https://auth.example.com/token" hosts="api.example.com" methods="TRACE">x</agenthub.connection>
// <agenthub.connection id="p.bad5" type="http" client_id="c" authorize="https://auth.example.com/a" token="https://auth.example.com/token" hosts="api.example.com" paths="/v1/../x">x</agenthub.connection>
`);
  assert.equal(meta.connections.length, 1);
  assert.equal(warnings.length, 5, warnings.join("\n"));
  const c = meta.connections[0];
  assert.equal(c.type, "http");
  assert.equal(c.host, "auth.example.com");
  assert.deepEqual(c.hosts, ["api.example.com"]);
  assert.deepEqual(c.http, { clientId: "pub-client", authorize: "https://auth.example.com/authorize", token: "https://auth.example.com/token", hosts: ["api.example.com"], methods: ["GET", "POST"], paths: ["/v1/", "/v2/x"], port: 53682 });
  // the core passes the http part on; a host missing from net rejects the declaration
  const pl = { id: "p", source: "builtin", meta: { ...meta, net: ["auth.example.com — вход", "api.example.com — данные"] } };
  assert.deepEqual(pluginConnections(pl).list[0].http.hosts, ["api.example.com"]);
  assert.equal(pluginConnections({ ...pl, meta: { ...meta, net: ["auth.example.com — вход"] } }).rejected[0].why, "net");
  // what a human agrees to: client, endpoints, API hosts, methods, paths
  const perms = permissionsFromMeta(meta);
  assert.match(perms.connections[0].what, /^p: http client=pub-client authorize=https:\/\/auth\.example\.com\/authorize token=https:\/\/auth\.example\.com\/token api=api\.example\.com scope=- methods=GET,POST paths=\/v1\/,\/v2\/x$/);
  const lint = lintPlugin({ id: "p", meta: { ...meta, title: "P", version: "1.0.0", author: { github: "x" }, platforms: ["macos"] }, official: true, lang: "en" });
  assert.deepEqual(lint.errors, []);
  assert.ok(lint.warnings.some((w) => w.includes('type="http"') && w.includes("api.example.com")));
  assert.ok(lint.warnings.some((w) => w.includes("methods=POST")));

  const decl = c.http;
  assert.equal(normalizeHttpRequest({ path: "/v1/items" }, decl).method, "GET");
  assert.equal(normalizeHttpRequest({ method: "DELETE", path: "/v1/items" }, decl).error, "http:method-not-allowed");
  assert.equal(normalizeHttpRequest({ path: "/v1/x", host: "evil.example" }, decl).error, "http:host-not-allowed");
  for (const path of ["//evil.example/v1/", "v1/x", "/v1/x?y=1", "/v1/../admin", "/v1/%2e%2e/admin", "/v1/x#f", "/v1/a\\b", "/v1/a b"]) assert.equal(normalizeHttpRequest({ path }, decl).error, "args:path:invalid", path);
  assert.equal(normalizeHttpRequest({ path: "/admin" }, decl).error, "http:path-not-allowed");
  assert.equal(normalizeHttpRequest({ path: "/v1/x", headers: { Authorization: "Bearer x" } }, decl).error, "http:header-not-allowed");
  assert.equal(normalizeHttpRequest({ path: "/v1/x", headers: { "X-Forwarded-For": "1.2.3.4" } }, decl).error, "http:header-not-allowed");
  assert.equal(normalizeHttpRequest({ path: "/v1/x", headers: { accept: "a\r\nb" } }, decl).error, "args:headers:value");
  assert.equal(normalizeHttpRequest({ path: "/v1/x", body: "x" }, decl).error, "args:body:not-allowed");
  assert.equal(normalizeHttpRequest({ method: "POST", path: "/v1/x", body: "x".repeat(70 * 1024) }, decl).error, "too-large");
  const ok = normalizeHttpRequest({ method: "post", path: "/v1/x", query: { q: "a b", tag: ["1", 2] }, headers: { "Notion-Version": "2022-06-28", "X-GitHub-Api-Version": "1" }, body: { a: 1 } }, decl);
  assert.deepEqual(ok.query, [["q", "a b"], ["tag", "1"], ["tag", "2"]]);
  assert.equal(ok.headers["content-type"], "application/json");
  assert.equal(ok.body, '{"a":1}');
  for (const h of ["cookie", "host", "proxy-authorization", "x-http-method-override", "connection", "transfer-encoding"]) assert.equal(requestHeaderAllowed(h), false, h);
  for (const h of ["set-cookie", "www-authenticate", "server"]) assert.equal(responseHeaderAllowed(h), false, h);
  assert.equal(responseHeaderAllowed("x-ratelimit-remaining"), true);
});

test("http connection: login with the pre-registered client, proxied reads (cache) and writes, refresh on 401, rate limit, disconnect", async () => {
  const f = await fakeService();
  const plugins = tempHome("ah-hplug-");
  const work = tempHome("ah-hwork-");
  const reqFile = join(work, "req.json");
  const outFile = join(work, "out.json");
  httpPlugin(plugins, { reqFile, outFile });
  const bin = tempHome("ah-hsec-");
  const sec = fakeSecurity(bin);
  const h = await startHub({
    pluginsDir: plugins,
    services: "oauth,secrets",
    sys: appSelfSys(),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      services: { secrets: { securityPath: sec.p }, oauth: { apix: { authorize: `${f.base}/oauth/authorize?access_type=offline`, token: `${f.base}/oauth/token`, api: f.base, intervalMs: 3_600_000, callWaitMs: 3000, loginTimeoutMs: 10_000 } } },
    },
  });
  let runs = 0;
  const run = async (list) => {
    writeFileSync(reqFile, JSON.stringify(list));
    const n = ++runs;
    h.core.host.refresh("apix", "Manual");
    await waitFor(() => {
      const t = h.core.pluginState("apix")?.header?.[0]?.title || "";
      return t.startsWith(`done ${list.length} `) && t !== run.last && (run.last = t);
    }, { timeoutMs: 10_000 });
    return JSON.parse(readFileSync(outFile, "utf8"));
  };
  try {
    const st0 = await waitFor(async () => {
      const r = await req(h.sock, "GET", "/connections");
      return r.body?.connections?.find((c) => c.id === "apix" && c.state === "disconnected");
    });
    assert.equal(st0.type, "http");
    assert.deepEqual(st0.apiHosts, ["api.example.com"]);
    assert.deepEqual(st0.methods, ["GET", "POST"]);
    assert.deepEqual(st0.paths, ["/v1/"]);
    assert.equal(st0.requestedScope, "read write");
    // before login the plugin gets 409
    const [pre] = await run([{ body: { path: "/v1/items" } }]);
    assert.equal(pre.status, 409);
    assert.equal(pre.body.error, "oauth:not-connected");

    // login: no discovery, no registration — the declared client and endpoints, PKCE, no resource indicator
    const c1 = await req(h.sock, "POST", "/connections/apix/connect");
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    const au = new URL(c1.body.authorizeUrl);
    assert.equal(`${au.origin}${au.pathname}`, `${f.base}/oauth/authorize`);
    assert.equal(au.searchParams.get("access_type"), "offline", "fixed query parameters of the declared endpoint are kept");
    assert.equal(au.searchParams.get("client_id"), "pub-client");
    assert.equal(au.searchParams.get("code_challenge_method"), "S256");
    assert.equal(au.searchParams.get("scope"), "read write");
    assert.equal(au.searchParams.has("resource"), false);
    assert.match(au.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    const a = f.s.approve(c1.body.authorizeUrl);
    const page = await get(`${a.redirect}?code=${a.code}&state=${a.state}`);
    assert.equal(page.status, 200, page.text);
    const st1 = (await req(h.sock, "GET", "/connections")).body.connections.find((c) => c.id === "apix");
    assert.equal(st1.state, "connected");
    assert.equal(st1.refresh, true);
    const kc = sec.read();
    assert.ok(kc["agent-hub.oauth|apix.token"], "the token is in the keychain");
    assert.equal(kc["agent-hub.oauth|apix.client"], undefined, "a pre-registered client stores nothing");

    // reads: the first goes to the service, the same one again comes from the interval cache, fresh: true goes again
    const r1 = await run([{ body: { path: "/v1/items", query: { q: "x" } } }, { body: { path: "/v1/items", query: { q: "x" } } }, { body: { path: "/v1/items", query: { q: "x" }, fresh: true } }]);
    assert.equal(r1[0].status, 200, JSON.stringify(r1[0].body));
    assert.equal(r1[0].body.ok, true);
    assert.equal(r1[0].body.fresh, true);
    assert.equal(r1[0].body.response.status, 200);
    assert.deepEqual(r1[0].body.response.json, { n: 1, q: "x" });
    assert.equal(r1[0].body.response.headers.etag, '"e1"');
    assert.equal(r1[0].body.response.headers["x-ratelimit-remaining"], "99");
    assert.equal(r1[0].body.response.headers["set-cookie"], undefined, "response headers from the allow-list only");
    assert.equal(r1[1].body.fresh, false);
    assert.equal(r1[1].body.response.json.n, 1, "served from the cache");
    assert.equal(r1[2].body.fresh, true);
    assert.equal(r1[2].body.response.json.n, 2);
    const seen = f.s.seen.at(-1);
    assert.match(seen.headers.authorization, /^Bearer api-access-1-/);
    assert.equal(seen.query, "?q=x");

    // a write: always to the service, marks the cached reads stale (read after write goes to the service)
    const r2 = await run([
      { body: { method: "POST", path: "/v1/items", body: { title: "new" }, headers: { "X-GitHub-Api-Version": "2022-11-28" } } },
      { body: { path: "/v1/items", query: { q: "x" } } },
      { body: { method: "DELETE", path: "/v1/items" } },
      { body: { path: "/v1/items", host: "elsewhere.example" } },
      { body: { path: "/admin" } },
      { body: { path: "//elsewhere.example/v1/" } },
      { body: { path: "/v1/items", headers: { Cookie: "a=b" } } },
      { body: { tool: "x" }, route: "/connections/apix/mcp" },
      { body: { path: "/v1/missing" } },
      { body: { path: "/v1/redirect" } },
      { body: { path: "/v1/big" } },
      { body: { path: "/v1/bin" } },
    ]);
    assert.equal(r2[0].body.ok, true, JSON.stringify(r2[0].body));
    assert.equal(r2[0].body.response.status, 201);
    assert.deepEqual(f.s.posts[0], { body: '{"title":"new"}', ct: "application/json", ver: "2022-11-28" });
    assert.equal(r2[1].body.response.json.n, 3, "read after write is not served from the cache");
    assert.deepEqual([r2[2].status, r2[2].body.error], [403, "http:method-not-allowed"]);
    assert.deepEqual([r2[3].status, r2[3].body.error], [403, "http:host-not-allowed"]);
    assert.deepEqual([r2[4].status, r2[4].body.error], [403, "http:path-not-allowed"]);
    assert.deepEqual([r2[5].status, r2[5].body.error], [400, "args:path:invalid"]);
    assert.deepEqual([r2[6].status, r2[6].body.error], [403, "http:header-not-allowed"]);
    assert.deepEqual([r2[7].status, r2[7].body.error], [400, "mcp:not-mcp"]);
    assert.equal(r2[8].body.response.status, 404, "a 4xx is the service's answer");
    assert.equal(r2[9].body.response.status, 302, "redirects are not followed");
    assert.equal(r2[9].body.response.headers.location, "https://elsewhere.example/landing");
    assert.equal(r2[10].body.response.truncated, true);
    assert.equal(r2[10].body.response.body.length, 256 * 1024);
    assert.equal(r2[11].body.response.encoding, "base64");
    assert.equal(Buffer.from(r2[11].body.response.body, "base64").length, 6);
    assert.ok(!f.s.seen.some((x) => x.method === "DELETE" || x.path === "/admin"), "refused requests never reach the service");

    // a non-plugin process can't use the proxy
    const np = await curl(h.sock, "POST", "/connections/apix/http", { path: "/v1/items" });
    assert.deepEqual([np.status, np.body.error], [403, "http:not-a-plugin"]);

    // 401: one refresh with the refresh token, then the request is retried
    f.s.rejectAll = true;
    const [r3] = await run([{ body: { path: "/v1/items", fresh: true } }]);
    assert.equal(r3.body.ok, true, JSON.stringify(r3.body));
    assert.equal(f.s.refreshed, 1);
    assert.match(f.s.seen.at(-1).headers.authorization, /^Bearer api-access-2-/);
    const refreshForm = f.s.tokenForms.at(-1);
    assert.equal(refreshForm.grant_type, "refresh_token");
    assert.equal(refreshForm.client_id, "pub-client");

    // 5xx: an error with the response; 429 with Retry-After: a rate backoff — the next fresh call is not made
    f.s.down = true;
    const [r4] = await run([{ body: { path: "/v1/items", fresh: true } }]);
    assert.equal(r4.body.ok, false);
    assert.equal(r4.body.error, "http:server-error");
    assert.equal(r4.body.response.status, 502);
    f.s.down = false;
    f.s.rate = true;
    const r5 = await run([{ body: { method: "POST", path: "/v1/items", body: "{}" } }, { body: { method: "POST", path: "/v1/items", body: "{}" } }]);
    assert.equal(r5[0].body.error, "http:rate-limited");
    assert.equal(r5[0].body.response.status, 429);
    assert.deepEqual([r5[1].status, r5[1].body.error, r5[1].body.why], [429, "http:wait", "rate-limit"]);
    f.s.rate = false;

    // disconnect: the token is deleted
    const d = await req(h.sock, "POST", "/connections/apix/disconnect");
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(sec.read()["agent-hub.oauth|apix.token"], undefined);

    // nothing secret in the journal or in security's argv
    const journal = readFileSync(h.config.paths.journal, "utf8");
    for (const leak of ["SECRETVALUE", "SECRETCOOKIE", "code-"]) assert.doesNotMatch(journal, new RegExp(leak), `journal without ${leak}`);
    assert.doesNotMatch(sec.log(), /SECRETVALUE/);
    assert.ok(journal.includes('"type":"http-call"'));
  } finally {
    await h.stop();
    await f.close();
    cleanup(plugins);
    cleanup(work);
    cleanup(bin);
  }
});

test("http connection: a changed declaration (other API host) does not reuse the old token", async () => {
  const f = await fakeService();
  const plugins = tempHome("ah-hplug2-");
  const work = tempHome("ah-hwork2-");
  const reqFile = join(work, "req.json");
  const outFile = join(work, "out.json");
  httpPlugin(plugins, { reqFile, outFile });
  const bin = tempHome("ah-hsec2-");
  const sec = fakeSecurity(bin);
  const h = await startHub({
    pluginsDir: plugins,
    services: "oauth,secrets",
    sys: appSelfSys(),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      services: { secrets: { securityPath: sec.p }, oauth: { apix: { authorize: `${f.base}/oauth/authorize`, token: `${f.base}/oauth/token`, api: f.base, loginTimeoutMs: 10_000 } } },
    },
  });
  try {
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body?.connections?.find((c) => c.id === "apix" && c.state === "disconnected"));
    const c1 = await req(h.sock, "POST", "/connections/apix/connect");
    const a = f.s.approve(c1.body.authorizeUrl);
    assert.equal((await get(`${a.redirect}?code=${a.code}&state=${a.state}`)).status, 200);
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body.connections.find((c) => c.id === "apix")?.state === "connected");
    // the plugin now sends the token to another host: the stored login is bound to the old declaration
    const text = readFileSync(join(plugins, "apix.1h.mjs"), "utf8").replace('hosts="api.example.com"', 'hosts="api2.example.com"').replace("api.example.com — данные", "api2.example.com — данные");
    writeFileSync(join(plugins, "apix.1h.mjs"), text);
    h.core.host.rescan();
    const st = await waitFor(async () => (await req(h.sock, "GET", "/connections")).body.connections.find((c) => c.id === "apix" && c.apiHosts?.[0] === "api2.example.com"), { timeoutMs: 8000 });
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body.connections.find((c) => c.id === "apix")?.state === "disconnected");
    assert.ok(st);
  } finally {
    await h.stop();
    await f.close();
    cleanup(plugins);
    cleanup(work);
    cleanup(bin);
  }
});

// Review 2026-11-12 (C2): encoded traversal, routing headers and method overrides never reach the service.
test("http request checks: encoded separators and dots, double encoding, `;`, routing headers, _method are refused", () => {
  const decl = { hosts: ["api.example.com"], methods: ["GET", "POST"], paths: ["/v1/"] };
  for (const path of ["/v1/..%2Fadmin", "/v1/..%2fadmin", "/v1/%2e%2e%2fadmin", "/v1/%2E%2E/admin", "/v1/..;/admin", "/v1/x;y", "/v1/a%5cb", "/v1/a%5Cb", "/v1/%252e%252e/admin", "/v1/a%25b", "/v1/a%2Fb", "/v1/x%2e", "/v1/a%zz"]) {
    assert.equal(normalizeHttpRequest({ path }, decl).error, "args:path:invalid", path);
  }
  assert.equal(normalizeHttpRequest({ path: "/v1/a%20b/c" }, decl).error, undefined, "an encoded space is still a valid path");
  for (const h of ["X-Override-URL", "X-Envoy-Original-Path", "x-middleware-subrequest", "X-Custom-Thing", "X-Api-Key-Id", "Forwarded", "X-Forwarded-Version"]) {
    assert.equal(normalizeHttpRequest({ path: "/v1/x", headers: { [h]: "1" } }, decl).error, "http:header-not-allowed", h);
    assert.equal(requestHeaderAllowed(h), false, h);
  }
  for (const h of ["X-GitHub-Api-Version", "Notion-Version", "Stripe-Version", "Accept", "Idempotency-Key"]) assert.equal(requestHeaderAllowed(h), true, h);
  for (const k of ["_method", "_METHOD", "_Method"]) assert.equal(normalizeHttpRequest({ path: "/v1/x", query: { [k]: "DELETE" } }, decl).error, "http:query-not-allowed", k);
  assert.deepEqual(normalizeHttpRequest({ path: "/v1/x", query: { method: "a" } }, decl).query, [["method", "a"]]);
});

// Review 2026-11-12 (C1): parallel requests must not overrun the daily budget — a call is reserved before the first await.
test("http connection: parallel calls never overrun the daily budget (reserved before the keychain read)", async () => {
  const f = await fakeService();
  const plugins = tempHome("ah-hplug3-");
  const work = tempHome("ah-hwork3-");
  httpPlugin(plugins, { reqFile: join(work, "req.json"), outFile: join(work, "out.json") });
  const bin = tempHome("ah-hsec3-");
  const sec = fakeSecurity(bin);
  const h = await startHub({
    pluginsDir: plugins,
    services: "oauth,secrets",
    sys: appSelfSys(),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      // budget 6 → at most 2 calls a day
      services: { secrets: { securityPath: sec.p }, oauth: { apix: { authorize: `${f.base}/oauth/authorize`, token: `${f.base}/oauth/token`, api: f.base, intervalMs: 3_600_000, dailyBudget: 6, callWaitMs: 5000, loginTimeoutMs: 10_000 } } },
    },
  });
  try {
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body?.connections?.find((c) => c.id === "apix" && c.state === "disconnected"));
    const c1 = await req(h.sock, "POST", "/connections/apix/connect");
    const a = f.s.approve(c1.body.authorizeUrl);
    assert.equal((await get(`${a.redirect}?code=${a.code}&state=${a.state}`)).status, 200);
    const conn = await waitFor(() => (h.core.facts.get("oauth.api")?.get("apix")?.state === "connected" ? h.core.facts.get("oauth.api").get("apix") : null));
    // the plugin's own run may already have called (connect reruns it): start from a clean counter
    await waitFor(() => conn.inflight.size === 0);
    conn.persist.calls = [];
    const before = f.s.seen.length;
    const pl = { id: "apix", net: ["api.example.com — данные"] };
    const replies = await Promise.all([
      conn.httpRequest(pl, { method: "POST", path: "/v1/items", body: { n: 1 } }),
      conn.httpRequest(pl, { method: "POST", path: "/v1/items", body: { n: 2 } }),
      conn.httpRequest(pl, { path: "/v1/items", query: { q: "a" } }),
      conn.httpRequest(pl, { path: "/v1/items", query: { q: "b" } }),
      conn.httpRequest(pl, { path: "/v1/items", query: { q: "c" }, fresh: true }),
    ]);
    assert.equal(f.s.seen.length - before, 2, `only the budget's 2 calls reach the service: ${JSON.stringify(replies.map((r) => [r.status, r.body.error, r.body.why]))}`);
    assert.equal(conn.calls24h(Date.now()), 2);
    assert.equal(conn.reservedCalls, 0, "no reservation is left behind");
    const gated = replies.filter((r) => r.status === 429 || (r.status === 200 && r.body.fresh === false));
    assert.equal(gated.length, 3);
    for (const r of gated) assert.equal(r.body.why, "budget");
  } finally {
    await h.stop();
    await f.close();
    cleanup(plugins);
    cleanup(work);
    cleanup(bin);
  }
});

// Re-review 66: net="none" on an action covers the hub's own proxy too — refused before the connection state is looked at.
test(`http connection: an action with net="none" gets 403 net:none on /connections/:id/http; another action passes the caller check`, async () => {
  const plugins = tempHome("ah-hplug-");
  writePlugin(
    plugins,
    "apix.1h.mjs",
    `#!/usr/bin/env node
// <agenthub.title>Api X</agenthub.title>
// <agenthub.net>auth.example.com — sign-in</agenthub.net>
// <agenthub.net>api.example.com — data</agenthub.net>
// <agenthub.connection type="http" client_id="pub-client" authorize="https://auth.example.com/oauth/authorize" token="https://auth.example.com/oauth/token" hosts="api.example.com" methods="GET,POST" title="Api X">data</agenthub.connection>
// <agenthub.action id="quiet" level="immediate" net="none" title="Quiet">apix.1h.mjs --action quiet</agenthub.action>
// <agenthub.action id="post" level="confirm" title="Post">apix.1h.mjs --action post</agenthub.action>
import { request } from "node:http";
import { writeFileSync } from "node:fs";
const ai = process.argv.indexOf("--action");
if (ai < 0) { console.log("idle | status=ok"); process.exit(0); }
const data = JSON.stringify({ method: "POST", path: "/v1/items", body: "{}" });
const r = request({ socketPath: process.env.AGENTHUB_HUB_SOCKET, path: "/connections/apix/http", method: "POST", headers: { Host: "hub", "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
  let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => {
    writeFileSync(process.env.AGENTHUB_PLUGIN_DATA_PATH + "/" + process.argv[ai + 1] + ".json", JSON.stringify({ status: res.statusCode, body: JSON.parse(s || "null") }));
  });
});
r.end(data);
`,
  );
  const bin = tempHome("ah-hsec-");
  const sec = fakeSecurity(bin);
  const h = await startHub({
    pluginsDir: plugins,
    services: "oauth,secrets",
    sys: appSelfSys(),
    overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' }, services: { secrets: { securityPath: sec.p } } },
  });
  try {
    await waitFor(async () => (await req(h.sock, "GET", "/connections")).body?.connections?.some((c) => c.id === "apix"));
    const inst = h.core.host.get("apix");
    const run = async (id) => {
      const ar = await inst.runAction(inst.plugin.meta.actions.find((x) => x.id === id));
      assert.equal(ar.ok, true, JSON.stringify(ar));
      return JSON.parse(readFileSync(join(h.config.paths.pluginData, "apix", `${id}.json`), "utf8"));
    };
    const q = await run("quiet");
    assert.deepEqual([q.status, q.body.error], [403, "net:none"]);
    assert.ok(h.core.journal.tail(200).some((e) => e.type === "http-denied" && e.error === "net:none" && e.action === "quiet"));
    const p = await run("post");
    assert.deepEqual([p.status, p.body.error], [409, "oauth:not-connected"]);
  } finally {
    await h.stop();
    cleanup(bin);
    cleanup(plugins);
  }
});
