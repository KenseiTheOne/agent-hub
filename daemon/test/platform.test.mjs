// Platform layer: the core does not hardcode Unix specifics (/usr/bin and /bin/kill paths, process.getuid, process
// groups, ~/Library), and the Windows branches return sensible values (named pipe, %LOCALAPPDATA%, taskkill).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DAEMON_DIR } from "../lib/config.mjs";
import { interpreterFor, openCommand, stateDir, terminateCommand, transportPath, transportProblem, treeSpawnOptions, usesFileModes } from "../lib/platform.mjs";

// Modules that are inherently macOS-only (launchd, notifications, keychain, codesign/peercred, Telegram
// via curl, .app build), plus the platform layer itself. The core (server, host, runner, generic primitives) is not.
const MAC_ONLY = new Set([
  "lib/platform.mjs",
  "lib/launchd.mjs",
  "lib/app-sign.mjs", // codesign of the build for agenthub pin-app
  "lib/peer.mjs", // codesign, until Windows signature checks (WinVerifyTrust)
  "lib/native.mjs",
  "lib/meta.mjs", // binary xattrs, the fallback path without the addon
  "lib/push/idle.mjs",
  "lib/push/macos.mjs",
  "lib/push/send-test.mjs",
  "lib/push/telegram.mjs",
  "lib/services/secrets.mjs",
  "lib/services/usage.mjs", // macOS keychain (/usr/bin/security) on darwin only; otherwise .credentials.json
  "lib/services/actions.mjs",
  "lib/primitives/_actions-support.mjs",
  "lib/primitives/cmux.focus.mjs",
  "lib/primitives/terminal.focus.mjs",
  // terminal adapters: tmux, iTerm2 and Terminal.app (AppleScript) — macOS terminals and paths
  "lib/terminals/cmux.mjs",
  "lib/terminals/tmux.mjs",
  "lib/terminals/iterm2.mjs",
  "lib/terminals/terminal-app.mjs",
  "lib/terminals/_proc.mjs",
  "lib/primitives/session.interrupt.mjs",
  "lib/primitives/session.launch.mjs",
  // hub updates: building AgentHub.app (swift, codesign) and launchctl are macOS-only (docs/hub-updates.md)
  "lib/hub-update/build.mjs",
  "lib/hub-update/cli.mjs",
]);

function files(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (n.endsWith(".mjs")) out.push(p);
  }
  return out;
}

test("core has no Unix specifics outside the platform layer", () => {
  const bad = [];
  for (const f of files(join(DAEMON_DIR, "lib"))) {
    const rel = relative(DAEMON_DIR, f);
    if (MAC_ONLY.has(rel)) continue;
    const code = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    for (const re of [/"\/usr\/bin\//, /"\/bin\//, /process\.getuid/, /"Library"/, /process\.kill\(-/, /detached:\s*true/, /\.split\("\/"\)\.pop\(\)/]) {
      if (re.test(code)) bad.push(`${rel}: ${re}`);
    }
  }
  // tarballs and paths inside registry archives always use "/" (the format), which is not a Unix specific
  assert.deepEqual(bad.filter((b) => !/registry\/(tarball|perms)\.mjs/.test(b) && !/hook\/cards\.mjs: .*split/.test(b)), []);
});

test("Windows branches: named pipe, %LOCALAPPDATA%, taskkill, interpreters from PATH, no file modes", () => {
  const w = { platform: "win32" };
  assert.equal(stateDir({ env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, home: "C:\\Users\\u", ...w }).endsWith("AgentHub"), true);
  const pipe = transportPath("C:\\x", { ...w, user: "u" });
  assert.equal(pipe, "\\\\.\\pipe\\agenthub-u");
  assert.equal(transportProblem(pipe, w), null);
  assert.match(transportProblem("C:\\x\\hub.sock", w), /named pipe/);
  assert.equal(usesFileModes("win32"), false);
  assert.deepEqual(treeSpawnOptions(w), { windowsHide: true });
  assert.deepEqual(terminateCommand(42, w), ["taskkill", "/PID", "42"]);
  assert.deepEqual(interpreterFor("py", w), ["python"]);
  assert.deepEqual(interpreterFor("sh", w), ["bash"]);
  assert.equal(openCommand("https://e.x", w)[0], "rundll32.exe");
  // macOS: unchanged
  const m = { platform: "darwin" };
  assert.equal(stateDir({ env: {}, home: "/Users/u", ...m }), "/Users/u/Library/Application Support/AgentHub");
  assert.equal(transportPath("/h", m), "/h/hub.sock");
  assert.deepEqual(treeSpawnOptions(m), { detached: true });
  assert.deepEqual(terminateCommand(42, m), ["/bin/kill", "-TERM", "42"]);
  assert.deepEqual(openCommand("/a", { reveal: true, ...m }), ["/usr/bin/open", "-R", "/a"]);
  assert.match(transportProblem("x".repeat(10), m), /must be a Unix path/);
});
