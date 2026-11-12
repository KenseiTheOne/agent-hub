// The oauth service: hub connections to external services via OAuth 2.1 and calls to their MCP servers on behalf of plugins
// (docs/api.md "Connections"). The core doesn't know which connections exist: trusted plugins declare them themselves with the tag
// <agenthub.connection id=… url=… scope=… tools=… interval=… budget=… title=…> (contract 2, lib/meta.mjs
// parseConnection). The core accepts a declaration only from builtin/official/own, only with the plugin id (or "<id>.<name>") and
// only if the URL host is in the plugin's <agenthub.net> (core.pluginConnections); no plugin — no connection.
// The service reconciles the connection set on plugin / plugin.removed events (a plugin restart — restart: true — is not
// a removal: an ongoing login and the result cache stay).
//
// The plugin is removed but its login stays in the keychain — the connection is "orphaned" (orphan: true): listed only with "Disconnect",
// no calls and no new login; after a daemon restart such connections are found via Cache/oauth-<id>.json. When the same
// id is declared again (the plugin is back) it's a regular connection with the previous login. Removing a plugin "with data" (purge,
// event plugins.removed) also deletes the login of its connections.
//
// Login (POST /connections/:id/connect, app only): authorization server discovery via metadata (lib/oauth.mjs),
// dynamic registration of a public client (no client_secret), PKCE S256, state, a code receiver on
// 127.0.0.1 with a random port (on repeat — the same port as the registered client, if free),
// timeout — loginTimeoutMs (5 min), a single receipt. The shell opens the login page (the URL is in the route reply).
// Client registration and tokens live **only** in the keychain via the secrets service (fact `secrets.store`,
// entries `agent-hub.oauth` / `<id>.client`, `<id>.token`; the entry name is the connection id, as before contract 2, so
// an existing login is preserved); service memory holds only the expiry and flags, the token itself is read from the keychain on every
// call. The token remembers the resource URL it was issued for (resource): if the plugin changes the URL, the old token isn't sent to the new
// URL, a new login is needed. A login predating contract 2 (no URL) is pinned to the declared URL on first read
// — only if a built-in or official plugin declared the connection (trust on first use);
// for an own plugin such a login isn't accepted: a new login is needed. Neither the token, the code, nor the verifier get into the log, the bus, route replies or
// plugins.
//
// MCP calls on behalf of plugins (POST /connections/:id/mcp): the plugin is identified by the peer pid on the socket (core fact
// pluginByPid: a running plugin run), must be the one that declared the connection, trusted and with the service host in
// `<agenthub.net>`; the tool must be from the declared allowlist (tools). The reply is the tool result. The rate is enforced by
// the service, not the plugin: the same request no more often than the declared interval (the core keeps it within 5 min …
// 24 h), the declared daily budget (1…10000, minus a reserve), backoff on RATE_LIMIT_EXCEEDED / retryAfter, on 429
// and on x-ratelimit-*; between allowed calls the plugin gets the previous result from service memory with nextAt and
// a reason (why). The call counter and backoff survive a restart: <home>/Cache/oauth-<id>.json (timestamps only,
// no tokens or content). An action process (a human pressed the plugin's button) may call too (pluginByPid with actions).
// A write or an explicit refresh: `fresh: true` in the request — no interval cache, no merging with an identical call in
// flight, the reply waits for the service (up to 20 s); the daily budget and backoff still apply (gated — 429 mcp:wait,
// the call is not made); a tool error does not start a backoff (it is usually the input, not the service). The result
// is not kept in memory, and a successful fresh call marks this plugin's cached results of the connection stale: the next
// ordinary call goes to the service (read after write), while a gated one still gets the previous result.
//
// Expiry and revocation: 401 from MCP — token refresh if the server issued a refresh token; none or an invalid_grant refusal —
// state expired ("Connect again"), the plugin gets 409 oauth:expired. A network or server failure during
// refresh and a temporary keychain failure (timeout, keychain locked) are not expiry: backoff `error`, the login is intact.
// 403 from MCP (insufficient_scope and others except invalid_token) means "insufficient permissions", not "login expired": mcp:forbidden and
// a one-hour backoff. A tool result with isError is not a successful refresh: the previous result stays, the plugin gets
// mcp:tool-error and the error text (errorText, up to 300 chars), backoff `tool-error`.
// "Disconnect" deletes both keychain entries; on failure the state is unchanged, error keychain-delete. The hub doesn't attempt to revoke
// granted access on the service side (MCP servers usually don't declare revocation_endpoint).
//
// type="http" connections (G7, lib/meta.mjs parseHttpConnection): a pre-registered PUBLIC client declared by the plugin
// (client_id, authorize and token endpoints) — no discovery, no dynamic registration, PKCE S256, the same loopback receiver,
// tokens in the same keychain entry (<id>.token; no <id>.client entry). The token is bound to the declaration (endpoint, client
// id, API hosts): a changed declaration needs a new login. Calls: POST /connections/:id/http {method, host?, path, query?,
// headers?, body?, fresh?} — the hub sends the request to a declared API host over https with the bearer token and returns
// {status, headers (allow-list), body (≤256 KB), encoding, json?}. Same caller rules, budget and backoff as MCP; GET/HEAD are
// served from the interval cache unless fresh; other methods are writes (always fresh, they mark the plugin's cached reads
// stale). 401 — one refresh and a retry, then expired; 429/503 with Retry-After — a rate backoff; 5xx — an error backoff.
//
// Settings (config.json → services.oauth): enabled; <id>.intervalMs and <id>.dailyBudget — on top of the plugin's declaration
// (within the same limits), <id>.loginTimeoutMs (300000), <id>.callWaitMs (3000), <id>.reloadMs (60000: if the keychain didn't
// answer at startup — re-read after this long). Test mode: <id>.resource and <id>.hosts — a double on
// 127.0.0.1/localhost (URL substitution isn't accepted in live mode); for type http — <id>.authorize, <id>.token (loopback
// endpoints) and <id>.api (the loopback origin every declared API host is sent to), <id>.port (a fixed redirect port).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authorizeUrl, discover, exchangeCode, normalizeHttpRequest, OAuthError, pkcePair, proxyFetch, randomState, refreshAccess, registerClient, startLoopback, staticMeta, urlAllowed } from "../oauth.mjs";
import { McpError, McpSession, retryAfterMs } from "../mcp-client.mjs";
import { VERSION } from "../version.mjs";
import { CONNECTION_ID_RE } from "../meta.mjs";

export const name = "oauth";
export const ENV_SOCKET = "AGENTHUB_HUB_SOCKET";

// Core limits for plugin declarations: interval between identical calls and the daily budget.
export const LIMITS = Object.freeze({ minIntervalMs: 5 * 60_000, maxIntervalMs: 24 * 3600_000, minBudget: 1, maxBudget: 10_000 });

