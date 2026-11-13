// The core's platform layer: everything that differs between macOS (and other POSIX systems) and Windows lives here.
// The core, server, plugin host and primitives call only these functions; paths like /usr/bin/…, process.getuid,
// POSIX process groups and ~/Library aren't written in them (test/platform.test.mjs checks this).
//
// Only macOS is live today. The win32 branch is groundwork for Windows (design: "a portable core"): transport —
// named pipe \\.\pipe\agenthub-<user>, state directory — %LOCALAPPDATA%\AgentHub, plugin process tree
// — taskkill /T, interpreters — from PATH. Peer and signature verification on Windows
// (GetNamedPipeClientProcessId, WinVerifyTrust) is a separate step together with the Windows shell; until then
// there's no peercred addon, and every client is cli (closed, not open).
// What the daemon check found on Windows and what's deferred until the shell port — docs/windows.md.
//
// platform — a parameter for tests (process.platform by default).

import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep, win32 } from "node:path";
import { msg } from "./i18n.mjs";

export const PLATFORM = process.platform;
export const isWindows = (platform = PLATFORM) => platform === "win32";

// uid of the current process; Windows has none — null ("same uid" checks there are done by the pipe ACL).
export function myUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

// The daemon state directory.
export function stateDir({ env = process.env, home = homedir(), platform = PLATFORM } = {}) {
  if (env.AGENTHUB_HOME) return resolve(env.AGENTHUB_HOME);
  if (platform === "darwin") return join(home, "Library", "Application Support", "AgentHub");
  if (isWindows(platform)) return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "AgentHub");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "agenthub");
}

// The live hub's state directory — like stateDir, but without AGENTHUB_HOME (the directory is compared with it to detect
// a test copy). LOCALAPPDATA and XDG_STATE_HOME come from the same environment: otherwise on Windows and Linux the live daemon
// with its own directory would be taken for a test copy.
export function liveStateDir({ env = process.env, home = homedir(), platform = PLATFORM } = {}) {
  const rest = { ...(env || {}) };
  delete rest.AGENTHUB_HOME;
  return stateDir({ env: rest, home, platform });
}

// The account's home directory from the user database, not $HOME (os.homedir() reads HOME). null — unknown.
export function accountHome() {
  try {
    return userInfo().homedir || null;
  } catch {
    return null;
  }
}

// Whether dir is the live hub's state directory — by $HOME (liveStateDir) or by the account's real home: the guards that
// lift test-only switches (AGENTHUB_TEST_TIER, AGENTHUB_TEST_EXTENSIONS, self-test) must not be fooled by HOME=/tmp/x with
// AGENTHUB_HOME pointing at the real live directory. liveStateDir itself keeps following HOME: install/update tests and
// tools run with a fake HOME rely on it to stay out of the real directory.
export function isLiveStateDir(dir, { env = process.env, platform = PLATFORM } = {}) {
  if (samePath(dir, liveStateDir({ env, platform }), { platform })) return true;
  const real = accountHome();
  return Boolean(real) && samePath(dir, liveStateDir({ env, home: real, platform }), { platform });
}

// Whether a path is absolute — by platform rules. Not startsWith("/"): that would silently lose real paths on Windows.
// On Windows only a drive-letter path "C:\\x" (or "C:/x"). win32.isAbsolute won't do here: it treats
// "/x" and "\\x" as absolute (from the root of the current directory's drive — chosen by cwd, where any user may
// put a file; docs/windows.md, A1/A2) and UNC "\\\\server\\share" (a network login with NTLM already on stat, A3b).
export function isAbsolutePath(p, { platform = PLATFORM } = {}) {
  if (typeof p !== "string") return false;
  return isWindows(platform) ? /^[A-Za-z]:[\\/]/.test(p) : posix.isAbsolute(p);
}

