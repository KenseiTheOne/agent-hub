// An own plugin source (decision 2026-11-09): a local folder outside the registry that the human approved in the app.
//
// The folder format is the same as a registry plugin (agent-hub-plugins/plugins/<id>/): the main file
// <id>.<interval>.<extension> with metadata, README.md, optionally test/ and fixtures/. Convention for
// a repository: the plugin lives in agenthub/<id>/ — then the repository root can be given too (the only plugin in
// agenthub/ is found automatically). No git URLs: only a folder on this Mac.
//
// The check is the same as in registry CI (scripts/lib/registry.mjs inspectPlugin): no symlinks, README,
// exactly one text main file with a known interpreter, metadata without warnings, lintPlugin (as for
// official: actions allowed), forbidden places in all copy files, size limits. The copy, like a registry
// archive, excludes test/, fixtures/ and dot files. The fingerprint (sha256 of the "path — file sha256" list) is what
// the human agrees to; it's also the sha256 in plugins.lock.
//
// The path is a realpath: a symlink to the folder is resolved at request time, and the real path goes into plugins.lock; there are no symlinks inside
// the folder at all (neither outward nor inward). Only the owner — the current user — may write to the folder and its files:
// group- or world-writable, a foreign owner or a world-writable directory above the folder (without
// sticky) — refused: the hub installs changes without new permissions itself, and a foreign writer would gain the own plugin's trust.
// On macOS ACLs also grant permissions (`chmod +a "everyone allow write"` with mode 644): ACL write access for anyone but you —
// also refused (writableInfo reads them via /bin/ls -le). Processes running as your own user (including agents in
// this repository) can always write to the folder — the folder check doesn't protect against them.
//
// Reading — without following symlinks and without a check-then-read race: the file is opened with O_NOFOLLOW|O_NONBLOCK,
// and fstat of the descriptor must match the walk's lstat (same inode, a regular file, within the limit); a FIFO and
// a file swapped for a symlink are errors, not a read of a foreign place or a hung daemon event loop. Directories are
// re-checked with lstat after reading the listing. The walk is complete (more files than the limit is an error, not a truncated list).
//
// Error and warning texts are in the hub language (lang: ru | en), including the linter's (perms.mjs, shared with the registry:
// registry CI calls it without lang — in Russian); reasons for forbidden paths and metadata are in Russian for now.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseFileName, parseMetaText } from "../meta.mjs";
import { aclListCommand, myUid } from "../platform.mjs";
import { ID_RE, RESERVED_IDS, lintPlugin, loudPushRules, permissionsFromMeta, pushWarnings, sourceViolations } from "./perms.mjs";
import { LIMITS } from "./tarball.mjs";

// Like the registry (agent-hub-plugins scripts/lib/registry.mjs): only text plugins with a known interpreter.
export const ALLOWED_EXT = new Set(["mjs", "js", "cjs", "py", "sh", "bash", "zsh"]);
// Tests and fixtures (as in a registry archive) and dot files don't go into the copy.
export const PACK_EXCLUDE_TOP = new Set(["test", "fixtures"]);
export const inPack = (rel) => !rel.split("/").some((s) => s.startsWith(".")) && !PACK_EXCLUDE_TOP.has(rel.split("/")[0]);
// The convention directory in a repository: <repo>/agenthub/<id>/
export const REPO_DIR = "agenthub";

export class OwnSourceError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// Content fingerprint: sha256 of "path\tsha256" lines ordered by path. Doesn't depend on file times or permissions.
export function fingerprintOf(files) {
  const lines = files.map((f) => `${f.rel}\t${f.sha256 || sha256(f.data)}`).sort();
  return sha256(lines.join("\n") + "\n");
}

// ~/… and an absolute path; the CLI resolves a relative one itself (from its cwd), the daemon doesn't need it.
export function expandPath(p, home = homedir()) {
  const s = String(p ?? "");
  if (s === "~") return home;
  if (s.startsWith("~/")) return join(home, s.slice(2));
  return s;
}

