// The usage service: the Claude subscription quota for hub plugins — without depending on a statusline plugin.
//
// Every 3 min (with backoff on errors) it takes the Claude Code OAuth token from where Claude Code itself keeps it
// (the macOS keychain: the "Claude Code-credentials" entry, with a profile suffix under CLAUDE_CONFIG_DIR; the fallback
// path — <Claude config directory>/.credentials.json), and makes one GET https://api.anthropic.com/api/oauth/usage
// with the same headers as the Claude Code statusline scripts use. The result is <home>/Cache/usage.json (0600, atomic):
//   { version: 1, fetched_at, checked_at, error, retry_at?, rows: [{ kind, group, percent, severity, resets_at, scope?, label? }] }
// fetched_at / checked_at — epoch seconds (last success / last attempt), error — a code without text,
// retry_at — when the service will hit the API again after an error (the backoff survives a daemon restart).
//
// The token never leaves the service: it lives only in a local variable of a single request; it is not written to disk and never reaches
// the journal, errors, the bus, push or plugins. An expired token is not refreshed (a refresh rotates the refresh token and
// would log Claude Code itself out) — the service waits for Claude Code to refresh it. No token — no requests.
// Network — api.anthropic.com only, no redirects; the response body is capped at 256 KB, and only the rows are taken from it.
//
// Plugins get the cache path in the AGENTHUB_USAGE_FILE variable (ctx.providePluginEnv: the core gives it only to builtin,
// official and own). Switch: config.json → services.usage.enabled = false (enabled by default).
//
// Test mode (AGENTHUB_HOME): the keychain and the real host are not touched. Doubles — services.usage.securityPath
// (a /usr/bin/security double), services.usage.credentialsFile, services.usage.url (only http(s)://127.0.0.1 or
// localhost). services.usage.live = true in test mode — behaves as live (the real keychain and host; for a live
// check on the test stand). Other settings: intervalMs (180000; live, no less than 60000), firstDelayMs (2000),
// timeoutMs (8000), claudeConfigDir (a Claude Code profile instead of the daemon environment's CLAUDE_CONFIG_DIR).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

export const name = "usage";

export const USAGE_HOST = "api.anthropic.com";
export const USAGE_PATH = "/api/oauth/usage";
export const ENV_NAME = "AGENTHUB_USAGE_FILE";
const TTL_MS = 180_000;
const ERROR_BACKOFF_MS = 300_000;
const BACKOFF_MS = { 401: 600_000, 403: 3_600_000, 429: 900_000 };
const NO_TOKEN_RETRY_MS = 180_000; // check the keychain again (without a network request)
const MAX_BACKOFF_MS = 3_600_000; // upper bound for retry_at from the cache (a corrupt or far-off value does not freeze the service)
const MAX_BODY = 256 * 1024;
const MAX_ROWS = 40;

const running = new Map(); // ctx → { timer, stopped }

// Keychain entry name, as in Claude Code itself: with the suffix
// sha256(NFC(dir))[:8] if CLAUDE_SECURESTORAGE_CONFIG_DIR or CLAUDE_CONFIG_DIR is set.
export function keychainService({ configDir = null, secureDir } = {}) {
  let isDefault;
  let base;
  if (secureDir !== undefined && secureDir !== null) {
    isDefault = !secureDir;
    base = secureDir;
  } else {
    isDefault = !configDir;
    base = configDir || "";
  }
  if (isDefault) return "Claude Code-credentials";
  const digest = createHash("sha256").update(String(base).normalize("NFC"), "utf8").digest("hex").slice(0, 8);
  return `Claude Code-credentials-${digest}`;
}

// JSON Claude Code ({claudeAiOauth:{accessToken, expiresAt}}) → { token } | { error: "no-token" | "token-expired" }.
// The text itself is never stored anywhere.
export function tokenFrom(raw, nowMs = Date.now()) {
  let oauth;
  try {
    oauth = JSON.parse(raw)?.claudeAiOauth;
  } catch {
    return { error: "no-token" };
  }
  if (!oauth || typeof oauth !== "object") return { error: "no-token" };
  const token = oauth.accessToken;
  if (typeof token !== "string" || !token) return { error: "no-token" };
  const exp = oauth.expiresAt;
  if (typeof exp === "number" && Number.isFinite(exp) && exp < nowMs + 60_000) return { error: "token-expired" };
  return { token };
}

