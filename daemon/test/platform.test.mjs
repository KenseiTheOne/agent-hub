// Platform layer: the core does not hardcode Unix specifics (/usr/bin and /bin/kill paths, process.getuid, process
// groups, ~/Library), and the Windows branches return sensible values (named pipe, %LOCALAPPDATA%, taskkill).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative } from "node:path";
import { awakeModeOf, DAEMON_DIR } from "../lib/config.mjs";
import {
  AWAKE_SUDOERS,
  awakeCommands,
  awakeControl,
  awakeSudoersCommands,
  awakeSudoersRule,
  interpreterFor,
  openCommand,
  parseBattery,
  parseHasLid,
  parseSleepDisabled,
  stateDir,
  terminateCommand,
  transportPath,
  transportProblem,
  treeSpawnOptions,
  usesFileModes,
} from "../lib/platform.mjs";
import { cleanup, IS_DARWIN, tempHome } from "./helpers.mjs";

// Modules that are inherently macOS-only (launchd, notifications, keychain, codesign/peercred, .app build), plus the
// platform layer itself. The core (server, host, runner, generic primitives) is not.
const MAC_ONLY = new Set([
  "lib/platform.mjs",
  "lib/launchd.mjs",
  "lib/app-sign.mjs", // codesign of the build for agenthub pin-app
  "lib/peer.mjs", // codesign, until Windows signature checks (WinVerifyTrust)
  "lib/native.mjs",
  "lib/meta.mjs", // binary xattrs, the fallback path without the addon
  "lib/push/idle.mjs",
  "lib/push/macos.mjs",
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

// ---------- staying awake with the lid closed ----------
// The samples are real output (macOS 26, MacBook Pro), shortened.

const PMSET_ON = `System-wide power settings:
 SleepDisabled\t\t1
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            10
 sleep                1 (sleep prevented by caffeinate, powerd, coreaudiod)
 hibernatemode        3
 ttyskeepawake        1
 displaysleep         2
 tcpkeepalive         1
 lowpowermode         0
 womp                 0
`;
const BATT_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=22085731)\t63%; discharging; 3:32 remaining present: true
`;
const BATT_AC = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=22085731)\t100%; charged; 0:00 remaining present: true
`;
const IOREG_LID = `+-o IOPMrootDomain  <class IOPMrootDomain, id 0x100000117, registered, matched, active, busy 0 (0 ms), retain 12>
    {
      "AppleClamshellCausesSleep" = Yes
      "AppleClamshellState" = No
      "SleepDisabled" = Yes
    }
`;

test("awake: the flag, the battery and the lid are read from pmset and ioreg output", () => {
  assert.equal(parseSleepDisabled(PMSET_ON), true);
  assert.equal(parseSleepDisabled(PMSET_ON.replace("SleepDisabled\t\t1", "SleepDisabled\t\t0")), false);
  // the flag has its own line: `sleep 1 (sleep prevented by …)` and "SleepDisabled" inside another word are not it
  assert.equal(parseSleepDisabled(PMSET_ON.replace(" SleepDisabled\t\t1\n", "")), null);
  assert.equal(parseSleepDisabled(" NotSleepDisabledAtAll 1\n"), null);
  assert.equal(parseSleepDisabled(""), null);
  assert.equal(parseSleepDisabled(null), null);

  assert.deepEqual(parseBattery(BATT_BATTERY), { onBattery: true, charge: 63 });
  assert.deepEqual(parseBattery(BATT_AC), { onBattery: false, charge: 100 });
  // a desktop Mac: mains, no battery line
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n"), { onBattery: false, charge: null });
  // a UPS is neither: the guard must not act on a guess
  assert.deepEqual(parseBattery("Now drawing from 'UPS Power'\n -UPS-1 (id=1)\t80%; discharging\n"), { onBattery: null, charge: null });
  assert.deepEqual(parseBattery(""), { onBattery: null, charge: null });

  assert.equal(parseHasLid(IOREG_LID), true);
  assert.equal(parseHasLid(""), false, "a desktop Mac prints nothing");
  assert.equal(parseHasLid(IOREG_LID.replace(/^.*AppleClamshellState.*\n/m, "")), false);
});

test("awake: the commands — two exact pmset calls through sudo -n, nothing off macOS", () => {
  const c = awakeCommands({ platform: "darwin" });
  assert.deepEqual(c.flag, ["/usr/bin/pmset", "-g"]);
  assert.deepEqual(c.battery, ["/usr/bin/pmset", "-g", "batt"]);
  assert.deepEqual(c.set(true), ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-a", "disablesleep", "1"]);
  assert.deepEqual(c.set(false), ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-a", "disablesleep", "0"]);
  // -k: a live sudo timestamp must not answer for the rule
  assert.deepEqual(c.granted, ["/usr/bin/sudo", "-n", "-k", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"]);
  assert.equal(awakeCommands({ platform: "win32" }), null);
  assert.equal(awakeCommands({ platform: "linux" }), null);
  assert.equal(awakeSudoersCommands("/t/rule", "/etc/sudoers.d/agenthub-sleep", { platform: "linux" }), null);
  const s = awakeSudoersCommands("/t/rule", "/etc/sudoers.d/agenthub-sleep", { platform: "darwin" });
  assert.deepEqual(s.check, ["/usr/sbin/visudo", "-cf", "/t/rule"]);
  assert.deepEqual(s.install, ["/usr/bin/sudo", "/usr/bin/install", "-m", "0440", "-o", "root", "-g", "wheel", "/t/rule", "/etc/sudoers.d/agenthub-sleep"]);
  assert.deepEqual(s.remove, ["/usr/bin/sudo", "/bin/rm", "-f", "/etc/sudoers.d/agenthub-sleep"]);
  assert.deepEqual(AWAKE_SUDOERS, { dir: "/etc/sudoers.d", name: "agenthub-sleep" });
});

const GOOD_USERS = ["_svc-user_1", "first.last", "First.Last", "Kensei", "1user", "a", "A1b", "john-doe", "user_2", "Ab"];

test("awake: the sudoers rule names exactly the two commands; a user name that is not a plain short name is refused", () => {
  const rule = awakeSudoersRule("kensei");
  const lines = rule.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines, ["kensei ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1"]);
  assert.ok(rule.endsWith("\n"));
  // real macOS short names: both cases, digits (also first), "_", "-", a dot inside
  for (const good of GOOD_USERS) assert.ok(awakeSudoersRule(good)?.includes(`\n${good} ALL=(root) NOPASSWD: `), good);
  // anything that could add a rule of its own or change this one: separators and specials, a leading dash or dot, and a
  // word of capitals only — sudoers reads that as an alias, and ALL as every user
  for (const bad of ["", "a b", "a,b", "kensei\nroot ALL=(ALL) NOPASSWD: ALL", "ALL", "ADMINS", "A", "WHEEL_1", "-abc", ".abc", "a".repeat(33), "ke%nsei", "%admin", "k#", "#501", "+net", "!kensei", "a=b", "a:b", "a@b", 'a"b', "a\\b", "a/b", "a\tb", "кенсей", null, undefined, 42]) {
    assert.equal(awakeSudoersRule(bad), null, JSON.stringify(bad));
  }
});

test("awake: visudo accepts the rule text and rejects a broken file (no root needed for -cf on a file of our own)", { skip: !IS_DARWIN || !existsSync("/usr/sbin/visudo") }, () => {
  const dir = tempHome("ah-sudoers-");
  try {
    const file = join(dir, "rule");
    const { check } = awakeSudoersCommands(file, join(dir, "target"));
    // every name the hub lets through makes a file visudo accepts
    for (const user of ["kensei", ...GOOD_USERS]) {
      writeFileSync(file, awakeSudoersRule(user), { mode: 0o600 });
      execFileSync(check[0], check.slice(1), { stdio: "ignore" });
    }
    writeFileSync(file, "kensei ALL=(root NOPASSWD /usr/bin/pmset\n");
    assert.throws(() => execFileSync(check[0], check.slice(1), { stdio: "ignore" }));
  } finally {
    cleanup(dir);
  }
});

test("awake: a test directory runs no system command — the double file, or nothing; the real commands only when asked", async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv.join(" "));
    return { code: 0, stdout: argv.includes("batt") ? BATT_BATTERY : argv[0].endsWith("ioreg") ? IOREG_LID : PMSET_ON, stderr: "" };
  };
  // test mode, no double: nothing runs, nothing is supported
  const off = awakeControl({ platform: "darwin", testMode: true, runner });
  assert.equal(off.mode, "off");
  assert.equal(await off.lid(), false);
  assert.equal(await off.flag(), null);
  assert.equal(await off.granted(), false);
  assert.deepEqual(await off.battery(), { onBattery: null, charge: null });
  assert.deepEqual(await off.set(true), { ok: false, skipped: "test-mode" });
  assert.deepEqual(calls, []);

  // the double: read and written instead of the commands
  const dir = tempHome("ah-awake-");
  try {
    const file = join(dir, "awake.json");
    const put = (d) => writeFileSync(file, JSON.stringify(d));
    const get = () => JSON.parse(readFileSync(file, "utf8"));
    put({ flag: false, granted: true, lid: true, charge: 63, onBattery: true });
    const d = awakeControl({ platform: "darwin", testMode: true, testFile: file, runner });
    assert.equal(d.mode, "double");
    assert.deepEqual([await d.lid(), await d.flag(), await d.granted(), await d.battery()], [true, false, true, { onBattery: true, charge: 63 }]);
    assert.deepEqual(await d.set(true), { ok: true, code: 0 });
    assert.deepEqual(get(), { flag: true, granted: true, lid: true, charge: 63, onBattery: true });
    assert.equal(await d.flag(), true);
    // no rule: sudo refuses the command and the flag stays
    put({ ...get(), granted: false });
    assert.deepEqual(await d.set(false), { ok: false, code: 1, refused: true });
    assert.equal(get().flag, true);
    // the command itself fails — not a refusal
    put({ ...get(), granted: true, fail: true });
    assert.deepEqual(await d.set(false), { ok: false, code: 1 });
    // what cannot be read is unknown, not "off" and not "no lid"
    put({ flag: true, granted: true, lid: null, blind: true });
    assert.deepEqual([await d.lid(), await d.flag()], [null, null]);
    // a missing or broken file reads as "nothing here"
    writeFileSync(file, "{");
    assert.deepEqual([await d.lid(), await d.flag(), await d.granted(), await d.battery()], [false, false, false, { onBattery: null, charge: null }]);
    assert.deepEqual(calls, []);
    // outside test mode the double is ignored: the live hub cannot be pointed at a file
    assert.equal(awakeControl({ platform: "darwin", testMode: false, testFile: file, runner }).mode, "system");
  } finally {
    cleanup(dir);
  }

  // the system (a live hub, or a stand with AGENTHUB_AWAKE_REAL=1) — through the runner
  const rules = tempHome("ah-sudoers-");
  try {
    const ruleFile = join(rules, "agenthub-sleep");
    const sys = awakeControl({ platform: "darwin", testMode: true, real: true, runner, ruleFile });
    assert.equal(sys.mode, "system");
    assert.equal(await sys.lid(), true);
    assert.equal(await sys.lid(), true);
    assert.equal(await sys.flag(), true);
    // no rule file — not granted, and sudo is not even asked: its yes would not be about our rule
    assert.equal(await sys.granted(), false);
    assert.deepEqual(calls, ["/usr/sbin/ioreg -r -k AppleClamshellState -d 1", "/usr/bin/pmset -g"], "the lid is asked once: a Mac does not grow one");
    writeFileSync(ruleFile, "rule");
    assert.equal(await sys.granted(), true);
    assert.deepEqual(await sys.battery(), { onBattery: true, charge: 63 });
    assert.deepEqual(await sys.set(false), { ok: true, code: 0 });
    assert.deepEqual(calls.slice(2), ["/usr/bin/sudo -n -k -l /usr/bin/pmset -a disablesleep 1", "/usr/bin/pmset -g batt", "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"]);

    // sudo refuses the switch although the probe says yes (a rule for another account, an unrelated password-free
    // entry): not granted from then on, without asking sudo again — until the rule file is replaced
    let probes = 0;
    const refusing = awakeControl({
      platform: "darwin",
      ruleFile,
      runner: async (argv) => {
        if (argv.includes("-l")) {
          probes++;
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "sudo: a password is required\n" };
      },
    });
    assert.equal(await refusing.granted(), true);
    assert.deepEqual(await refusing.set(true), { ok: false, code: 1, refused: true });
    assert.equal(await refusing.granted(), false);
    assert.equal(probes, 1);
    rmSync(ruleFile);
    writeFileSync(ruleFile, "another rule, longer");
    assert.equal(await refusing.granted(), true, "a new rule file is asked about again");

    // pmset itself failing, a timeout — not a refusal; an unreadable flag and lid — unknown
    const failing = awakeControl({ platform: "darwin", ruleFile, runner: async (argv) => ({ code: argv.includes("-l") ? 0 : 1, stdout: "", stderr: "pmset: no such setting\n" }) });
    assert.deepEqual(await failing.set(true), { ok: false, code: 1 });
    assert.equal(await failing.granted(), true);
    assert.equal(await failing.flag(), null);
    assert.equal(await failing.lid(), null, "a failed ioreg is not \"no lid\"");
    const slow = awakeControl({ platform: "darwin", ruleFile, runner: async () => ({ code: -1, stdout: "", stderr: "sudo: timed out\n", timedOut: true }) });
    assert.deepEqual(await slow.set(false), { ok: false, code: -1 });
    // the timeouts the quit path asks for reach the runner
    const seen = [];
    const timed = awakeControl({ platform: "darwin", ruleFile, runner: async (argv, ms) => (seen.push(ms), { code: 0, stdout: PMSET_ON, stderr: "" }) });
    await timed.flag();
    await timed.flag({ timeoutMs: 1000 });
    await timed.set(false);
    await timed.set(false, { timeoutMs: 1500 });
    assert.deepEqual(seen, [5000, 1000, 10_000, 1500]);
  } finally {
    cleanup(rules);
  }
  assert.equal(awakeControl({ platform: "linux" }).mode, "off");
});

test("awake: only the account's live directory touches the machine — the test switches are ignored there, and a fake-HOME \"live\" directory runs nothing", (t) => {
  const live = join(userInfo().homedir, "Library", "Application Support", "AgentHub");
  const vars = { AGENTHUB_TEST_AWAKE_FILE: "/tmp/agenthub-x/awake.json", AGENTHUB_TEST_SUDOERS_DIR: "/tmp/agenthub-x/sudoers.d", AGENTHUB_AWAKE_REAL: "1" };
  const modeOf = (m) => awakeControl({ platform: "darwin", testMode: m.awakeTest, testFile: m.testAwakeFile, real: m.awakeReal, runner: async () => ({ code: 1, stdout: "", stderr: "" }) }).mode;
  // a test directory: the doubles and the stand switch work
  const testDir = awakeModeOf({ ...vars, AGENTHUB_HOME: "/tmp/agenthub-test-home-x" });
  assert.deepEqual(testDir, { awakeTest: true, testAwakeFile: "/tmp/agenthub-x/awake.json", testSudoersDir: "/tmp/agenthub-x/sudoers.d", awakeReal: true });
  assert.equal(modeOf(testDir), "double");
  assert.equal(modeOf(awakeModeOf({ AGENTHUB_HOME: "/tmp/agenthub-test-home-x", AGENTHUB_AWAKE_REAL: "1" })), "system");
  assert.equal(modeOf(awakeModeOf({ AGENTHUB_HOME: "/tmp/agenthub-test-home-x" })), "off");
  // the live directory named through AGENTHUB_HOME is still the live hub: the system, and none of the test switches
  const viaEnv = awakeModeOf({ ...vars, AGENTHUB_HOME: live });
  assert.deepEqual(viaEnv, { awakeTest: false, testAwakeFile: null, testSudoersDir: null, awakeReal: false });
  assert.equal(modeOf(viaEnv), "system");
  assert.deepEqual(awakeModeOf({ ...vars }, live), viaEnv);
  // a fake HOME (install tests, tools): the directory looks live by $HOME — it must not reach the real machine, and the
  // test switches do not turn it into a stand either
  const savedHome = process.env.HOME;
  process.env.HOME = "/tmp/agenthub-fake-home";
  t.after(() => (process.env.HOME = savedHome));
  const fakeLive = join("/tmp/agenthub-fake-home", "Library", "Application Support", "AgentHub");
  const fake = awakeModeOf({ ...vars, HOME: "/tmp/agenthub-fake-home" }, fakeLive);
  assert.deepEqual(fake, { awakeTest: true, testAwakeFile: null, testSudoersDir: null, awakeReal: false });
  assert.equal(modeOf(fake), "off");
  // …while AGENTHUB_HOME pointing at the real live directory from under a fake HOME is the live hub
  assert.equal(awakeModeOf({ ...vars, HOME: "/tmp/agenthub-fake-home", AGENTHUB_HOME: live }).awakeTest, false);
});