// Plugin declaration (plugin state → connections[]) → the service's connection definition.
export function defFromDeclared(pluginId, pluginTitle, c) {
  return {
    id: c.id,
    tier: c.tier || null,
    title: c.title || pluginTitle || pluginId,
    note: c.note || null,
    plugin: pluginId,
    resource: c.url,
    hosts: [...new Set([c.host, ...(c.hosts || [])].filter(Boolean).map((h) => String(h).toLowerCase()))],
    scope: c.scope || null,
    tools: [...(c.tools || [])],
    intervalMs: c.intervalMs,
    dailyBudget: c.budget,
    type: c.type === "http" ? "http" : "mcp",
    http: c.type === "http" && c.http ? { ...c.http, hosts: [...c.http.hosts], methods: [...c.http.methods], paths: [...(c.http.paths || [])] } : null,
  };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Connection interval and budget: the plugin declaration (or config.json on top) within core limits; in test mode
// the interval may be shorter than 5 min (doubles). → { intervalMs, dailyBudget }
export function connectorLimits(def, cfg = {}, { live = true } = {}) {
  return {
    intervalMs: clamp(Number(cfg.intervalMs) || def.intervalMs || 15 * 60_000, live ? LIMITS.minIntervalMs : 1, LIMITS.maxIntervalMs),
    dailyBudget: clamp(Math.round(Number(cfg.dailyBudget) || def.dailyBudget || 100), LIMITS.minBudget, LIMITS.maxBudget),
  };
}

const DAY_MS = 24 * 3600_000;
const BUDGET_RESERVE = 4;
const META_TTL_MS = 3600_000;
const MAX_ARGS_BYTES = 8 * 1024;
const MAX_CACHE = 20;
// Call marks in Cache/oauth-<id>.json: at least the daily budget (otherwise a budget above this number wouldn't work).
const callsCap = (budget) => Math.max(500, Math.min(LIMITS.maxBudget, Number(budget) || 0));
// a login predating contract 2 without a resource URL is pinned to the declaration only for these tiers
const LEGACY_TOKEN_TIERS = new Set(["builtin", "official"]);
const ERROR_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000];
const RATE_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 3600_000, 6 * 3600_000];
const FORBIDDEN_BACKOFF_MS = 3600_000; // 403 — like the usage service: an hour
const BACKOFF_REASONS = new Set(["rate-limit", "error", "forbidden", "tool-error"]);
// connection errors cleared by the first successful call (not by a new login)
const CALL_ERRORS = new Set(["forbidden", "keychain-read"]);
const running = new Map(); // ctx → Service

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

// A stable argument string: the result cache key.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const PAGE = {
  ru: {
    ok: ["Подключено", (t) => `${t} подключён к Agent Hub. Эту вкладку можно закрыть.`],
    error: ["Не подключено", (t) => `Не получилось подключить ${t}. Вернитесь в Agent Hub и нажмите «Подключить» ещё раз.`],
    denied: ["Не подключено", "Вход отменён — доступ не выдан. Вкладку можно закрыть."],
    used: ["Уже обработано", "Этот вход уже обработан. Вкладку можно закрыть."],
    bad: ["Не тот адрес", "Agent Hub не ждёт этот запрос."],
  },
  en: {
    ok: ["Connected", (t) => `${t} is connected to Agent Hub. You can close this tab.`],
    error: ["Not connected", (t) => `Couldn't connect ${t}. Go back to Agent Hub and click Connect again.`],
    denied: ["Not connected", "Sign-in cancelled — no access was granted. You can close this tab."],
    used: ["Already handled", "This sign-in has already been handled. You can close this tab."],
    bad: ["Wrong address", "Agent Hub isn't expecting this request."],
  },
};
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Code receiver page; name — the connection title from the plugin declaration (escaped).
function page(lang, kind, code, name = "") {
  const t = PAGE[lang === "en" ? "en" : "ru"];
  const [title, raw] = kind === "error" && code === "denied" ? t.denied : t[kind] || t.bad;
  const text = typeof raw === "function" ? raw(escapeHtml(name || "Agent Hub")) : raw;
  return `<!doctype html><html lang="${lang === "en" ? "en" : "ru"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Hub — ${title}</title><body style="font:16px -apple-system,system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px;color:#222;background:#fafafa"><h1 style="font-size:22px">${title}</h1><p>${text}</p></body></html>`;
}

class Connector {
  constructor(svc, def, cfg) {
    this.svc = svc;
    this.ctx = svc.ctx;
    this.def = def;
    const live = !this.ctx.config.testMode;
    this.kind = def.type === "http" && def.http ? "http" : "mcp";
    this.resource = !live && typeof cfg.resource === "string" ? cfg.resource : def.resource;
    this.hosts = !live && Array.isArray(cfg.hosts) ? cfg.hosts.map(String) : [...def.hosts];
    this.loopback = !live;
    if (this.kind === "http") {
      // declared endpoints (test mode: loopback doubles); the token is bound to the declaration — endpoint, client, API hosts
      const loop = (v) => (!live && typeof v === "string" ? v : null);
      this.endpoints = { authorize: loop(cfg.authorize) || def.http.authorize, token: loop(cfg.token) || def.http.token };
      this.apiBase = loop(cfg.api);
      this.redirectPort = (!live && Number.isInteger(cfg.port) ? cfg.port : null) ?? def.http.port ?? null;
      this.resource = `http|${this.endpoints.token}|${def.http.clientId}|${[...def.http.hosts].sort().join(",")}`;
      this.httpRate = null;
    }
    // interval and budget — from the plugin declaration (or config.json on top) within core limits
    ({ intervalMs: this.intervalMs, dailyBudget: this.dailyBudget } = connectorLimits(def, cfg, { live }));
    this.loginTimeoutMs = Math.max(1000, Number(cfg.loginTimeoutMs) || 300_000);
    this.callWaitMs = Math.max(100, Number(cfg.callWaitMs) || 3000);
    this.fetchImpl = svc.fetchImpl;
    this.reloadMs = Math.max(10, Number(cfg.reloadMs) || 60_000);
    this.state = "unknown"; // unknown | unavailable | disconnected | connecting | connected | expired
    this.since = Date.now();
    this.error = null;
    this.errorReason = null; // refinement of the login error code (discovery: resource-mismatch, issuer-url, …)
    this.reloadTimer = null;
    this.tokenMeta = null; // { expiresAt, scope, refresh, obtainedAt } — without values
    this.login = null; // { lb, startedAt, expiresAt, prev }
    this.meta = null; // { value, at }
    this.session = new McpSession({ url: this.resource, fetchImpl: this.fetchImpl, clientInfo: { name: "agent-hub", version: VERSION || "0" } });
    this.cache = new Map(); // request key → { at, result }
    this.errors = new Map(); // request key → { error, errorText?, at } — the last error until a successful call
    this.inflight = new Map();
    // calls let through the gate whose network request has not been counted yet (the keychain read, a refresh in between):
    // gate() counts them, so parallel requests cannot all pass before the first one is recorded (review 2026-11-12)
    this.reservedCalls = 0;
    this.file = join(this.ctx.config.paths.pluginCache, `oauth-${def.id}.json`);
    this.orphan = false; // plugin removed, login stayed (Service.orphan)
    this.persist = this.loadPersist();
  }
  get id() {
    return this.def.id;
  }
  store() {
    return this.ctx.facts.get("secrets.store") || null;
  }

