// Plugin secrets service: a provider for the core (ctx.registerSecretsProvider) on top of the macOS keychain.
//
// A plugin declares `<agenthub.secrets>example.token — why</agenthub.secrets>`; the core asks the provider for the
// value and puts it into the plugin's environment as AGENTHUB_SECRET_EXAMPLE_TOKEN. The key `<service>.<account>`
// is looked up in the `login` keychain with
//   /usr/bin/security find-generic-password -s agent-hub.<service> -a <account> -w
// The user creates the entries (`security add-generic-password -s agent-hub.example -a token -w`).
//
// Who gets what:
//   builtin   — any keys except the hub's reserved services (oauth: connection logins; telegram: a leftover bot token);
//   installed — only `<plugin id>.<account>` (secret permissions are agreed at install time, and the manager
//               blocks permission growth);
//   local     — nothing ("unverified").
// In test mode (AGENTHUB_HOME) the keychain is never read; tests use services.secrets.securityPath
// (a `security` double). Values are written neither to the journal nor to the bus: the journal gets only the key and outcome.
//
// Settings (config.json → services.secrets): enabled, ttlMs (300000), missTtlMs (60000), timeoutMs (5000).
// Cache: a found value is reused for ttlMs (5 min), a missing one for missTtlMs (1 min) — an entry made in the terminal shows
// up in the plugin within a minute at most. A write or delete from the app (below) drops the key from the cache right away.
//
// Key: `<service>.<account>`, service `[a-z0-9][a-z0-9_-]{0,63}` (an installed plugin's own namespace is its id, and a
// registry id is up to 64 characters), account `[a-z][a-z0-9_.-]{0,63}`; the keychain names stay within lib/keychain.mjs's
// 96 characters (`agent-hub.` + 64).
//
// Entering a secret in the app (fact `secrets.api`, routes lib/routes/secrets.mjs, app only):
//   list(pluginId)              — the plugin's declared keys with set/unset state, never values: a key the provider has
//                                 cached answers from the cache, any other is an existence check (`find-generic-password`
//                                 without -w — the value is never read); at most MAX_LISTED keys;
//   set(pluginId, key, value)   — write via the stdin of `security -i` (lib/keychain.mjs writeItem raw), not argv;
//   remove(pluginId, key)       — delete the entry.
// Only keys the plugin declares in <agenthub.secrets> and would actually receive (denyReason). After a change the key leaves
// the cache and the plugin restarts with a fresh environment (AGENTHUB_REFRESH_REASON=SecretChanged): a streamable one via
// ctx.restartPlugin when the core provides it, otherwise — and for a standard plugin — a run (refresh). The journal gets
// `secret-set {plugin, key, op, ok, error?}`, the bus `secrets.changed {plugin, key, state}` — never the value.
//
// Connection store (decision 2026-11-09, oauth service): the `secrets.store` fact does get/set/delete of entries of the
// `agent-hub.oauth` keychain service (client registration and OAuth tokens; the value is JSON in base64url). Writes go
// via the stdin of `security -i` (lib/keychain.mjs), not argv. These entries are never given to plugins: the `oauth`
// service is reserved. In test mode without a `security` double there is no store (get → null,
// set → no-keychain error).
//
// get: null means no entry; a keychain failure (timeout, keychain locked) throws StoreError (code) instead of null:
// the oauth service must not mistake a transient failure for "not logged in" or "login expired".
// A long value (a `security -i` line is at most 4095 characters) is split into parts: entries `<account>.<generation><n>`
// (generation alternates a/b), and the entry itself is a header `parts_<generation>_<n>_<sha256>`; the header is written
// last, so the previous value stays in effect until then. Parts of the previous generation are deleted afterwards.

import { createHash } from "node:crypto";
import { decodeJson, deleteItem, encodeJson, itemExists, MAX_LINE, RAW_VALUE_RE, readItem, readItemResult, writeItem, writeLine } from "../keychain.mjs";
import { contentOf, msg } from "../i18n.mjs";
import { readPluginMeta, splitWhy } from "../meta.mjs";

export const name = "secrets";

