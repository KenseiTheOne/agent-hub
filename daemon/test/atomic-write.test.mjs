// lib/statefile.mjs: one atomic write (temp file next to the target + rename, the mode preserved) and one way to change
// config.json — updateConfig(fn), a read-modify-write under a cross-process lock, so that the daemon, the CLI and the updater
// do not lose each other's changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DAEMON_DIR } from "../lib/config.mjs";
import { writeAppRequirement } from "../lib/app-pin.mjs";
import { pointConfigAtCopy } from "../lib/builtin-copy.mjs";
import { writeBrewSetting } from "../lib/hub-update/brew.mjs";
import { configLockPath, updateConfig, withFileLock, writeFileAtomic, writeJsonAtomic } from "../lib/statefile.mjs";
import { cleanup, FILE_MODES, tempHome } from "./helpers.mjs";

const modeOf = (p) => statSync(p).mode & 0o777;
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const STATEFILE = pathToFileURL(join(DAEMON_DIR, "lib", "statefile.mjs")).href;

function runNode(script, args = []) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", script, ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

test("writeFileAtomic: a new file is 0600, an existing file keeps its mode, an explicit mode is set exactly; no temp file stays", () => {
  const dir = tempHome("ah-aw-");
  try {
    const f = join(dir, "a.json");
    writeFileAtomic(f, "one");
    assert.equal(readFileSync(f, "utf8"), "one");
    if (FILE_MODES) assert.equal(modeOf(f), 0o600, "a new file is private");
    if (FILE_MODES) {
      chmodSync(f, 0o640);
      writeFileAtomic(f, "two");
      assert.equal(modeOf(f), 0o640, "the mode of the existing file is kept");
      writeFileAtomic(f, "three", { mode: 0o600 });
      assert.equal(modeOf(f), 0o600, "an explicit mode wins");
    }
    // a JSON value: one line + a newline; space — indentation
    writeJsonAtomic(f, { a: 1 });
    assert.equal(readFileSync(f, "utf8"), '{"a":1}\n');
    writeJsonAtomic(f, { a: 1 }, { space: 2 });
    assert.equal(readFileSync(f, "utf8"), '{\n  "a": 1\n}\n');
    // mkdir: the directory is created (0700)
    const deep = join(dir, "sub", "dir", "b.json");
    assert.throws(() => writeFileAtomic(deep, "x"), /ENOENT/);
    writeFileAtomic(deep, "x", { mkdir: true });
    assert.equal(readFileSync(deep, "utf8"), "x");
    if (FILE_MODES) assert.equal(modeOf(join(dir, "sub", "dir")), 0o700);
    assert.deepEqual(readdirSync(dir).sort(), ["a.json", "sub"], "no temp files are left");
  } finally {
    cleanup(dir);
  }
});

test("writeFileAtomic: a failed write removes its temp file and leaves the target as it was", () => {
  const dir = tempHome("ah-aw-");
  try {
    // the target is a non-empty directory: the rename fails after the temp file is written
    const target = join(dir, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "kept");
    assert.throws(() => writeFileAtomic(target, "data"));
    assert.deepEqual(readdirSync(dir), ["target"], "the temp file is removed");
    assert.equal(readFileSync(join(target, "keep"), "utf8"), "kept");
    // a value that cannot be serialised: nothing is created at all
    const loop = {};
    loop.self = loop;
    assert.throws(() => writeJsonAtomic(join(dir, "loop.json"), loop));
    assert.deepEqual(readdirSync(dir), ["target"]);
  } finally {
    cleanup(dir);
  }
});

