// Copy of the built-in plugins in the state directory: <home>/Builtin.
//
// The live daemon (launchd) runs built-in plugins from its own copy, not from the repository working tree:
// an edit in ~/path/to/agent-hub/plugins (uncommitted, on another branch, half-saved) does not reach
// the running hub until a human updates the copy with `agenthub builtin update` (or `agenthub install
// --apply`). Test mode (AGENTHUB_HOME) and running from the repo without installing still use <repo>/plugins.
//
// Copying is in place, file by file (a temp file in the same directory + rename): the Builtin directory
// stays the same, so the host watcher (fs.watch) keeps seeing changes; unchanged files are not touched,
// so their plugins do not restart. Permissions: directories 0700, files 0600, executables (source has the x bit)
// 0700. Symlinks and dotfiles are not copied. The copy manifest is
// <home>/Builtin/.agenthub-builtin.json (source, time, file sha256s).

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readJsonFile, REPO_DIR } from "./config.mjs";
import { myUid, samePath, usesFileModes } from "./platform.mjs";
import { msg } from "./i18n.mjs";

export const BUILTIN_DIR = "Builtin";
export const MANIFEST = ".agenthub-builtin.json";
export const REPO_PLUGINS = join(REPO_DIR, "plugins");

export function builtinCopyDir(home) {
  return join(home, BUILTIN_DIR);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const MODES = usesFileModes();

// Source files: { rel → { abs, exec } } (rel uses "/"), skipping dot names and symlinks.
function walk(src) {
  const out = new Map();
  const skipped = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const rel = relative(src, abs).split(sep).join("/");
      if (st.isSymbolicLink()) skipped.push(rel);
      else if (st.isDirectory()) visit(abs);
      else if (st.isFile()) out.set(rel, { abs, exec: (st.mode & 0o111) !== 0 });
    }
  };
  visit(src);
  return { files: out, skipped };
}

function readManifest(dest) {
  try {
    return JSON.parse(readFileSync(join(dest, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

// Compare the copy with the source without changing anything. → { dest, exists, added, updated, removed, same }
export function builtinStatus({ src = REPO_PLUGINS, home }) {
  const dest = builtinCopyDir(home);
  const { files } = walk(src);
  const exists = existsSync(dest);
  const added = [];
  const updated = [];
  let same = 0;
  for (const [rel, f] of files) {
    const target = join(dest, ...rel.split("/"));
    if (!existsSync(target)) added.push(rel);
    else if (sha256(readFileSync(target)) !== sha256(readFileSync(f.abs)) || (MODES && (statSync(target).mode & 0o777) !== (f.exec ? 0o700 : 0o600))) updated.push(rel);
    else same++;
  }
  const removed = exists ? extraFiles(dest, files) : [];
  return { src, dest, exists, added, updated, removed, same, manifest: exists ? readManifest(dest) : null };
}

function extraFiles(dest, files) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      // dot names (the manifest, Finder's .DS_Store, leftovers of an interrupted write .<name>.tmp-<pid>) are not copied
      // from the source (walk), so they do not count as extra in the copy
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const rel = relative(dest, abs).split(sep).join("/");
      if (rel === MANIFEST) continue;
      const st = lstatSync(abs);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        visit(abs);
        if (![...files.keys()].some((k) => k.startsWith(rel + "/"))) out.push(rel + "/");
      } else if (!files.has(rel)) out.push(rel);
    }
  };
  visit(dest);
  return out;
}

// Remove leftovers of an interrupted write (.<name>.tmp-<pid>, manifest .agenthub-builtin.json.tmp-<pid>). Symlinks are left alone.
const TEMP_RE = /^\..+\.tmp-\d+$/;
function removeStaleTemps(dest) {
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory() && !st.isSymbolicLink()) visit(abs);
      else if (st.isFile() && TEMP_RE.test(name)) rmSync(abs, { force: true });
    }
  };
  try {
    visit(dest);
  } catch {}
}

// The destination must be a real directory owned by this user (not a symlink, or the copy would go
// wherever the link points).
function ensureDir(path) {
  if (existsSync(path)) {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(msg("err.builtin.notDir", { path }));
    const uid = myUid();
    if (uid !== null && uid !== undefined && st.uid !== uid) throw new Error(msg("err.otherOwner", { path }));
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  if (MODES) chmodSync(path, 0o700);
}

// Update the copy. dryRun only counts. → same as builtinStatus, plus skipped (symlinks).
export function syncBuiltin({ src = REPO_PLUGINS, home, dryRun = false, now = () => new Date() }) {
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(msg("err.builtin.noSrc", { path: src }));
  if (samePath(src, builtinCopyDir(home))) throw new Error(msg("err.builtin.same"));
  const st = builtinStatus({ src, home });
  const { files, skipped } = walk(src);
  if (dryRun) return { ...st, skipped, dryRun: true };
  ensureDir(home);
  const dest = st.dest;
  ensureDir(dest);
  const manifestFiles = {};
  for (const [rel, f] of files) {
    const target = join(dest, ...rel.split("/"));
    // directories along the path, top-down: each is checked (not a symlink, ours) and gets 0700
    const parts = rel.split("/").slice(0, -1);
    let d = dest;
    for (const p of parts) {
      d = join(d, p);
      ensureDir(d);
    }
    const data = readFileSync(f.abs);
    manifestFiles[rel] = sha256(data);
    const mode = f.exec ? 0o700 : 0o600;
    if (!st.added.includes(rel) && !st.updated.includes(rel)) continue;
    const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);
    writeFileSync(tmp, data, { mode });
    if (MODES) chmodSync(tmp, mode);
    renameSync(tmp, target);
  }
  for (const rel of st.removed) rmSync(join(dest, ...rel.replace(/\/$/, "").split("/")), { recursive: true, force: true });
  removeStaleTemps(dest);
  const manifest = { source: resolve(src), copiedAt: now().toISOString(), files: manifestFiles };
  const mtmp = join(dest, `${MANIFEST}.tmp-${process.pid}`);
  writeFileSync(mtmp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  if (MODES) chmodSync(mtmp, 0o600);
  renameSync(mtmp, join(dest, MANIFEST));
  return { ...st, skipped, manifest };
}

// config.json: builtinPluginsDir → the copy. Other keys are kept; the write is atomic, 0600.
// → { changed, before }
export function pointConfigAtCopy(configPath, dir) {
  let cfg = {};
  if (existsSync(configPath)) {
    try {
      cfg = readJsonFile(configPath);
    } catch (e) {
      throw new Error(msg("err.config.parseKeep", { why: e.message }));
    }
  }
  const before = cfg.builtinPluginsDir ?? null;
  if (before === dir) return { changed: false, before };
  cfg.builtinPluginsDir = dir;
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  if (MODES) chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { changed: true, before };
}
