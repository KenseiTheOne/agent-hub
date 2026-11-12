// OAuth 2.1 for hub connections to external services (the oauth service, lib/services/oauth.mjs; docs/api.md
// "Connections"). Public client: PKCE (S256), state, dynamic client registration (RFC 7591, no
// client_secret) — or, for type="http" connections, a client the plugin author pre-registered (staticMeta: declared
// endpoints, no discovery, no registration), authorization server discovery via protected resource metadata (RFC 9728) and server metadata
// (RFC 8414), resource indicator (RFC 8707), iss check in the response (RFC 9207). The redirect URI is a temporary
// listener on 127.0.0.1 (RFC 8252 §7.3): one request with the right state, a short lifetime, then it closes.
//
// No storage and no journal here: token values are returned to the caller (the service), and errors are codes
// without the server's response text (OAuthError.code).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export class OAuthError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code; // discovery | register | exchange | refresh | invalid-grant | denied | state | iss-mismatch | timeout | net | http | aborted
    Object.assign(this, extra);
  }
}

const MAX_BODY = 256 * 1024;

// ---------- PKCE and state ----------
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url"); // 43 characters, RFC 7636 §4.1
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}
export function randomState() {
  return randomBytes(24).toString("base64url");
}
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- URLs ----------
// Whether a URL is allowed: https on a listed host; in test mode also http(s) on 127.0.0.1 / localhost.
export function urlAllowed(u, { hosts = [], loopback = false } = {}) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (loopback && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (url.protocol === "http:" || url.protocol === "https:")) return true;
  return url.protocol === "https:" && hosts.includes(url.hostname) && (url.port === "" || url.port === "443");
}

// WWW-Authenticate: Bearer realm="…", error="invalid_token", resource_metadata="…" → { scheme, params }
export function parseWwwAuthenticate(h) {
  const s = String(h || "");
  const m = /^\s*([A-Za-z][\w-]*)\s*(.*)$/s.exec(s);
  if (!m) return { scheme: null, params: {} };
  const params = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let x;
  while ((x = re.exec(m[2]))) params[x[1].toLowerCase()] = x[2] !== undefined ? x[2].replace(/\\(.)/g, "$1") : x[3];
  return { scheme: m[1].toLowerCase(), params };
}

// ---------- HTTP ----------
// → { status, headers, json, text }. No redirects; body up to 256 KB.
export async function httpCall(url, { method = "GET", headers = {}, json, form, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const h = { Accept: "application/json", ...headers };
  let body;
  if (json !== undefined) {
    h["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    h["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null)).toString();
  }
  let res;
  try {
    res = await fetchImpl(url, { method, headers: h, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new OAuthError("net", { reason: e?.name === "TimeoutError" ? "timeout" : "network" });
  }
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BODY) throw new OAuthError("http", { status: res.status, reason: "too-large" });
  const text = (await res.text()).slice(0, MAX_BODY);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json: parsed, text };
}

function wellKnown(base, suffix) {
  // RFC 8414 §3.1 / RFC 9728 §3.1: /.well-known/<name> is inserted between the host and the path
  const u = new URL(base);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return `${u.origin}/.well-known/${suffix}${path}`;
}

