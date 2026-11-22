// The codex-quota plugin: live limits through a fake `codex app-server` (initialize → account/rateLimits/read), windows
// mapped by their length (300 min = 5 h, 10080 = week) and not by position, the stale fallback from the newest token_count in
// session files, and the quiet states: Codex not installed, not signed in, an API key, a hung or broken server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOutput, splitFrames } from "../lib/output.mjs";
import { readPluginMeta } from "../lib/meta.mjs";
import { SECRET, writer, rolloutPath, writeRollout, fileRateLimits } from "./fixtures/codex/rollouts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = join(REPO, "plugins/codex-quota/codex-quota.mjs");
const FAKE = join(REPO, "daemon/test/fixtures/codex/fake-codex.mjs");
const Q = await import(FILE);

// the fixture: 5 h window resets 2026-11-22T06:00Z (31%), the week resets 2026-11-26T17:00Z (64%)
const NOW = "2026-11-22T04:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function world({ codexHome = true, bin = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ah-cxq-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  if (bin) {
    writeFileSync(join(binDir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(join(binDir, "codex"), 0o755);
  }
  if (codexHome) mkdirSync(join(root, ".codex"));
  return { root, codex: join(root, ".codex"), binDir, log: join(root, "calls.log"), envLog: join(root, "env.log") };
}

// A rollout with a token_count rate_limits snapshot written at `at`.
function writeLimits(codex, id, at, rl, { old = false } = {}) {
  const w = writer({ start: at, old });
  w.meta({ id });
  w.userMessage();
  w.tokenCount({ rateLimits: rl });
  w.agentMessage();
  const p = writeRollout(rolloutPath(codex, id, at), w.text());
  const t = new Date(Date.parse(at) + 60_000);
  utimesSync(p, t, t);
  return p;
}

function run(w, extra = {}, { until = (p) => !/loading|asking/i.test(p.header[0]?.title || ""), timeoutMs = 10_000 } = {}) {
  return new Promise((res, rej) => {
    const env = { HOME: w.root, PATH: "/usr/bin:/bin", AGENTHUB_LANG: "en", AGENTHUB_TEST_NOW: NOW, AGENTHUB_TEST_BIN_DIR: w.binDir, AGENTHUB_PLUGIN_DATA_PATH: join(w.root, "data"), FAKE_CODEX_LOG: w.log, FAKE_CODEX_ENV_LOG: w.envLog, ...extra };
    const p = spawn(process.execPath, [FILE], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      p.kill();
      rej(new Error(`timeout; out=${out} err=${err}`));
    }, timeoutMs);
    p.stdout.on("data", (d) => {
      out += d;
      const frames = splitFrames(out);
      const last = frames.length ? parseOutput(frames.at(-1)) : null;
      if (last && out.endsWith("~~~\n") && until(last)) {
        clearTimeout(t);
        p.stdin.end();
        p.on("exit", () => res({ out, err, frames, text: frames.at(-1), parsed: last }));
      }
    });
    p.stderr.on("data", (d) => (err += d));
  });
}
const calls = (w) => (existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : []);

test("codex-quota: metadata — streamable, app-server and session files declared, never the token", () => {
  const { meta } = readPluginMeta(FILE);
  assert.equal(meta.type, "streamable");
  assert.ok(meta.exec.some((x) => /^codex app-server — /.test(x)));
  assert.ok(meta.fsRead.some((x) => x.startsWith("~/.codex/sessions/")));
  const src = readFileSync(FILE, "utf8");
  assert.doesNotMatch(src, /auth\.json|chatgpt\.com|CODEX_API_KEY|OPENAI_API_KEY/);
  assert.doesNotMatch(src, /"agents"|codex agents/, "never runs `codex agents` (it starts the background server)");
});

