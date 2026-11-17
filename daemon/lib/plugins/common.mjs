// What every part of the plugin manager shares: RegistryError (a refusal with its HTTP status and code), the state-file
// helpers (atomic write, tolerant JSON read, sha256, hashes of a directory tree) and the lifetime of a consent window token.
// No manager here. lib/plugins.mjs re-exports the public names.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { msg } from "../i18n.mjs";
import { writeFileAtomic } from "../statefile.mjs";
import { LIMITS as TAR_LIMITS } from "../registry/tarball.mjs";

export const CONSENT_TTL_MS = 120_000;

export class RegistryError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// The shared helper (lib/statefile.mjs): the directory is created, a temp file next to the target, rename.
export function atomicWrite(path, text, mode = 0o600) {
  writeFileAtomic(path, text, { mode, mkdir: true });
}

export function readJsonOr(path, fallback) {
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

export function sameFiles(a, b) {
  const ka = Object.keys(a || {}).sort();
  const kb = Object.keys(b || {}).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function isStr(v, max) {
  return typeof v === "string" && v.length <= max;
}
