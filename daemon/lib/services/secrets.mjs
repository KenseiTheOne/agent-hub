// Plugin secrets service: a provider for the core (ctx.registerSecretsProvider) on top of the macOS keychain.
//
// A plugin declares `<agenthub.secrets>example.token — why</agenthub.secrets>`; the core asks the provider for the
// value and puts it into the plugin's environment as AGENTHUB_SECRET_EXAMPLE_TOKEN. The key `<service>.<account>`
// is looked up in the `login` keychain with
//   /usr/bin/security find-generic-password -s agent-hub.<service> -a <account> -w
// The user creates the entries (`security add-generic-password -s agent-hub.example -a token -w`).
//
// Who gets what:
//   builtin   — any keys except the hub's reserved services (telegram: the push bot reads it itself);
//   installed — only `<plugin id>.<account>` (secret permissions are agreed at install time, and the manager
//               blocks permission growth);
//   local     — nothing ("unverified").
// In test mode (AGENTHUB_HOME) the keychain is never read; tests use services.secrets.securityPath
// (a `security` double). Values are written neither to the journal nor to the bus: the journal gets only the key and outcome.
//
// Settings (config.json → services.secrets): enabled, ttlMs (300000), missTtlMs (60000), timeoutMs (5000).
//
// Connection store (decision 2026-11-09, oauth service): the `secrets.store` fact does get/set/delete of entries of the
// `agent-hub.oauth` keychain service (client registration and OAuth tokens; the value is JSON in base64url). Writes go
// via the stdin of `security -i` (lib/keychain.mjs), not argv. These entries are never given to plugins: the `oauth`
// service is reserved, like `telegram`. In test mode without a `security` double there is no store (get → null,
// set → no-keychain error).
//
// get: null means no entry; a keychain failure (timeout, keychain locked) throws StoreError (code) instead of null:
// the oauth service must not mistake a transient failure for "not logged in" or "login expired".
// A long value (a `security -i` line is at most 4095 characters) is split into parts: entries `<account>.<generation><n>`
// (generation alternates a/b), and the entry itself is a header `parts_<generation>_<n>_<sha256>`; the header is written
// last, so the previous value stays in effect until then. Parts of the previous generation are deleted afterwards.

import { createHash } from "node:crypto";
import { decodeJson, deleteItem, encodeJson, MAX_LINE, readItem, readItemResult, writeItem, writeLine } from "../keychain.mjs";
import { msg } from "../i18n.mjs";

export const name = "secrets";

export const RESERVED_SERVICES = new Set(["telegram", "oauth"]);
export const STORE_SERVICE = "agent-hub.oauth";
// "<connection id>.client|token": the id follows the same rule as the declaration (lib/meta.mjs CONNECTION_ID_RE: a plugin
// id or "<plugin id>.<name>", starting with a letter, up to 64 characters), so any accepted declaration can be stored in
// the keychain (an account name with a ".a16" part stays under lib/keychain.mjs's limit of 96).
const STORE_ACCOUNT_RE = /^(?=.{1,64}\.(?:client|token)$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]{0,31})?\.(client|token)$/;
const KEY_RE = /^([a-z][a-z0-9_-]{0,31})\.([a-z][a-z0-9_.-]{0,63})$/;
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
  return "untrusted";
}

export async function start(ctx) {
  const cfg = ctx.config.services?.secrets || {};
  const securityPath = ctx.config.testMode ? cfg.securityPath || null : "/usr/bin/security";
  const ttlMs = cfg.ttlMs ?? 300_000;
  const missTtlMs = cfg.missTtlMs ?? 60_000;
  const timeoutMs = cfg.timeoutMs ?? 5_000;
  const cache = new Map(); // key → { value, until }
  running.set(ctx, { cache });
  const store = makeStore(ctx, securityPath, timeoutMs);
  try {
    ctx.facts.provide("secrets.store", () => store);
  } catch {} // repeated start on the same core: the fact already exists

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
    const [svc, account] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
    const value = await readKeychain(securityPath, `agent-hub.${svc}`, account, timeoutMs);
    cache.set(key, { value, until: now + (value ? ttlMs : missTtlMs) });
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