// "telegram" stays reserved after the Telegram channel was removed (2026-11-11): an old bot token may still sit in
// the keychain, and no plugin, built-in included, should be able to read it.
export const RESERVED_SERVICES = new Set(["telegram", "oauth"]);
export const STORE_SERVICE = "agent-hub.oauth";
// "<connection id>.client|token": the id follows the same rule as the declaration (lib/meta.mjs CONNECTION_ID_RE: a plugin
// id or "<plugin id>.<name>", starting with a letter, up to 64 characters), so any accepted declaration can be stored in
// the keychain (an account name with a ".a16" part stays under lib/keychain.mjs's limit of 96).
const STORE_ACCOUNT_RE = /^(?=.{1,64}\.(?:client|token)$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]{0,31})?\.(client|token)$/;
export const KEY_RE = /^([a-z0-9][a-z0-9_-]{0,63})\.([a-z][a-z0-9_.-]{0,63})$/;
// The longest value the app may write: a `security -i` line (≤ 4095) with the longest names stays under the limit.
export const MAX_VALUE = 3072;
// GET /secrets/:plugin lists at most this many declared keys (the rest is only counted: `more`), looking them up at most
// LIST_PARALLEL at a time — a plugin declaring hundreds of keys must not start hundreds of `security` processes.
export const MAX_LISTED = 32;
const LIST_PARALLEL = 4;
const running = new Map(); // ctx → { cache }

function readKeychain(securityPath, service, account, timeoutMs) {
  return readItem(securityPath, service, account, { timeoutMs }).then((v) => (v && v.length <= 8192 ? v : null));
}

export class StoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const PART = 3800; // base64url characters per part: a security -i line with the command prefix stays under 4095
const MAX_PARTS = 16;
const HEAD_RE = /^parts_([ab])_(\d{1,2})_([A-Za-z0-9_-]{22})$/;
const digest = (s) => createHash("sha256").update(s).digest("base64url").slice(0, 22);

// The oauth service store: only "<connector>.client" and "<connector>.token" entries of the agent-hub.oauth service.
// Values are objects (JSON); the journal gets only the entry name and outcome.
export function makeStore(ctx, securityPath, timeoutMs) {
  const check = (account) => {
    if (!STORE_ACCOUNT_RE.test(String(account || ""))) throw new Error(msg("err.secrets.account"));
  };
  const read = (account) => readItemResult(securityPath, STORE_SERVICE, account, { timeoutMs });
  const write = (account, value) => writeItem(securityPath, STORE_SERVICE, account, value, { timeoutMs });
  const del = (account) => deleteItem(securityPath, STORE_SERVICE, account, { timeoutMs });
  // delete the parts of generation gen (a known count n, or up to the first missing one)
  const dropParts = async (account, gen, n = MAX_PARTS) => {
    let ok = true;
    for (let i = 1; i <= n; i++) {
      const r = await del(`${account}.${gen}${i}`);
      if (r.missing && n === MAX_PARTS) break;
      if (!r.ok) ok = false;
    }
    return ok;
  };
  return Object.freeze({
    available: Boolean(securityPath),
    async get(account) {
      check(account);
      if (!securityPath) return null;
      const h = await read(account);
      if (h.missing) return null;
      if (h.error) throw new StoreError(h.error);
      const m = HEAD_RE.exec(h.value);
      if (!m) return decodeJson(h.value);
      let all = "";
      for (let i = 1; i <= Number(m[2]); i++) {
        const r = await read(`${account}.${m[1]}${i}`);
        if (r.error) throw new StoreError(r.error);
        if (r.missing) return null; // entry is corrupt: no parts means not logged in
        all += r.value;
      }
      return digest(all) === m[3] ? decodeJson(all) : null;
    },
    async set(account, value) {
      check(account);
      if (!securityPath) return { ok: false, error: "no-keychain" };
      const enc = encodeJson(value);
      let r;
      let parts = 0;
      if (enc.length > PART * MAX_PARTS) r = { ok: false, error: "too-large" };
      else {
        const prev = await read(account);
        const old = prev.value ? HEAD_RE.exec(prev.value) : null;
        if (prev.error) r = { ok: false, error: `read-${prev.error}` }; // generation unknown: leave the live parts alone
        else if (writeLine(STORE_SERVICE, account, enc).length <= MAX_LINE) {
          r = await write(account, enc);
          if (r.ok && old) await dropParts(account, old[1], Number(old[2]));
        } else {
          const gen = old?.[1] === "a" ? "b" : "a";
          for (let i = 0; i * PART < enc.length; i++) {
            r = await write(`${account}.${gen}${i + 1}`, enc.slice(i * PART, (i + 1) * PART));
            parts = i + 1;
            if (!r.ok) break;
          }
          if (r.ok) r = await write(account, `parts_${gen}_${parts}_${digest(enc)}`);
          if (r.ok && old) await dropParts(account, old[1], Number(old[2]));
        }
      }
      ctx.journal.write({ type: "secret-store", op: "set", account, ok: r.ok, ...(parts ? { parts } : {}), ...(r.error ? { error: r.error } : {}) });
      return r;
    },
    async delete(account) {
      check(account);
      if (!securityPath) return { ok: true, missing: true };
      const h = await read(account);
      const m = h.value ? HEAD_RE.exec(h.value) : null;
      const r = await del(account);
      // parts: if there is a header, exactly its parts; if there is none or it could not be read, collect leftovers of earlier entries
      let partsOk = true;
      if (m) partsOk = await dropParts(account, m[1], Number(m[2]));
      if (!m || h.error) for (const g of ["a", "b"]) partsOk = (await dropParts(account, g)) && partsOk;
      const out = r.ok && !partsOk ? { ok: false, error: "parts" } : r;
      ctx.journal.write({ type: "secret-store", op: "delete", account, ok: out.ok, ...(out.missing ? { missing: true } : {}), ...(out.error ? { error: out.error } : {}) });
      return out;
    },
  });
}

