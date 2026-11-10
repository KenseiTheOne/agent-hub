// An MCP client over Streamable HTTP (JSON-RPC 2.0 POST to the server address) — for the oauth service (lib/services/oauth.mjs).
//
// Session: initialize → notifications/initialized once, then tools/call with the same Mcp-Session-Id and
// MCP-Protocol-Version. The response is JSON or an SSE stream (the message with our id is taken). The server forgot the session (404 with
// Mcp-Session-Id set) — one retry with a new one. The token is passed only in the Authorization header and is not
// stored here: every call gets it as an argument.
//
// Errors are McpError with kind: auth (401 or 403 with invalid_token; authError — the error from WWW-Authenticate), forbidden
// (other 403s: insufficient_scope — not enough permissions, not expiry), rate (429, RATE_LIMIT_EXCEEDED
// in a JSON-RPC error or in a tool result; retryAfterMs if the server said so), http, net, protocol.
// A tool result with isError (not a limit) is not a client error: it is returned as is.

import { parseWwwAuthenticate } from "./oauth.mjs";

export const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY = 2 * 1024 * 1024;
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 24 * 3600_000;

export class McpError extends Error {
  constructor(kind, extra = {}) {
    super(kind);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

// retryAfter from the service's response text: seconds, milliseconds or an epoch timestamp. → ms to wait (1 min … 24 h) or null
export function retryAfterMs(v, now = Date.now()) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  let ms;
  if (n > 1e12) ms = n - now; // epoch ms
  else if (n > 1e9) ms = n * 1000 - now; // epoch seconds
  else if (n >= 100_000) ms = n; // already milliseconds
  else ms = n * 1000; // seconds
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.round(ms)));
}

// A sign of an exhausted limit in the text (a JSON-RPC error, a tool result). → { retryAfterMs } or null
export function rateLimitIn(text, now = Date.now()) {
  const s = String(text || "").slice(0, 64 * 1024);
  if (!/RATE_LIMIT_EXCEEDED|rate[ _-]?limit(ed)?[ _-]?(exceeded|reached)|too many requests/i.test(s)) return null;
  const m = /retry[_-]?after["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(s);
  return { retryAfterMs: m ? retryAfterMs(m[1], now) : null };
}

function headerRetry(h, now) {
  const v = h.get("retry-after");
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return retryAfterMs(Number(v), now);
  const t = Date.parse(v);
  return Number.isFinite(t) ? retryAfterMs(t, now) : null;
}

// SSE → JSON messages (data: only)
export function sseMessages(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {}
  }
  return out;
}

export class McpSession {
  constructor({ url, fetchImpl = globalThis.fetch, clientInfo = { name: "agent-hub", version: "0" } }) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.clientInfo = clientInfo;
    this.sessionId = null;
    this.protocol = null;
    this.ready = false;
    this.seq = 0;
    this.httpRate = null; // { remaining, resetMs } from x-ratelimit-* of the last response
  }
  reset() {
    this.sessionId = null;
    this.protocol = null;
    this.ready = false;
  }

  async post(token, msg, { deadlineAt }) {
    const left = deadlineAt - Date.now();
    if (left < 100) throw new McpError("net", { reason: "deadline" });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocol) headers["MCP-Protocol-Version"] = this.protocol;
    let res;
    try {
      res = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify(msg), redirect: "error", signal: AbortSignal.timeout(left) });
    } catch (e) {
      throw new McpError("net", { reason: e?.name === "TimeoutError" ? "timeout" : "network" });
    }
    const now = Date.now();
    const rem = res.headers.get("x-ratelimit-remaining");
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (rem !== null && Number.isFinite(Number(rem))) this.httpRate = { remaining: Number(rem), resetMs: Number.isFinite(reset) && reset > 0 ? (reset > 1e12 ? reset : reset * 1000) : null, at: now };
    if (res.status === 401 || res.status === 403) {
      const w = parseWwwAuthenticate(res.headers.get("www-authenticate"));
      const authError = w.params.error || null;
      // 403 — the sign-in lacks permissions (insufficient_scope etc.), not "the sign-in expired": signing in again with the same scope
      // gives the same 403. Expiry is 401 or invalid_token.
      if (res.status === 403 && authError !== "invalid_token") throw new McpError("forbidden", { status: 403, authError });
      throw new McpError("auth", { status: res.status, authError });
    }
    if (res.status === 429) throw new McpError("rate", { status: 429, retryAfterMs: headerRetry(res.headers, now) });
    if (res.status === 404 && this.sessionId) throw new McpError("session", { status: 404 });
    if (res.status === 202 && msg.id === undefined) return { headers: res.headers, message: null };
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_BODY) throw new McpError("protocol", { reason: "too-large" });
    const text = (await res.text()).slice(0, MAX_BODY);
    if (res.status < 200 || res.status >= 300) {
      const rl = rateLimitIn(text, now);
      if (rl) throw new McpError("rate", { status: res.status, retryAfterMs: rl.retryAfterMs });
      throw new McpError("http", { status: res.status });
    }
    if (msg.id === undefined) return { headers: res.headers, message: null };
    const ct = String(res.headers.get("content-type") || "");
    let messages;
    if (ct.includes("text/event-stream")) messages = sseMessages(text);
    else {
      try {
        const j = JSON.parse(text);
        messages = Array.isArray(j) ? j : [j];
      } catch {
        throw new McpError("protocol", { reason: "not-json" });
      }
    }
    const m = messages.find((x) => x && x.id === msg.id);
    if (!m) throw new McpError("protocol", { reason: "no-response" });
    if (m.error) {
      const rl = rateLimitIn(JSON.stringify(m.error), now);
      if (rl) throw new McpError("rate", { retryAfterMs: rl.retryAfterMs });
      throw new McpError("protocol", { reason: "rpc-error", rpcCode: Number.isInteger(m.error.code) ? m.error.code : null });
    }
    return { headers: res.headers, message: m };
  }

  async init(token, opts) {
    this.reset();
    const r = await this.post(token, { jsonrpc: "2.0", id: ++this.seq, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo } }, opts);
    const sid = r.headers.get("mcp-session-id");
    if (sid && /^[\x21-\x7e]{1,256}$/.test(sid)) this.sessionId = sid;
    const pv = r.message?.result?.protocolVersion;
    this.protocol = typeof pv === "string" && /^[\w.-]{1,32}$/.test(pv) ? pv : PROTOCOL_VERSION;
    await this.post(token, { jsonrpc: "2.0", method: "notifications/initialized" }, opts);
    this.ready = true;
  }

  // → { result: {content, structuredContent?, isError?} }; a limit in a tool result — McpError("rate")
  async callTool(token, name, args, { deadlineAt = Date.now() + 10_000 } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!this.ready) await this.init(token, { deadlineAt });
        const r = await this.post(token, { jsonrpc: "2.0", id: ++this.seq, method: "tools/call", params: { name, arguments: args || {} } }, { deadlineAt });
        const result = r.message?.result;
        if (!result || typeof result !== "object") throw new McpError("protocol", { reason: "no-result" });
        if (result.isError) {
          const text = (Array.isArray(result.content) ? result.content : []).map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
          const rl = rateLimitIn(text);
          if (rl) throw new McpError("rate", { retryAfterMs: rl.retryAfterMs });
        }
        return { result };
      } catch (e) {
        if (e instanceof McpError && e.kind === "session" && attempt === 0) {
          this.reset();
          continue;
        }
        if (e instanceof McpError && (e.kind === "auth" || e.kind === "net")) this.reset();
        throw e;
      }
    }
    throw new McpError("protocol", { reason: "session" });
  }
}
