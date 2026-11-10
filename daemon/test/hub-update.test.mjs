// Hub auto-update (docs/hub-updates.md): version — a single source of truth, tag discovery (a bare-repository
// double of origin), version comparison, building into Versions in a temporary AGENTHUB_HOME (a build-release.sh double instead of
// swift), atomic pointer switch, rollback at every step, check schedule and backoff, "Check
// now", permissions (app only, hub pause), the trial-run watchdog, migration from a working folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, chmodSync, rmSync, utimesSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DAEMON_DIR, REPO_DIR, installOf, loadConfig } from "../lib/config.mjs";
import { Core } from "../lib/core.mjs";
import { createPeer } from "../lib/peer.mjs";
import { startServer } from "../lib/server.mjs";
import { cdhashRequirement, pinFingerprint, requirementSha } from "../lib/app-pin.mjs";
import { VERSION, compareVersions, isLabel, parseSemver, readVersion, tagVersion } from "../lib/version.mjs";
import { NOTES_LIMITS, cleanNotesText, fetchTagNotes, hasUserinfo, latestRelease, listTags, parseLsRemote, parseTagNotes, redactText, redactUrl, usableOrigin } from "../lib/hub-update/remote.mjs";
import { HubUpdateChecker, validRelease } from "../lib/hub-update/checker.mjs";
import { buildVersion, testCodeOf } from "../lib/hub-update/build.mjs";
import { readBundleCodeAsync } from "../lib/app-sign.mjs";
import { builderArgv, relaunchPrevious } from "../lib/services/hub-update.mjs";
import { currentLabel, hubPaths, listVersions, pinnedCdhash, previousLabel, prune, readBuild, readHistory, readLink, rememberPin, setLink, versionApp } from "../lib/hub-update/layout.mjs";
import { applySwitch, capturePrev, isSnapshot, restoreFiles } from "../lib/hub-update/switch.mjs";
import { readInstall, restorePinOf, rollbackTrial, runWatch, startupVerdict, transitionInstall, writeInstall } from "../lib/hub-update/trial.mjs";
import { HubUpdater } from "../lib/hub-update/updater.mjs";
import { daemonLocation, plistXml } from "../lib/launchd.mjs";
import { hubDetail, hubLabel } from "../lib/services/push.mjs";
import * as PLATFORM_MOD from "../lib/platform.mjs";
import { cleanup, req, tempHome, waitFor } from "./helpers.mjs";

const A = "a".repeat(40); // cdhash of the previous build
const B = "b".repeat(40); // cdhash of the new one
const C = "c".repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env0 = () => {
  const e = { ...process.env };
  delete e.NODE_OPTIONS;
  return e;
};
const GIT = "/usr/bin/git";
const git = (cwd, ...args) => execFileSync(GIT, ["-C", cwd, ...args], { encoding: "utf8", env: { ...env0(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

// ---------- release sources double ----------
// Version tree: VERSION, scripts/build-release.sh (a swift build double: a bundle with TEST-CDHASH), daemon/bin/agenthubd
// (a self-test double), a built-in plugin. The doubles' behavior is set by options.
function writeTree(dir, { version, cdhash = B, buildExit = 0, selfVersion = version, selfOk = true, plugin = "v" + version } = {}) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "daemon", "bin"), { recursive: true });
  mkdirSync(join(dir, "plugins", "demo"), { recursive: true });
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  writeFileSync(
    join(dir, "scripts", "build-release.sh"),
    `#!/bin/bash
set -e
[ "$1" = "--out" ] || exit 2
echo "двойник сборки ${version}"
mkdir -p app/.build && echo junk > app/.build/x
${buildExit ? `echo "ошибка компиляции" >&2; exit ${buildExit}` : ""}
mkdir -p "$2/AgentHub.app/Contents/MacOS"
printf '#!/bin/sh\\n' > "$2/AgentHub.app/Contents/MacOS/AgentHub"
chmod +x "$2/AgentHub.app/Contents/MacOS/AgentHub"
echo ${cdhash} > "$2/AgentHub.app/Contents/TEST-CDHASH"
`,
  );
  chmodSync(join(dir, "scripts", "build-release.sh"), 0o755);
  writeFileSync(join(dir, "daemon", "bin", "agenthubd"), `if (process.argv.includes("--self-test")) { console.log(JSON.stringify({ ok: ${selfOk}, version: ${JSON.stringify(selfVersion)}, native: false })); process.exit(${selfOk ? 0 : 1}); }\n`);
  writeFileSync(join(dir, "plugins", "demo", "demo.60s.sh"), `#!/bin/sh\necho ${plugin}\n`);
  chmodSync(join(dir, "plugins", "demo", "demo.60s.sh"), 0o755);
}

// origin double: a working repository + a bare clone. release() — commit and tag (annotated by default), push.
function originWorld(root) {
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  mkdirSync(work, { recursive: true });
  execFileSync(GIT, ["init", "-q", "-b", "main", work]);
  execFileSync(GIT, ["init", "-q", "--bare", bare]);
  git(work, "remote", "add", "origin", bare);
  return {
    work,
    bare,
    release(version, opts = {}) {
      writeTree(work, { version, ...opts });
      git(work, "add", "-A");
      git(work, "commit", "-q", "-m", `release ${version}`);
      const tag = opts.tag ?? `v${version}`;
      if (opts.lightweight) git(work, "tag", tag);
      else git(work, "tag", "-a", tag, "-m", opts.message ?? tag);
      git(work, "push", "-q", "origin", "main", tag);
      return { tag, commit: git(work, "rev-parse", "HEAD") };
    },
  };
}

// An installed version "as after migration": Versions/<label> with build.json, src/plugins and the bundle.
function seedVersion(home, label, { cdhash = A, origin = null, plugin = "seed-" + label, commit = "1".repeat(40) } = {}) {
  const dir = join(home, "Versions", label);
  writeTree(join(dir, "src"), { version: label.replace(/-.*$/, ""), plugin });
  mkdirSync(join(dir, "AgentHub.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dir, "AgentHub.app", "Contents", "MacOS", "AgentHub"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "AgentHub.app", "Contents", "TEST-CDHASH"), cdhash + "\n");
  writeFileSync(join(dir, "build.json"), JSON.stringify({ ok: true, label, version: label.replace(/-.*$/, ""), tag: `v${label}`, commit, origin, cdhash, requirement: cdhashRequirement(cdhash), builtAt: "2026-11-01T00:00:00.000Z" }));
  return dir;
}

function pinConfig(home, label, cdhash, extra = {}) {
  const req = cdhashRequirement(cdhash);
  writeFileSync(join(home, "config.json"), JSON.stringify({ requirements: { app: req }, appPin: { requirementSha: requirementSha(req), by: "agenthub pin-app", path: versionApp(home, label) }, ...extra }, null, 2), { mode: 0o600 });
}

const readCfg = (home) => JSON.parse(readFileSync(join(home, "config.json"), "utf8"));

// ---------- version: a single source of truth ----------

test("version: VERSION is the only source; package.json, plugin.json and bundle.sh agree with it", () => {
  const v = readFileSync(join(REPO_DIR, "VERSION"), "utf8").trim();
  assert.equal(VERSION, v);
  assert.equal(readVersion(join(REPO_DIR, "VERSION")), v);
  assert.equal(JSON.parse(readFileSync(join(DAEMON_DIR, "package.json"), "utf8")).version, v, "scripts/set-version.sh writes package.json too");
  assert.equal(JSON.parse(readFileSync(join(REPO_DIR, "claude-plugin", ".claude-plugin", "plugin.json"), "utf8")).version, v);
  const bundle = readFileSync(join(REPO_DIR, "scripts", "bundle.sh"), "utf8");
  assert.doesNotMatch(bundle, /^VERSION="\d/m, "bundle.sh does not hardcode the version");
  assert.match(bundle, /\$ROOT\/VERSION/);
  // there is no version string in the daemon and bridge code any more
  for (const f of [join(DAEMON_DIR, "lib", "core.mjs"), join(REPO_DIR, "bridge", "agenthub-bridge.mjs")]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /VERSION = "\d+\.\d+\.\d+"/, f);
  }
});

test("version comparison: semver, pre-release lower than the release, dev labels lower than their release", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "numbers compare as numbers");
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1, "a numeric identifier is lower than a string one");
  assert.equal(compareVersions("0.1.0-dev.6ceb3d8", "0.1.0"), -1, "migration without a tag: v0.1.0 is already newer");
  assert.equal(compareVersions("0.1.0+build.5", "0.1.0"), 0, "build metadata is ignored");
  assert.equal(compareVersions("x", "0.1.0"), null);
  assert.equal(tagVersion("v0.2.0"), "0.2.0");
  assert.equal(tagVersion("v0.2.0-rc.1"), "0.2.0-rc.1");
  assert.equal(tagVersion("0.2.0"), null);
  assert.equal(tagVersion("v0.2"), null);
  assert.equal(tagVersion("release-1"), null);
  assert.ok(isLabel("0.1.0-dev.6ceb3d8.dirty"));
  assert.ok(!isLabel("../0.1.0"));
  assert.ok(!isLabel("current"));
  assert.deepEqual(parseSemver("1.2.3-rc.1").pre, ["rc", 1]);
});

// ---------- tag discovery ----------

test("ls-remote: annotated tag — the commit from ^{}, lightweight — its own; non-releases dropped; the highest newer than the current one", () => {
  const c1 = "1".repeat(40), c2 = "2".repeat(40), t2 = "3".repeat(40), c4 = "4".repeat(40);
  const text = `${c1}\trefs/tags/v0.1.0\n${t2}\trefs/tags/v0.2.0\n${c2}\trefs/tags/v0.2.0^{}\n${c4}\trefs/tags/v0.3.0-rc.1\n${c4}\trefs/tags/nightly\n${c4}\trefs/heads/main\n`;
  const tags = parseLsRemote(text);
  assert.deepEqual(tags.map((t) => [t.tag, t.commit]), [["v0.1.0", c1], ["v0.2.0", c2], ["v0.3.0-rc.1", c4]]);
  assert.equal(latestRelease(tags, "0.1.0").version, "0.2.0");
  assert.equal(latestRelease(tags, "0.1.0", { prerelease: true }).version, "0.3.0-rc.1");
  assert.equal(latestRelease(tags, "0.2.0"), null, "strictly newer");
  assert.equal(latestRelease(tags, "0.3.0"), null);
  assert.equal(latestRelease(tags, "0.1.0-dev.abc").version, "0.2.0");
});

test("tag discovery in the bare origin double; unreachable origin — error hub-update:remote", async () => {
  const root = tempHome("ah-hu-git-");
  try {
    const o = originWorld(root);
    const r1 = o.release("0.1.0", { lightweight: true });
    const r2 = o.release("0.2.0");
    git(o.work, "tag", "experiment");
    git(o.work, "push", "-q", "origin", "experiment");
    const tags = await listTags({ remote: o.bare });
    const by = Object.fromEntries(tags.map((t) => [t.tag, t.commit]));
    assert.deepEqual(Object.keys(by).sort(), ["v0.1.0", "v0.2.0"]);
    assert.equal(by["v0.1.0"], r1.commit);
    assert.equal(by["v0.2.0"], r2.commit, "annotated tag → the commit, not the tag object");
    await assert.rejects(listTags({ remote: join(root, "nope.git") }), (e) => e.code === "hub-update:remote");
    await assert.rejects(listTags({ remote: "--upload-pack=touch /tmp/x" }), (e) => e.code === "hub-update:remote");
    await assert.rejects(listTags({ remote: null }), (e) => e.code === "hub-update:not-configured");
  } finally {
    cleanup(root);
  }
});

// ---------- check: schedule, backoff, one notification per version, "Check now" ----------

function fakeTimers() {
  // check timers are real setTimeout; here only the "now" time for nextAt
  let t = Date.parse("2026-11-06T12:00:00Z");
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("release check: after firstDelay, then interval + jitter; errors — backoff 5→15→60 min; one notification per version (also after a restart)", async () => {
  const home = tempHome("ah-hu-chk-");
  try {
    const clock = fakeTimers();
    const events = [];
    const journal = [];
    let fail = 0;
    let tags = [{ tag: "v0.2.0", version: "0.2.0", commit: "2".repeat(40) }];
    const calls = [];
    const make = () =>
      new HubUpdateChecker({
        home,
        journal: (e) => journal.push(e),
        emit: (e) => events.push(e),
        remote: () => "/origin.git",
        current: () => "0.1.0",
        timing: { firstDelayMs: 60_000, intervalMs: 6 * 3600_000, jitterMs: 30 * 60_000, backoffMs: [5 * 60_000, 15 * 60_000, 3600_000] },
        random: () => 0.5,
        now: clock.now,
        listTags: async (o) => {
          calls.push(o.remote);
          if (fail-- > 0) throw Object.assign(new Error("no network"), { code: "hub-update:remote" });
          return tags;
        },
      });
    const c = make();
    c.start();
    // the first one — after a minute + jitter of up to a minute (0.5 × min(jitter, 1 min))
    assert.equal(c.nextAt - clock.now(), 60_000 + 30_000);
    c.stop();
    c.stopped = false;
    fail = 3;
    for (const want of [5 * 60_000, 15 * 60_000, 3600_000]) {
      const r = await c.check("timer");
      assert.equal(r.ok, false);
      assert.equal(c.info().error, "hub-update:remote");
      assert.equal(c.nextAt - clock.now(), want + Math.floor(0.5 * want * 0.1), `backoff ${want}`);
    }
    // the error repeats — a journal record only when the error changes (timer)
    assert.equal(journal.filter((e) => e.type === "hub-update-check").length, 1);
    const ok = await c.check("timer");
    assert.equal(ok.ok, true);
    assert.equal(c.nextAt - clock.now(), 6 * 3600_000 + 15 * 60_000, "interval + jitter");
    assert.equal(c.info().available.version, "0.2.0");
    assert.equal(c.info().error, null);
    assert.equal(events.filter((e) => e.type === "hub-update.available").length, 1);
    await c.check("timer");
    assert.equal(events.filter((e) => e.type === "hub-update.available").length, 1, "one version — one notification");
    c.stop();
    // a new instance (daemon restart) remembers notified versions (check.json)
    const c2 = make();
    await c2.check("timer");
    assert.equal(events.filter((e) => e.type === "hub-update.available").length, 1);
    tags = [...tags, { tag: "v0.3.0", version: "0.3.0", commit: "3".repeat(40) }];
    await c2.check("timer");
    assert.deepEqual(events.filter((e) => e.type === "hub-update.available").map((e) => e.version), ["0.2.0", "0.3.0"]);
    c2.stop();
  } finally {
    cleanup(home);
  }
});

test("release notes: annotated tag message — git fetch of the tag into a service mirror without tokens; lightweight — no notes; cache by tag object", async () => {
  const root = tempHome("ah-hu-notes-");
  try {
    const o = originWorld(join(root, "o"));
    o.release("0.1.0", { lightweight: true });
    o.release("0.2.0", { message: "Agent Hub 0.2.0: быстрее поповер\n\nПервая строка тела\x07\nВторая строка" });
    const home = join(root, "h");
    mkdirSync(home, { mode: 0o700 });
    const fetched = [];
    const make = (current = "0.1.0") =>
      new HubUpdateChecker({
        home,
        remote: () => o.bare,
        current: () => current,
        testMode: true,
        fetchNotes: async (a) => {
          fetched.push(a.tag);
          return fetchTagNotes(a);
        },
      });
    // "Check now" answers after ls-remote, the notes load afterwards (settled — wait for them)
    const chk = async (x) => {
      const res = await x.check("manual");
      await x.settled();
      return res;
    };
    const c = make();
    const r = await chk(c);
    assert.equal(r.ok, true);
    assert.deepEqual(c.info().available.notes, { subject: "Agent Hub 0.2.0: быстрее поповер", body: "Первая строка тела\nВторая строка" }, "control characters are stripped");
    assert.equal(c.info().available.object, undefined, "the tag object sha does not leak out");
    assert.deepEqual(fetched, ["v0.2.0"], "the current version's lightweight tag is not fetched — no notes");
    // the mirror is temporary: nothing is left in HubUpdate except check.json
    assert.deepEqual(readdirSync(join(home, "HubUpdate")).sort(), ["check.json"]);
    // a repeated check — from the cache (the same tag object), also after a restart (check.json)
    await chk(c);
    await chk(make());
    assert.deepEqual(fetched, ["v0.2.0"]);
    // the tag was rewritten (a new object) — the notes are re-read, the old ones are not shown
    git(o.work, "tag", "-f", "-a", "v0.2.0", "-m", "Agent Hub 0.2.0: исправлено описание");
    git(o.work, "push", "-q", "-f", "origin", "v0.2.0");
    await chk(c);
    assert.equal(c.info().available.notes.subject, "Agent Hub 0.2.0: исправлено описание");
    assert.deepEqual(fetched, ["v0.2.0", "v0.2.0"]);
    // the current version with an annotated tag — its notes are available too (for Settings)
    const cur = make("0.2.0");
    await chk(cur);
    assert.equal(cur.notesOf("0.2.0").subject, "Agent Hub 0.2.0: исправлено описание");
    assert.equal(cur.info().available, null);
    // the builder puts the notes into build.json (tagInfo.notes)
    const b = await buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "tag", remote: o.bare, tag: "v0.2.0" }, origin: o.bare, codeOf: testCodeOf });
    assert.equal(b.tagInfo.notes.subject, "Agent Hub 0.2.0: исправлено описание");
    // a mirror error is not a check error: journal hub-update-notes, retry on the next check
    const journal = [];
    const bad = new HubUpdateChecker({ home: join(root, "h2"), journal: (e) => journal.push(e), remote: () => o.bare, current: () => "0.1.0", testMode: true, fetchNotes: async () => Promise.reject(Object.assign(new Error("x"), { code: "hub-update:notes", detail: "network" })) });
    assert.equal((await chk(bad)).ok, true);
    assert.equal(bad.info().available.version, "0.2.0");
    assert.equal(bad.info().available.notes, undefined);
    assert.ok(journal.some((e) => e.type === "hub-update-notes" && e.ok === false && e.version === "0.2.0"));
  } finally {
    cleanup(root);
  }
});