  // ---------- state ----------
  loadPersist() {
    try {
      const o = JSON.parse(readFileSync(this.file, "utf8"));
      return {
        calls: Array.isArray(o.calls) ? o.calls.filter((x) => Number.isFinite(x)).slice(-callsCap(this.dailyBudget)) : [],
        backoff: o.backoff && Number.isFinite(o.backoff.until) ? { n: Number(o.backoff.n) || 1, until: Math.min(o.backoff.until, Date.now() + DAY_MS), reason: BACKOFF_REASONS.has(o.backoff.reason) ? o.backoff.reason : "error" } : null,
        authFailedAt: Number.isFinite(o.authFailedAt) ? o.authFailedAt : null,
        lastOkAt: Number.isFinite(o.lastOkAt) ? o.lastOkAt : null,
      };
    } catch {
      return { calls: [], backoff: null, authFailedAt: null, lastOkAt: null };
    }
  }
  savePersist() {
    try {
      mkdirSync(this.ctx.config.paths.pluginCache, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      // who declared it and what it was called — to show an "orphaned" login after the plugin is removed (no tokens)
      writeFileSync(tmp, JSON.stringify({ ...this.persist, plugin: this.def.plugin, title: this.def.title }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {}
  }
  setState(state, { error, reason } = {}) {
    if (error !== undefined) {
      this.error = error;
      this.errorReason = error ? reason || null : null;
    }
    if (state !== this.state) {
      this.state = state;
      this.since = Date.now();
    }
    this.svc.changed();
  }
  async load() {
    this.loadedAt = Date.now();
    const store = this.store();
    if (!store || !store.available) {
      this.state = "unavailable";
      return;
    }
    let token;
    try {
      token = await store.get(`${this.id}.token`);
    } catch (e) {
      // the keychain didn't answer (timeout, locked): not "not connected" — state unknown, re-read later
      this.state = "unknown";
      this.error = "keychain-read";
      this.ctx.journal.write({ type: "oauth-keychain-failed", connector: this.id, op: "load", error: e?.code || "read" });
      this.scheduleReload();
      return;
    }
    clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    if (this.error === "keychain-read") this.error = null;
    if (this.orphan) {
      // no plugin: all that matters is whether the login is in the keychain (we don't check the URL — there won't be calls)
      this.tokenMeta = token && typeof token.accessToken === "string" ? { expiresAt: token.expiresAt || null, scope: token.scope || null, refresh: Boolean(token.refreshToken), obtainedAt: token.obtainedAt || null } : null;
      this.state = this.tokenMeta ? "connected" : "disconnected";
      return;
    }
    if (token && typeof token.accessToken === "string" && !token.resource) token = await this.pinLegacy(store, token);
    if (!token || typeof token.accessToken !== "string" || !this.tokenFits(token)) {
      if (token && typeof token.accessToken === "string") this.ctx.journal.write({ type: token.resource ? "oauth-resource-changed" : "oauth-resource-unknown", connector: this.id });
      this.tokenMeta = null;
      this.state = "disconnected";
      return;
    }
    this.tokenMeta = { expiresAt: token.expiresAt || null, scope: token.scope || null, refresh: Boolean(token.refreshToken), obtainedAt: token.obtainedAt || null };
    this.state = this.expiredNow(Date.now()) ? "expired" : "connected";
  }
  // The token was issued for this resource URL. An entry predating contract 2 doesn't remember the URL: pinLegacy pins it (only for
  // built-in and official); if it didn't get pinned (the keychain didn't write) — accepted for those and only those.
  tokenFits(token) {
    if (!token?.resource) return this.kind === "mcp" && LEGACY_TOKEN_TIERS.has(this.def.tier);
    return token.resource === this.resource;
  }
  // A login predating contract 2 (no resource URL): trust on first use. If a built-in or official plugin (signed index)
  // declared the connection, the login is pinned to the declared URL right away, and the next URL change
  // will require a new login. An own plugin may have taken the same id after the official one was removed — it doesn't
  // get the login. → token (with resource if pinned)
  async pinLegacy(store, token) {
    if (this.kind !== "mcp" || !LEGACY_TOKEN_TIERS.has(this.def.tier)) return token;
    const next = { ...token, resource: this.resource };
    let w = { ok: false };
    try {
      w = await store.set(`${this.id}.token`, next);
    } catch {}
    this.ctx.journal.write({ type: "oauth-resource-pinned", connector: this.id, host: this.def.hosts[0] || null, stored: Boolean(w?.ok) });
    return w?.ok ? next : token;
  }
  scheduleReload() {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(async () => {
      this.reloadTimer = null;
      if (this.state !== "unknown" || this.login) return;
      try {
        await this.load();
      } catch {}
      this.svc.changed();
    }, this.reloadMs);
    this.reloadTimer.unref?.();
  }
  expiredNow(now) {
    const t = this.tokenMeta;
    if (!t) return false;
    if (this.persist.authFailedAt && (!t.obtainedAt || this.persist.authFailedAt >= t.obtainedAt)) return true;
    return Boolean(t.expiresAt && t.expiresAt <= now && !t.refresh);
  }
  calls24h(now) {
    return this.persist.calls.filter((t) => now - t < DAY_MS).length;
  }
  // Reserve one call right after gate() let it through, before any await. → release() (idempotent): the call was counted
  // (recordCall) or never reached the network.
  reserveCall() {
    this.reservedCalls++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.reservedCalls--;
    };
  }
  // A request goes to the service now: count it (and turn the reservation, if any, into the real mark).
  recordCall(release) {
    release?.();
    this.persist.calls.push(Date.now());
    this.persist.calls = this.persist.calls.filter((t) => Date.now() - t < DAY_MS).slice(-callsCap(this.dailyBudget));
  }
  // The earliest time the service may be called, and the reason. → { until, why }
  gate(now) {
    let until = 0;
    let why = null;
    const b = this.persist.backoff;
    if (b && b.until > now) {
      until = b.until;
      why = b.reason;
    }
    const r = this.kind === "http" ? this.httpRate : this.session.httpRate;
    if (r && r.remaining !== null && r.remaining <= 2 && r.resetMs && r.resetMs > now && r.resetMs > until) {
      until = r.resetMs;
      why = "http-limit";
    }
    const limit = Math.max(1, this.dailyBudget - BUDGET_RESERVE);
    // reserved calls are about to be made: they count as made now
    const recent = [...this.persist.calls.filter((t) => now - t < DAY_MS), ...Array(this.reservedCalls).fill(now)].sort((a, b) => a - b);
    if (recent.length >= limit) {
      const at = recent[recent.length - limit] + DAY_MS;
      if (at > until) {
        until = at;
        why = "budget";
      }
    }
    return { until, why };
  }
  info(now = Date.now()) {
    const g = this.gate(now);
    const lastAt = Math.max(0, ...[...this.cache.values()].map((e) => e.at));
    const nextAt = Math.max(lastAt ? lastAt + this.intervalMs : 0, g.until);
    return {
      id: this.id,
      title: this.def.title,
      note: this.def.note || null,
      plugin: this.def.plugin,
      ...(this.orphan ? { orphan: true } : {}),
      host: this.def.hosts[0] || this.hosts[0] || null,
      tools: [...this.def.tools],
      // mcp | http (G7); for http — the API hosts the token goes to, allowed methods and path prefixes
      type: this.kind,
      ...(this.kind === "http" ? { apiHosts: [...this.def.http.hosts], methods: [...this.def.http.methods], paths: [...(this.def.http.paths || [])] } : {}),
      state: this.state,
      since: iso(this.since),
      error: this.error,
      errorReason: this.errorReason,
      scope: this.tokenMeta?.scope || null,
      // what the connection asks for at login (scope= from the plugin declaration); the scope above is what the server granted
      requestedScope: this.def.scope || null,
      expiresAt: iso(this.tokenMeta?.expiresAt),
      refresh: this.tokenMeta ? this.tokenMeta.refresh : null,
      login: this.login ? { startedAt: iso(this.login.startedAt), expiresAt: iso(this.login.expiresAt) } : null,
      intervalMs: this.intervalMs,
      dailyBudget: this.dailyBudget,
      calls24h: this.calls24h(now),
      lastOkAt: iso(this.persist.lastOkAt),
      nextAt: this.state === "connected" && nextAt > now ? iso(nextAt) : null,
      why: g.until > now ? g.why : null,
      keychain: this.state !== "unavailable",
    };
  }

  // ---------- login ----------
  async discovery() {
    const now = Date.now();
    if (this.meta && now - this.meta.at < META_TTL_MS) return this.meta.value;
    if (this.kind === "http") {
      const value = staticMeta(this.endpoints, { hosts: this.hosts, loopback: this.loopback });
      this.meta = { value, at: now };
      return value;
    }
    const value = await discover(this.resource, { hosts: this.hosts, loopback: this.loopback, fetchImpl: this.fetchImpl });
    this.meta = { value, at: now };
    return value;
  }
  abortLogin() {
    const l = this.login;
    if (!l) return false;
    this.login = null;
    l.lb.close();
    return true;
  }
  async connect() {
    if (this.orphan) throw new OAuthError("orphan");
    const store = this.store();
    if (!store || !store.available) throw new OAuthError("no-keychain");
    const prev = this.login ? this.login.prev : this.state;
    this.abortLogin();
    let meta;
    try {
      meta = await this.discovery();
    } catch (e) {
      this.meta = null;
      throw e;
    }
    let client;
    try {
      // a pre-registered client (http) is the declaration itself: nothing is stored
      client = this.kind === "http" ? null : await store.get(`${this.id}.client`);
    } catch {
      throw new OAuthError("keychain-read");
    }
    if (client && (client.issuer !== meta.issuer || typeof client.clientId !== "string" || typeof client.redirectUri !== "string")) client = null;
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const lang = this.ctx.lang();
    const holder = { client: null };
    const opts = {
      state,
      issuer: meta.issuer,
      requireIss: meta.issParam,
      timeoutMs: this.loginTimeoutMs,
      page: (kind, code) => page(lang, kind, code, this.def.title),
      onCode: (code) => this.finishLogin(code, holder.client, verifier, meta),
    };
    let wantPort = 0;
    try {
      wantPort = client ? Number(new URL(client.redirectUri).port) || 0 : 0;
    } catch {}
    let lb;
    if (this.kind === "http" && this.redirectPort) {
      // the service registered an exact redirect URI: that port or nothing
      try {
        lb = await startLoopback({ ...opts, port: this.redirectPort });
      } catch {
        throw new OAuthError("port-busy", { reason: String(this.redirectPort) });
      }
    } else {
      try {
        lb = await startLoopback({ ...opts, port: wantPort });
      } catch {
        lb = await startLoopback({ ...opts, port: 0 });
      }
    }
    try {
      if (this.kind === "http") client = { clientId: this.def.http.clientId, redirectUri: lb.redirectUri, issuer: null, grantTypes: ["authorization_code", "refresh_token"] };
      else if (!client || client.redirectUri !== lb.redirectUri) {
        client = await registerClient(meta, { redirectUri: lb.redirectUri, scope: this.def.scope, fetchImpl: this.fetchImpl });
        const w = await store.set(`${this.id}.client`, client);
        if (!w.ok) throw new OAuthError("keychain");
        this.ctx.journal.write({ type: "oauth-client-registered", connector: this.id, grants: client.grantTypes });
      }
    } catch (e) {
      lb.close();
      throw e;
    }
    holder.client = client;
    const startedAt = Date.now();
    const login = { lb, startedAt, expiresAt: startedAt + this.loginTimeoutMs, prev: prev === "connecting" ? "disconnected" : prev };
    this.login = login;
    lb.result.then(
      () => {},
      (e) => {
        if (this.login !== login) return;
        this.login = null;
        const code = e?.code || "authorize";
        this.ctx.journal.write({ type: "oauth-login-failed", connector: this.id, error: code });
        this.setState(login.prev, { error: code === "aborted" ? null : code });
      },
    );
    this.ctx.journal.write({ type: "oauth-login-start", connector: this.id, port: lb.port, scope: this.def.scope });
    this.setState("connecting", { error: null });
    // declared scope words that the server lists for itself (if the server lists none — we ask for nothing special)
    // http: no server metadata — the declared scope as is
    const scope = this.kind === "http" ? this.def.scope || null : String(this.def.scope || "").split(" ").filter((w) => w && meta.scopes.includes(w)).join(" ") || null;
    return { authorizeUrl: authorizeUrl(meta, client, { state, challenge, scope }), expiresAt: iso(login.expiresAt) };
  }
  async finishLogin(code, client, verifier, meta) {
    const login = this.login;
    try {
      const token = { ...(await exchangeCode(meta, client, { code, verifier, fetchImpl: this.fetchImpl })), resource: this.resource };
      const w = await this.store().set(`${this.id}.token`, token);
      if (!w.ok) throw new OAuthError("keychain");
      this.tokenMeta = { expiresAt: token.expiresAt, scope: token.scope, refresh: Boolean(token.refreshToken), obtainedAt: token.obtainedAt };
      this.persist.authFailedAt = null;
      if (this.persist.backoff?.reason === "error") this.persist.backoff = null;
      this.savePersist();
      this.cache.clear();
      this.errors.clear();
      this.session.reset();
      if (this.login === login) this.login = null;
      this.ctx.journal.write({ type: "oauth-connected", connector: this.id, scope: token.scope, refresh: Boolean(token.refreshToken), expiresInS: token.expiresAt ? Math.round((token.expiresAt - Date.now()) / 1000) : null });
      this.setState("connected", { error: null });
      this.svc.refreshPlugin(this.def.plugin);
      return { ok: true };
    } catch (e) {
      const c = e?.code || "exchange";
      if (this.login === login) this.login = null;
      this.ctx.journal.write({ type: "oauth-login-failed", connector: this.id, error: c, status: e?.status ?? null });
      this.setState(login?.prev || "disconnected", { error: c });
      return { ok: false, code: c };
    }
  }
  cancel() {
    const l = this.login;
    if (!this.abortLogin()) return false;
    this.ctx.journal.write({ type: "oauth-login-cancelled", connector: this.id });
    this.setState(l.prev, { error: null });
    return true;
  }
  async disconnect() {
    const prev = this.login ? this.login.prev : this.state;
    this.abortLogin();
    const store = this.store();
    // token first: if it wasn't deleted, the login stays in the keychain and after a restart it's "Connected" again. Then the state is
    // unchanged, error keychain-delete ("press "Disconnect" again")
    const r1 = store ? await store.delete(`${this.id}.token`) : { ok: true };
    if (!r1.ok) {
      this.ctx.journal.write({ type: "oauth-disconnected", connector: this.id, ok: false, error: r1.error || "keychain" });
      this.setState(prev === "connecting" ? "disconnected" : prev, { error: "keychain-delete" });
      return { ok: false, error: "keychain-delete" };
    }
    const r2 = store ? await store.delete(`${this.id}.client`) : { ok: true };
    this.tokenMeta = null;
    this.cache.clear();
    this.errors.clear();
    this.session.reset();
    this.meta = null;
    this.persist.authFailedAt = null;
    this.savePersist();
    const ok = r2.ok;
    this.ctx.journal.write({ type: "oauth-disconnected", connector: this.id, ok, ...(ok ? {} : { error: r2.error || "keychain" }) });
    // no token — "not connected" is true; the client registration (no secret) stayed — another "Disconnect" will remove it
    this.setState(store && store.available ? "disconnected" : "unavailable", { error: ok ? null : "keychain-delete" });
    this.svc.refreshPlugin(this.def.plugin);
    return ok ? { ok } : { ok, error: "keychain-delete" };
  }
  markExpired(reason) {
    this.persist.authFailedAt = Date.now();
    this.savePersist();
    this.session.reset();
    this.cache.clear();
    this.errors.clear();
    this.ctx.journal.write({ type: "oauth-expired", connector: this.id, reason });
    this.setState("expired", { error: reason });
  }

  // ---------- MCP calls ----------
  // → { token } | { expired: reason } (login needed) | { error: code } (temporary failure: keychain, network during refresh).
  // Refreshes ahead of time if the expiry is close and there's a refresh token.
  async accessToken(now) {
    const store = this.store();
    if (!store) return { expired: "token-expired" };
    let token;
    try {
      token = await store.get(`${this.id}.token`);
    } catch {
      return { error: "keychain-read" };
    }
    if (!token || typeof token.accessToken !== "string" || !this.tokenFits(token)) return { expired: "token-expired" };
    if (token.expiresAt && token.expiresAt - now < 60_000) {
      if (!token.refreshToken) return { expired: "token-expired" };
      const r = await this.refresh(token);
      // refresh failed due to an outage, but the old token is still alive — call with it
      if (r.error && token.expiresAt - now > 5_000) return { token: token.accessToken };
      return r;
    }
    return { token: token.accessToken };
  }
  // → { token } | { expired } (no refresh token or the server answered invalid_grant) | { error } (network, 5xx, keychain).
  async refresh(token) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const store = this.store();
        if (!store) return { expired: "token-expired" };
        let t;
        let client;
        try {
          t = token || (await store.get(`${this.id}.token`));
          client = this.kind === "http" ? { clientId: this.def.http.clientId, redirectUri: null } : await store.get(`${this.id}.client`);
        } catch {
          return { error: "keychain-read" };
        }
        if (!t?.refreshToken || !client || !this.tokenFits(t)) return { expired: "token-expired" };
        const meta = await this.discovery();
        const next = { ...(await refreshAccess(meta, client, t, { fetchImpl: this.fetchImpl })), resource: this.resource };
        const w = await store.set(`${this.id}.token`, next);
        if (w.ok) this.tokenMeta = { expiresAt: next.expiresAt, scope: next.scope, refresh: Boolean(next.refreshToken), obtainedAt: next.obtainedAt };
        this.ctx.journal.write({ type: "oauth-refreshed", connector: this.id, rotated: next.refreshToken !== t.refreshToken, stored: w.ok });
        // not written — this call's token is still valid; the next refresh will show whether the old refresh token is alive
        return { token: next.accessToken };
      } catch (e) {
        const code = e?.code || "refresh";
        this.ctx.journal.write({ type: "oauth-refresh-failed", connector: this.id, error: code, status: e?.status ?? null });
        if (code === "invalid-grant") return { expired: "invalid-grant" };
        if (code === "discovery") this.meta = null;
        return { error: "refresh" };
      } finally {
        setTimeout(() => (this.refreshing = null), 0);
      }
    })();
    return this.refreshing;
  }
  // Backoff: rate (limit), forbidden (403), tool (isError), error (other). → reason (why)
  backoff(kind, e = {}) {
    const reason = kind === "rate" ? "rate-limit" : kind === "forbidden" ? "forbidden" : kind === "tool" ? "tool-error" : "error";
    const b = this.persist.backoff;
    const n = (b?.reason === reason ? b.n : 0) + 1;
    let wait;
    if (kind === "rate") wait = Math.min(e.retryAfterMs || RATE_BACKOFF_MS[Math.min(n, RATE_BACKOFF_MS.length) - 1], DAY_MS);
    else if (kind === "forbidden") wait = FORBIDDEN_BACKOFF_MS;
    else wait = Math.min(ERROR_BACKOFF_MS[Math.min(n, ERROR_BACKOFF_MS.length) - 1], this.intervalMs);
    this.persist.backoff = { n, until: Date.now() + wait, reason };
    this.savePersist();
    return reason;
  }
  // A temporary login failure (keychain didn't answer, token refresh failed due to network or server): not expiry.
  softFail(tool, code) {
    this.backoff("error");
    this.ctx.journal.write({ type: "mcp-call-failed", connector: this.id, tool, kind: "oauth", status: null, reason: code, waitS: Math.round((this.persist.backoff.until - Date.now()) / 1000) });
    this.svc.changed();
    return { error: `oauth:${code}` };
  }
  async doCall(tool, args, key, { fresh = false, release = null } = {}) {
    const now = Date.now();
    const a = await this.accessToken(now);
    if (a.expired) {
      this.markExpired(a.expired);
      return { error: "oauth:expired" };
    }
    if (a.error) return this.softFail(tool, a.error);
    let token = a.token;
    const deadlineAt = now + 20_000;
    let attempt = 0;
    for (;;) {
      this.recordCall(release);
      try {
        const { result } = await this.session.callTool(token, tool, args, { deadlineAt });
        const at = Date.now();
        if (result.isError) {
          // a tool error (not a limit) is not a successful refresh: the previous result stays, lastOkAt untouched
          const errorText = toolErrorText(result);
          if (fresh) {
            // a write refused by the tool (validation and the like): the service is fine — no backoff, nothing remembered
            this.ctx.journal.write({ type: "mcp-call-failed", connector: this.id, tool, kind: "tool", status: null, reason: null, waitS: 0, fresh: true });
            return { error: "mcp:tool-error", errorText };
          }
          this.errors.set(key, { error: "mcp:tool-error", errorText, at });
          this.backoff("tool");
          this.ctx.journal.write({ type: "mcp-call-failed", connector: this.id, tool, kind: "tool", status: null, reason: null, waitS: Math.round((this.persist.backoff.until - Date.now()) / 1000) });
          this.svc.changed();
          return { error: "mcp:tool-error", errorText };
        }
        if (!fresh) {
          // a write finished while this read was in flight: the result may predate it — keep it, but stale
          this.cache.set(key, { at, result, ...(this.freshAt > now ? { stale: true } : {}) });
          if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
          this.errors.delete(key);
        }
        this.persist.backoff = null;
        this.persist.lastOkAt = at;
        this.savePersist();
        if (CALL_ERRORS.has(this.error)) this.error = null;
        this.svc.changed();
        return { result, at };
      } catch (e) {
        const kind = e instanceof McpError ? e.kind : "net";
        if (kind === "auth") {
          if (attempt === 0 && this.tokenMeta?.refresh) {
            attempt++;
            const r = await this.refresh(null);
            if (r.token) {
              token = r.token;
              continue;
            }
            if (r.error) return this.softFail(tool, r.error);
          }
          this.savePersist();
          this.markExpired(e.authError === "invalid_token" ? "invalid-token" : `http-${e.status}`);
          return { error: "oauth:expired" };
        }
        if (kind === "forbidden") {
          // 403: the login lacks permissions (insufficient_scope) — re-login with the same scope won't help
          this.backoff("forbidden");
          this.errors.set(key, { error: "mcp:forbidden", at: Date.now() });
          this.ctx.journal.write({ type: "mcp-call-failed", connector: this.id, tool, kind, status: e.status ?? null, reason: e.authError || null, waitS: Math.round((this.persist.backoff.until - Date.now()) / 1000) });
          this.setState(this.state, { error: "forbidden", reason: e.authError || null });
          return { error: "mcp:forbidden" };
        }
        this.backoff(kind === "rate" ? "rate" : "error", e);
        this.ctx.journal.write({ type: "mcp-call-failed", connector: this.id, tool, kind, status: e.status ?? null, reason: e.reason || null, waitS: Math.round((this.persist.backoff.until - Date.now()) / 1000) });
        this.svc.changed();
        return { error: kind === "rate" ? "mcp:rate-limited" : `mcp:${kind}` };
      }
    }
  }
  // A fresh call (a write or an explicit refresh): gated — 429 <kind>:wait; otherwise straight to the service. → { status, body }
  // o — { exec(fresh) → {result, at} | {error, …}, what (journal fields), field (reply key: result | response) }
  async callFresh(plugin, key, now, o) {
    const meta = (t = Date.now()) => ({ intervalMs: this.intervalMs, calls24h: this.calls24h(t), dailyBudget: this.dailyBudget });
    const g = this.gate(now);
    if (g.until > now) return { status: 429, body: { error: `${this.kind}:wait`, why: g.why, nextAt: iso(g.until), ...meta(now) } };
    // reserved before the first await: parallel fresh calls see each other in gate()
    const release = this.reserveCall();
    const started = Date.now();
    let r;
    try {
      r = await o.exec(true, release);
    } finally {
      release();
    }
    this.ctx.journal.write({ type: `${this.kind}-call`, connector: this.id, plugin: plugin.id, ...o.what, fresh: true, ok: !r.error, ...(r.error ? { error: r.error } : {}), ms: Date.now() - started });
    if (r.error === "oauth:expired") return { status: 409, body: { error: r.error, connection: this.info() } };
    if (r.error) return { status: 200, body: { ok: false, [o.field]: r.result ?? null, fetchedAt: null, nextAt: null, why: null, fresh: false, error: r.error, ...(r.errorText ? { errorText: r.errorText } : {}), ...meta() } };
    this.invalidate(plugin.id);
    return { status: 200, body: { ok: true, [o.field]: r.result, fetchedAt: iso(r.at), nextAt: null, why: null, fresh: true, ...meta() } };
  }
  // A plugin's cached results of this connection become stale (after a successful fresh call): the next ordinary call
  // goes to the service, a gated one still gets the previous result.
  invalidate(pluginId) {
    this.freshAt = Date.now();
    const prefix = `${pluginId}|`;
    for (const [k, e] of this.cache) if (k.startsWith(prefix)) e.stale = true;
  }
  // A call on behalf of a plugin. fresh — a write or an explicit refresh (see the header). → { status, body }
  async call(plugin, tool, args, { fresh = false } = {}) {
    if (this.orphan) return { status: 409, body: { error: "oauth:orphan" } };
    if (this.kind !== "mcp") return { status: 400, body: { error: "mcp:not-mcp" } };
    if (!this.def.tools.includes(tool)) return { status: 403, body: { error: "mcp:tool-not-allowed" } };
    const argsObj = args === undefined || args === null ? {} : args;
    if (typeof argsObj !== "object" || Array.isArray(argsObj)) return { status: 400, body: { error: "args:args:type" } };
    const key = `${plugin.id}|${tool}|${stable(argsObj)}`;
    if (Buffer.byteLength(key) > MAX_ARGS_BYTES) return { status: 413, body: { error: "too-large" } };
    return this.serve(plugin, key, { fresh, field: "result", what: { tool }, exec: (f, release) => this.doCall(tool, argsObj, key, { fresh: f, release }) });
  }
  // An HTTP request on behalf of a plugin (type http, G7). body — {method, host?, path, query?, headers?, body?, fresh?}.
  // GET/HEAD — reads (interval cache unless fresh); other methods — writes (always fresh). → { status, body }
  async httpRequest(plugin, body) {
    if (this.orphan) return { status: 409, body: { error: "oauth:orphan" } };
    if (this.kind !== "http") return { status: 400, body: { error: "http:not-http" } };
    if (body?.fresh !== undefined && typeof body.fresh !== "boolean") return { status: 400, body: { error: "args:fresh:type" } };
    const rq = normalizeHttpRequest(body, this.def.http);
    if (rq.error) {
      const st = rq.error === "too-large" ? 413 : rq.error.startsWith("http:") ? 403 : 400;
      return { status: st, body: { error: rq.error, ...(rq.header ? { header: rq.header } : {}), ...(rq.key ? { key: rq.key } : {}) } };
    }
    // the plugin's own network permission covers the host it asks for (the core checked it at declaration; checked again here)
    const net = (plugin.net || []).map((e) => String(e).split(/\s+[—–-]{1,2}\s+/)[0].trim().toLowerCase());
    if (!net.includes(rq.host)) return { status: 403, body: { error: "http:net-not-declared" } };
    const read = rq.method === "GET" || rq.method === "HEAD";
    const key = `${plugin.id}|${rq.method}|${rq.host}|${rq.path}|${stable(rq.query)}|${stable(rq.headers)}${read ? "" : `|${createHash("sha256").update(rq.body || "").digest("hex").slice(0, 16)}`}`;
    if (Buffer.byteLength(key) > 4 * MAX_ARGS_BYTES) return { status: 413, body: { error: "too-large" } };
    const what = { method: rq.method, host: rq.host, path: rq.path.slice(0, 120) };
    return this.serve(plugin, key, { fresh: body.fresh === true || !read, field: "response", what, exec: (f, release) => this.doHttp(rq, key, { fresh: f, release }) });
  }
  // The shared call flow: state checks, the interval cache, merging identical calls in flight, fresh calls. → { status, body }
  async serve(plugin, key, o) {
    const fresh = o.fresh === true;
    if (this.state === "unknown") {
      await this.svc.loaded;
      await this.loading;
      // the keychain didn't answer at startup — re-read now instead of waiting for a daemon restart
      if (this.state === "unknown" && !this.login && Date.now() - (this.loadedAt || 0) > 5_000) await this.load().catch(() => {});
    }
    const reply = (extra) => {
      const e = this.cache.get(key) || null;
      const err = this.errors.get(key) || null;
      const t = Date.now();
      const gg = this.gate(t);
      const due = e && !e.stale ? e.at + this.intervalMs : t;
      const nextAt = Math.max(due, gg.until);
      return {
        status: 200,
        body: {
          ok: Boolean(e),
          [o.field]: e ? e.result : null,
          fetchedAt: iso(e?.at),
          nextAt: iso(nextAt),
          why: gg.until >= due && gg.until > t ? gg.why : "interval",
          intervalMs: this.intervalMs,
          calls24h: this.calls24h(t),
          dailyBudget: this.dailyBudget,
          ...(err ? { error: err.error, ...(err.errorText ? { errorText: err.errorText } : {}) } : {}),
          ...extra,
        },
      };
    };
    const now = Date.now();
    // the keychain still didn't answer — not "not connected": the previous result (if any) and the reason, retry later
    if (this.state === "unknown") return reply({ fresh: false, error: "oauth:keychain-read" });
    if (this.state !== "connected" && !(this.state === "connecting" && this.tokenMeta && !this.expiredNow(now))) {
      const error = this.state === "expired" ? "oauth:expired" : this.state === "unavailable" ? "oauth:unavailable" : "oauth:not-connected";
      return { status: 409, body: { error, connection: this.info(now) } };
    }
    if (fresh) return this.callFresh(plugin, key, now, o);
    const entry = this.cache.get(key) || null;
    const g = this.gate(now);
    if (entry && !entry.stale && now - entry.at < this.intervalMs) return reply({ fresh: false });
    if (g.until > now) return reply({ fresh: false });
    let p = this.inflight.get(key);
    if (!p) {
      const started = Date.now();
      const release = this.reserveCall();
      p = o.exec(false, release).finally(release).then((r) => {
        this.ctx.journal.write({ type: `${this.kind}-call`, connector: this.id, plugin: plugin.id, ...o.what, ok: !r.error, ...(r.error ? { error: r.error } : {}), ms: Date.now() - started });
        return r;
      });
      p.finally(() => this.inflight.delete(key)).catch(() => {});
      this.inflight.set(key, p);
    }
    let timer;
    const r = await Promise.race([p, new Promise((res) => (timer = setTimeout(() => res(null), this.callWaitMs)))]);
    clearTimeout(timer);
    if (!r) return reply({ fresh: false, pending: true });
    if (r.error === "oauth:expired") return { status: 409, body: { error: r.error, connection: this.info() } };
    if (r.error) return reply({ fresh: false, error: r.error, ...(r.errorText ? { errorText: r.errorText } : {}) });
    return reply({ fresh: true });
  }
  // One proxied HTTP request with the token (type http): 401 — one refresh and a retry, then expired; 429 and 503 with
  // Retry-After — a rate backoff; 5xx and network failures — an error backoff (not for a fresh write: the reply says what
  // happened); other statuses are the service's answer — a read is cached (a 4xx too: "not found" is an answer).
  // → { result, at } | { error, result? }
  async doHttp(rq, key, { fresh = false, release = null } = {}) {
    const label = `${rq.method} ${rq.host}`;
    const now = Date.now();
    const a = await this.accessToken(now);
    if (a.expired) {
      this.markExpired(a.expired);
      return { error: "oauth:expired" };
    }
    if (a.error) return this.softFail(label, a.error);
    let token = a.token;
    let attempt = 0;
    const base = this.apiBase || `https://${rq.host}`;
    for (;;) {
      this.recordCall(release);
      let res;
      try {
        res = await proxyFetch(rq, token, { base, fetchImpl: this.fetchImpl });
      } catch (e) {
        if (!fresh) this.backoff("error");
        this.ctx.journal.write({ type: "http-call-failed", connector: this.id, request: label, kind: "net", status: null, reason: e?.reason || null, waitS: fresh ? 0 : Math.round((this.persist.backoff.until - Date.now()) / 1000) });
        if (!fresh) this.errors.set(key, { error: "http:net", at: Date.now() });
        this.svc.changed();
        return { error: "http:net" };
      }
      if (res.rate) {
        const r = res.rate.reset;
        const resetMs = !r ? null : r > 1e12 ? r : r > 1e9 ? r * 1000 : Date.now() + r * 1000;
        this.httpRate = { remaining: res.rate.remaining, resetMs, at: Date.now() };
      }
      const { rate, retryAfter, ...response } = res;
      if (res.status === 401) {
        if (attempt === 0 && this.tokenMeta?.refresh) {
          attempt++;
          const r = await this.refresh(null);
          if (r.token) {
            token = r.token;
            continue;
          }
          if (r.error) return this.softFail(label, r.error);
        }
        this.savePersist();
        this.markExpired("http-401");
        return { error: "oauth:expired" };
      }
      if (res.status === 429 || (res.status === 503 && retryAfter)) {
        // Retry-After: seconds or an HTTP date (→ epoch ms); retryAfterMs clamps it to 1 min … 24 h
        const ra = retryAfter ? (/^\d+$/.test(retryAfter.trim()) ? retryAfterMs(Number(retryAfter)) : retryAfterMs(Date.parse(retryAfter))) : null;
        this.backoff("rate", { retryAfterMs: ra });
        this.ctx.journal.write({ type: "http-call-failed", connector: this.id, request: label, kind: "rate", status: res.status, reason: null, waitS: Math.round((this.persist.backoff.until - Date.now()) / 1000) });
        if (!fresh) this.errors.set(key, { error: "http:rate-limited", at: Date.now() });
        this.svc.changed();
        return { error: "http:rate-limited", result: response };
      }
      if (res.status >= 500) {
        if (!fresh) {
          this.backoff("error");
          this.errors.set(key, { error: "http:server-error", at: Date.now() });
        }
        this.ctx.journal.write({ type: "http-call-failed", connector: this.id, request: label, kind: "server", status: res.status, reason: null, waitS: fresh ? 0 : Math.round((this.persist.backoff.until - Date.now()) / 1000) });
        this.svc.changed();
        return { error: "http:server-error", result: response };
      }
      const at = Date.now();
      if (!fresh) {
        this.cache.set(key, { at, result: response, ...(this.freshAt > now ? { stale: true } : {}) });
        if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
        this.errors.delete(key);
      }
      this.persist.backoff = null;
      this.persist.lastOkAt = at;
      this.savePersist();
      if (CALL_ERRORS.has(this.error)) this.error = null;
      this.svc.changed();
      return { result: response, at };
    }
  }
}