// ---------- authorization server discovery ----------
// → { resource, issuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint, scopes, grantTypes, issParam }
export async function discover(resource, { hosts = [], loopback = false, fetchImpl, timeoutMs = 10_000 } = {}) {
  const ok = (u) => urlAllowed(u, { hosts, loopback });
  if (!ok(resource)) throw new OAuthError("discovery", { reason: "resource-url" });
  // 1. a request without a token → 401 with the resource metadata URL
  let metaUrl = null;
  const probe = await httpCall(resource, { method: "POST", json: { jsonrpc: "2.0", id: 0, method: "ping" }, headers: { Accept: "application/json, text/event-stream" }, fetchImpl, timeoutMs });
  if (probe.status === 401) metaUrl = parseWwwAuthenticate(probe.headers.get("www-authenticate")).params.resource_metadata || null;
  const resOrigin = new URL(resource).origin;
  const candidates = metaUrl ? [metaUrl] : [wellKnown(resource, "oauth-protected-resource"), `${resOrigin}/.well-known/oauth-protected-resource`];
  let rm = null;
  for (const u of candidates) {
    // resource metadata only from the same origin as the resource itself
    if (!ok(u) || new URL(u).origin !== resOrigin) throw new OAuthError("discovery", { reason: "metadata-url" });
    const r = await httpCall(u, { fetchImpl, timeoutMs });
    if (r.status === 200 && r.json) {
      rm = r.json;
      break;
    }
  }
  if (!rm) throw new OAuthError("discovery", { reason: "no-resource-metadata" });
  if (rm.resource !== resource) throw new OAuthError("discovery", { reason: "resource-mismatch" });
  const issuer = Array.isArray(rm.authorization_servers) ? rm.authorization_servers[0] : null;
  if (typeof issuer !== "string" || !ok(issuer)) throw new OAuthError("discovery", { reason: "issuer-url" });
  // 2. authorization server metadata
  let as = null;
  for (const u of [wellKnown(issuer, "oauth-authorization-server"), wellKnown(issuer, "openid-configuration")]) {
    const r = await httpCall(u, { fetchImpl, timeoutMs });
    if (r.status === 200 && r.json) {
      as = r.json;
      break;
    }
  }
  if (!as) throw new OAuthError("discovery", { reason: "no-as-metadata" });
  if (String(as.issuer || "").replace(/\/+$/, "") !== issuer.replace(/\/+$/, "")) throw new OAuthError("discovery", { reason: "issuer-mismatch" });
  const methods = Array.isArray(as.code_challenge_methods_supported) ? as.code_challenge_methods_supported : [];
  // MCP spec: refuse if S256 is missing from the metadata
  if (!methods.includes("S256")) throw new OAuthError("discovery", { reason: "no-s256" });
  for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (typeof as[k] !== "string" || !ok(as[k])) throw new OAuthError("discovery", { reason: `${k.replace(/_endpoint$/, "")}-url` });
  }
  const auth = Array.isArray(as.token_endpoint_auth_methods_supported) ? as.token_endpoint_auth_methods_supported : ["none"];
  if (!auth.includes("none")) throw new OAuthError("discovery", { reason: "no-public-client" });
  return {
    resource,
    issuer: as.issuer,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    scopes: Array.isArray(rm.scopes_supported) ? rm.scopes_supported.filter((x) => typeof x === "string") : Array.isArray(as.scopes_supported) ? as.scopes_supported : [],
    grantTypes: Array.isArray(as.grant_types_supported) ? as.grant_types_supported : ["authorization_code"],
    issParam: as.authorization_response_iss_parameter_supported === true,
  };
}

// ---------- dynamic client registration ----------
// Public client (token_endpoint_auth_method: none). Grants are the intersection of the needed and the server-declared ones.
// 200 and 201 are both success (some servers answer 200). → { clientId, redirectUri, issuer, grantTypes, registeredAt }
export async function registerClient(meta, { redirectUri, clientName = "Agent Hub", scope, fetchImpl, timeoutMs = 10_000, now = Date.now() } = {}) {
  const grants = ["authorization_code", "refresh_token"].filter((g) => meta.grantTypes.includes(g));
  if (!grants.includes("authorization_code")) throw new OAuthError("register", { reason: "no-auth-code-grant" });
  const r = await httpCall(meta.registrationEndpoint, {
    method: "POST",
    json: { client_name: clientName, redirect_uris: [redirectUri], grant_types: grants, response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}) },
    fetchImpl,
    timeoutMs,
  });
  if (r.status !== 200 && r.status !== 201) throw new OAuthError("register", { status: r.status });
  const id = r.json?.client_id;
  if (typeof id !== "string" || !id || id.length > 512) throw new OAuthError("register", { reason: "no-client-id" });
  return { clientId: id, redirectUri, issuer: meta.issuer, grantTypes: grants, registeredAt: now };
}

// Endpoints declared by a type="http" connection (no discovery, no registration): checked like discovered ones — https on a
// listed host (test mode: loopback). → the same shape as discover()
export function staticMeta({ authorize, token }, { hosts = [], loopback = false } = {}) {
  for (const [k, u] of [["authorization", authorize], ["token", token]]) if (!urlAllowed(u, { hosts, loopback })) throw new OAuthError("discovery", { reason: `${k}-url` });
  return { resource: undefined, issuer: null, authorizationEndpoint: authorize, tokenEndpoint: token, registrationEndpoint: null, scopes: null, grantTypes: ["authorization_code", "refresh_token"], issParam: false };
}