test("\"Check now\": the answer comes right after ls-remote, release notes load afterwards within the shared budget; the notification — after the notes", async () => {
  const root = tempHome("ah-hu-notes-slow-");
  try {
    const o = originWorld(join(root, "o"));
    o.release("0.2.0", { message: "Agent Hub 0.2.0: тема" });
    const home = join(root, "h");
    mkdirSync(home, { mode: 0o700 });
    let release;
    const gate = new Promise((r) => (release = r));
    const calls = [];
    const events = [];
    const c = new HubUpdateChecker({
      home,
      remote: () => o.bare,
      current: () => "0.1.0",
      testMode: true,
      emit: (e) => events.push(e),
      fetchNotes: async (a) => {
        calls.push(a.timeoutMs);
        await gate; // the network hangs
        return { subject: "Agent Hub 0.2.0: тема", body: null };
      },
    });
    const t0 = Date.now();
    const r = await Promise.race([c.check("manual"), sleep(5000).then(() => "timeout")]);
    assert.notEqual(r, "timeout", "the answer does not wait for the notes");
    assert.equal(r.ok, true);
    assert.equal(r.available.version, "0.2.0");
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(calls.length, 1);
    assert.ok(calls[0] > 0 && calls[0] <= 15_000, `notes timeout comes from the shared budget: ${calls[0]}`);
    assert.ok(!events.some((e) => e.type === "hub-update.available"), "the notification waits for the notes");
    release();
    await c.settled();
    assert.equal(c.info().available.notes.subject, "Agent Hub 0.2.0: тема");
    assert.ok(events.some((e) => e.type === "hub-update.available" && e.version === "0.2.0"));
  } finally {
    cleanup(root);
  }
});

test("release notes: parsing the tag message — the subject is required, the body is trimmed, not a tag — null", () => {
  assert.deepEqual(parseTagNotes("tag\0Тема\0Тело\n\n\n\nещё\n"), { subject: "Тема", body: "Тело\n\nещё" });
  assert.equal(parseTagNotes("commit\0Тема\0"), null);
  assert.equal(parseTagNotes("tag\0   \0тело"), null);
  assert.equal(parseTagNotes(`tag\0${"я".repeat(500)}\0`).subject.length, NOTES_LIMITS.subject);
  assert.equal(cleanNotesText("a\u202eb\r\nc", 100), "ab\nc", "text direction overrides and CR are stripped");
});

test("install: builder steps (clone → build → verify) reach install.json and events; foreign steps are not accepted", async () => {
  const home = tempHome("ah-hu-steps-");
  try {
    installedWorld(home);
    const w = updaterWorld(home);
    let release;
    const gate = new Promise((r) => (release = r));
    w.builder = (job) => {
      seedVersion(home, job.label, { cdhash: B, commit: job.commit });
      return {
        pid: 4243,
        done: (async () => {
          for (const st of ["clone", "build", "evil", "verify"]) {
            job.onStep?.(st);
            await sleep(5);
          }
          await gate;
          return { code: 0, out: JSON.stringify({ ok: true, build: readBuild(home, job.label) }) + "\n" };
        })(),
      };
    };
    const u = w.make({ waiting: () => ({ cards: 0, sessions: 3 }), ...fastOpts() });
    u.install("0.2.0");
    await waitFor(() => readInstall(home).step === "verify");
    const steps = w.events.filter((e) => e.type === "hub-update.status").map((e) => e.hubUpdate.install.step);
    assert.deepEqual([...new Set(steps)], ["clone", "build", "verify"], "the \"evil\" step is not accepted");
    release();
    await u.running;
    // only sessions are waiting: ready with a breakdown
    assert.equal(readInstall(home).phase, "ready");
    assert.deepEqual([u.info().install.waiting, u.info().install.waitingCards, u.info().install.waitingSessions], [3, 0, 3]);
  } finally {
    cleanup(home);
  }
});

test("release check: switches and \"Check now\"; origin not set — no network", async () => {
  const home = tempHome("ah-hu-sw-");
  try {
    let setting = false;
    let cfgOn = true;
    let remote = "/origin.git";
    let calls = 0;
    const c = new HubUpdateChecker({
      home,
      remote: () => remote,
      current: () => "0.1.0",
      setting: () => setting,
      configAllows: () => cfgOn,
      testMode: true,
      timing: { firstDelayMs: 50 },
      listTags: async () => {
        calls++;
        return [{ tag: "v0.2.0", version: "0.2.0", commit: "2".repeat(40) }];
      },
    });
    assert.equal(c.info().enabled, false);
    assert.equal((await c.check("timer")).skipped, "disabled", "on the timer with the setting off — no network");
    assert.equal(calls, 0);
    const now = await c.check("manual");
    assert.equal(now.ok, true, "\"Check now\" — the human asked for it");
    assert.equal(calls, 1);
    assert.equal(now.available.version, "0.2.0");
    cfgOn = false;
    assert.equal((await c.check("manual")).skipped, "disabled", "config.json overrides the button");
    assert.equal(calls, 1);
    cfgOn = true;
    setting = true;
    remote = null;
    assert.equal((await c.check("manual")).skipped, "not-configured");
    assert.equal(calls, 1);
    assert.equal(c.info().configured, false);
    c.stop();
  } finally {
    cleanup(home);
  }
});

// ---------- building into Versions (build-release.sh double) ----------

test("build: clone the tag from origin, verify the commit and VERSION, build double, signature check, self-test, rename into Versions/<version>", async () => {
  const root = tempHome("ah-hu-b-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  try {
    const o = originWorld(join(root, "o"));
    const r = o.release("0.2.0");
    const log = join(home, "logs", "b.log");
    const steps = [];
    const b = await buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "tag", remote: o.bare, tag: r.tag, commit: r.commit }, origin: o.bare, logPath: log, codeOf: testCodeOf, onStep: (s) => steps.push(s) });
    assert.deepEqual(steps, ["clone", "build", "verify", "selftest", "promote"]);
    assert.equal(b.cdhash, B);
    assert.equal(b.requirement, cdhashRequirement(B));
    assert.equal(b.commit, r.commit);
    assert.equal(readBuild(home, "0.2.0").origin, o.bare);
    assert.ok(existsSync(join(home, "Versions", "0.2.0", "AgentHub.app", "Contents", "MacOS", "AgentHub")));
    assert.ok(!existsSync(join(home, "Versions", "0.2.0", "src", "app", ".build")), "intermediate swift files are removed");
    assert.deepEqual(readdirSync(join(home, "Versions")), ["0.2.0"], "no staging left");
    assert.match(readFileSync(log, "utf8"), /двойник сборки 0\.2\.0/);
    assert.equal(currentLabel(home), null, "the build does not switch the live install");
    assert.equal(b.tagInfo.annotated, true);
    assert.equal(b.tagInfo.subject, "release 0.2.0");
    assert.equal(b.tagInfo.branch, "main");
    assert.ok(!existsSync(join(home, "Versions", "0.2.0", "src", ".git", "FETCH_HEAD")), "the origin URL does not remain in the clone");
    assert.ok(!readFileSync(join(home, "Versions", "0.2.0", "src", ".git", "config"), "utf8").includes(o.bare), "remote is not written to .git/config");
    // the same version again — built anew: an existing Versions/<version> directory is not reused
    writeFileSync(join(home, "Versions", "0.2.0", "build.json"), JSON.stringify({ ...readBuild(home, "0.2.0"), cdhash: C, requirement: cdhashRequirement(C) }));
    const again = await buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "tag", remote: o.bare, tag: r.tag, commit: r.commit }, codeOf: testCodeOf });
    assert.equal(again.reuse, undefined);
    assert.equal(again.cdhash, B, "cdhash comes from the new build, not from a planted build.json");
    assert.equal(readBuild(home, "0.2.0").cdhash, B);
  } finally {
    cleanup(root);
  }
});

test("build: each error has its own code, staging is removed, Versions/<version> does not appear", async () => {
  const root = tempHome("ah-hu-bf-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  try {
    const o = originWorld(join(root, "o"));
    const cases = [
      ["0.2.1", { buildExit: 3 }, "hub-update:build-failed"],
      ["0.2.2", { selfOk: false }, "hub-update:selftest-failed"],
      ["0.2.3", { selfVersion: "9.9.9" }, "hub-update:version-mismatch"],
      ["0.2.4", { cdhash: "zz" }, "hub-update:verify-failed"],
    ];
    for (const [v, opts, code] of cases) {
      const r = o.release(v, opts);
      const log = join(home, "logs", `${v}.log`);
      await assert.rejects(buildVersion({ home, label: v, version: v, source: { kind: "tag", remote: o.bare, tag: r.tag, commit: r.commit }, logPath: log, codeOf: testCodeOf }), (e) => e.code === code, `${v} → ${code}`);
      assert.ok(!existsSync(join(home, "Versions", v)), v);
      assert.match(readFileSync(log, "utf8"), new RegExp(`error: ${code}`));
    }
    // VERSION in the tag does not match the tag
    const bad = o.release("0.3.0", { tag: "v0.3.1" });
    await assert.rejects(buildVersion({ home, label: "0.3.1", version: "0.3.1", source: { kind: "tag", remote: o.bare, tag: bad.tag, commit: bad.commit }, codeOf: testCodeOf }), (e) => e.code === "hub-update:version-mismatch");
    // the tag was rewritten after the check — wrong commit
    const r = o.release("0.4.0");
    await assert.rejects(buildVersion({ home, label: "0.4.0", version: "0.4.0", source: { kind: "tag", remote: o.bare, tag: r.tag, commit: "f".repeat(40) }, codeOf: testCodeOf }), (e) => e.code === "hub-update:commit-mismatch");
    // origin unreachable
    await assert.rejects(buildVersion({ home, label: "0.5.0", version: "0.5.0", source: { kind: "tag", remote: join(root, "nope.git"), tag: "v0.5.0" }, codeOf: testCodeOf }), (e) => e.code === "hub-update:clone-failed");
    assert.deepEqual(readdirSync(join(home, "Versions")).filter((n) => n.startsWith(".")), [], "no staging at all");
  } finally {
    cleanup(root);
  }
});

// ---------- switching and file rollback ----------

test("switch: the pointer is an atomic symlink rename; pin, previous and the built-in copy from the new version; rollback restores everything", () => {
  const home = tempHome("ah-hu-sw-");
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    seedVersion(home, "0.2.0", { cdhash: B });
    setLink(join(home, "Versions", "current"), "0.1.0");
    pinConfig(home, "0.1.0", A, { services: { push: { quietHours: null } } });
    const before = readFileSync(join(home, "config.json"), "utf8");
    const prev = capturePrev(home);
    assert.deepEqual([prev.current, prev.previous, prev.requirement], ["0.1.0", null, cdhashRequirement(A)]);
    applySwitch({ home, label: "0.2.0", prev });
    assert.equal(readlinkSync(join(home, "Versions", "current")), "0.2.0", "relative symlink");
    assert.equal(previousLabel(home), "0.1.0");
    const cfg = readCfg(home);
    assert.equal(cfg.requirements.app, cdhashRequirement(B));
    assert.equal(cfg.appPin.by, "agenthub hub-update");
    assert.equal(cfg.appPin.version, "0.2.0");
    assert.equal(cfg.appPin.path, versionApp(home, "0.2.0"));
    assert.equal(cfg.appPin.requirementSha, requirementSha(cdhashRequirement(B)));
    assert.deepEqual(cfg.services, { push: { quietHours: null } }, "the rest of the config is untouched");
    assert.equal(cfg.builtinPluginsDir, join(home, "Builtin"));
    assert.match(readFileSync(join(home, "Builtin", "demo", "demo.60s.sh"), "utf8"), /seed-0\.2\.0/);
    assert.deepEqual(readdirSync(join(home, "Versions")).filter((n) => n.includes(".tmp")), [], "no temporary links");
    // rollback
    const r = restoreFiles({ home, prev });
    assert.equal(r.ok, true);
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(previousLabel(home), null);
    const back = readCfg(home);
    assert.equal(back.requirements.app, JSON.parse(before).requirements.app);
    assert.deepEqual([back.appPin.requirementSha, back.appPin.path], [JSON.parse(before).appPin.requirementSha, JSON.parse(before).appPin.path]);
    assert.equal(back.appPin.by, "agenthub hub-update rollback", "the pin change journal says who restored it");
    assert.match(readFileSync(join(home, "Builtin", "demo", "demo.60s.sh"), "utf8"), /seed-0\.1\.0/);
  } finally {
    cleanup(home);
  }
});

test("switch: a failure at each step — what was done is rolled back, config.json and the pointer as before", () => {
  for (const failAt of ["pin", "link", "builtin"]) {
    const home = tempHome("ah-hu-swf-");
    try {
      seedVersion(home, "0.1.0", { cdhash: A });
      seedVersion(home, "0.2.0", { cdhash: B });
      setLink(join(home, "Versions", "current"), "0.1.0");
      pinConfig(home, "0.1.0", A);
      const before = readCfg(home);
      const prev = capturePrev(home);
      let build = readBuild(home, "0.2.0");
      if (failAt === "pin") build = { ...build, requirement: null };
      if (failAt === "link") {
        // a directory in place of previous: a symlink rename over it will fail
        mkdirSync(join(home, "Versions", "previous", "x"), { recursive: true });
      }
      if (failAt === "builtin") rmSync(join(home, "Versions", "0.2.0", "src", "plugins"), { recursive: true });
      assert.throws(() => applySwitch({ home, label: "0.2.0", build, prev }), (e) => e.code === "hub-update:switch-failed" && e.step === failAt, failAt);
      assert.equal(currentLabel(home), "0.1.0", `${failAt}: pointer in place`);
      const after = readCfg(home);
      assert.equal(after.requirements.app, before.requirements.app, `${failAt}: pin unchanged`);
      assert.deepEqual([after.appPin.requirementSha, after.appPin.path], [before.appPin.requirementSha, before.appPin.path]);
    } finally {
      cleanup(home);
    }
  }
});

