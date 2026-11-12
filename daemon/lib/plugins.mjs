// Plugin manager (stage 8): catalog from a signed index.json, archive install by sha256,
// plugins.lock with granted permissions, re-consent when permissions grow, removal, blocklist,
// Plugins/local as "unverified".
//
// Who calls what:
//   lib/services/plugins.mjs — creates the manager, sets the core plugin policy (ctx.setPluginPolicy);
//   lib/routes/plugins.mjs   — HTTP: /registry/* (install and removal — app class only).
//
// Where things live (in the AgentHub state directory):
//   Plugins/<id>/            — an installed plugin (exactly what's in plugins.lock; written only by the manager)
//   Plugins/local/           — development: "unverified", effects only open.* (the core enforces the ceiling)
//   plugins.lock             — { version, plugins: { <id>: { version, sha256, granted, files, disabled } } }, 0600
//   Registry/index.json(.minisig) — the last verified catalog; Registry/state.json — rollback protection
//   Registry/staging|trash   — temporary during install; Registry/disabled/<id> — disabled by the blocklist;
//   Registry/quarantine/<id> — what landed in Plugins/ bypassing the manager (not in lock, files changed);
//   Registry/archives/<id>.tar.gz — archive of the installed version (sha256 from the signed index): the policy
//                              uses it to verify that the files on disk are exactly the official archive.
//   Registry/attest/<id>.json(.minisig) — the signed index in which the installed version was official
//                              (kept when a new catalog replaces it): through it an official plugin stays
//                              official until the user updates it to the released version.
//
// The policy takes the tier of an installed plugin from the verified catalog at check time, not from
// plugins.lock: official only if the signed index currently names this id official, the archive sha256 in lock
// is signed as official (by the current catalog or the saved Registry/attest/<id> — the index where this version was
// the latest) and the files on disk match the contents of the saved archive. A new release of an official plugin
// doesn't change the tier of the installed one: until updated it works as before (actions, its own push rules, service
// variables). If the registry owner lowered the tier or lock was written bypassing the manager, the plugin runs as community
// (without actions and its own push rules).
//
// "Official" is only what the signed catalog lists as official right now (decision 2026-11-11): a plugin installed as official
// whose id the current verified index no longer lists (or lists as community — official.json in the registry) is community
// from the next policy check on — permission ceiling, effects, actions and consent rules as for community, and the UI simply
// shows the tier it has now. The transition is journaled once (plugin-tier-lowered, and plugin-tier-restored if the catalog
// lists it as official again); Registry/tiers.json remembers the lowered ids across restarts. Only a verified catalog moves the
// tier: a failed download or a rejected signature keeps the last verified index on disk and in memory (fetchCatalog throws before
// replacing anything), so a network error never demotes a plugin.
//
// Own sources (decision 2026-11-09, lib/registry/own-source.mjs): a plugin from a local folder (convention — agenthub/<id>/ in
// the repository). An install request (POST /registry/own/request, `agenthub plugins install --from <folder>`) can be
// created by any local process, but only a human in the pinned app can install it (POST /registry/own/approve
// → 428 with the consent window → token). The copy goes to Plugins/<id> (the copy runs, not the repository folder), lock entry:
// tier "own", sha256 — content fingerprint, own.path — the folder's realpath. Tier own: trusted like official.
// The manager watches the folder (fs.watch + reconciliation once a minute): content changed, same permissions — the new copy
// is installed automatically without a window (log plugin-own-updated, event plugins.own-updated → the push service's "Plugin
// updated" banner, kind "updates", decision 2026-11-11); permissions grew — "Update
// available" and the consent window; folder gone or broken — the plugin runs on the last copy, the UI shows
// a warning. An own plugin never becomes official: it has no archive or registry attestation, and switching from
// an installed registry plugin to an own one with the same id goes only through the consent window marked as a switch.
//
// Tier own is not taken from the tier field in plugins.lock (any user process can write it): an own entry
// is trusted only if the manager itself made it — after the consent window (approveOwn, /registry/install with a token) or
// by a quiet update from the same folder. The manager remembers a fingerprint of every such entry (path, content fingerprint,
// files, permissions) in daemon memory and in Registry/own-approvals.json; an entry in the file the daemon didn't make while
// running grants no trust (the file can only revoke consent — CLI `plugins remove`). On mismatch the plugin
// runs as community, the blocklist doesn't let it through, log plugin-own-unexpected, event plugins.own-unexpected
// (push service — security exception notification) and a request for re-approval in the app. The limit is the
// same as for app pinning (app-pin.mjs): forging both files while the daemon is down can't be detected.
//
// Network: on explicit command (POST /registry/fetch, install) and by the background update check (lib/registry/updates.mjs:
// ~1 min after start and every 6 h, same fetchCatalog and same signature check; disabled by
// services.plugins.checkUpdates = false or the "Check for plugin updates" setting), https:// only; a file
// path or file:// — for tests and a local mirror. The background check installs nothing: only the catalog and the update list.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch as fsWatch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, parseFileName, parseIcon, parseMetaText, parseRequires } from "./meta.mjs";
import { cleanAuthor } from "./author.mjs";
import { contentLang, contentOf, currentLang, errText, msg, normTag, pickLang } from "./i18n.mjs";
import { fileSig, readJsonFile } from "./config.mjs";
import { isAbsolutePath, liveStateDir, myUid, samePath } from "./platform.mjs";
import { scanDir } from "./host.mjs";
import { verify as verifySignature } from "./registry/minisign.mjs";
import { readTarGz, LIMITS as TAR_LIMITS } from "./registry/tarball.mjs";
import { CONTRACT_FEATURES, ID_RE, RESERVED_IDS, lintPlugin, permissionGrowth, permissionList, permissionsFingerprint, permissionsFromMeta, splitWhy } from "./registry/perms.mjs";
import { expandPath, inspectSource, OwnSourceError, shortPath } from "./registry/own-source.mjs";
import { refreshLocalWritePlaces } from "./registry/local-places.mjs";

// CLI next to the daemon: the shell shows the registry connection command with the full path (agenthub isn't in PATH).
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agenthub");

export const INDEX_VERSION = 1;
export const LOCK_VERSION = 1;
// The label of a Plugins/local plugin in /registry/installed, in the hub language.
export const unverifiedLabel = () => msg("plugins.unverified");
const CONSENT_TTL_MS = 120_000;
// An install request from an own folder lives for a day (the human may have stepped away from the Mac); at most 10 requests.
const OWN_REQUEST_TTL_MS = 24 * 3_600_000;
const OWN_REQUESTS_MAX = 10;
// Own sources: fingerprint reconciliation once a minute and folder watcher debounce.
export const OWN_DEFAULTS = Object.freeze({ checkMs: 60_000, debounceMs: 1500 });
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_SIG_BYTES = 4096;
const PLATFORM = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;
const KINDS_WITH_WHY = ["fsRead", "fsWrite", "watch", "exec", "secrets", "net", "connections", "terminal", "subscribe"];

export class RegistryError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function atomicWrite(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function readJsonOr(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Hashes of all files in the directory (without dot files). A symlink or non-file — null (tampering).
export function hashTree(dir, { maxFiles = TAR_LIMITS.maxFiles } = {}) {
  const out = {};
  let n = 0;
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(msg("err.tree.symlink", { path: r }));
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) {
        if (++n > maxFiles) throw new Error(msg("err.tree.tooMany"));
        out[r] = sha256(readFileSync(p));
      } else throw new Error(msg("err.tree.notFile", { path: r }));
    }
  };
  walk(dir, "");
  return out;
}

// Version order by semver, like the shell's PluginVersion.compare: core X.Y.Z compared numerically (missing parts are zeros;
// non-numeric — as strings), a pre-release is lower than the release of the same version (1.3.0-beta.1 < 1.3.0), pre-release
// identifiers one by one: numeric as numbers, numeric lower than alphanumeric, alphanumeric as strings; with an equal common
// prefix the shorter is lower. Build metadata (+…) is ignored. → -1 | 0 | 1
export function compareVersions(a, b) {
  const [ca, pa] = splitVersion(a), [cb, pb] = splitVersion(b);
  const core = compareCore(ca, cb);
  if (core) return core;
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return comparePrerelease(pa, pb);
}

function splitVersion(v) {
  let s = String(v).trim();
  const plus = s.indexOf("+");
  if (plus >= 0) s = s.slice(0, plus);
  const dash = s.indexOf("-");
  if (dash < 0) return [s, null];
  const pre = s.slice(dash + 1);
  return [s.slice(0, dash), pre === "" ? null : pre];
}

const isNum = (x) => /^\d+$/.test(x);

function compareCore(a, b) {
  const pa = a.split(".").filter(Boolean), pb = b.split(".").filter(Boolean);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    if (isNum(x) && isNum(y)) {
      const nx = Number(x), ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      const c = x.localeCompare(y, "en", { numeric: true });
      if (c) return c < 0 ? -1 : 1;
    }
  }
  return 0;
}

function comparePrerelease(a, b) {
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    const nx = isNum(x), ny = isNum(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx) return -1;
    else if (ny) return 1;
    else return x < y ? -1 : 1;
  }
  if (pa.length === pb.length) return 0;
  return pa.length < pb.length ? -1 : 1;
}

function sameFiles(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

function isStr(v, max) {
  return typeof v === "string" && v.length <= max;
}

// Shape check of permissions from index.json: { kind: [{what, why}] , effects: [str], actions: [{id, level, command}] }
function validPermissions(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  for (const k of KINDS_WITH_WHY) {
    if (p[k] === undefined) continue;
    if (!Array.isArray(p[k]) || p[k].length > 100) return false;
    if (!p[k].every((e) => e && isStr(e.what, 1024) && (e.why === null || e.why === undefined || isStr(e.why, 1024)) && (e.recursive === undefined || e.recursive === true))) return false;
  }
  if (p.effects !== undefined && !(Array.isArray(p.effects) && p.effects.every((e) => isStr(e, 128)))) return false;
  if (p.actions !== undefined && !(Array.isArray(p.actions) && p.actions.every((a) => a && isStr(a.id, 64) && isStr(a.level, 32) && isStr(a.command, 2048) && (a.arg === undefined || isStr(a.arg, 256))))) return false;
  return true;
}

// Icon of an index entry: { symbol, color? } by the same rules as the <agenthub.icon> tag; otherwise null.
function entryIcon(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = parseIcon({ symbol: v.symbol, ...(v.color !== undefined ? { color: v.color } : {}) });
  return typeof r === "string" ? null : r;
}

// The plugin needs a newer contract than this hub has: refuse with "needs a newer hub" (not a linter error). → null | {need, have}
export function contractTooNew(need) {
  return Number.isInteger(need) && need > CONTRACT_VERSION ? { need, have: CONTRACT_VERSION } : null;
}
// Same for an index entry: a contract field of unknown shape (not an integer ≥ 1 — e.g. "2.1" or an object from a future
// build-index) is also "needs a newer hub" (need: null), not a rejection of the whole catalog. The object form
// {version, features} (B11, registry/perms.mjs indexContract) names features added to the contract after hub 0.1.2: a feature
// this hub doesn't know is "needs a newer hub" too (need: null, features: the unknown ones). → null | {need, have, features?}
export function entryContractTooNew(e) {
  if (e?.contractUnknown) return { need: null, have: CONTRACT_VERSION };
  const tooNew = contractTooNew(e?.contract);
  if (tooNew) return tooNew;
  const missing = (e?.contractFeatures || []).filter((f) => !CONTRACT_FEATURES.includes(f));
  return missing.length ? { need: null, have: CONTRACT_VERSION, features: missing } : null;
}

// The contract field of an index entry: an integer, or {version, features} (B11). → {contract, features} | null (unknown shape)
function entryContract(c) {
  if (Number.isInteger(c) && c >= 1 && c <= 9999) return { contract: c, features: [] };
  if (c && typeof c === "object" && !Array.isArray(c) && Number.isInteger(c.version) && c.version >= 1 && c.version <= 9999 && Array.isArray(c.features) && c.features.length <= 32 && c.features.every((f) => isStr(f, 32) && /^[a-z][a-z0-9-]*$/.test(f))) {
    return { contract: c.version, features: [...new Set(c.features)].sort() };
  }
  return null;
}

// Parse and shape-check index.json. → { generatedAt, plugins: Map, blocklist: [...] }
export function parseIndex(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new RegistryError(422, "registry:index-json");
  }
  if (!obj || obj.version !== INDEX_VERSION) throw new RegistryError(422, "registry:index-version");
  if (!isStr(obj.generatedAt, 64) || Number.isNaN(Date.parse(obj.generatedAt))) throw new RegistryError(422, "registry:index-generatedAt");
  if (!Array.isArray(obj.plugins) || obj.plugins.length > 2000) throw new RegistryError(422, "registry:index-plugins");
  const plugins = new Map();
  for (const e of obj.plugins) {
    const ok =
      e &&
      typeof e.id === "string" &&
      ID_RE.test(e.id) &&
      !RESERVED_IDS.has(e.id) &&
      isStr(e.version, 64) &&
      /^[0-9a-f]{64}$/.test(e.sha256 || "") &&
      isStr(e.archive, 512) &&
      e.archive.length > 0 &&
      Number.isInteger(e.size) &&
      e.size > 0 &&
      validPermissions(e.permissions) &&
      (e.platforms === undefined || (Array.isArray(e.platforms) && e.platforms.every((x) => isStr(x, 16)))) &&
      (e.tier === undefined || INDEX_TIERS.includes(e.tier)) &&
      // tier and the old official field must not disagree: one of them is forged or a build error
      (e.tier === undefined || e.official === undefined || (e.tier === "official") === (e.official === true)) &&
      (e.requires === undefined || (Array.isArray(e.requires) && e.requires.length <= 8));
    // contract 2: minimum plugin contract version (build-index takes it from <agenthub.contract>). An unknown
    // value doesn't break the catalog: the entry is marked "needs a newer hub" (entryContractTooNew)
    // B11: or {version, features} — the features newer than hub 0.1.2 the plugin uses (an older hub reads it as unknown)
    const ec = e?.contract === undefined || e?.contract === null ? null : entryContract(e.contract);
    if (!ok) throw new RegistryError(422, "registry:index-entry", { id: isStr(e?.id, 64) ? e.id : null });
    if (plugins.has(e.id)) throw new RegistryError(422, "registry:index-duplicate", { id: e.id });
    plugins.set(e.id, {
      id: e.id,
      version: e.version,
      title: isStr(e.title, 200) ? e.title : e.id,
      desc: isStr(e.desc, 1000) ? e.desc : null,
      // translations of the title and description (registry build-index: lang variants of the metadata) — strings only
      i18n: cleanI18n(e.i18n),
      author: cleanAuthor(e.author),
      platforms: e.platforms || [],
      type: e.type === "streamable" ? "streamable" : "standard",
      interval: isStr(e.interval, 16) ? e.interval : null,
      tier: entryTier(e),
      official: entryTier(e) === "official",
      archive: e.archive,
      sha256: e.sha256,
      size: e.size,
      permissions: e.permissions,
      // dependencies (<agenthub.requires>): "Requires <program>" in the catalog; an invalid entry is dropped entirely
      requires: (e.requires || []).map((r) => (r && typeof r === "object" ? parseRequires({ name: r.name, url: r.url, check: r.check }, isStr(r.note, 300) ? r.note : null) : "x")).filter((r) => typeof r === "object"),
      // minimum contract version (null — 1) and icon (<agenthub.icon>; invalid — no icon, the entry stays)
      contract: ec ? ec.contract : null,
      ...(ec?.features.length ? { contractFeatures: ec.features } : {}),
      ...(e.contract !== undefined && e.contract !== null && !ec ? { contractUnknown: true } : {}),
      icon: entryIcon(e.icon),
    });
  }
  const blocklist = [];
  for (const b of Array.isArray(obj.blocklist) ? obj.blocklist : []) {
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) continue;
    blocklist.push({
      id: b.id,
      versions: Array.isArray(b.versions) ? b.versions.filter((v) => isStr(v, 64)) : null,
      sha256: Array.isArray(b.sha256) ? b.sha256.filter((v) => /^[0-9a-f]{64}$/.test(v)) : null,
      reason: isStr(b.reason, 300) ? b.reason : "blocklist",
    });
  }
  return { generatedAt: obj.generatedAt, plugins, blocklist };
}