test("codex-quota: windows are mapped by length, not by position; snake_case from files and camelCase from the server", () => {
  // an August-style file: the week in primary, no secondary
  const p = Q.parseSnapshot(fileRateLimits({ primary: { used_percent: 12.5, window_minutes: 10080, resets_at: 1795712400 } }));
  assert.equal(p.ok, true);
  const rows = Q.rowsOf([p]);
  assert.deepEqual(rows.map((r) => [r.kind, r.percent]), [["week", 12.5]]);
  const live = Q.parseRateLimits(JSON.parse(readFileSync(join(REPO, "plugins/codex-quota/fixtures/rate-limits.json"), "utf8")));
  assert.deepEqual(Q.rowsOf(live.snapshots).map((r) => [r.kind, r.percent, r.minutes]), [["h5", 31, 300], ["week", 64, 10080]]);
  // a narrower bucket (by limit id) becomes a scoped row; an unknown window length is "other"
  const by = Q.parseRateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 } }, rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1 } }, "gpt-x": { limitId: "gpt-x", limitName: "GPT-X", primary: { usedPercent: 40, windowDurationMins: 1440, resetsAt: 1 } } } });
  const r2 = Q.rowsOf(by.snapshots);
  assert.deepEqual(r2.map((r) => [r.kind, r.percent, r.scope]), [["h5", 6, null], ["other", 40, "GPT-X"]]);
  assert.equal(Q.parseRateLimits({ rateLimits: { primary: "x" } }).ok, false);
  assert.equal(Q.rpcReason({ message: "codex account authentication required to read rate limits" }), "not-logged-in");
  assert.equal(Q.rpcReason({ message: "chatgpt authentication required to read rate limits" }), "api-key");
});