test("Versions: list newest first, cleanup keeps current, previous and keep; staging and trash are removed", () => {
  const home = tempHome("ah-hu-pr-");
  try {
    for (const l of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.1.0-dev.abc1234"]) seedVersion(home, l);
    mkdirSync(join(home, "Versions", ".staging-0.5.0-1234"), { recursive: true });
    setLink(join(home, "Versions", "current"), "0.2.0");
    setLink(join(home, "Versions", "previous"), "0.1.0");
    assert.deepEqual(listVersions(home), ["0.4.0", "0.3.0", "0.2.0", "0.1.0", "0.1.0-dev.abc1234"]);
    const removed = prune(home, { keep: 3 });
    assert.deepEqual(removed.sort(), ["0.1.0-dev.abc1234", "0.3.0"]);
    assert.deepEqual(listVersions(home), ["0.4.0", "0.2.0", "0.1.0"]);
    assert.ok(!existsSync(join(home, "Versions", ".staging-0.5.0-1234")));
    assert.equal(readLink(join(home, "Versions", "nope")), null);
  } finally {
    cleanup(home);
  }
});

// ---------- in-process install (core doubles) ----------

function updaterWorld(home, { self = "0.1.0", estop = false, available = { version: "0.2.0", tag: "v0.2.0", commit: "2".repeat(40) } } = {}) {
  const w = { events: [], journal: [], calls: [], conns: [], estop, life: null, builder: null };
  w.life = {
    begin: () => w.calls.push("begin"),
    abort: () => w.calls.push("abort"),
    restart: () => w.calls.push("restart"),
    checkPin: () => w.calls.push("checkPin"),
    appConnections: () => w.conns,
    updating: () => false,
  };
  const readyNoticed = new Set();
  const checker = {
    available: () => available,
    remote: () => "/origin.git",
    info: () => ({ enabled: true, available }),
    check: async () => ({ ok: true }),
    stop() {},
    // once per version (the real memory is HubUpdate/check.json, test "ready: one notification…")
    claimReadyNotice: (label) => (readyNoticed.has(label) ? false : (readyNoticed.add(label), true)),
  };
  w.make = (over = {}) =>
    new HubUpdater({
      home,
      self,
      version: (self || "0.1.0").replace(/-.*$/, ""),
      journal: (e) => w.journal.push(e),
      emit: (e) => w.events.push(e),
      estop: () => w.estop,
      life: w.life,
      checker,
      codeOf: testCodeOf,
      opts: { appQuitMs: 50, deadlineMs: 60_000, launchDelayMs: 20 },
      spawnBuilder: (job) => {
        w.calls.push(`build:${job.label}`);
        return w.builder(job);
      },
      spawnWatchdog: () => {
        w.calls.push("watchdog");
        return 99999999;
      },
      terminate: (pid) => w.calls.push(`kill:${pid}`),
      relaunchApp: () => w.calls.push("relaunch"),
      launchApp: async (p) => w.calls.push(`launch:${p}`),
      killApp: async (p) => w.calls.push(`killApp:${p}`),
      hasSupervisor: () => false,
      processAlive: () => false,
      ...over,
    });
  // builder double: "built" — the version appeared in Versions
  w.okBuilder = (cd = B) => (job) => {
    seedVersion(home, job.label, { cdhash: cd, commit: job.commit });
    return { pid: 4242, done: Promise.resolve({ code: 0, out: JSON.stringify({ ok: true, build: readBuild(home, job.label) }) + "\n" }) };
  };
  return w;
}

test("install: build in a separate process → verify → the app quits → pin, pointer, built-ins → watchdog → restart (code 75); the new daemon confirms by the new app's stream", async () => {
  const home = tempHome("ah-hu-in-");
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    setLink(join(home, "Versions", "current"), "0.1.0");
    pinConfig(home, "0.1.0", A);
    const w = updaterWorld(home);
    w.builder = w.okBuilder();
    w.conns = [{ pid: 777 }];
    const u = w.make();
    assert.equal(u.info().blocked, null);
    const info = u.install("0.2.0", { class: "app", pid: 1 });
    assert.equal(info.install.phase, "building");
    assert.equal(info.blocked, "busy");
    assert.throws(() => u.install("0.2.0"), (e) => e.code === "hub-update:busy");
    // the app quits by itself on hub-update.restarting
    setTimeout(() => (w.conns = []), 10);
    await u.running;
    assert.deepEqual(w.calls, ["build:0.2.0", "begin", "checkPin", "watchdog", "restart"]);
    assert.ok(w.events.some((e) => e.type === "hub-update.restarting" && e.label === "0.2.0"));
    assert.equal(currentLabel(home), "0.2.0");
    assert.equal(previousLabel(home), "0.1.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(B));
    assert.ok(u.expectsPin(pinFingerprint(cdhashRequirement(B)).label), "the \"re-pinned\" push is suppressed for this change");
    assert.ok(!u.expectsPin(pinFingerprint(cdhashRequirement(C)).label));
    const st = readInstall(home);
    assert.equal(st.phase, "trial");
    assert.equal(st.prev.current, "0.1.0");
    assert.ok(Date.parse(st.deadlineAt) > Date.now());
    assert.ok(w.journal.some((e) => e.type === "hub-update-switch" && e.label === "0.2.0" && e.from === "0.1.0"));

    // the new daemon (label 0.2.0) after the restart
    const w2 = updaterWorld(home, { self: "0.2.0", available: null });
    const u2 = w2.make();
    assert.equal(u2.resume(), "confirm-wait");
    await sleep(60);
    assert.deepEqual(w2.calls, [`launch:${versionApp(home, "0.2.0")}`], "no supervision — the update service launches the app");
    u2.onAppStream();
    assert.equal(readInstall(home).phase, "done");
    const ev = w2.events.find((e) => e.type === "hub-update.installed");
    assert.deepEqual([ev.label, ev.from, ev.cdhash], ["0.2.0", "0.1.0", B]);
    assert.equal(u2.info().current.label, "0.2.0");
    assert.equal(u2.info().previous.label, "0.1.0");
    u2.stop();
  } finally {
    cleanup(home);
  }
});

test("install: the app did not quit by itself within appQuitMs — SIGTERM to its process; /shutdown during the switch does not stop the daemon", async () => {
  const home = tempHome("ah-hu-kill-");
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    setLink(join(home, "Versions", "current"), "0.1.0");
    pinConfig(home, "0.1.0", A);
    const w = updaterWorld(home);
    w.builder = w.okBuilder();
    w.conns = [{ pid: 777 }];
    const u = w.make();
    u.install("0.2.0");
    await u.running;
    assert.ok(w.calls.includes("kill:777"));
    assert.ok(w.journal.some((e) => e.type === "hub-update-app-terminated" && e.pid === 777));
  } finally {
    cleanup(home);
  }
  // core: during the switch runShutdown("shutdown") does nothing, runShutdown("update") restarts
  const core = Object.create(Core.prototype);
  core.updating = false;
  core.stopping = false;
  const seen = [];
  core.shutdownHandler = (r) => seen.push(r);
  core.beginUpdate();
  assert.equal(core.stopping, true, "app supervision does not interfere");
  core.runShutdown("shutdown");
  core.runShutdown("update");
  await sleep(10);
  assert.deepEqual(seen, ["update"]);
  core.abortUpdate();
  assert.deepEqual([core.updating, core.stopping], [false, false]);
});

test("install: a failure at each step — we stay on the previous version, pointer and pin unchanged, journal and a failed event", async () => {
  const cases = [
    ["build", (w) => (w.builder = () => ({ pid: 1, done: Promise.resolve({ code: 1, out: JSON.stringify({ ok: false, code: "hub-update:build-failed", detail: "build-release.sh → 1" }) }) })), "hub-update:build-failed", false],
    ["tampering after the build", (w) => (w.builder = (job) => {
      const r = w.okBuilder()(job);
      writeFileSync(join(home(w), "Versions", job.label, "AgentHub.app", "Contents", "TEST-CDHASH"), C);
      return r;
    }), "hub-update:verify-failed", false],
    ["bundle and build.json tampering after the build", (w) => (w.builder = (job) => {
      const r = w.okBuilder()(job);
      writeFileSync(join(home(w), "Versions", job.label, "AgentHub.app", "Contents", "TEST-CDHASH"), C);
      writeFileSync(join(home(w), "Versions", job.label, "build.json"), JSON.stringify({ ...readBuild(home(w), job.label), cdhash: C, requirement: cdhashRequirement(C) }));
      return r;
    }), "hub-update:verify-failed", false],
    ["the builder answered about another version", (w) => (w.builder = (job) => {
      seedVersion(home(w), job.label, { cdhash: B, commit: job.commit });
      return { pid: 1, done: Promise.resolve({ code: 0, out: JSON.stringify({ ok: true, build: { label: job.label, commit: "9".repeat(40), cdhash: B } }) }) };
    }), "hub-update:verify-failed", false],
    ["hub pause after the build", (w) => (w.builder = (job) => {
      const r = w.okBuilder()(job);
      w.estop = true;
      return r;
    }), "hub-update:estop", false],
    ["switch", (w) => (w.builder = (job) => {
      const r = w.okBuilder()(job);
      rmSync(join(home(w), "Versions", job.label, "src", "plugins"), { recursive: true });
      return r;
    }), "hub-update:switch-failed", true],
  ];
  const homes = new WeakMap();
  const home = (w) => homes.get(w);
  for (const [name, setup, code, switched] of cases) {
    const h = tempHome("ah-hu-fail-");
    try {
      seedVersion(h, "0.1.0", { cdhash: A });
      setLink(join(h, "Versions", "current"), "0.1.0");
      pinConfig(h, "0.1.0", A);
      const before = readCfg(h);
      const w = updaterWorld(h);
      homes.set(w, h);
      setup(w);
      const u = w.make();
      u.install("0.2.0");
      await u.running;
      const st = readInstall(h);
      assert.equal(st.phase, "failed", name);
      assert.equal(st.error, code, name);
      assert.equal(currentLabel(h), "0.1.0", `${name}: pointer unchanged`);
      assert.equal(readCfg(h).requirements.app, before.requirements.app, `${name}: pin unchanged`);
      assert.deepEqual([readCfg(h).appPin.requirementSha, readCfg(h).appPin.path], [before.appPin.requirementSha, before.appPin.path]);
      assert.ok(w.journal.some((e) => e.type === "hub-update-failed" && e.error === code), name);
      assert.ok(w.events.some((e) => e.type === "hub-update.failed" && e.error === code), name);
      assert.ok(!w.calls.includes("restart"), `${name}: the daemon does not restart`);
      if (switched) {
        assert.ok(w.calls.includes("abort"), "supervision is back in force");
        assert.ok(w.calls.includes("relaunch"), "the previous app is launched again");
        assert.ok(w.journal.some((e) => e.type === "hub-update-restore" && e.ok === true));
      }
      assert.equal(u.info().blocked, w.estop ? "estop" : null);
    } finally {
      cleanup(h);
    }
  }
});

test("install: permissions and state — not from an install, paused, busy, unknown or not newer version, no previous one", () => {
  const home = tempHome("ah-hu-g-");
  try {
    seedVersion(home, "0.2.0", { cdhash: A });
    setLink(join(home, "Versions", "current"), "0.2.0");
    // self = null: daemon from a working folder
    const u0 = updaterWorld(home, { self: null }).make();
    assert.equal(u0.info().blocked, "not-installed");
    assert.throws(() => u0.install("0.2.0"), (e) => e.code === "hub-update:not-installed");
    const w = updaterWorld(home, { self: "0.2.0", available: { version: "0.2.0", tag: "v0.2.0", commit: "2".repeat(40) } });
    const u = w.make();
    assert.throws(() => u.install("0.2.0"), (e) => e.code === "hub-update:not-newer");
    assert.throws(() => u.install("0.9.0"), (e) => e.code === "hub-update:unknown-version");
    assert.throws(() => u.rollback(), (e) => e.code === "hub-update:no-previous");
    w.estop = true;
    assert.equal(u.info().blocked, "estop");
    assert.throws(() => u.install("0.2.0"), (e) => e.code === "hub-update:estop");
    assert.throws(() => u.rollback("0.1.0"), (e) => e.code === "hub-update:estop");
  } finally {
    cleanup(home);
  }
});

test("rollback to the previous version: no build, the same switch path (op=rollback); after confirmation previous is the one we left", async () => {
  const home = tempHome("ah-hu-rb-");
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    seedVersion(home, "0.2.0", { cdhash: B });
    setLink(join(home, "Versions", "current"), "0.2.0");
    setLink(join(home, "Versions", "previous"), "0.1.0");
    pinConfig(home, "0.2.0", B);
    const w = updaterWorld(home, { self: "0.2.0", available: null });
    const u = w.make();
    assert.equal(u.info().previous.label, "0.1.0");
    // the hub never pinned build 0.1.0 (no history) — rolling back to it is not allowed
    assert.throws(() => u.rollback(null, { class: "app" }), (e) => e.code === "hub-update:untrusted-build");
    rememberPin(home, "0.1.0", { cdhash: A, op: "migrate" });
    u.rollback(null, { class: "app" });
    await u.running;
    assert.ok(!w.calls.some((c) => c.startsWith("build:")), "no build");
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(previousLabel(home), "0.2.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(A));
    assert.equal(readInstall(home).op, "rollback");
    assert.ok(w.calls.includes("restart"));
  } finally {
    cleanup(home);
  }
});

test("trial run: no confirmation by the deadline and no watchdog — the new daemon rolls back the files itself and restarts; the previous one closes the install as failed", async () => {
  const home = tempHome("ah-hu-tr-");
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    seedVersion(home, "0.2.0", { cdhash: B });
    setLink(join(home, "Versions", "current"), "0.1.0");
    pinConfig(home, "0.1.0", A);
    const prev = capturePrev(home);
    applySwitch({ home, label: "0.2.0", prev });
    writeInstall(home, { phase: "trial", op: "install", label: "0.2.0", from: "0.1.0", startedAt: "2026-11-06T10:00:00.000Z", deadlineAt: new Date(Date.now() + 80).toISOString(), watchdogPid: 12345, prev, log: "/x.log" });
    const w = updaterWorld(home, { self: "0.2.0", available: null });
    w.conns = [{ pid: 555 }];
    const u = w.make({ hasSupervisor: () => true });
    assert.equal(u.resume(), "confirm-wait");
    await waitFor(() => w.calls.includes("restart"), { timeoutMs: 2000 });
    assert.ok(w.calls.includes("kill:555"), "the new app is killed");
    assert.ok(w.calls.includes(`killApp:${versionApp(home, "0.2.0")}`), "and one that did not connect — by the version's bundle path");
    assert.ok(w.calls.indexOf(`killApp:${versionApp(home, "0.2.0")}`) < w.calls.indexOf("restart"));
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(A));
    assert.equal(readInstall(home).phase, "rolled-back");
    // the previous daemon after the restart
    const w0 = updaterWorld(home, { self: "0.1.0" });
    const u0 = w0.make();
    assert.equal(u0.resume(), "finalize-failed");
    assert.equal(readInstall(home).phase, "failed");
    assert.equal(readInstall(home).error, "hub-update:trial-timeout");
    assert.ok(w0.events.some((e) => e.type === "hub-update.failed" && e.label === "0.2.0" && e.log === "/x.log"));
    u.stop();
  } finally {
    cleanup(home);
  }
});

test("daemon start: an interrupted build — failed interrupted; an interrupted switch — file rollback and restart into the previous one", () => {
  assert.equal(startupVerdict({ phase: "trial", label: "0.2.0" }, "0.2.0"), "confirm-wait");
  assert.equal(startupVerdict({ phase: "trial", label: "0.2.0" }, "0.1.0"), "finalize-failed");
  assert.equal(startupVerdict({ phase: "done" }, "0.2.0"), null);
  const home = tempHome("ah-hu-st-");
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    seedVersion(home, "0.2.0", { cdhash: B });
    setLink(join(home, "Versions", "current"), "0.1.0");
    pinConfig(home, "0.1.0", A);
    mkdirSync(join(home, "Versions", ".staging-0.3.0-dead"), { recursive: true });
    writeInstall(home, { phase: "building", op: "install", label: "0.3.0", startedAt: "x" });
    const w = updaterWorld(home);
    assert.equal(w.make().resume(), "interrupted");
    assert.equal(readInstall(home).error, "hub-update:interrupted");
    assert.ok(!existsSync(join(home, "Versions", ".staging-0.3.0-dead")), "the interrupted build's staging is removed");
    // the switch broke off in the middle (the pointer is already on 0.2.0)
    const prev = capturePrev(home);
    applySwitch({ home, label: "0.2.0", prev });
    writeInstall(home, { phase: "switching", op: "install", label: "0.2.0", prev, startedAt: "y" });
    const w2 = updaterWorld(home, { self: "0.2.0" });
    assert.equal(w2.make().resume(), "restore");
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(A));
    assert.ok(w2.calls.includes("restart"), "daemon of the wrong version — restart into the previous one");
  } finally {
    cleanup(home);
  }
});

// ---------- watchdog ----------