class Service {
  constructor(ctx, { fetchImpl } = {}) {
    this.ctx = ctx;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.cfg = ctx.config.services?.oauth || {};
    this.connectors = new Map(); // connection id → Connector
    this.sigs = new Map(); // plugin id → fingerprint of its declarations (don't rebuild on every frame)
    this.emitTimer = null;
    this.started = false;
    this.loaded = null;
  }
  list() {
    const now = Date.now();
    return [...this.connectors.values()].map((c) => c.info(now)).sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  changed() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.ctx.emit({ type: "connections.changed", connections: this.list() });
    }, 0);
    this.emitTimer.unref?.();
  }
  refreshPlugin(id) {
    if (id) this.ctx.refreshPlugin(id, "Manual");
  }
  // A plugin's connections from its state (connections — declarations already checked by the core, trusted plugins only).
  // New — create and read the keychain; URL, hosts or allowlist changed — recreate; gone — remove
  // (the login stays in the keychain: when the plugin comes back the connection is "Connected" again).
  syncPlugin(st) {
    if (!st || typeof st.id !== "string") return;
    const declared = Array.isArray(st.connections) ? st.connections : [];
    const sig = JSON.stringify([st.title, declared]);
    if (this.sigs.get(st.id) === sig) return;
    this.sigs.set(st.id, sig);
    const want = new Map(declared.map((c) => [c.id, defFromDeclared(st.id, st.title, c)]));
    // the plugin is back (or declared what remained from before): "orphaned" logins with its id become regular
    // connections again, the login is re-read from the keychain
    for (const [id, c] of [...this.connectors]) if (c.orphan && want.has(id)) this.drop(id, { quiet: true });
    for (const [id, c] of [...this.connectors]) {
      if (c.def.plugin !== st.id || c.orphan) continue;
      const d = want.get(id);
      // the plugin no longer declares the connection, but the login stayed in the keychain — "orphaned" (only "Disconnect")
      if (!d && (c.tokenMeta || c.error === "keychain-delete")) {
        this.orphan(c);
        continue;
      }
      if (d && JSON.stringify([d.resource, d.hosts, d.scope, d.tools, d.intervalMs, d.dailyBudget, d.type, d.http]) === JSON.stringify([c.def.resource, c.def.hosts, c.def.scope, c.def.tools, c.def.intervalMs, c.def.dailyBudget, c.def.type, c.def.http])) {
        c.def = d; // title and description — in the hub language
        want.delete(id);
        continue;
      }
      this.drop(id);
    }
    for (const [id, d] of want) {
      const owner = this.connectors.get(id);
      if (owner && owner.def.plugin !== st.id) {
        // a connection id belongs to one plugin (core.pluginConnections), so this is a race between two instances;
        // we don't remember the fingerprint: once freed, dropPlugin will reconcile this plugin again
        this.ctx.journal.write({ type: "connection-rejected", plugin: st.id, connection: id, why: "taken" });
        this.sigs.delete(st.id);
        continue;
      }
      const c = new Connector(this, d, this.cfg[id] || {});
      this.connectors.set(id, c);
      this.ctx.journal.write({ type: "connection-added", plugin: st.id, connection: id, host: d.hosts[0] || null });
      if (this.started) c.loading = c.load().catch(() => (c.state = "unavailable")).then(() => this.changed());
    }
    this.changed();
  }
  // Plugin removed. A restart (restart) is not a removal: connections, login and cache stay, the returning instance reconciles
  // them by fingerprint. Removal: if the login stayed in the keychain the connection is "orphaned" (only "Disconnect"), otherwise remove it.
  dropPlugin(pluginId, { restart = false } = {}) {
    if (restart) return;
    this.sigs.delete(pluginId);
    let any = false;
    for (const [id, c] of [...this.connectors]) {
      if (c.def.plugin !== pluginId || c.orphan) continue;
      any = true;
      if (c.tokenMeta || c.error === "keychain-delete") this.orphan(c);
      else this.drop(id);
    }
    if (any) {
      // a connection this plugin held may have been refused to another one ("taken") — reconcile the others
      for (const st of this.ctx.state.plugins?.() || []) if (st.id !== pluginId && !this.sigs.has(st.id)) this.syncPlugin(st);
      this.changed();
    }
  }
  orphan(c) {
    c.abortLogin();
    c.orphan = true;
    c.cache.clear();
    c.errors.clear();
    c.session.reset();
    c.state = c.tokenMeta ? "connected" : c.state;
    this.ctx.journal.write({ type: "connection-orphaned", plugin: c.def.plugin, connection: c.id });
  }
  drop(id, { quiet = false } = {}) {
    const c = this.connectors.get(id);
    if (!c) return;
    c.abortLogin();
    clearTimeout(c.reloadTimer);
    c.reloadTimer = null;
    this.connectors.delete(id);
    if (!quiet) this.ctx.journal.write({ type: "connection-removed", plugin: c.def.plugin, connection: id });
  }
  // "Disconnect" on an orphan: login deleted — the row is gone (and the counters file too).
  afterDisconnect(c, r) {
    if (!c.orphan || !r.ok) return;
    this.drop(c.id);
    try {
      rmSync(c.file, { force: true });
    } catch {}
    this.changed();
  }
  // Removing a plugin "with data" (plugins.removed, purge: true): the login of its connections is deleted with it.
  async purgePlugin(pluginId) {
    for (const c of [...this.connectors.values()]) {
      if (c.def.plugin !== pluginId) continue;
      c.orphan = true;
      const r = await c.disconnect();
      this.ctx.journal.write({ type: "connection-purged", plugin: pluginId, connection: c.id, ok: r.ok });
      this.afterDisconnect(c, r);
    }
  }
  // Logins left from removed plugins (Cache/oauth-<id>.json without a declaration): "orphaned" connections.
  findOrphans() {
    let names = [];
    try {
      names = readdirSync(this.ctx.config.paths.pluginCache);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names.slice(0, 500)) {
      const m = /^oauth-(.+)\.json$/.exec(n);
      if (!m || !CONNECTION_ID_RE.test(m[1]) || this.connectors.has(m[1])) continue;
      let o = {};
      try {
        o = JSON.parse(readFileSync(join(this.ctx.config.paths.pluginCache, n), "utf8")) || {};
      } catch {}
      const plugin = typeof o.plugin === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(o.plugin) ? o.plugin : m[1].split(".")[0];
      const title = typeof o.title === "string" && o.title.trim() && o.title.length <= 64 ? o.title.trim() : m[1];
      const c = new Connector(this, { id: m[1], tier: null, title, note: null, plugin, resource: "https://invalid.invalid/", hosts: [], scope: null, tools: [], intervalMs: null, dailyBudget: null, type: "mcp", http: null }, {});
      c.orphan = true;
      this.connectors.set(m[1], c);
      out.push(c);
    }
    return out;
  }
  async load() {
    this.started = true;
    for (const st of this.ctx.state.plugins()) this.syncPlugin(st);
    const orphans = this.findOrphans();
    for (const c of this.connectors.values()) {
      if (c.loading) continue;
      c.loading = c.load().catch(() => (c.state = "unavailable"));
    }
    await Promise.all([...this.connectors.values()].map((c) => c.loading));
    // an orphan without a login in the keychain is just an old counters file: don't show it (we don't touch the file — the keychain may not
    // have answered)
    for (const c of orphans) if (c.orphan && c.state === "disconnected" && this.connectors.get(c.id) === c) this.drop(c.id, { quiet: true });
    this.changed();
  }
  get(id) {
    return this.connectors.get(id) || null;
  }
  stop() {
    clearTimeout(this.emitTimer);
    for (const c of this.connectors.values()) {
      c.abortLogin();
      clearTimeout(c.reloadTimer);
      c.reloadTimer = null;
    }
  }
}

