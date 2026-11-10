// A hub installed with Homebrew (docs/hub-updates.md §8b): the formula puts the release source tree into
// <prefix>/opt/agent-hub/libexec, `agenthub setup` builds the hub from it (source kind "brew"), and the update check reads the
// version from that tree instead of git tags. Everything runs in temporary directories: a fake brew tree with a build double
// (build-release.sh → a bundle with TEST-CDHASH, an agenthubd self-test double), xcode-select/xcrun doubles, --no-launchd.
// No network, no live hub directory, no launchd.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAEMON_DIR } from "../lib/config.mjs";
import { cdhashRequirement, requirementSha } from "../lib/app-pin.mjs";
import { brewCopyFilter, brewDirOf, brewSetting, brewSettingReader, readBrewSource, writeBrewSetting } from "../lib/hub-update/brew.mjs";
import { buildVersion, testCodeOf } from "../lib/hub-update/build.mjs";
import { HubUpdateChecker } from "../lib/hub-update/checker.mjs";
import { HubUpdater } from "../lib/hub-update/updater.mjs";
import { currentLabel, readBuild, setLink, versionApp } from "../lib/hub-update/layout.mjs";
import { buildToolProblems } from "../lib/hub-update/cli.mjs";
import { builderArgv } from "../lib/services/hub-update.mjs";
import { cleanup, tempHome } from "./helpers.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);

function writeExec(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// A release tree as the formula installs it into libexec: VERSION, COMMIT, the CLI, the build script double, a daemon
// self-test double, a built-in plugin. Extra: .git and app/.build that must not reach Versions.
function writeBrewTree(dir, { version, commit = C1, cdhash = B } = {}) {
  writeFileSync(join(mkdir(dir), "VERSION"), `${version}\n`);
  if (commit) writeFileSync(join(dir, "COMMIT"), `${commit}\n`);
  else rmFile(join(dir, "COMMIT"));
  writeExec(join(dir, "daemon", "bin", "agenthub"), "#!/usr/bin/env node\n");
  writeExec(join(dir, "daemon", "bin", "agenthubd"), `if (process.argv.includes("--self-test")) { console.log(JSON.stringify({ ok: true, version: ${JSON.stringify(version)}, native: false })); process.exit(0); }\n`);
  writeExec(
    join(dir, "scripts", "build-release.sh"),
    `#!/bin/bash
set -e
[ "$1" = "--out" ] || exit 2
echo "brew build double ${version}"
mkdir -p "$2/AgentHub.app/Contents/MacOS"
printf '#!/bin/sh\\n' > "$2/AgentHub.app/Contents/MacOS/AgentHub"
chmod +x "$2/AgentHub.app/Contents/MacOS/AgentHub"
echo ${cdhash} > "$2/AgentHub.app/Contents/TEST-CDHASH"
`,
  );
  writeExec(join(dir, "plugins", "demo", "demo.60s.sh"), `#!/bin/sh\necho brew-${version}\n`);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, "app", ".build"), { recursive: true });
  writeFileSync(join(dir, "app", ".build", "junk"), "x");
  return dir;
}
function mkdir(d) {
  mkdirSync(d, { recursive: true });
  return d;
}
function rmFile(p) {
  try {
    cleanup(p);
  } catch {}
}

// A brew prefix double: Cellar/agent-hub/<v>/libexec and opt/agent-hub → ../Cellar/agent-hub/<v> (what `brew upgrade` relinks).
function brewPrefix(root) {
  const prefix = mkdir(join(root, "brew"));
  const opt = join(prefix, "opt", "agent-hub");
  return {
    prefix,
    libexec: join(opt, "libexec"),
    install(version, opts = {}) {
      const keg = join(prefix, "Cellar", "agent-hub", version);
      writeBrewTree(join(keg, "libexec"), { version, ...opts });
      mkdir(dirname(opt));
      rmFile(opt);
      symlinkSync(join("..", "Cellar", "agent-hub", version), opt);
      return join(keg, "libexec");
    },
  };
}

// ---------- helpers of brew.mjs ----------

