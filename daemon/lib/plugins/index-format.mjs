// The signed registry index (index.json): size limits, the shape check (parseIndex), the tier and contract of an entry,
// this hub's platform name and the version order. Pure functions — no manager here.
// lib/plugins.mjs re-exports the public names.

import { CONTRACT_VERSION, parseIcon, parseRequires } from "../meta.mjs";
import { cleanAuthor } from "../author.mjs";
import { CONTRACT_FEATURES, ID_RE, RESERVED_IDS } from "../registry/perms.mjs";
import { isStr, RegistryError } from "./common.mjs";
import { cleanI18n } from "./perm-i18n.mjs";

export const INDEX_VERSION = 1;
export const MAX_INDEX_BYTES = 4 * 1024 * 1024;
export const MAX_SIG_BYTES = 4096;
export const PLATFORM = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;
const KINDS_WITH_WHY = ["fsRead", "fsWrite", "watch", "exec", "secrets", "net", "connections", "terminal", "subscribe"];

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
export function entryIcon(v) {
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
  // expiresAt (optional, signed with the rest of the index): the moment after which the registry owner no longer vouches
  // for this catalog. A registry that re-signs on a schedule never serves an expired one, so a catalog past this date is a
  // frozen or replayed copy: it is kept for tiers and the blocklist but offers nothing to install (PluginManager.catalogExpired).
  // An index without the field has no such limit (noteFreshness journals it); a field that is not a date is a build error.
  let expiresAt = null;
  if (obj.expiresAt !== undefined && obj.expiresAt !== null) {
    if (!isStr(obj.expiresAt, 64) || Number.isNaN(Date.parse(obj.expiresAt))) throw new RegistryError(422, "registry:index-expiresAt");
    expiresAt = obj.expiresAt;
  }
  return { generatedAt: obj.generatedAt, expiresAt, plugins, blocklist };
}

// Tiers a signed registry index may assign. The index doesn't assign builtin and local:
// those are install locations (the app directory and Plugins/local).
export const INDEX_TIERS = ["official", "community"];
// Tier of an index or plugins.lock entry: tier, and for entries predating tier — by the official field.
export function entryTier(e) {
  if (e?.tier === "official" || e?.tier === "community") return e.tier;
  return e?.official === true ? "official" : "community";
}
