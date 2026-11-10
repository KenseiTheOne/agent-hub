// Running plugins.
//
// standard   — on the interval from the file name or on <agenthub.schedule> (cron), with a timeout (5 s), then kill
//              of the whole process group and status error.
// streamable — a long-lived process; stdout is split into frames on `~~~`; the core writes NDJSON to stdin
//              ({"type":"fileChanged"|"inbound"|"actionResult", ...}); if it dies, it restarts with backoff.
// The environment is cleaned: only the basics (HOME, PATH, TMPDIR, LANG, USER), AGENTHUB_*, OS_* and declared secrets.
// <agenthub.watch> — fs.watch (FSEvents on macOS) with debouncing.

import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, watch } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { expandHome, standardPath } from "./config.mjs";
import { FrameSplitter } from "./output.mjs";
import { msg } from "./i18n.mjs";
import { interpreterFor, isWindows, killTree, osInfoCommands, treeSpawnOptions } from "./platform.mjs";

// → [command, ...args] for a plugin file. The interpreter by extension comes from the platform layer
// (POSIX: /usr/bin/python3, /bin/sh…; Windows: from PATH).
export function commandFor(plugin) {
  const interp = interpreterFor(plugin.ext);
  if (plugin.executable && !interp) return [plugin.file];
  if (interp) return [...interp, plugin.file];
  return null;
}

// ---------- OS_* ----------
let osCache = { at: 0, vars: null, pending: null };

function execText(file, args) {
  return new Promise((res) => {
    execFile(file, args, { timeout: 2000, encoding: "utf8" }, (err, out) => res(err ? "" : String(out).trim()));
  });
}

function sysctlTime(text) {
  const m = /sec\s*=\s*(\d+)/.exec(text);
  return m ? new Date(Number(m[1]) * 1000).toISOString() : "";
}

// commands: OS info commands (tests replace them; null means the OS has none: Linux, Windows).
export async function osVars({ commands = osInfoCommands() } = {}) {
  if (osCache.vars && Date.now() - osCache.at < 30_000) return osCache.vars;
  if (osCache.pending) return osCache.pending;
  // The cache is updated in .then, not in the collection body: without OS commands the body never reaches await and
  // would run synchronously, so the new osCache would appear before pending is assigned and osVars would return null (buildEnv crashed).
  osCache.pending = collectOsVars(commands).then((vars) => {
    osCache = { at: Date.now(), vars, pending: null };
    return vars;
  });
  return osCache.pending;
}

async function collectOsVars(cmds) {
  const vars = { OS_PLATFORM: process.platform };
  if (cmds) {
    const [ver, appearance, wake, sleep] = await Promise.all([cmds.version, cmds.appearance, cmds.wake, cmds.sleep].map(([f, ...a]) => execText(f, a)));
    const [maj = "", min = "", patch = "0"] = ver.split(".");
    Object.assign(vars, {
      OS_VERSION_MAJOR: maj,
      OS_VERSION_MINOR: min,
      OS_VERSION_PATCH: patch,
      OS_APPEARANCE: appearance === "Dark" ? "Dark" : "Light",
      OS_LAST_WAKE_TIME: sysctlTime(wake),
      OS_LAST_SLEEP_TIME: sysctlTime(sleep),
    });
  }
  return vars;
}

