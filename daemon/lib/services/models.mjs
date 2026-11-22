// The models service: the Claude models this sign-in can use, for hub plugins — so a plugin that offers a model choice
// learns about a new model by itself instead of carrying a list that goes stale.
//
// Every 6 h (with backoff on errors) it takes the Claude Code OAuth token the same way the usage service does
// (lib/services/usage.mjs: the keychain entry of Claude Code, the fallback .credentials.json) and makes one
// GET https://api.anthropic.com/v1/models?limit=1000. The result is <home>/Cache/models.json (0600, atomic):
//   { version: 1, fetched_at, checked_at, error, retry_at?, models: [{ id, name?, created_at? }] }
// fetched_at / checked_at — epoch seconds (last success / last attempt), error — a code without text,
// retry_at — when the service will hit the API again after an error (the backoff survives a daemon restart).
// models — as the API orders them (newest first); only the id, the display name and the release date are kept.
//
// The token is handled as in the usage service: one local variable per request, never on disk, in the journal, on the
// bus or in plugins; an expired token is not refreshed. No token — no requests, and the list of the previous account is
// erased. Network — api.anthropic.com only, no redirects; the response body is capped at 256 KB.
//
// Plugins get the cache path in the AGENTHUB_CLAUDE_MODELS_FILE variable (ctx.providePluginEnv: the core gives it only
// to builtin, official and own). Switch: config.json → services.models.enabled = false (enabled by default).
//
// Test mode (AGENTHUB_HOME): the keychain and the real host are not touched. Doubles — services.models.securityPath,
// services.models.credentialsFile, services.models.url (loopback only); services.models.live = true — behaves as live.
// Other settings: intervalMs (21600000; live, no less than 600000), firstDelayMs (5000), timeoutMs (8000),
// claudeConfigDir (a Claude Code profile; otherwise the one of the usage service, otherwise CLAUDE_CONFIG_DIR).

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { endpoint, fetchJson, tokenSource, writeCache } from "./usage.mjs";
import { OnDemand } from "./_on-demand.mjs";

export const name = "models";

export const MODELS_PATH = "/v1/models?limit=1000";
export const ENV_NAME = "AGENTHUB_CLAUDE_MODELS_FILE";
const TTL_MS = 6 * 3_600_000;
const ERROR_BACKOFF_MS = 900_000;
const BACKOFF_MS = { 401: 3_600_000, 403: 6 * 3_600_000, 404: 6 * 3_600_000, 429: 3_600_000 };
const NO_TOKEN_RETRY_MS = 600_000; // check the keychain again (without a network request)
const MAX_BACKOFF_MS = 6 * 3_600_000; // upper bound for retry_at from the cache
const MAX_MODELS = 200;
const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]{0,60}$/;

const running = new Map(); // ctx → ModelsService