test("brew source: VERSION and COMMIT from the tree; a broken tree is refused with a reason; the opt path is found from the keg", () => {
  const root = tempHome("ah-brew-src-");
  try {
    const b = brewPrefix(root);
    const keg = b.install("0.2.0");
    assert.deepEqual(readBrewSource(b.libexec), { ok: true, dir: b.libexec, version: "0.2.0", commit: C1 });
    writeFileSync(join(keg, "COMMIT"), "not a commit\n");
    assert.equal(readBrewSource(b.libexec).commit, null, "garbage in COMMIT — no commit, not an error");
    assert.equal(readBrewSource(join(root, "nope")).ok, false);
    assert.equal(readBrewSource("relative/path").why, "not-absolute");
    writeFileSync(join(keg, "VERSION"), "garbage\n");
    assert.deepEqual(readBrewSource(b.libexec), { ok: false, why: "no VERSION" });
    // the CLI runs from the real keg path (node resolves the bin symlink): → the stable opt link
    assert.equal(brewDirOf(keg), b.libexec);
    assert.equal(brewDirOf(join(root, "elsewhere")), null, "not a keg");
    // the opt link already points to another version (brew upgrade done, this CLI is the old keg) — not ours
    const keg2 = b.install("0.3.0");
    assert.equal(brewDirOf(keg), null);
    assert.equal(brewDirOf(keg2), b.libexec);
  } finally {
    cleanup(root);
  }
});

test("brew setting: services.hubUpdate.brew is written and removed without touching the rest of config.json; the daemon reads it fresh", () => {
  const root = tempHome("ah-brew-cfg-");
  try {
    const cfgPath = join(root, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ requirements: { app: "x" }, services: { hubUpdate: { remote: "/o.git" } } }));
    const read = brewSettingReader();
    assert.equal(read(cfgPath), null);
    assert.equal(writeBrewSetting(cfgPath, "/opt/homebrew/opt/agent-hub/libexec"), true);
    assert.equal(writeBrewSetting(cfgPath, "/opt/homebrew/opt/agent-hub/libexec"), false, "same value — no write");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.requirements.app, "x");
    assert.equal(cfg.services.hubUpdate.remote, "/o.git");
    assert.equal(brewSetting(cfg), "/opt/homebrew/opt/agent-hub/libexec");
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
    assert.equal(read(cfgPath), "/opt/homebrew/opt/agent-hub/libexec", "read fresh after the file changed");
    assert.equal(writeBrewSetting(cfgPath, null), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).services, { hubUpdate: { remote: "/o.git" } });
    assert.equal(writeBrewSetting(join(root, "missing.json"), null), false, "no config and nothing to remove — no file is created");
    assert.ok(!existsSync(join(root, "missing.json")));
    assert.equal(brewSetting({ services: { hubUpdate: { brew: "relative" } } }), null, "only an absolute path");
    // the copy filter: VCS data and old build products stay behind
    const f = brewCopyFilter("/k/libexec");
    assert.equal(f("/k/libexec/daemon/lib/core.mjs"), true);
    assert.equal(f("/k/libexec/.git"), false);
    assert.equal(f("/k/libexec/app/.build"), false);
    assert.equal(f("/k/libexec/daemon/native/peercred/build"), false);
    assert.equal(f("/k/libexec/plugins/x/.DS_Store"), false);
  } finally {
    cleanup(root);
  }
});

// ---------- the builder ----------

