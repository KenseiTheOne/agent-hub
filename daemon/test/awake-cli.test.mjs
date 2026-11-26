// `agenthub awake status | on | off | grant | revoke` as a separate process against a daemon in a temporary
// AGENTHUB_HOME. The machine is two doubles: AGENTHUB_TEST_AWAKE_FILE (the flag, the lid, the battery) and
// AGENTHUB_TEST_SUDOERS_DIR (the rule file). No test runs sudo or `pmset -a`, none writes to /etc; the rule text
// still goes through the real `visudo -cf` (it checks a file of ours and needs no root).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DAEMON_DIR, loadConfig } from "../lib/config.mjs";
import { awakeGrant } from "../lib/hub-update/cli.mjs";
import { AWAKE_SUDOERS, awakeSudoersRule } from "../lib/platform.mjs";
import { cleanup, onlyDarwin, scrubAwakeEnv, tempHome, waitFor } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");
const skip = onlyDarwin("the peer class comes from the peercred addon");
const USER = userInfo().username;
// an account name the rule cannot take (capitals only, a space): the grant itself is not checked there
const plainUser = awakeSudoersRule(USER) !== null;

function world() {
  const home = tempHome("ah-awc-");
  const box = tempHome("ah-awx-");
  const file = join(box, "awake.json");
  const sudoers = join(box, "sudoers.d");
  const env = { ...scrubAwakeEnv({ ...process.env }), AGENTHUB_HOME: home, AGENTHUB_SERVICES: "awake", AGENTHUB_BUILTIN_PLUGINS: join(box, "plugins"), AGENTHUB_TEST_AWAKE_FILE: file, AGENTHUB_TEST_SUDOERS_DIR: sudoers, AGENTHUB_SYSTEM_LANG: "en" };
  for (const k of ["NODE_OPTIONS", "AGENTHUB_LANG", "AGENTHUB_TEST_TTY"]) delete env[k];
  const w = {
    home,
    box,
    file,
    sudoers,
    rule: join(sudoers, AWAKE_SUDOERS.name),
    env,
    read: () => JSON.parse(readFileSync(file, "utf8")),
    patch: (p) => writeFileSync(file, JSON.stringify({ ...w.read(), ...p })),
    cli: (args, extra = {}) =>
      new Promise((resolve) => {
        execFile(process.execPath, [join(BIN, "agenthub"), ...args], { env: { ...env, ...extra }, timeout: 20_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
      }),
    journal: () =>
      readFileSync(join(home, "journal.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    daemon: null,
    async start() {
      w.daemon = spawn(process.execPath, [join(BIN, "agenthubd")], { env, stdio: "ignore" });
      await waitFor(() => existsSync(join(home, "hub.sock")), { timeoutMs: 8000 });
    },
    async stop() {
      const d = w.daemon;
      w.daemon = null;
      if (!d || d.exitCode !== null) return;
      d.kill("SIGTERM");
      await waitFor(() => d.exitCode !== null, { timeoutMs: 6000 });
    },
    async end() {
      await w.stop().catch(() => {});
      cleanup(home);
      cleanup(box);
    },
  };
  writeFileSync(file, JSON.stringify({ flag: false, granted: false, lid: true, charge: 80, onBattery: true }));
  return w;
}

test("agenthub awake: status, the switch is refused without the rule; grant installs it (checked by visudo), on/off switch the flag, revoke returns sleep and removes the rule", { skip: skip || (!plainUser && "the account name cannot go into a sudoers rule") }, async () => {
  const w = world();
  try {
    await w.start();
    const st = await w.cli(["awake", "status"]);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /^Awake with the lid closed: off$/m);
    assert.match(st.stdout, /^rights: +none — grant: agenthub awake grant$/m);
    assert.match(st.stdout, /^power: +battery, charge 80%$/m);
    assert.match(st.stdout, /^threshold: +10% — on the battery below it the hub returns sleep by itself$/m);
    // no rule — the switch is refused, and the answer says how to get the rights
    const denied = await w.cli(["awake", "on"]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /^No rights: .*agenthub awake grant/);
    assert.equal(w.read().flag, false);

    // the rule lands in place but sudo does not apply it (sudoers.d not included): the grant must not report success
    w.patch({ inert: true });
    const inert = await w.cli(["awake", "grant"]);
    assert.equal(inert.code, 1, inert.stderr + inert.stdout);
    assert.match(inert.stderr, /^awake grant: the rule is in .*, but sudo does not apply it\. Check that \/etc\/sudoers includes the sudoers\.d directory/);
    assert.doesNotMatch(inert.stdout, /Rights granted/);
    assert.ok(existsSync(w.rule));
    assert.equal(JSON.parse((await w.cli(["awake", "status", "--json"])).stdout).granted, false);
    assert.ok(!w.journal().some((e) => e.op === "awake-grant"));
    w.patch({ inert: false });

    // the file alone is not "already granted": it is written again, and this time it works
    const grant = await w.cli(["awake", "grant"]);
    assert.equal(grant.code, 0, grant.stderr + grant.stdout);
    assert.match(grant.stdout, /^Rights granted: /);
    assert.ok(grant.stdout.includes(w.rule), "the file is named as a full path");
    assert.equal(readFileSync(w.rule, "utf8"), awakeSudoersRule(USER));
    assert.match(readFileSync(w.rule, "utf8"), new RegExp(`^${USER} ALL=\\(root\\) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1$`, "m"));
    assert.equal((statSync(w.rule).mode & 0o777).toString(8), "440");
    assert.deepEqual(readdirSync(w.sudoers), [AWAKE_SUDOERS.name], "nothing but the rule lands in the directory");
    assert.equal(w.read().granted, true, "the two doubles act as one machine");
    const j = w.journal().find((e) => e.type === "hub-update-cli" && e.op === "awake-grant");
    assert.equal(j?.file, w.rule);
    // the daemon was told to look again: the section follows the grant without waiting for the next check
    assert.equal(JSON.parse((await w.cli(["awake", "status", "--json"])).stdout).granted, true);
    const again = await w.cli(["awake", "grant"]);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /^Rights are already granted/);
    // sudo saying yes is not enough either (a live sudo timestamp, some other password-free rule): without the file the
    // rule is written — and the daemon, too, reports the rights only with the file in place
    rmSync(w.rule);
    assert.equal(JSON.parse((await w.cli(["awake", "status", "--json"])).stdout).granted, false);
    const rewritten = await w.cli(["awake", "grant"]);
    assert.equal(rewritten.code, 0, rewritten.stderr + rewritten.stdout);
    assert.match(rewritten.stdout, /^Rights granted: /);
    assert.ok(existsSync(w.rule));
    assert.equal(JSON.parse((await w.cli(["awake", "status", "--json"])).stdout).granted, true);

    const on = await w.cli(["awake", "on"]);
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /^The Mac will stay awake with the lid closed\. On the battery below 10% the hub returns sleep by itself\. Turn off: agenthub awake off\n$/);
    assert.equal(w.read().flag, true);
    // bare `agenthub awake` is the status; the hub language applies
    assert.match((await w.cli(["awake"])).stdout, /^Awake with the lid closed: on$/m);
    const ru = await w.cli(["awake", "status"], { AGENTHUB_SYSTEM_LANG: "ru" });
    assert.match(ru.stdout, /^Не спать с закрытой крышкой: включено$/m);
    assert.match(ru.stdout, /^права: +выданы$/m);
    assert.match(ru.stdout, /^питание: +батарея, заряд 80%$/m);
    assert.deepEqual(Object.keys(JSON.parse((await w.cli(["awake", "status", "--json"], { AGENTHUB_SYSTEM_LANG: "ru" })).stdout)), ["supported", "granted", "on", "onBattery", "charge", "threshold"], "machine output is the /state.awake section in any language");
    const off = await w.cli(["awake", "off"]);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /^Sleep is back/);
    assert.equal(w.read().flag, false);

    // on the battery below the threshold: the guard returns sleep at once, and the command does not report success
    w.patch({ charge: 9 });
    const low = await w.cli(["awake", "on"]);
    assert.equal(low.code, 1);
    assert.match(low.stderr, /^Charge 9% is below the 10% threshold: sleep was returned right away/);
    assert.equal(w.read().flag, false);
    // the command itself fails: a clear line, the flag stays
    w.patch({ charge: 80, fail: true });
    const failed = await w.cli(["awake", "on"]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /^The pmset command did not work/);
    w.patch({ fail: false });
    // sudo refuses it (the rule does not work for this account): "no rights" with the way to get them, not "try again"
    w.patch({ refuse: true });
    const refused = await w.cli(["awake", "on"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^No rights: .*agenthub awake grant/);
    assert.equal(JSON.parse((await w.cli(["awake", "status", "--json"])).stdout).granted, false);
    assert.equal(w.read().flag, false);
    w.patch({ refuse: false });
    assert.equal(JSON.parse((await w.cli(["awake", "status", "--json"])).stdout).granted, true);

    const usage = await w.cli(["awake", "sometimes"]);
    assert.equal(usage.code, 64);
    assert.match(usage.stderr, /^agenthub awake \[status \[--json\]\] \| on \| off \| grant \| revoke/);
    assert.match((await w.cli(["help-me"])).stdout, /\| awake \[status\|on\|off\|grant\|revoke\]/, "cli.usage lists the command");

    // revoke: sleep first (the rule still allows it), then the rule
    assert.equal((await w.cli(["awake", "on"])).code, 0);
    const revoke = await w.cli(["awake", "revoke"]);
    assert.equal(revoke.code, 0, revoke.stderr + revoke.stdout);
    assert.match(revoke.stdout, /^Sleep is back \(pmset -a disablesleep 0\)\.\nThe rule .* is removed/);
    assert.ok(!existsSync(w.rule));
    assert.deepEqual({ flag: w.read().flag, granted: w.read().granted }, { flag: false, granted: false });
    assert.equal(JSON.parse((await w.cli(["awake", "status", "--json"])).stdout).granted, false);
    const rj = w.journal().find((e) => e.type === "hub-update-cli" && e.op === "awake-revoke");
    assert.deepEqual({ removed: rj?.removed, sleepReturned: rj?.sleepReturned, stillOn: rj?.stillOn }, { removed: true, sleepReturned: true, stillOn: false });
    const none = await w.cli(["awake", "revoke"]);
    assert.equal(none.code, 0);
    assert.match(none.stdout, /^There is no rule/);

    // the flag set by hand and no rule: the hub cannot return sleep — both commands say so, with the command that does
    w.patch({ flag: true });
    const stuck = await w.cli(["awake", "status"]);
    assert.match(stuck.stdout, /^Awake with the lid closed: on$/m);
    assert.match(stuck.stdout, /^Sleep is disabled and the hub has no rights: .*sudo pmset -a disablesleep 0$/m);
    const cant = await w.cli(["awake", "revoke"]);
    assert.equal(cant.code, 1, "not a clean revoke while sleep is disabled");
    assert.match(cant.stdout, /Sleep is still disabled \(SleepDisabled 1\).*sudo pmset -a disablesleep 0/);
    assert.equal(w.read().flag, true, "nothing switches the flag without the rule");

    // a Mac without a lid: nothing to switch and nothing to grant
    w.patch({ flag: false, lid: false });
    assert.match((await w.cli(["awake", "status"])).stdout, /^This Mac has no lid/);
    const noLid = await w.cli(["awake", "on"]);
    assert.equal(noLid.code, 1);
    assert.match(noLid.stderr, /^This Mac has no lid/);
    const noLidGrant = await w.cli(["awake", "grant"]);
    assert.equal(noLidGrant.code, 1);
    assert.ok(!existsSync(w.rule));

    // no daemon: status and the switch have nobody to ask; the rule does not need one
    w.patch({ lid: true });
    await w.stop();
    const down = await w.cli(["awake", "status"]);
    assert.equal(down.code, 2);
    assert.match(down.stderr, /^daemon unreachable: /);
    assert.equal((await w.cli(["awake", "on"])).code, 2);
    assert.equal((await w.cli(["awake", "grant"])).code, 0);
    assert.ok(existsSync(w.rule));
    assert.equal((await w.cli(["awake", "revoke"])).code, 0);
    assert.ok(!existsSync(w.rule));
  } finally {
    await w.end();
  }
});

test("agenthub awake grant | revoke in a test directory without the doubles: refused, nothing is run or written; the awake service off — a clear line", { skip }, async () => {
  const w = world();
  try {
    const bare = { AGENTHUB_TEST_AWAKE_FILE: "", AGENTHUB_TEST_SUDOERS_DIR: "" };
    for (const sub of ["grant", "revoke"]) {
      const r = await w.cli(["awake", sub], bare);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /is a test directory, and the sleep flag and the sudoers rule are machine-wide/);
      assert.ok(r.stderr.includes(w.home));
    }
    assert.ok(!existsSync(w.sudoers));
    // the awake double alone: the flag has a double, the rule has nowhere to go
    const half = await w.cli(["awake", "grant"], { AGENTHUB_TEST_SUDOERS_DIR: "" });
    assert.equal(half.code, 2);
    assert.equal(w.read().granted, false);
    // services.awake off (here — AGENTHUB_SERVICES=none): no /awake behind the route
    w.env.AGENTHUB_SERVICES = "none";
    await w.start();
    const off = await w.cli(["awake", "status"]);
    assert.equal(off.code, 1);
    assert.match(off.stderr, /^The awake service is turned off/);
  } finally {
    await w.end();
  }
});