test("codex-quota: live answer → week in the header, 5-hour card first, pace event; one app-server session", async () => {
  const w = world();
  try {
    const r = await run(w);
    assert.equal(r.parsed.status, "wait");
    assert.match(r.parsed.header[0].title, /^Week 64% · resets /);
    assert.equal(r.parsed.header[0].params.tile, "64%");
    assert.ok(r.parsed.events.some((e) => /^pace-85:20261126$/.test(e)), JSON.stringify(r.parsed.events));
    const gauges = r.parsed.body.filter((i) => i.params.gauge !== undefined).map((i) => i.title.split(" — ")[0]);
    assert.deepEqual(gauges, ["5-hour window", "Week"]);
    assert.match(r.text, /codex app-server \(account\/rateLimits\/read\)/);
    assert.match(r.text, /Plan: plus/);
    assert.deepEqual(calls(w), ["initialize", "initialized", "account/rateLimits/read"]);
    assert.equal(readFileSync(w.envLog, "utf8"), "1\n", "remote control is off for the short-lived server");
    const cache = JSON.parse(readFileSync(join(w.root, "data/limits.json"), "utf8"));
    assert.equal(cache.live.source, "live");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-quota: not signed in / API key → a quiet state, no event, no fallback noise", async () => {
  const w = world();
  try {
    const a = await run(w, { FAKE_CODEX_MODE: "nologin" });
    assert.equal(a.parsed.status, "unknown");
    assert.match(a.parsed.header[0].title, /^Not signed in to Codex/);
    assert.deepEqual(a.parsed.events, []);
    rmSync(join(w.root, "data"), { recursive: true, force: true });
    const b = await run(w, { FAKE_CODEX_MODE: "apikey" });
    assert.match(b.parsed.header[0].title, /API key/);
    assert.deepEqual(b.parsed.events, []);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-quota: the server hangs → timeout, the newest token_count from session files is shown with its age", async () => {
  const w = world();
  try {
    // an older file with a 5-hour + week snapshot, a newer one in the old format with the week only in primary
    writeLimits(w.codex, "bbbbbbbb-0000-4000-8000-000000000001", "2026-11-21T20:00:00.000Z", fileRateLimits({ primary: { used_percent: 90, window_minutes: 300, resets_at: 1795320000 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1795712400 } }));
    writeLimits(w.codex, "bbbbbbbb-0000-4000-8000-000000000002", "2026-11-22T03:30:00.000Z", fileRateLimits({ primary: { used_percent: 55, window_minutes: 10080, resets_at: 1795712400 } }), { old: true });
    const r = await run(w, { FAKE_CODEX_MODE: "hang", AGENTHUB_CODEX_RPC_TIMEOUT_MS: "700" });
    assert.match(r.parsed.header[0].title, /^Week 55% · resets .* · from session files, 30 min ago$/);
    assert.match(r.text, /the last token_count event in session files · 30 min ago · Codex didn't answer: /);
    assert.doesNotMatch(r.out, new RegExp(SECRET));
    // older than an hour → stale: status unknown, "not updating"
    const later = await run(w, { FAKE_CODEX_MODE: "hang", AGENTHUB_CODEX_RPC_TIMEOUT_MS: "700", AGENTHUB_TEST_NOW: "2026-11-22T06:30:00.000Z" }, { until: (p) => /not updating/.test(p.header[0]?.title || "") });
    assert.equal(later.parsed.status, "unknown");
    assert.match(later.parsed.header[0].title, /not updating.*data from 3 h ago/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-quota: a broken answer → unknown + source-broken; a crash with files → the file snapshot", async () => {
  const w = world();
  try {
    const r = await run(w, { FAKE_CODEX_MODE: "bad" });
    assert.equal(r.parsed.status, "unknown");
    assert.ok(r.parsed.events.includes("source-broken"), JSON.stringify(r.parsed.events));
    rmSync(join(w.root, "data"), { recursive: true, force: true });
    writeLimits(w.codex, "bbbbbbbb-0000-4000-8000-000000000003", "2026-11-22T03:50:00.000Z", fileRateLimits({ primary: { used_percent: 20, window_minutes: 300, resets_at: 1795327200 } }));
    const c = await run(w, { FAKE_CODEX_MODE: "crash" });
    assert.match(c.parsed.header[0].title, /^5 hours 20% · resets .* · from session files/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-quota: Codex not installed → quiet frame, nothing spawned; codex without ~/.codex → not signed in, nothing spawned", async () => {
  const none = world({ bin: false, codexHome: false });
  try {
    const r = await run(none, {}, { until: () => true });
    assert.equal(r.frames.length, 1, r.out);
    assert.match(r.parsed.header[0].title, /^Codex isn't installed/);
    assert.equal(r.parsed.status, "unknown");
    assert.deepEqual(r.parsed.events, []);
  } finally {
    rmSync(none.root, { recursive: true, force: true });
  }
  const bare = world({ codexHome: false });
  try {
    const r = await run(bare, {}, { until: () => true });
    assert.equal(r.frames.length, 1, r.out);
    assert.match(r.parsed.header[0].title, /^Not signed in to Codex/);
    assert.deepEqual(calls(bare), []);
  } finally {
    rmSync(bare.root, { recursive: true, force: true });
  }
});

test("codex-quota: callDue — every 15 min, after 5 when sessions changed, hourly after 'won't work', manual after 1 min", () => {
  const MIN = 60_000;
  const at = (min, o = {}) => Q.callDue({ nowMs: 1e12, calledAt: 1e12 - min * MIN, ...o });
  assert.equal(Q.callDue({ nowMs: 1e12, calledAt: 0 }), true, "never called");
  assert.equal(at(14), false);
  assert.equal(at(15), true);
  assert.equal(at(4, { changed: true }), false);
  assert.equal(at(5, { changed: true }), true);
  for (const error of ["api-key", "not-logged-in", "no-codex"]) {
    assert.equal(at(59, { error, changed: true }), false, error);
    assert.equal(at(60, { error }), true, error);
    assert.equal(at(1, { error, manual: true }), true, `${error}: a manual refresh still asks`);
  }
  assert.equal(at(15, { error: "timeout" }), true, "a transient failure keeps the normal cadence");
  assert.equal(at(0.5, { manual: true }), false);
});

test("codex-quota: fmtWhen — only today's time is bare; the same day of another month gets a date", () => {
  const now = new Date(2026, 10, 22, 12, 0).getTime();
  assert.equal(Q.fmtWhen(new Date(2026, 10, 22, 18, 5).getTime(), now, "en"), "18:05");
  assert.equal(Q.fmtWhen(new Date(2026, 9, 22, 9, 0).getTime(), now, "en"), "Thu Oct 22, 09:00");
  assert.equal(Q.fmtWhen(new Date(2026, 11, 22, 9, 0).getTime(), now, "ru"), "вт 22.12 09:00");
  assert.equal(Q.fmtWhen(new Date(2026, 10, 23, 9, 0).getTime(), now, "en"), "Mon Nov 23, 09:00");
});

test("codex-quota: newestRollouts — by modification time across day folders, not by the folder's date", () => {
  const w = world();
  try {
    const t0 = Date.parse("2026-11-22T03:00:00.000Z");
    // a long session started three days ago and still writing; many short sessions today
    const long = writeLimits(w.codex, "019a0000-0000-7000-8000-00000000000a", "2026-11-19T10:00:00.000Z", fileRateLimits({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1 } }));
    utimesSync(long, new Date(t0 + 60 * 60_000), new Date(t0 + 60 * 60_000));
    for (let i = 0; i < 3; i++) {
      const p = writeLimits(w.codex, `019a0000-0000-7000-8000-00000000001${i}`, `2026-11-22T0${i}:00:00.000Z`, fileRateLimits({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1 } }));
      utimesSync(p, new Date(t0 + i * 60_000), new Date(t0 + i * 60_000));
    }
    const got = Q.newestRollouts(w.codex, 2);
    assert.equal(got[0].path, long);
    assert.equal(got.length, 2);
    assert.equal(Q.newestRollouts(w.codex, 2, { days: 1 }).some((f) => f.path === long), false, "older day folders beyond the cap aren't looked at");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-quota: the process — no call within 15 min; a changed session file brings it to 5 min; 'not signed in' waits an hour", async () => {
  const w = world();
  const cacheFile = join(w.root, "data/limits.json");
  // live: null — so a due call shows "asking" first and run() waits for the answer
  const age = (min) => {
    const c = JSON.parse(readFileSync(cacheFile, "utf8"));
    c.calledAt = Date.now() - min * 60_000;
    c.live = null;
    writeFileSync(cacheFile, JSON.stringify(c));
    return c.calledAt;
  };
  try {
    await run(w);
    assert.equal(calls(w).length, 3);
    age(10);
    await run(w, {}, { until: () => true });
    assert.equal(calls(w).length, 3, "10 min, no session activity → no call");
    const called = age(6);
    const p = writeLimits(w.codex, "019a0000-0000-7000-8000-0000000000c1", "2026-11-22T03:00:00.000Z", fileRateLimits({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1 } }));
    utimesSync(p, new Date(called + 60_000), new Date(called + 60_000));
    await run(w);
    assert.equal(calls(w).length, 6, "a session wrote after the last call and 6 min passed → a call");
    // not signed in: the next automatic call only after an hour, even with session activity
    rmSync(join(w.root, "data"), { recursive: true, force: true });
    await run(w, { FAKE_CODEX_MODE: "nologin" });
    assert.equal(calls(w).length, 9);
    const c2 = age(30);
    utimesSync(p, new Date(c2 + 60_000), new Date(c2 + 60_000));
    const r = await run(w, { FAKE_CODEX_MODE: "nologin" }, { until: () => true });
    assert.equal(calls(w).length, 9, "30 min after 'not signed in' → no call");
    assert.match(r.parsed.header[0].title, /not signed in to Codex/i, "the cached reason is kept between calls");
    age(61);
    await run(w, { FAKE_CODEX_MODE: "nologin" });
    assert.equal(calls(w).length, 12);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-quota: paused hub — no call, the cached live answer is shown", async () => {
  const w = world();
  try {
    await run(w);
    const before = calls(w).length;
    const r = await run(w, { AGENTHUB_PAUSED: "1" }, { until: () => true });
    assert.equal(calls(w).length, before);
    assert.match(r.parsed.header[0].title, /^Week 64%/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