// The plugin's cleaned environment. Secrets: { NAME: value } → AGENTHUB_SECRET_NAME.
export function buildEnv({ pluginId, dataPath, cachePath, reason, lang = "ru", paused = false, os = {}, secrets = {}, extra = {}, home = homedir(), platform = process.platform, sysEnv = process.env }) {
  let user = "";
  try {
    user = userInfo().username;
  } catch {}
  const env = {
    HOME: home,
    PATH: standardPath(home),
    TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: "en_US.UTF-8",
    USER: user,
    AGENTHUB_PLUGIN_ID: pluginId,
    AGENTHUB_PLUGIN_DATA_PATH: dataPath,
    AGENTHUB_PLUGIN_CACHE_PATH: cachePath,
    AGENTHUB_REFRESH_REASON: reason,
    // The hub UI language (ru | en). LANG stays en_US.UTF-8 for predictable parsing of program output.
    AGENTHUB_LANG: lang === "en" ? "en" : "ru",
    // Hub pause (contract 3): 1 means ESTOP is set, 0 means it is not. Always passed: an explicit 0 tells the plugin the hub
    // is new enough and background work is allowed; setting and clearing the pause restarts plugins (Paused|Resumed).
    AGENTHUB_PAUSED: paused ? "1" : "0",
  };
  if (isWindows(platform)) {
    // On Windows os.homedir() reads USERPROFILE, not HOME; without SystemRoot sockets (Winsock) do not work and
    // processes do not start. The values are system paths, not secrets.
    env.USERPROFILE = home;
    for (const k of ["SystemRoot", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) if (sysEnv[k]) env[k] = sysEnv[k];
  }
  for (const [k, v] of Object.entries(os)) if (k.startsWith("OS_")) env[k] = String(v);
  // from core services, trusted plugins only (core.pluginEnvFor): AGENTHUB_<NAME>; core-owned names and secrets are not overridden
  for (const [k, v] of Object.entries(extra)) {
    if (/^AGENTHUB_[A-Z][A-Z0-9_]*$/.test(k) && !(k in env) && !k.startsWith("AGENTHUB_SECRET_") && typeof v === "string") env[k] = v;
  }
  for (const [k, v] of Object.entries(secrets)) {
    const name = k.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    if (typeof v === "string") env[`AGENTHUB_SECRET_${name}`] = v;
  }
  return env;
}

// The plugin process with all descendants: POSIX uses a process group, Windows uses taskkill /T (platform layer).
function killGroup(child, signal) {
  killTree(child, signal);
}

// A one-shot run with a timeout. → { code, signal, stdout, timedOut, overflow, durationMs, error? }
// onSpawn(kill, pid) receives a function that kills the process group (to stop the daemon mid-run) and the pid
// of the started process (the core uses it to identify the plugin process: fact pluginByPid, oauth service).
export function runOnce(argv, { env, cwd, timeoutMs = 5000, maxBytes = 1024 * 1024, stdin = null, onSpawn = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, cwd, ...treeSpawnOptions(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: "", timedOut: false, overflow: false, durationMs: 0, error: e.code || e.message });
      return;
    }
    onSpawn?.(() => killGroup(child, "SIGKILL"), child.pid ?? null);
    const chunks = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let done = false;
    let stderrBytes = 0;
    const finish = (code, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // finish off any descendants left in the group
      killGroup(child, "SIGKILL");
      resolve({
        code,
        signal,
        stdout: Buffer.concat(chunks).toString("utf8"),
        timedOut,
        overflow,
        stderrBytes,
        durationMs: Date.now() - started,
        ...(error ? { error } : {}),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => {
        killGroup(child, "SIGKILL");
        finish(null, "SIGKILL");
      }, 500).unref();
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      if (size + b.length > maxBytes) {
        overflow = true;
        killGroup(child, "SIGKILL");
        return;
      }
      chunks.push(b);
      size += b.length;
    });
    child.stderr.on("data", (b) => {
      stderrBytes += b.length; // stderr is not kept: it may contain anything
    });
    child.on("error", (e) => finish(null, null, e.code || e.message));
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin.on("error", () => {});
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

// A long-lived streamable process.
export class StreamProcess {
  constructor(argv, { env, cwd, maxBytes = 1024 * 1024, onFrame, onExit, onStart }) {
    this.argv = argv;
    this.opts = { env, cwd };
    this.maxBytes = maxBytes;
    this.onFrame = onFrame;
    this.onExit = onExit;
    this.onStart = onStart;
    this.child = null;
    this.stopped = false;
    this.backoffMs = 1000;
    this.restartTimer = null;
    this.startedAt = 0;
  }
  start() {
    if (this.stopped || this.child) return;
    this.startedAt = Date.now();
    let child;
    try {
      child = spawn(this.argv[0], this.argv.slice(1), { ...this.opts, ...treeSpawnOptions(), stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      this.onExit?.({ code: null, signal: null, error: e.code || e.message });
      this.scheduleRestart();
      return;
    }
    this.child = child;
    const splitter = new FrameSplitter((frame, overflow) => this.onFrame?.(frame, overflow), this.maxBytes);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s) => splitter.push(s));
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    child.on("close", (code, signal) => {
      splitter.end();
      killGroup(child, "SIGKILL");
      if (this.child === child) this.child = null;
      this.onExit?.({ code, signal });
      // ran for more than a minute: reset the backoff
      if (Date.now() - this.startedAt > 60_000) this.backoffMs = 1000;
      this.scheduleRestart();
    });
    this.onStart?.(child.pid);
  }
  scheduleRestart() {
    if (this.stopped) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start(), this.backoffMs);
    this.restartTimer.unref?.();
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }
  // NDJSON to stdin
  write(obj) {
    if (!this.child || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }
  get pid() {
    return this.child?.pid ?? null;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(() => {
        killGroup(child, "SIGKILL");
        res();
      }, 1000);
      child.once("close", () => {
        clearTimeout(t);
        res();
      });
      try {
        child.stdin.end();
      } catch {}
      killGroup(child, "SIGTERM");
    });
  }
}