test("build from a Homebrew tree: copied without .git and app/.build (a read-only keg too), commit from COMMIT, build.json.brew; a changed tree — commit-mismatch or version-mismatch", async () => {
  const root = tempHome("ah-brew-build-");
  try {
    const b = brewPrefix(root);
    const keg = b.install("0.2.0");
    // brew may leave files read-only — the build writes into the copy
    chmodSync(join(keg, "VERSION"), 0o444);
    chmodSync(join(keg, "plugins", "demo"), 0o555);
    const home = mkdir(join(root, "hub"));
    const steps = [];
    const build = await buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "brew", dir: b.libexec, commit: C1 }, codeOf: testCodeOf, logPath: join(home, "logs", "b.log"), onStep: (s) => steps.push(s) });
    assert.deepEqual(steps, ["clone", "build", "verify", "selftest", "promote"]);
    assert.equal(build.cdhash, B);
    assert.equal(build.commit, C1);
    assert.equal(build.tag, null);
    assert.equal(build.origin, null);
    assert.equal(readBuild(home, "0.2.0").brew, b.libexec);
    const src = join(home, "Versions", "0.2.0", "src");
    assert.ok(existsSync(join(src, "plugins", "demo", "demo.60s.sh")));
    assert.ok(!existsSync(join(src, ".git")), "no VCS data");
    assert.ok(!existsSync(join(src, "app", ".build")));
    assert.match(readFileSync(join(home, "logs", "b.log"), "utf8"), /sources from Homebrew: .*version 0\.2\.0/);
    chmodSync(join(keg, "plugins", "demo"), 0o755);

    // brew changed the tree between the check and the build: another commit, another version, the formula is gone
    await assert.rejects(buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "brew", dir: b.libexec, commit: C2 }, codeOf: testCodeOf }), (e) => e.code === "hub-update:commit-mismatch");
    await assert.rejects(buildVersion({ home, label: "0.2.1", version: "0.2.1", source: { kind: "brew", dir: b.libexec }, codeOf: testCodeOf }), (e) => e.code === "hub-update:version-mismatch");
    await assert.rejects(buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "brew", dir: join(root, "gone") }, codeOf: testCodeOf }), (e) => e.code === "hub-update:brew-missing");
    assert.deepEqual(readdirSync(join(home, "Versions")), ["0.2.0"], "no staging left after failures");
  } finally {
    cleanup(root);
  }
});

// ---------- the update check ----------

test("check in brew mode: no git at all — the version is read from the brew tree (live after brew upgrade), one notification per version; the tree is gone — hub-update:brew-missing", async () => {
  const root = tempHome("ah-brew-check-");
  try {
    const b = brewPrefix(root);
    b.install("0.1.0");
    const home = mkdir(join(root, "hub"));
    const events = [];
    const journal = [];
    let dir = b.libexec;
    const c = new HubUpdateChecker({
      home,
      journal: (e) => journal.push(e),
      emit: (e) => events.push(e),
      remote: () => "/origin.git",
      brew: () => dir,
      current: () => "0.1.0",
      testMode: true,
      listTags: async () => {
        throw new Error("git must not be asked in brew mode");
      },
    });
    let info = c.info();
    assert.equal(info.source, "brew");
    assert.equal(info.brew, b.libexec);
    assert.equal(info.configured, true);
    assert.equal(info.available, null, "brew has the same version");
    const r1 = await c.check("manual");
    assert.equal(r1.ok, true);
    assert.ok(c.info().checkedAt);
    assert.equal(events.length, 0);

    // brew upgrade agent-hub → 0.2.0: the shell sees it right away, the check notifies once
    b.install("0.2.0", { commit: C2 });
    assert.deepEqual(c.info().available, { version: "0.2.0", tag: null, commit: C2, brew: true });
    await c.check("manual");
    await c.check("timer");
    assert.deepEqual(events.filter((e) => e.type === "hub-update.available").map((e) => e.version), ["0.2.0"]);
    assert.ok(journal.some((e) => e.type === "hub-update-check" && e.source === "brew" && e.available === "0.2.0"));

    // brew uninstall agent-hub while the hub stays: an error with a code, no available version
    dir = join(root, "brew", "opt", "gone", "libexec");
    const r2 = await c.check("manual");
    assert.equal(r2.ok, false);
    assert.equal(r2.error, "hub-update:brew-missing");
    info = c.info();
    assert.equal(info.error, "hub-update:brew-missing");
    assert.equal(info.available, null);

    // the setting removed (git mode again) — the old git path, the brew fields say so
    dir = null;
    assert.equal(c.info().source, "git");
    assert.equal(c.info().brew, null);
    c.stop();
  } finally {
    cleanup(root);
  }
});

// ---------- the update itself ----------