// Whether it's the same directory. On POSIX — equality of resolve(), and if both paths exist on disk — also equality of realpath:
// APFS is case-insensitive by default, and AGENTHUB_HOME="~/library/application support/agenthub" is the same live
// directory (otherwise the live hub would be taken for a test one and the "test directory only" guards would be lifted); a symlink to
// the directory is the same directory too. Windows paths ignore case, separator kind and a trailing separator — compared without
// them there. An empty path matches nothing.
export function samePath(a, b, { platform = PLATFORM } = {}) {
  if (!a || !b) return false;
  if (!isWindows(platform)) {
    if (posix.resolve(String(a)) === posix.resolve(String(b))) return true;
    if (platform !== PLATFORM) return false; // a foreign platform (tests) — wrong drive
    try {
      return realpathSync.native(String(a)) === realpathSync.native(String(b));
    } catch {
      return false;
    }
  }
  const key = (p) => win32.resolve(String(p)).replace(/\\+$/, "").toLowerCase();
  return key(a) === key(b);
}

// Transport address: a Unix socket in the state directory or a Windows named pipe (Node: the same listen(path)).
export function transportPath(home, { platform = PLATFORM, user = safeUser() } = {}) {
  if (isWindows(platform)) return `\\\\.\\pipe\\agenthub-${user}`;
  return join(home, "hub.sock");
}

function safeUser() {
  try {
    return String(userInfo().username || "user").replace(/[^\w.-]/g, "_").slice(0, 64) || "user";
  } catch {
    return "user";
  }
}

// → null (the address is fine) | error text.
export function transportProblem(p, { platform = PLATFORM } = {}) {
  if (typeof p !== "string" || !p) return msg("err.transport.empty");
  if (isWindows(platform)) return /^\\\\[.?]\\pipe\\[\w.-]{1,200}$/.test(p) ? null : msg("err.transport.pipe");
  if (!p.startsWith("/")) return msg("err.transport.unix");
  if (Buffer.byteLength(p) > 103) return msg("err.transport.long", { path: p });
  return null;
}

// Permissions on the state directory and socket are set via file mode (0700/0600) only on POSIX.
// On Windows access to the named pipe is governed by its ACL (by default — owner, SYSTEM, administrators).
export const usesFileModes = (platform = PLATFORM) => !isWindows(platform);