export function authorizeUrl(meta, client, { state, challenge, scope }) {
  const u = new URL(meta.authorizationEndpoint);
  const q = { response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, resource: meta.resource };
  if (scope) q.scope = scope;
  // a pre-registered client (type http) has no resource indicator: no empty parameter
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

// exp from a JWT (signature not verified: only a fallback lifetime when expires_in is absent). → epoch ms or null
export function jwtExpMs(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isFinite(p?.exp) && p.exp > 0 ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

function tokenRecord(j, now, prev = null) {
  if (!j || typeof j.access_token !== "string" || !j.access_token || j.access_token.length > 8192) return null;
  if (j.token_type && String(j.token_type).toLowerCase() !== "bearer") return null;
  const exp = Number(j.expires_in);
  return {
    accessToken: j.access_token,
    // rotation: a new refresh token replaces the old one; if none arrives, the old one stays
    refreshToken: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : prev?.refreshToken || null,
    expiresAt: Number.isFinite(exp) && exp > 0 ? now + exp * 1000 : jwtExpMs(j.access_token),
    scope: typeof j.scope === "string" ? j.scope.slice(0, 200) : prev?.scope || null,
    obtainedAt: now,
  };
}

export async function exchangeCode(meta, client, { code, verifier, fetchImpl, timeoutMs = 15_000, now = Date.now() }) {
  const r = await httpCall(meta.tokenEndpoint, {
    method: "POST",
    form: { grant_type: "authorization_code", code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: verifier, resource: meta.resource },
    fetchImpl,
    timeoutMs,
  });
  if (r.status !== 200) throw new OAuthError(r.json?.error === "invalid_grant" ? "invalid-grant" : "exchange", { status: r.status });
  const t = tokenRecord(r.json, now);
  if (!t) throw new OAuthError("exchange", { reason: "no-token" });
  return t;
}

// Refresh: only if the server issued a refresh token. invalid_grant → OAuthError("invalid-grant"): a new login is needed.
export async function refreshAccess(meta, client, token, { fetchImpl, timeoutMs = 15_000, now = Date.now() }) {
  if (!token?.refreshToken) throw new OAuthError("invalid-grant", { reason: "no-refresh-token" });
  const r = await httpCall(meta.tokenEndpoint, {
    method: "POST",
    form: { grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: client.clientId, resource: meta.resource },
    fetchImpl,
    timeoutMs,
  });
  if (r.status === 400 || r.status === 401) throw new OAuthError(r.json?.error === "invalid_grant" || r.status === 401 ? "invalid-grant" : "refresh", { status: r.status });
  if (r.status !== 200) throw new OAuthError("refresh", { status: r.status });
  const t = tokenRecord(r.json, now, token);
  if (!t) throw new OAuthError("refresh", { reason: "no-token" });
  return t;
}

// ---------- code listener on 127.0.0.1 ----------
// Listens on 127.0.0.1 only, path /oauth/callback, method GET. The first request with the right state (and the right
// iss, if the server declared it) is the result; the listener closes right away. Requests with a foreign state get 400
// and do not stop it from waiting for the real one. Lifetime: timeoutMs. page(kind, code) → HTML reply to the browser.
// → { port, redirectUri, result: Promise<{code}>, close() }; result rejects with OAuthError(denied|iss-mismatch|timeout|aborted)
export function startLoopback({ port = 0, state, issuer = null, requireIss = false, timeoutMs = 300_000, page = () => "", onCode = null } = {}) {
  return new Promise((resolveStart, rejectStart) => {
    let settle;
    let fail;
    const result = new Promise((res, rej) => {
      settle = res;
      fail = rej;
    });
    result.catch(() => {});
    let done = false;
    const server = createServer(async (req, res) => {
      const send = (status, html) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
        res.end(html);
      };
      let url;
      try {
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        return send(400, page("bad"));
      }
      if (req.method !== "GET" || url.pathname !== "/oauth/callback") return send(404, page("bad"));
      if (done) return send(410, page("used"));
      const q = url.searchParams;
      if (!sameSecret(q.get("state") || "", state)) return send(400, page("bad"));
      const iss = q.get("iss");
      if ((requireIss || iss !== null) && issuer && iss !== issuer) {
        finish(new OAuthError("iss-mismatch"));
        return send(400, page("error", "iss-mismatch"));
      }
      if (q.get("error")) {
        const code = q.get("error") === "access_denied" ? "denied" : "authorize";
        finish(new OAuthError(code));
        return send(400, page("error", code));
      }
      const code = q.get("code");
      if (!code || code.length > 4096) {
        finish(new OAuthError("authorize"));
        return send(400, page("error", "authorize"));
      }
      done = true;
      clearTimeout(timer);
      server.close();
      // reply to the browser after the code exchange (onCode), so the page tells the truth
      let outcome = { ok: true };
      if (onCode) {
        try {
          outcome = await onCode(code);
        } catch (e) {
          outcome = { ok: false, code: e?.code || "exchange" };
        }
      }
      settle({ code, outcome });
      send(outcome.ok ? 200 : 400, outcome.ok ? page("ok") : page("error", outcome.code));
      // the browser holds the connection (keep-alive); the listener must not stay alive because of it
      server.closeIdleConnections?.();
      setTimeout(() => server.closeAllConnections?.(), 1000).unref?.();
    });
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      setTimeout(() => server.closeAllConnections?.(), 1000).unref?.();
      fail(err);
    };
    const timer = setTimeout(() => finish(new OAuthError("timeout")), timeoutMs);
    timer.unref?.();
    server.on("error", (e) => {
      clearTimeout(timer);
      rejectStart(e);
    });
    server.listen({ host: "127.0.0.1", port }, () => {
      const p = server.address().port;
      resolveStart({ port: p, redirectUri: `http://127.0.0.1:${p}/oauth/callback`, result, close: () => finish(new OAuthError("aborted")) });
    });
  });
}