function seedVersion(home, label, cdhash) {
  const dir = join(home, "Versions", label);
  writeBrewTree(join(dir, "src"), { version: label, cdhash });
  writeExec(join(dir, "AgentHub.app", "Contents", "MacOS", "AgentHub"), "#!/bin/sh\n");
  writeFileSync(join(dir, "AgentHub.app", "Contents", "TEST-CDHASH"), cdhash + "\n");
  writeFileSync(join(dir, "build.json"), JSON.stringify({ ok: true, label, version: label, tag: null, commit: null, origin: null, cdhash, requirement: cdhashRequirement(cdhash), builtAt: "2026-11-01T00:00:00.000Z" }));
}

test("\"Update\" in brew mode: the builder gets the brew directory (no tag, no origin), a release without a commit passes verification, the usual switch follows", async () => {
  const root = tempHome("ah-brew-upd-");
  try {
    const home = mkdir(join(root, "hub"));
    seedVersion(home, "0.1.0", A);
    setLink(join(home, "Versions", "current"), "0.1.0");
    const req = cdhashRequirement(A);
    writeFileSync(join(home, "config.json"), JSON.stringify({ requirements: { app: req }, appPin: { requirementSha: requirementSha(req), by: "agenthub pin-app", path: versionApp(home, "0.1.0") } }), { mode: 0o600 });
    const brewDir = "/opt/homebrew/opt/agent-hub/libexec";
    const available = { version: "0.2.0", tag: null, commit: null, brew: true };
    const checker = { available: () => available, brewDir: () => brewDir, remote: () => null, info: () => ({ enabled: true, available, source: "brew" }), stop() {}, claimReadyNotice: () => false };
    const calls = [];
    const jobs = [];
    const u = new HubUpdater({
      home,
      self: "0.1.0",
      version: "0.1.0",
      journal: () => {},
      emit: () => {},
      estop: () => false,
      life: { begin: () => calls.push("begin"), abort: () => {}, restart: () => calls.push("restart"), checkPin: () => {}, appConnections: () => [], updating: () => false },
      checker,
      codeOf: testCodeOf,
      opts: { appQuitMs: 20, deadlineMs: 60_000, launchDelayMs: 20 },
      spawnBuilder: (job) => {
        jobs.push(job);
        seedVersion(home, job.label, B);
        return { pid: 1, done: Promise.resolve({ code: 0, out: JSON.stringify({ ok: true, build: readBuild(home, job.label) }) + "\n" }) };
      },
      spawnWatchdog: () => null,
      terminate: () => {},
      relaunchApp: () => {},
      launchApp: async () => {},
      killApp: async () => {},
      hasSupervisor: () => true,
      processAlive: () => false,
    });
    assert.throws(() => u.install("0.3.0"), (e) => e.code === "hub-update:unknown-version");
    u.install("0.2.0", { class: "app", pid: 1 });
    await u.running;
    assert.equal(jobs[0].brew, brewDir);
    assert.equal(jobs[0].tag, null);
    assert.equal(jobs[0].remote, null);
    assert.equal(currentLabel(home), "0.2.0");
    assert.deepEqual(calls, ["begin", "restart"]);
    // the builder's argv: --brew <dir> instead of --tag/--remote-stdin; the commit only when known
    const argv = builderArgv(home, { label: "0.2.0", version: "0.2.0", brew: brewDir, commit: null, log: "/l.log" });
    assert.ok(argv.includes("--brew") && argv[argv.indexOf("--brew") + 1] === brewDir);
    assert.ok(!argv.includes("--remote-stdin") && !argv.includes("--tag") && !argv.includes("--commit"));
    assert.ok(builderArgv(home, { label: "0.2.0", version: "0.2.0", brew: brewDir, commit: C1, log: "/l.log" }).includes(C1));
    u.stop();
  } finally {
    cleanup(root);
  }
});

// ---------- the CLI: agenthub setup / hub install --brew ----------