// Response rows (limits[]) → safe fields only. Anything foreign or unfamiliar is dropped.
export function cleanRows(body) {
  const list = body && typeof body === "object" && !Array.isArray(body) ? body.limits : null;
  if (!Array.isArray(list)) return null;
  const str = (v, max) => (typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
  const rows = [];
  for (const r of list) {
    if (rows.length >= MAX_ROWS) break;
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const kind = typeof r.kind === "string" && /^[a-z0-9_.-]{1,40}$/i.test(r.kind) ? r.kind : null;
    const percent = typeof r.percent === "number" && Number.isFinite(r.percent) ? Math.max(0, Math.min(1000, r.percent)) : null;
    if (!kind || percent === null) continue;
    const row = { kind, group: str(r.group, 40), percent, severity: str(r.severity, 20), resets_at: str(r.resets_at, 40) };
    if (row.resets_at && !Number.isFinite(Date.parse(row.resets_at))) row.resets_at = null;
    const model = str(r.scope?.model?.display_name, 40);
    if (model) row.scope = { model: { display_name: model } };
    const label = str(r.label, 60) || str(r.title, 60);
    if (label) row.label = label;
    rows.push(row);
  }
  return rows;
}

// Exit code of `security find-generic-password` when the entry is missing (errSecItemNotFound).
export const SEC_NOT_FOUND = 44;

// → { value } | { missing: true } (no entry: code 44, empty output, no program) | { unavailable: true } (timeout,
// access dialog denied, locked keychain, other codes — a temporary failure, not a sign-out).
function readKeychain(file, timeoutMs, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin" } }, (err, stdout) => {
      // neither stderr nor the error text is kept: only "present / missing / unavailable"
      // the program itself is missing (ENOENT) — there is no keychain at all: same as "no entry"
      if (err) return resolve(err.code === SEC_NOT_FOUND || err.code === "ENOENT" ? { missing: true } : { unavailable: true });
      const v = String(stdout ?? "").trim();
      resolve(v ? { value: v } : { missing: true });
    });
  });
}

