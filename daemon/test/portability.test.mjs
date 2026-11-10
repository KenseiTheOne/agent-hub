// Findings from checking the daemon on Windows (2026-11-10) that are useful on macOS/Linux too: osVars without OS commands,
// absolute paths and directory comparison by platform rules, BOM in config.json/settings.json, a clear refusal on a corrupt
// config.json, install/uninstall without launchd, open.file for document types only. What is deferred: docs/windows.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEnv, osVars } from "../lib/runner.mjs";
import { watchPaths } from "../lib/host.mjs";
import { isAbsolutePath, samePath } from "../lib/platform.mjs";
import { DAEMON_DIR, loadConfig, readJsonFile } from "../lib/config.mjs";
import { Settings } from "../lib/settings.mjs";
import { writeAppRequirement } from "../lib/app-pin.mjs";
import { hasLaunchd, LABEL } from "../lib/launchd.mjs";
import * as openFile from "../lib/primitives/open.file.mjs";
import { cleanup, onlyDarwin, tempHome, withRepoPlist } from "./helpers.mjs";

const BIN = join(DAEMON_DIR, "bin");
const BOM = "\uFEFF";

function run(args, env) {
  // the CLI speaks the hub language, and test mode makes the "system" language ru: these checks read the English CLI
  const e = { ...process.env, AGENTHUB_SERVICES: "none", ...(/[\\/]agenthub$/.test(args[0] || "") ? { AGENTHUB_SYSTEM_LANG: "en" } : {}), ...env };
  delete e.NODE_OPTIONS;
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: e, timeout: 15_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

// First in the file: the osVars cache is per process, and the bug only happened with an empty cache.
test("osVars without OS commands (Linux, Windows): the first call returns an object with OS_PLATFORM, not null; buildEnv does not crash", async () => {
  const vars = await osVars({ commands: null });
  assert.ok(vars && typeof vars === "object", String(vars));
  assert.equal(vars.OS_PLATFORM, process.platform);
  const env = buildEnv({ pluginId: "p", dataPath: "D", cachePath: "C", reason: "Schedule", os: vars });
  assert.equal(env.OS_PLATFORM, process.platform);
  assert.deepEqual(await osVars(), vars, "the second call comes from the cache");
});

test("isAbsolutePath and watchPaths: absolute path by platform rules, not startsWith(\"/\")", () => {
  assert.equal(isAbsolutePath("/Users/u/x", { platform: "darwin" }), true);
  assert.equal(isAbsolutePath("C:\\Users\\u\\x", { platform: "darwin" }), false);
  assert.equal(isAbsolutePath("C:\\Users\\u\\x", { platform: "win32" }), true);
  assert.equal(isAbsolutePath("rel/x", { platform: "win32" }), false);
  assert.equal(isAbsolutePath("C:/Users/u/x", { platform: "win32" }), true);
  // paths from the current drive's root and UNC are not absolute (even though win32.isAbsolute says yes): docs/windows.md, A1–A3b
  for (const p of ["/x", "\\x", "\\\\srv\\share\\x", "\\\\?\\C:\\x", "C:x"]) assert.equal(isAbsolutePath(p, { platform: "win32" }), false, p);
  assert.equal(isAbsolutePath(null), false);
  const vars = { AGENTHUB_USAGE_FILE: "C:\\Users\\u\\AppData\\Local\\AgentHub\\Cache\\usage.json" };
  assert.deepEqual(watchPaths(["$AGENTHUB_USAGE_FILE — кэш"], vars, { platform: "win32" }), { paths: [vars.AGENTHUB_USAGE_FILE], skipped: [] });
  assert.deepEqual(watchPaths(["$AGENTHUB_USAGE_FILE — кэш"], vars, { platform: "darwin" }), { paths: [], skipped: ["AGENTHUB_USAGE_FILE"] });
  assert.deepEqual(watchPaths(["$AGENTHUB_USAGE_FILE — кэш"], { AGENTHUB_USAGE_FILE: "/h/Cache/usage.json" }, { platform: "darwin" }).paths, ["/h/Cache/usage.json"]);
});

test("samePath: on POSIX, resolve equality; on Windows, case-insensitive and ignoring a trailing separator; empty never matches", () => {
  assert.equal(samePath("/a/b/", "/a/b", { platform: "darwin" }), true);
  assert.equal(samePath("/a/./b", "/a/b", { platform: "linux" }), true);
  assert.equal(samePath("/a/B", "/a/b", { platform: "darwin" }), false, "on POSIX case is part of the path (as before)");
  assert.equal(samePath("C:\\Users\\U\\AppData\\Local\\AgentHub\\", "c:\\users\\u\\appdata\\local\\agenthub", { platform: "win32" }), true);
  assert.equal(samePath("C:/Users/u/AgentHub", "C:\\Users\\u\\AgentHub", { platform: "win32" }), true);
  assert.equal(samePath("C:\\a", "D:\\a", { platform: "win32" }), false);
  assert.equal(samePath("", "/a"), false);
  // an existing directory: APFS is case-insensitive, so the same directory in another case and via a symlink matches
  const dir = tempHome("ah-same-");
  try {
    mkdirSync(join(dir, "Live"));
    symlinkSync(join(dir, "Live"), join(dir, "link"));
    assert.equal(samePath(join(dir, "link"), join(dir, "Live")), true, "a symlink to a directory is the same directory");
    if (existsSync(join(dir, "live"))) assert.equal(samePath(join(dir, "live"), join(dir, "Live")), true, "different case on a case-insensitive file system");
    mkdirSync(join(dir, "Other"));
    assert.equal(samePath(join(dir, "Other"), join(dir, "Live")), false);
  } finally {
    cleanup(dir);
  }
  assert.equal(samePath(null, null), false);
});

test("BOM: config.json and settings.json with a BOM are read (loadConfig, Settings, writeAppRequirement); UTF-16 gives a clear error", () => {
  const home = tempHome("ah-bom-");
  try {
    const cfgPath = join(home, "config.json");
    writeFileSync(cfgPath, BOM + JSON.stringify({ claudeHome: "~/.claude-bom" }));
    assert.deepEqual(readJsonFile(cfgPath), { claudeHome: "~/.claude-bom" });
    const cfg = loadConfig({ env: { AGENTHUB_HOME: home } });
    assert.match(cfg.claudeHome, /\.claude-bom$/);
    // app-pin reads the same file: with a BOM, pinning does not fail with "config.json не разобран"
    writeAppRequirement(cfgPath, 'identifier "com.kensei.agenthub"');
    assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).claudeHome, "~/.claude-bom", "other keys are preserved");
    const setPath = join(home, "settings.json");
    writeFileSync(setPath, BOM + JSON.stringify({ lang: "en" }));
    assert.equal(new Settings(setPath, { detect: () => "ru" }).get("lang"), "en");
    writeFileSync(cfgPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("{}", "utf16le")]));
    assert.throws(() => readJsonFile(cfgPath), /UTF-16/);
    assert.throws(() => loadConfig({ env: { AGENTHUB_HOME: home } }), /config\.json couldn't be parsed: .*UTF-16/);
  } finally {
    cleanup(home);
  }
});