// PATH for plugins and primitives (like agents launched by launchd on macOS), with the platform separator.
export function standardPath({ home = homedir(), platform = PLATFORM, env = process.env } = {}) {
  if (isWindows(platform)) return env.PATH || env.Path || "";
  const dirs = platform === "darwin"
    ? [join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : [join(home, ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return dirs.join(":");
}

// Interpreter by plugin file extension. null — unknown extension.
export function interpreterFor(ext, { platform = PLATFORM } = {}) {
  if (["mjs", "js", "cjs"].includes(ext)) return [process.execPath];
  if (isWindows(platform)) {
    if (ext === "py") return ["python"];
    if (ext === "sh" || ext === "bash") return ["bash"];
    if (ext === "ps1") return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
    return null;
  }
  if (ext === "py") return ["/usr/bin/python3"];
  if (ext === "sh") return ["/bin/sh"];
  if (ext === "bash") return ["/bin/bash"];
  if (ext === "zsh") return ["/bin/zsh"];
  return null;
}

// spawn options for a process whose tree is later killed as a whole: on POSIX — its own process group
// (detached), on Windows — no separate console (windowsHide), taskkill /T removes the tree.
export function treeSpawnOptions({ platform = PLATFORM } = {}) {
  return isWindows(platform) ? { windowsHide: true } : { detached: true };
}

// Kill a process and all its descendants.
// Whether a process group still has a member we may signal (task 82): process.kill(-pgid, 0). ESRCH — the group is empty;
// EPERM — its members belong to another user, so it is not ours either. A group is only ever looked up for processes the
// daemon spawned detached (each leads its own group). Where groups can't be probed (Windows) the answer is true.
export function groupAlive(pgid, { platform = PLATFORM } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (isWindows(platform)) return true;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killTree(child, signal = "SIGKILL", { platform = PLATFORM } = {}) {
  if (!child?.pid) return;
  if (isWindows(platform)) {
    try {
      const k = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
      k.on("error", () => {
        try {
          child.kill(signal);
        } catch {}
      });
      k.unref();
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

// Process descendants (children, grandchildren, …) from the ps table: `ps -A -o pid=,ppid=`. psOutput — for tests. Windows — [].
export function descendantPids(pid, { platform = PLATFORM, psOutput = null } = {}) {
  if (isWindows(platform) || !Number.isInteger(pid) || pid <= 0) return [];
  let text = psOutput;
  if (text === null) {
    try {
      text = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return [];
    }
  }
  const kids = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pp = Number(m[2]);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(Number(m[1]));
  }
  const out = [];
  const seen = new Set([pid]);
  const stack = [pid];
  while (stack.length) {
    for (const c of kids.get(stack.pop()) || []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

// Kill a process with all descendants WITHOUT moving it into its own process group: the hub build (git, swift) stays in
// the parent's group — Ctrl-C from the installer's terminal and launchd on daemon exit reach it as before — and on
// timeout it's removed as a whole: descendants are found from the ps table (snapshotted before the first signal, while
// "parent — child" links are intact). Windows — taskkill /T. → how many processes got the signal.
export function killProcessTree(pid, signal = "SIGKILL", { platform = PLATFORM, psOutput = null, kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  if (isWindows(platform)) {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" }).on("error", () => {}).unref();
      return 1;
    } catch {
      return 0;
    }
  }
  let n = 0;
  for (const p of [pid, ...descendantPids(pid, { platform, psOutput })]) {
    try {
      kill(p, signal);
      n++;
    } catch {}
  }
  return n;
}

// Open a URL or file with the default program. → [file, ...args] for ctx.exec (no shell).
export function openCommand(target, { reveal = false, platform = PLATFORM } = {}) {
  if (platform === "darwin") return ["/usr/bin/open", ...(reveal ? ["-R"] : []), target];
  if (isWindows(platform)) return reveal ? ["explorer.exe", `/select,${target}`] : ["rundll32.exe", "url.dll,FileProtocolHandler", target];
  return ["xdg-open", target];
}

// LaunchServices redirections not visible from the extension (macOS): `open` wouldn't launch the file itself.
//   alias     — a Finder alias: the kIsAlias flag (0x8000) in com.apple.FinderInfo or bookmark data "book\0\0\0\0mark";
//               `open` would open the target — be it a .app or a .command;
//   open-with — the file has its own assigned program (xattr com.apple.LaunchServices.OpenWith);
//   bundle    — the directory has the kHasBundle flag (0x2000): LaunchServices treats it as a package.
// → null | reason. Attributes couldn't be read — throws (the caller refuses). On other OSes — null (Windows has
// its own check — docs/windows.md, A3b).
const ALIAS_MAGIC = Buffer.from("book\0\0\0\0mark", "latin1");
export function launchRedirect(real, { isDir = false, platform = PLATFORM, xattr = "/usr/bin/xattr" } = {}) {
  if (platform !== "darwin") return null;
  if (!isDir) {
    let head = Buffer.alloc(0);
    const fd = openSync(real, "r");
    try {
      const buf = Buffer.alloc(ALIAS_MAGIC.length);
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
    if (head.equals(ALIAS_MAGIC)) return "alias";
  }
  const opts = { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] };
  const names = new Set(execFileSync(xattr, [real], opts).split("\n").map((l) => l.trim()).filter(Boolean));
  if (!isDir && names.has("com.apple.LaunchServices.OpenWith")) return "open-with";
  if (names.has("com.apple.FinderInfo")) {
    const hex = execFileSync(xattr, ["-px", "com.apple.FinderInfo", real], opts).replace(/\s+/g, "");
    const flags = parseInt(hex.slice(16, 20), 16) || 0; // bytes 8–9: finderFlags (for both files and directories)
    if (!isDir && flags & 0x8000) return "alias";
    if (isDir && flags & 0x2000) return "bundle";
  }
  return null;
}

// Commands for the plugins' OS_* environment (version, theme, sleep and wake times). null — the platform doesn't provide them.
export function osInfoCommands({ platform = PLATFORM } = {}) {
  if (platform !== "darwin") return null;
  return {
    version: ["/usr/bin/sw_vers", "-productVersion"],
    appearance: ["/usr/bin/defaults", "read", "-g", "AppleInterfaceStyle"],
    wake: ["/usr/sbin/sysctl", "-n", "kern.waketime"],
    sleep: ["/usr/sbin/sysctl", "-n", "kern.sleeptime"],
  };
}

// Process table without the peercred addon: ps (POSIX). null — the platform doesn't provide it (Windows).
export function psCommand({ platform = PLATFORM } = {}) {
  return isWindows(platform) ? null : "/bin/ps";
}

// Listing with ACLs (`ls -le`): who else can write to an own plugin's folder (lib/registry/own-source.mjs). null — the
// platform has no such way (macOS ACLs; on Linux and Windows the check isn't done).
export function aclListCommand({ platform = PLATFORM } = {}) {
  return platform === "darwin" ? "/bin/ls" : null;
}

// Gracefully terminate a process (SIGTERM; on Windows — taskkill without /F, the process gets WM_CLOSE).
export function terminateCommand(pid, { platform = PLATFORM } = {}) {
  if (isWindows(platform)) return ["taskkill", "/PID", String(pid)];
  return ["/bin/kill", "-TERM", String(pid)];
}

// git for hub updates (lib/hub-update): on macOS — /usr/bin/git (the Command Line Tools shim, keychain
// as the credential helper), otherwise — from PATH.
export function gitCommand({ platform = PLATFORM } = {}) {
  return platform === "darwin" ? "/usr/bin/git" : "git";
}

// A process that must outlive the daemon's exit (the hub update watchdog): its own process group — launchd kills
// the job's group when the daemon exits. On Windows no separate console is needed, just no window.
export function detachedSpawnOptions({ platform = PLATFORM } = {}) {
  return isWindows(platform) ? { detached: true, windowsHide: true } : { detached: true };
}

// A command that prints the OS preferred languages (the first is primary), or null: then the language comes from Intl (lib/i18n.mjs).
export function systemLanguagesCommand({ platform = PLATFORM } = {}) {
  if (platform === "darwin") return ["/usr/bin/defaults", "read", "-g", "AppleLanguages"];
  return null;
}

// ---------- app: launching and finding the process (app service, lib/app-supervisor.mjs) ----------

// Launch the app by bundle path: macOS — `open -g <path>` (no shell; LaunchServices doesn't duplicate an already running
// one, -g — don't bring it to the front). null — the platform can't do this (there's no Windows shell yet).
export function appLaunchCommand(bundlePath, { platform = PLATFORM } = {}) {
  if (platform === "darwin") return ["/usr/bin/open", "-g", bundlePath];
  return null;
}

// Table of own processes: pid and `comm`. On macOS ps `comm` is argv[0] (anyone can fake it: `exec -a`),
// not the executable path, so these are only candidates: proc_pidpath confirms the path (appControl, pidPath).
export function processListCommand({ platform = PLATFORM } = {}) {
  if (isWindows(platform)) return null;
  return ["/bin/ps", "-x", "-o", "pid=,comm="];
}

// Output of processListCommand (and of the double's file in tests) → [{pid, path}]. Line: "<pid> <path>", the path runs to the end
// of the line (it may contain spaces: "Application Support").
export function parseProcessList(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), path: m[2] });
  }
  return out;
}

// The bundle's executables directory: the app process is the one whose executable lives directly in it.
export function appExecutableDir(bundlePath, { platform = PLATFORM } = {}) {
  if (platform === "darwin") return join(bundlePath, "Contents", "MacOS") + sep;
  return null;
}

// Bundle from a process executable path (…/X.app/Contents/MacOS/X → …/X.app); null — not from a bundle.
export function bundleOfExecutable(exePath, { platform = PLATFORM } = {}) {
  if (platform !== "darwin" || typeof exePath !== "string") return null;
  const m = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath);
  return m ? m[1] : null;
}

function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Whether an app bundle path is fit for the daemon to launch (app service) and to pin (pin-app).
// → null | "path-missing" (no such bundle) | "path-unsafe" (the bundle or a directory above it isn't ours or is
// group/world-writable: an outsider could swap the build there) | "unsupported" (the platform doesn't know bundles).
// The path as is; its realpath is checked. allowSticky — don't treat sticky-bit directories (/tmp) as open:
// test mode only, where test benches live in a temporary directory.
export function appBundleProblem(bundlePath, { platform = PLATFORM, testMode = false, uid = myUid(), allowSticky = testMode } = {}) {
  if (platform !== "darwin" && !testMode) return "unsupported";
  if (typeof bundlePath !== "string" || !isAbsolute(bundlePath) || !/\.app$/.test(bundlePath)) return "path-missing";
  let real;
  try {
    real = realpathSync(bundlePath);
    if (!lstatSync(real).isDirectory()) return "path-missing";
  } catch {
    return "path-missing";
  }
  if (!usesFileModes(platform) || uid === null) return null;
  for (let p = real, first = true; ; first = false) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return "path-unsafe";
    }
    if (st.uid !== uid && st.uid !== 0) return "path-unsafe";
    if ((st.mode & 0o022) !== 0 && !(allowSticky && !first && (st.mode & 0o1000) !== 0)) return "path-unsafe";
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return null;
}

// Verifying the bundle signature on disk against a requirement (the same requirement the daemon checks for a process): macOS — codesign.
export function bundleVerifyCommand(bundlePath, requirement, { platform = PLATFORM } = {}) {
  if (platform !== "darwin") return null;
  return ["/usr/bin/codesign", "--verify", "--strict", "-R", "=" + requirement, bundlePath];
}

function run(argv, timeoutMs) {
  return new Promise((done) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      done({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout ?? ""), timedOut: Boolean(err?.killed) });
    });
  });
}