function cliWorld(root, lang = "en") {
  const fakebin = mkdir(join(root, "fakebin"));
  writeExec(join(fakebin, "xcode-select"), '#!/bin/sh\n[ -n "$FAKE_NO_CLT" ] && exit 2\necho /Library/Developer/CommandLineTools\n');
  writeExec(join(fakebin, "xcrun"), '#!/bin/sh\ncase "$*" in\n  *--show-sdk-version*) echo "${FAKE_SDK:-26.0}" ;;\n  "--find swift") echo /usr/bin/swift ;;\n  "--find clang") echo /usr/bin/clang ;;\n  *) exit 1 ;;\nesac\n');
  const hub = mkdir(join(root, "hub"));
  const env = (extra = {}) => {
    const e = { ...process.env, HOME: mkdir(join(root, "home")), AGENTHUB_HOME: hub, AGENTHUB_SYSTEM_LANG: lang, PATH: `${fakebin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: mkdir(join(root, "tmp")), ...extra };
    delete e.NODE_OPTIONS;
    delete e.AGENTHUB_LANG;
    delete e.AGENTHUB_TEST_LAUNCHCTL;
    return e;
  };
  const run = (args, extra = {}) => spawnSync(process.execPath, [join(DAEMON_DIR, "bin", "agenthub"), ...args], { encoding: "utf8", env: env(extra), timeout: 60_000 });
  return { hub, run };
}

test("CLI: hub install --brew — built from the brew tree, pinned, the update source recorded; repeat — fine; brew has a newer version — the hub follows brew and the Update button installs it; status and uninstall speak of brew", () => {
  const root = tempHome("ah-brew-cli-");
  try {
    const b = brewPrefix(root);
    b.install("0.2.0");
    const w = cliWorld(root);
    const cfg = () => JSON.parse(readFileSync(join(w.hub, "config.json"), "utf8"));

    const plan = w.run(["hub", "install", "--brew", b.libexec, "--no-launchd"]);
    assert.equal(plan.status, 0, plan.stderr + plan.stdout);
    assert.match(plan.stdout, /source:\s+Homebrew — /);
    assert.match(plan.stdout, /version:\s+0\.2\.0 \(Homebrew formula, commit 1111111\)/);
    assert.match(plan.stdout, /from the Homebrew tree/);
    assert.match(plan.stdout, /new versions come from Homebrew: brew upgrade agent-hub/);
    assert.ok(!existsSync(join(w.hub, "Versions")), "the plan builds nothing");

    const r = w.run(["hub", "install", "--brew", b.libexec, "--no-launchd", "--apply", "--yes"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(currentLabel(w.hub), "0.2.0");
    assert.equal(readBuild(w.hub, "0.2.0").brew, b.libexec);
    assert.equal(readBuild(w.hub, "0.2.0").commit, C1);
    assert.equal(cfg().services.hubUpdate.brew, b.libexec, "the update source is Homebrew");
    assert.equal(cfg().requirements.app, cdhashRequirement(B));
    assert.match(r.stdout, /Updates:\s+brew upgrade agent-hub — then the hub offers Update/);
    assert.match(r.stdout, /agenthub uninstall --apply, then brew uninstall agent-hub/);
    assert.match(readFileSync(join(w.hub, "journal.jsonl"), "utf8"), /"type":"hub-update-cli".*"op":"brew-source"/);

    const again = w.run(["hub", "install", "--brew", b.libexec, "--no-launchd", "--apply", "--yes"]);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /updates:\s+from Homebrew/);
    assert.match(again.stdout, /is fine — nothing to do\. New versions: brew upgrade agent-hub/);

    const st = w.run(["hub", "status"]);
    assert.match(st.stdout, /updates:\s+from Homebrew — .*brew has 0\.2\.0/);

    // brew upgrade agent-hub → 0.3.0: setup does not switch by itself — the Update button does (trial run, rollback)
    b.install("0.3.0");
    const newer = w.run(["hub", "install", "--brew", b.libexec, "--no-launchd", "--apply", "--yes"]);
    assert.equal(newer.status, 0, newer.stderr + newer.stdout);
    assert.match(newer.stdout, /already takes new versions from Homebrew.*press Update/);
    assert.equal(currentLabel(w.hub), "0.2.0");

    const un = w.run(["uninstall", "--apply", "--yes", "--no-launchd"]);
    assert.equal(un.status, 0, un.stderr + un.stdout);
    assert.match(un.stdout, /after that remove the formula: brew uninstall agent-hub/);
    assert.match(un.stdout, /Homebrew: what's left is the formula — brew uninstall agent-hub/);
    assert.equal(brewSetting(cfg()), null, "the brew source is cleared with the install");
  } finally {
    cleanup(root);
  }
});

test("CLI: a git-installed hub and brew with a newer version — setup switches the update source to brew; the installer from git switches it back; texts in Russian", () => {
  const root = tempHome("ah-brew-cli2-");
  try {
    const b = brewPrefix(root);
    b.install("0.2.0");
    const w = cliWorld(root, "ru");
    // installed 0.1.0 (from git, say): the same Versions layout
    seedVersion(w.hub, "0.1.0", A);
    setLink(join(w.hub, "Versions", "current"), "0.1.0");
    writeFileSync(join(w.hub, "config.json"), JSON.stringify({ services: { hubUpdate: { remote: "/o.git" } } }), { mode: 0o600 });
    const plan = w.run(["hub", "install", "--brew", b.libexec, "--no-launchd"]);
    assert.equal(plan.status, 0, plan.stderr + plan.stdout);
    assert.match(plan.stdout, /С --apply хаб начнёт брать версии из Homebrew/);
    const r = w.run(["hub", "install", "--brew", b.libexec, "--no-launchd", "--apply", "--yes"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Готово: хаб берёт новые версии из Homebrew.*нажмите «Обновить»/);
    const cfg = JSON.parse(readFileSync(join(w.hub, "config.json"), "utf8"));
    assert.equal(cfg.services.hubUpdate.brew, b.libexec);
    assert.equal(cfg.services.hubUpdate.remote, "/o.git", "other settings stay");
    assert.equal(currentLabel(w.hub), "0.1.0", "no switch from the CLI");
    const st = w.run(["hub", "status"]);
    assert.match(st.stdout, /обновления:\s+из Homebrew — .*в brew 0\.2\.0/);

    // the installer from git (the same version 0.1.0 in origin) — the repair switches the update source back to git tags
    const repo = mkdir(join(root, "repo"));
    const git = (...a) => execFileSync("/usr/bin/git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    execFileSync("/usr/bin/git", ["init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "VERSION"), "0.1.0\n");
    git("add", "-A");
    git("commit", "-q", "-m", "0.1.0");
    git("tag", "v0.1.0");
    const back = w.run(["hub", "install", "--origin", repo, "--no-launchd", "--apply", "--yes"]);
    assert.equal(back.status, 0, back.stderr + back.stdout);
    assert.match(back.stdout, /обновления:\s+из Homebrew — переключить на git-теги/);
    assert.match(back.stdout, /обновления теперь из git-тегов/);
    assert.equal(brewSetting(JSON.parse(readFileSync(join(w.hub, "config.json"), "utf8"))), null);
  } finally {
    cleanup(root);
  }
});

test("CLI: setup outside Homebrew, --brew with --origin, no Command Line Tools — clear refusals before any build", () => {
  const root = tempHome("ah-brew-cli3-");
  try {
    const b = brewPrefix(root);
    b.install("0.2.0");
    const w = cliWorld(root);
    // this repository's CLI does not run from a brew keg
    const s = w.run(["setup", "--no-launchd", "--yes"]);
    assert.equal(s.status, 2, s.stderr + s.stdout);
    assert.match(s.stderr, /doesn't run from Homebrew.*\n.*brew install KenseiTheOne\/tap\/agent-hub, then agenthub setup/);
    const both = w.run(["hub", "install", "--brew", b.libexec, "--origin", "/o.git", "--no-launchd"]);
    assert.equal(both.status, 64);
    const bad = w.run(["hub", "install", "--brew", join(root, "nope"), "--no-launchd"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not an Agent Hub source tree/);
    const noClt = w.run(["hub", "install", "--brew", b.libexec, "--no-launchd", "--apply", "--yes"], { FAKE_NO_CLT: "1" });
    assert.equal(noClt.status, 3, noClt.stderr + noClt.stdout);
    assert.match(noClt.stderr, /Command Line Tools .*xcode-select --install/);
    assert.ok(!existsSync(join(w.hub, "Versions")));
    // the same check as a function: an old SDK
    assert.deepEqual(buildToolProblems({ run: (cmd, args) => (args.includes("--show-sdk-version") ? "15.4" : "/x") }).length, 1);
    assert.deepEqual(buildToolProblems({ run: () => "26.1" }), []);
  } finally {
    cleanup(root);
  }
});