// Tiers a signed registry index may assign. The index doesn't assign builtin and local:
// those are install locations (the app directory and Plugins/local).
export const INDEX_TIERS = ["official", "community"];
// Tier of an index or plugins.lock entry: tier, and for entries predating tier — by the official field.
export function entryTier(e) {
  if (e?.tier === "official" || e?.tier === "community") return e.tier;
  return e?.official === true ? "official" : "community";
}

// ---------- several registries (G19) ----------
// services.plugins.registries: [{ name, indexUrl, publicKey, trust }] next to the old scalar indexUrl/publicKey pair, which keeps
// working as the registry "default" with trust "official" (and comes first). name — a-z, 0-9, "-" (starting with a letter, up to 32);
// trust — "official" (the index may name plugins official) or "community" (default: every entry is community, whatever the index
// says). Order matters: the same id in two registries — the earlier registry wins in the catalog (registry-shadowed is journaled),
// while an installed plugin always follows the registry it was installed from (lock entry registry). Each registry's signature is
// verified with its own key; a registry's blocklist applies to its own plugins, an official registry's blocklist — to all.
export const REGISTRY_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const REGISTRY_TRUST = ["official", "community"];
export const MAX_REGISTRIES = 8;
const strOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
// services.plugins → { list: [{name, indexUrl, publicKey, trust}], errors: [{index, name, error}] }
export function registrySources(opts = {}) {
  const list = [];
  const errors = [];
  const url0 = strOrNull(opts?.indexUrl);
  const key0 = typeof opts?.publicKey === "string" && opts.publicKey.trim() ? opts.publicKey : null;
  if (url0 || key0) list.push({ name: "default", indexUrl: url0, publicKey: key0, trust: "official" });
  const arr = Array.isArray(opts?.registries) ? opts.registries : [];
  arr.forEach((r, index) => {
    const name = typeof r?.name === "string" ? r.name : null;
    let error = null;
    if (!r || typeof r !== "object") error = "type";
    else if (!name || !REGISTRY_NAME_RE.test(name)) error = "name";
    else if (list.some((x) => x.name === name)) error = "duplicate";
    else if (!strOrNull(r.indexUrl)) error = "indexUrl";
    else if (typeof r.publicKey !== "string" || !r.publicKey.trim()) error = "publicKey";
    else if (r.trust !== undefined && !REGISTRY_TRUST.includes(r.trust)) error = "trust";
    else if (list.length >= MAX_REGISTRIES) error = "too-many";
    if (error) errors.push({ index, name: name && name.length <= 64 ? name : null, error });
    else list.push({ name, indexUrl: strOrNull(r.indexUrl), publicKey: r.publicKey, trust: r.trust || "community" });
  });
  return { list, errors };
}
// The label suffix of a registry: null when only the default registry is configured (single-registry UI unchanged), else the name.
export function registryLabel(name, sources) {
  if (!name) return null;
  return sources.length === 1 && sources[0].name === "default" && name === "default" ? null : name;
}
// "official plugin · <name>" in the hub language.
export function tierLabel(tier, name, sources) {
  const base = msg(`tier.${tier === "official" ? "official" : "community"}`);
  const l = registryLabel(name, sources);
  return l ? `${base} · ${l}` : base;
}

export class PluginManager {
  // fetcher(url, maxBytes) → Promise<Buffer> — network stub for tests.
  // onChange() — after the manager changed Plugins/ (install, removal, blocklist, quarantine): the service
  // asks the core to rescan plugins without waiting for fs.watch (FSEvents events can be lost).
  // onUpdates(items) — the list of available updates (pluginUpdates) changed: the service sends an event and a notification.
  // pinned() — whether the app build is pinned (requirements.app): without it nobody can approve an own plugin request.
  constructor({ config, journal = null, emit = null, estop = () => false, fetcher = null, onChange = null, onUpdates = null, lang = currentLang, pinned = () => true } = {}) {
    this.config = config;
    this.pinned = pinned;
    this.lang = lang;
    this.paths = config.paths;
    // services.plugins is re-read from config.json when it changes (getter opts): the registry can be connected
    // without restarting the daemon, and a key removed from the file really disappears. baseOpts — what didn't come from
    // the file (test overrides; services.plugins has no defaults): it overrides the file, as in loadConfig.
    const startFile = readPluginOpts(config.paths.config) || {};
    const startOpts = config.services?.plugins || {};
    this.baseOpts = Object.fromEntries(Object.entries(startOpts).filter(([k, v]) => !(k in startFile) || JSON.stringify(startFile[k]) !== JSON.stringify(v)));
    this.optsNow = startOpts;
    this.optsSig = config.configLoadedSig ?? null;
    this.journal = journal;
    this.emitFn = emit;
    this.estop = estop;
    this.fetcher = fetcher;
    this.onChange = onChange;
    this.onUpdates = onUpdates;
    this.updatesFp = null; // fingerprint of the last update list (noteUpdates)
    this.dirs = {
      registry: join(this.paths.home, "Registry"),
      staging: join(this.paths.home, "Registry", "staging"),
      trash: join(this.paths.home, "Registry", "trash"),
      disabled: join(this.paths.home, "Registry", "disabled"),
      quarantine: join(this.paths.home, "Registry", "quarantine"),
      archives: join(this.paths.home, "Registry", "archives"),
      attest: join(this.paths.home, "Registry", "attest"),
    };
    this.files = {
      index: join(this.dirs.registry, "index.json"),
      sig: join(this.dirs.registry, "index.json.minisig"),
      state: join(this.dirs.registry, "state.json"),
      tiers: join(this.dirs.registry, "tiers.json"),
    };
    this.lowered = null; // id → {version, sha256, reason, at}: installed as official, the catalog no longer says so (tiers.json)
    // Registry sources (G19, registrySources): name → { catalog: { generatedAt, plugins: Map, blocklist, fetchedAt } | null,
    // error, stamp (size and mtime of its index.json/.minisig on disk the catalog was loaded from), key (the public key it was
    // verified with) }. this.catalog — the merged view (catalogView).
    this.cats = new Map();
    this.catsVer = 0;
    this.merged = null;
    this.sourcesMemo = null;
    this.shadowNoted = new Set();
    this.archiveCache = new Map(); // `${id}|${sha256}|${stat}` → { rel: sha256 } | null
    this.attestCache = new Map(); // `${registry}|${id}` → { key: `${stat}|${publicKey}`, entry: index entry | null }
    this.pending = new Map(); // consent token → { id, pid, expires, prep }
    this.lockCache = null;
    // Installs and updates in progress (id → {id, op, title, version, since}): downloading and verifying
    // the archive, writing files. The "safe to shut down" verdict (idle service) — fact plugins.busy, event plugins.busy.
    // Reference-counted (busyRefs): two concurrent installs of the same id (two windows, a repeated click) — the mark
    // is cleared only when the last one finishes.
    this.busyOps = new Map();
    this.busyRefs = new Map();
    // Own sources: install requests (requestId → request), folder state of installed own plugins
    // (id → {status, …}), folder watchers and timers (startOwn/stopOwn — the plugins service).
    this.ownRequests = new Map();
    this.ownState = new Map();
    this.ownWatchers = new Map(); // id → { path, watcher }
    this.ownDebounce = new Map(); // id → timeout
    this.ownTimer = null;
    this.ownOpts = { ...OWN_DEFAULTS };
    this.ownStarted = false;
    this.uid = myUid() ?? -1;
    // Consents for own plugins: id → fingerprint of the lock entry the manager itself made (approvalDigest). Memory
    // is filled at startup from Registry/own-approvals.json and afterwards only by the manager; approvalsDisk — cache
    // of the file by signature (ino, size, mtime): only revocation is taken from the file.
    this.ownApproved = new Map();
    this.approvalsDisk = null;
    this.ownUnexpected = new Map(); // id → fingerprint of an entry already reported (log, push, request)
  }

  // Plugins' HOME (synthetic on the test bench — AGENTHUB_PLUGIN_HOME): used to expand "~" in dependency
  // checks and to shorten the own folder path for display.
  homeDir() {
    return this.config.pluginHome || homedir();
  }

  busyList() {
    return [...this.busyOps.values()].map((b) => ({ ...b }));
  }
  // info — start (one more reference), null — finish one.
  setBusy(id, info) {
    const n = this.busyRefs.get(id) || 0;
    if (info) {
      this.busyRefs.set(id, n + 1);
      this.busyOps.set(id, { id, since: this.busyOps.get(id)?.since || new Date().toISOString(), ...info });
    } else {
      if (n <= 0) return;
      if (n > 1) return void this.busyRefs.set(id, n - 1);
      this.busyRefs.delete(id);
      this.busyOps.delete(id);
    }
    this.emit({ type: "plugins.busy", busy: this.busyList() });
  }
  // Title and version for the "Installing plugin: …" line — from the verified catalog in the hub language.
  busyInfo(id, entry = null) {
    const installed = this.lock().plugins[id] || null;
    const e = entry || (installed?.tier === "own" ? installed : null) || this.catalogEntry(id, installed) || null;
    return { op: installed ? "update" : "install", title: (e && pickLang(e.title, e.i18n, "title", this.langNow())) || id, version: e?.version || null };
  }

  log(entry) {
    try {
      this.journal?.write(entry);
    } catch {}
  }
  emit(ev) {
    try {
      this.emitFn?.(ev);
    } catch {}
  }
  changed() {
    try {
      this.onChange?.();
    } catch {}
  }
  // The update list may have changed (new catalog, install, removal, blocklist): report if it changed.
  noteUpdates() {
    let items;
    try {
      items = this.pluginUpdates();
    } catch {
      return;
    }
    const fp = JSON.stringify(items.map((u) => [u.id, u.installed, u.version, u.sha256, u.permissionsGrow]));
    if (fp === this.updatesFp) return;
    this.updatesFp = fp;
    try {
      this.onUpdates?.(items);
    } catch {}
  }

