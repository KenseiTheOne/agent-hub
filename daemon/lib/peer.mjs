// Verifying the peer on the socket and the authenticity of processes.
//
// On accept we determine the client class once and bind it to the connection:
//   app    — an executable inside AgentHub.app whose signature passes requirements.app (by default — the cdhash
//            of the pinned build, lib/app-pin.mjs; or a certificate); a diagnostic launch with --probe-action
//            (present only in a debug build) does not count as app;
//   hook   — agenthub-hook (path from peer.hookPaths), and among its ancestors (up to 4 levels by ppid) there is a process
//            whose signature passes requirements.claudeCode; the pid of that Claude is remembered;
//   bridge — the bridge process: a script from peer.bridgePaths run directly by an interpreter, the file itself inside the
//            hub's own tree and writable by this user only (bridgeCandidate below — and what this does NOT prove);
//   cli    — everything else (read-only and "immediate"-level actions).
// Requirement strings live in the daemon config (requirements.*), not in code.
//
// The signature is checked on the running process, not on the file on disk:
//   - the kernel (csops, the peercred addon: codeInfo) returns the process cdhash, flags, identifier and Team ID — they cannot be
//     spoofed by writing to a file, and they are available even if auto-update has already deleted the version's file;
//   - `codesign --verify --strict -R=<requirement> <pid>` checks the process itself; the verdict is cached by the cdhash
//     from the kernel (another binary — another cdhash — a new check);
//   - the version's file is gone (auto-update deleted it), but the same cdhash has already passed the requirement — the process
//     is recognized by cdhash (journal: verified-by=cdhash). The list of verified cdhashes — <home>/verified-code.json.
// No addon (doubles in tests) — the old path: codesign on the file, cache by (realpath, dev:ino, mtime,
// ctime, birthtime, size).
// A failure of the check itself (timeout, EAGAIN, ENOENT from codesign) is not cached: the next request checks again.
//
// requirements.app changes on the fly (build re-pin): forget("app") drops the app verdicts and bumps the
// generation — an app classification result carries appGen, and the server reclassifies a connection whose generation
// is stale. beforeAppCheck is called before every app check (re-read config.json if it changed).
//
// Known limitation (see docs/api.md): the pid check does not protect against passing an fd between processes or against
// an attacker under the same UID who rewrites config.json and the daemon code (or signs their own binary
// with the same key).

import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { expandHome, RUN_DIRS } from "./config.mjs";
import { loadNative } from "./native.mjs";
import { myUid, psCommand } from "./platform.mjs";

const CS_VALID = 0x1;
const CS_ADHOC = 0x2;

// → { ok, definite }. definite=false — a failure of the check itself (timeout, launch error); such results are not cached.
// target — a file path or a pid (as a string): codesign with a pid checks the running process.
function codesignVerify(target, requirement) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/codesign",
      ["--verify", "--strict", "-R", "=" + requirement, String(target)],
      { timeout: 15_000 },
      (err, _out, stderr) => {
        if (!err) return resolve({ ok: true, definite: true });
        // 1 — the signature failed (or no file), 3 — the requirement is not satisfied; anything else — a check failure
        if (!err.killed && (err.code === 1 || err.code === 3)) {
          return resolve({ ok: false, definite: true, missing: err.code === 1 && /No such file/i.test(String(stderr || "")) });
        }
        resolve({ ok: false, definite: false });
      },
    );
  });
}

function fileId(path) {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    // the user cannot set ctime and birthtime: any write or chmod changes ctime
    return `${real}|${st.dev}:${st.ino}|${st.mtimeMs}|${st.ctimeMs}|${st.birthtimeMs}|${st.size}`;
  } catch {
    return null;
  }
}

// A codesign double's answer may be plain true/false — that is a final verdict.
function verdict(r) {
  if (typeof r === "boolean") return { ok: r, definite: true };
  return { ok: Boolean(r?.ok), definite: r?.definite !== false, missing: Boolean(r?.missing) };
}