// Response (data[]) → safe fields only: [{ id, name?, created_at? }]; null — not a model list. Anything foreign or
// unfamiliar is dropped; an id is taken once.
export function cleanModels(body) {
  const list = body && typeof body === "object" && !Array.isArray(body) ? body.data : null;
  if (!Array.isArray(list)) return null;
  const str = (v, max) => (typeof v === "string" && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
  const out = [];
  const seen = new Set();
  for (const m of list) {
    if (out.length >= MAX_MODELS) break;
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const id = typeof m.id === "string" && MODEL_ID_RE.test(m.id) ? m.id : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = { id };
    const label = str(m.display_name, 60);
    if (label) row.name = label;
    const created = str(m.created_at, 40);
    if (created && Number.isFinite(Date.parse(created))) row.created_at = created;
    out.push(row);
  }
  return out;
}

function readCache(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

export class ModelsService {
  constructor(ctx) {
    this.ctx = ctx;
    const cfg = ctx.config.services?.models || {};
    this.cfg = cfg;
    this.testMode = Boolean(ctx.config.testMode) && cfg.live !== true;
    this.dir = ctx.config.paths.pluginCache;
    this.file = join(this.dir, "models.json");
    this.ep = endpoint(cfg, Boolean(ctx.config.testMode), MODELS_PATH);
    // the same sign-in as the usage service: a profile set there applies here too
    const claudeConfigDir = cfg.claudeConfigDir || ctx.config.services?.usage?.claudeConfigDir;
    this.token = tokenSource(ctx, { ...cfg, claudeConfigDir }, this.testMode);
    const minInterval = this.testMode ? 50 : 600_000;
    this.intervalMs = Math.max(minInterval, Number(cfg.intervalMs) || TTL_MS);
    this.timeoutMs = Number(cfg.timeoutMs) || 8_000;
    this.timer = null;
    this.stopped = false;
    this.demand = new OnDemand(this, ENV_NAME, "models-demand");
    this.lastError = undefined;
    this.lastIds = undefined;
  }

  // One cycle. → delay until the next one, ms.
  async tick() {
    const prev = readCache(this.file) || {};
    const nowSec = Date.now() / 1000;
    const keep = Array.isArray(prev.models) ? prev.models : [];
    const base = { version: 1, fetched_at: typeof prev.fetched_at === "number" ? prev.fetched_at : null, checked_at: nowSec };
    let out;
    let delay;
    if (!this.ep) {
      out = { ...base, error: "no-endpoint", models: keep };
      delay = NO_TOKEN_RETRY_MS;
    } else {
      const tk = await this.token.read();
      if (tk.error) {
        // signed out — the list of the previous account must not stay around; expired — wait for Claude Code to refresh it
        out = { ...base, error: tk.error, models: tk.error === "no-token" ? [] : keep };
        delay = NO_TOKEN_RETRY_MS;
      } else {
        // anthropic-version is required by /v1/models
        const r = await fetchJson(this.ep, tk.token, this.timeoutMs, { "anthropic-version": "2023-06-01" });
        if (r.error) {
          out = { ...base, error: r.error, models: keep };
          delay = ERROR_BACKOFF_MS;
        } else if (r.status !== 200) {
          out = { ...base, error: `http-${r.status}`, models: keep };
          delay = BACKOFF_MS[r.status] ?? ERROR_BACKOFF_MS;
        } else {
          const models = cleanModels(r.body);
          // an empty list is a broken reply, not "no models": the previous list stays
          if (!models || !models.length) {
            out = { ...base, error: "bad-response", models: keep };
            delay = ERROR_BACKOFF_MS;
          } else {
            out = { ...base, fetched_at: nowSec, error: null, models };
            delay = this.intervalMs;
          }
        }
      }
    }
    if (this.testMode) delay = Math.min(delay, Number(this.cfg.backoffCapMs) || delay);
    if (out.error && out.error !== "no-token" && out.error !== "token-expired" && out.error !== "keychain-unavailable" && out.error !== "no-endpoint") out.retry_at = nowSec + delay / 1000;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeCache(this.file, out);
    } catch (e) {
      this.ctx.journal.write({ type: "models-write-error", code: e.code || "write" });
    }
    // journal and bus — only when the outcome or the list changes
    const ids = out.models.map((m) => m.id).join();
    if (out.error !== this.lastError || ids !== this.lastIds) {
      this.ctx.journal.write({ type: "models-fetch", ok: !out.error, error: out.error || null, models: out.models.length });
      this.ctx.emit({ type: "models.updated", ok: !out.error, error: out.error || null, models: out.models.length });
      this.lastError = out.error;
      this.lastIds = ids;
    }
    return delay;
  }

  // First attempt: a fresh cache from the previous daemon run — do not hit the network right away; a backoff after an
  // error is in progress (retry_at in the cache) — wait for it to end.
  firstDelay() {
    const prev = readCache(this.file);
    const first = Number(this.cfg.firstDelayMs ?? 5_000);
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
    if (this.stopped || !this.demand.active) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      let next = ERROR_BACKOFF_MS;
      try {
        next = await this.tick();
      } catch (e) {
        this.ctx.journal.write({ type: "models-error", code: e?.code || "internal" });
      }
      this.schedule(next);
    }, ms);
    this.timer.unref?.();
  }

  start() {
    this.ctx.providePluginEnv(ENV_NAME, this.file);
    // polls only while a running plugin reads the file (services/_on-demand.mjs; services.models.onDemand = false — always)
    this.demand.start();
  }

  stop() {
    this.stopped = true;
    this.demand.stop();
    clearTimeout(this.timer);
    this.ctx.providePluginEnv(ENV_NAME, null);
  }
}

export async function start(ctx) {
  const svc = new ModelsService(ctx);
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