test("corrupt config.json: agenthub and agenthubd print one line and exit 1, no stack; with a BOM they work", async () => {
  const home = tempHome("ah-badcfg-");
  try {
    writeFileSync(join(home, "config.json"), "{ не json");
    // the CLI speaks the hub language: Russian with a Russian "system" language, English otherwise
    const cli = await run([join(BIN, "agenthub"), "version"], { AGENTHUB_HOME: home, AGENTHUB_SYSTEM_LANG: "ru" });
    assert.equal(cli.code, 1, cli.stderr);
    assert.match(cli.stderr, /^agenthub: config\.json не разобран: /);
    assert.doesNotMatch(cli.stderr, /\n\s+at /, "no stack");
    const cliEn = await run([join(BIN, "agenthub"), "version"], { AGENTHUB_HOME: home });
    assert.equal(cliEn.code, 1, cliEn.stderr);
    assert.match(cliEn.stderr, /^agenthub: config\.json couldn't be parsed: /);
    const d = await run([join(BIN, "agenthubd")], { AGENTHUB_HOME: home });
    assert.equal(d.code, 1, d.stderr);
    assert.match(d.stderr, /^\[agenthubd [^\]]+\] config\.json не разобран: /);
    assert.doesNotMatch(d.stderr, /\n\s+at /, "no stack");
    writeFileSync(join(home, "config.json"), BOM + "{}");
    const ok = await run([join(BIN, "agenthub"), "version"], { AGENTHUB_HOME: home });
    assert.equal(ok.code, 0, ok.stderr);
  } finally {
    cleanup(home);
  }
});