// identifier and Team ID from the requirement string — for recognizing a process by cdhash when the file is gone.
export function requirementIdentity(requirement) {
  const id = /\bidentifier\s+"([^"]+)"/.exec(requirement || "")?.[1] ?? null;
  const team = /leaf\[subject\.OU\]\s*=\s*"?([A-Z0-9]{10})"?/.exec(requirement || "")?.[1] ?? null;
  return { id, team };
}

// argv flags with which Claude Code runs without a human (background `claude -p`, SDK).
export function isPrintArgv(argv) {
  return (argv || []).slice(1).some((a) => {
    if (typeof a !== "string") return false;
    if (a === "--") return false;
    if (a === "-p" || a === "--print") return true;
    if (/^--(print|output-format|input-format)(=|$)/.test(a)) return true;
    return /^-[A-Za-z]*p[A-Za-z]*$/.test(a) && !a.startsWith("--");
  });
}

export const PEER_CLASSES = ["app", "hook", "bridge", "cli"];

// Keys of diagnostic shell launches (the same list as QuitPolicy.isDiagnostic in
// app/Sources/AgentHubKit/DaemonLifecycle.swift): such a process exits on its own, the daemon supervision does not see it.
export const APP_DIAGNOSTIC_ARGS = new Set([
  "--probe-peer",
  "--quit-after-snapshot",
  "--snapshot-panel",
  "--snapshot-menubar",
  "--print-status-item",
  "--show-popover",
  "--snapshot-popover",
  "--snapshot-consent",
  "--snapshot-report",
  "--snapshot-confirm",
  "--self-test-popover",
  "--self-test-status-menu",
]);

// What is wrong with a script file as the identity of a peer class (the bridge): → null | a short reason.
// real — the script's realpath; roots — the realpaths of the hub's own trees. The file must be inside one of them, a regular
// file owned by this user (or root) that nobody else can write, and so must every directory from it up to the tree's root:
// otherwise another account could put its own code where the daemon expects the hub's. Owner and mode bits mean nothing on
// Windows — there only the location is checked.
export function scriptProblem(real, roots, uid = myUid()) {
  const root = (roots || []).find((r) => typeof r === "string" && r && real.startsWith(r.endsWith(sep) ? r : r + sep));
  if (!root) return "outside-tree";
  const posix = process.platform !== "win32";
  const foreign = (st) => posix && st.uid !== uid && st.uid !== 0;
  const open = (st) => posix && (st.mode & 0o022) !== 0;
  try {
    const st = lstatSync(real);
    if (!st.isFile()) return "not-a-file";
    if (foreign(st)) return "owner";
    if (open(st)) return "writable";
    const top = root.endsWith(sep) ? root.slice(0, -1) : root;
    for (let d = dirname(real); d.length >= top.length; d = dirname(d)) {
      const ds = statSync(d);
      if (foreign(ds)) return "dir-owner";
      if (open(ds)) return "dir-writable";
      if (d === top || dirname(d) === d) break;
    }
  } catch {
    return "stat";
  }
  return null;
}

// The hub's own trees (the version this daemon runs from, and the install's Versions/current), resolved.
function hubTrees() {
  return [...new Set(RUN_DIRS.map((d) => realOr(d)))];
}

// System functions; replaced by doubles in tests.
export function defaultSys() {
  const n = loadNative();
  return {
    available: Boolean(n),
    peerPid: (fd) => n?.peerPid(fd) ?? null,
    peerUid: (fd) => n?.peerUid(fd) ?? null,
    pidPath: (pid) => n?.pidPath(pid) ?? null,
    pidInfo: (pid) => n?.pidInfo(pid) ?? null,
    procArgv: (pid) => n?.procArgv(pid) ?? null,
    codeInfo: n?.codeInfo ? (pid) => n.codeInfo(pid) ?? null : null,
    codesignVerify,
    fileId,
    myUid,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
    writeJson: (p, v) => writeFileSync(p, JSON.stringify(v) + "\n", { mode: 0o600 }),
    procState,
    ttyName,
    scriptProblem: (real) => scriptProblem(real, hubTrees()),
  };
}

