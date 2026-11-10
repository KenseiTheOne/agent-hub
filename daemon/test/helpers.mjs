// Shared test helpers: a temporary AGENTHUB_HOME, a daemon in the test process, requests over the socket.
// What does not exist outside macOS (codesign, launchd, plutil, peercred, osascript, cmux) is skipped with a reason: onlyDarwin().

import { mkdtempSync, rmSync, realpathSync, writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { request } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, REPO_DIR } from "../lib/config.mjs";
import { NATIVE_PATH } from "../lib/native.mjs";
import { usesFileModes } from "../lib/platform.mjs";
import { Core } from "../lib/core.mjs";
import { createPeer } from "../lib/peer.mjs";
import { startServer } from "../lib/server.mjs";

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(TEST_DIR, "fixtures");

export const IS_DARWIN = process.platform === "darwin";
// File modes (0600/0700) exist only on POSIX; on Windows access is decided by ACLs.
export const FILE_MODES = usesFileModes();

// The skip reason (the test's skip option) for what exists only on macOS; on macOS — false, the test runs.
export function onlyDarwin(what) {
  return IS_DARWIN ? false : `macOS only: ${what}`;
}

// The peercred addon (the peer on the socket, csops) exists only on macOS: it is built there if it is missing.
// → whether the addon is present.
export function ensureNative() {
  if (!IS_DARWIN) return false;
  if (!existsSync(NATIVE_PATH)) execFileSync(join(REPO_DIR, "scripts", "build-native.sh"), { stdio: "ignore" });
  return true;
}

// A short path: sun_path ≤ 103 bytes.
export function tempHome(prefix = "ah-") {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function writePlugin(dir, name, text, mode = 0o755) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
}

// configFile — an object that goes into <home>/config.json before startup (what the service reads from disk itself);
// settingsFile — an object for <home>/settings.json (shell settings before startup: migrating old values).
export async function startHub({ pluginsDir, overrides = {}, sys, env = {}, services = "none", configFile = null, settingsFile = null } = {}) {
  const home = tempHome();
  if (settingsFile) writeFileSync(join(home, "settings.json"), JSON.stringify(settingsFile), { mode: 0o600 });
  if (configFile) writeFileSync(join(home, "config.json"), JSON.stringify(typeof configFile === "function" ? configFile(home) : configFile), { mode: 0o600 });
  const claudeHome = join(home, "claude-home");
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  const config = loadConfig({
    env: {
      AGENTHUB_HOME: home,
      AGENTHUB_BUILTIN_PLUGINS: pluginsDir || join(home, "no-builtin"),
      AGENTHUB_TEST_EXEC_LOG: join(home, "exec.log"),
      AGENTHUB_CLAUDE_HOME: claudeHome,
      AGENTHUB_SERVICES: services,
      ...env,
    },
    overrides,
  });
  const peer = createPeer({ config, ...(sys ? { sys } : {}) });
  const core = new Core({ config, peer });
  await core.init();
  const srv = await startServer(core);
  return {
    home,
    claudeHome,
    config,
    core,
    srv,
    sock: config.paths.socket,
    async stop() {
      await srv.close();
      await core.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function req(sock, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const r = request({ socketPath: sock, agent: false, method, path, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(s);
        } catch {}
        resolve({ status: res.statusCode, body: json, text: s, headers: res.headers });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// curl is a separate process: a real peer of class cli.
export function curl(sock, method, path, body) {
  const args = ["-s", "--unix-socket", sock, "-X", method, "-w", "\n%{http_code}", `http://hub${path}`];
  if (body !== undefined) args.push("-H", "content-type: application/json", "-d", JSON.stringify(body));
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/curl", args, { timeout: 10_000 }, (err, out) => {
      if (err) return reject(err);
      const i = out.lastIndexOf("\n");
      const text = out.slice(0, i);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      resolve({ status: Number(out.slice(i + 1)), body: json, text });
    });
  });
}

export async function waitFor(fn, { timeoutMs = 5000, stepMs = 50 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function cleanup(p) {
  rmSync(p, { recursive: true, force: true });
}

// The launchd/<LABEL>.plist template in the repository is rewritten by `agenthub install --apply` (with temporary HOME paths).
// Such tests exist in several files, and node --test runs files in parallel: without a shared lock one test
// restored the "saved" template in the middle of someone else's check (flickering "the template in the repository is the same") or
// saved someone else's temporary version and left it in the working tree. The lock is a directory in tmpdir per template path
// (mkdir is atomic across processes); one abandoned for longer than 2 min is removed. The template is restored under the lock.
export async function withRepoPlist(repoPlist, fn, { waitMs = 120_000 } = {}) {
  const lock = join(tmpdir(), `agenthub-test-plist-${createHash("sha256").update(repoPlist).digest("hex").slice(0, 16)}.lock`);
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > until) throw new Error(`withRepoPlist: lock ${lock} is busy`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const saved = existsSync(repoPlist) ? readFileSync(repoPlist, "utf8") : null;
  try {
    return await fn();
  } finally {
    try {
      // the template is generated, not tracked (launchd/*.plist in .gitignore): a test that made it removes it again
      if (saved !== null) writeFileSync(repoPlist, saved);
      else rmSync(repoPlist, { force: true });
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