test("install/uninstall without launchd (Linux, Windows): refuse with a --no-launchd hint, and work with it", async () => {
  assert.equal(hasLaunchd("darwin", {}), true);
  assert.equal(hasLaunchd("linux", {}), false);
  assert.equal(hasLaunchd("win32", {}), false);
  const home = tempHome("ah-nold-");
  const env = { AGENTHUB_HOME: home, AGENTHUB_TEST_NO_LAUNCHD: "1" };
  const repoPlist = join(DAEMON_DIR, "..", "launchd", `${LABEL}.plist`);
  try {
    // the launchd/ template in the repo is under a shared lock (helpers.withRepoPlist), which also restores the file
    await withRepoPlist(repoPlist, async () => {
      rmSync(repoPlist, { force: true });
      const i = await run([join(BIN, "agenthub"), "install"], env);
      assert.equal(i.code, 2, i.stdout + i.stderr);
      assert.match(i.stderr, /only on macOS/);
      assert.match(i.stderr, /--no-launchd/);
      const n = await run([join(BIN, "agenthub"), "install", "--apply", "--no-launchd", "--registry-url", "https://example.invalid/index.json"], env);
      assert.equal(n.code, 0, n.stderr);
      assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).services.plugins.indexUrl, "https://example.invalid/index.json");
      assert.doesNotMatch(n.stdout, /plist written/, "without launchd no plist is written");
      assert.throws(() => readFileSync(repoPlist), /ENOENT/);
    });
    const u = await run([join(BIN, "agenthub"), "uninstall"], env);
    assert.equal(u.code, 2, u.stdout + u.stderr);
    assert.match(u.stderr, /only on macOS/);
    const un = await run([join(BIN, "agenthub"), "uninstall", "--no-launchd"], env);
    assert.equal(un.code, 0, un.stderr);
    assert.match(un.stdout, /Nothing deleted without --apply/);
    assert.doesNotMatch(un.stdout, /launchctl/);
  } finally {
    cleanup(home);
  }
});

test("open.file: only document types open; executables and unknown types are reveal-only; a bundle directory gives bundle", () => {
  const dir = tempHome("ah-open-");
  try {
    const f = (name, mode = 0o644) => {
      const p = join(dir, name);
      writeFileSync(p, "x");
      chmodSync(p, mode);
      return p;
    };
    for (const name of ["a.md", "b.pdf", "c.png", "d.json", "e.MOV"]) assert.deepEqual(openFile.verifyFacts({ path: f(name) }), { ok: true }, name);
    // on macOS `open` runs or mounts these, and they were missing from the old deny list
    for (const name of ["a.pyw", "b.jnlp", "c.afploc", "d.smbloc", "e.term", "f.wflow", "g.zip", "noext", "h.command", "i.webloc"]) {
      assert.deepEqual(openFile.verifyFacts({ path: f(name) }), { ok: false, reason: "risky-type" }, name);
      assert.deepEqual(openFile.verifyFacts({ path: join(dir, name), reveal: true }), { ok: true }, `${name}: reveal is allowed`);
    }
    assert.deepEqual(openFile.verifyFacts({ path: f("run.md", 0o755) }), { ok: false, reason: "executable" });
    mkdirSync(join(dir, "X.xpc"));
    mkdirSync(join(dir, "plain"));
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "X.xpc") }), { ok: false, reason: "bundle" });
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "plain") }), { ok: true });
  } finally {
    cleanup(dir);
  }
});

test("open.file run: the type is rechecked via realpath; a symlink swapped after the check → refusal, open is not called", async () => {
  const dir = tempHome("ah-openr-");
  try {
    writeFileSync(join(dir, "doc.md"), "x");
    writeFileSync(join(dir, "evil.pyw"), "x");
    const link = join(dir, "link.md");
    symlinkSync(join(dir, "doc.md"), link);
    const calls = [];
    const ctx = { exec: async (file, argv) => (calls.push([file, ...argv]), { code: 0 }) };
    assert.deepEqual(openFile.verifyFacts({ path: link }), { ok: true });
    assert.deepEqual(await openFile.run({ path: link }, ctx), { ok: true, code: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].at(-1), join(dir, "doc.md"), "open receives the realpath");
    // swap between verifyFacts and run
    rmSync(link);
    symlinkSync(join(dir, "evil.pyw"), link);
    assert.deepEqual(await openFile.run({ path: link }, ctx), { ok: false, reason: "risky-type" });
    assert.equal(calls.length, 1, "open was not called");
    // reveal: anything may be shown in Finder
    assert.equal((await openFile.run({ path: link, reveal: true }, ctx)).ok, true);
    assert.equal(calls.length, 2);
  } finally {
    cleanup(dir);
  }
});