// Tool error text (isError) for the plugin: one line, no control characters, up to 300 chars.
export function toolErrorText(result) {
  const text = (Array.isArray(result?.content) ? result.content : []).map((c) => (c && typeof c.text === "string" ? c.text : "")).join(" ");
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || null;
}

// Checking the peer plugin: trusted, the very one that declared the connection, and with network access to the connection host.
export function pluginAllowed(pl, conn) {
  if (!pl) return "mcp:not-a-plugin";
  if (!pl.trusted) return "mcp:untrusted";
  if (pl.id !== conn.def.plugin) return "mcp:not-owner";
  const hosts = (pl.net || []).map((e) => String(e).split(/\s+[—–-]{1,2}\s+/)[0].trim().toLowerCase());
  // the real service host (not a test-mode double): this is the permission the plugin agreed to at install
  if (!conn.def.hosts.some((h) => hosts.includes(h.toLowerCase()))) return "mcp:net-not-declared";
  return null;
}

export async function start(ctx, opts = {}) {
  const svc = new Service(ctx, opts);
  running.set(ctx, svc);
  ctx.facts.provide("oauth.connections", () => svc.list());
  ctx.facts.provide("oauth.api", () => svc);
  // For plugins — the path to the hub socket (not a secret): this is how a trusted plugin calls POST /connections/:id/mcp.
  ctx.providePluginEnv(ENV_SOCKET, ctx.config.paths.socket);
  // Storage is provided by the secrets service — it starts later (alphabetically): we read the keychain once all services have started.
  let go;
  svc.loaded = new Promise((res) => (go = res)).then(() => svc.load());
  svc.onStarted = () => go();
  ctx.on("services.started", svc.onStarted);
  // plugins declare connections: appeared, changed, gone — reconcile the set
  svc.onPlugin = (ev) => svc.syncPlugin(ev?.plugin);
  svc.onRemoved = (ev) => svc.dropPlugin(ev?.plugin, { restart: ev?.restart === true });
  // removal "with data" from the plugin manager (POST /registry/remove with purge)
  svc.onUninstalled = (ev) => {
    if (ev?.purge === true && typeof ev.plugin === "string") svc.purgePlugin(ev.plugin).catch(() => {});
  };
  ctx.on("plugin", svc.onPlugin);
  ctx.on("plugin.removed", svc.onRemoved);
  ctx.on("plugins.removed", svc.onUninstalled);
}

export async function stop(ctx) {
  for (const [c, svc] of [...running]) {
    if (ctx && c !== ctx) continue;
    svc.stop();
    c.off("services.started", svc.onStarted);
    c.off("plugin", svc.onPlugin);
    c.off("plugin.removed", svc.onRemoved);
    c.off("plugins.removed", svc.onUninstalled);
    c.providePluginEnv(ENV_SOCKET, null);
    running.delete(c);
  }
}

export { urlAllowed };