// Platform adapter for the app service: find the app process, launch the app, verify the bundle signature.
// In test mode (testMode) the real app is never launched: only the double's command
// test.launch (argv without a shell, the bundle path as the last argument); without it the launch is skipped. The process
// table in tests may be replaced by the file test.processes (lines "<pid> <path>", as from ps).
// pidPath(pid) → the process executable path (proc_pidpath, peercred addon): `comm` from ps is only a candidate,
// a process is recognized as our app only if its real executable lives in the bundle (by realpath).
export function appControl({ platform = PLATFORM, testMode = false, test = {}, runner = run, pidPath = null } = {}) {
  const testLaunch = Array.isArray(test?.launch) && test.launch.length && test.launch.every((a) => typeof a === "string" && a) ? test.launch : null;
  const testProcesses = typeof test?.processes === "string" && test.processes ? test.processes : null;
  return {
    // who can launch something: outside test mode — the platform, in it — only the double
    supported: testMode ? Boolean(testLaunch) : Boolean(appLaunchCommand("/x", { platform })),
    // pids of processes whose executable is inside <bundle>/Contents/MacOS/. null — the check failed.
    async processes(bundlePath) {
      const dir = appExecutableDir(bundlePath, { platform }) ?? (testMode ? join(bundlePath, "Contents", "MacOS") + sep : null);
      if (!dir) return null;
      let text;
      if (testMode && testProcesses) {
        try {
          text = readFileSync(testProcesses, "utf8");
        } catch {
          text = "";
        }
      } else {
        const cmd = processListCommand({ platform });
        if (!cmd) return null;
        const r = await runner(cmd, 5000);
        if (r.code !== 0) return null;
        text = r.stdout;
      }
      const inDir = (path, d) => typeof path === "string" && path.startsWith(d) && !path.slice(d.length).includes(sep);
      const realDir = appExecutableDir(realOr(bundlePath), { platform }) ?? (testMode ? join(realOr(bundlePath), "Contents", "MacOS") + sep : dir);
      const cands = parseProcessList(text).filter((p) => inDir(p.path, dir) || inDir(p.path, realDir));
      // the double's table is the test bench's ground truth; otherwise proc_pidpath confirms the path
      if ((testMode && testProcesses) || typeof pidPath !== "function") return cands.map((p) => p.pid);
      return cands.filter((p) => inDir(pidPath(p.pid), realDir)).map((p) => p.pid);
    },
    // → {ok, code?, skipped?}
    async launch(bundlePath) {
      if (testMode) {
        if (!testLaunch) return { ok: false, skipped: "test-mode" };
        const r = await runner([...testLaunch, bundlePath], 10_000);
        return { ok: r.code === 0, code: r.code };
      }
      const cmd = appLaunchCommand(bundlePath, { platform });
      if (!cmd) return { ok: false, skipped: "unsupported" };
      const r = await runner(cmd, 15_000);
      return { ok: r.code === 0, code: r.code };
    },
    // → true | false | null (nothing to check with). In test mode — no check (the double isn't signed).
    async verify(bundlePath, requirement) {
      if (testMode) return true;
      const cmd = bundleVerifyCommand(bundlePath, requirement, { platform });
      if (!cmd) return null;
      const r = await runner(cmd, 15_000);
      if (r.code === 0) return true;
      if (!r.timedOut && (r.code === 1 || r.code === 3)) return false;
      return null;
    },
  };
}