// ---------- watch ----------
// A path may end with a glob in its last segment: ~/.claude/sessions/*.json
// If the path does not exist yet but its parent directory does (a cache file a service is about to write), the parent
// is watched by name: the path appearing fires an event right away (not after retryMs). Once a directory appears, it is watched instead.
function globToRe(mask) {
  return new RegExp("^" + mask.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
}

export class Watcher {
  constructor(entries, onChange, { debounceMs = 300, retryMs = 30_000, home = homedir(), recursive = false } = {}) {
    this.recursive = recursive;
    this.targets = entries.map((e) => {
      const p = expandHome(String(e).split(/\s+[—–-]{1,2}\s+/)[0].trim(), home);
      const base = basename(p);
      if (/[*?]/.test(base)) return { dir: dirname(p), filter: globToRe(base), raw: p };
      return { dir: p, filter: null, raw: p };
    });
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.retryMs = retryMs;
    this.watchers = [];
    this.timer = null;
    this.retry = null;
    this.pending = new Set();
    this.closed = false;
  }
  start() {
    let missing = false;
    for (const t of this.targets) {
      if (t.w) continue;
      if (!existsSync(t.dir)) {
        if (!t.filter && this.watchParent(t)) continue;
        missing = true;
        continue;
      }
      let isFile = false;
      try {
        isFile = statSync(t.dir).isFile();
      } catch {}
      try {
        const target = isFile ? dirname(t.dir) : t.dir;
        const only = isFile ? basename(t.dir) : null;
        t.w = watch(target, { persistent: false, recursive: this.recursive && !isFile }, (_ev, name) => {
          const n = name ? String(name) : "";
          if (only && n && n !== only) return;
          if (t.filter && n && !t.filter.test(n)) return;
          this.pending.add(n ? join(target, n) : target);
          this.kick();
        });
        t.w.on("error", () => {
          try {
            t.w.close();
          } catch {}
          t.w = null;
          this.scheduleRetry();
        });
      } catch {
        missing = true;
      }
    }
    if (missing) this.scheduleRetry();
  }
  // Wait for the path t.dir to appear by watching its parent directory. → true if the watch is set up.
  watchParent(t) {
    const parent = dirname(t.dir);
    const only = basename(t.dir);
    try {
      if (!statSync(parent).isDirectory()) return false;
    } catch {
      return false;
    }
    try {
      t.w = watch(parent, { persistent: false }, (_ev, name) => {
        const n = name ? String(name) : "";
        if (n && n !== only) return;
        this.pending.add(t.dir);
        this.kick();
        let dir = false;
        try {
          dir = statSync(t.dir).isDirectory();
        } catch {}
        if (dir && !this.closed) {
          try {
            t.w?.close();
          } catch {}
          t.w = null;
          this.start();
        }
      });
      t.w.on("error", () => {
        try {
          t.w.close();
        } catch {}
        t.w = null;
        this.scheduleRetry();
      });
      return true;
    } catch {
      t.w = null;
      return false;
    }
  }
  scheduleRetry() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.start();
    }, this.retryMs);
    this.retry.unref?.();
  }
  kick() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending.clear();
      if (!this.closed) this.onChange(paths);
    }, this.debounceMs);
    this.timer.unref?.();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.retry);
    for (const t of this.targets) {
      try {
        t.w?.close();
      } catch {}
      t.w = null;
    }
  }
}

// ---------- cron ----------
// Five fields: minute hour day-of-month month day-of-week; *, lists, ranges, steps; 0 and 7 are Sunday.
function parseField(f, min, max) {
  const set = new Set();
  for (const part of f.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(msg("err.cron.field", { field: f }));
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(msg("err.cron.range", { part }));
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(msg("err.cron.fields"));
  const dow = parseField(f[4], 0, 7);
  if (dow.has(7)) dow.add(0);
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12),
    dow,
    domAny: f[2] === "*",
    dowAny: f[4] === "*",
  };
}

// The next firing time strictly after from (local time).
export function nextCron(cron, from = new Date()) {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = c.dom.has(d.getDate());
    const dowOk = c.dow.has(d.getDay());
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

// Parses an action command line into argv without a shell: quotes and backslashes; ~/ is expanded.
// A plugin action's argv before the interpreter is prepended: the command per splitCommand rules, with the argument value
// replacing a `{name}` word (except the first), or appended at the end if there is none. The same for running
// (host.mjs runAction) and for the confirmation text (core.mjs shownCommand): a human sees exactly the argv that will run.
export function actionArgv(command, argDecl, value) {
  let argv = splitCommand(String(command || ""));
  if (argDecl) {
    const i = argv.indexOf(`{${argDecl.name}}`);
    if (i >= 1) argv = argv.map((a, k) => (k === i ? value : a));
    else argv = [...argv, value];
  }
  return argv;
}

export function splitCommand(cmd, home = homedir()) {
  const out = [];
  let cur = "";
  let q = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (q) throw new Error(msg("err.quote"));
  if (has || cur) out.push(cur);
  return out.map((a) => expandHome(a, home));
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}