test("watchdog: confirmation — exit; the daemon did not come up — kickstart; deadline passed — file rollback, kill the new app, kickstart -k", async () => {
  const home = tempHome("ah-hu-wd-");
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    seedVersion(home, "0.2.0", { cdhash: B });
    setLink(join(home, "Versions", "current"), "0.1.0");
    pinConfig(home, "0.1.0", A);
    const prev = capturePrev(home);
    applySwitch({ home, label: "0.2.0", prev });
    let t = 1000;
    const trial = (deadline) => writeInstall(home, { phase: "trial", label: "0.2.0", startedAt: "s1", deadlineAt: new Date(deadline).toISOString(), prev });
    // confirmed
    trial(10_000);
    let n = 0;
    const r1 = await runWatch({ home, now: () => t, sleep: async () => {
      t += 1000;
      if (++n === 3) writeInstall(home, { ...readInstall(home), phase: "done" });
    }, health: async () => true });
    assert.equal(r1.result, "confirmed");
    // the daemon is down longer than restartAfterMs — kickstart once; then the deadline — rollback
    trial(t + 30_000);
    const restarts = [];
    const killed = [];
    const r2 = await runWatch({ home, now: () => t, sleep: async () => (t += 2000), health: async () => false, restartAfterMs: 5000, restart: async (k) => restarts.push(k), killApp: async (p) => killed.push(p) });
    assert.equal(r2.result, "rolled-back");
    assert.deepEqual(restarts, ["kickstart", "restart"]);
    assert.deepEqual(killed, [versionApp(home, "0.2.0")]);
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(A));
    assert.equal(readInstall(home).phase, "rolled-back");
    assert.equal(readInstall(home).error, "hub-update:trial-timeout");
    // another install started — the watchdog leaves
    writeInstall(home, { phase: "trial", label: "0.2.0", startedAt: "s2", deadlineAt: new Date(t + 9e9).toISOString(), prev });
    let first = true;
    const r3 = await runWatch({ home, now: () => t, sleep: async () => {
      if (first) writeInstall(home, { ...readInstall(home), startedAt: "s3" });
      first = false;
    } });
    assert.equal(r3.result, "superseded");
    // the watchdog's rollback — the same files as restoreFiles
    const r4 = await rollbackTrial({ home, st: { label: "0.2.0", prev } });
    assert.equal(r4.ok, true);
  } finally {
    cleanup(home);
  }
});

// ---------- routes, permissions and the full path through the daemon ----------

// Process world: pid → {path, cdhash}; state.who — who is on the socket now (as in app-lifecycle.test.mjs).
function sysWorld() {
  const procs = new Map([[20, { path: "/usr/bin/curl" }]]);
  const state = { who: 20 };
  const uid = process.getuid();
  return {
    procs,
    state,
    sys: {
      available: true,
      peerPid: () => state.who,
      peerUid: () => uid,
      pidPath: (pid) => procs.get(pid)?.path ?? null,
      pidInfo: (pid) => (procs.has(pid) ? { pid, ppid: 1, uid, startSec: 1, startUsec: 0, tty: false } : null),
      procArgv: (pid) => procs.get(pid)?.argv ?? null,
      codeInfo: (pid) => (procs.get(pid)?.cdhash ? { flags: 0x3, cdhash: procs.get(pid).cdhash, identity: "com.kensei.agenthub", teamId: null } : null),
      codesignVerify: async (target, requirement) => {
        const p = procs.get(Number(target));
        return Boolean(p?.cdhash) && requirement === cdhashRequirement(p.cdhash);
      },
      fileId: (p) => p,
      myUid: () => uid,
      readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
      writeJson: () => {},
    },
  };
}

async function startHubAt(home, { sys, services, env = {} }) {
  const config = loadConfig({ env: { AGENTHUB_HOME: home, AGENTHUB_BUILTIN_PLUGINS: join(home, "no-builtin"), AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log"), AGENTHUB_CLAUDE_HOME: join(home, "claude-home"), AGENTHUB_SERVICES: services, ...env } });
  const core = new Core({ config, peer: createPeer({ config, sys }) });
  await core.init();
  const srv = await startServer(core);
  return { core, srv, sock: config.paths.socket, stop: async () => { await srv.close(); await core.stop(); } };
}

function openStream(sock) {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath: sock, path: "/events", agent: false }, (res) => {
      res.on("data", () => {});
      resolve({ close: () => r.destroy() });
    });
    r.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    r.end();
  });
}

