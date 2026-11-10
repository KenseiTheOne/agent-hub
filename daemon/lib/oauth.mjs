// OAuth 2.1 for hub connections to external services (the oauth service, lib/services/oauth.mjs; docs/api.md
// "Connections"). Public client: PKCE (S256), state, dynamic client registration (RFC 7591, no
// client_secret), authorization server discovery via protected resource metadata (RFC 9728) and server metadata
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

export function authorizeUrl(meta, client, { state, challenge, scope }) {
  const u = new URL(meta.authorizationEndpoint);
  const q = { response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, resource: meta.resource };
  if (scope) q.scope = scope;
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
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
