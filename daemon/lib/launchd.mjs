// The daemon's LaunchAgent: plist generation and install commands.
// `agenthub install` without --apply only writes the plist to <repo>/launchd/ and prints what it would do.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_DIR, REPO_DIR, pathsFor, standardPath } from "./config.mjs";
import { liveStateDir, myUid } from "./platform.mjs";
import { msg } from "./i18n.mjs";

export const LABEL = "com.kensei.agenthub";

// launchd exists only on macOS; on other platforms install/uninstall don't set up autostart (only --no-launchd).
// AGENTHUB_TEST_NO_LAUNCHD=1 — CLI tests check the behavior of a platform without launchd on a Mac.
export const hasLaunchd = (platform = process.platform, env = process.env) => platform === "darwin" && env.AGENTHUB_TEST_NO_LAUNCHD !== "1";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ProcessType=Standard, not Background: Background enables darwinbg (disk throttling, low CPU priority,
// timer coalescing) for all descendants too — plugins, codesign, ps — while the daemon serves interactive
// paths: replying to the PermissionRequest hook while the human waits, the shell's SSE, confirmations.
//
// KeepAlive is {SuccessfulExit: false}, not true (decision 2026-11-06): launchd still restarts the daemon after a crash (code ≠ 0, signal),
// but not after a normal exit with code 0. The daemon exits normally when the pinned
// app closes (POST /shutdown) or on SIGTERM. It's started again by RunAtLoad at login or
// by the app itself on launch (`launchctl kickstart gui/<uid>/com.kensei.agenthub`).
//
// launchd doesn't create directories for StandardOutPath/StandardErrorPath: without the logs directory the job won't start
// (last exit code 78), so `agenthub install --apply` creates it before bootstrap (stateDirs).

// Directories that must exist before bootstrap: state (0700) and logs from the plist (0700).
export function stateDirs(stateDir = liveStateDir()) {
  const p = pathsFor(stateDir);
  return { home: p.home, logs: p.logs, socket: p.socket };
}

// Where launchd starts the daemon from. If the hub has been moved to a standalone installation (<home>/Versions/current exists,
// docs/hub-updates.md) — via the Versions/current pointer: an update switches the symlink, the plist doesn't change, and
// the developer's working folder doesn't affect the live hub. Otherwise — as before, from this repository.
export function daemonLocation(stateDir = liveStateDir()) {
  const current = join(stateDir, "Versions", "current");
  if (existsSync(join(current, "src", "daemon", "bin", "agenthubd"))) {
    return { installed: true, daemon: join(current, "src", "daemon", "bin", "agenthubd"), workDir: join(current, "src") };
  }
  return { installed: false, daemon: join(DAEMON_DIR, "bin", "agenthubd"), workDir: REPO_DIR };
}

// The hub's minimum node (same as the installer scripts/install.sh, MIN_NODE).
export const MIN_NODE_MAJOR = 22;

// Whether node is fit for the daemon: version ≥ MIN_NODE_MAJOR and headers alongside (include/node/node_api.h — used by
// build-native.sh to build the addon, and the update builder builds and verifies the new version with this same node).
// The answer is cached per process. → { ok, version }
const nodeProbeCache = new Map();
export function probeNode(path) {
  if (nodeProbeCache.has(path)) return nodeProbeCache.get(path);
  let res = { ok: false, version: null };
  try {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const r = spawnSync(path, ["-p", "JSON.stringify([process.versions.node, require('fs').existsSync(require('path').resolve(process.execPath, '../../include/node/node_api.h'))])"], { encoding: "utf8", env, timeout: 10_000 });
    const [version, headers] = JSON.parse(String(r.stdout || "").trim().split("\n").pop() || "null") || [];
    const major = parseInt(String(version || ""), 10);
    res = { ok: r.status === 0 && major >= MIN_NODE_MAJOR && headers === true, version: version || null };
  } catch {}
  nodeProbeCache.set(path, res);
  return res;
}

// node for launchd is a stable path, not a versioned Cellar path: the first of /opt/homebrew/bin/node
// (Homebrew on Apple Silicon, first in PATH in the launchd job) and /usr/local/bin/node (Homebrew on Intel, the
// nodejs.org installer) that exists and is fit (probeNode: ≥ 22 with headers — the daemon wouldn't start on an old node 18 there);
// if none is fit — the node running this command (nvm etc.; the installer already checked it). One rule for
// the plist and the build: the installer and migration build the addon and run the self-test with this same node (build.mjs, opts.node).
export function launchdNode({ candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"], fallback = process.execPath, probe = probeNode } = {}) {
  return candidates.find((p) => existsSync(p) && probe(p).ok) ?? fallback;
}

// env — extra job variables (only for the installer's test job: AGENTHUB_HOME); the live plist
// doesn't contain them.
export function plistXml({ node = launchdNode(), home = homedir(), stateDir = liveStateDir(), location = daemonLocation(stateDir), env = null } = {}) {
  const logs = pathsFor(stateDir).logs;
  const extraEnv = Object.entries(env || {})
    .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(location.daemon)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(standardPath(home))}</string>
${extraEnv}  </dict>
  <key>WorkingDirectory</key>
  <string>${esc(location.workDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>${esc(join(logs, "agenthubd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(logs, "agenthubd.err.log"))}</string>
</dict>
</plist>
`;
}

// Which KeepAlive the daemon job runs under — from the plist on disk (`agenthub install --apply` writes it and immediately
// reloads the job, so what's on disk is what's loaded):
//   "ok"       — KeepAlive {SuccessfulExit: false} (or false, or no key): launchd doesn't restart a normal exit with code 0
//                — exiting via a disabled "Launch at login" and /shutdown work;
//   "outdated" — KeepAlive true (plist before 2026-11-06) or a dict without SuccessfulExit=false: launchd will start the daemon again
//                after ThrottleInterval — a "login-off" exit would become a "start → 30 s → exit" loop, and the app couldn't
//                be closed (after /shutdown the daemon comes up and launches it again 2 s later);
//   "missing"  — no plist (the daemon was started by hand, the LaunchAgent isn't installed);
//   "unknown"  — couldn't read or parse it (a binary plist etc.).
export function launchAgentState(plistPath) {
  let xml;
  try {
    xml = readFileSync(plistPath, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? "missing" : "unknown";
  }
  if (!/^\s*<\?xml|^\s*<!DOCTYPE|^\s*<plist/.test(xml)) return "unknown";
  const m = /<key>\s*KeepAlive\s*<\/key>\s*(<true\s*\/>|<false\s*\/>|<dict>([\s\S]*?)<\/dict>|<dict\s*\/>)/.exec(xml);
  if (!m) return /<key>\s*KeepAlive\s*<\/key>/.test(xml) ? "unknown" : "ok";
  if (/^<true/.test(m[1])) return "outdated";
  if (/^<false/.test(m[1])) return "ok";
  return /<key>\s*SuccessfulExit\s*<\/key>\s*<false\s*\/>/.test(m[2] || "") ? "ok" : "outdated";
}

// launchctl is /bin/launchctl; AGENTHUB_TEST_LAUNCHCTL replaces it with a double in CLI tests.
export function installPlan({ uid = myUid(), home = homedir(), launchctl = process.env.AGENTHUB_TEST_LAUNCHCTL || "/bin/launchctl" } = {}) {
  const repoPlist = join(REPO_DIR, "launchd", `${LABEL}.plist`);
  const target = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  return {
    repoPlist,
    target,
    bootstrap: [launchctl, "bootstrap", `gui/${uid}`, target],
    bootout: [launchctl, "bootout", `gui/${uid}/${LABEL}`],
    print: [launchctl, "print", `gui/${uid}/${LABEL}`],
  };
}

// An optional mode (bundle.sh --cert): a requirement by the "AgentHub Local Signing" certificate (its own on every machine).
// By default — the cdhash of the pinned build (lib/app-pin.mjs, agenthub pin-app).
export function localAppRequirement(sha1) {
  if (!/^[0-9a-fA-F]{40}$/.test(sha1 || "")) throw new Error(msg("err.certSha1"));
  return `identifier "com.kensei.agenthub" and certificate leaf = H"${sha1.toLowerCase()}"`;
}