  // cleanTemp: "all" — at startup the daemon clears everything from Registry/staging and trash (leftovers of interrupted installs);
  // "stale" — the CLI (agenthub plugins install/remove) clears only what's older than 10 min: something fresh may be
  // an install the daemon is running right now.
  async init({ cleanTemp = "all" } = {}) {
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const d of [this.dirs.staging, this.dirs.trash]) {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (cleanTemp !== "all") {
          try {
            if (Date.now() - lstatSync(p).mtimeMs < 10 * 60_000) continue;
          } catch {
            continue;
          }
        }
        rmSync(p, { recursive: true, force: true });
      }
    }
    // interception points by the real paths on this machine (symlinks in dotfiles) — for the loud line in the consent window
    refreshLocalWritePlaces();
    this.ownApproved = new Map(this.readApprovalsDisk());
    this.loadRequests();
    this.loadCached();
    this.applyBlocklist();
    this.noteUpdates();
  }

  // ---------- consents for own plugins ----------
  approvalsPath() {
    return join(this.dirs.registry, "own-approvals.json");
  }

  // Fingerprint of an own plugin's lock entry: folder path, content fingerprint, copy files and granted permissions.
  approvalDigest(id, e) {
    const files = Object.entries(e?.files || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return sha256(JSON.stringify([id, e?.own?.path || null, e?.sha256 || null, files, permissionsFingerprint(e?.granted)]));
  }

  // Consents file: id → fingerprint (cached by file signature).
  readApprovalsDisk() {
    const path = this.approvalsPath();
    const sig = fileSig(path);
    if (this.approvalsDisk?.sig === sig) return this.approvalsDisk.map;
    const map = new Map();
    const j = readJsonOr(path, null);
    if (j?.version === 1 && j.plugins && typeof j.plugins === "object") {
      for (const [id, r] of Object.entries(j.plugins)) if (ID_RE.test(id) && typeof r?.digest === "string") map.set(id, r.digest);
    }
    this.approvalsDisk = { sig, map };
    return map;
  }

  // Writing consents: only what's both in memory and in the file (a revocation from the file stands, a foreign entry doesn't), plus
  // change (id → fingerprint | null — remove).
  writeApprovals(change = {}) {
    const disk = this.readApprovalsDisk();
    const next = new Map();
    for (const [id, d] of this.ownApproved) if (disk.get(id) === d) next.set(id, d);
    for (const [id, d] of Object.entries(change)) {
      if (d) next.set(id, d);
      else next.delete(id);
    }
    this.ownApproved = next;
    const plugins = {};
    for (const [id, digest] of next) plugins[id] = { digest };
    try {
      atomicWrite(this.approvalsPath(), JSON.stringify({ version: 1, plugins }, null, 2) + "\n");
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.own.consentsNotSaved", { why: e.code || e.message }) });
    }
    this.approvalsDisk = null;
  }

  // Was the own entry in lock made by the manager itself after human consent (or by a quiet update from the same folder)?
  ownTrusted(id, e) {
    if (e?.tier !== "own") return false;
    const mem = this.ownApproved.get(id);
    if (!mem || mem !== this.approvalDigest(id, e)) return false;
    return this.readApprovalsDisk().get(id) === mem;
  }

  // An own entry the manager didn't make: report once per its fingerprint — log, event (push service — security
  // exception) and a re-approval request from the entry's folder (if it passes the check).
  noteUnexpectedOwn(id, e) {
    const digest = this.approvalDigest(id, e);
    if (this.ownUnexpected.get(id) === digest) return;
    this.ownUnexpected.set(id, digest);
    this.log({ type: "plugin-own-unexpected", plugin: id, version: e.version || null, path: e.own?.path || null, sha256: e.sha256 || null });
    this.emit({ type: "plugins.own-unexpected", plugin: id, version: e.version || null });
    const path = e.own?.path;
    if (!path) return;
    setImmediate(() => {
      try {
        this.requestOwn(path, { peer: { class: "hub" }, reason: "unexpected" });
      } catch (err) {
        this.log({ type: "plugin-own-rejected", plugin: id, error: err?.code || "own:error", reason: "unexpected" });
      }
    });
  }

  // ---------- plugins.lock ----------
  lock() {
    const path = this.paths.pluginsLock;
    let mtime = null;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {}
    if (this.lockCache && this.lockCache.mtime === mtime) return this.lockCache.data;
    const data = readJsonOr(path, null);
    const lock = data && data.version === LOCK_VERSION && data.plugins && typeof data.plugins === "object" ? data : { version: LOCK_VERSION, plugins: {} };
    this.lockCache = { mtime, data: lock };
    return lock;
  }
  saveLock(lock) {
    atomicWrite(this.paths.pluginsLock, JSON.stringify(lock, null, 2) + "\n");
    this.lockCache = null;
  }
  lockEntry(id) {
    return this.lock().plugins[id] || null;
  }

  get opts() {
    const sig = fileSig(this.paths.config);
    if (sig === this.optsSig) return this.optsNow;
    const file = sig === "absent" ? {} : readPluginOpts(this.paths.config);
    if (!file) return this.optsNow; // the file is being written right now — read it next time
    this.optsSig = sig;
    const prev = this.optsNow;
    this.optsNow = { ...file, ...this.baseOpts };
    const regSig = (o) => JSON.stringify(registrySources(o).list);
    if (regSig(prev) !== regSig(this.optsNow)) {
      const now = registrySources(this.optsNow);
      this.log({ type: "registry-config-changed", indexUrl: Boolean(this.indexUrl()), publicKey: Boolean(this.publicKey()), registries: now.list.map((r) => r.name), ...(now.errors.length ? { invalid: now.errors } : {}) });
      // a catalog on disk was verified with the previous key — re-verify with the new one (or reset); a removed registry's
      // catalog is dropped (its installed plugins become community until it is back)
      this.loadCached();
      this.noteUpdates();
    }
    return this.optsNow;
  }

  // ---------- registry sources (G19) ----------
  // The configured registries in order (registrySources): the scalar indexUrl/publicKey pair is the registry "default"
  // (trust official), then services.plugins.registries[].
  sources() {
    const o = this.opts;
    if (this.sourcesMemo?.opts !== o) this.sourcesMemo = { opts: o, list: registrySources(o).list };
    return this.sourcesMemo.list;
  }
  source(name) {
    return this.sources().find((r) => r.name === name) || null;
  }
  // The registry an installed (lock) entry came from: its registry field; an entry from before G19 — "default", or the first
  // configured registry when there is no default.
  registryOf(e) {
    if (typeof e?.registry === "string" && REGISTRY_NAME_RE.test(e.registry)) return e.registry;
    const list = this.sources();
    return list.some((r) => r.name === "default") || !list.length ? "default" : list[0].name;
  }
  // Files of a registry: "default" keeps the historical Registry/index.json…, Registry/attest/; others — Registry/sources/<name>/.
  srcFiles(name) {
    const dir = name === "default" ? this.dirs.registry : join(this.dirs.registry, "sources", name);
    return { dir, index: join(dir, "index.json"), sig: join(dir, "index.json.minisig"), state: join(dir, "state.json"), attest: name === "default" ? this.dirs.attest : join(dir, "attest") };
  }
  catState(name) {
    let c = this.cats.get(name);
    if (!c) this.cats.set(name, (c = { catalog: null, error: null, stamp: null }));
    return c;
  }
  setCat(name, catalog, error = undefined) {
    const c = this.catState(name);
    c.catalog = catalog;
    if (error !== undefined) c.error = error;
    this.catsVer++;
  }
  // The merged catalog: every registry's plugins in config order; the same id in a later registry is shadowed by the
  // earlier one (journaled once, registry-shadowed) — except for an installed plugin, which always follows the registry it was
  // installed from (catalogEntry). Blocklists: tagged with their registry (blockReason). null — no verified catalog at all.
  get catalog() {
    const key = `${this.catsVer}|${this.sources().map((r) => r.name).join(",")}`;
    if (this.merged?.key === key) return this.merged.value;
    const plugins = new Map();
    const blocklist = [];
    let generatedAt = null;
    let fetchedAt = null;
    let any = false;
    const shadowed = [];
    for (const src of this.sources()) {
      const cat = this.cats.get(src.name)?.catalog;
      if (!cat) continue;
      any = true;
      if (!generatedAt || Date.parse(cat.generatedAt) > Date.parse(generatedAt)) generatedAt = cat.generatedAt;
      if (cat.fetchedAt && (!fetchedAt || Date.parse(cat.fetchedAt) > Date.parse(fetchedAt))) fetchedAt = cat.fetchedAt;
      for (const [id, e] of cat.plugins) {
        if (plugins.has(id)) shadowed.push({ id, registry: src.name, by: plugins.get(id).registry });
        else plugins.set(id, e);
      }
      for (const b of cat.blocklist) blocklist.push(b);
    }
    for (const x of shadowed) {
      const k = `${x.id}|${x.registry}|${x.by}`;
      if (this.shadowNoted.has(k)) continue;
      this.shadowNoted.add(k);
      this.log({ type: "registry-shadowed", plugin: x.id, registry: x.registry, by: x.by });
    }
    const value = any ? { generatedAt, fetchedAt, plugins, blocklist, shadowed } : null;
    this.merged = { key, value };
    return value;
  }
  // The first registry's error (the old single-registry field), or null.
  get catalogError() {
    for (const src of this.sources()) {
      const e = this.cats.get(src.name)?.error;
      if (e) return e;
    }
    return null;
  }
  // The catalog entry for id: an installed registry plugin — from the registry it was installed from (an earlier registry
  // listing the same id never takes it over); otherwise — the first registry listing it.
  catalogEntry(id, inst = this.lockEntry(id)) {
    if (inst && inst.tier !== "own") return this.cats.get(this.registryOf(inst))?.catalog?.plugins.get(id) || null;
    return this.catalog?.plugins.get(id) || null;
  }
  // Registries for the shell (GET /registry/catalog → registries): name, trust, state of its catalog.
  registriesView() {
    return this.sources().map((r) => {
      const c = this.cats.get(r.name) || {};
      return {
        name: r.name,
        trust: r.trust,
        // the tier label suffix: null for the single default registry (the UI stays as before)
        label: registryLabel(r.name, this.sources()),
        configured: Boolean(r.indexUrl && r.publicKey),
        missing: [!r.indexUrl && "index-url", !r.publicKey && "public-key"].filter(Boolean),
        generatedAt: c.catalog?.generatedAt || null,
        fetchedAt: c.catalog?.fetchedAt || null,
        plugins: c.catalog ? c.catalog.plugins.size : 0,
        error: c.error || null,
        // "official plugin · <name>" in the hub language (the suffix only when there is more than the default registry)
        tierLabel: tierLabel(r.trust, r.name, this.sources()),
      };
    });
  }

  // ---------- catalog ----------
  // The first registry's index URL and key (single-registry fields of /registry/catalog: configured, missing).
  publicKey(name = null) {
    const src = name ? this.source(name) : this.sources()[0];
    const k = src?.publicKey;
    return typeof k === "string" && k.trim() ? k : null;
  }

  // Verify an index with the key of registry name and parse it. A registry with trust "community" never makes a plugin
  // official (its entries are capped to community); every entry carries the registry name.
  verifyIndex(indexBytes, sigText, name = this.sources()[0]?.name || "default") {
    const src = this.source(name);
    const key = src?.publicKey || null;
    if (!key) throw new RegistryError(409, "registry:no-public-key", { registry: name });
    const v = verifySignature(indexBytes, String(sigText), key);
    if (!v.ok) throw new RegistryError(422, `registry:${v.reason === "key-mismatch" ? "foreign-key" : v.reason}`, { registry: name });
    const idx = parseIndex(Buffer.from(indexBytes).toString("utf8"));
    for (const e of idx.plugins.values()) {
      e.registry = name;
      if (src.trust !== "official" && e.tier === "official") {
        e.tier = "community";
        e.official = false;
        e.capped = true;
      }
    }
    for (const b of idx.blocklist) b.registry = name;
    return idx;
  }

  // Fingerprint of a registry's index.json and signature on disk: another process may have updated it (`agenthub plugins install`).
  diskStamp(name = "default") {
    const f = this.srcFiles(name);
    try {
      const a = statSync(f.index);
      const b = statSync(f.sig);
      return `${a.size}:${a.mtimeMs}:${a.ctimeMs}|${b.size}:${b.mtimeMs}:${b.ctimeMs}`;
    } catch {
      return null;
    }
  }

  // Re-read the catalogs from disk if they were changed outside this process. An older index (rollback) is not taken. Files that
  // don't verify (a half-written pair from another process — index.json is replaced before its signature — or a damaged file) don't
  // replace the last verified catalog in memory: tiers keep following it until a pair on disk verifies again.
  refreshCatalog() {
    let changed = false;
    for (const src of this.sources()) {
      const st = this.catState(src.name);
      const stamp = this.diskStamp(src.name);
      if (stamp === st.stamp && st.key === src.publicKey) continue;
      const prev = st.catalog;
      this.loadSource(src);
      if (prev && st.catalog && Date.parse(st.catalog.generatedAt) < Date.parse(prev.generatedAt)) {
        this.log({ type: "registry-rejected", registry: src.name, error: "registry:rollback" });
        this.setCat(src.name, prev);
      }
      if (prev && !st.catalog && st.error && st.key === src.publicKey) this.setCat(src.name, prev);
      changed = true;
    }
    if (changed) this.noteUpdates();
  }

  // (Re)load every registry's catalog from disk; registries no longer configured are forgotten.
  loadCached() {
    const names = new Set(this.sources().map((r) => r.name));
    for (const n of [...this.cats.keys()]) if (!names.has(n)) this.cats.delete(n);
    for (const src of this.sources()) this.loadSource(src);
    this.catsVer++;
  }
  loadSource(src) {
    const st = this.catState(src.name);
    const f = this.srcFiles(src.name);
    this.setCat(src.name, null);
    st.stamp = this.diskStamp(src.name);
    st.key = src.publicKey;
    if (!existsSync(f.index) || !existsSync(f.sig)) return;
    try {
      const idx = this.verifyIndex(readFileSync(f.index), readFileSync(f.sig, "utf8"), src.name);
      this.setCat(src.name, { ...idx, fetchedAt: readJsonOr(f.state, {}).fetchedAt || null }, null);
    } catch (e) {
      this.setCat(src.name, null, e.code || e.message);
      this.log({ type: "registry-cache-rejected", registry: src.name, error: e.code || e.message });
    }
  }

  indexUrl(name = null) {
    const src = name ? this.source(name) : this.sources()[0];
    const u = src?.indexUrl;
    return typeof u === "string" && u.trim() ? u.trim() : null;
  }

  async fetchBytes(url, maxBytes) {
    if (this.fetcher) {
      const b = Buffer.from(await this.fetcher(url, maxBytes));
      if (b.length > maxBytes) throw new RegistryError(413, "registry:too-large");
      return b;
    }
    if (url.startsWith("/") || url.startsWith("file:")) {
      const path = url.startsWith("file:") ? fileURLToPath(url) : url;
      let st;
      try {
        st = statSync(path);
      } catch {
        throw new RegistryError(404, "registry:not-found");
      }
      if (st.size > maxBytes) throw new RegistryError(413, "registry:too-large");
      return readFileSync(path);
    }
    if (!url.startsWith("https://")) throw new RegistryError(400, "registry:url-scheme");
    if (this.opts.allowNetwork === false) throw new RegistryError(409, "registry:network-disabled");
    let res;
    try {
      res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new RegistryError(502, "registry:fetch");
    }
    if (!res.url.startsWith("https://")) throw new RegistryError(502, "registry:redirect");
    if (!res.ok) throw new RegistryError(502, "registry:http", { http: res.status });
    const chunks = [];
    let n = 0;
    for await (const c of res.body) {
      n += c.length;
      if (n > maxBytes) throw new RegistryError(413, "registry:too-large");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // Archive URL relative to the index.json of the entry's registry; locally — not above the index directory.
  archiveUrl(entry) {
    const base = this.indexUrl(entry.registry || this.sources()[0]?.name || "default");
    if (!base) throw new RegistryError(409, "registry:no-index-url");
    if (/^https:\/\//.test(entry.archive)) return entry.archive;
    if (/^[a-z]+:/i.test(entry.archive) || entry.archive.startsWith("/")) throw new RegistryError(422, "registry:archive-url");
    if (base.startsWith("https://")) {
      const u = new URL(entry.archive, base);
      if (u.protocol !== "https:") throw new RegistryError(422, "registry:archive-url");
      return u.href;
    }
    const baseDir = dirname(base.startsWith("file:") ? fileURLToPath(base) : base);
    const p = resolve(baseDir, entry.archive);
    if (!p.startsWith(baseDir + sep)) throw new RegistryError(422, "registry:archive-url");
    return p;
  }

  // Download and verify every configured registry (G19). One registry — as before: its error is thrown. Several — each on its own;
  // throws only if none succeeded (the first error). → { generatedAt, plugins, blocklist, registries: [{name, ok, error?, …}] }
  async fetchCatalog() {
    const list = this.sources();
    if (!list.length || !list.some((r) => r.indexUrl)) throw new RegistryError(409, "registry:no-index-url");
    if (!list.some((r) => r.indexUrl && r.publicKey)) throw new RegistryError(409, "registry:no-public-key");
    const results = [];
    let firstError = null;
    for (const src of list) {
      if (!src.indexUrl || !src.publicKey) {
        results.push({ name: src.name, ok: false, error: src.indexUrl ? "registry:no-public-key" : "registry:no-index-url" });
        continue;
      }
      try {
        results.push({ name: src.name, ok: true, ...(await this.fetchSource(src)) });
      } catch (e) {
        firstError ||= e;
        results.push({ name: src.name, ok: false, error: e.code || e.message });
      }
    }
    if (list.length === 1 && firstError) throw firstError;
    if (!results.some((r) => r.ok)) throw firstError || new RegistryError(502, "registry:fetch");
    this.applyBlocklist();
    // New catalogs may have changed the tier of installed plugins (official → community): the core re-evaluates the policy.
    this.changed();
    const cat = this.catalog;
    this.emit({ type: "plugins.catalog", generatedAt: cat?.generatedAt || null, plugins: cat?.plugins.size || 0 });
    this.noteUpdates();
    return { generatedAt: cat?.generatedAt || null, plugins: cat?.plugins.size || 0, blocklist: cat?.blocklist.length || 0, registries: results };
  }

  async fetchSource(src) {
    const url = src.indexUrl;
    const f = this.srcFiles(src.name);
    const sigUrl = url.startsWith("https://") ? new URL(url).href + ".minisig" : url + ".minisig";
    const [indexBytes, sigBytes] = await Promise.all([this.fetchBytes(url, MAX_INDEX_BYTES), this.fetchBytes(sigUrl, MAX_SIG_BYTES)]);
    let idx;
    try {
      idx = this.verifyIndex(indexBytes, sigBytes.toString("utf8"), src.name);
    } catch (e) {
      this.log({ type: "registry-rejected", registry: src.name, error: e.code || e.message });
      throw e;
    }
    const st = this.catState(src.name);
    const prev = readJsonOr(f.state, {}).generatedAt || st.catalog?.generatedAt || null;
    if (prev && Date.parse(idx.generatedAt) < Date.parse(prev)) {
      this.log({ type: "registry-rejected", registry: src.name, error: "registry:rollback" });
      throw new RegistryError(409, "registry:rollback", { have: prev, got: idx.generatedAt, registry: src.name });
    }
    // The previous catalog is being replaced: save the signed attestation of officialness for installed versions that are
    // the latest in it (otherwise a new release by itself, without an update, would demote the installed one to community).
    this.keepAttestations(idx, src.name);
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    atomicWrite(f.index, indexBytes);
    atomicWrite(f.sig, sigBytes);
    const fetchedAt = new Date().toISOString();
    atomicWrite(f.state, JSON.stringify({ generatedAt: idx.generatedAt, fetchedAt }) + "\n");
    this.setCat(src.name, { ...idx, fetchedAt }, null);
    st.stamp = this.diskStamp(src.name);
    st.key = src.publicKey;
    this.log({ type: "registry-fetched", registry: src.name, generatedAt: idx.generatedAt, plugins: idx.plugins.size, blocked: idx.blocklist.length });
    return { generatedAt: idx.generatedAt, plugins: idx.plugins.size, blocklist: idx.blocklist.length };
  }

  // ---------- blocklist ----------
  // A blocklist entry applies to a plugin from its own registry; blocklists of registries with trust "official" apply to every
  // plugin (the hub's kill switch). registry — the plugin's registry (null: a local plugin or not from a registry).
  blockReason(id, { version = null, sha256: sum = null, any = false, registry = null } = {}) {
    for (const b of this.catalog?.blocklist || []) {
      if (b.id !== id) continue;
      if (b.registry && b.registry !== registry && this.source(b.registry)?.trust !== "official") continue;
      const all = !b.versions?.length && !b.sha256?.length;
      if (all) return b.reason;
      if (any) continue;
      if (version && b.versions?.includes(version)) return b.reason;
      if (sum && b.sha256?.includes(sum)) return b.reason;
    }
    return null;
  }

  // Disables installed plugins from the blocklist (the directory moves to Registry/disabled/<id>, the core doesn't see it)
  // and restores those removed from the blocklist (if the files match lock).
  applyBlocklist() {
    const lock = this.lock();
    let changed = false;
    for (const [id, e] of Object.entries(lock.plugins)) {
      // The registry blocklist is about registry plugins; it doesn't disable an own plugin from its own folder (the human installed it).
      // An own entry the manager didn't make (ownTrusted) is not an own plugin: the blocklist applies to it.
      if (this.ownTrusted(id, e)) continue;
      const reason = this.blockReason(id, { version: e.version, sha256: e.sha256, registry: this.registryOf(e) });
      const live = join(this.paths.plugins, id);
      const off = join(this.dirs.disabled, id);
      if (reason && !e.disabled) {
        if (existsSync(live)) {
          rmSync(off, { recursive: true, force: true });
          renameSync(live, off);
        }
        e.disabled = { reason: "blocklist", detail: reason, at: new Date().toISOString() };
        changed = true;
        this.log({ type: "plugin-blocked", plugin: id, version: e.version });
        this.emit({ type: "plugins.blocked", plugin: id });
      } else if (!reason && e.disabled?.reason === "blocklist" && existsSync(off)) {
        let ok = false;
        try {
          ok = sameFiles(hashTree(off), e.files);
        } catch {}
        if (ok && !existsSync(live)) {
          renameSync(off, live);
          e.disabled = null;
          changed = true;
          this.log({ type: "plugin-unblocked", plugin: id, version: e.version });
        }
      }
    }
    if (changed) {
      this.saveLock(lock);
      this.changed();
      this.noteUpdates();
    }
  }

  // ---------- policy for the core ----------
  // fn(plugin, defaults) from ctx.setPluginPolicy. The core still clamps effects to the ceiling.
  policy(pl, defaults) {
    if (pl.source === "builtin") return null;
    if (pl.source === "local") {
      const reason = this.blockReason(pl.id, { any: true });
      return reason ? { allowed: false, reason: "blocklist" } : null;
    }
    const v = this.checkInstalled(pl);
    if (!v.ok) return { allowed: false, reason: v.reason };
    const granted = new Set(v.entry.granted?.effects || []);
    // tier comes from the verified catalog right now (not from lock and not from plugin metadata), see officialNow; own —
    // only a lock entry the manager made itself after human consent in the app (approveOwn / update
    // from the same folder): ownTrusted checks it against the consent fingerprint. A tier: "own" field written bypassing the manager
    // gives community (and the plugin-own-unexpected signal); files on disk are exactly the lock entry (checkInstalled).
    let tier;
    if (v.entry.tier === "own") {
      tier = this.ownTrusted(pl.id, v.entry) ? "own" : "community";
      if (tier !== "own") this.noteUnexpectedOwn(pl.id, v.entry);
    } else {
      tier = this.officialNow(pl.id, v.entry) ? "official" : "community";
      this.noteTier(pl.id, v.entry, tier === "official");
    }
    // registry (G19): where a registry plugin came from — the core shows it in /state.plugins[].registry(Label)
    const reg = v.entry.tier === "own" ? null : this.registryOf(v.entry);
    return { allowed: true, effects: (defaults?.effects || []).filter((e) => granted.has(e)), tier, official: tier === "official", ...(reg ? { registry: reg, registryLabel: registryLabel(reg, this.sources()) } : {}) };
  }

  // Is the installed plugin official right now: the signed catalog names the id official (tier not lowered),
  // the archive sha256 from lock is signed as official — by the current catalog or the saved attestation
  // (Registry/attest/<id>: the previous index where this version was the latest; verified with the same public key),
  // and the lock files (also on disk — checkInstalled) are exactly the contents of the saved archive with that sha256.
  // A lock entry with tier official made bypassing the manager grants no officialness: no signed index
  // names its archive official.
  officialNow(id, e) {
    // an own plugin is never official, even if the catalog has a plugin with the same id and the same content
    if (e?.tier === "own") return false;
    this.refreshCatalog();
    const ce = e ? this.catalogEntry(id, e) : null;
    if (!ce || ce.tier !== "official" || !e) return false;
    if (ce.sha256 !== e.sha256 && !this.attestedOfficial(id, e)) return false;
    const files = this.archiveFiles(id, e.sha256);
    return Boolean(files) && sameFiles(files, e.files);
  }

  // ---------- official → community and back (decision 2026-11-11) ----------
  loweredMap() {
    if (this.lowered) return this.lowered;
    const j = readJsonOr(this.files.tiers, null);
    const out = new Map();
    if (j && j.version === 1 && j.lowered && typeof j.lowered === "object" && !Array.isArray(j.lowered)) {
      for (const [id, v] of Object.entries(j.lowered).slice(0, 500)) if (ID_RE.test(id) && v && typeof v === "object") out.set(id, v);
    }
    this.lowered = out;
    return out;
  }
  saveLowered() {
    try {
      atomicWrite(this.files.tiers, JSON.stringify({ version: 1, lowered: Object.fromEntries(this.loweredMap()) }, null, 2) + "\n");
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.fileNotWritten", { file: "tiers.json", why: e.code || e.message }) });
    }
  }
  // Why an installed official plugin is not official now: the id is gone from the catalog, the catalog lists it as community,
  // or the installed archive is not the signed one (no attestation, files differ from the saved archive).
  lowerReason(id, e) {
    const ce = this.catalogEntry(id, e);
    if (!ce) return "not-in-catalog";
    if (ce.tier !== "official") return "community";
    return "archive";
  }
  // Called by the policy for every installed registry plugin: a plugin installed as official (lock tier) that the verified
  // catalog doesn't call official now is journaled once; back to official — once more. Without a verified catalog (never
  // fetched, the cache on disk failed its signature) nothing is journaled: there is nothing to compare with.
  noteTier(id, e, official) {
    const cat = this.cats.get(this.registryOf(e))?.catalog || null;
    if (entryTier(e) !== "official" || !cat) return;
    const map = this.loweredMap();
    const mark = map.get(id);
    const same = mark && mark.sha256 === e.sha256;
    if (!official && !same) {
      const reason = this.lowerReason(id, e);
      map.set(id, { version: e.version, sha256: e.sha256, reason, at: new Date().toISOString() });
      this.saveLowered();
      this.log({ type: "plugin-tier-lowered", plugin: id, version: e.version, from: "official", to: "community", reason, generatedAt: cat.generatedAt, registry: this.registryOf(e) });
    } else if (official && mark) {
      map.delete(id);
      this.saveLowered();
      if (same) this.log({ type: "plugin-tier-restored", plugin: id, version: e.version, from: "community", to: "official", generatedAt: cat.generatedAt, registry: this.registryOf(e) });
    }
  }
  // The plugin was installed again or removed: the previous mark is about another install.
  clearLowered(id) {
    if (!this.loweredMap().has(id)) return;
    this.lowered.delete(id);
    this.saveLowered();
  }

  // Attestations of id in every configured registry (and the one the lock entry names): removed on update and removal.
  dropAttest(id, e = null) {
    const regs = new Set(["default", ...this.sources().map((r) => r.name), ...(e ? [this.registryOf(e)] : [])]);
    for (const r of regs) for (const f of Object.values(this.attestFiles(id, r))) rmSync(f, { force: true });
  }
  attestFiles(id, registry = "default") {
    const dir = this.srcFiles(registry).attest;
    return { index: join(dir, `${id}.json`), sig: join(dir, `${id}.json.minisig`) };
  }

  // Does the saved signed index name the installed version (id, version, archive sha256) official?
  attestedOfficial(id, e) {
    const reg = this.registryOf(e);
    const f = this.attestFiles(id, reg);
    let stamp;
    try {
      const a = lstatSync(f.index);
      const b = lstatSync(f.sig);
      if (!a.isFile() || !b.isFile()) return false;
      stamp = `${a.size}:${a.mtimeMs}:${a.ctimeMs}:${a.ino}|${b.size}:${b.mtimeMs}:${b.ctimeMs}:${b.ino}`;
    } catch {
      return false;
    }
    const key = `${stamp}|${this.source(reg)?.publicKey || ""}`;
    let hit = this.attestCache.get(`${reg}|${id}`);
    if (!hit || hit.key !== key) {
      let entry = null;
      try {
        if (this.source(reg) && statSync(f.index).size <= MAX_INDEX_BYTES) entry = this.verifyIndex(readFileSync(f.index), readFileSync(f.sig, "utf8"), reg).plugins.get(id) || null;
      } catch {
        entry = null;
      }
      hit = { key, entry };
      this.attestCache.set(`${reg}|${id}`, hit);
    }
    const ae = hit.entry;
    return Boolean(ae && ae.tier === "official" && ae.sha256 === e.sha256 && ae.version === e.version);
  }

  // The new catalog next replaces the current one (verified, on disk): for installed plugins whose version is official
  // in the current catalog and no longer the latest in the new one, save the current index with its signature to Registry/attest/<id>.
  keepAttestations(next, registry = "default") {
    this.refreshCatalog(); // memory is exactly what's on disk (another process may have updated the catalog)
    const cur = this.cats.get(registry)?.catalog;
    const files = this.srcFiles(registry);
    if (!cur) return;
    let bytes = null;
    let sig = null;
    for (const [id, e] of Object.entries(this.lock().plugins)) {
      if (e.tier === "own" || this.registryOf(e) !== registry) continue;
      const ce = cur.plugins.get(id);
      if (!ce || ce.tier !== "official" || ce.sha256 !== e.sha256) continue;
      if (next.plugins.get(id)?.sha256 === e.sha256) continue; // the new catalog signs it itself
      if (this.attestedOfficial(id, e)) continue;
      try {
        if (!bytes) {
          bytes = readFileSync(files.index);
          sig = readFileSync(files.sig);
          this.verifyIndex(bytes, sig.toString("utf8"), registry); // on disk — exactly the verified catalog
        }
        const f = this.attestFiles(id, registry);
        mkdirSync(files.attest, { recursive: true, mode: 0o700 });
        atomicWrite(f.index, bytes);
        atomicWrite(f.sig, sig);
        this.log({ type: "registry-attest-kept", plugin: id, version: e.version });
      } catch (err) {
        this.log({ type: "warning", plugin: id, detail: msg("warn.officialProof", { why: err.code || err.message }) });
        if (!sig) return;
      }
    }
  }

  // File hashes of the saved archive Registry/archives/<id>.tar.gz, if its sha256 is sum. → { rel: sha256 } | null
  archiveFiles(id, sum) {
    const path = join(this.dirs.archives, `${id}.tar.gz`);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const key = `${id}|${sum}|${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    if (this.archiveCache.has(key)) return this.archiveCache.get(key);
    let out = null;
    try {
      const bytes = readFileSync(path);
      if (sha256(bytes) === sum) {
        out = {};
        for (const f of readTarGz(bytes, { root: id })) out[f.path.slice(id.length + 1)] = sha256(f.data);
      }
    } catch {
      out = null;
    }
    for (const k of this.archiveCache.keys()) if (k.startsWith(`${id}|`)) this.archiveCache.delete(k);
    this.archiveCache.set(key, out);
    return out;
  }

  // Does the installed plugin match lock? → { ok, entry } | { ok: false, reason }
  checkInstalled(pl) {
    const e = this.lockEntry(pl.id);
    if (!e) return { ok: false, reason: "not-in-lock" };
    if (e.disabled) return { ok: false, reason: e.disabled.reason || "disabled" };
    if (!this.ownTrusted(pl.id, e) && this.blockReason(pl.id, { version: e.version, sha256: e.sha256, registry: this.registryOf(e) })) return { ok: false, reason: "blocklist" };
    const dir = join(this.paths.plugins, pl.id);
    if (resolve(pl.dir) !== resolve(dir)) return { ok: false, reason: "layout" };
    let files;
    try {
      files = hashTree(dir);
    } catch {
      return { ok: false, reason: "tampered" };
    }
    if (!sameFiles(files, e.files)) return { ok: false, reason: "tampered" };
    const grew = permissionGrowth(e.granted, permissionsFromMeta(pl.meta));
    if (grew.length) return { ok: false, reason: "consent-required" };
    return { ok: true, entry: e };
  }

  // Whatever is in Plugins/ bypassing the manager (not in lock, files changed, not a folder) is moved to
  // Registry/quarantine/: no unaccounted code stays on disk (services start before plugins, and the policy
  // wouldn't let it run anyway).
  reconcile() {
    const moved = [];
    if (!existsSync(this.paths.plugins)) return moved;
    const { plugins } = scanDir(this.paths.plugins, "installed");
    const seen = new Set();
    for (const pl of plugins) {
      seen.add(pl.dir === this.paths.plugins ? pl.file : pl.dir);
      const v = this.checkInstalled(pl);
      if (v.ok || v.reason === "blocklist" || v.reason === "disabled") continue;
      const victim = pl.dir === this.paths.plugins ? pl.file : pl.dir;
      const dest = join(this.dirs.quarantine, `${pl.id}-${Date.now()}-${randomBytes(3).toString("hex")}`);
      try {
        renameSync(victim, dest);
        moved.push(pl.id);
        this.log({ type: "plugin-quarantined", plugin: pl.id, reason: v.reason });
        this.emit({ type: "plugins.quarantined", plugin: pl.id, reason: v.reason });
      } catch (err) {
        this.log({ type: "warning", plugin: pl.id, detail: msg("warn.quarantine", { why: err.code || err.message }) });
      }
    }
    if (moved.length) this.changed();
    return moved;
  }

  // ---------- install preparation ----------
  async prepare(id) {
    if (typeof id !== "string" || !ID_RE.test(id) || RESERVED_IDS.has(id)) throw new RegistryError(400, "registry:id");
    if (!this.catalog) throw new RegistryError(409, "registry:no-catalog", this.catalogError ? { detail: this.catalogError } : {});
    // an installed registry plugin updates only from the registry it came from (G19); a new one — from the first registry listing it
    const entry = this.catalogEntry(id);
    if (!entry) throw new RegistryError(404, "not-found");
    const blocked = this.blockReason(id, { version: entry.version, sha256: entry.sha256, registry: entry.registry });
    if (blocked) throw new RegistryError(409, "registry:blocklist", { reason: blocked });
    if (entry.platforms.length && !entry.platforms.includes(PLATFORM)) throw new RegistryError(409, "registry:platform");
    if (this.builtinIds().has(id)) throw new RegistryError(409, "registry:id-taken", { by: "builtin" });
    const maxBytes = Math.min(this.opts.maxArchiveBytes || 5 * 1024 * 1024, TAR_LIMITS.maxTotalBytes);
    if (entry.size > maxBytes) throw new RegistryError(413, "registry:too-large");
    const bytes = await this.fetchBytes(this.archiveUrl(entry), maxBytes);
    const got = sha256(bytes);
    if (got !== entry.sha256) {
      this.log({ type: "registry-rejected", plugin: id, error: "registry:sha256" });
      throw new RegistryError(422, "registry:sha256");
    }
    let files;
    try {
      files = readTarGz(bytes, { root: id });
    } catch (e) {
      throw new RegistryError(422, "registry:archive", { detail: errText(e).slice(0, 160) });
    }
    // dot files and paths differing only in case wouldn't match lock on disk (case-insensitive APFS)
    const lower = new Set();
    for (const f of files) {
      if (f.path.split("/").some((seg) => seg.startsWith("."))) throw new RegistryError(422, "registry:archive", { detail: msg("err.archive.dotFile", { path: f.path.slice(0, 120) }) });
      const k = f.path.toLowerCase();
      if (lower.has(k)) throw new RegistryError(422, "registry:archive", { detail: msg("err.archive.caseDup", { path: f.path.slice(0, 120) }) });
      lower.add(k);
    }
    const mains = files.filter((f) => {
      const rest = f.path.slice(id.length + 1);
      if (rest.includes("/")) return false;
      const fn = parseFileName(rest);
      return fn && fn.id === id;
    });
    if (mains.length !== 1) throw new RegistryError(422, "registry:archive-main", { found: mains.length });
    const main = mains[0];
    const text = main.data.subarray(0, 64 * 1024).toString("utf8");
    const { meta } = parseMetaText(text);
    const perms = permissionsFromMeta(meta);
    if (meta.version !== entry.version) throw new RegistryError(422, "registry:archive-version");
    // the plugin needs a newer hub: a clear refusal before the permission check (new tags may be unknown to an old core)
    const tooNew = contractTooNew(meta.contract) || entryContractTooNew(entry);
    if (tooNew) {
      this.log({ type: "registry-rejected", plugin: id, error: "registry:hub-too-old", need: tooNew.need, have: tooNew.have });
      throw new RegistryError(409, "registry:hub-too-old", { id, ...tooNew });
    }
    if (permissionsFingerprint(perms) !== permissionsFingerprint(entry.permissions)) throw new RegistryError(422, "registry:archive-permissions");
    // The same linter as in registry CI. Officialness comes from the signed index (entry.official), not from
    // metadata: official plugins may declare actions, third-party ones may not.
    const lint = lintPlugin({ id, meta, source: main.data.toString("utf8"), official: entry.tier === "official", lang: this.langNow() });
    if (lint.errors.length) {
      this.log({ type: "registry-rejected", plugin: id, error: "registry:lint", count: lint.errors.length });
      throw new RegistryError(422, "registry:lint", { errors: lint.errors.slice(0, 20) });
    }
    // what comes from the archive, why — from the index (if present there).
    const whyByKey = new Map(permissionList(entry.permissions).map((p) => [p.key, p.why]));
    const list = permissionList(perms, { pluginId: id }).map((p) => ({ ...p, why: p.why ?? whyByKey.get(p.key) ?? null }));
    const prev = this.lockEntry(id);
    const growth = prev ? permissionGrowth(prev.granted, perms, { pluginId: id }) : permissionList(perms, { pluginId: id });
    const addedKeys = new Set(growth.map((p) => p.key));
    return {
      kind: "registry",
      icon: meta.icon || entry.icon || null,
      id,
      entry,
      archive: bytes,
      files,
      perms,
      list: list.map(({ key, ...p }) => ({ ...p, added: addedKeys.has(key) })),
      growth: growth.map(({ key, ...p }) => p),
      // translations of "why" from the archive itself (lang variants of tags, title-xx of actions); fallback — from the index
      i18n: mergeI18n(entry.i18n, permI18nFromMeta(meta)),
      update: Boolean(prev),
      fromVersion: prev?.version || null,
      // A new install always shows the permissions window; an update only when permissions grow. Switching from an own plugin (same
      // id from an own folder) to a registry plugin always shows the window, marked as a switch.
      needsConsent: !prev || growth.length > 0 || Boolean(prev.disabled) || prev.tier === "own",
      migrate: prev?.tier === "own" ? { from: "own", version: prev.version, path: prev.own?.path || null } : null,
    };
  }

  builtinIds() {
    const out = new Set();
    try {
      for (const pl of scanDir(this.config.builtinPluginsDir, "builtin").plugins) out.add(pl.id);
    } catch {}
    return out;
  }

  // POST /registry/install: without a token — 428 with the permissions window (or an immediate update install if permissions don't grow).
  async install(id, opts = {}) {
    if (this.estop()) throw new RegistryError(423, "estop");
    let info = null;
    try {
      if (typeof id === "string" && ID_RE.test(id)) info = this.busyInfo(id);
    } catch {}
    if (info) this.setBusy(id, info);
    try {
      return await this.installNow(id, opts);
    } finally {
      if (info) this.setBusy(id, null);
    }
  }

  // source: "registry" — install from the registry catalog even if an own plugin with this id is installed now (switch, consent
  // window always). Without it an installed own plugin is updated from its own folder.
  // preview: true — window only (diagnostic snapshot of the shell, peer.diagnostic): nothing is ever installed —
  // 428 with the window even if permissions don't grow; nothing to consent to — 409 consent:nothing. Pending windows for the same id
  // (shown to the human) are not reset.
  async installNow(id, { consentToken = null, peer = null, source = null, preview = false } = {}) {
    let prep;
    if (consentToken && preview) throw new RegistryError(403, "peer:diagnostic");
    if (consentToken) {
      const p = this.pending.get(consentToken);
      this.pending.delete(consentToken);
      if (!p || p.preview || p.id !== id || p.expires < Date.now() || p.pid !== (peer?.pid ?? null)) throw new RegistryError(403, "consent:invalid");
      prep = p.prep;
      if (prep.kind === "own") return this.commitOwnConsented(p, peer);
      // a new catalog may have arrived while the window was open
      // (same archive, but a different tier — the linter in prepare judged by the old tier)
      this.refreshCatalog();
      const cur = this.catalogEntry(id);
      if (!cur || cur.sha256 !== prep.entry.sha256 || cur.tier !== prep.entry.tier || cur.registry !== prep.entry.registry) throw new RegistryError(409, "registry:catalog-changed");
      if (this.blockReason(id, { version: cur.version, sha256: cur.sha256, registry: cur.registry })) throw new RegistryError(409, "registry:blocklist");
    } else {
      const inst = this.lockEntry(id);
      if (inst?.tier === "own" && source !== "registry") {
        // an own plugin comes from its own folder: without permission growth it's installed right away (like a registry update), otherwise the window
        prep = this.prepareOwn(inst.own?.path, { expectId: id });
      } else prep = await this.prepare(id);
      if (preview) {
        if (!prep.needsConsent) throw new RegistryError(409, "consent:nothing");
        this.askConsent(prep, peer, { preview: true });
      }
      if (prep.needsConsent) this.askConsent(prep, peer);
    }
    if (prep.kind === "own") return this.commitOwn(prep, peer);
    return this.commit(prep, peer);
  }

  // Consent window: a one-time token for 120 s bound to the id, the prepared bytes and the app pid → 428.
  // extra — goes into the token record (requestId of the request), body — extra window fields.
  askConsent(prep, peer, extra = {}, body = {}) {
    const id = prep.id;
    const token = randomBytes(18).toString("base64url");
    // a new window for the same id cancels the previous one; a snapshot (preview) window doesn't: it installs nothing
    for (const [t, p] of this.pending) if (p.expires < Date.now() || (p.id === id && !extra.preview)) this.pending.delete(t);
    if (this.pending.size > 20) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(token, { id, pid: peer?.pid ?? null, expires: Date.now() + CONSENT_TTL_MS, prep, ...extra });
    this.log({ type: "plugin-consent-requested", plugin: id, version: prep.entry.version, added: prep.growth.length, pid: peer?.pid, ...(prep.kind === "own" ? { source: "own" } : {}), ...(prep.migrate ? { migrate: prep.migrate.from } : {}) });
    const lang = this.langNow();
    throw new RegistryError(428, "consent-required", {
      needsConsent: true,
      token,
      expiresInMs: CONSENT_TTL_MS,
      id,
      title: pickLang(prep.entry.title, prep.entry.i18n, "title", lang),
      tier: prep.entry.tier,
      ...(prep.kind === "own" ? {} : { registry: prep.entry.registry || null, registryLabel: registryLabel(prep.entry.registry, this.sources()), tierLabel: tierLabel(prep.entry.tier, prep.entry.registry, this.sources()) }),
      version: prep.entry.version,
      fromVersion: prep.fromVersion,
      update: prep.update,
      sha256: prep.entry.sha256,
      permissions: localizePerms(prep.list, prep.i18n, lang),
      added: localizePerms(prep.growth, prep.i18n, lang),
      // own source: folder path (realpath and, for display, with "~"), content fingerprint, who can write to the folder
      source: prep.kind === "own" ? ownSourceView(prep.source) : { kind: "registry" },
      // switch: the same id is already installed from the registry (official/community) or from another own folder — or vice versa
      migrate: prep.migrate ? { ...prep.migrate, ...(prep.migrate.path ? { pathShort: shortPath(prep.migrate.path) } : {}) } : null,
      // plugin icon (<agenthub.icon>): the consent window tile is drawn from the declaration, not by id
      icon: prep.icon || null,
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      ...body,
    });
  }

  // ---------- own sources ----------

  // Folder check (lib/registry/own-source.mjs) with path errors as RegistryError.
  inspectOwn(path) {
    try {
      return inspectSource(path, { uid: this.uid, lang: this.langNow() });
    } catch (e) {
      if (e instanceof OwnSourceError) throw new RegistryError(e.status, e.code, e.extra);
      throw e;
    }
  }

  // Preparing an install from an own folder — like the registry's prepare, but bytes are read from the folder (in memory: exactly
  // what the human saw in the consent window gets installed), tier own, sha256 — content fingerprint. src — an already
  // checked folder (watching), otherwise it's checked again.
  prepareOwn(path, { expectId = null, src = null } = {}) {
    if (!path) throw new RegistryError(409, "own:no-source");
    src ||= this.inspectOwn(path);
    // contract before the linter: the linter treats contract tags newer than this core as errors, while the human needs
    // "needs a newer hub", not a list of cryptic errors (same as the registry, prepare)
    const tooNew = contractTooNew(src.meta?.contract);
    if (tooNew) throw new RegistryError(409, "own:hub-too-old", { id: src.id, path: src.dir, ...tooNew });
    if (src.errors.length || !src.meta) throw new RegistryError(422, "own:lint", { id: src.id, path: src.dir, errors: src.errors.slice(0, 20) });
    if (expectId && src.id !== expectId) throw new RegistryError(409, "own:id-changed", { id: src.id, expected: expectId });
    if (this.builtinIds().has(src.id)) throw new RegistryError(409, "registry:id-taken", { by: "builtin" });
    const meta = src.meta;
    if (meta.platforms.length && !meta.platforms.includes(PLATFORM)) throw new RegistryError(409, "registry:platform");
    const id = src.id;
    const perms = src.perms;
    const prev = this.lockEntry(id);
    // an own entry the manager didn't make (ownTrusted) doesn't count as consent: permissions as for a new install
    const unverified = Boolean(prev && prev.tier === "own" && !this.ownTrusted(id, prev));
    const base = prev && !unverified ? prev.granted : null;
    const growth = base ? permissionGrowth(base, perms, { pluginId: id }) : permissionList(perms, { pluginId: id });
    const addedKeys = new Set(growth.map((p) => p.key));
    const titles = {};
    for (const [lang, v] of Object.entries(meta.i18n || {})) if (v?.title) titles[lang] = { title: v.title };
    const i18n = mergeI18n(cleanI18n(titles), permI18nFromMeta(meta));
    const migrate = this.ownMigrate(id, prev, src.dir);
    // quietly (no window) — only the same permission set (including loud push rules) and no version rollback
    const samePerms = Boolean(base) && permissionsFingerprint(base) === permissionsFingerprint(perms);
    const downgrade = Boolean(prev?.version && meta.version && compareVersions(meta.version, prev.version) < 0);
    return {
      kind: "own",
      icon: meta.icon || null,
      id,
      entry: { id, version: meta.version, title: meta.title || id, i18n, tier: "own", sha256: src.fingerprint, archive: null },
      archive: null,
      files: src.files.map((f) => ({ path: `${id}/${f.rel}`, data: f.data, mode: 0o644 })),
      perms,
      list: permissionList(perms, { pluginId: id }).map(({ key, ...p }) => ({ ...p, added: addedKeys.has(key) })),
      growth: growth.map(({ key, ...p }) => p),
      i18n,
      update: Boolean(prev),
      fromVersion: prev?.version || null,
      source: { path: src.dir, fingerprint: src.fingerprint, writable: src.writable, warnings: src.warnings.slice(0, 10) },
      migrate,
      unverified,
      downgrade,
      samePerms,
      needsConsent: !prev || unverified || growth.length > 0 || Boolean(prev.disabled) || Boolean(migrate),
    };
  }

  // Switch marker for own plugin id from folder dir: the same id is installed from the registry (official/community) or from
  // another own folder; not installed but present in the registry catalog — "catalog" (the own plugin gets everything bound to
  // the id: agent-hub.<id> secrets in the keychain, PluginData/<id>, notification rules "<id>:<key>"). Window — always.
  ownMigrate(id, prev, dir) {
    if (prev && prev.tier !== "own") return { from: this.officialNow(id, prev) ? "official" : "community", version: prev.version };
    if (prev && prev.own?.path !== dir) return { from: "own", version: prev.version, path: prev.own?.path || null };
    if (prev) return null;
    this.refreshCatalog();
    const ce = this.catalog?.plugins.get(id);
    if (!ce) return null;
    const lang = this.langNow();
    return { from: "catalog", tier: ce.tier, version: ce.version, title: pickLang(ce.title, ce.i18n, "title", lang) || id };
  }

  commitOwn(prep, peer, opts = {}) {
    const r = this.commit(prep, peer, opts);
    return { ...r, source: "own", path: prep.source.path };
  }

  // Install via the consent window token: the request (if any) is removed.
  commitOwnConsented(p, peer) {
    const r = this.commitOwn(p.prep, peer);
    if (p.requestId) this.dropRequest(p.requestId, "installed");
    return r;
  }

  pruneRequests() {
    const now = Date.now();
    let changed = false;
    for (const [k, r] of this.ownRequests) {
      if (Date.parse(r.expiresAt) < now) {
        this.ownRequests.delete(k);
        changed = true;
      }
    }
    if (changed) this.saveRequests();
  }

  // Requests survive a daemon restart (the CLI promises "valid for a day"): Registry/own-requests.json, 0600, without
  // bytes — only what's visible in the list; on approval the folder is checked again anyway.
  requestsPath() {
    return join(this.dirs.registry, "own-requests.json");
  }
  loadRequests() {
    const j = readJsonOr(this.requestsPath(), null);
    this.ownRequests = new Map();
    const now = Date.now();
    for (const r of Array.isArray(j?.requests) ? j.requests.slice(-OWN_REQUESTS_MAX) : []) {
      if (!r || typeof r.requestId !== "string" || !/^[\w-]{8,64}$/.test(r.requestId)) continue;
      if (typeof r.id !== "string" || !ID_RE.test(r.id) || !isAbsolutePath(r.path)) continue;
      if (!(Date.parse(r.expiresAt) > now)) continue;
      const titles = r.titles && typeof r.titles === "object" && !Array.isArray(r.titles) ? Object.fromEntries(Object.entries(r.titles).filter(([k, v]) => isStr(k, 8) && isStr(v, 200))) : {};
      this.ownRequests.set(r.requestId, {
        requestId: r.requestId,
        id: r.id,
        titles: Object.keys(titles).length ? titles : { "": r.id },
        version: isStr(r.version, 64) ? r.version : null,
        path: r.path,
        fingerprint: typeof r.fingerprint === "string" && /^[0-9a-f]{64}$/.test(r.fingerprint) ? r.fingerprint : null,
        permissions: Number.isInteger(r.permissions) ? r.permissions : 0,
        update: r.update === true,
        migrate: r.migrate && typeof r.migrate === "object" && isStr(r.migrate.from, 16) ? r.migrate : null,
        icon: entryIcon(r.icon),
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        by: isStr(r.by, 16) ? r.by : null,
        ...(r.reason === "unexpected" ? { reason: "unexpected" } : {}),
        ...(r.risk === "group-writable" ? { risk: r.risk } : {}),
      });
    }
  }
  saveRequests() {
    try {
      atomicWrite(this.requestsPath(), JSON.stringify({ version: 1, requests: [...this.ownRequests.values()] }, null, 2) + "\n");
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.own.requestsNotSaved", { why: e.code || e.message }) });
    }
  }

  dropRequest(requestId, done) {
    const r = this.ownRequests.get(requestId);
    if (!r) return false;
    this.ownRequests.delete(requestId);
    this.saveRequests();
    this.emit({ type: "plugins.own-request", requestId, plugin: r.id, done });
    return true;
  }

  // POST /registry/own/request (`agenthub plugins install --from <folder>`, the "Add from folder…" button): a request.
  // Any local process can create it; only a human in the pinned app can install it (approveOwn).
  // The folder is checked right away (same linter as the registry): with errors there's no request. → { ok, pending, requestId, … }
  // | { ok, already } (the same folder with the same content is already installed).
  // A request for the same id from another folder doesn't displace a pending one: 409 own:request-conflict (the human
  // would approve a folder other than the one requested from the terminal) — decline the previous one first. reason: "unexpected" —
  // the manager created the request itself (own entry in lock not confirmed, noteUnexpectedOwn).
  requestOwn(path, { peer = null, reason = null } = {}) {
    if (!this.pinned()) throw new RegistryError(409, "own:no-app");
    const src = this.inspectOwn(path);
    // contract before the linter (see prepareOwn)
    const tooNew = contractTooNew(src.meta?.contract);
    if (tooNew) {
      this.log({ type: "plugin-own-rejected", plugin: src.id, error: "own:hub-too-old", need: tooNew.need, have: tooNew.have });
      throw new RegistryError(409, "own:hub-too-old", { id: src.id, path: src.dir, ...tooNew });
    }
    if (src.errors.length || !src.meta) {
      this.log({ type: "plugin-own-rejected", plugin: src.id, error: "own:lint", count: src.errors.length });
      throw new RegistryError(422, "own:lint", { id: src.id, path: src.dir, errors: src.errors.slice(0, 20) });
    }
    if (this.builtinIds().has(src.id)) throw new RegistryError(409, "registry:id-taken", { by: "builtin" });
    if (src.meta.platforms.length && !src.meta.platforms.includes(PLATFORM)) throw new RegistryError(409, "registry:platform");
    const inst = this.lockEntry(src.id);
    if (inst?.tier === "own" && inst.own?.path === src.dir && inst.sha256 === src.fingerprint && !inst.disabled && this.ownTrusted(src.id, inst)) {
      return { ok: true, already: true, id: src.id, version: src.version, path: src.dir };
    }
    this.pruneRequests();
    const other = [...this.ownRequests.values()].find((r) => r.id === src.id && r.path !== src.dir);
    if (other) {
      if (reason === "unexpected") return { ok: true, pending: true, ...this.requestView(other) };
      this.log({ type: "plugin-own-rejected", plugin: src.id, error: "own:request-conflict", pid: peer?.pid });
      throw new RegistryError(409, "own:request-conflict", { id: src.id, path: src.dir, pending: { requestId: other.requestId, path: other.path, pathShort: shortPath(other.path) } });
    }
    for (const [rid, r] of this.ownRequests) if (r.path === src.dir || r.id === src.id) this.ownRequests.delete(rid);
    if (this.ownRequests.size >= OWN_REQUESTS_MAX) throw new RegistryError(429, "own:too-many-requests", { max: OWN_REQUESTS_MAX });
    const migrate = this.ownMigrate(src.id, inst, src.dir);
    const titles = { "": src.meta.title || src.id };
    for (const [lang, v] of Object.entries(src.meta.i18n || {})) if (v?.title) titles[lang] = v.title;
    const now = Date.now();
    const rq = {
      requestId: randomBytes(12).toString("base64url"),
      id: src.id,
      titles,
      version: src.version,
      path: src.dir,
      fingerprint: src.fingerprint,
      permissions: permissionList(src.perms).length,
      update: Boolean(inst),
      migrate,
      icon: src.meta.icon || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + OWN_REQUEST_TTL_MS).toISOString(),
      by: peer?.class || null,
      ...(reason === "unexpected" ? { reason } : {}),
      ...(ownRisk(src.writable) ? { risk: ownRisk(src.writable) } : {}),
    };
    this.ownRequests.set(rq.requestId, rq);
    this.saveRequests();
    this.log({ type: "plugin-own-requested", plugin: src.id, version: src.version, by: rq.by, pid: peer?.pid, ...(migrate ? { migrate: migrate.from } : {}), ...(reason ? { reason } : {}), ...(rq.risk ? { risk: rq.risk } : {}) });
    this.emit({ type: "plugins.own-request", requestId: rq.requestId, plugin: src.id, version: src.version });
    return { ok: true, pending: true, ...this.requestView(rq) };
  }

  requestView(r, lang = this.langNow()) {
    return {
      requestId: r.requestId,
      id: r.id,
      title: (r.titles[contentLang(Object.fromEntries(Object.entries(r.titles).filter(([k]) => k).map(([k, v]) => [k, { title: v }])), lang, { field: "title" })] ?? null) || r.titles[""] || r.id,
      version: r.version,
      path: r.path,
      pathShort: shortPath(r.path),
      fingerprint: r.fingerprint,
      permissions: r.permissions,
      update: r.update,
      migrate: r.migrate ? { ...r.migrate, ...(r.migrate.path ? { pathShort: shortPath(r.migrate.path) } : {}), ...(r.migrate.from === "catalog" ? { title: this.catalogTitle(r.id, lang) || r.migrate.title } : {}) } : null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      by: r.by,
      reason: r.reason || null,
      icon: r.icon || null,
      // the folder is writable by the group (allowed with a warning): the CLI prints the loud line, the window shows it again
      risk: r.risk || null,
    };
  }

  // Catalog plugin title in language lang (the "catalog" marker in a request is in the display language, not the request's).
  catalogTitle(id, lang = this.langNow()) {
    const ce = this.catalog?.plugins.get(id);
    return ce ? pickLang(ce.title, ce.i18n, "title", lang) || null : null;
  }

  ownRequestList() {
    this.pruneRequests();
    return [...this.ownRequests.values()].map((r) => this.requestView(r));
  }

  // POST /registry/own/decline — the human declined the request.
  declineOwn(requestId, { peer = null } = {}) {
    const r = this.ownRequests.get(requestId);
    if (!r) throw new RegistryError(404, "own:no-request");
    this.dropRequest(requestId, "declined");
    this.log({ type: "plugin-own-declined", plugin: r.id, version: r.version, pid: peer?.pid });
    return { ok: true, id: r.id };
  }

  // POST /registry/own/approve: without a token — the folder is checked again and always 428 with the consent window (path,
  // id, version, fingerprint, permissions; a marker if the content changed after the request); with a token — install exactly
  // the bytes that were in the window.
  // A request is bound to its folder: if the request folder was replaced (by a symlink or another folder) — refusal own:path-changed, a new
  // request. preview — a window for a diagnostic snapshot: installs nothing and doesn't reset other windows.
  approveOwn(requestId, { consentToken = null, peer = null, preview = false } = {}) {
    if (this.estop()) throw new RegistryError(423, "estop");
    this.pruneRequests();
    const rq = this.ownRequests.get(requestId);
    if (!rq) throw new RegistryError(404, "own:no-request");
    if (consentToken && preview) throw new RegistryError(403, "peer:diagnostic");
    if (consentToken) {
      const p = this.pending.get(consentToken);
      this.pending.delete(consentToken);
      if (!p || p.preview || p.requestId !== requestId || p.id !== rq.id || p.expires < Date.now() || p.pid !== (peer?.pid ?? null)) throw new RegistryError(403, "consent:invalid");
      if (p.prep.source?.path !== rq.path) throw new RegistryError(409, "own:path-changed", { path: rq.path, now: p.prep.source?.path || null });
      return this.commitOwnConsented(p, peer);
    }
    const src = this.inspectOwn(rq.path);
    if (src.dir !== rq.path) {
      this.log({ type: "plugin-own-rejected", plugin: rq.id, error: "own:path-changed", pid: peer?.pid });
      throw new RegistryError(409, "own:path-changed", { path: rq.path, now: src.dir });
    }
    const prep = this.prepareOwn(rq.path, { expectId: rq.id, src });
    this.askConsent(prep, peer, { requestId, ...(preview ? { preview: true } : {}) }, { changedSinceRequest: prep.source.fingerprint !== rq.fingerprint });
  }

  // ---------- watching own folders ----------

  startOwn(opts = {}) {
    this.ownOpts = { ...OWN_DEFAULTS, ...opts };
    this.ownStarted = true;
    clearInterval(this.ownTimer);
    this.ownTimer = setInterval(() => this.checkOwnAll("timer"), Math.max(this.ownOpts.checkMs, 100));
    this.ownTimer.unref?.();
    this.checkOwnAll("start");
  }

  stopOwn() {
    this.ownStarted = false;
    clearInterval(this.ownTimer);
    this.ownTimer = null;
    for (const t of this.ownDebounce.values()) clearTimeout(t);
    this.ownDebounce.clear();
    for (const w of this.ownWatchers.values()) {
      try {
        w.watcher?.close();
      } catch {}
    }
    this.ownWatchers.clear();
  }

  // Watchers — one per own plugin folder from lock; no folder — no watcher (timer reconciliation
  // picks it up when it appears and sets one again).
  syncOwnWatch() {
    if (!this.ownStarted) return;
    const want = new Map(Object.values(this.lock().plugins).filter((e) => e.tier === "own" && e.own?.path).map((e) => [e.id, e.own.path]));
    for (const [id, w] of this.ownWatchers) {
      if (want.get(id) === w.path && w.watcher) continue;
      try {
        w.watcher?.close();
      } catch {}
      this.ownWatchers.delete(id);
    }
    for (const [id, path] of want) {
      if (this.ownWatchers.has(id)) continue;
      let watcher = null;
      try {
        if (statSync(path).isDirectory()) {
          watcher = fsWatch(path, { recursive: true, persistent: false }, () => this.scheduleOwn(id));
          watcher.on("error", () => {
            try {
              watcher.close();
            } catch {}
            const w = this.ownWatchers.get(id);
            if (w?.watcher === watcher) w.watcher = null;
          });
        }
      } catch {
        watcher = null;
      }
      this.ownWatchers.set(id, { path, watcher });
    }
  }

  scheduleOwn(id) {
    clearTimeout(this.ownDebounce.get(id));
    const t = setTimeout(() => {
      this.ownDebounce.delete(id);
      if (this.ownStarted) this.checkOwn(id, "watch");
    }, this.ownOpts.debounceMs);
    t.unref?.();
    this.ownDebounce.set(id, t);
  }

  checkOwnAll(reason = "check") {
    for (const id of [...this.ownState.keys()]) if (this.lockEntry(id)?.tier !== "own") this.ownState.delete(id);
    // a watcher that didn't exist (no folder) or died — set it up again
    for (const [id, w] of this.ownWatchers) if (!w.watcher) this.ownWatchers.delete(id);
    this.syncOwnWatch();
    const out = {};
    for (const e of Object.values(this.lock().plugins)) if (e.tier === "own") out[e.id] = this.checkOwn(e.id, reason);
    return out;
  }

  // Reconciling an own plugin folder with the installed copy. Same content — ok; different, permission set exactly the same (including
  // loud push rules), version not older and the check passes — the new copy installs itself (while the hub is paused it waits
  // for the pause to lift); permissions grew — "update" (consent window via the "Update" button); permissions narrowed or the version is older than
  // the installed one (git checkout of an old branch) — also "update", but without a window: installed with one "Update" click;
  // lock entry not confirmed by the manager — "unverified" (only via the request window); no folder — "missing", the folder
  // fails the check, is replaced by a symlink or holds a different plugin — "broken". In the last cases the plugin runs on the
  // last copy.
  checkOwn(id, reason = "check") {
    const e = this.lockEntry(id);
    if (!e || e.tier !== "own") {
      this.ownState.delete(id);
      return null;
    }
    const prev = this.ownState.get(id) || null;
    let st;
    try {
      const src = inspectSource(e.own?.path || "", { uid: this.uid, lang: this.langNow() });
      if (src.dir !== e.own.path) st = { status: "broken", error: "own:moved" };
      else if (src.id !== id) st = { status: "broken", error: "own:id-changed" };
      else if (contractTooNew(src.meta?.contract)) st = { status: "broken", error: "own:hub-too-old", ...contractTooNew(src.meta.contract), version: src.version, fingerprint: src.fingerprint };
      else if (src.errors.length) st = { status: "broken", error: "own:lint", errors: src.errors.slice(0, 20), version: src.version, fingerprint: src.fingerprint };
      else if (!this.ownTrusted(id, e)) st = { status: "unverified", version: src.version, fingerprint: src.fingerprint };
      else if (src.fingerprint === e.sha256) st = { status: "ok", version: src.version, fingerprint: src.fingerprint };
      else {
        const prep = this.prepareOwn(e.own.path, { expectId: id, src });
        if (prep.needsConsent || !prep.samePerms || prep.downgrade) {
          st = { status: "update", version: src.version, fingerprint: src.fingerprint, growth: prep.growth, i18n: prep.i18n, ...(prep.downgrade ? { downgrade: true } : {}) };
        } else if (this.estop()) st = { status: "paused", version: src.version, fingerprint: src.fingerprint };
        else {
          this.commitOwn(prep, null, { auto: true });
          st = { status: "ok", version: src.version, fingerprint: src.fingerprint, updatedAt: new Date().toISOString() };
        }
      }
    } catch (err) {
      const code = err?.code || "own:error";
      st = code === "own:not-found" ? { status: "missing" } : { status: "broken", error: code, ...(err?.extra?.errors ? { errors: err.extra.errors } : {}), ...(Number.isInteger(err?.extra?.need) ? { need: err.extra.need, have: err.extra.have } : {}) };
    }
    st.checkedAt = new Date().toISOString();
    this.ownState.set(id, st);
    const sig = (x) => (x ? JSON.stringify([x.status, x.error || null, x.fingerprint || null]) : null);
    if (sig(prev) !== sig(st)) {
      if (st.status !== "ok" || (prev && prev.status !== "ok")) this.log({ type: "plugin-own-source", plugin: id, status: st.status, error: st.error || null, reason });
      this.emit({ type: "plugins.own", plugin: id, status: st.status });
      if (st.status === "missing" || st.status === "broken") {
        // remove the watcher of a vanished folder: if it reappears, timer reconciliation sets a new one
        const w = this.ownWatchers.get(id);
        if (w?.watcher) {
          try {
            w.watcher.close();
          } catch {}
          w.watcher = null;
        }
      }
      this.noteUpdates();
    }
    return st;
  }

  // For /state (fact plugins.own): requests awaiting approval and own plugins with a folder problem.
  ownInfo() {
    const lang = this.langNow();
    const problems = [];
    for (const e of Object.values(this.lock().plugins)) {
      if (e.tier !== "own") continue;
      const st = this.ownState.get(e.id);
      if (st && st.status !== "ok") problems.push({ id: e.id, title: pickLang(e.title, e.i18n, "title", lang) || e.id, status: st.status, error: st.error || null });
    }
    return { requests: this.ownRequestList(), problems };
  }

  commit(prep, peer, { auto = false } = {}) {
    // The hub pause may have been turned on while the human was reading permissions (consent window, typing the id in the terminal).
    if (this.estop()) throw new RegistryError(423, "estop");
    const own = prep.kind === "own";
    const { id, entry, files, perms, archive } = prep;
    const stage = join(this.dirs.staging, `${id}-${randomBytes(4).toString("hex")}`);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const hashes = {};
    try {
      for (const f of files) {
        const rel = f.path.slice(id.length + 1);
        const dest = join(stage, ...rel.split("/"));
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        const mode = f.mode & 0o111 ? 0o700 : 0o600;
        writeFileSync(dest, f.data, { mode });
        chmodSync(dest, mode);
        hashes[rel] = sha256(f.data);
      }
    } catch (e) {
      rmSync(stage, { recursive: true, force: true });
      throw new RegistryError(500, "registry:write", { detail: e.code || "write" });
    }
    const lock = this.lock();
    const before = lock.plugins[id] ? structuredClone(lock.plugins[id]) : null;
    const now = new Date().toISOString();
    lock.plugins[id] = {
      id,
      version: entry.version,
      sha256: entry.sha256,
      archive: entry.archive,
      tier: entry.tier,
      official: entry.tier === "official",
      // the registry it came from (G19): updates and officialness follow this registry only
      ...(!own && entry.registry ? { registry: entry.registry } : {}),
      installedAt: before?.installedAt || now,
      updatedAt: now,
      granted: perms,
      files: hashes,
      disabled: null,
      // own source: real folder path, title and translations (it has no registry catalog)
      ...(own ? { own: { path: prep.source.path }, title: entry.title, i18n: entry.i18n || {} } : {}),
    };
    // Lock first (and the consent for an own plugin — the fingerprint of exactly this entry), then files: the core policy checks new
    // files against the new lock.
    const approvalBefore = this.ownApproved.get(id) ?? null;
    this.saveLock(lock);
    this.writeApprovals({ [id]: own ? this.approvalDigest(id, lock.plugins[id]) : null });
    this.ownUnexpected.delete(id);
    const live = join(this.paths.plugins, id);
    const old = join(this.dirs.trash, `${id}-${randomBytes(4).toString("hex")}`);
    let movedOld = false;
    try {
      mkdirSync(this.paths.plugins, { recursive: true, mode: 0o700 });
      rmSync(join(this.dirs.disabled, id), { recursive: true, force: true });
      if (existsSync(live)) {
        renameSync(live, old);
        movedOld = true;
      }
      renameSync(stage, live);
      chmodSync(live, 0o700);
    } catch (e) {
      try {
        if (movedOld && !existsSync(live)) renameSync(old, live);
      } catch {}
      const l2 = this.lock();
      if (before) l2.plugins[id] = before;
      else delete l2.plugins[id];
      this.saveLock(l2);
      this.writeApprovals({ [id]: approvalBefore });
      rmSync(stage, { recursive: true, force: true });
      throw new RegistryError(500, "registry:install", { detail: e.code || "rename" });
    }
    rmSync(old, { recursive: true, force: true });
    this.clearLowered(id);
    // the previous version's attestation is no longer needed: the current catalog signs the new one
    this.dropAttest(id, before);
    // Archive of this version — for the officialness check (officialNow). If it fails to write, the plugin runs as community.
    // An own plugin has no archive: the previous registry archive (switch) is deleted — the copy won't become official.
    try {
      if (archive) atomicWrite(join(this.dirs.archives, `${id}.tar.gz`), archive);
      else rmSync(join(this.dirs.archives, `${id}.tar.gz`), { force: true });
    } catch (e) {
      this.log({ type: "warning", plugin: id, detail: msg("warn.archiveNotSaved", { why: e.code || e.message }) });
    }
    if (auto) {
      // automatic update of the own copy: same permissions, the human already consented to them; which files changed goes to the
      // log, the event becomes a "Plugin updated" notification (push service)
      const prevFiles = before?.files || {};
      const changedFiles = [...new Set([...Object.keys(prevFiles), ...Object.keys(hashes)])].filter((f) => prevFiles[f] !== hashes[f]).sort().slice(0, 20);
      this.log({ type: "plugin-own-updated", plugin: id, from: before?.version || null, version: entry.version, sha256: entry.sha256, files: changedFiles });
      this.emit({ type: "plugins.own-updated", plugin: id, version: entry.version, from: before?.version || null, files: changedFiles });
    } else {
      this.log({ type: "plugin-installed", plugin: id, version: entry.version, sha256: entry.sha256, update: Boolean(before), pid: peer?.pid, ...(own ? { source: "own" } : {}), ...(prep.migrate ? { migrate: prep.migrate.from } : {}) });
      this.emit({ type: "plugins.installed", plugin: id, version: entry.version, update: Boolean(before), ...(own ? { source: "own" } : {}) });
    }
    // the source folder is writable by the group (allowed with a warning, decision 2026-11-11): a separate journal line on every
    // install from such a folder, including automatic updates
    const risk = own ? ownRisk(prep.source?.writable) : null;
    if (risk) this.log({ type: "plugin-own-risk", plugin: id, version: entry.version, risk, path: prep.source.path, files: prep.source.writable.group.slice(0, 10), auto: Boolean(auto) });
    if (own) this.ownState.set(id, { status: "ok", checkedAt: now, version: entry.version, fingerprint: entry.sha256 });
    else this.ownState.delete(id);
    this.syncOwnWatch();
    this.changed();
    this.noteUpdates();
    return { ok: true, id, version: entry.version, update: Boolean(before), fromVersion: before?.version || null };
  }

  // POST /registry/remove: plugin files, lock entry, cache; PluginData only with purge.
  remove(id, { purge = false, peer = null } = {}) {
    if (typeof id !== "string" || !ID_RE.test(id) || RESERVED_IDS.has(id)) throw new RegistryError(400, "registry:id");
    const lock = this.lock();
    const live = join(this.paths.plugins, id);
    const off = join(this.dirs.disabled, id);
    if (!lock.plugins[id] && !existsSync(live) && !existsSync(off)) throw new RegistryError(404, "not-found");
    if (existsSync(live)) {
      const t = join(this.dirs.trash, `${id}-${randomBytes(4).toString("hex")}`);
      renameSync(live, t);
      rmSync(t, { recursive: true, force: true });
    }
    rmSync(off, { recursive: true, force: true });
    rmSync(join(this.dirs.archives, `${id}.tar.gz`), { force: true });
    this.dropAttest(id, lock.plugins[id]);
    rmSync(join(this.paths.pluginCache, id), { recursive: true, force: true });
    if (purge) rmSync(join(this.paths.pluginData, id), { recursive: true, force: true });
    const version = lock.plugins[id]?.version || null;
    const wasOwn = lock.plugins[id]?.tier === "own";
    delete lock.plugins[id];
    this.saveLock(lock);
    this.clearLowered(id);
    this.writeApprovals({ [id]: null });
    this.ownState.delete(id);
    this.ownUnexpected.delete(id);
    this.syncOwnWatch();
    this.log({ type: "plugin-removed-by-user", plugin: id, version, purge: Boolean(purge), pid: peer?.pid, ...(wasOwn ? { source: "own" } : {}) });
    this.emit({ type: "plugins.removed", plugin: id, ...(purge ? { purge: true } : {}) });
    this.changed();
    this.noteUpdates();
    return { ok: true, id };
  }

  langNow() {
    try {
      return this.lang() || currentLang();
    } catch {
      return currentLang();
    }
  }

  // ---------- available updates ----------
  // Installed plugins whose version in the verified catalog is newer: { id, title, installed, version, sha256,
  // tier, permissionsGrow, added } — added: permissions of the new version beyond the granted ones (in the hub language). A rollback (older
  // in the catalog) and a rebuilt archive of the same version aren't included: only the manager reports those. A new version blocked
  // by the registry and a foreign platform — also not.
  pluginUpdates() {
    const lock = this.lock();
    const lang = this.langNow();
    const out = [];
    for (const [id, inst] of Object.entries(lock.plugins)) {
      if (inst.tier === "own") {
        // own plugin: the update comes from its own folder, only what awaits consent (permissions grew) goes into the list;
        // without permission growth the copy installs itself (checkOwn)
        const st = this.ownState.get(id);
        if (st?.status !== "update") continue;
        const growth = st.growth || [];
        out.push({
          id,
          title: pickLang(inst.title, inst.i18n, "title", lang) || id,
          installed: inst.version,
          version: st.version,
          sha256: st.fingerprint,
          tier: "own",
          source: "own",
          path: inst.own?.path || null,
          permissionsGrow: growth.length > 0,
          added: localizePerms(growth, st.i18n || inst.i18n, lang),
          downgrade: Boolean(st.downgrade),
          // one notification per new content (the own folder's version may not change)
          notifyKey: `${id}@${st.version}#${String(st.fingerprint || "").slice(0, 12)}`,
        });
        continue;
      }
      const ce = this.catalogEntry(id, inst);
      if (!ce || ce.sha256 === inst.sha256) continue;
      if (compareVersions(ce.version, inst.version) <= 0) continue;
      if (this.blockReason(id, { version: ce.version, sha256: ce.sha256, registry: ce.registry })) continue;
      if (ce.platforms.length && !ce.platforms.includes(PLATFORM)) continue;
      // a version that needs a newer hub is not "update available": this hub wouldn't let it be installed anyway
      // (registry:hub-too-old); the catalog shows it with "Needs a newer hub" (listCatalog → needsHub)
      if (entryContractTooNew(ce)) continue;
      const growth = permissionGrowth(inst.granted, ce.permissions, { pluginId: ce.id }).map(({ key, ...p }) => p);
      out.push({
        id,
        title: pickLang(ce.title, ce.i18n, "title", lang),
        installed: inst.version,
        version: ce.version,
        sha256: ce.sha256,
        tier: ce.tier,
        registry: ce.registry || null,
        registryLabel: registryLabel(ce.registry, this.sources()),
        permissionsGrow: growth.length > 0,
        added: localizePerms(growth, ce.i18n, lang),
      });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  configured() {
    return this.sources().some((r) => r.indexUrl && r.publicKey);
  }

  // ---------- lists for the shell ----------
  listCatalog() {
    const lock = this.lock();
    const builtin = this.builtinIds();
    const plugins = [];
    const srcs = this.sources();
    for (const first of this.catalog?.plugins.values() || []) {
      const inst = lock.plugins[first.id] || null;
      // an own plugin with this id is installed: the catalog doesn't update it (switching to the catalog only explicitly, with a window)
      const own = inst?.tier === "own";
      // an installed registry plugin is shown from the registry it came from (G19); gone from there — the first listing, no update
      const pinned = inst && !own ? this.catalogEntry(first.id, inst) : null;
      const e = pinned || first;
      const elsewhere = Boolean(inst && !own && !pinned);
      const growth = inst && !own ? permissionGrowth(inst.granted, e.permissions, { pluginId: e.id }).map(({ key, ...p }) => p) : null;
      const lang = this.langNow();
      plugins.push({
        id: e.id,
        version: e.version,
        title: pickLang(e.title, e.i18n, "title", lang),
        desc: pickLang(e.desc, e.i18n, "desc", lang),
        author: e.author,
        platforms: e.platforms,
        type: e.type,
        interval: e.interval,
        tier: e.tier,
        official: e.tier === "official",
        label: e.tier === "official" ? "official" : null,
        // G19: the registry listing it, the label suffix (null with only the default registry) and the full tier label
        registry: e.registry || null,
        registryLabel: registryLabel(e.registry, srcs),
        tierLabel: tierLabel(e.tier, e.registry, srcs),
        ...(e.capped ? { capped: true } : {}),
        sha256: e.sha256,
        size: e.size,
        permissions: localizePerms(permissionList(e.permissions, { pluginId: e.id }).map(({ key, ...p }) => p), e.i18n, lang),
        installed: inst ? inst.version : null,
        installedOwn: own ? { path: inst.own?.path || null, pathShort: shortPath(inst.own?.path || "") } : null,
        updateAvailable: Boolean(inst && !own && !elsewhere && inst.sha256 !== e.sha256),
        growth,
        // "Requires <program>": the dependency and whether it's installed (whether the check path exists in the plugins' HOME)
        requires: (e.requires || []).map((r) => {
          const tr = contentOf(e.i18n, lang, { field: "requires" }).requires?.[r.name] || {};
          return { name: tr.name || r.name, url: r.url, note: tr.note || r.note || null, check: r.check, present: existsSync(expandPath(r.check, this.homeDir())) };
        }),
        blocked: this.blockReason(e.id, { version: e.version, sha256: e.sha256, registry: e.registry }),
        builtin: builtin.has(e.id),
        platformOk: !e.platforms.length || e.platforms.includes(PLATFORM),
        // contract 2: icon from the index and "needs a newer hub" (the plugin needs a newer contract than this core)
        icon: e.icon || null,
        contract: e.contract || 1,
        ...(entryContractTooNew(e) ? { needsHub: entryContractTooNew(e) } : {}),
      });
    }
    return {
      configured: this.configured(),
      // what's missing to connect the (first) registry: the index URL, the public key, or both
      missing: [!this.indexUrl() && "index-url", !this.publicKey() && "public-key"].filter(Boolean),
      generatedAt: this.catalog?.generatedAt || null,
      fetchedAt: this.catalog?.fetchedAt || null,
      // G19: every configured registry ({name, trust, label, configured, missing, generatedAt, fetchedAt, plugins, error,
      // tierLabel}) and the ids a later registry also lists (hidden: the earlier registry wins)
      registries: this.registriesView(),
      shadowed: (this.catalog?.shadowed || []).map((x) => ({ ...x })),
      error: this.catalogError,
      // for the "how to connect" hint: CLI with the full path and the hub directory (non-default — AGENTHUB_HOME=…)
      connect: { cli: CLI_PATH, home: this.paths.home, defaultHome: samePath(this.paths.home, liveStateDir()) },
      plugins,
    };
  }

  listInstalled() {
    const lock = this.lock();
    const installed = Object.values(lock.plugins).map((e) => {
      if (e.tier === "own") return this.ownInstalledView(e);
      // tier — as in the policy: by the verified catalog right now, not by the lock entry
      const official = this.officialNow(e.id, e);
      const ce = this.catalogEntry(e.id, e);
      const lang = this.langNow();
      const reg = this.registryOf(e);
      return {
        id: e.id,
        title: ce ? pickLang(ce.title, ce.i18n, "title", lang) : e.id,
        // official in the catalog, but the archive is of another version: until updated it runs as a community plugin
        officialPending: !official && ce?.tier === "official" && ce.sha256 !== e.sha256,
        updateAvailable: Boolean(ce && ce.sha256 !== e.sha256),
        version: e.version,
        sha256: e.sha256,
        tier: official ? "official" : "community",
        official,
        // G19: the registry it was installed from; registryLabel — null with only the default registry
        registry: reg,
        registryLabel: registryLabel(reg, this.sources()),
        tierLabel: tierLabel(official ? "official" : "community", reg, this.sources()),
        source: "installed",
        // official and third-party plugins are removed by the manager; built-ins (app directory) are not
        removable: true,
        label: null,
        disabled: e.disabled ? e.disabled.reason : null,
        installedAt: e.installedAt,
        updatedAt: e.updatedAt,
        permissions: localizePerms(permissionList(e.granted, { pluginId: e.id }).map(({ key, ...p }) => p), ce?.i18n, lang),
      };
    });
    const local = [];
    try {
      for (const pl of scanDir(this.paths.pluginsLocal, "local").plugins) {
        local.push({
          id: pl.id,
          version: pl.meta.version,
          source: "local",
          tier: "local",
          label: unverifiedLabel(),
          effectsCeiling: ["open.*"],
          blocked: this.blockReason(pl.id, { any: true }),
          permissions: permissionList(permissionsFromMeta(pl.meta), { pluginId: pl.id }).map(({ key, ...p }) => p),
        });
      }
    } catch {}
    return { installed, local, requests: this.ownRequestList() };
  }

  // "Installed" row for an own plugin: folder path, its state, update with permission growth.
  ownInstalledView(e) {
    const lang = this.langNow();
    const st = this.ownState.get(e.id) || null;
    return {
      id: e.id,
      title: pickLang(e.title, e.i18n, "title", lang) || e.id,
      officialPending: false,
      updateAvailable: st?.status === "update",
      version: e.version,
      sha256: e.sha256,
      tier: "own",
      official: false,
      source: "installed",
      removable: true,
      label: null,
      disabled: e.disabled ? e.disabled.reason : null,
      installedAt: e.installedAt,
      updatedAt: e.updatedAt,
      permissions: localizePerms(permissionList(e.granted, { pluginId: e.id }).map(({ key, ...p }) => p), e.i18n, lang),
      own: {
        path: e.own?.path || null,
        pathShort: shortPath(e.own?.path || ""),
        // ok | update (permissions grew — consent window; narrowed or version rollback — one click) | paused (waiting for the hub
        // pause to lift) | unverified (lock entry not confirmed — runs as community, awaits a request) | missing |
        // broken | unknown
        status: st?.status || "unknown",
        downgrade: Boolean(st?.downgrade),
        error: st?.error || null,
        errors: st?.errors || [],
        // own:hub-too-old: the plugin in the folder requires a newer contract (need) than the hub understands (have)
        ...(Number.isInteger(st?.need) ? { need: st.need, have: st.have } : {}),
        checkedAt: st?.checkedAt || null,
        fingerprint: e.sha256,
        next: st && st.fingerprint && st.fingerprint !== e.sha256 ? { version: st.version || null, fingerprint: st.fingerprint } : null,
        growth: st?.status === "update" ? localizePerms(st.growth || [], st.i18n || e.i18n, lang) : [],
      },
    };
  }
}

// services.plugins from config.json: {} — no file or section, null — the file couldn't be parsed.
function readPluginOpts(path) {
  try {
    if (!existsSync(path)) return {};
    const cfg = readJsonFile(path);
    const o = cfg?.services?.plugins;
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return null;
  }
}

function cleanI18n(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [raw, x] of Object.entries(v).slice(0, 64)) {
    // any BCP-47 tag (G14), canonical case; malformed — dropped
    const lang = normTag(raw);
    if (!lang || !x || typeof x !== "object") continue;
    const e = {};
    if (isStr(x.title, 200) && x.title) e.title = x.title;
    if (isStr(x.desc, 1000) && x.desc) e.desc = x.desc;
    for (const k of ["why", "actions"]) {
      if (!x[k] || typeof x[k] !== "object" || Array.isArray(x[k])) continue;
      const m = {};
      for (const [what, why] of Object.entries(x[k]).slice(0, 200)) if (isStr(what, 1024) && isStr(why, 1024) && why) m[what] = why;
      if (Object.keys(m).length) e[k] = m;
    }
    // dependency translations: { <name>: { name?, note? } }
    if (x.requires && typeof x.requires === "object" && !Array.isArray(x.requires)) {
      const m = {};
      for (const [name, v] of Object.entries(x.requires).slice(0, 8)) {
        if (!isStr(name, 64) || !v || typeof v !== "object") continue;
        const r = {};
        if (isStr(v.name, 64) && v.name) r.name = v.name;
        if (isStr(v.note, 300) && v.note) r.note = v.note;
        if (Object.keys(r).length) m[name] = r;
      }
      if (Object.keys(m).length) e.requires = m;
    }
    if (Object.keys(e).length) out[lang] = e;
  }
  return out;
}