// ---------- HTTP proxy for type="http" connections (G7) ----------
// The plugin describes a request, the hub checks it against the declaration and sends it with the bearer token
// (lib/services/oauth.mjs Connector.httpRequest, POST /connections/:id/http). Only https to a declared API host (test mode: the
// loopback double), the path under a declared prefix, a declared method, request headers from an allow-list (never Authorization,
// Cookie, Host or hop-by-hop), no redirects followed (a 3xx comes back with its Location), the response body capped.
export const PROXY_LIMITS = Object.freeze({ maxPath: 2048, maxQuery: 64, maxHeaders: 16, maxHeaderValue: 1024, maxBody: 64 * 1024, maxResponse: 256 * 1024 });
const REQ_HEADERS = new Set(["accept", "accept-language", "content-type", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "prefer", "idempotency-key", "range"]);
// An allow-list only (review 2026-11-12): the fixed headers above plus API version headers (Notion-Version, Stripe-Version,
// X-GitHub-Api-Version). Any other X-… header may be routing or rewriting for a proxy in front of the API (X-Override-URL,
// X-Envoy-Original-Path, x-middleware-subrequest …) — refused, as are routing names that happen to end in -version.
export function requestHeaderAllowed(name) {
  const n = String(name).toLowerCase();
  if (REQ_HEADERS.has(n)) return true;
  if (/^x-(?:forwarded|real-ip|http-method|method-override|original|rewrite|host|client-ip|proxy|envoy|middleware|override)/.test(n)) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-version$/.test(n);
}
// Query keys some frameworks read as a method override (`?_method=DELETE` turns a GET into a write)
const QUERY_DENY_RE = /^_method$/i;
const RES_HEADERS = new Set(["content-type", "content-language", "content-range", "etag", "last-modified", "link", "location", "retry-after", "cache-control", "date", "expires", "x-total-count", "x-request-id"]);
export function responseHeaderAllowed(name) {
  const n = String(name).toLowerCase();
  return RES_HEADERS.has(n) || /^x-ratelimit-[a-z-]+$/.test(n) || /^ratelimit(?:-[a-z-]+)?$/.test(n);
}
const CTRL_RE = /[\u0000-\u001f\u007f]/;
const scalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// Request from the plugin → a checked request, or { error: code }. decl — { hosts, methods, paths } of the connection.
export function normalizeHttpRequest(b, decl) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "args:body:type" };
  const method = typeof b.method === "string" ? b.method.toUpperCase() : "GET";
  if (!decl.methods.includes(method)) return { error: "http:method-not-allowed" };
  const host = b.host === undefined ? decl.hosts[0] : typeof b.host === "string" ? b.host.toLowerCase() : null;
  if (!host || !decl.hosts.includes(host)) return { error: "http:host-not-allowed" };
  const path = b.path;
  // an absolute path on the host: not "//other" (protocol-relative), no query/fragment/backslash/control chars, no dot segments
  // (also percent-encoded — the URL parser would resolve them past a path prefix)
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > PROXY_LIMITS.maxPath || /[?#\\\s]/.test(path) || CTRL_RE.test(path)) return { error: "args:path:invalid" };
  if (path.split("/").some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) return { error: "args:path:invalid" };
  // encoded separators and dots (`..%2F`, `%2e%2e%2f`, `%5c`), a `%` of double encoding (`%252e`), a malformed escape and `;`
  // (`..;/` — a path parameter some servers strip before resolving dot segments): a server or a proxy in front of it could
  // decode them past the declared prefix, so they are refused rather than normalized
  if (/%(?:2f|5c|2e|25)|%(?![0-9a-f]{2})|;/i.test(path)) return { error: "args:path:invalid" };
  let pathname;
  try {
    pathname = new URL(path, "https://h.invalid").pathname;
  } catch {
    return { error: "args:path:invalid" };
  }
  if (decl.paths?.length && !decl.paths.some((p) => pathname.startsWith(p))) return { error: "http:path-not-allowed" };
  const query = [];
  if (b.query !== undefined && b.query !== null) {
    if (typeof b.query !== "object" || Array.isArray(b.query)) return { error: "args:query:type" };
    for (const [k, v] of Object.entries(b.query)) {
      if (QUERY_DENY_RE.test(k)) return { error: "http:query-not-allowed", key: k.slice(0, 64) };
      for (const x of Array.isArray(v) ? v : [v]) {
        if (!scalar(x) || k.length > 256 || String(x).length > 2048) return { error: "args:query:type" };
        query.push([k, String(x)]);
      }
    }
    if (query.length > PROXY_LIMITS.maxQuery) return { error: "args:query:too-many" };
  }
  const headers = {};
  if (b.headers !== undefined && b.headers !== null) {
    if (typeof b.headers !== "object" || Array.isArray(b.headers)) return { error: "args:headers:type" };
    const list = Object.entries(b.headers);
    if (list.length > PROXY_LIMITS.maxHeaders) return { error: "args:headers:too-many" };
    for (const [k, v] of list) {
      if (!requestHeaderAllowed(k)) return { error: "http:header-not-allowed", header: String(k).slice(0, 64) };
      if (typeof v !== "string" || v.length > PROXY_LIMITS.maxHeaderValue || CTRL_RE.test(v)) return { error: "args:headers:value" };
      headers[k.toLowerCase()] = v;
    }
  }
  let body;
  if (b.body !== undefined && b.body !== null) {
    if (method === "GET" || method === "HEAD") return { error: "args:body:not-allowed" };
    if (typeof b.body === "string") body = b.body;
    else if (typeof b.body === "object") {
      body = JSON.stringify(b.body);
      headers["content-type"] ||= "application/json";
    } else return { error: "args:body:type" };
    if (Buffer.byteLength(body) > PROXY_LIMITS.maxBody) return { error: "too-large" };
  }
  return { method, host, path, query, headers, body };
}

