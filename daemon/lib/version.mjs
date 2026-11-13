// The hub version has a single source of truth: the VERSION file at the repository root (and in every installed version
// <home>/Versions/<label>/src/VERSION). It's read by the daemon (/state.version, the start entry), the bridge, scripts/bundle.sh
// (the app's CFBundleShortVersionString). daemon/package.json and claude-plugin/.claude-plugin/plugin.json are
// derived copies: scripts/set-version.sh writes them, version.test.mjs catches a mismatch.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERSION_FILE = join(ROOT, "VERSION");
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+([0-9A-Za-z.-]{1,64}))?$/;

// VERSION file text → "X.Y.Z[-pre]" | null.
export function parseVersionFile(text) {
  const v = String(text ?? "").trim();
  return SEMVER.test(v) ? v : null;
}

export function readVersion(file = VERSION_FILE) {
  try {
    return parseVersionFile(readFileSync(file, "utf8")) ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

// "1.2.3-rc.1+meta" → { major, minor, patch, pre: ["rc", 1] | [] } | null. The build tag (+…) is ignored.
export function parseSemver(v) {
  const m = SEMVER.exec(String(v ?? "").trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

// Semver comparison: numbers as numbers, a pre-release is lower than the release of the same version. → -1 | 0 | 1 (null — not versions).
export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseSemver(a) : a;
  const y = typeof b === "string" ? parseSemver(b) : b;
  if (!x || !y) return null;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = typeof p === "number";
    const qn = typeof q === "number";
    if (pn && qn) return p < q ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// Release tag "vX.Y.Z[-pre]" → version "X.Y.Z[-pre]" | null.
export function tagVersion(tag) {
  const m = /^v(\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?)$/.exec(String(tag ?? ""));
  return m ? m[1] : null;
}

// Version directory label: "0.2.0", "0.1.0-dev.6ceb3d8", "0.1.0-dev.6ceb3d8.dirty". Only such names in Versions/.
export const LABEL_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;
export function isLabel(s) {
  return typeof s === "string" && LABEL_RE.test(s) && !s.includes("..");
}

// The version a build counts as when looking for updates. A build from a working folder or a branch is labelled
// `X.Y.Z-dev.<sha7>[.dirty]` (hub migrate, the branch channel); semver reads `-dev…` as "before X.Y.Z", so the hub
// offered the older `vX.Y.Z` tag as an update (13.11: 0.1.2-dev.52e4996 → v0.1.2, code from before the build). VERSION
// is raised by the release commit itself (scripts/set-version.sh, docs/hub-updates.md §9), so such a build is at or after
// X.Y.Z: it compares as X.Y.Z — the same tag is not newer, the next one is. Other labels are returned as they are.
export function updateBaseOf(label) {
  const m = /^(\d+\.\d+\.\d+)-dev\.[0-9a-f]{7}(?:\.dirty)?$/.exec(String(label ?? ""));
  return m ? m[1] : label;
}