test("uninstall --no-launchd from the live directory: refused both with AGENTHUB_TEST_NO_LAUNCHD and with AGENTHUB_HOME in a different case", { skip: onlyDarwin("launchd") }, async () => {
  // the "live" directory is under a temporary HOME (the real ~/Library is not touched); without --apply nothing is removed
  const fakeHome = tempHome("ah-livecase-");
  const live = join(fakeHome, "Library", "Application Support", "AgentHub");
  mkdirSync(live, { recursive: true });
  const base = { HOME: fakeHome, AGENTHUB_TEST_NO_LAUNCHD: "1" };
  try {
    const a = await run([join(BIN, "agenthub"), "uninstall", "--no-launchd"], { ...base, AGENTHUB_HOME: "" });
    assert.equal(a.code, 2, a.stdout + a.stderr);
    assert.match(a.stderr, /--no-launchd is for a test directory/);
    if (existsSync(live.toLowerCase())) {
      const b = await run([join(BIN, "agenthub"), "uninstall", "--no-launchd", "--yes"], { ...base, AGENTHUB_HOME: live.toLowerCase() });
      assert.equal(b.code, 2, b.stdout + b.stderr);
      assert.match(b.stderr, /is for a test directory/);
    }
  } finally {
    cleanup(fakeHome);
  }
});

test("open.file: a directory with an extension (.sparsebundle, .playground) is reveal-only; a Finder alias and a custom app (OpenWith) are refused", { skip: onlyDarwin("LaunchServices, xattr") }, async () => {
  const dir = tempHome("ah-openx-");
  const xattr = (...a) => execFileSync("/usr/bin/xattr", a);
  const hex = (flags, type = "0000000000000000") => type + flags + "0".repeat(64 - 16 - 4);
  try {
    for (const name of ["Disk.sparsebundle", "P.playground", "Tool.swiftpm"]) {
      mkdirSync(join(dir, name));
      assert.deepEqual(openFile.verifyFacts({ path: join(dir, name) }), { ok: false, reason: "bundle" }, name);
      assert.deepEqual(openFile.verifyFacts({ path: join(dir, name), reveal: true }), { ok: true }, name);
    }
    // a directory without an extension but with the package flag (kHasBundle) in FinderInfo
    mkdirSync(join(dir, "pkg"));
    xattr("-wx", "com.apple.FinderInfo", hex("2000"), join(dir, "pkg"));
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "pkg") }), { ok: false, reason: "bundle" });
    // a Finder alias under a document name: bookmark data "book\0\0\0\0mark" …
    writeFileSync(join(dir, "alias.txt"), Buffer.concat([Buffer.from("book\0\0\0\0mark", "latin1"), Buffer.alloc(64)]));
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "alias.txt") }), { ok: false, reason: "alias" });
    // … and the kIsAlias flag with any data
    writeFileSync(join(dir, "flag.md"), "x");
    xattr("-wx", "com.apple.FinderInfo", hex("8000", "616C69734D414353"), join(dir, "flag.md"));
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "flag.md") }), { ok: false, reason: "alias" });
    // a custom app for the file
    writeFileSync(join(dir, "doc.txt"), "x");
    xattr("-w", "com.apple.LaunchServices.OpenWith", "x", join(dir, "doc.txt"));
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "doc.txt") }), { ok: false, reason: "open-with" });
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "doc.txt"), reveal: true }), { ok: true });
    // a regular document with harmless FinderInfo (a color label) opens
    writeFileSync(join(dir, "ok.md"), "x");
    xattr("-wx", "com.apple.FinderInfo", hex("000C"), join(dir, "ok.md"));
    assert.deepEqual(openFile.verifyFacts({ path: join(dir, "ok.md") }), { ok: true });
    // run() checks the same thing: open is not called
    const calls = [];
    const ctx = { exec: async (file, argv) => (calls.push([file, ...argv]), { code: 0 }) };
    assert.deepEqual(await openFile.run({ path: join(dir, "alias.txt") }, ctx), { ok: false, reason: "alias" });
    assert.deepEqual(await openFile.run({ path: join(dir, "Disk.sparsebundle") }, ctx), { ok: false, reason: "bundle" });
    assert.equal(calls.length, 0);
  } finally {
    cleanup(dir);
  }
});
