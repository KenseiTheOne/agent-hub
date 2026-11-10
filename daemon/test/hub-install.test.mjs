// The installer (scripts/install.sh → agenthub hub install) and removal (agenthub uninstall), docs/hub-updates.md §8a.
// Everything runs in a temporary HOME and a temporary AGENTHUB_HOME: origin is a bare double (holding this repository's real CLI,
// a build-release.sh double instead of swift and a daemon double), launchctl is a double that actually brings up the daemon
// double from the plist on the test directory's socket; sw_vers, xcode-select and xcrun are substituted. The network, the live
// directory and ~/Library/LaunchAgents aren't touched; the installer runs in a new session (without a controlling
// terminal), so it can't reach the /dev/tty of whoever runs the tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAEMON_DIR, REPO_DIR } from "../lib/config.mjs";
import { cdhashRequirement } from "../lib/app-pin.mjs";
import { currentLabel, previousLabel, readBuild, versionApp } from "../lib/hub-update/layout.mjs";
import { readInstall, writeInstall } from "../lib/hub-update/trial.mjs";
import { LABEL, launchdNode, probeNode } from "../lib/launchd.mjs";
import { cleanup, tempHome, waitFor } from "./helpers.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const GIT = "/usr/bin/git";
const INSTALLER = join(REPO_DIR, "scripts", "install.sh");
// AGENTHUB_SYSTEM_LANG=en: the installer and the CLI speak the hub language; these checks read the English output
const env0 = () => {
  const e = { ...process.env, AGENTHUB_SYSTEM_LANG: "en" };
  delete e.NODE_OPTIONS;
  delete e.AGENTHUB_HOME;
  delete e.AGENTHUB_TEST_TTY;
  delete e.AGENTHUB_TEST_LAUNCHCTL;
  return e;
};
const git = (cwd, ...args) => execFileSync(GIT, ["-C", cwd, ...args], { encoding: "utf8", env: { ...env0(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

// ---------- doubles ----------

// Daemon double: --self-test — a reply to the builder; otherwise a server on <AGENTHUB_HOME>/hub.sock (/health — pid,
// /hub-update — which version it runs from, like the real one: the label comes from the path via Versions/current; the rest — 200),
// on SIGTERM it removes the socket and exits with code 0, like the real one. Exits on its own after 2 min (no leftover processes).
const DAEMON_DOUBLE = (version) => `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--self-test")) {
  console.log(JSON.stringify({ ok: true, version: ${JSON.stringify(version)}, native: false }));
  process.exit(0);
}
const home = process.env.AGENTHUB_HOME;
if (!home) process.exit(9);
const sock = join(home, "hub.sock");
rmSync(sock, { force: true });
appendFileSync(join(home, "logs", "daemon-runs.log"), ${JSON.stringify(version)} + " " + process.pid + "\\n");
const self = /\\/Versions\\/([^/]+)\\/src\\//.exec(realpathSync(process.argv[1]))?.[1] ?? null;
const srv = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/hub-update") return res.end(JSON.stringify({ installed: Boolean(self), label: self }));
  res.end(JSON.stringify({ ok: true, pid: process.pid }));
});
srv.listen(sock);
const stop = () => { srv.close(); rmSync(sock, { force: true }); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setTimeout(stop, 120_000);
`;

// launchctl double: bootstrap reads the plist (plutil) and runs ProgramArguments with its environment and working
// directory as a separate process; bootout — SIGTERM and wait for exit; print — whether it's alive. Calls go to calls.log.
const LAUNCHCTL_DOUBLE = `import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dir = process.env.FAKE_LAUNCHD_DIR;
const [cmd, ...rest] = process.argv.slice(2);
appendFileSync(join(dir, "calls.log"), [cmd, ...rest].join(" ") + "\\n");
const pidFile = join(dir, "job.pid");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const jobPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (cmd === "bootstrap") {
  if (jobPid() && alive(jobPid())) process.exit(5);
  const j = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", rest[1]], { encoding: "utf8" }));
  if (!existsSync(dirname(j.StandardErrorPath))) process.exit(78);
  const out = openSync(j.StandardOutPath, "a");
  const err = openSync(j.StandardErrorPath, "a");
  const child = spawn(j.ProgramArguments[0], j.ProgramArguments.slice(1), { cwd: j.WorkingDirectory, env: j.EnvironmentVariables, detached: true, stdio: ["ignore", out, err] });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  writeFileSync(join(dir, "plist.json"), JSON.stringify(j));
  process.exit(0);
}
if (cmd === "bootout") {
  const pid = jobPid();
  if (!pid) process.exit(3);
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 60 && alive(pid); i++) sleep(50);
  rmSync(pidFile, { force: true });
  process.exit(0);
}
if (cmd === "print") process.exit(jobPid() && alive(jobPid()) ? 0 : 113);
process.exit(0);
`;

function writeExec(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// Release sources in origin: the real CLI (daemon/lib, daemon/bin/agenthub) — the installer runs it from the
// downloaded branch; build doubles (build-release.sh → a bundle with TEST-CDHASH) and a daemon double; a built-in plugin.
function writeHubTree(dir, { version, cdhash = B, plugin = "v" + version } = {}) {
  mkdirSync(join(dir, "daemon", "bin"), { recursive: true });
  cpSync(join(DAEMON_DIR, "lib"), join(dir, "daemon", "lib"), { recursive: true });
  cpSync(join(DAEMON_DIR, "bin", "agenthub"), join(dir, "daemon", "bin", "agenthub"));
  cpSync(join(DAEMON_DIR, "package.json"), join(dir, "daemon", "package.json"));
  writeExec(join(dir, "daemon", "bin", "agenthubd"), DAEMON_DOUBLE(version));
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  writeExec(
    join(dir, "scripts", "build-release.sh"),
    `#!/bin/bash
set -e
[ "$1" = "--out" ] || exit 2
echo "двойник сборки ${version}"
mkdir -p "$2/AgentHub.app/Contents/MacOS"
printf '#!/bin/sh\\n' > "$2/AgentHub.app/Contents/MacOS/AgentHub"
chmod +x "$2/AgentHub.app/Contents/MacOS/AgentHub"
echo ${cdhash} > "$2/AgentHub.app/Contents/TEST-CDHASH"
`,
  );
  writeExec(join(dir, "plugins", "demo", "demo.60s.sh"), `#!/bin/sh\necho ${plugin}\n`);
  mkdirSync(join(dir, "claude-plugin", "hook"), { recursive: true });
  writeFileSync(join(dir, "claude-plugin", "hook", "agenthub-hook"), "#!/bin/sh\necho {}\n");
}

// The world: a temporary HOME, a test hub directory, tool doubles, a bare origin with a working clone.
function world() {
  const root = tempHome("ah-inst-");
  const w = {
    root,
    home: join(root, "home"),
    hub: join(root, "hub"),
    fakebin: join(root, "fakebin"),
    launchd: join(root, "launchd"),
    work: join(root, "work"),
    bare: join(root, "origin.git"),
  };
  for (const d of [w.home, w.hub, w.launchd, w.work]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writeExec(join(w.fakebin, "sw_vers"), '#!/bin/sh\n[ "$1" = "-productVersion" ] && echo "${FAKE_MACOS:-26.1}"\n');
  writeExec(join(w.fakebin, "xcode-select"), '#!/bin/sh\n[ -n "$FAKE_NO_CLT" ] && { echo "xcode-select: error: unable to get active developer directory" >&2; exit 2; }\necho /Library/Developer/CommandLineTools\n');
  writeExec(join(w.fakebin, "xcrun"), '#!/bin/sh\ncase "$*" in\n  *--show-sdk-version*) echo "${FAKE_SDK:-26.0}" ;;\n  "--find swift") [ -n "$FAKE_NO_SWIFT" ] && exit 1; echo /usr/bin/swift ;;\n  "--find clang") echo /usr/bin/clang ;;\n  *) exit 1 ;;\nesac\n');
  writeFileSync(join(w.root, "launchctl.mjs"), LAUNCHCTL_DOUBLE);
  w.launchctl = join(w.root, "launchctl");
  writeExec(w.launchctl, `#!/bin/sh\nexec "${process.execPath}" "${join(w.root, "launchctl.mjs")}" "$@"\n`);
  execFileSync(GIT, ["init", "-q", "-b", "main", w.work]);
  execFileSync(GIT, ["init", "-q", "--bare", w.bare]);
  git(w.work, "remote", "add", "origin", w.bare);
  w.commit = (version, opts = {}) => {
    writeHubTree(w.work, { version, ...opts });
    git(w.work, "add", "-A");
    git(w.work, "commit", "-q", "-m", `hub ${version}`);
    git(w.work, "push", "-q", "origin", "main");
    return git(w.work, "rev-parse", "HEAD");
  };
  w.release = (version, opts = {}) => {
    const commit = w.commit(version, opts);
    git(w.work, "tag", "-a", `v${version}`, "-m", `Agent Hub ${version}`);
    git(w.work, "push", "-q", "origin", `v${version}`);
    return commit;
  };
  w.env = (extra = {}) => ({
    ...env0(),
    HOME: w.home,
    PATH: `${w.fakebin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    AGENTHUB_TEST_EXTRA_PATH: "",
    AGENTHUB_TEST_LAUNCHCTL: w.launchctl,
    FAKE_LAUNCHD_DIR: w.launchd,
    AGENTHUB_INSTALL_WAIT_MS: "10000",
    TMPDIR: join(w.root, "tmp"),
    ...extra,
  });
  mkdirSync(join(w.root, "tmp"), { recursive: true });
  w.calls = () => (existsSync(join(w.launchd, "calls.log")) ? readFileSync(join(w.launchd, "calls.log"), "utf8").trim().split("\n") : []);
  w.jobPid = () => (existsSync(join(w.launchd, "job.pid")) ? Number(readFileSync(join(w.launchd, "job.pid"), "utf8")) : 0);
  w.plist = () => join(w.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  w.stop = () => {
    const pid = w.jobPid();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  };
  return w;
}

// The installer in a new session (detached → no controlling terminal, /dev/tty can't be opened). → {code, stdout, stderr}
function runInstaller(args, env, { input = "" } = {}) {
  return new Promise((done) => {
    const c = spawn("/bin/bash", [INSTALLER, ...args], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 90_000);
    c.on("close", (code) => {
      clearTimeout(t);
      done({ code, stdout, stderr });
    });
    c.stdin.end(input);
  });
}

// This repository's CLI (for node-level checks: the "y/N" question, refusals before the network).
function cli(args, env, input = "") {
  return spawnSync(process.execPath, [join(DAEMON_DIR, "bin", "agenthub"), ...args], { encoding: "utf8", env, input, timeout: 60_000 });
}

const readCfg = (hub) => JSON.parse(readFileSync(join(hub, "config.json"), "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------- tests ----------

test("installer: latest release on main — built by the same builder, pinned, launchd brings up the daemon from Versions/current; repeat — \"all good\" and repair without a rebuild; new version — \"update with the button\"; removal — settings stay, --purge — everything", async () => {
  const w = world();
  try {
    w.release("0.2.0");
    // a tag not on main (an agent's branch) and a pre-release aren't installed
    git(w.work, "checkout", "-q", "-b", "side");
    w.commit("0.3.0");
    git(w.work, "tag", "v0.3.0");
    git(w.work, "push", "-q", "origin", "side", "v0.3.0");
    git(w.work, "checkout", "-q", "main");
    git(w.work, "tag", "v0.4.0-rc.1");
    git(w.work, "push", "-q", "origin", "v0.4.0-rc.1");

    // plan: changes nothing
    const plan = await runInstaller(["--origin", w.bare, "--home", w.hub, "--plan"], w.env());
    assert.equal(plan.code, 0, plan.stderr + plan.stdout);
    assert.match(plan.stdout, /version:\s+0\.2\.0 \(release v0\.2\.0\)/);
    assert.match(plan.stdout, /tags not on main \(not installed\): v0\.3\.0/);
    assert.match(plan.stdout, /no hub — a new install/);
    assert.match(plan.stdout, /Nothing done without --apply/);
    assert.ok(!existsSync(join(w.hub, "Versions")));
    assert.ok(!existsSync(w.plist()));
    assert.ok(!existsSync(join(w.hub, "HubUpdate")), "the plan creates nothing in the hub directory");
    assert.deepEqual(readdirSync(join(w.root, "tmp")), [], "the installer's temporary clone and the main mirror are cleaned up");

    const r = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(currentLabel(w.hub), "0.2.0");
    const b = readBuild(w.hub, "0.2.0");
    assert.equal(b.tag, "v0.2.0");
    assert.equal(b.origin, w.bare, "origin — for update checks");
    assert.equal(b.tagInfo.notes.subject, "Agent Hub 0.2.0");
    const cfg = readCfg(w.hub);
    assert.equal(cfg.requirements.app, cdhashRequirement(B));
    assert.equal(cfg.appPin.by, "agenthub hub install");
    assert.equal(cfg.appPin.path, versionApp(w.hub, "0.2.0"));
    assert.equal(cfg.builtinPluginsDir, join(w.hub, "Builtin"));
    assert.match(readFileSync(join(w.hub, "Builtin", "demo", "demo.60s.sh"), "utf8"), /v0\.2\.0/);
    assert.equal(readInstall(w.hub).op, "setup");
    assert.match(readFileSync(join(w.hub, "journal.jsonl"), "utf8"), /"type":"hub-update-cli".*"op":"setup"/);
    // launchd: plist in the temporary HOME, the daemon via Versions/current, the test directory in the job's environment
    const xml = readFileSync(w.plist(), "utf8");
    assert.ok(xml.includes(join(w.hub, "Versions", "current", "src", "daemon", "bin", "agenthubd")));
    assert.ok(xml.includes(`<string>${w.hub}</string>`));
    assert.deepEqual(w.calls().map((l) => l.split(" ")[0]), ["bootout", "bootstrap"]);
    assert.match(readFileSync(join(w.hub, "logs", "daemon-runs.log"), "utf8"), /^0\.2\.0 \d+/);
    assert.ok(alive(w.jobPid()), "the daemon is running");
    assert.ok(existsSync(join(w.hub, "hub.sock")));
    // result: the hook as a command for the human, ~/.claude untouched
    assert.deepEqual(readdirSync(join(w.root, "tmp")), [], "temporary directories cleaned up after install");
    assert.match(r.stdout, /Done: Agent Hub 0\.2\.0/);
    assert.ok(r.stdout.includes(`claude --plugin-dir "${join(w.hub, "Versions", "current", "src", "claude-plugin")}"`));
    assert.ok(!existsSync(join(w.home, ".claude")), "~/.claude untouched");

    // a repeat run — same version, everything in place: does nothing (and doesn't touch launchd)
    const again = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(again.code, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /Install 0\.2\.0 is fine — nothing to do/);
    assert.equal(w.calls().filter((c) => !c.startsWith("print")).length, 2, "launchd untouched (only print — whose daemon answers)");

    // the developer pinned their own build (bundle.sh --pin-live), the daemon is alive: a repeat re-pins the version and closes
    // the previous copy right here — the job isn't restarted, otherwise there would be two icons in the menu bar
    const devApp = join(w.root, "dev", "app", "build", "AgentHub.app");
    const pinned = readCfg(w.hub);
    pinned.requirements.app = cdhashRequirement(A);
    pinned.appPin = { ...pinned.appPin, path: devApp, by: "bundle.sh --pin-live" };
    writeFileSync(join(w.hub, "config.json"), JSON.stringify(pinned));
    const repin = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(repin.code, 0, repin.stderr + repin.stdout);
    assert.match(repin.stdout, /daemon:\s+responding\n/);
    assert.equal(w.calls().filter((c) => !c.startsWith("print")).length, 2, "the job untouched");
    assert.ok(repin.stdout.includes(`old copy of the app ${devApp}:`), repin.stdout);
    assert.equal(readCfg(w.hub).appPin.path, versionApp(w.hub, "0.2.0"));

    // the daemon crashed, the pin was knocked off (bundle.sh --pin-live) — a repeat repairs without a rebuild
    const builtAt = b.builtAt;
    w.stop();
    await waitFor(() => !alive(w.jobPid()), { timeoutMs: 5000 });
    const broken = readCfg(w.hub);
    broken.requirements.app = cdhashRequirement(A);
    writeFileSync(join(w.hub, "config.json"), JSON.stringify(broken));
    const fix = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(fix.code, 0, fix.stderr + fix.stdout);
    assert.match(fix.stdout, /pin:\s+NOT this build/);
    assert.match(fix.stdout, /daemon:\s+not responding/);
    assert.equal(readCfg(w.hub).requirements.app, cdhashRequirement(B));
    assert.equal(readBuild(w.hub, "0.2.0").builtAt, builtAt, "no rebuild");
    assert.ok(alive(w.jobPid()), "the daemon is up again");

    // 0.3.1 is out on main — the installer doesn't update over it: "with the Update button"
    w.release("0.3.1");
    const newer = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(newer.code, 5, newer.stderr + newer.stdout);
    assert.match(newer.stderr, /with the Update button/);
    assert.equal(currentLabel(w.hub), "0.2.0");

    // removal during an update — refused
    writeInstall(w.hub, { phase: "building", op: "install", label: "0.3.0" });
    const busy = await runInstaller(["--uninstall", "--home", w.hub, "--yes"], w.env());
    assert.equal(busy.code, 5, busy.stderr + busy.stdout);
    assert.match(busy.stderr, /a hub update is in progress.*add --force/);
    // --force without --uninstall — the installer refuses (the flag is for removal only)
    const forceInstall = await runInstaller(["--force", "--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(forceInstall.code, 64);

    // removal (the update "got stuck" — --force, which the installer passes to the CLI): the daemon is stopped cleanly, the job
    // is unloaded, versions and the built-ins copy are deleted; settings and the journal aren't
    const pid = w.jobPid();
    writeFileSync(join(w.hub, "settings.json"), '{"lang":"en"}\n');
    const un = await runInstaller(["--uninstall", "--force", "--home", w.hub, "--yes"], w.env());
    assert.equal(un.code, 0, un.stderr + un.stdout);
    await waitFor(() => !alive(pid), { timeoutMs: 5000 });
    assert.ok(!existsSync(join(w.hub, "hub.sock")), "the daemon removed the socket — a clean stop");
    assert.ok(!existsSync(w.plist()));
    assert.ok(w.calls().at(-1).startsWith("bootout"));
    for (const d of ["Versions", "HubUpdate", "Builtin"]) assert.ok(!existsSync(join(w.hub, d)), d);
    assert.ok(existsSync(join(w.hub, "settings.json")));
    assert.ok(existsSync(join(w.hub, "journal.jsonl")));
    assert.equal(readCfg(w.hub).requirements.app, cdhashRequirement(B), "settings and the pin stay");
    assert.equal(readCfg(w.hub).builtinPluginsDir, undefined, "config.json no longer points at the deleted built-ins copy");
    assert.ok(!readdirSync(join(w.hub, "logs")).some((n) => n.startsWith("hub-update-")), "build logs deleted");
    assert.match(un.stdout, /claude plugin uninstall agent-hub/);
    assert.match(un.stdout, /remaining: .*settings, journal/);
    // no installation anymore — the installer with --uninstall says how to remove the rest
    const none = await runInstaller(["--uninstall", "--home", w.hub, "--yes"], w.env());
    assert.equal(none.code, 1);
    // --purge — the hub directory only: an ordinary folder (a typo in --home) and a hub directory with foreign files — refused
    const precious = join(w.root, "precious");
    mkdirSync(join(precious, "src"), { recursive: true });
    writeFileSync(join(precious, "notes.txt"), "важное");
    const notHub = cli(["uninstall", "--apply", "--purge", "--yes", "--no-launchd"], w.env({ AGENTHUB_HOME: precious }));
    assert.equal(notHub.status, 2, notHub.stderr + notHub.stdout);
    assert.match(notHub.stderr, /does not look like a hub directory/);
    assert.ok(existsSync(join(precious, "notes.txt")), "the foreign directory is untouched");
    writeFileSync(join(precious, "config.json"), "{}\n");
    const mixed = cli(["uninstall", "--apply", "--purge", "--yes", "--no-launchd"], w.env({ AGENTHUB_HOME: precious }));
    assert.equal(mixed.status, 2);
    assert.match(mixed.stderr, /foreign entries: .*notes\.txt/);
    assert.ok(existsSync(join(precious, "src")));
    // --purge — the whole hub directory; plugin keychain entries are named — they were collected before Plugins/ was deleted
    mkdirSync(join(w.hub, "Plugins", "tix"), { recursive: true });
    writeFileSync(join(w.hub, "Plugins", "tix", "tix.1h.sh"), "#!/bin/sh\n# <agenthub.title>T</agenthub.title>\n# <agenthub.secrets>tix.token — запасной путь</agenthub.secrets>\n", { mode: 0o755 });
    const purge = cli(["uninstall", "--apply", "--purge", "--yes"], w.env({ AGENTHUB_HOME: w.hub }));
    assert.equal(purge.status, 0, purge.stderr + purge.stdout);
    assert.ok(!existsSync(w.hub));
    assert.match(purge.stdout, /-s agent-hub\.tix\b/, "the plugin's secrets service is named even after the directory is deleted");
    assert.match(purge.stdout, /-s agent-hub\.oauth\b/, "connection sign-ins are a core service, always named");
    assert.match(purge.stdout, /security dump-keychain \| grep agent-hub\./);
  } finally {
    w.stop();
    cleanup(w.root);
  }
});

test("installer: no tags — main labelled X.Y.Z-dev.<commit>; a hub running from a working folder moves into Versions — settings, journal and plugin data stay, pin and plist are new", async () => {
  const w = world();
  try {
    const head = w.commit("0.1.0");
    // "working folder": the plist points into the repository, the app/build build is pinned, there are settings, a journal, plugin data
    const oldDaemon = "/Users/someone/src/agent-hub/daemon/bin/agenthubd";
    mkdirSync(dirname(w.plist()), { recursive: true });
    writeFileSync(w.plist(), `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key>\n<array>\n<string>/opt/homebrew/bin/node</string>\n<string>${oldDaemon}</string>\n</array></dict></plist>\n`);
    writeFileSync(join(w.hub, "config.json"), JSON.stringify({ requirements: { app: cdhashRequirement(A) }, appPin: { by: "agenthub pin-app", path: "/Users/someone/src/agent-hub/app/build/AgentHub.app" }, services: { push: { enabled: false } } }), { mode: 0o600 });
    writeFileSync(join(w.hub, "settings.json"), '{"lang":"ru"}\n');
    writeFileSync(join(w.hub, "journal.jsonl"), '{"ts":"2026-11-01T00:00:00.000Z","type":"start"}\n');
    mkdirSync(join(w.hub, "PluginData", "quota"), { recursive: true });
    writeFileSync(join(w.hub, "PluginData", "quota", "state.json"), "{}\n");

    const r = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const label = `0.1.0-dev.${head.slice(0, 7)}`;
    // settings.json says ru: the CLI the installer runs speaks the hub language
    assert.match(r.stdout, /на main нет релизных тегов/);
    assert.match(r.stdout, /хаб работает из рабочей папки \(демон: \/Users\/someone\/src\/agent-hub\/daemon\/bin\/agenthubd\)/);
    assert.match(r.stdout, /Настройки, журнал, плагины и их данные остаются/);
    assert.equal(currentLabel(w.hub), label);
    assert.equal(previousLabel(w.hub), null);
    assert.equal(readBuild(w.hub, label).commit, head);
    assert.equal(readBuild(w.hub, label).origin, w.bare);
    const cfg = readCfg(w.hub);
    assert.equal(cfg.requirements.app, cdhashRequirement(B), "the new build is pinned");
    assert.equal(cfg.appPin.path, versionApp(w.hub, label));
    assert.equal(cfg.services.push.enabled, false, "other settings as they were");
    assert.equal(readFileSync(join(w.hub, "settings.json"), "utf8"), '{"lang":"ru"}\n');
    assert.ok(existsSync(join(w.hub, "PluginData", "quota", "state.json")));
    const journal = readFileSync(join(w.hub, "journal.jsonl"), "utf8");
    assert.match(journal, /^\{"ts":"2026-11-01T00:00:00.000Z","type":"start"\}\n/, "the journal is appended, not replaced");
    const cliEntry = journal.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "hub-update-cli");
    assert.equal(cliEntry.op, "setup");
    assert.equal(cliEntry.old, `cdhash:${A}`, "the journal records which pin was replaced");
    assert.equal(cliEntry.new, `cdhash:${B}`);
    const xml = readFileSync(w.plist(), "utf8");
    assert.ok(!xml.includes(oldDaemon), "plist rewritten");
    assert.ok(xml.includes(join(w.hub, "Versions", "current", "src", "daemon", "bin", "agenthubd")));
    assert.ok(alive(w.jobPid()));
    // a new commit on main without tags: -dev.<commit> labels are compared by history, not by hash string — a hint about the tag
    const next = w.commit("0.1.0", { plugin: "v-next" });
    const again = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(again.code, 5, again.stderr + again.stdout);
    assert.match(again.stderr, new RegExp(`в main есть новые коммиты \\(0\\.1\\.0-dev\\.${next.slice(0, 7)}\\)`));
    assert.match(again.stderr, /поставьте тег v0\.1\.0 на main/);
    assert.doesNotMatch(again.stderr, /она новее|кнопкой «Обновить» в меню Agent Hub/);
    assert.equal(currentLabel(w.hub), label);
  } finally {
    w.stop();
    cleanup(w.root);
  }
});

test("installer: missing dependencies — a clear list and how to install; without a terminal and with --yes without --home — refused", async () => {
  const w = world();
  try {
    const base = ["--origin", w.bare, "--home", w.hub, "--yes"];
    const old = await runInstaller(base, w.env({ FAKE_MACOS: "15.6" }));
    assert.equal(old.code, 3);
    assert.match(old.stderr, /macOS 26 \(Tahoe\) or newer — now 15\.6/);
    const noClt = await runInstaller(base, w.env({ FAKE_NO_CLT: "1" }));
    assert.equal(noClt.code, 3);
    assert.match(noClt.stderr, /Command Line Tools .*xcode-select --install/);
    const noSwift = await runInstaller(base, w.env({ FAKE_NO_SWIFT: "1" }));
    assert.match(noSwift.stderr, /swift \(from Command Line Tools\)/);
    const oldSdk = await runInstaller(base, w.env({ FAKE_SDK: "15.4" }));
    assert.match(oldSdk.stderr, /macOS 26 SDK .* now 15\.4/);
    // node isn't in PATH (and Homebrew locations aren't searched — AGENTHUB_TEST_EXTRA_PATH is empty)
    const noNode = await runInstaller(base, w.env({ PATH: `${w.fakebin}:/usr/bin:/bin` }));
    assert.equal(noNode.code, 3);
    assert.match(noNode.stderr, /node 22 or newer: brew install node/);
    // old node
    writeExec(join(w.root, "oldnode", "node"), '#!/bin/sh\necho 20.11.1\n');
    const oldNode = await runInstaller(base, w.env({ PATH: `${w.fakebin}:${join(w.root, "oldnode")}:/usr/bin:/bin` }));
    assert.match(oldNode.stderr, /now 20\.11\.1/);
    // an old node first in PATH and a suitable one where launchd will take it from: the installer takes the same one as launchd
    w.release("0.2.0");
    mkdirSync(join(w.root, "brew"), { recursive: true });
    symlinkSync(process.execPath, join(w.root, "brew", "node"));
    const brewFirst = await runInstaller(["--origin", w.bare, "--home", w.hub, "--plan"], w.env({ PATH: `${w.fakebin}:${join(w.root, "oldnode")}:/usr/bin:/bin`, AGENTHUB_TEST_EXTRA_PATH: join(w.root, "brew") }));
    assert.equal(brewFirst.code, 0, brewFirst.stderr + brewFirst.stdout);
    assert.doesNotMatch(brewFirst.stderr, /now 20/);
    // several at once — all in one list
    const many = await runInstaller(base, w.env({ FAKE_MACOS: "15.6", PATH: `${w.fakebin}:/usr/bin:/bin` }));
    assert.match(many.stderr, /macOS 26[\s\S]*node 22/);
    assert.ok(!existsSync(join(w.hub, "Versions")), "nothing was installed");
    // --yes without --home — only for a test directory
    const yesLive = await runInstaller(["--origin", w.bare, "--yes"], w.env());
    assert.equal(yesLive.code, 2);
    assert.match(yesLive.stderr, /--yes only together with --home/);
    // without a terminal (a new session, stdin is a pipe) and without --yes — refused before any work
    const noTty = await runInstaller(["--origin", w.bare, "--home", w.hub], w.env());
    assert.equal(noTty.code, 3);
    assert.match(noTty.stderr, /a terminal is required/);
  } finally {
    cleanup(w.root);
  }
});

test("hub install: the \"Install? [y/N]\" question in a terminal (n — nothing, y — installs); refusals before the network: a token in the URL, --yes in the live directory, launchd from a test directory without a double", async () => {
  const w = world();
  try {
    w.release("0.2.0");
    const tty = { ...env0(), HOME: w.home, AGENTHUB_HOME: w.hub, AGENTHUB_TEST_TTY: "1" };
    const no = cli(["hub", "install", "--origin", w.bare, "--apply", "--no-launchd"], tty, "n\n");
    assert.equal(no.status, 1, no.stderr + no.stdout);
    assert.match(no.stdout, /Install\? \[y\/N\] Cancelled — nothing changed/);
    assert.ok(!existsSync(join(w.hub, "Versions")));
    // without a TTY (and without --yes) — refused, like migrate
    const noTty = cli(["hub", "install", "--origin", w.bare, "--apply", "--no-launchd"], { ...tty, AGENTHUB_TEST_TTY: "" });
    assert.equal(noTty.status, 3);
    const yes = cli(["hub", "install", "--origin", w.bare, "--apply", "--no-launchd"], tty, "y\n");
    assert.equal(yes.status, 0, yes.stderr + yes.stdout);
    assert.equal(currentLabel(w.hub), "0.2.0");
    assert.ok(!existsSync(w.plist()), "--no-launchd: LaunchAgents untouched");
    // credentials in the URL — refused right away
    const tok = cli(["hub", "install", "--origin", "https://user:secret@example.invalid/agent-hub.git"], tty);
    assert.equal(tok.status, 2);
    assert.ok(!tok.stderr.includes("secret"));
    // the live directory (here — a temporary HOME without AGENTHUB_HOME) and --yes — refused right away
    const live = { ...env0(), HOME: w.home };
    const yl = cli(["hub", "install", "--origin", w.bare, "--apply", "--yes"], live);
    assert.equal(yl.status, 2);
    assert.match(yl.stderr, /--yes is for a test directory/);
    const ul = cli(["uninstall", "--apply", "--yes"], live);
    assert.equal(ul.status, 2);
    // launchd from a test directory without a launchctl double — refused
    const nod = cli(["hub", "install", "--origin", w.bare, "--apply", "--yes"], { ...env0(), HOME: w.home, AGENTHUB_HOME: join(w.root, "hub2") });
    assert.equal(nod.status, 2);
    assert.match(nod.stderr, /Add --no-launchd/);
  } finally {
    cleanup(w.root);
  }
});

test("launchdNode: an old node (or one without headers) in Homebrew locations doesn't go to launchd — the one the installer checked is used", () => {
  const root = tempHome("ah-node-");
  try {
    const old = join(root, "old", "node");
    writeExec(old, '#!/bin/sh\necho \'["18.20.4",true]\'\n');
    const noHeaders = join(root, "nohdr", "node");
    writeExec(noHeaders, '#!/bin/sh\necho \'["24.1.0",false]\'\n');
    const good = join(root, "good", "node");
    mkdirSync(dirname(good), { recursive: true });
    symlinkSync(process.execPath, good);
    assert.equal(probeNode(old).ok, false);
    assert.equal(probeNode(old).version, "18.20.4");
    assert.equal(probeNode(noHeaders).ok, false);
    assert.equal(probeNode(good).ok, true);
    assert.equal(launchdNode({ candidates: [old, noHeaders], fallback: "/fallback/node" }), "/fallback/node");
    assert.equal(launchdNode({ candidates: [join(root, "missing"), old, good], fallback: "/fallback/node" }), good);
  } finally {
    cleanup(root);
  }
});

test("installer: an origin URL with credentials — refused right after argument parsing, the token isn't printed and doesn't reach git; ssh://user@ — allowed", async () => {
  const w = world();
  try {
    for (const origin of ["https://someone:ghp_FAKEtoken123@127.0.0.1:9/agent-hub.git", "https://ghp_FAKEtoken123@127.0.0.1:9/agent-hub.git", "HTTP://u:ghp_FAKEtoken123@h/x.git"]) {
      const r = await runInstaller(["--plan", "--home", w.hub, "--origin", origin], w.env());
      assert.equal(r.code, 2, r.stderr + r.stdout);
      assert.match(r.stderr, /with credentials .*\*\*\*@/);
      assert.ok(!(r.stdout + r.stderr).includes("ghp_FAKE"), `token in the output: ${r.stdout}${r.stderr}`);
      assert.doesNotMatch(r.stdout, /fetching the installer/, "didn't get as far as git");
    }
    // ssh with a lone user name isn't credentials: it proceeds (here git can't connect, but the URL is shown as is)
    const ssh = await runInstaller(["--plan", "--home", w.hub, "--origin", "ssh://git@127.0.0.1:9/agent-hub.git"], w.env({ GIT_SSH_COMMAND: "false" }));
    assert.notEqual(ssh.code, 2, ssh.stderr);
    assert.match(ssh.stdout, /fetching the installer from ssh:\/\/git@127\.0\.0\.1:9/);
  } finally {
    cleanup(w.root);
  }
});

test("installer: the previous daemon didn't leave after bootout (started by hand) — no bootstrap, refused with a hint, not \"Done\" from the previous one's reply", async () => {
  const w = world();
  let manual = null;
  try {
    w.release("0.2.0");
    mkdirSync(join(w.hub, "logs"), { recursive: true });
    // "a daemon started by hand": answers /health with its own pid and ignores SIGTERM; launchd doesn't know about it
    const sock = join(w.hub, "hub.sock");
    manual = spawn(process.execPath, ["-e", `const s=require("node:http").createServer((q,r)=>{r.writeHead(200,{"content-type":"application/json"});r.end(JSON.stringify({ok:true,pid:process.pid}))});s.listen(${JSON.stringify(sock)},()=>console.log("up"));process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),60000);`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((r) => manual.stdout.once("data", r));
    const r = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env({ AGENTHUB_INSTALL_DOWN_MS: "1500" }));
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`the old daemon still answers .*pid ${manual.pid}`));
    assert.doesNotMatch(r.stdout, /runs from Versions\/current|Done:/);
    assert.ok(!w.calls().some((c) => c.startsWith("bootstrap")), `bootstrap wasn't called: ${w.calls().join(" | ")}`);
    assert.equal(currentLabel(w.hub), "0.2.0", "the version is installed — a repeat run will finish the job");

    // a repeat, as the message says, while the previous one is still alive: it's not this installation's daemon answering — not "all good"
    const again = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env({ AGENTHUB_INSTALL_DOWN_MS: "1500" }));
    assert.equal(again.code, 1, again.stdout + again.stderr);
    assert.doesNotMatch(again.stdout, /is fine — nothing to do/);
    assert.match(again.stdout, new RegExp(`daemon:\\s+responding, but the wrong one: .*pid ${manual.pid}`));
    assert.match(again.stderr, /the old daemon still answers/);
    assert.ok(!w.calls().some((c) => c.startsWith("bootstrap")));

    // the previous one is stopped — a repeat finishes the job without a rebuild
    manual.kill("SIGKILL");
    await waitFor(() => !alive(manual.pid), { timeoutMs: 5000 });
    const done = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env({ AGENTHUB_INSTALL_DOWN_MS: "1500" }));
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /runs from Versions\/current/);
    assert.ok(alive(w.jobPid()), "the job's daemon is running");
  } finally {
    manual?.kill("SIGKILL");
    w.stop();
    cleanup(w.root);
  }
});

test("removal: the daemon didn't leave after bootout (started by hand) — nothing is deleted, code 1 with the pid; --force — deletes, the answering daemon's socket stays; --no-launchd in the live directory — refused", async () => {
  const w = world();
  let manual = null;
  try {
    w.release("0.2.0");
    const r = await runInstaller(["--origin", w.bare, "--home", w.hub, "--yes"], w.env());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    // the job's daemon crashed, a hand-started one is on the socket and ignores SIGTERM
    w.stop();
    await waitFor(() => !alive(w.jobPid()), { timeoutMs: 5000 });
    const sock = join(w.hub, "hub.sock");
    rmSync(sock, { force: true });
    manual = spawn(process.execPath, ["-e", `const s=require("node:http").createServer((q,r)=>{r.writeHead(200,{"content-type":"application/json"});r.end(JSON.stringify({ok:true,pid:process.pid}))});s.listen(${JSON.stringify(sock)},()=>console.log("up"));process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),60000);`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((res) => manual.stdout.once("data", res));
    const un = await runInstaller(["--uninstall", "--home", w.hub, "--yes"], w.env({ AGENTHUB_INSTALL_DOWN_MS: "1000" }));
    assert.equal(un.code, 1, un.stdout + un.stderr);
    assert.match(un.stderr, new RegExp(`the daemon still answers .*pid ${manual.pid}.*Nothing deleted`));
    assert.doesNotMatch(un.stdout, /deleted:/);
    for (const d of ["Versions", "HubUpdate", "Builtin"]) assert.ok(existsSync(join(w.hub, d)), `${d} in place`);
    assert.ok(existsSync(sock), "the live daemon's socket is in place");
    // --force — deliberately: deletes, but doesn't touch the socket while it answers
    const forced = await runInstaller(["--uninstall", "--force", "--home", w.hub, "--yes"], w.env({ AGENTHUB_INSTALL_DOWN_MS: "1000" }));
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    assert.ok(!existsSync(join(w.hub, "Versions")));
    assert.ok(existsSync(sock), "--force: the answering daemon's socket stays");
  } finally {
    manual?.kill("SIGKILL");
    w.stop();
    cleanup(w.root);
  }
  // the live directory (a temporary HOME without AGENTHUB_HOME): --no-launchd would leave a job with a plist pointing at deleted Versions
  const w2 = world();
  try {
    const env = w2.env();
    delete env.AGENTHUB_TEST_LAUNCHCTL;
    const live = cli(["uninstall", "--no-launchd"], env);
    assert.equal(live.status, 2, live.stderr + live.stdout);
    assert.match(live.stderr, /--no-launchd is for a test directory/);
  } finally {
    cleanup(w2.root);
  }
});