// For display: the home directory is "~".
export function shortPath(p, home = homedir()) {
  const s = String(p ?? "");
  return home && (s === home || s.startsWith(home + "/")) ? "~" + s.slice(home.length) : s;
}

function mainsIn(dir, id) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (n.startsWith(".")) return false;
    const fn = parseFileName(n);
    if (!fn || fn.id !== id) return false;
    try {
      return lstatSync(join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

// The plugin folder from the human's path: the plugin folder itself (<…>/<id>/ with <id>.<…>) or a repository root with a single
// plugin in agenthub/. → realpath of the plugin folder
export function resolveSourceDir(input, { home = homedir() } = {}) {
  if (typeof input !== "string" || !input || input.length > 1024 || input.includes("\0")) throw new OwnSourceError(400, "own:path");
  const p = expandPath(input, home);
  if (!isAbsolute(p)) throw new OwnSourceError(400, "own:path-relative");
  let real;
  try {
    real = realpathSync(p);
  } catch {
    throw new OwnSourceError(404, "own:not-found", { path: p });
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new OwnSourceError(404, "own:not-found", { path: real });
  }
  if (!st.isDirectory()) throw new OwnSourceError(422, "own:not-dir", { path: real });
  if (mainsIn(real, basename(real)).length) return real;
  const repo = join(real, REPO_DIR);
  let sub = [];
  try {
    if (lstatSync(repo).isDirectory()) {
      sub = readdirSync(repo)
        .filter((n) => !n.startsWith(".") && !n.startsWith("_"))
        .filter((n) => {
          try {
            return lstatSync(join(repo, n)).isDirectory() && mainsIn(join(repo, n), n).length > 0;
          } catch {
            return false;
          }
        })
        .sort();
    }
  } catch {}
  if (sub.length === 1) return join(repo, sub[0]);
  if (sub.length > 1) throw new OwnSourceError(409, "own:ambiguous", { path: real, ids: sub.slice(0, 20) });
  throw new OwnSourceError(422, "own:no-plugin", { path: real });
}

// Folder check error texts: [ru, en].
const MSG = {
  badId: (p) => [`имя папки «${p.id}»: только a-z, 0-9, «-», до 64 символов`, `folder name "${p.id}": only a-z, 0-9, "-", up to 64 characters`],
  symlink: (p) => [`${p.rel}: символьные ссылки запрещены`, `${p.rel}: symbolic links are not allowed`],
  other: (p) => [`${p.rel}: не файл и не папка`, `${p.rel}: neither a file nor a folder`],
  tooMany: (p) => [`файлов больше ${p.n}`, `more than ${p.n} files`],
  tooManyEntries: (p) => [`в папке больше ${p.n} записей — проверка прервана`, `the folder has more than ${p.n} entries — check stopped`],
  notMine: () => ["папку или её файлы может менять другой пользователь (владелец — не вы)", "another user can change the folder or its files (you're not the owner)"],
  others: (p) => [`писать сюда могут не только вы (права группы или всех): ${p.list}`, `not only you can write here (group or everyone permissions): ${p.list}`],
  acl: (p) => [`писать сюда могут не только вы (ACL): ${p.list}`, `not only you can write here (ACL): ${p.list}`],
  parentOpen: (p) => [`каталог над папкой открыт на запись всем: ${p.dir}`, `the folder above is world-writable: ${p.dir}`],
  noReadme: () => ["нет README.md", "no README.md"],
  manyMains: (p) => [`несколько исполняемых файлов: ${p.list}`, `several executable files: ${p.list}`],
  noMain: (p) => [`нет файла ${p.id}.<интервал>.<расширение> или ${p.id}.<расширение>`, `no ${p.id}.<interval>.<ext> or ${p.id}.<ext> file`],
  tooBig: (p) => [`${p.rel}: больше ${p.n} байт`, `${p.rel}: larger than ${p.n} bytes`],
  unreadable: (p) => [`${p.rel}: не читается (${p.code})`, `${p.rel}: can't be read (${p.code})`],
  changed: (p) => [`${p.rel}: файл сменился во время проверки`, `${p.rel}: the file changed during the check`],
  dirChanged: (p) => [`${p.rel}: папка сменилась во время проверки`, `${p.rel}: the folder changed during the check`],
  totalBig: (p) => [`плагин больше ${p.n} байт`, `the plugin is larger than ${p.n} bytes`],
  ext: (p) => [`${p.main}: только ${p.list} (бинарники и прочее не принимаются)`, `${p.main}: only ${p.list} (binaries and the like aren't accepted)`],
  binaryMain: (p) => [`${p.main}: двоичный файл`, `${p.main}: binary file`],
  mainUnread: (p) => [`${p.main}: главный файл не прочитан`, `${p.main}: the main file wasn't read`],
  noMeta: (p) => [`${p.main}: нет метаданных плагина`, `${p.main}: no plugin metadata`],
  meta: (p) => [`метаданные: ${p.w}`, `metadata: ${p.w}`],
  binary: (p) => [`${p.rel}: двоичные файлы не принимаются`, `${p.rel}: binary files aren't accepted`],
  forbidden: (p) => [`${p.rel}: упоминает запретное место: ${p.what}`, `${p.rel}: mentions a forbidden location: ${p.what}`],
};
const say = (lang, key, p = {}) => MSG[key](p)[lang === "en" ? 1 : 0];

// All folder entries (without dot entries), in full: no truncation — more than maxEntries entries gives over (a check
// error). A symlink is an entry with symlink: true; a directory is re-checked with lstat after reading the listing (a directory
// swapped for a symlink between lstat and readdir — dirChanged).
function walk(dir, maxEntries, rel = "", out = { entries: [], over: false, dirChanged: [] }) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    if (out.entries.length >= maxEntries) {
      out.over = true;
      return out;
    }
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.entries.push({ rel: r, abs, st, symlink: true });
    else if (st.isDirectory()) {
      out.entries.push({ rel: r, abs, st, dir: true });
      walk(abs, maxEntries, r, out);
      if (out.over) return out;
      let again = null;
      try {
        again = lstatSync(abs);
      } catch {}
      if (!again || !again.isDirectory() || again.ino !== st.ino || again.dev !== st.dev) out.dirChanged.push(r);
    } else if (st.isFile()) out.entries.push({ rel: r, abs, st });
    else out.entries.push({ rel: r, abs, st, other: true });
  }
  return out;
}