test("awake grant: a user name that is not a plain account name never reaches the rule file", async (t) => {
  const w = world();
  const said = [];
  t.mock.method(console, "error", (s) => said.push(String(s)));
  t.mock.method(console, "log", (s) => said.push(String(s)));
  try {
    const config = loadConfig({ env: w.env });
    for (const user of ["Bad Name", "root, ALL", "me\nroot ALL=(ALL) NOPASSWD: ALL", "%admin", "#0", "ALL", "ADMINS", ".hidden", "", "a".repeat(33)]) {
      assert.equal(await awakeGrant({ config, isLiveHome: false, user }), 2, JSON.stringify(user));
    }
    assert.ok(!existsSync(w.sudoers), "nothing is written");
    assert.equal(w.read().granted, false);
    assert.ok(said.every((s) => /cannot go into a sudoers rule|не годится для правила sudoers/.test(s)), said.join("\n"));
    assert.ok(!said.some((s) => s.includes("\n")), "the refused name is shown escaped, on one line");
    // and a plain one goes through (no daemon needed)
    assert.equal(await awakeGrant({ config, isLiveHome: false, user: "some_user-1" }), 0);
    assert.match(readFileSync(w.rule, "utf8"), /^some_user-1 ALL=\(root\) NOPASSWD: /m);
    // …and so do the account names macOS really gives: a dot inside, capitals, a leading digit
    for (const user of ["first.last", "First.Last", "1user"]) {
      rmSync(w.rule);
      assert.equal(await awakeGrant({ config, isLiveHome: false, user }), 0, user);
      assert.ok(readFileSync(w.rule, "utf8").includes(`\n${user} ALL=(root) NOPASSWD: `), user);
    }
  } finally {
    await w.end();
  }
});