test("updateConfig: changes in place or by return value, false writes nothing, a missing file is an empty config, 0600", () => {
  const dir = tempHome("ah-uc-");
  try {
    const cfg = join(dir, "config.json");
    // a missing file: fn sees {}, and "nothing to write" creates no file
    const none = updateConfig(cfg, (c) => {
      assert.deepEqual(c, {});
      return false;
    });
    assert.deepEqual(none, { written: false, cfg: {} });
    assert.ok(!existsSync(cfg));
    // in place
    const first = updateConfig(cfg, (c) => {
      c.a = 1;
    });
    assert.deepEqual(first, { written: true, cfg: { a: 1 } });
    assert.equal(readFileSync(cfg, "utf8"), '{\n  "a": 1\n}\n');
    if (FILE_MODES) assert.equal(modeOf(cfg), 0o600);
    // a returned object replaces the config
    updateConfig(cfg, (c) => ({ ...c, b: 2 }));
    assert.deepEqual(readJson(cfg), { a: 1, b: 2 });
    // false: the file is not rewritten (not even its mtime)
    const old = new Date(Date.now() - 60_000);
    utimesSync(cfg, old, old);
    const before = statSync(cfg).mtimeMs;
    assert.equal(updateConfig(cfg, () => false).written, false);
    assert.equal(statSync(cfg).mtimeMs, before);
    // a config that was readable by others becomes private on the next write
    if (FILE_MODES) {
      chmodSync(cfg, 0o644);
      updateConfig(cfg, (c) => {
        c.c = 3;
      });
      assert.equal(modeOf(cfg), 0o600);
    }
    // an error in fn: nothing is written, the lock is released
    assert.throws(
      () =>
        updateConfig(cfg, (c) => {
          c.broken = true;
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(readJson(cfg).broken, undefined);
    assert.ok(!existsSync(configLockPath(cfg)), "the lock is released after an error");
    assert.deepEqual(readdirSync(dir), ["config.json"], "no lock or temp file stays");
    // missing: "throw" — the caller needs the file; nothing is created for it
    const absent = join(dir, "no-such", "config.json");
    assert.throws(() => updateConfig(absent, () => {}, { missing: "throw" }));
    assert.ok(!existsSync(join(dir, "no-such")));
  } finally {
    cleanup(dir);
  }
});

test("updateConfig: a config.json that cannot be parsed, or is not an object, is never overwritten", () => {
  const dir = tempHome("ah-uc-");
  try {
    const cfg = join(dir, "config.json");
    for (const text of ['{"a": 1,', "[1, 2]", '"text"', ""]) {
      writeFileSync(cfg, text);
      let called = false;
      assert.throws(() =>
        updateConfig(cfg, (c) => {
          called = true;
          c.x = 1;
        }),
      );
      assert.equal(called, false, `fn is not called for ${JSON.stringify(text)}`);
      assert.equal(readFileSync(cfg, "utf8"), text, "the file is left as it is");
      assert.ok(!existsSync(configLockPath(cfg)));
    }
    // every writer of config.json goes through it: none of them replaces a broken file
    writeFileSync(cfg, '{"a": 1,');
    assert.throws(() => writeAppRequirement(cfg, 'identifier "x"', { by: "test" }));
    assert.throws(() => pointConfigAtCopy(cfg, join(dir, "Builtin")));
    assert.throws(() => writeBrewSetting(cfg, dir));
    assert.equal(readFileSync(cfg, "utf8"), '{"a": 1,');
  } finally {
    cleanup(dir);
  }
});

test("the config writers keep each other's keys", () => {
  const dir = tempHome("ah-uc-");
  try {
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ mine: { keep: true } }));
    assert.deepEqual(pointConfigAtCopy(cfg, "/copy"), { changed: true, before: null });
    assert.deepEqual(pointConfigAtCopy(cfg, "/copy"), { changed: false, before: "/copy" });
    assert.equal(writeBrewSetting(cfg, dir), true);
    assert.equal(writeBrewSetting(cfg, dir), false, "the same value is not a change");
    const c = readJson(cfg);
    assert.deepEqual(c.mine, { keep: true });
    assert.equal(c.builtinPluginsDir, "/copy");
    assert.equal(typeof c.services.hubUpdate.brew, "string");
    assert.equal(writeBrewSetting(cfg, null), true);
    assert.deepEqual(readJson(cfg), { mine: { keep: true }, builtinPluginsDir: "/copy" });
    // removing the setting from a home that has no config creates nothing
    const empty = join(dir, "none", "config.json");
    assert.equal(writeBrewSetting(empty, null), false);
    assert.ok(!existsSync(join(dir, "none")));
    if (FILE_MODES) assert.equal(modeOf(cfg), 0o600);
  } finally {
    cleanup(dir);
  }
});

test("withFileLock: a held lock makes the other side wait and then fail with ELOCKED; a dead owner's and an old lock are taken over", () => {
  const dir = tempHome("ah-lk-");
  try {
    const lock = join(dir, "x.lock");
    // held by this (live) process
    const r = withFileLock(lock, () => {
      assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
      const t0 = Date.now();
      assert.throws(
        () => withFileLock(lock, () => "inner", { waitMs: 150 }),
        (e) => e.code === "ELOCKED",
      );
      assert.ok(Date.now() - t0 >= 140, "it waited before giving up");
      return "outer";
    });
    assert.equal(r, "outer");
    assert.ok(!existsSync(lock), "released");
    // the owner is gone
    writeFileSync(lock, "999999999\n");
    assert.equal(withFileLock(lock, () => "taken", { waitMs: 500 }), "taken");
    assert.ok(!existsSync(lock));
    // a live owner, but the lock is older than any write can take
    writeFileSync(lock, `${process.pid}\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    assert.equal(withFileLock(lock, () => "old", { waitMs: 500 }), "old");
    // a fresh lock of a live owner is respected
    writeFileSync(lock, `${process.pid}\n`);
    assert.throws(() => withFileLock(lock, () => "no", { waitMs: 100 }), (e) => e.code === "ELOCKED");
    assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`, "someone else's lock is not removed");
    assert.deepEqual(readdirSync(dir), ["x.lock"], "no helper files stay");
  } finally {
    cleanup(dir);
  }
});

test("updateConfig across processes: concurrent writers lose no change", async () => {
  const dir = tempHome("ah-uc-");
  try {
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ human: "setting", counter: 0 }), { mode: 0o600 });
    const WRITERS = 6;
    const ROUNDS = 25;
    // each process: its own key + a shared counter, both read-modify-write
    const script = `
      import { updateConfig } from ${JSON.stringify(STATEFILE)};
      const [cfg, name, rounds] = process.argv.slice(1);
      for (let i = 0; i < Number(rounds); i++) {
        updateConfig(cfg, (c) => {
          c.counter = (c.counter || 0) + 1;
          c[name] = (c[name] || 0) + 1;
        }, { lock: { waitMs: 20000 } });
      }
    `;
    const results = await Promise.all(Array.from({ length: WRITERS }, (_, i) => runNode(script, [cfg, `w${i}`, String(ROUNDS)])));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const c = readJson(cfg);
    assert.equal(c.counter, WRITERS * ROUNDS, "no increment is lost");
    for (let i = 0; i < WRITERS; i++) assert.equal(c[`w${i}`], ROUNDS);
    assert.equal(c.human, "setting", "a key nobody touched is kept");
    assert.deepEqual(readdirSync(dir), ["config.json"], "no lock, temp or helper file stays");
    if (FILE_MODES) assert.equal(modeOf(cfg), 0o600);
  } finally {
    cleanup(dir);
  }
});