// Whether this plugin may get the key. → null (allowed) or a reason code.
export function denyReason(pl, key) {
  const m = KEY_RE.exec(key || "");
  if (!m) return "bad-key";
  const [, svc] = m;
  if (RESERVED_SERVICES.has(svc)) return "reserved";
  if (pl?.source === "builtin") return null;
  if (pl?.source === "installed") return svc === pl.id ? null : "foreign-namespace";
  // a test hub with AGENTHUB_TEST_TIER=own (G15): a Plugins/local plugin runs as own — its own <id>.* keys, like an installed one
  if (pl?.source === "local" && pl?.granted?.testTier === true && pl?.granted?.tier === "own") return svc === pl.id ? null : "foreign-namespace";
  return "untrusted";
}

// The environment variable a key arrives as (runner.mjs buildEnv).
export const envName = (key) => `AGENTHUB_SECRET_${String(key).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
const splitKey = (key) => [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];

// The app side of plugin secrets (see the header). Answers are { status, body } for the routes.
export function makeApi(ctx, { securityPath, timeoutMs, cache, bump = () => {} }) {
  // The plugin's declared keys from its metadata (the file the running instance came from). → { pl, entries } | { res }
  const declared = (pluginId) => {
    const st = typeof pluginId === "string" ? ctx.state.plugin(pluginId) : null;
    if (!st) return { res: { status: 404, body: { error: "not-found" } } };
    let meta = null;
    try {
      meta = st.file ? readPluginMeta(st.file)?.meta : null;
    } catch {}
    // "why" through the content language chain (hub language, then the system languages — lib/i18n.mjs contentLang)
    const tr = contentOf(meta?.i18n, ctx.lang(), { field: "why" }).why || {};
    const entries = [];
    for (const raw of meta?.secrets || []) {
      const { what, why } = splitWhy(raw);
      if (entries.some((e) => e.key === what)) continue;
      entries.push({ key: what, why: tr[what] || why || null });
    }
    // the plugin as denyReason sees it in the core: its tier and the test-tier mark (G15) come with the state
    return { pl: { id: st.id, source: st.source, granted: { tier: st.tier || null, testTier: st.testTier === true } }, entries };
  };
  const view = (pl, e, state, extra = {}) => {
    const why = denyReason(pl, e.key);
    return { key: e.key, why: e.why, env: envName(e.key), state: why ? "denied" : state, editable: !why && Boolean(securityPath), ...(why ? { reason: why } : {}), ...extra };
  };
  const lookup = async (pl, e) => {
    if (denyReason(pl, e.key)) return view(pl, e, "denied");
    if (!securityPath) return view(pl, e, "unavailable");
    const hit = cache.get(e.key);
    if (hit && hit.until > Date.now()) return view(pl, e, hit.value ? "set" : "unset");
    const [svc, account] = splitKey(e.key);
    const r = await itemExists(securityPath, `agent-hub.${svc}`, account, { timeoutMs });
    if (r.error) return view(pl, e, "error", { error: r.error });
    return view(pl, e, r.exists ? "set" : "unset");
  };
  // Checks shared by set and remove. → { pl, entry } | { res }
  const target = (pluginId, key) => {
    const d = declared(pluginId);
    if (d.res) return d;
    const entry = d.entries.find((e) => e.key === key);
    if (!entry) return { res: { status: 404, body: { error: "secrets:not-declared" } } };
    const why = denyReason(d.pl, key);
    if (why) return { res: { status: 403, body: { error: `secrets:${why}` } } };
    if (!securityPath) return { res: { status: 409, body: { error: "secrets:no-keychain" } } };
    return { pl: d.pl, entry };
  };
  // After a change: forget the cached value, restart the plugin with a fresh environment. → "restart" | "refresh"
  const changed = (pl, entry, state) => {
    cache.delete(entry.key);
    bump();
    ctx.emit({ type: "secrets.changed", plugin: pl.id, key: entry.key, state });
    if (typeof ctx.restartPlugin === "function") {
      ctx.restartPlugin(pl.id, "SecretChanged");
      return "restart";
    }
    ctx.refreshPlugin(pl.id, "SecretChanged");
    return "refresh";
  };
  return Object.freeze({
    async list(pluginId) {
      const d = declared(pluginId);
      if (d.res) return d.res;
      const shown = d.entries.slice(0, MAX_LISTED);
      const secrets = new Array(shown.length);
      let next = 0;
      const worker = async () => {
        while (next < shown.length) {
          const i = next++;
          secrets[i] = await lookup(d.pl, shown[i]);
        }
      };
      await Promise.all(Array.from({ length: Math.min(LIST_PARALLEL, shown.length) }, worker));
      const more = d.entries.length - shown.length;
      return { status: 200, body: { plugin: d.pl.id, keychain: Boolean(securityPath), secrets, ...(more > 0 ? { more } : {}) } };
    },
    async set(pluginId, key, value) {
      const t = target(pluginId, key);
      if (t.res) return t.res;
      if (typeof value !== "string" || !value) return { status: 400, body: { error: "args:value:required" } };
      if (value.length > MAX_VALUE) return { status: 400, body: { error: "args:value:length", max: MAX_VALUE } };
      if (!RAW_VALUE_RE.test(value)) return { status: 400, body: { error: "args:value:chars" } };
      const [svc, account] = splitKey(key);
      const r = await writeItem(securityPath, `agent-hub.${svc}`, account, value, { timeoutMs, raw: true });
      ctx.journal.write({ type: "secret-set", op: "set", plugin: t.pl.id, key, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      if (!r.ok) return { status: r.error === "timeout" ? 503 : 500, body: { error: "secrets:keychain", reason: r.error } };
      const restarted = changed(t.pl, t.entry, "set");
      return { status: 200, body: { ok: true, restarted, secret: view(t.pl, t.entry, "set") } };
    },
    async remove(pluginId, key) {
      const t = target(pluginId, key);
      if (t.res) return t.res;
      const [svc, account] = splitKey(key);
      const r = await deleteItem(securityPath, `agent-hub.${svc}`, account, { timeoutMs });
      ctx.journal.write({ type: "secret-set", op: "delete", plugin: t.pl.id, key, ok: r.ok, ...(r.missing ? { missing: true } : {}), ...(r.error ? { error: r.error } : {}) });
      if (!r.ok) return { status: r.error === "timeout" ? 503 : 500, body: { error: "secrets:keychain", reason: r.error } };
      const restarted = changed(t.pl, t.entry, "unset");
      return { status: 200, body: { ok: true, ...(r.missing ? { missing: true } : {}), restarted, secret: view(t.pl, t.entry, "unset") } };
    },
  });
}

export async function start(ctx) {
  const cfg = ctx.config.services?.secrets || {};
  const securityPath = ctx.config.testMode ? cfg.securityPath || null : "/usr/bin/security";
  const ttlMs = cfg.ttlMs ?? 300_000;
  const missTtlMs = cfg.missTtlMs ?? 60_000;
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const cache = new Map(); // key → { value, until }
  // bumped by every write/delete from the app: a keychain read that started before it does not put the old value back
  let version = 0;
  running.set(ctx, { cache });
  const store = makeStore(ctx, securityPath, timeoutMs);
  const api = makeApi(ctx, { securityPath, timeoutMs, cache, bump: () => version++ });
  try {
    ctx.facts.provide("secrets.store", () => store);
  } catch {} // repeated start on the same core: the fact already exists
  try {
    ctx.facts.provide("secrets.api", () => (running.get(ctx)?.cache === cache ? api : null));
  } catch {}

  ctx.registerSecretsProvider(async (pluginId, key, pl) => {
    const why = denyReason(pl, key);
    if (why) {
      ctx.journal.write({ type: "secret-denied", plugin: pluginId, key, reason: why });
      return undefined;
    }
    if (!securityPath) return undefined; // test mode without a double: no secrets
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.until > now) return hit.value ?? undefined;
    const [svc, account] = splitKey(key);
    const v0 = version;
    const value = await readKeychain(securityPath, `agent-hub.${svc}`, account, timeoutMs);
    if (version === v0) cache.set(key, { value, until: now + (value ? ttlMs : missTtlMs) });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    if (!hit || Boolean(hit.value) !== Boolean(value)) ctx.journal.write({ type: "secret-lookup", plugin: pluginId, key, found: Boolean(value) });
    return value ?? undefined;
  });
}

export async function stop(ctx) {
  for (const [c, st] of [...running]) {
    if (ctx && c !== ctx) continue;
    st.cache.clear();
    running.delete(c);
  }
}