test("sudo under Ctrl-C: the interrupt at the password prompt stops sudo, not the CLI — the caller goes on to its closing text", async () => {
  // the stand-in for sudo does what a Ctrl-C at its prompt does: the whole foreground group gets SIGINT, the parent too
  const child = `process.kill(process.ppid, "SIGINT"); setTimeout(() => process.exit(1), 300);`;
  const run = (body) =>
    new Promise((resolve) => {
      execFile(process.execPath, ["--input-type=module", "-e", body], { env: scrubAwakeEnv({ ...process.env, NODE_OPTIONS: "" }), timeout: 20_000 }, (err, stdout) => resolve({ code: err ? err.code : 0, signal: err?.signal ?? null, stdout }));
    });
  const cliUrl = JSON.stringify(new URL("../lib/hub-update/cli.mjs", import.meta.url).href);
  const held = await run(`
    import { spawnHoldingSigint } from ${cliUrl};
    let closing = "no finally";
    try {
      const r = spawnHoldingSigint([process.execPath, "-e", ${JSON.stringify(child)}], { stdio: "ignore" });
      console.log("status " + r.status);
    } finally {
      closing = "finally ran";
    }
    await new Promise((done) => setTimeout(done, 100));
    console.log(closing + ", handlers left: " + process.listenerCount("SIGINT"));
  `);
  assert.deepEqual([held.code, held.signal], [0, null], held.stdout);
  assert.equal(held.stdout, "status 1\nfinally ran, handlers left: 0\n");
  // without the hold the same interrupt ends the process on the spot — what install and uninstall used to do
  const bare = await run(`
    import { spawnSync } from "node:child_process";
    spawnSync(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" });
    await new Promise((done) => setTimeout(done, 100));
    console.log("survived");
  `);
  assert.equal(bare.signal, "SIGINT", bare.stdout);
  assert.doesNotMatch(bare.stdout, /survived/);
});