// ps for one process, synchronously and not. The synchronous functions (ttyName, procState) stay for callers that cannot
// await — the facts and ctx methods an extension calls synchronously (facts.processTty, ctx.peer.procState). The hub's own
// request paths (the terminal service and the built-in adapters) use the asynchronous twins: a ps run does not stop the
// event loop.
const psSync = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
const psAsync = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { encoding: "utf8", timeout: 3000 }, (e, out) => (e ? reject(e) : resolve(out))));
const ttyFrom = (out) => {
  const v = String(out).trim();
  return /^tty[A-Za-z0-9]{1,12}$/.test(v) ? v : null;
};
const stateFrom = (out) => {
  const v = String(out).trim();
  if (!/^[A-Za-z<>+]{1,8}$/.test(v)) return null;
  return { stopped: v.includes("T"), foreground: v.includes("+") };
};

// The controlling terminal of a process ("ttys004") — for the terminal layer, which finds a session's tab by it (tmux,
// iTerm2, Terminal.app). Asked only when an operation runs. → string | null (no process, no terminal, no ps).
export function ttyName(pid, { exec = psSync } = {}) {
  const ps = psCommand();
  if (!ps || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    return ttyFrom(exec(ps, ["-o", "tty=", "-p", String(pid)]));
  } catch {
    return null;
  }
}
// → Promise<string | null>; never rejects.
export async function ttyNameAsync(pid, { exec = psAsync } = {}) {
  const ps = psCommand();
  if (!ps || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    return ttyFrom(await exec(ps, ["-o", "tty=", "-p", String(pid)]));
  } catch {
    return null;
  }
}

// Process state for typing into a tab (contract 3): whether it is stopped (Ctrl+Z, "T") and in the foreground group
// of its terminal ("+" in ps STAT: pgid == tpgid). → { stopped, foreground } | null (no process, or no ps on the platform).
export function procState(pid, { exec = psSync } = {}) {
  const ps = psCommand();
  if (!ps || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    return stateFrom(exec(ps, ["-o", "stat=", "-p", String(pid)]));
  } catch {
    return null;
  }
}
// → Promise<{ stopped, foreground } | null>; never rejects.
export async function procStateAsync(pid, { exec = psAsync } = {}) {
  const ps = psCommand();
  if (!ps || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    return stateFrom(await exec(ps, ["-o", "stat=", "-p", String(pid)]));
  } catch {
    return null;
  }
}

// The asynchronous answer of a set of system functions (sys): its own async function if it has one; the real ps twin
// when sys carries the real synchronous function; otherwise the synchronous function it carries (a double in tests).
// → Promise<value | null>; never rejects.
const SYS_ASYNC = { ttyName: [ttyName, ttyNameAsync], procState: [procState, procStateAsync] };
export async function sysAsync(sys, name, pid) {
  const [sync, twin] = SYS_ASYNC[name] || [];
  try {
    const own = sys?.[`${name}Async`];
    if (typeof own === "function") return (await own(pid)) ?? null;
    if (twin && sys?.[name] === sync) return await twin(pid);
    return sys?.[name]?.(pid) ?? null;
  } catch {
    return null;
  }
}