// Permission translations from archive metadata: { en: { why: { <what>: <why> }, actions: { <id>: <title> } } }.
function permI18nFromMeta(meta) {
  const out = {};
  for (const [lang, v] of Object.entries(meta?.i18n || {})) if (v?.why) (out[lang] ||= {}).why = { ...v.why };
  for (const a of meta?.actions || []) {
    for (const [lang, v] of Object.entries(a.i18n || {})) if (v?.title) ((out[lang] ||= {}).actions ||= {})[a.id] = v.title;
  }
  return cleanI18n(out);
}

function mergeI18n(a = {}, b = {}) {
  const out = {};
  for (const lang of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a?.[lang] || {};
    const y = b?.[lang] || {};
    out[lang] = { ...x, ...y, why: { ...(x.why || {}), ...(y.why || {}) }, actions: { ...(x.actions || {}), ...(y.actions || {}) } };
  }
  return out;
}

// Source in the consent window: real folder path and the same for display (with "~"), content fingerprint, who can write
// to the folder (only you; your group too — accepted with the "group-writable" risk line; anyone else — the request can't be
// accepted), linter warnings (immediate actions) and push rule
// warnings (kind="security", core keys) — for an own plugin the reviewer is the human themselves.
function ownSourceView(src) {
  return {
    kind: "own",
    path: src.path,
    pathShort: shortPath(src.path),
    fingerprint: src.fingerprint,
    writable: { mine: src.writable?.mine !== false, others: src.writable?.others || [], group: src.writable?.group || [], parentOpen: Boolean(src.writable?.parentOpen), acl: src.writable?.acl || [] },
    // a loud line in the window (the WRITE_RISK_TEXT kind): the folder is writable by the group — allowed, but the human must see it
    risk: ownRisk(src.writable),
    warnings: src.warnings || [],
  };
}