test("daemon: /hub-update routes — read by app and cli, check/install/rollback/settings app only, paused — 423; \"Check now\" for plugins — app only", async () => {
  const root = tempHome("ah-hu-rt-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  const o = originWorld(join(root, "o"));
  o.release("0.2.0");
  seedVersion(home, "0.1.0", { cdhash: A, origin: o.bare });
  setLink(join(home, "Versions", "current"), "0.1.0");
  pinConfig(home, "0.1.0", A, { services: { hubUpdate: { test: { self: "0.1.0" }, updateCheck: { firstDelayMs: 3_600_000 } } } });
  const w = sysWorld();
  w.procs.set(10, { path: join(versionApp(home, "0.1.0"), "Contents", "MacOS", "AgentHub"), cdhash: A });
  const h = await startHubAt(home, { sys: w.sys, services: "hub-update,plugins" });
  try {
    const st = await req(h.sock, "GET", "/state");
    assert.equal(st.body.hubUpdate.label, "0.1.0");
    assert.equal(st.body.hubUpdate.installed, true);
    assert.equal(st.body.hubUpdate.configured, true, "origin comes from the current version's build.json");
    assert.equal((await req(h.sock, "GET", "/hub-update")).status, 200, "cli can read");
    for (const [m, p, b] of [["POST", "/hub-update/check"], ["POST", "/hub-update/install", { version: "0.2.0" }], ["POST", "/hub-update/rollback"], ["POST", "/hub-update/switch"], ["PUT", "/settings/hub-updates", { enabled: false }], ["POST", "/registry/check-updates"]]) {
      const r = await req(h.sock, m, p, b);
      assert.equal(r.status, 403, `cli: ${m} ${p}`);
    }
    w.state.who = 10; // the pinned app
    const chk = await req(h.sock, "POST", "/hub-update/check");
    assert.equal(chk.status, 200);
    assert.equal(chk.body.hubUpdate.available.version, "0.2.0", "the tag is found in the bare origin double");
    const set = await req(h.sock, "PUT", "/settings/hub-updates", { enabled: false });
    assert.equal(set.body.checkHubUpdates.setting, false);
    assert.equal(set.body.hubUpdate.enabled, false);
    assert.ok(h.core.journal.tail(50).some((e) => e.type === "settings-changed" && e.key === "checkHubUpdates" && e.value === false));
    assert.equal((await req(h.sock, "GET", "/settings")).body.checkHubUpdates.setting, false);
    assert.equal((await req(h.sock, "POST", "/registry/check-updates")).status, 200, "app: \"Check now\" for plugins");
    assert.equal((await req(h.sock, "POST", "/hub-update/install", {})).status, 400);
    assert.equal((await req(h.sock, "POST", "/hub-update/install", { version: "0.9.0" })).status, 404);
    assert.equal((await req(h.sock, "POST", "/hub-update/rollback")).body.error, "hub-update:no-previous");
    const sw = await req(h.sock, "POST", "/hub-update/switch");
    assert.deepEqual([sw.status, sw.body.error], [409, "hub-update:not-ready"], "nothing to switch to");
    assert.equal((await req(h.sock, "POST", "/hub-update/install", { version: "0.2.0", acceptCommit: "zz" })).status, 400);
    w.state.who = 20;
    await req(h.sock, "POST", "/estop", { on: true });
    w.state.who = 10;
    const paused = await req(h.sock, "POST", "/hub-update/install", { version: "0.2.0" });
    assert.equal(paused.status, 423);
    assert.equal(paused.body.error, "hub-update:estop");
    assert.equal(paused.body.hubUpdate.blocked, "estop");
    assert.equal(currentLabel(home), "0.1.0");
  } finally {
    await h.stop();
    cleanup(root);
  }
});

test("daemon: a Homebrew-managed hub — /state.hubUpdate.source brew, the available version from the brew tree without git; the setting is read fresh (no restart)", async () => {
  const root = tempHome("ah-hu-brew-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  const brew = join(root, "brew", "opt", "agent-hub", "libexec");
  writeTree(brew, { version: "0.2.0" });
  writeFileSync(join(brew, "daemon", "bin", "agenthub"), "#!/usr/bin/env node\n");
  writeFileSync(join(brew, "COMMIT"), "3".repeat(40) + "\n");
  seedVersion(home, "0.1.0", { cdhash: A, origin: "/nonexistent/origin.git" });
  setLink(join(home, "Versions", "current"), "0.1.0");
  pinConfig(home, "0.1.0", A, { services: { hubUpdate: { brew, test: { self: "0.1.0" }, updateCheck: { firstDelayMs: 3_600_000 } } } });
  const w = sysWorld();
  w.procs.set(10, { path: join(versionApp(home, "0.1.0"), "Contents", "MacOS", "AgentHub"), cdhash: A });
  const h = await startHubAt(home, { sys: w.sys, services: "hub-update" });
  try {
    const st = (await req(h.sock, "GET", "/state")).body.hubUpdate;
    assert.equal(st.source, "brew");
    assert.equal(st.brew, brew);
    assert.equal(st.configured, true);
    assert.deepEqual(st.available, { version: "0.2.0", tag: null, commit: "3".repeat(40), brew: true });
    w.state.who = 10;
    const chk = await req(h.sock, "POST", "/hub-update/check");
    assert.equal(chk.status, 200);
    assert.equal(chk.body.hubUpdate.error, null, "no git call to the (nonexistent) origin");
    assert.ok(chk.body.hubUpdate.checkedAt);
    // agenthub uninstall / the git installer remove the setting while the daemon runs — git mode right away
    const cfg = readCfg(home);
    delete cfg.services.hubUpdate.brew;
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    const after = (await req(h.sock, "GET", "/hub-update")).body;
    assert.equal(after.source, "git");
    assert.equal(after.available, null);
  } finally {
    await h.stop();
    cleanup(root);
  }
});

test("ready: the waiting count in hubUpdate.install is recomputed on hook card and session events (without a shell reconnect)", async () => {
  const root = tempHome("ah-hu-wait-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  seedVersion(home, "0.1.0", { cdhash: A });
  setLink(join(home, "Versions", "current"), "0.1.0");
  pinConfig(home, "0.1.0", A, { services: { hubUpdate: { test: { self: "0.1.0" }, updateCheck: { firstDelayMs: 3_600_000 } } } });
  const w = sysWorld();
  const h = await startHubAt(home, { sys: w.sys, services: "hub-update" });
  try {
    const u = h.core.facts.get("hub.updater");
    let parts = { cards: 2, sessions: 0 };
    u.d = { ...u.d, waiting: () => parts };
    u.state = { ...u.state, phase: "ready", op: "install", label: "0.2.0" };
    u.changed();
    const seen = [];
    h.core.on("hub-update.status", (ev) => seen.push(ev.hubUpdate.install));
    // both cards answered — "2 waiting" must not linger
    parts = { cards: 0, sessions: 0 };
    h.core.emit({ type: "hook.card.removed", requestId: "r1", sessionId: "s1", reason: "answered" });
    assert.deepEqual([seen.at(-1)?.waiting, seen.at(-1)?.waitingCards], [0, 0]);
    // a new card arrived — the warning before "Restart" must appear
    parts = { cards: 1, sessions: 0 };
    h.core.emit({ type: "hook.card", requestId: "r2", sessionId: "s2", kind: "permission", tool: "Bash" });
    assert.equal(seen.at(-1)?.waitingCards, 1);
    // a session waits for input — same
    parts = { cards: 1, sessions: 2 };
    h.core.emit({ type: "sessions", sessions: [] });
    assert.equal(seen.at(-1)?.waitingSessions, 2);
    // the same count — no extra broadcast
    const n = seen.length;
    h.core.emit({ type: "sessions", sessions: [] });
    assert.equal(seen.length, n);
    // not ready — card events do not poke the service
    u.state = { ...u.state, phase: "idle" };
    u.changed();
    const m = seen.length;
    parts = { cards: 5, sessions: 0 };
    h.core.emit({ type: "hook.card", requestId: "r3", sessionId: "s3", kind: "permission", tool: "Bash" });
    assert.equal(seen.length, m);
  } finally {
    await h.stop();
    cleanup(root);
  }
});

test("daemon: full path — \"Update\" → build by the real `agenthub hub build` (swift double) → switch → exit \"update\"; the new daemon confirms by the new app's stream, push \"updated\", no \"re-pinned\"", async () => {
  const root = tempHome("ah-hu-e2e-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  const o = originWorld(join(root, "o"));
  const rel = o.release("0.2.0", { cdhash: B });
  seedVersion(home, "0.1.0", { cdhash: A, origin: o.bare });
  setLink(join(home, "Versions", "current"), "0.1.0");
  const hu = (self) => ({ hubUpdate: { test: { self, appQuitMs: 300, launchDelayMs: 100 }, updateCheck: { firstDelayMs: 3_600_000 } } });
  pinConfig(home, "0.1.0", A, { services: hu("0.1.0") });
  const w = sysWorld();
  w.procs.set(10, { path: join(versionApp(home, "0.1.0"), "Contents", "MacOS", "AgentHub"), cdhash: A });
  const h = await startHubAt(home, { sys: w.sys, services: "hub-update,push" });
  const reasons = [];
  h.core.shutdownHandler = (r) => reasons.push(r);
  let h2 = null;
  let stopped = false;
  try {
    w.state.who = 10;
    const s = await openStream(h.sock);
    await waitFor(() => h.core.appConnections().length === 1);
    // the first pin at test directory start (no app-pin.json yet) has its own notification; we count after it.
    // Wait for exactly that and for the push queue, not "100 ms": under load it came later, got counted after
    // the install, and the test failed on "re-pinned suppressed" even though suppression worked (flake 2026-11-06)
    const { _engine } = await import("../lib/services/push.mjs");
    const pinPushes = () => h.core.journal.tail(500).filter((e) => e.type === "push-sent" && /app-pin-changed/.test(e.key || "")).length;
    await waitFor(() => pinPushes() >= 1, { timeoutMs: 10_000 });
    await _engine().idle();
    const pinBefore = pinPushes();
    assert.equal((await req(h.sock, "POST", "/hub-update/check")).body.hubUpdate.available.commit, rel.commit);
    const r = await req(h.sock, "POST", "/hub-update/install", { version: "0.2.0" });
    assert.equal(r.status, 202);
    assert.equal(r.body.hubUpdate.install.phase, "building");
    // the daemon is not blocked while the build runs
    assert.equal((await req(h.sock, "GET", "/health")).status, 200);
    // the hub-update.restarting event — the app quits
    await waitFor(() => h.core.recent.some((e) => e.type === "hub-update.restarting"), { timeoutMs: 20_000 });
    s.close();
    await waitFor(() => reasons.includes("update"), { timeoutMs: 10_000 });
    assert.equal(h.core.updating, true);
    assert.equal(currentLabel(home), "0.2.0");
    const b = readBuild(home, "0.2.0");
    assert.equal(b.commit, rel.commit);
    assert.equal(b.cdhash, B);
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(B));
    assert.equal(readInstall(home).phase, "trial");
    assert.match(readFileSync(readInstall(home).log, "utf8"), /двойник сборки 0\.2\.0/);
    const j = h.core.journal.tail(300);
    assert.ok(j.some((e) => e.type === "app-requirement-changed" && e.by === "agenthub hub-update" && e.source === "hub-update"), "the pin change is in the journal, recorded by the install itself");
    // the pin change is already recorded (app-requirement-changed above); wait for the push queue so the check does not miss
    // a late notification
    await _engine().idle();
    await sleep(200);
    await _engine().idle();
    assert.equal(pinPushes(), pinBefore, "the \"re-pinned\" push is suppressed");
    await h.stop();
    stopped = true;

    // the new daemon "from 0.2.0"
    const cfg = readCfg(home);
    cfg.services = hu("0.2.0");
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
    w.procs.set(11, { path: join(versionApp(home, "0.2.0"), "Contents", "MacOS", "AgentHub"), cdhash: B });
    h2 = await startHubAt(home, { sys: w.sys, services: "hub-update,push" });
    assert.equal(readInstall(home).step, "confirm");
    w.state.who = 11;
    const s2 = await openStream(h2.sock);
    await waitFor(() => readInstall(home).phase === "done");
    // the journal is shared with the previous daemon — look at records after the new one started
    const all2 = h2.core.journal.tail(500);
    const j2 = all2.slice(all2.map((e) => e.type).lastIndexOf("start"));
    assert.ok(j2.some((e) => e.type === "hub-update-installed" && e.label === "0.2.0" && e.from === "0.1.0"));
    assert.ok(!j2.some((e) => e.type === "app-requirement-changed"), "the new daemon did not take the pin change for tampering");
    await waitFor(() => h2.core.journal.tail(300).some((e) => /^push-/.test(e.type) && /hub-update-installed:0\.2\.0/.test(e.key || "")), { timeoutMs: 5000 });
    assert.equal(hubLabel({ facts: h2.core.facts, lang: () => "ru" }, "hub-update-installed:0.2.0"), null);
    assert.match(hubDetail({ facts: h2.core.facts, lang: () => "ru" }, "hub-update-installed:0.2.0"), /0\.2\.0 \(было 0\.1\.0\) · закреплена сборка bbbbbbbbbbbb/);
    assert.equal((await req(h2.sock, "GET", "/state")).body.hubUpdate.current.label, "0.2.0");
    s2.close();
  } finally {
    if (!stopped) await h.stop();
    if (h2) await h2.stop();
    cleanup(root);
  }
});

test("push: a pinned build path change to Versions/<label> of a running install — no \"If this wasn't you\" alarm; a foreign path — an alarm with the rule label in the subtitle", async () => {
  const root = tempHome("ah-hu-pp-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  seedVersion(home, "0.1.0", { cdhash: A });
  seedVersion(home, "0.2.0", { cdhash: A });
  setLink(join(home, "Versions", "current"), "0.1.0");
  // the same signature for both versions (the build did not change the app): requirements.app unchanged, only the path changes
  pinConfig(home, "0.1.0", A, { services: { push: { ackTimeoutMs: 100 }, hubUpdate: { test: { self: "0.1.0" }, updateCheck: { firstDelayMs: 3_600_000 } } } });
  rememberPin(home, "0.1.0", { cdhash: A, op: "install" });
  const w = sysWorld();
  const h = await startHubAt(home, { sys: w.sys, services: "hub-update,push" });
  const execLog = () => (existsSync(join(home, "exec.log")) ? readFileSync(join(home, "exec.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const pathBanners = () => execLog().filter((c) => c.file === "/usr/bin/osascript" && c.args.some((a) => /Демон теперь запускает/.test(a)));
  const setPath = (path) => {
    const c = readCfg(home);
    c.appPin.path = path;
    writeFileSync(join(home, "config.json"), JSON.stringify(c), { mode: 0o600 });
    h.core.appPin.check("test");
  };
  try {
    await waitFor(() => h.core.appPin?.info().path === versionApp(home, "0.1.0"));
    const { _engine } = await import("../lib/services/push.mjs");
    await _engine().idle();
    // switch to 0.2.0: install.json in the trial run; the previous pin (same signature) is expected for a rollback
    const prev = capturePrev(home, join(home, "config.json"));
    writeInstall(home, { phase: "trial", op: "install", label: "0.2.0", from: "0.1.0", startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), prev, restorePin: restorePinOf(prev) });
    assert.equal(h.core.facts.get("hub.update.expectsPin", `cdhash:${A}`), true, "the fingerprint with the same signature is \"expected\"");
    setPath(versionApp(home, "0.2.0"));
    await waitFor(() => h.core.journal.tail(100).some((e) => e.type === "app-pin-path-changed" && e.new === versionApp(home, "0.2.0")));
    await _engine().idle();
    await sleep(200);
    await _engine().idle();
    assert.deepEqual(pathBanners(), [], "our own install path is not an alarm");
    assert.ok(!h.core.journal.tail(200).some((e) => /^push-/.test(e.type) && /app-pin-path-changed/.test(e.key || "")));
    // the same install is still running, but the path is in a foreign directory: an alarm (the expected fingerprint does not count for the path)
    const other = join(root, "elsewhere", "AgentHub.app");
    mkdirSync(other, { recursive: true });
    setPath(other);
    const osa = await waitFor(() => pathBanners()[0], { timeoutMs: 8000 });
    assert.equal(osa.args[8], "Сменился путь закреплённой сборки Agent Hub", "the subtitle is the rule label, not empty");
    assert.ok(osa.args[6].includes(other), "the body is the path");
    // the install finished long ago — a path into Versions/0.1.0 by hand is now an alarm too
    writeInstall(home, { phase: "done", op: "install", label: "0.2.0", from: "0.1.0", finishedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    setPath(versionApp(home, "0.1.0"));
    await waitFor(() => pathBanners().length === 2, { timeoutMs: 8000 });
  } finally {
    await h.stop();
    cleanup(root);
  }
});

test("push: hub update event texts", () => {
  const info = { label: "0.2.0", running: "0.2.0", install: { error: "hub-update:build-failed", log: "/l.log", op: "install", from: "0.1.0" }, current: { label: "0.2.0", cdhash: B } };
  const ctx = { facts: { get: (n) => (n === "hub.update" ? info : null) }, lang: () => "ru" };
  assert.equal(hubDetail(ctx, "hub-update:0.3.0"), "0.3.0. Сейчас 0.2.0 · обновить — в меню Agent Hub");
  // release notes (the tag message subject) — on one line if it is the same version
  info.available = { version: "0.3.0", notes: { subject: "Быстрее\nпоповер", body: "тело" } };
  assert.equal(hubDetail(ctx, "hub-update:0.3.0"), "0.3.0 — Быстрее поповер. Сейчас 0.2.0 · обновить — в меню Agent Hub");
  assert.equal(hubDetail(ctx, "hub-update:0.4.0"), "0.4.0. Сейчас 0.2.0 · обновить — в меню Agent Hub");
  // a §9 subject ("Agent Hub 0.3.0") is not a description: do not repeat the version; a version-only subject — no description (or the first body line)
  info.available = { version: "0.3.0", notes: { subject: "Agent Hub 0.3.0", body: null } };
  assert.equal(hubDetail(ctx, "hub-update:0.3.0"), "0.3.0. Сейчас 0.2.0 · обновить — в меню Agent Hub");
  info.available = { version: "0.3.0", notes: { subject: "Agent Hub v0.3.0: карточка «Можно ли выключать»", body: "тело" } };
  assert.equal(hubDetail(ctx, "hub-update:0.3.0"), "0.3.0 — Карточка «Можно ли выключать». Сейчас 0.2.0 · обновить — в меню Agent Hub");
  info.available = { version: "0.3.0", notes: { subject: "v0.3.0", body: "\nПервая строка тела\nвторая" } };
  assert.equal(hubDetail(ctx, "hub-update:0.3.0"), "0.3.0 — Первая строка тела. Сейчас 0.2.0 · обновить — в меню Agent Hub");
  // a long subject — cut at a word boundary with an ellipsis (and no period after it)
  info.available = { version: "0.4.0", notes: { subject: "Agent Hub 0.4.0: длинная тема релиза — карточка «Можно ли выключать» теперь учитывает фоновые прогоны, сеть и квоту сразу", body: null } };
  assert.equal(hubDetail(ctx, "hub-update:0.4.0"), "0.4.0 — Длинная тема релиза — карточка «Можно ли выключать» теперь учитывает фоновые прогоны, сеть и квоту… Сейчас 0.2.0 · обновить — в меню Agent Hub");
  info.available = { version: "0.3.0", notes: { subject: "Быстрее\nпоповер", body: "тело" } };
  // no tautology like "failed: build failed"; the version is in the text
  assert.equal(hubDetail(ctx, "hub-update-failed:0.3.0"), "0.3.0: ошибка сборки. Хаб остался на 0.2.0 · лог: /l.log");
  info.install.error = "hub-update:weird";
  assert.match(hubDetail(ctx, "hub-update-failed:0.3.0"), /^0\.3\.0: ошибка установки/);
  info.install.op = "rollback";
  assert.equal(hubLabel(ctx, "hub-update-installed:0.1.0"), "Agent Hub возвращён на прежнюю версию");
  assert.equal(hubDetail({ ...ctx, lang: () => "en" }, "hub-update:0.3.0"), "0.3.0 — Быстрее поповер. Now 0.2.0 · update from the Agent Hub menu");
});

// ---------- migration from a working folder ----------

function cli(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [join(DAEMON_DIR, "bin", "agenthub"), ...args], { encoding: "utf8", env: { ...env0(), AGENTHUB_HOME: home, AGENTHUB_TEST_TTY: "1", AGENTHUB_SYSTEM_LANG: "en", ...extraEnv }, timeout: 60_000 });
}

test("migration: no tag — label by commit; with tag vVERSION on HEAD — by tag; dirty tree — refused, --allow-dirty — …dirty; without --no-launchd from a test directory — refused", () => {
  const root = tempHome("ah-hu-mig-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync(GIT, ["init", "-q", "-b", "main", repo]);
    writeTree(repo, { version: "0.1.0", cdhash: A });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", "https://example.invalid/agent-hub.git");
    const short = git(repo, "rev-parse", "--short=7", "HEAD");
    // a plan without --apply does nothing
    const plan = cli(home, ["hub", "migrate", "--from", repo, "--no-launchd"]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, new RegExp(`0\\.1\\.0-dev\\.${short}`));
    assert.ok(!existsSync(join(home, "Versions")));
    // launchd from a test directory — refused
    assert.equal(cli(home, ["hub", "migrate", "--from", repo, "--apply"]).status, 2);
    const m = cli(home, ["hub", "migrate", "--from", repo, "--apply", "--no-launchd"]);
    assert.equal(m.status, 0, m.stderr + m.stdout);
    const label = `0.1.0-dev.${short}`;
    assert.equal(currentLabel(home), label);
    const cfg = readCfg(home);
    assert.equal(cfg.requirements.app, cdhashRequirement(A));
    assert.equal(cfg.appPin.by, "agenthub hub migrate");
    assert.equal(cfg.appPin.path, versionApp(home, label));
    assert.equal(cfg.builtinPluginsDir, join(home, "Builtin"));
    assert.ok(existsSync(join(home, "Builtin", "demo", "demo.60s.sh")));
    assert.equal(readBuild(home, label).origin, "https://example.invalid/agent-hub.git", "origin for update checks");
    assert.equal(readInstall(home).op, "migrate");
    // tag v0.1.0 on HEAD — label by tag, previous — the dev version
    git(repo, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
    const m2 = cli(home, ["hub", "migrate", "--from", repo, "--apply", "--no-launchd"]);
    assert.equal(m2.status, 0, m2.stderr);
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(previousLabel(home), label);
    // dirty tree
    writeFileSync(join(repo, "plugins", "demo", "demo.60s.sh"), "#!/bin/sh\necho dirty\n");
    const dirty = cli(home, ["hub", "migrate", "--from", repo, "--apply", "--no-launchd"]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /uncommitted changes/);
    const d2 = cli(home, ["hub", "migrate", "--from", repo, "--apply", "--no-launchd", "--allow-dirty"]);
    assert.equal(d2.status, 0, d2.stderr + d2.stdout);
    assert.equal(currentLabel(home), `0.1.0-dev.${short}.dirty`);
    assert.match(readFileSync(join(home, "Builtin", "demo", "demo.60s.sh"), "utf8"), /dirty/, "working tree files as is");
    assert.equal(readBuild(home, currentLabel(home)).dirty, true);
    // hub status
    const st = cli(home, ["hub", "status"]);
    assert.match(st.stdout, /current:\s+0\.1\.0-dev\.\w+\.dirty/);
    // emergency rollback to previous (files; launchctl is not called in a test directory)
    const rb = cli(home, ["hub", "rollback", "--apply"]);
    assert.equal(rb.status, 0, rb.stderr);
    assert.equal(currentLabel(home), "0.1.0");
  } finally {
    cleanup(root);
  }
});

// ---------- plist, hook and bridge paths, self-test ----------

test("plist after migration — via Versions/current; the install's hook and bridge paths — both via current and real", () => {
  const home = tempHome("ah-hu-pl-");
  try {
    assert.equal(daemonLocation(home).installed, false);
    seedVersion(home, "0.2.0");
    setLink(join(home, "Versions", "current"), "0.2.0");
    const loc = daemonLocation(home);
    assert.equal(loc.daemon, join(home, "Versions", "current", "src", "daemon", "bin", "agenthubd"));
    const xml = plistXml({ stateDir: home });
    assert.ok(xml.includes(`<string>${join(home, "Versions", "current", "src", "daemon", "bin", "agenthubd")}</string>`));
    assert.ok(xml.includes(`<string>${join(home, "Versions", "current", "src")}</string>`));
    assert.ok(!xml.includes(REPO_DIR + "/daemon"), "the working folder does not get into the plist");
  } finally {
    cleanup(home);
  }
  const i = installOf("/U/Library/Application Support/AgentHub/Versions/0.2.0/src");
  assert.equal(i.label, "0.2.0");
  assert.equal(i.stableRepo, "/U/Library/Application Support/AgentHub/Versions/current/src");
  assert.equal(installOf("/U/src/agent-hub"), null);
  assert.equal(installOf("/U/x/Versions/current/src"), null, "current is not a label");
});

test("agenthubd --self-test: loads the core and the server in a test directory, version from VERSION; without a test directory — refused", () => {
  const home = tempHome("ah-hu-self-");
  try {
    const r = spawnSync(process.execPath, [join(DAEMON_DIR, "bin", "agenthubd"), "--self-test"], { encoding: "utf8", env: { ...env0(), AGENTHUB_HOME: home }, timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout.trim());
    assert.equal(j.ok, true);
    assert.equal(j.version, VERSION);
    const live = spawnSync(process.execPath, [join(DAEMON_DIR, "bin", "agenthubd"), "--self-test"], { encoding: "utf8", env: (() => { const e = env0(); delete e.AGENTHUB_HOME; return e; })(), timeout: 30_000 });
    assert.equal(live.status, 1);
    assert.match(live.stdout, /a test AGENTHUB_HOME is required/);
  } finally {
    cleanup(home);
  }
});

test("agenthubd --self-test: a broken routes or services module — refused (the core and the server only log import errors)", () => {
  const root = tempHome("ah-hu-selfbad-");
  try {
    const tree = join(root, "src");
    mkdirSync(join(tree, "daemon"), { recursive: true });
    for (const d of ["lib", "bin"]) execFileSync("/bin/cp", ["-R", join(DAEMON_DIR, d), join(tree, "daemon", d)]);
    writeFileSync(join(tree, "daemon", "package.json"), readFileSync(join(DAEMON_DIR, "package.json")));
    writeFileSync(join(tree, "VERSION"), readFileSync(join(REPO_DIR, "VERSION")));
    const run = () => {
      const home = join(root, `h${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(home, { mode: 0o700 });
      const r = spawnSync(process.execPath, [join(tree, "daemon", "bin", "agenthubd"), "--self-test"], { encoding: "utf8", env: { ...env0(), AGENTHUB_HOME: home }, timeout: 30_000 });
      return JSON.parse(r.stdout.trim().split("\n").pop());
    };
    assert.equal(run().ok, true, "an intact copy passes");
    const route = join(tree, "daemon", "lib", "routes", "hub-update.mjs");
    const routeText = readFileSync(route, "utf8");
    writeFileSync(route, routeText + "\nexport const = ;\n");
    const r1 = run();
    assert.equal(r1.ok, false);
    assert.match(r1.error, /routes\/hub-update\.mjs/);
    writeFileSync(route, routeText);
    const svc = join(tree, "daemon", "lib", "services", "hub-update.mjs");
    writeFileSync(svc, 'import { nope } from "./no-such-module.mjs";\n' + readFileSync(svc, "utf8"));
    const r2 = run();
    assert.equal(r2.ok, false);
    assert.match(r2.error, /services\/hub-update\.mjs/);
  } finally {
    cleanup(root);
  }
});

// ---------- fixes from the auto-update review (2026-11-06) ----------

// Hub on 0.1.0 from Versions, pin A, the hub pinned A for 0.1.0 itself (history.json).
function installedWorld(home) {
  seedVersion(home, "0.1.0", { cdhash: A });
  setLink(join(home, "Versions", "current"), "0.1.0");
  pinConfig(home, "0.1.0", A);
  rememberPin(home, "0.1.0", { cdhash: A, op: "migrate" });
}
const fastOpts = (o = {}) => ({ opts: { appQuitMs: 50, deadlineMs: 60_000, launchDelayMs: 20, ...o } });
const pinStateFile = (home, cd, label) =>
  writeFileSync(join(home, "app-pin.json"), JSON.stringify({ requirementSha: requirementSha(cdhashRequirement(cd)), fingerprint: `cdhash:${cd}`, kind: "cdhash", changedAt: new Date().toISOString(), by: "agenthub hub-update", path: versionApp(home, label), source: "hub-update" }));

test("review: the daemon died while the app was quitting — the prev snapshot is already on disk in one record with the phase; a start after the break does not touch the pin or the pointers", async () => {
  const home = tempHome("ah-hu-r1-");
  try {
    installedWorld(home);
    seedVersion(home, "0.0.9", { cdhash: C });
    setLink(join(home, "Versions", "previous"), "0.0.9");
    const before = readCfg(home);
    const w = updaterWorld(home);
    w.builder = w.okBuilder();
    w.conns = [{ pid: 777 }]; // the app does not quit — the waitAppGone window is open
    const u = w.make(fastOpts({ appQuitMs: 10_000 }));
    u.install("0.2.0");
    await waitFor(() => w.calls.includes("begin"));
    const window = readInstall(home);
    assert.equal(window.phase, "switching");
    assert.ok(isSnapshot(window.prev), "the snapshot is written together with the switching phase, before the app quits");
    assert.deepEqual([window.prev.current, window.prev.previous, window.prev.requirement], ["0.1.0", "0.0.9", cdhashRequirement(A)]);
    // "the daemon died" in this window — exactly window is on disk
    u.stop();
    await u.running;
    writeInstall(home, window);
    const w2 = updaterWorld(home, { self: "0.1.0" });
    assert.equal(w2.make().resume(), "restore");
    const cfg = readCfg(home);
    assert.equal(cfg.requirements.app, before.requirements.app, "pin intact");
    assert.equal(cfg.appPin.requirementSha, before.appPin.requirementSha);
    assert.equal(cfg.appPin.path, before.appPin.path);
    assert.deepEqual([currentLabel(home), previousLabel(home)], ["0.1.0", "0.0.9"], "pointers intact");
    assert.deepEqual([readInstall(home).phase, readInstall(home).error], ["failed", "hub-update:interrupted"]);
    assert.ok(!w2.calls.includes("restart"), "the daemon is already the version current points to");
    // a record without a snapshot (old format, prev: null) — files are not touched at all
    writeInstall(home, { ...window, prev: null });
    const w3 = updaterWorld(home, { self: "0.2.0" });
    assert.equal(w3.make().resume(), "restore");
    assert.equal(readCfg(home).requirements.app, before.requirements.app);
    assert.deepEqual([currentLabel(home), previousLabel(home)], ["0.1.0", "0.0.9"]);
    assert.ok(!w3.calls.includes("restart"));
    assert.equal(readInstall(home).error, "hub-update:interrupted");
    // an empty snapshot is not "nothing was there"
    assert.equal(restoreFiles({ home, prev: {} }).skipped, true);
    assert.equal(readCfg(home).requirements.app, before.requirements.app);
    assert.equal(currentLabel(home), "0.1.0");
  } finally {
    cleanup(home);
  }
});

test("review: install.json cannot be written — the switch does not start (the app does not quit, files unchanged)", async () => {
  const home = tempHome("ah-hu-r1w-");
  const dir = join(home, "HubUpdate");
  try {
    installedWorld(home);
    const w = updaterWorld(home);
    w.builder = (job) => {
      const r = w.okBuilder()(job);
      // install.json can no longer be written (a non-empty directory in its place: rename over it will fail)
      rmSync(join(dir, "install.json"), { force: true });
      mkdirSync(join(dir, "install.json", "x"), { recursive: true });
      return r;
    };
    const u = w.make(fastOpts());
    u.install("0.2.0");
    await u.running;
    assert.ok(!w.calls.includes("begin"), "the app does not quit");
    assert.ok(!w.calls.includes("restart"));
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(A));
    assert.ok(w.journal.some((e) => e.type === "hub-update-failed" && e.error === "hub-update:state-write"));
  } finally {
    cleanup(home);
  }
});

test("review: daemon stop while the app was quitting — no switch and no \"update\" restart (failed: interrupted)", async () => {
  for (const how of ["stop", "shuttingDown"]) {
    const home = tempHome("ah-hu-r2-");
    try {
      installedWorld(home);
      const w = updaterWorld(home);
      w.builder = w.okBuilder();
      w.conns = [{ pid: 777 }];
      let down = false;
      w.life.shuttingDown = () => down;
      const u = w.make(fastOpts({ appQuitMs: 5000 }));
      u.install("0.2.0");
      await waitFor(() => w.calls.includes("begin"));
      if (how === "stop") u.stop();
      else down = true;
      await u.running;
      assert.deepEqual(w.calls.filter((c) => ["checkPin", "watchdog", "restart"].includes(c) || c.startsWith("kill:")), [], how);
      assert.equal(currentLabel(home), "0.1.0", how);
      assert.equal(readCfg(home).requirements.app, cdhashRequirement(A), how);
      assert.deepEqual([readInstall(home).phase, readInstall(home).error], ["failed", "hub-update:interrupted"], how);
    } finally {
      cleanup(home);
    }
  }
});

test("review: the new daemon came up after the trial-run deadline — the deadline counts from its start, once", async () => {
  const home = tempHome("ah-hu-r2d-");
  try {
    installedWorld(home);
    seedVersion(home, "0.2.0", { cdhash: B });
    const prev = capturePrev(home);
    applySwitch({ home, label: "0.2.0", prev });
    const st0 = { phase: "trial", op: "install", label: "0.2.0", from: "0.1.0", startedAt: "s1", deadlineAt: new Date(Date.now() - 60_000).toISOString(), prev, restorePin: restorePinOf(prev) };
    writeInstall(home, st0);
    const w = updaterWorld(home, { self: "0.2.0", available: null });
    const u = w.make({ hasSupervisor: () => true, ...fastOpts({ deadlineMs: 400 }) });
    assert.equal(u.resume(), "confirm-wait");
    const st = readInstall(home);
    assert.equal(st.deadlineExtended, true);
    assert.ok(Date.parse(st.deadlineAt) > Date.now(), "the new deadline is ahead");
    await sleep(150);
    assert.ok(!w.calls.includes("restart"), "does not roll back right at start");
    u.onAppStream();
    assert.equal(readInstall(home).phase, "done");
    u.stop();
    // the extension happens once: the next start after the deadline rolls back
    writeInstall(home, { ...st0, deadlineExtended: true });
    const w2 = updaterWorld(home, { self: "0.2.0", available: null });
    const u2 = w2.make({ hasSupervisor: () => true, ...fastOpts({ deadlineMs: 400 }) });
    u2.resume();
    await waitFor(() => w2.calls.includes("restart"), { timeoutMs: 2000 });
    assert.equal(readInstall(home).phase, "rolled-back");
    u2.stop();
  } finally {
    cleanup(home);
  }
});

test("review: trial-run rollback by deadline — journal \"agenthub hub-update rollback\", no \"re-pinned\" push from either the new or the previous daemon; a foreign change — there is one", async () => {
  const root = tempHome("ah-hu-r3-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  const hu = (self) => ({ hubUpdate: { test: { self, appQuitMs: 100, launchDelayMs: 60_000 }, updateCheck: { firstDelayMs: 3_600_000 } } });
  seedVersion(home, "0.1.0", { cdhash: A });
  seedVersion(home, "0.2.0", { cdhash: B });
  setLink(join(home, "Versions", "current"), "0.1.0");
  pinConfig(home, "0.1.0", A, { services: hu("0.2.0") });
  rememberPin(home, "0.1.0", { cdhash: A, op: "migrate" });
  const prev = capturePrev(home);
  applySwitch({ home, label: "0.2.0", prev });
  rememberPin(home, "0.2.0", { cdhash: B, op: "install" });
  // the previous daemon recorded the change to B itself before the restart (app-pin.json)
  pinStateFile(home, B, "0.2.0");
  writeInstall(home, { phase: "trial", op: "install", label: "0.2.0", from: "0.1.0", startedAt: "s1", deadlineAt: new Date(Date.now() + 500).toISOString(), prev, restorePin: restorePinOf(prev), watchdogPid: null, log: "/x.log" });
  const w = sysWorld();
  const pinPushes = (core, since) => core.journal.tail(800).filter((e) => /^push-/.test(e.type) && /app-pin-changed/.test(e.key || "") && e.ts >= since).length;
  let since = new Date().toISOString();
  let h = await startHubAt(home, { sys: w.sys, services: "hub-update,push" });
  const reasons = [];
  h.core.shutdownHandler = (r) => reasons.push(r);
  try {
    // the new daemon (0.2.0): the app did not connect, no watchdog — rolls back itself
    await waitFor(() => reasons.includes("update"), { timeoutMs: 5000 });
    const changed = await waitFor(() => h.core.journal.tail(300).find((e) => e.type === "app-requirement-changed" && e.new === `cdhash:${A}`), { timeoutMs: 8000 });
    assert.equal(changed.by, "agenthub hub-update rollback", "the journal says who restored the pin");
    assert.equal(readInstall(home).phase, "rolled-back");
    await sleep(300);
    assert.equal(pinPushes(h.core, since), 0, "new daemon: no \"re-pinned\"");
    await h.stop();
    // the previous daemon (0.1.0); the new one did not get to record the change (app-pin.json is still B)
    pinStateFile(home, B, "0.2.0");
    const cfg = readCfg(home);
    cfg.services = hu("0.1.0");
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
    since = new Date().toISOString();
    h = await startHubAt(home, { sys: w.sys, services: "hub-update,push" });
    assert.equal(readInstall(home).phase, "failed");
    await waitFor(() => h.core.journal.tail(300).some((e) => e.type === "app-requirement-changed" && e.new === `cdhash:${A}` && e.source === "start" && e.ts >= since));
    await waitFor(() => h.core.journal.tail(300).some((e) => /^push-/.test(e.type) && /hub-update-failed:0\.2\.0/.test(e.key || "") && e.ts >= since), { timeoutMs: 5000 });
    await sleep(300);
    assert.equal(pinPushes(h.core, since), 0, "previous daemon: no \"re-pinned\", only \"failed\"");
    // control: a foreign re-pin still gives a push
    const c2 = readCfg(home);
    c2.requirements.app = cdhashRequirement(C);
    c2.appPin = { requirementSha: requirementSha(cdhashRequirement(C)), by: "agenthub pin-app" };
    writeFileSync(join(home, "config.json"), JSON.stringify(c2), { mode: 0o600 });
    await waitFor(() => pinPushes(h.core, since) >= 1, { timeoutMs: 8000 });
  } finally {
    await h.stop();
    cleanup(root);
  }
});

test("review: trial-run confirmation and rollback — phase transition under a lock; a late stream from the new app does not overwrite the watchdog's rollback", async () => {
  const home = tempHome("ah-hu-r4-");
  try {
    installedWorld(home);
    seedVersion(home, "0.2.0", { cdhash: B });
    let prev = capturePrev(home);
    applySwitch({ home, label: "0.2.0", prev });
    writeInstall(home, { phase: "trial", op: "install", label: "0.2.0", from: "0.1.0", startedAt: "s1", deadlineAt: new Date(Date.now() + 60_000).toISOString(), prev });
    const w = updaterWorld(home, { self: "0.2.0", available: null });
    const u = w.make({ hasSupervisor: () => true });
    assert.equal(u.resume(), "confirm-wait"); // in memory — trial
    const r = await rollbackTrial({ home, st: readInstall(home) });
    assert.equal(r.ok, true);
    assert.equal(readInstall(home).phase, "rolled-back");
    assert.equal(readInstall(home).restorePin, `cdhash:${A}`);
    u.onAppStream();
    assert.equal(readInstall(home).phase, "rolled-back", "a confirmation by the in-memory phase does not overwrite the rollback");
    assert.ok(!w.events.some((e) => e.type === "hub-update.installed"));
    assert.equal(currentLabel(home), "0.1.0");
    u.stop();
    // the other way round: confirmed earlier — the watchdog's rollback touches nothing
    prev = capturePrev(home);
    applySwitch({ home, label: "0.2.0", prev });
    writeInstall(home, { phase: "trial", op: "install", label: "0.2.0", from: "0.1.0", startedAt: "s2", deadlineAt: new Date(Date.now() + 60_000).toISOString(), prev });
    const w2 = updaterWorld(home, { self: "0.2.0", available: null });
    const u2 = w2.make({ hasSupervisor: () => true });
    u2.resume();
    u2.onAppStream();
    assert.equal(readInstall(home).phase, "done");
    assert.equal(await rollbackTrial({ home, st: { ...readInstall(home), phase: "trial" } }), null);
    assert.equal(currentLabel(home), "0.2.0");
    u2.stop();
    // a lock left by a dead process is removed by age
    const lock = join(home, "HubUpdate", "install.lock");
    writeFileSync(lock, "1");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    assert.ok(transitionInstall(home, { phase: "done", startedAt: "s2" }, { note: 1 }));
    assert.ok(!existsSync(lock));
  } finally {
    cleanup(home);
  }
});

test("review: an interrupted switch in the new daemon — no \"failed · hub on <new>\" push from the outgoing one; the previous version writes the result", () => {
  const home = tempHome("ah-hu-r5-");
  try {
    installedWorld(home);
    seedVersion(home, "0.2.0", { cdhash: B });
    const prev = capturePrev(home);
    applySwitch({ home, label: "0.2.0", prev });
    writeInstall(home, { phase: "switching", op: "install", label: "0.2.0", from: "0.1.0", startedAt: "s1", prev, restorePin: restorePinOf(prev) });
    const w = updaterWorld(home, { self: "0.2.0" });
    assert.equal(w.make().resume(), "restore");
    assert.ok(!w.events.some((e) => e.type === "hub-update.failed"), "the outgoing daemon does not send \"failed\"");
    assert.ok(w.calls.includes("restart"));
    assert.equal(currentLabel(home), "0.1.0");
    assert.deepEqual([readInstall(home).phase, readInstall(home).error], ["rolled-back", "hub-update:interrupted"]);
    const w0 = updaterWorld(home, { self: "0.1.0" });
    assert.equal(w0.make().resume(), "finalize-failed");
    const ev = w0.events.find((e) => e.type === "hub-update.failed");
    assert.deepEqual([ev.label, ev.from, ev.error], ["0.2.0", "0.1.0", "hub-update:interrupted"]);
  } finally {
    cleanup(home);
  }
});

test("review: PermissionRequest cards are waiting — the built version waits for a second press (phase ready), restart only via \"Restart now\"", async () => {
  const home = tempHome("ah-hu-r6-");
  try {
    installedWorld(home);
    const w = updaterWorld(home);
    w.builder = w.okBuilder();
    let waiting = 2;
    const u = w.make({ waiting: () => waiting, ...fastOpts() });
    u.install("0.2.0");
    await u.running;
    assert.equal(readInstall(home).phase, "ready");
    assert.ok(!w.calls.includes("begin") && !w.calls.includes("restart"), "the daemon does not restart by itself");
    assert.equal(u.info().install.waiting, 2);
    assert.equal(u.info().install.waitingCards, 2, "a count without a breakdown (old form) — cards");
    assert.equal(u.info().blocked, null);
    // in ready a rollback would silently discard the built version — refused until restarted
    assert.throws(() => u.rollback("0.1.0"), (e) => e.code === "hub-update:ready");
    assert.ok(w.events.some((e) => e.type === "hub-update.ready" && e.waiting === 2 && e.notify === true), "the first time — with a notification");
    w.estop = true;
    assert.throws(() => u.switchReady(), (e) => e.code === "hub-update:estop");
    w.estop = false;
    waiting = 1;
    u.switchReady({ class: "app", pid: 1 });
    await u.running;
    assert.ok(w.calls.includes("restart"));
    assert.equal(currentLabel(home), "0.2.0");
    assert.ok(w.journal.some((e) => e.type === "hub-update-confirm" && e.waiting === 1));
    assert.throws(() => u.switchReady(), (e) => e.code === "hub-update:not-ready");
    // a daemon restart in the ready phase — anew
    assert.equal(startupVerdict({ phase: "ready", label: "0.3.0" }, "0.2.0"), "interrupted");
  } finally {
    cleanup(home);
  }
});

test("ready: \"New hub version built — waiting for a restart\" — one notification per version (check.json → readyNotified survives a restart); rollback — no notification", async () => {
  const home = tempHome("ah-hu-rdy-");
  try {
    installedWorld(home);
    const w = updaterWorld(home);
    w.builder = w.okBuilder();
    const real = new HubUpdateChecker({ home, current: () => "0.1.0", testMode: true });
    const u = w.make({ waiting: () => 1, ...fastOpts(), checker: Object.assign(Object.create(real), { available: () => ({ version: "0.2.0", tag: "v0.2.0", commit: "2".repeat(40) }), remote: () => "/origin.git" }) });
    u.install("0.2.0");
    await u.running;
    assert.equal(readInstall(home).phase, "ready");
    const ready = () => w.events.filter((e) => e.type === "hub-update.ready");
    assert.deepEqual(ready().map((e) => e.notify), [true]);
    assert.ok(w.journal.some((e) => e.type === "hub-update-ready" && e.notify === true));
    assert.ok(readFileSync(join(home, "HubUpdate", "check.json"), "utf8").includes('"readyNotified"'));
    // the same version is already built and waiting — "Update" does not rebuild it (a verified build is not discarded)
    assert.throws(() => u.install("0.2.0"), (e) => e.code === "hub-update:ready");
    assert.equal(readInstall(home).phase, "ready");
    // the install was interrupted (daemon restart in ready) and the human pressed "Update" again — we wait, but without a second notification
    u.ready = null;
    u.setState({ phase: "failed", error: "hub-update:interrupted" });
    u.install("0.2.0");
    await u.running;
    assert.deepEqual(ready().map((e) => e.notify), [true, false]);
    // the memory is in a file: a new check instance (daemon restart) does not notify either; another version — notifies
    const again = new HubUpdateChecker({ home, current: () => "0.1.0", testMode: true });
    assert.equal(again.claimReadyNotice("0.2.0"), false);
    assert.equal(again.claimReadyNotice("0.3.0"), true);
    assert.equal(new HubUpdateChecker({ home, current: () => "0.1.0", testMode: true }).claimReadyNotice("0.3.0"), false);
  } finally {
    cleanup(home);
  }
  // a rollback waiting for cards — no notification (a human started it with a button)
  const home2 = tempHome("ah-hu-rdy2-");
  try {
    installedWorld(home2);
    seedVersion(home2, "0.0.9", { cdhash: B });
    rememberPin(home2, "0.0.9", { cdhash: B, op: "install" });
    const w = updaterWorld(home2);
    const u = w.make({ waiting: () => 2, ...fastOpts() });
    u.rollback("0.0.9");
    await u.running;
    const ev = w.events.find((e) => e.type === "hub-update.ready");
    assert.ok(ev, "a rollback waits for cards too");
    assert.equal(ev.notify, false);
  } finally {
    cleanup(home2);
  }
});

test("push: \"New hub version built — waiting for a restart\" — only on hub-update.ready with notify, one key per version, ru/en text", async () => {
  const home = tempHome("ah-hu-rdp-");
  mkdirSync(join(home, "h"), { mode: 0o700 });
  writeFileSync(join(home, "h", "config.json"), JSON.stringify({ services: { push: { ackTimeoutMs: 100 } } }), { mode: 0o600 });
  const h = await startHubAt(join(home, "h"), { sys: sysWorld().sys, services: "push" });
  try {
    const pushed = () => h.core.journal.tail(300).filter((e) => /^push-/.test(e.type) && /hub-update-ready:/.test(e.key || ""));
    h.core.emit({ type: "hub-update.ready", op: "install", label: "0.2.0", waiting: 2, notify: false });
    await sleep(300);
    assert.equal(pushed().length, 0, "without notify — silent (already notified about this version)");
    h.core.emit({ type: "hub-update.ready", op: "install", label: "0.2.0", waiting: 2, notify: true });
    await waitFor(() => pushed().length > 0, { timeoutMs: 5000 });
    assert.ok(pushed().every((e) => e.key === "@hub:hub-update-ready:0.2.0"));
  } finally {
    await h.stop();
    cleanup(home);
  }
  const info = { label: "0.1.0", running: "0.1.0", install: { phase: "ready", label: "0.2.0", waiting: 2, waitingCards: 2, waitingSessions: 1, op: "install" } };
  const ctx = { facts: { get: (n) => (n === "hub.update" ? info : null) }, lang: () => "ru" };
  assert.equal(hubDetail(ctx, "hub-update-ready:0.2.0"), "0.2.0. Ждут ответа: 2 — перезапуск снимет их карточки, вопросы уйдут в терминал. Перезапустить — в меню Agent Hub или в Настройках");
  assert.equal(hubDetail({ ...ctx, lang: () => "en" }, "hub-update-ready:0.2.0"), "0.2.0. Waiting for an answer: 2 — a restart drops their cards and the questions fall back to the terminal. Restart from the Agent Hub menu or Settings");
  // no hub cards, only sessions are waiting — no mention of cards
  info.install = { phase: "ready", label: "0.2.0", waiting: 2, waitingCards: 0, waitingSessions: 2, op: "install" };
  assert.equal(hubDetail(ctx, "hub-update-ready:0.2.0"), "0.2.0. Ждут ответа сессии: 2 — лучше сначала ответить. Перезапустить — в меню Agent Hub или в Настройках");
  info.install = { phase: "building" };
  assert.equal(hubDetail(ctx, "hub-update-ready:0.2.0"), "0.2.0. Перезапустить — в меню Agent Hub или в Настройках");
  assert.equal(hubLabel(ctx, "hub-update-ready:0.2.0"), null, "the title is the rule label");
});

test("review: bundle cdhash in the daemon — asynchronous codesign, the event loop does not stall", async () => {
  const dir = tempHome("ah-hu-r7-");
  try {
    const fake = join(dir, "codesign");
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--verify" ]; then sleep 0.5; [ -e "$3" ] || { echo "нет бандла" >&2; exit 1; }; exit 0; fi\necho "Identifier=com.kensei.agenthub" >&2\necho "CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded" >&2\necho "CDHash=${B}" >&2\n`, { mode: 0o755 });
    let ticks = 0;
    const t = setInterval(() => ticks++, 50);
    const info = await readBundleCodeAsync(dir, { codesign: fake });
    clearInterval(t);
    assert.equal(info.cdhash, B);
    assert.equal(info.adhoc, true);
    assert.ok(ticks >= 4, `timers ran while codesign was working (${ticks})`);
    await assert.rejects(readBundleCodeAsync(join(dir, "nope.app"), { codesign: fake }), /codesign --verify/);
  } finally {
    cleanup(dir);
  }
});

test("review: the previous app after a failed switch — supervision; limit exhausted — not launched; without supervision — only the pin's verified bundle", async () => {
  const home = tempHome("ah-hu-r8-");
  try {
    installedWorld(home);
    const calls = [];
    const journal = [];
    let verdict = true;
    const apps = { launch: async (p) => (calls.push(`launch:${p}`), { ok: true }), verify: async (p, r) => (calls.push(`verify:${r === cdhashRequirement(A)}`), verdict) };
    const cfgPath = join(home, "config.json");
    const requirement = cdhashRequirement(A);
    const base = { apps, configPath: cfgPath, requirement, testMode: true, journal: (e) => journal.push(e) };
    const sup = (o) => ({ schedule: (r) => calls.push(`schedule:${r}`), opts: { supervise: true, restartDelayMs: 1 }, limited: false, ...o });
    assert.equal(relaunchPrevious({ ...base, sup: sup() }), "supervisor");
    // supervision stopped restarts after crashes — we do not launch around the limit
    assert.equal(relaunchPrevious({ ...base, sup: sup({ limited: true }) }), null);
    assert.equal(journal.at(-1).why, "limited");
    // no supervision: the pin path, signature verified
    assert.equal(relaunchPrevious({ ...base, sup: undefined }), "launch");
    await sleep(10);
    // relaunch, not start: "Launch at login" being off does not delay bringing the app back
    assert.deepEqual(calls, ["schedule:relaunch", "verify:true", `launch:${versionApp(home, "0.1.0")}`]);
    // the signature does not match — not launched
    calls.length = 0;
    verdict = false;
    assert.equal(relaunchPrevious({ ...base, sup: undefined }), "launch");
    await sleep(10);
    assert.deepEqual(calls, ["verify:true"]);
    assert.equal(journal.at(-1).why, "pin-mismatch");
    // appPin from the previous pin (requirements.app edited by hand) — the path is not used
    calls.length = 0;
    assert.equal(relaunchPrevious({ ...base, sup: undefined, requirement: cdhashRequirement(C) }), null);
    assert.equal(journal.at(-1).why, "no-path");
    // no bundle
    assert.equal(relaunchPrevious({ ...base, sup: undefined, configPath: join(home, "nope.json") }), null);
    rmSync(versionApp(home, "0.1.0"), { recursive: true });
    assert.equal(relaunchPrevious({ ...base, sup: undefined }), null);
    assert.equal(journal.at(-1).why, "path-missing");
    await sleep(10);
    assert.deepEqual(calls, []);
  } finally {
    cleanup(home);
  }
});

test("review: cleanup — build logs (except current/previous) beyond N and older than the limit, the watchdog journal tail, versions that failed to install; low disk space — a clear error before the build", async () => {
  const home = tempHome("ah-hu-r10-");
  try {
    installedWorld(home);
    const logs = join(home, "logs");
    mkdirSync(logs, { recursive: true });
    const name = (i) => join(logs, `hub-update-0.${i}.0-2026-10-${String(i + 1).padStart(2, "0")}T00-00-00.log`);
    const day = 24 * 3600_000;
    for (let i = 0; i < 12; i++) {
      writeFileSync(name(i), "x");
      const t = new Date(Date.now() - (i < 2 ? 40 : 12 - i) * day);
      utimesSync(name(i), t, t);
    }
    // the current version's log is old but stays
    const b = readBuild(home, "0.1.0");
    writeFileSync(join(home, "Versions", "0.1.0", "build.json"), JSON.stringify({ ...b, log: name(0) }));
    writeFileSync(join(logs, "hub-update-watch.log"), "строка\n".repeat(20_000));
    seedVersion(home, "0.3.0", { cdhash: C }); // failed to install
    const removed = prune(home, { keep: 3, drop: ["0.3.0"], logKeep: 5 });
    assert.deepEqual(removed, ["0.3.0"], "a version that failed to install is not kept for keep");
    const left = readdirSync(logs).filter((n) => n !== "hub-update-watch.log").sort();
    assert.deepEqual(left, [name(0), name(7), name(8), name(9), name(10), name(11)].map((p) => p.slice(logs.length + 1)).sort());
    assert.ok(readFileSync(join(logs, "hub-update-watch.log")).length <= 256 * 1024);
    // a failure after the build — the version directory is removed right away
    const w = updaterWorld(home);
    w.builder = (job) => {
      const r = w.okBuilder()(job);
      writeFileSync(join(home, "Versions", job.label, "AgentHub.app", "Contents", "TEST-CDHASH"), C);
      return r;
    };
    const u = w.make(fastOpts());
    u.install("0.2.0");
    await u.running;
    assert.equal(readInstall(home).error, "hub-update:verify-failed");
    assert.ok(!existsSync(join(home, "Versions", "0.2.0")));
    // low disk space
    const log = join(logs, "space.log");
    await assert.rejects(buildVersion({ home, label: "0.4.0", version: "0.4.0", source: { kind: "tag", remote: "/nope.git", tag: "v0.4.0" }, logPath: log, codeOf: testCodeOf, timeouts: { minFreeBytes: Number.MAX_SAFE_INTEGER } }), (e) => e.code === "hub-update:no-space");
    assert.match(readFileSync(log, "utf8"), /no-space — \d+ MB free/);
  } finally {
    cleanup(home);
  }
});

test("review: release provenance — a tag on a commit outside origin/main is not installed (not-on-main); a junk v999 does not shadow the real release", async () => {
  const root = tempHome("ah-hu-r11-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  try {
    const o = originWorld(join(root, "o"));
    o.release("0.1.0");
    const main = git(o.work, "rev-parse", "HEAD");
    git(o.work, "checkout", "-q", "-b", "agent-branch");
    writeTree(o.work, { version: "0.2.0" });
    git(o.work, "add", "-A");
    git(o.work, "commit", "-q", "-m", "непросмотренный коммит");
    const side = git(o.work, "rev-parse", "HEAD");
    git(o.work, "tag", "v0.2.0");
    git(o.work, "tag", "v999.0.0");
    git(o.work, "push", "-q", "origin", "v0.2.0", "v999.0.0"); // the branch is not pushed
    git(o.work, "checkout", "-q", "main");
    const tags = await listTags({ remote: o.bare });
    assert.equal(tags.find((t) => t.tag === "v0.2.0").commit, side);
    assert.notEqual(side, main);
    await assert.rejects(buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "tag", remote: o.bare, tag: "v0.2.0", commit: side }, codeOf: testCodeOf, logPath: join(home, "b.log") }), (e) => e.code === "hub-update:not-on-main");
    assert.ok(!existsSync(join(home, "Versions", "0.2.0")));
    // a major version jump
    assert.equal(latestRelease(tags, "0.1.0", { maxMajor: 1 }).version, "0.2.0");
    const journal = [];
    const c = new HubUpdateChecker({ home, journal: (e) => journal.push(e), remote: () => o.bare, current: () => "0.1.0", testMode: true });
    await c.check("manual");
    await c.settled(); // release notes load after the answer — wait for them before cleaning up the directory
    assert.equal(c.available().version, "0.2.0", "v999.0.0 does not shadow");
    assert.ok(journal.some((e) => e.type === "hub-update-skipped" && e.versions.includes("999.0.0")));
    c.stop();
  } finally {
    cleanup(root);
  }
});

test("review: a tag of the same version moved to another commit — journal, event (push), the version is marked moved; \"Update\" only with confirmation of the new commit", async () => {
  const home = tempHome("ah-hu-r12-");
  try {
    installedWorld(home);
    const c1 = "c".repeat(39) + "1";
    const c2 = "d".repeat(39) + "2";
    let commit = c1;
    const events = [];
    const journal = [];
    const make = () => new HubUpdateChecker({ home, journal: (e) => journal.push(e), emit: (e) => events.push(e), remote: () => "/o.git", current: () => "0.1.0", testMode: true, listTags: async () => [{ tag: "v0.2.0", version: "0.2.0", commit }] });
    const c = make();
    await c.check("manual");
    assert.equal(c.available().moved, undefined);
    commit = c2;
    await c.check("timer");
    const ev = events.find((e) => e.type === "hub-update.tag-moved");
    assert.deepEqual([ev.version, ev.old, ev.new], ["0.2.0", c1, c2]);
    assert.ok(journal.some((e) => e.type === "hub-update-tag-moved" && e.old === c1 && e.new === c2));
    assert.deepEqual(c.available().moved && [c.available().moved.old, c.available().moved.new], [c1, c2]);
    await c.check("timer");
    assert.equal(events.filter((e) => e.type === "hub-update.tag-moved").length, 1, "one move — one event");
    assert.ok(make().available().moved, "remembered after a restart (check.json)");
    const w = updaterWorld(home);
    w.builder = w.okBuilder();
    const u = w.make({ checker: c, ...fastOpts() });
    assert.throws(() => u.install("0.2.0"), (e) => e.code === "hub-update:tag-moved");
    assert.throws(() => u.install("0.2.0", null, { acceptCommit: c1 }), (e) => e.code === "hub-update:tag-moved");
    u.install("0.2.0", null, { acceptCommit: c2 });
    await u.running;
    assert.equal(readInstall(home).commit, c2);
    assert.equal(c.available()?.moved, undefined);
    // push text
    const ctx = { facts: { get: (n) => (n === "hub.update" ? { label: "0.1.0", available: { version: "0.2.0", moved: { old: c1, new: c2 } }, install: {} } : null) }, lang: () => "ru" };
    assert.equal(hubDetail(ctx, "hub-update-tag-moved:0.2.0"), `0.2.0: ${c1.slice(0, 12)} → ${c2.slice(0, 12)}. Установка — только после подтверждения: окно покажет оба коммита`);
    c.stop();
  } finally {
    cleanup(home);
  }
});

test("review: the build is never taken from a planted Versions/<label> — neither on install nor on rollback", async () => {
  const home = tempHome("ah-hu-r13-");
  try {
    // (a) rollback: Versions/0.0.9 holds a foreign build C (both the bundle and build.json), the hub pinned A for 0.0.9
    seedVersion(home, "0.2.0", { cdhash: B });
    seedVersion(home, "0.0.9", { cdhash: C });
    setLink(join(home, "Versions", "current"), "0.2.0");
    setLink(join(home, "Versions", "previous"), "0.0.9");
    pinConfig(home, "0.2.0", B);
    const w = updaterWorld(home, { self: "0.2.0", available: null });
    const u = w.make(fastOpts());
    assert.throws(() => u.rollback(), (e) => e.code === "hub-update:untrusted-build", "no history record — refused right away");
    rememberPin(home, "0.0.9", { cdhash: A, op: "install" });
    u.rollback();
    await u.running;
    assert.equal(readInstall(home).error, "hub-update:verify-failed");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(B), "the foreign build is not pinned");
    assert.equal(u.expectsPin(`cdhash:${C}`), false);
    assert.ok(!w.calls.includes("begin"));
    // (b) install: a pre-placed Versions/0.3.0 with the tag's commit — not reused (a clone is mandatory)
    seedVersion(home, "0.3.0", { cdhash: C, commit: "3".repeat(40) });
    await assert.rejects(buildVersion({ home, label: "0.3.0", version: "0.3.0", source: { kind: "tag", remote: join(home, "nonexistent-origin.git"), tag: "v0.3.0", commit: "3".repeat(40) }, codeOf: testCodeOf }), (e) => e.code === "hub-update:clone-failed");
    assert.equal(pinnedCdhash(home, "0.3.0"), null);
  } finally {
    cleanup(home);
  }
});

test("review: hub rollback/migrate --apply — only from a human's terminal, not while paused (except --under-estop), the bundle is checked against build.json; a hub-update-cli journal record; origin with credentials — refused", () => {
  const root = tempHome("ah-hu-r14-");
  const home = join(root, "h");
  mkdirSync(home, { mode: 0o700 });
  try {
    seedVersion(home, "0.1.0", { cdhash: A });
    seedVersion(home, "0.2.0", { cdhash: B });
    setLink(join(home, "Versions", "current"), "0.2.0");
    setLink(join(home, "Versions", "previous"), "0.1.0");
    pinConfig(home, "0.2.0", B);
    const noTty = cli(home, ["hub", "rollback", "--apply"], { AGENTHUB_TEST_TTY: "" });
    assert.equal(noTty.status, 3, noTty.stderr);
    assert.match(noTty.stderr, /only from a human's terminal/);
    assert.equal(currentLabel(home), "0.2.0");
    writeFileSync(join(home, "ESTOP"), "");
    const paused = cli(home, ["hub", "rollback", "--apply"]);
    assert.equal(paused.status, 4, paused.stderr);
    assert.equal(currentLabel(home), "0.2.0");
    // the bundle is not the one in build.json
    const tc = join(home, "Versions", "0.1.0", "AgentHub.app", "Contents", "TEST-CDHASH");
    writeFileSync(tc, C);
    const forged = cli(home, ["hub", "rollback", "--apply", "--under-estop"]);
    assert.equal(forged.status, 1);
    assert.match(forged.stderr, /is not the build/);
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(B));
    writeFileSync(tc, A);
    const ok = cli(home, ["hub", "rollback", "--apply", "--under-estop"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(A));
    const j = readFileSync(join(home, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const e = j.find((x) => x.type === "hub-update-cli");
    assert.deepEqual([e.op, e.label, e.from, e.new, e.estop], ["rollback", "0.1.0", "0.2.0", `cdhash:${A}`, true]);
    assert.equal(readHistory(home).labels["0.1.0"].cdhash, A);
    assert.equal(readHistory(home).labels["0.2.0"].cdhash, B, "the build we left is in the history");
    rmSync(join(home, "ESTOP"));
    // migrate: no TTY — refused; origin with a token — refused
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync(GIT, ["init", "-q", "-b", "main", repo]);
    writeTree(repo, { version: "0.1.0", cdhash: A });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", "https://user:SECRET-TOKEN@example.invalid/agent-hub.git");
    const tok = cli(home, ["hub", "migrate", "--from", repo, "--no-launchd"]);
    assert.equal(tok.status, 1);
    assert.ok(!tok.stderr.includes("SECRET-TOKEN") && !tok.stdout.includes("SECRET-TOKEN"));
    assert.match(tok.stderr, /contains credentials/);
    git(repo, "remote", "set-url", "origin", "https://example.invalid/agent-hub.git");
    const mt = cli(home, ["hub", "migrate", "--from", repo, "--apply", "--no-launchd"], { AGENTHUB_TEST_TTY: "" });
    assert.equal(mt.status, 3, mt.stderr);
  } finally {
    cleanup(root);
  }
});

test("review: check.json and the release — tag exactly vVERSION, commit of 40 hex; otherwise the record is dropped and never reaches git", () => {
  const home = tempHome("ah-hu-r15-");
  try {
    const sha = "a".repeat(40);
    assert.deepEqual(validRelease({ version: "0.2.0", tag: "v0.2.0", commit: sha }), { version: "0.2.0", tag: "v0.2.0", commit: sha });
    for (const bad of [{ version: "0.2.0", tag: "main", commit: sha }, { version: "0.2.0", tag: "v0.2.1", commit: sha }, { version: "0.2.0", tag: "v0.2.0", commit: "HEAD" }, { version: "0.2.0", tag: "--upload-pack=x", commit: sha }, null]) assert.equal(validRelease(bad), null, JSON.stringify(bad));
    mkdirSync(join(home, "HubUpdate"), { recursive: true });
    writeFileSync(join(home, "HubUpdate", "check.json"), JSON.stringify({ version: 1, notified: {}, latest: { version: "0.2.0", tag: "main", commit: sha } }));
    const c = new HubUpdateChecker({ home, current: () => "0.1.0", remote: () => "/o.git" });
    assert.equal(c.available(), null);
    installedWorld(home);
    const u = updaterWorld(home, { available: { version: "0.2.0", tag: "main", commit: sha } }).make();
    assert.throws(() => u.install("0.2.0"), (e) => e.code === "hub-update:unknown-version");
  } finally {
    cleanup(home);
  }
});

test("review: a branch named like the tag in origin — the tag itself is taken (refs/tags), the build passes, a warning in the log", async () => {
  const root = tempHome("ah-hu-r16-");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  try {
    const o = originWorld(join(root, "o"));
    const r = o.release("0.2.0");
    git(o.work, "checkout", "-q", "-b", "tmp");
    writeFileSync(join(o.work, "extra.txt"), "x");
    git(o.work, "add", "-A");
    git(o.work, "commit", "-q", "-m", "ветка с именем тега");
    git(o.work, "push", "-q", "origin", "tmp:refs/heads/v0.2.0");
    git(o.work, "checkout", "-q", "main");
    const log = join(home, "b.log");
    const b = await buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "tag", remote: o.bare, tag: r.tag, commit: r.commit }, codeOf: testCodeOf, logPath: log });
    assert.equal(b.commit, r.commit);
    assert.ok(!existsSync(join(home, "Versions", "0.2.0", "src", "extra.txt")));
    assert.match(readFileSync(log, "utf8"), /a branch named like the tag v0\.2\.0/);
  } finally {
    cleanup(root);
  }
});

test("review: an origin URL with credentials does not reach the build log, the builder argv or build.json", async () => {
  const home = tempHome("ah-hu-r17-");
  try {
    const url = "http://user:SECRET-TOKEN@127.0.0.1:9/x.git";
    assert.equal(hasUserinfo(url), true);
    assert.equal(hasUserinfo("https://github.com/KenseiTheOne/agent-hub.git"), false);
    assert.equal(redactUrl(url), "http://***:***@127.0.0.1:9/x.git");
    assert.equal(redactText(`$ git fetch ${url} x`), "$ git fetch http://***@127.0.0.1:9/x.git x");
    // ssh: a user name only (ssh://git@…, like the scp form git@host:…) is not a secret: not refused and not "***"
    const ssh = "ssh://git@github.com/KenseiTheOne/agent-hub.git";
    assert.equal(hasUserinfo(ssh), false);
    assert.equal(hasUserinfo("git+ssh://git@github.com/KenseiTheOne/agent-hub.git"), false);
    assert.equal(redactUrl(ssh), ssh);
    assert.equal(redactText(`$ git ls-remote ${ssh}`), `$ git ls-remote ${ssh}`);
    assert.equal(hasUserinfo("https://git@github.com/x.git"), true, "a name in https is treated like a token");
    assert.equal(hasUserinfo("ssh://git:pw@github.com/x.git"), true, "a password in ssh is a secret");
    assert.equal(redactUrl("ssh://git:pw@github.com/x.git"), "ssh://git:***@github.com/x.git");
    assert.equal(redactText("ssh://git:pw@github.com/x.git"), "ssh://***@github.com/x.git");
    assert.equal(usableOrigin("ssh://***@github.com/x.git"), null, "a redacted URL from an old build is not used");
    assert.equal(usableOrigin(ssh), ssh);
    const log = join(home, "logs", "b.log");
    await assert.rejects(buildVersion({ home, label: "0.2.0", version: "0.2.0", source: { kind: "tag", remote: url, tag: "v0.2.0" }, origin: url, logPath: log, codeOf: testCodeOf }), (e) => e.code === "hub-update:clone-failed" && !String(e.detail).includes("SECRET"));
    const text = readFileSync(log, "utf8");
    assert.ok(!text.includes("SECRET-TOKEN"), text);
    assert.match(text, /\*\*\*/);
    const argv = builderArgv(home, { label: "0.2.0", version: "0.2.0", tag: "v0.2.0", commit: "2".repeat(40), branch: "main", log });
    assert.ok(argv.includes("--remote-stdin") && !argv.includes("--remote") && !argv.some((a) => a.includes("127.0.0.1")));
  } finally {
    cleanup(home);
  }
});

test("review: a hub pause set while the app was quitting — no switch: supervision is back in force, the previous app is launched, failed: estop", async () => {
  const home = tempHome("ah-hu-r18-");
  try {
    installedWorld(home);
    const w = updaterWorld(home);
    w.builder = w.okBuilder();
    w.conns = [{ pid: 777 }];
    const u = w.make(fastOpts({ appQuitMs: 5000 }));
    u.install("0.2.0");
    await waitFor(() => w.calls.includes("begin"));
    w.estop = true; // agenthub pause during these seconds
    w.conns = [];
    await u.running;
    assert.ok(w.calls.includes("abort") && w.calls.includes("relaunch"));
    assert.ok(!w.calls.includes("checkPin") && !w.calls.includes("restart"));
    assert.equal(currentLabel(home), "0.1.0");
    assert.equal(readCfg(home).requirements.app, cdhashRequirement(A));
    assert.deepEqual([readInstall(home).phase, readInstall(home).error], ["failed", "hub-update:estop"]);
  } finally {
    cleanup(home);
  }
});

// ---------- round 2: build deadlines and the builder's node ----------

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
async function gone(pid, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until && alive(pid)) await sleep(50);
  return !alive(pid);
}

test("build: a runLogged timeout also kills grandchildren (git-remote-https, swift-frontend) — the result comes at the deadline, not after the grandchild dies", async () => {
  const { runLogged } = await import("../lib/hub-update/build.mjs");
  const t0 = Date.now();
  // the grandchild `sleep 30` holds the inherited stdout; the direct child is bash
  const r = await runLogged(["/bin/bash", "-c", "sleep 30 & echo $!; wait"], { timeoutMs: 400, closeGraceMs: 300 });
  const took = Date.now() - t0;
  assert.ok(took < 3000, `returned in ${took} ms, not after 30 s`);
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
  const grandchild = Number(r.out.trim().split("\n")[0]);
  assert.ok(grandchild > 0);
  assert.ok(await gone(grandchild), "the grandchild is killed together with the child");
});

test("build: the process exited but a grandchild holds stdout — runLogged does not wait for it (result on exit + a short pause)", async () => {
  const { runLogged } = await import("../lib/hub-update/build.mjs");
  const t0 = Date.now();
  const r = await runLogged(["/bin/bash", "-c", "(sleep 4; true) & echo $!; echo ok"], { timeoutMs: 10_000, closeGraceMs: 200 });
  const took = Date.now() - t0;
  const bg = Number(r.out.trim().split("\n")[0]);
  try {
    assert.ok(took < 2000, `returned in ${took} ms`);
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
  } finally {
    try {
      process.kill(bg, "SIGKILL");
    } catch {}
  }
});

test("service: the builder's overall deadline — the builder is killed together with grandchildren, result timedOut; no node — node-missing without an exception", async () => {
  const { runBuilder, childNode, builderTimeoutMs } = await import("../lib/services/hub-update.mjs");
  // "builder": step clone, a grandchild holds stdout, the builder itself hangs
  const script = 'const {spawn}=require("node:child_process");const c=spawn("/bin/sleep",["30"],{stdio:["ignore","inherit","inherit"]});process.stdout.write(JSON.stringify({step:"clone"})+"\\n"+JSON.stringify({grandchild:c.pid})+"\\n");setInterval(()=>{},1000);';
  const steps = [];
  const t0 = Date.now();
  const b = runBuilder(process.execPath, ["-e", script], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 600, graceMs: 300, onStep: (s) => steps.push(s) });
  assert.ok(b.pid > 0);
  const r = await b.done;
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
  assert.deepEqual(steps, ["clone"]);
  const gc = JSON.parse(r.out.split("\n")[1]).grandchild;
  assert.ok(await gone(gc), "the builder's grandchild is killed");
  assert.ok(await gone(b.pid), "the builder is killed");

  // node removed (brew upgrade node): an immediate result, no uncaughtException
  assert.deepEqual(await runBuilder(null, []).done, { code: -1, out: "", error: "node-missing" });
  const r2 = await runBuilder("/nonexistent/node-26.5.1/bin/node", ["-e", "1"], { timeoutMs: 5000 }).done;
  assert.equal(r2.code, -1);
  assert.equal(r2.error, "ENOENT");

  // the builder's node: argv0 (as launchd started it) → execPath → launchdNode; none — null
  const ex = (set) => (p) => set.includes(p);
  assert.equal(childNode({ argv0: "/opt/homebrew/bin/node", execPath: "/opt/homebrew/Cellar/node/26.5.1/bin/node", exists: ex(["/opt/homebrew/bin/node"]) }), "/opt/homebrew/bin/node");
  assert.equal(childNode({ argv0: "node", execPath: "/x/node", exists: ex(["/x/node"]) }), "/x/node");
  assert.equal(childNode({ argv0: "/gone/node", execPath: "/gone/node2", exists: ex(["/usr/local/bin/node"]), fallback: () => "/usr/local/bin/node" }), "/usr/local/bin/node");
  assert.equal(childNode({ argv0: "/gone/node", execPath: "/gone/node2", exists: () => false, fallback: () => null }), null);
  // the builder deadline covers all steps
  assert.ok(builderTimeoutMs() > 30 * 60_000 + 3 * 5 * 60_000 + 60_000);
});

test("install: the builder did not start (node removed) — hub-update:node-missing and a log line; killed by the deadline — hub-update:build-timeout", async () => {
  for (const [done, code] of [
    [{ code: -1, out: "", error: "ENOENT" }, "hub-update:node-missing"],
    [{ code: -1, out: '{"step":"clone"}\n', timedOut: true }, "hub-update:build-timeout"],
  ]) {
    const home = tempHome("ah-hu-nm-");
    try {
      seedVersion(home, "0.1.0", { cdhash: A });
      setLink(join(home, "Versions", "current"), "0.1.0");
      pinConfig(home, "0.1.0", A);
      const w = updaterWorld(home);
      w.builder = () => ({ pid: null, done: Promise.resolve(done) });
      const u = w.make();
      u.install("0.2.0", { class: "app", pid: 1 });
      await u.running;
      const st = readInstall(home);
      assert.deepEqual([st.phase, st.error], ["failed", code]);
      assert.ok(st.log && existsSync(st.log), "\"Show log\" leads to the file");
      assert.match(readFileSync(st.log, "utf8"), new RegExp(code));
      assert.equal(currentLabel(home), "0.1.0");
      u.stop();
    } finally {
      cleanup(home);
    }
  }
});

test("platform: process descendants from the ps table; killProcessTree signals the process and all its descendants", () => {
  const { descendantPids, killProcessTree } = PLATFORM_MOD;
  const ps = "  10 1\n  11 10\n  12 11\n  13 10\n  20 1\n  21 20\n";
  assert.deepEqual(descendantPids(10, { psOutput: ps, platform: "darwin" }).sort(), [11, 12, 13]);
  assert.deepEqual(descendantPids(10, { psOutput: ps, platform: "win32" }), []);
  const sent = [];
  assert.equal(killProcessTree(10, "SIGKILL", { psOutput: ps, platform: "darwin", kill: (p, s) => sent.push([p, s]) }), 4);
  assert.deepEqual(sent.map((x) => x[0]).sort(), [10, 11, 12, 13]);
});