// Read a walked file without a race: O_NOFOLLOW (a symlink — ELOOP), O_NONBLOCK (a FIFO doesn't block), fstat of the descriptor —
// a regular file, the same inode as the walk's lstat, within limit; at most limit bytes are read.
// → { data } | { error: "changed" | "too-big" | <code> }
export function readChecked(abs, st, limit) {
  let fd;
  try {
    fd = openSync(abs, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch (e) {
    return { error: e.code === "ELOOP" || e.code === "EMLINK" ? "changed" : e.code || "open" };
  }
  try {
    const fs = fstatSync(fd);
    if (!fs.isFile() || fs.ino !== st.ino || fs.dev !== st.dev) return { error: "changed" };
    if (fs.size > limit) return { error: "too-big" };
    const buf = Buffer.alloc(Math.min(fs.size, limit) + 1);
    let n = 0;
    for (;;) {
      const k = readSync(fd, buf, n, buf.length - n, null);
      if (k <= 0) break;
      n += k;
      if (n >= buf.length) break;
    }
    if (n > limit) return { error: "too-big" };
    return { data: buf.subarray(0, n) };
  } catch (e) {
    return { error: e.code || "read" };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

// ACL entries granting write access to anyone but you (macOS: `/bin/ls -le`). → [relative paths] | null (can't tell)
const ACL_LINE = /^\s*\d+:\s+(\S+)\s+(?:inherited\s+)?(allow|deny)\s+(\S+)/;
const ACL_WRITE = new Set(["write", "append", "add_file", "add_subdirectory", "delete_child", "delete", "writeattr", "writeextattr", "writesecurity", "chown"]);
const LS_ENTRY = /^[-dlbcpsw][-rwxsStT]{9}[@+]?\s/;
const LS_NAME = /\s(?:\d{1,2}:\d{2}|\d{4})\s(.+)$/;
export function aclWriters(dir, { me = currentUser(), run = runLs } = {}) {
  if (!aclListCommand()) return [];
  let selfOut;
  let treeOut;
  try {
    selfOut = run(["-lde", dir]);
    treeOut = run(["-leR", dir]);
  } catch {
    return null;
  }
  const out = new Set();
  const scan = (text, self) => {
    let section = "";
    let last = null;
    for (const line of String(text).split("\n")) {
      if (!self && line.endsWith(":") && line.startsWith(dir + "/")) {
        section = line.slice(dir.length + 1, -1);
        last = null;
        continue;
      }
      if (LS_ENTRY.test(line)) {
        const m = LS_NAME.exec(line);
        last = self ? "." : m ? (section ? `${section}/${m[1]}` : m[1]) : "?";
        continue;
      }
      const a = ACL_LINE.exec(line);
      if (!a || a[2] !== "allow" || last == null) continue;
      if (a[1] === `user:${me}`) continue;
      if (a[3].split(",").some((r) => ACL_WRITE.has(r))) out.add(last);
    }
  };
  scan(selfOut, true);
  scan(treeOut, false);
  return [...out].filter((r) => r === "." || !r.split("/").some((s) => s.startsWith(".")));
}
function runLs(args) {
  return execFileSync(aclListCommand(), args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
}
function currentUser() {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

// Who can write to the source folder. → { mine, others: [paths], parentOpen, acl: [paths] } — others: what's writable by
// group or world by mode bits; acl — where an ACL grants write to someone other than you (macOS). Without a uid (Windows: permission bits
// mean something else there) — not checked.
export function writableInfo(dir, entries, uid = myUid() ?? -1, { acl = aclWriters } = {}) {
  const others = [];
  if (uid < 0) return { mine: true, others, parentOpen: false, acl: [] };
  let mine = true;
  const note = (rel, st) => {
    if (uid >= 0 && st.uid !== uid) mine = false;
    if (st.mode & 0o022) others.push(rel);
  };
  note(".", statSync(dir));
  for (const e of entries) if (!e.symlink) note(e.rel, e.st);
  let parentOpen = false;
  try {
    const ps = statSync(dirname(dir));
    parentOpen = Boolean(ps.mode & 0o002) && !(ps.mode & 0o1000);
  } catch {}
  const viaAcl = acl ? acl(dir) : [];
  return { mine, others: others.slice(0, 10), parentOpen, acl: (viaAcl || []).slice(0, 10) };
}

// Full check of a source folder. Path errors — OwnSourceError; content errors — in errors (like the CI linter).
// → { dir, id, main, meta, perms, files: [{rel, data, sha256}], fingerprint, version, errors, warnings, writable }
// perms — permissions from metadata plus loud push rules (push kind: security and quiet — for an own plugin the human
// sees them themselves, and their appearance is permission growth). warnings — the linter (immediate actions) and pushWarnings, as in registry CI.
// afterWalk — tests only (the check-then-read race).
export function inspectSource(input, { home = homedir(), uid = myUid() ?? -1, lang = "ru", acl = aclWriters, afterWalk = null } = {}) {
  const dir = resolveSourceDir(input, { home });
  const id = basename(dir);
  const errors = [];
  const warnings = [];
  const E = (key, p) => errors.push(say(lang, key, p));
  if (!ID_RE.test(id) || RESERVED_IDS.has(id)) E("badId", { id });
  let walked;
  const maxEntries = LIMITS.maxFiles * 5;
  try {
    walked = walk(dir, maxEntries);
  } catch (e) {
    throw new OwnSourceError(422, "own:unreadable", { path: dir, detail: e.code || e.message });
  }
  afterWalk?.(walked.entries);
  const entries = walked.entries;
  if (walked.over) E("tooManyEntries", { n: maxEntries });
  for (const r of walked.dirChanged) E("dirChanged", { rel: r });
  for (const e of entries) {
    if (e.symlink) E("symlink", { rel: e.rel });
    else if (e.other) E("other", { rel: e.rel });
  }
  const fileEntries = entries.filter((e) => !e.dir && !e.symlink && !e.other);
  if (fileEntries.length > LIMITS.maxFiles) E("tooMany", { n: LIMITS.maxFiles });
  const writable = writableInfo(dir, entries, uid, { acl });
  if (!writable.mine) E("notMine");
  if (writable.others.length) E("others", { list: writable.others.join(", ") });
  if (writable.acl.length) E("acl", { list: writable.acl.join(", ") });
  if (writable.parentOpen) E("parentOpen", { dir: dirname(dir) });
  const top = new Set(entries.filter((e) => !e.rel.includes("/")).map((e) => e.rel));
  if (!top.has("README.md")) E("noReadme");
  const mains = mainsIn(dir, id);
  let meta = null;
  let main = null;
  if (mains.length !== 1) E(mains.length ? "manyMains" : "noMain", { id, list: mains.join(", ") });
  const files = [];
  let total = 0;
  for (const e of fileEntries.filter((x) => inPack(x.rel))) {
    total += e.st.size;
    if (e.st.size > LIMITS.maxFileBytes) {
      E("tooBig", { rel: e.rel, n: LIMITS.maxFileBytes });
      continue;
    }
    if (total > LIMITS.maxTotalBytes) break;
    const r = readChecked(e.abs, e.st, LIMITS.maxFileBytes);
    if (r.error === "changed") E("changed", { rel: e.rel });
    else if (r.error === "too-big") E("tooBig", { rel: e.rel, n: LIMITS.maxFileBytes });
    else if (r.error) E("unreadable", { rel: e.rel, code: r.error });
    if (r.error) continue;
    files.push({ rel: e.rel, data: r.data, sha256: sha256(r.data) });
  }
  if (total > LIMITS.maxTotalBytes) E("totalBig", { n: LIMITS.maxTotalBytes });
  if (mains.length === 1) {
    main = mains[0];
    const fn = parseFileName(main);
    const f = files.find((x) => x.rel === main);
    if (!ALLOWED_EXT.has(fn.ext)) E("ext", { main, list: [...ALLOWED_EXT].join(", ") });
    if (!f) E("mainUnread", { main });
    else {
      if (f.data.subarray(0, 8192).includes(0)) E("binaryMain", { main });
      const parsed = parseMetaText(f.data.subarray(0, 64 * 1024).toString("utf8"));
      meta = parsed.meta;
      for (const w of parsed.warnings) E("meta", { w });
      // the same linter as the registry; the human approved the own plugin themselves — like official (actions allowed)
      const lint = lintPlugin({ id, meta, source: f.data.toString("utf8"), official: true, lang });
      errors.push(...lint.errors);
      warnings.push(...lint.warnings, ...pushWarnings(meta, { lang }));
    }
    if (!meta) E("noMeta", { main });
  }
  for (const f of files) {
    if (f.rel === main) continue;
    if (f.data.subarray(0, 8192).includes(0)) {
      E("binary", { rel: f.rel });
      continue;
    }
    for (const what of sourceViolations(f.data.toString("utf8"))) E("forbidden", { rel: f.rel, what });
  }
  return {
    dir,
    id,
    main,
    meta,
    perms: meta ? { ...permissionsFromMeta(meta), push: loudPushRules(meta) } : null,
    version: meta?.version || null,
    files,
    fingerprint: fingerprintOf(files),
    errors: [...new Set(errors)],
    warnings,
    writable,
  };
}

// Is the source path on disk still the same real path (not swapped for a symlink and not moved)?
export function samePath(stored) {
  try {
    return resolve(realpathSync(stored)) === resolve(stored) && !lstatSync(stored).isSymbolicLink();
  } catch {
    return false;
  }
}