function globRe(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
      if (pattern[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function createPeer({ config, sys = defaultSys() } = {}) {
  const pidCache = new Map(); // `${req}|${requirement}|${pid}|${start}|${path}` → result (final ones only)
  const fileCache = new Map(); // `${req}|${fileId}` → Promise<verdict>
  const codeCache = new Map(); // `${req}|${requirement}|${cdhash}` → Promise<verdict>
  const peerCfg = config.peer || {};
  const hookRes = (peerCfg.hookPaths || []).map((p) => globRe(expandHome(p)));
  const bridgeRes = (peerCfg.bridgePaths || []).map((p) => globRe(expandHome(p)));
  // entries without wildcards: the directory part is resolved (an install lists Versions/current/…), the file name is not
  const bridgeLiterals = (peerCfg.bridgePaths || []).map((p) => expandHome(p)).filter((p) => !/[*?]/.test(p));
  const interpreters = new Set(peerCfg.interpreters || []);
  const depth = peerCfg.hookAncestorDepth ?? 4;
  const appMarker = `${sep}${peerCfg.appBundleName || "AgentHub.app"}${sep}Contents${sep}MacOS${sep}`;
  const knownFile = peerCfg.knownCodeFile ?? (config.paths?.home ? join(config.paths.home, "verified-code.json") : null);
  let known = null; // `${reqSha}|${cdhash}` → { identity, teamId, at }
  const generations = new Map(); // requirementName → generation (grows when the requirement changes)
  let beforeAppCheck = null;

  // The requirement changed: verdicts for the old one are no longer valid.
  function forget(requirementName) {
    for (const m of [pidCache, fileCache, codeCache]) for (const k of [...m.keys()]) if (k.startsWith(`${requirementName}|`)) m.delete(k);
    generations.set(requirementName, (generations.get(requirementName) || 0) + 1);
  }
  const generation = (requirementName) => generations.get(requirementName) || 0;

  function trim(map, max = 2000) {
    if (map.size > max) for (const k of [...map.keys()].slice(0, map.size - max)) map.delete(k);
  }

  const reqSha = (requirement) => createHash("sha256").update(requirement).digest("hex").slice(0, 16);
  function loadKnown() {
    if (known) return known;
    known = new Map();
    if (!knownFile) return known;
    try {
      const data = sys.readJson(knownFile);
      for (const e of Array.isArray(data?.entries) ? data.entries : []) {
        if (typeof e?.key === "string" && /^[0-9a-f]{16}\|[0-9a-f]{40,64}$/.test(e.key)) known.set(e.key, { identity: e.identity ?? null, teamId: e.teamId ?? null, at: e.at ?? null });
      }
    } catch {}
    return known;
  }
  function rememberCode(requirement, code) {
    const m = loadKnown();
    const key = `${reqSha(requirement)}|${code.cdhash}`;
    if (m.has(key)) return;
    m.set(key, { identity: code.identity ?? null, teamId: code.teamId ?? null, at: new Date().toISOString() });
    trim(m, 200);
    if (!knownFile || !sys.writeJson) return;
    try {
      sys.writeJson(knownFile, { entries: [...m].map(([key, v]) => ({ key, ...v })) });
    } catch {}
  }
  // The file is gone, but this cdhash has already passed the requirement: the kernel confirms that the process runs exactly that code
  // (CS_VALID), not ad hoc, with the same identifier and Team ID.
  function knownGood(requirement, code) {
    if (!(code.flags & CS_VALID) || code.flags & CS_ADHOC) return false;
    const want = requirementIdentity(requirement);
    if (!want.id || !want.team) return false;
    if (code.identity !== want.id || code.teamId !== want.team) return false;
    const e = loadKnown().get(`${reqSha(requirement)}|${code.cdhash}`);
    return Boolean(e && e.identity === code.identity && e.teamId === code.teamId);
  }

  // → { ok, pid, path, startSec?, reason?, by? }
  async function verifySigned(pid, requirementName) {
    const requirement = config.requirements?.[requirementName];
    if (!requirement) return { ok: false, pid, reason: "no-requirement" };
    if (!Number.isInteger(pid) || pid <= 0) return { ok: false, pid, reason: "bad-pid" };
    const info = sys.pidInfo(pid);
    // Without the peercred addon (Linux, macOS without scripts/build-native.sh) there is no process info at all: null does not mean
    // the process has exited.
    if (!info) return { ok: false, pid, reason: sys.available ? "no-process" : "no-peercred" };
    if (info.uid !== sys.myUid()) return { ok: false, pid, reason: "foreign-uid" };
    const path = sys.pidPath(pid);
    const code = sys.codeInfo ? sys.codeInfo(pid) : null;
    if (code && typeof code.cdhash === "string") return verifyByCode(pid, info, path, code, requirementName, requirement);
    if (!path) return { ok: false, pid, reason: "no-path" };
    const key = `${requirementName}|${requirement}|${pid}|${info.startSec}.${info.startUsec}|${path}`;
    if (pidCache.has(key)) return pidCache.get(key);
    const fid = sys.fileId(path);
    if (!fid) return { ok: false, pid, path, reason: "no-file" };
    const fkey = `${requirementName}|${requirement}|${fid}`;
    let p = fileCache.get(fkey);
    if (!p) {
      p = Promise.resolve(sys.codesignVerify(path, requirement)).then(verdict, () => ({ ok: false, definite: false }));
      fileCache.set(fkey, p);
      trim(fileCache);
    }
    const v = await p;
    if (!v.definite) {
      if (fileCache.get(fkey) === p) fileCache.delete(fkey);
      return { ok: false, pid, path, reason: "verify-error" };
    }
    const res = v.ok ? { ok: true, pid, path, startSec: info.startSec } : { ok: false, pid, path, reason: "signature" };
    pidCache.set(key, res);
    trim(pidCache);
    return res;
  }

  async function verifyByCode(pid, info, path, code, requirementName, requirement) {
    if (!(code.flags & CS_VALID)) return { ok: false, pid, path, reason: "signature" };
    // For the app the key is the cdhash AND this process (pid + start time): `codesign --verify --strict <pid>` also checks
    // the bundle seal on disk (Info.plist, resources), and a copy with the same cdhash may have a different one. A cache by
    // cdhash alone would give a copy with a modified Info.plist the verdict of the genuine build that connected first.
    // Claude Code is a bare Mach-O without a bundle: the cdhash covers everything, and the cache by it is one per version (codesign ~1 s).
    const proc = requirementName === "app" ? `|${pid}|${info.startSec}.${info.startUsec}` : "";
    const ckey = `${requirementName}|${requirement}|${code.cdhash}${proc}`;
    let p = codeCache.get(ckey);
    if (!p) {
      p = Promise.resolve(sys.codesignVerify(pid, requirement)).then(verdict, () => ({ ok: false, definite: false }));
      codeCache.set(ckey, p);
      trim(codeCache);
    }
    const v = await p;
    // the process may have changed during the check (pid reused) — compare the start time
    const after = sys.pidInfo(pid);
    if (!after || after.startSec !== info.startSec || after.startUsec !== info.startUsec) return { ok: false, pid, path, reason: "no-process" };
    if (v.ok) {
      rememberCode(requirement, code);
      return { ok: true, pid, path, startSec: info.startSec, by: "process" };
    }
    // the version's file is gone or the check failed — such a verdict is not kept
    if (!v.definite || v.missing || !path) {
      if (codeCache.get(ckey) === p) codeCache.delete(ckey);
      if (knownGood(requirement, code)) return { ok: true, pid, path, startSec: info.startSec, by: "cdhash" };
      if (!path || v.missing) return { ok: false, pid, path, reason: path ? "no-file" : "no-path" };
      return { ok: false, pid, path, reason: "verify-error" };
    }
    return { ok: false, pid, path, reason: "signature" };
  }

  // The Claude Code process was started by a human: it has a controlling terminal and argv has no -p/--print/--output-format.
  // These properties are set at launch and cannot be faked by an agent from inside the session (unlike the files
  // ~/.claude/sessions/<pid>.json). → { ok, reason? }
  function interactiveProcess(pid) {
    const info = sys.pidInfo(pid);
    if (!info) return { ok: false, reason: sys.available ? "no-process" : "no-peercred" };
    if (info.tty !== true) return { ok: false, reason: "no-tty" };
    const argv = sys.procArgv(pid);
    if (!Array.isArray(argv) || !argv.length) return { ok: false, reason: "no-argv" };
    if (isPrintArgv(argv)) return { ok: false, reason: "print" };
    return { ok: true };
  }

  // The script the process runs: the executable itself or the interpreter's argv[1].
  function scriptOf(pid, exePath) {
    const cands = [exePath];
    if (interpreters.has(basename(exePath))) {
      const argv = sys.procArgv(pid) || [];
      const script = argv.slice(1).find((a) => !a.startsWith("-"));
      if (script && isAbsolute(script)) cands.push(script, realOr(script));
    }
    return cands;
  }

  // Is this process the bridge? → null (does not even look like one) | { ok: true } | { ok: false, reason, detail }.
  //
  // The app class rests on a code signature the kernel vouches for. A script has none: the kernel only says which
  // interpreter runs, and what the interpreter was told to run is the process's own argv. So this is the most that can be
  // checked from outside, and each rule closes one cheap way of posing as the bridge:
  //   - the script is the interpreter's first argument (argv[1]): `node --require other.js <bridge>`, `--import`, `--eval=`
  //     run someone else's code under the bridge's name — peer:bridge-launch;
  //   - only the script's realpath counts, and it must be one of peer.bridgePaths: a symlink with the bridge's name that
  //     leads elsewhere is not the bridge — peer:bridge-file;
  //   - that file is inside the hub's own tree, whatever config.json lists in peer.bridgePaths, is a regular file of this
  //     user (or root) and neither it nor the directories above it up to the tree's root are writable by anyone else
  //     (sys.scriptProblem; test doubles without it skip this part) — peer:bridge-file.
  // What stays open (v1, the same limit as the app pin, lib/app-pin.mjs): a process of the same user can edit the bridge
  // file in the hub's tree, preload code through the interpreter's environment (NODE_OPTIONS), or rewrite its own argv after
  // start. The class is a convention between the user's own processes, not a wall; what it gives is narrow — the
  // /bridge/* routes only, and only while no other bridge is connected (bridge:busy).
  function bridgeCandidate(pid, exePath) {
    const named = (p) => bridgeRes.some((re) => re.test(p));
    // the resolved file is one the config lists (a literal entry may itself go through a directory link)
    const listed = (real) => named(real) || bridgeLiterals.some((p) => join(realOr(dirname(p)), basename(p)) === real);
    let script = null;
    let direct = true;
    if (interpreters.has(basename(exePath))) {
      const argv = sys.procArgv(pid) || [];
      const first = argv.slice(1).find((a) => typeof a === "string" && !a.startsWith("-"));
      if (first && isAbsolute(first) && (named(first) || listed(realOr(first)))) {
        script = first;
        direct = argv[1] === first;
      }
    }
    if (!script && named(exePath)) script = exePath;
    if (!script) return null;
    if (!direct) return { ok: false, reason: "peer:bridge-launch", detail: "interpreter-options" };
    const real = realOr(script);
    if (!listed(real)) return { ok: false, reason: "peer:bridge-file", detail: "symlink" };
    const problem = typeof sys.scriptProblem === "function" ? sys.scriptProblem(real) : null;
    if (problem) return { ok: false, reason: "peer:bridge-file", detail: problem };
    return { ok: true };
  }

  async function findClaudeAncestor(pid) {
    let cur = sys.pidInfo(pid);
    for (let i = 0; i < depth && cur; i++) {
      const ppid = cur.ppid;
      if (!ppid || ppid <= 1) return null;
      const r = await verifySigned(ppid, "claudeCode");
      if (r.ok) return ppid;
      cur = sys.pidInfo(ppid);
    }
    return null;
  }

  // Peer class by the fd of the accepted connection.
  async function classifyFd(fd) {
    if (!sys.available || !Number.isInteger(fd) || fd < 0) return { class: "cli", reason: "peer:no-peercred" };
    const pid = sys.peerPid(fd);
    const uid = sys.peerUid(fd);
    if (uid !== null && uid !== sys.myUid()) return { class: "foreign", pid, uid, reason: "peer:uid" };
    if (!pid) return { class: "cli", reason: "peer:no-pid" };
    return classifyPid(pid);
  }

  async function classifyPid(pid) {
    const info = sys.pidInfo(pid);
    const path = sys.pidPath(pid);
    const base = { pid, path, startSec: info?.startSec ?? null };
    if (!info || !path) return { ...base, class: "cli", reason: "peer:no-process" };
    if (info.uid !== sys.myUid()) return { ...base, class: "foreign", reason: "peer:uid" };
    if (path.includes(appMarker)) {
      const argv = sys.procArgv(pid) || [];
      // The diagnostic actions mode exists only in a debug build; if it is in argv anyway — not app.
      if (argv.some((a) => typeof a === "string" && a.startsWith("--probe-action"))) {
        return { ...base, class: "cli", reason: "peer:app-probe" };
      }
      // A diagnostic launch (--probe-peer, snapshots, self-checks) is class app, but the app supervision does not
      // see it: such a process exits on its own, and its exit is not a crash (nor "a human opened the app").
      if (argv.some((a) => typeof a === "string" && APP_DIAGNOSTIC_ARGS.has(a))) base.diagnostic = true;
      try {
        beforeAppCheck?.();
      } catch {}
      // generation before the check: if the requirement changes during codesign, the server will recheck the connection
      const appGen = generation("app");
      const r = await verifySigned(pid, "app");
      if (r.ok) return { ...base, class: "app", appGen };
      return { ...base, class: "cli", appGen, reason: r.reason === "no-requirement" ? "peer:app-requirement-missing" : "peer:app-signature" };
    }
    const scripts = scriptOf(pid, path);
    if (scripts.some((s) => hookRes.some((re) => re.test(s)))) {
      const claudePid = await findClaudeAncestor(pid);
      if (claudePid) return { ...base, class: "hook", claudePid };
      return { ...base, class: "cli", reason: "peer:no-claude-ancestor", hookCandidate: true };
    }
    const bridge = bridgeCandidate(pid, path);
    if (bridge) return bridge.ok ? { ...base, class: "bridge" } : { ...base, class: "cli", reason: bridge.reason, detail: bridge.detail };
    return { ...base, class: "cli" };
  }

  async function classify(socket) {
    return classifyFd(socket?._handle?.fd);
  }

  // the hook's session_id must match the sessionId from ~/.claude/sessions/<Claude pid>.json
  function verifyHookSession(peer, sessionId) {
    if (peer?.class !== "hook" || !peer.claudePid) return { ok: false, reason: "peer:not-hook" };
    let data;
    try {
      data = sys.readJson(join(config.claudeHome, "sessions", `${peer.claudePid}.json`));
    } catch {
      return { ok: false, reason: "peer:no-session-file" };
    }
    if (typeof sessionId !== "string" || !sessionId || data?.sessionId !== sessionId) {
      return { ok: false, reason: "peer:session-mismatch" };
    }
    if (data.pid !== undefined && data.pid !== peer.claudePid) return { ok: false, reason: "peer:session-mismatch" };
    return { ok: true };
  }

  return {
    classify,
    classifyFd,
    classifyPid,
    verifySigned,
    findClaudeAncestor,
    verifyHookSession,
    interactiveProcess,
    forget,
    appGeneration: () => generation("app"),
    setBeforeAppCheck: (fn) => {
      beforeAppCheck = typeof fn === "function" ? fn : null;
    },
    sys,
  };
}