// One proxied request (no retries, no redirects). base — the origin to send to ("https://<host>"; test mode — the double).
// → { status, headers, body, encoding, json?, truncated?, rate, retryAfter } ; throws OAuthError("net") on a network failure
export async function proxyFetch(rq, token, { base, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const url = new URL(base + rq.path);
  if (url.origin !== new URL(base).origin) throw new OAuthError("http", { reason: "origin" });
  for (const [k, v] of rq.query || []) url.searchParams.append(k, v);
  let res;
  try {
    res = await fetchImpl(url, { method: rq.method, headers: { ...rq.headers, authorization: `Bearer ${token}` }, body: rq.body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new OAuthError("net", { reason: e?.name === "TimeoutError" ? "timeout" : "network" });
  }
  const headers = {};
  res.headers.forEach((v, k) => {
    if (responseHeaderAllowed(k)) headers[k.toLowerCase()] = String(v).slice(0, 2048);
  });
  const chunks = [];
  let n = 0;
  let truncated = false;
  if (res.body && rq.method !== "HEAD") {
    for await (const c of res.body) {
      const room = PROXY_LIMITS.maxResponse - n;
      if (c.length > room) {
        if (room > 0) chunks.push(Buffer.from(c).subarray(0, room));
        n = PROXY_LIMITS.maxResponse;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(c));
      n += c.length;
    }
  }
  const buf = Buffer.concat(chunks);
  const ct = String(headers["content-type"] || "").toLowerCase();
  const textual = !ct || /^(?:text\/|application\/(?:json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|x-www-form-urlencoded|javascript|graphql))/.test(ct);
  const out = { status: res.status, headers, body: textual ? buf.toString("utf8") : buf.toString("base64"), encoding: textual ? "utf8" : "base64" };
  if (truncated) out.truncated = true;
  if (textual && !truncated && /json/.test(ct)) {
    try {
      out.json = JSON.parse(out.body);
    } catch {}
  }
  const rem = res.headers.get("x-ratelimit-remaining") ?? res.headers.get("ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset"));
  out.rate = rem !== null && Number.isFinite(Number(rem)) ? { remaining: Number(rem), reset: Number.isFinite(reset) && reset > 0 ? reset : null } : null;
  out.retryAfter = res.headers.get("retry-after");
  return out;
}