// The risk of an own plugin folder that is still accepted: writable by the group (umask 002), not by everyone. → "group-writable" | null
export function ownRisk(writable) {
  return Array.isArray(writable?.group) && writable.group.length > 0 ? "group-writable" : null;
}

// Permissions in the hub language: "why" from translations (for actions — the title-xx title), otherwise as the author wrote it.
// For watching, "why" is part of the entry itself (the permission key depends on it), so we separate it for display.
// Keys and the "new" mark don't change: translation affects labels only.
export function localizePerms(list, i18n, lang) {
  const trWhy = contentOf(i18n, lang, { field: "why" });
  const trAct = contentOf(i18n, lang, { field: "actions" });
  return (list || []).map((p) => {
    let what = p.what;
    let why = p.why;
    if (p.kind === "watch" && !why) ({ what, why } = splitWhy(what));
    const norm = (v) => String(v).trim().replace(/\s+/g, " ");
    // a recursive watch (B10) is translated by its path
    const key = p.kind === "watch" ? norm(what).replace(/ recursive$/, "") : norm(what);
    const byWhat = trWhy.why ? Object.entries(trWhy.why).find(([k]) => norm(k) === key || norm(k) === norm(what))?.[1] : undefined;
    const byAction = p.kind === "actions" ? trAct.actions?.[String(what).split(" ")[0]] : undefined;
    return { ...p, what, why: byWhat ?? byAction ?? why ?? null };
  });
}

// Manager per state directory: the core loads the service and routes separately.
const managers = new Map();
export function registerManager(home, mgr) {
  managers.set(resolve(home), mgr);
}
export function unregisterManager(home, mgr) {
  if (managers.get(resolve(home)) === mgr) managers.delete(resolve(home));
}
export function managerFor(home) {
  return managers.get(resolve(home)) || null;
}