function readCache(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// Atomic 0600 write in the same directory.
export function writeCache(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

// Request URL: live — only https://api.anthropic.com/api/oauth/usage; in test mode — a double on loopback.
export function endpoint(cfg, testMode) {
  if (!testMode || cfg.live === true) return { proto: "https:", host: USAGE_HOST, port: 443, path: USAGE_PATH };
  if (typeof cfg.url !== "string") return null;
  let u;
  try {
    u = new URL(cfg.url);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
  return { proto: u.protocol, host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), path: `${u.pathname}${u.search}` };
}

// One GET. → { status, body } | { error: "network" | "timeout" | "too-large" | "bad-response" }. Never throws.
function fetchUsage(ep, token, timeoutMs) {
  return new Promise((resolve) => {
    const req = (ep.proto === "https:" ? httpsRequest : httpRequest)(
      {
        host: ep.host,
        port: ep.port,
        path: ep.path,
        method: "GET",
        // the same headers as the Claude Code statusline scripts; our own User-Agent
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json", "User-Agent": "agent-hub" },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const status = res.statusCode;
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            res.destroy();
            done({ error: "too-large" });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (status !== 200) return done({ status });
          try {
            done({ status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch {
            done({ error: "bad-response" });
          }
        });
        res.on("error", () => done({ error: "network" }));
      },
    );
    let finished = false;
    // overall request deadline: the socket timeout is idle time, and a slow byte-by-byte response keeps resetting it
    const deadline = setTimeout(() => {
      req.destroy();
      done({ error: "timeout" });
    }, timeoutMs);
    deadline.unref?.();
    const done = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      resolve(r);
    };
    req.on("timeout", () => {
      req.destroy();
      done({ error: "timeout" });
    });
    req.on("error", () => done({ error: "network" }));
    req.end();
  });
}

export class UsageService {
  constructor(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config.services?.usage || {};
    this.cfg = cfg;
    this.testMode = Boolean(ctx.config.testMode) && cfg.live !== true;
    const dir = ctx.config.paths.pluginCache;
    this.dir = dir;
    this.file = join(dir, "usage.json");
    this.ep = endpoint(cfg, Boolean(ctx.config.testMode));
    this.securityPath = this.testMode ? cfg.securityPath || null : process.platform === "darwin" ? "/usr/bin/security" : null;
    const configDir = typeof cfg.claudeConfigDir === "string" && cfg.claudeConfigDir ? cfg.claudeConfigDir : process.env.CLAUDE_CONFIG_DIR || null;
    this.service = keychainService({ configDir, secureDir: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR });
    // .credentials.json: live — in the Claude config directory (CLAUDE_CONFIG_DIR, otherwise claudeHome = ~/.claude);
    // test — only an explicit double (the real ~/.claude is not read)
    this.credentialsFile = this.testMode ? cfg.credentialsFile || null : join(configDir || ctx.config.claudeHome, ".credentials.json");
    const minInterval = this.testMode ? 50 : 60_000;
    this.intervalMs = Math.max(minInterval, Number(cfg.intervalMs) || TTL_MS);
    this.timeoutMs = Number(cfg.timeoutMs) || 8_000;
    this.timer = null;
    this.stopped = false;
    this.lastError = undefined;
  }

  // → { token } | { error: "no-token" | "token-expired" | "keychain-unavailable" }. keychain-unavailable — the keychain
  // could not be read (not "no entry"): quota rows are kept, the plugin does not ask to sign in again.
  async readToken() {
    let raw = null;
    let unavailable = false;
    if (this.securityPath) {
      const r = await readKeychain(this.securityPath, 5_000, ["find-generic-password", "-s", this.service, "-w"]);
      raw = r.value || null;
      unavailable = r.unavailable === true;
    }
    if (!raw && this.credentialsFile) {
      try {
        raw = readFileSync(this.credentialsFile, "utf8");
      } catch {
        raw = null;
      }
    }
    if (!raw) return { error: unavailable ? "keychain-unavailable" : "no-token" };
    return tokenFrom(raw);
  }

  // One cycle. → delay until the next one, ms.
  async tick() {
    const prev = readCache(this.file) || {};
    const nowSec = Date.now() / 1000;
    const keep = Array.isArray(prev.rows) ? prev.rows : [];
    const base = { version: 1, fetched_at: typeof prev.fetched_at === "number" ? prev.fetched_at : null, checked_at: nowSec };
    let out;
    let delay;
    if (!this.ep) {
      out = { ...base, error: "no-endpoint", rows: keep };
      delay = NO_TOKEN_RETRY_MS;
    } else {
      const tk = await this.readToken();
      if (tk.error) {
        // signed out — rows from the previous account must not stay around; expired — wait for Claude Code to refresh it
        out = { ...base, error: tk.error, rows: tk.error === "no-token" ? [] : keep };
        delay = NO_TOKEN_RETRY_MS;
      } else {
        const r = await fetchUsage(this.ep, tk.token, this.timeoutMs);
        if (r.error) {
          out = { ...base, error: r.error, rows: keep };
          delay = ERROR_BACKOFF_MS;
        } else if (r.status !== 200) {
          out = { ...base, error: `http-${r.status}`, rows: keep };
          delay = BACKOFF_MS[r.status] ?? ERROR_BACKOFF_MS;
        } else {
          const rows = cleanRows(r.body);
          if (!rows) {
            out = { ...base, error: "bad-response", rows: keep };
            delay = ERROR_BACKOFF_MS;
          } else {
            out = { ...base, fetched_at: nowSec, error: null, rows };
            delay = this.intervalMs;
          }
        }
      }
    }
    if (this.testMode) delay = Math.min(delay, Number(this.cfg.backoffCapMs) || delay);
    // the backoff after a network/API error survives a daemon restart (like the next_try of a statusline script): firstDelay honors it
    if (out.error && out.error !== "no-token" && out.error !== "token-expired" && out.error !== "keychain-unavailable" && out.error !== "no-endpoint") out.retry_at = nowSec + delay / 1000;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeCache(this.file, out);
    } catch (e) {
      this.ctx.journal.write({ type: "usage-write-error", code: e.code || "write" });
    }
    if (out.error !== this.lastError) {
      // journal — only the outcome and the code, on change
      this.ctx.journal.write({ type: "usage-fetch", ok: !out.error, error: out.error || null, rows: out.rows.length });
      this.ctx.emit({ type: "usage.updated", ok: !out.error, error: out.error || null });
      this.lastError = out.error;
    } else if (!out.error) this.ctx.emit({ type: "usage.updated", ok: true, error: null });
    return delay;
  }

  // First attempt: a fresh cache from the previous daemon run (success less than an interval ago) — do not hit the network right away;
  // a backoff after an error is in progress (retry_at in the cache: 429, 403, network) — wait for it to end instead of hitting the API after 2 s.
  firstDelay() {
    const prev = readCache(this.file);
    const first = Number(this.cfg.firstDelayMs ?? 2_000);
    if (prev && !prev.error && typeof prev.fetched_at === "number") {
      const left = prev.fetched_at * 1000 + this.intervalMs - Date.now();
      if (left > first) return Math.min(left, this.intervalMs);
    }
    if (prev && prev.error && typeof prev.retry_at === "number" && Number.isFinite(prev.retry_at)) {
      const left = prev.retry_at * 1000 - Date.now();
      if (left > first) return Math.min(left, MAX_BACKOFF_MS);
    }
    return first;
  }

  schedule(ms) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      let next = ERROR_BACKOFF_MS;
      try {
        next = await this.tick();
      } catch (e) {
        this.ctx.journal.write({ type: "usage-error", code: e?.code || "internal" });
      }
      this.schedule(next);
    }, ms);
    this.timer.unref?.();
  }

  start() {
    this.ctx.providePluginEnv(ENV_NAME, this.file);
    this.schedule(this.firstDelay());
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ctx.providePluginEnv(ENV_NAME, null);
  }
}

export async function start(ctx) {
  const svc = new UsageService(ctx);
  running.set(ctx, svc);
  svc.start();
}

export async function stop(ctx) {
  for (const [c, svc] of [...running]) {
    if (ctx && c !== ctx) continue;
    svc.stop();
    running.delete(c);
  }
}
