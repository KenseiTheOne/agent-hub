// Plugin host: discovery in directories, scheduled runs, passing frames to the core.
//
// Sources (in decreasing priority when ids collide):
//   builtin   — <repo>/plugins (config.builtinPluginsDir), trusted;
//   installed — <AGENTHUB_HOME>/Plugins/* (except local), third-party;
//   local     — <AGENTHUB_HOME>/Plugins/local, "unverified".

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readPluginMeta, parseFileName } from "./meta.mjs";
import { isAbsolutePath } from "./platform.mjs";
import { msg } from "./i18n.mjs";
import { cleanPhrase } from "./output.mjs";
import { actionArgv, buildEnv, commandFor, ensureDir, nextCron, osVars, parseCron, runOnce, spawnJob, StreamProcess, Watcher } from "./runner.mjs";

const PLATFORM = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform] || process.platform;

function findInDir(dir) {
  // folder plugin: a <dir>.* file inside
  const base = basename(dir);
  for (const f of readdirSync(dir).sort()) {
    const fn = parseFileName(f);
    if (fn && fn.id === base) return join(dir, f);
  }
  return null;
}

// Plugin id from the file name. Registry plugins follow the manager's ID_RE (lowercase, digits, "-"); built-in and local ones
// may also use uppercase, "_" and "." (SwiftBar-style names), but not ":", "@", spaces and the like: the id is part of the
// event key "<id>:<key>" (plugin "a:b" with event "x" would collide with "a" and "b:x"), and "@hub" is the hub's event source.
export const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function scanDir(dir, source) {
  const out = [];
  const warnings = [];
  if (!existsSync(dir)) return { plugins: out, warnings };
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    if (source === "installed" && name === "local") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    let file = null;
    if (st.isDirectory()) file = findInDir(p);
    else if (st.isFile()) file = p;
    if (!file) continue;
    try {
      const pm = readPluginMeta(file);
      if (!pm) continue;
      if (!PLUGIN_ID_RE.test(pm.id)) {
        warnings.push(msg("warn.plugin.badId", { name, id: String(pm.id).slice(0, 64) }));
        continue;
      }
      out.push({ ...pm, source, dir: dirname(file), mtimeMs: statSync(file).mtimeMs });
    } catch (e) {
      warnings.push(`${name}: ${e.message}`);
    }
  }
  return { plugins: out, warnings };
}

// A plugin's <agenthub.watch> paths. An entry may start with a variable that a core service gives to trusted
// plugins (ctx.providePluginEnv): "$AGENTHUB_USAGE_FILE — …" watches the usage service's cache file. The core substitutes
// the value from the same variables that go into the plugin's environment (pluginEnvFor: only builtin,
// official and own); for the rest, and with the service off, such an entry is skipped — the plugin runs on its own interval.
// The plugin's own directories ($AGENTHUB_PLUGIN_DATA_PATH, $AGENTHUB_PLUGIN_CACHE_PATH) are substituted for every tier:
// the instance adds them to vars (they are the plugin's, not a service's).
// The variable's value must be an absolute path per the platform's rules (platform — for tests).
// recursive — the entries declared with <agenthub.watch recursive="true"> (meta.watchRecursive): their paths come back as
// { path, recursive: true } (the Watcher then watches subdirectories too); others stay strings.
// → { paths: [...], skipped: [variable name] }
export function watchPaths(entries, vars, { platform = process.platform, recursive = [] } = {}) {
  const paths = [];
  const skipped = [];
  const deep = new Set(recursive);
  for (const e of entries || []) {
    const path0 = String(e).split(/\s+[—–-]{1,2}\s+/)[0].trim();
    const add = (p) => paths.push(deep.has(e) ? { path: p, recursive: true } : p);
    const m = /^\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))(.*)$/.exec(path0);
    if (!m) {
      add(path0);
      continue;
    }
    const name = m[1] || m[2];
    const v = vars?.[name];
    if (!isAbsolutePath(v, { platform })) {
      skipped.push(name);
      continue;
    }
    add(v + m[3]);
  }
  return { paths, skipped };
}

class PluginInstance {
  constructor(host, plugin) {
    this.host = host;
    this.core = host.core;
    this.plugin = plugin;
    this.timer = null;
    this.running = false;
    this.rerun = null;
    this.stream = null;
    this.watcher = null;
    this.stopped = false;
    this.cron = null;
    this.kills = new Set(); // group killers for current runs
    this.runPids = new Set(); // pids of ongoing standard runs (not actions): the pluginByPid fact
    this.actionPids = new Set(); // pids of ongoing actions (<agenthub.action>): the pluginByPid fact with { actions: true }
    this.streamGen = 0; // streamable process generation: a stale launch (overlapping language changes) doesn't start
  }
  get id() {
    return this.plugin.id;
  }
  async env(reason) {
    const cfg = this.core.config;
    const dataPath = ensureDir(join(cfg.paths.pluginData, this.id));
    const cachePath = ensureDir(join(cfg.paths.pluginCache, this.id));
    const secrets = await this.core.secretsFor(this.plugin);
    const extra = this.core.pluginEnvFor(this.plugin);
    return buildEnv({ pluginId: this.id, dataPath, cachePath, reason, lang: this.core.lang(), paused: this.core.estop(), os: await osVars(), secrets, extra, ...(cfg.pluginHome ? { home: cfg.pluginHome } : {}) });
  }
  start() {
    const p = this.plugin;
    const argv = commandFor(p);
    if (!argv) {
      this.core.pluginFailed(this.id, "not-executable");
      return;
    }
    this.argv = argv;
    if (p.meta.schedule) {
      try {
        this.cron = parseCron(p.meta.schedule);
      } catch (e) {
        this.core.warn(this.id, `schedule: ${e.message}`);
      }
    }
    if (p.meta.watch.length) {
      // service variables (trusted only) plus the plugin's own directories (any tier; created now so the watch holds);
      // "~" is the plugins' HOME (AGENTHUB_PLUGIN_HOME on a test bench), the same as in their environment
      const cfg = this.core.config;
      const own = { AGENTHUB_PLUGIN_DATA_PATH: ensureDir(join(cfg.paths.pluginData, this.id)), AGENTHUB_PLUGIN_CACHE_PATH: ensureDir(join(cfg.paths.pluginCache, this.id)) };
      const { paths, skipped } = watchPaths(p.meta.watch, { ...this.core.pluginEnvFor(p), ...own }, { recursive: p.meta.watchRecursive || [] });
      for (const name of skipped) this.core.warn(this.id, msg("warn.watch.var", { name }));
      if (paths.length) {
        this.watcher = new Watcher(paths, (changed) => this.onFiles(changed), cfg.pluginHome ? { home: cfg.pluginHome } : {});
        this.watcher.start();
      }
    }
    if (p.meta.type === "streamable") this.startStream();
    else this.runStandard("FirstLaunch");
  }
  async startStream(gen = this.streamGen, reason = gen ? "LanguageChanged" : "FirstLaunch") {
    const env = await this.env(reason);
    if (this.stopped || gen !== this.streamGen) return;
    const cfg = this.core.config.plugins;
    // a restart on a language or pause change (restartAll) stops the previous process — its exit isn't a plugin failure
    const sp = new StreamProcess(this.argv, {
      env,
      // an automatic restart after an exit builds the environment again (G8): a secret written meanwhile is seen
      envFn: () => this.env(reason),
      cwd: this.plugin.dir,
      maxBytes: cfg.maxOutputBytes,
      onFrame: (text, overflow) => this.core.applyFrame(this.id, text, { overflow }),
      onExit: ({ code, signal, error }) => {
        if (!this.stopped && !sp.stopped) this.core.pluginExited(this.id, { code, signal, error });
      },
      onStart: (pid) => this.core.pluginStarted(this.id, pid),
      // the process doesn't read stdin and over 1 MB waits in the pipe: messages are dropped, the journal hears once (B6)
      onBacklog: () => this.core.stdinBacklog?.(this.id),
    });
    this.stream = sp;
    sp.start();
  }
  // Restart streamable with a new environment. Every call is a new generation: if another call arrives while the previous process
  // is stopping or env() is waiting for the keychain, the old one doesn't start — one process lives.
  async restartStream(reason = "LanguageChanged") {
    const gen = ++this.streamGen;
    const old = this.stream;
    this.stream = null;
    // the plugin is told why first (G18): {"type":"stopping","reason":"restart","cause":<new AGENTHUB_REFRESH_REASON>}
    await old?.stop("restart", { cause: reason });
    if (this.stopped || gen !== this.streamGen) return;
    await this.startStream(gen, reason);
  }
  onFiles(paths) {
    if (this.plugin.meta.type === "streamable") {
      for (const path of paths.slice(0, 50)) this.send({ type: "fileChanged", path });
    } else this.refresh("FileChanged");
  }
  send(obj) {
    return this.stream ? this.stream.write(obj) : false;
  }
  schedule() {
    if (this.stopped || this.plugin.meta.type === "streamable") return;
    this.timer?.cancel?.();
    let delay = null;
    const minMs = this.core.config.plugins.minIntervalMs;
    if (this.cron) {
      const next = nextCron(this.cron);
      if (next) delay = next.getTime() - Date.now();
    } else if (this.plugin.intervalMs) delay = Math.max(this.plugin.intervalMs, minMs);
    if (delay === null) return;
    this.timer = wallTimer(Date.now() + delay, () => this.runStandard("Schedule"));
  }
  refresh(reason = "Manual") {
    // not launched (not-executable: no argv) — the diagnosis stays, no scheduled runs
    if (!this.argv) return;
    if (this.plugin.meta.type === "streamable") {
      this.send({ type: "refresh", reason });
      return;
    }
    this.runStandard(reason);
  }
  async runStandard(reason) {
    if (this.stopped || !this.argv) return;
    if (this.running) {
      this.rerun = reason;
      return;
    }
    this.running = true;
    this.timer?.cancel?.();
    let killer = null;
    let runPid = null;
    try {
      const env = await this.env(reason);
      // stopped while we waited for the keychain: don't launch the process (stop() would no longer see it)
      if (this.stopped) return;
      const cfg = this.core.config.plugins;
      const r = await runOnce(this.argv, {
        env,
        cwd: this.plugin.dir,
        timeoutMs: cfg.standardTimeoutMs,
        maxBytes: cfg.maxOutputBytes,
        onSpawn: (kill, pid) => {
          this.kills.add((killer = kill));
          if (pid) this.runPids.add((runPid = pid));
        },
        // the pid is the plugin's only while the process lives (B4): a descendant holding stdout delays the end of the run
        onLeaderExit: (pid) => this.runPids.delete(pid),
      });
      this.kills.delete(killer);
      this.runPids.delete(runPid);
      if (this.stopped) return;
      this.core.applyRun(this.id, r);
    } catch (e) {
      this.core.pluginFailed(this.id, e.message);
    } finally {
      this.running = false;
      if (this.rerun && !this.stopped) {
        const why = this.rerun;
        this.rerun = null;
        this.runStandard(why);
      } else this.schedule();
    }
  }
  // An action declared in <agenthub.action>: argv without a shell, cwd is the plugin directory, same environment.
  // The first word of the command is the plugin's main file name (`my-tool.30s.mjs --action stop`) → it runs
  // with the same interpreter as the plugin itself. A parameterized action's argument (already checked by the core against
  // the pattern) is a separate argv element: in place of the word `{name}`, or at the end if there is none.
  // The last stdout line of the form `reason=<code>` is the machine-readable refusal reason (result.reason); a `message=<text>` line
  // among the last lines (contract 2) is an explanation for humans in the hub language (AGENTHUB_LANG): the shell
  // shows it as is (result.message); the core and the shell know nothing about plugin codes.
  // input (G1) — the text a human typed for an input action: stdin is that text plus "\n", then EOF; argv never carries it.
  // background (G6) — start a job and return at once: { ok, job: { pid, kill } }; onJobExit({code, signal, ok, reason?, message?,
  // durationMs, error?}) when it ends. A job has no timeout and its own process group; its pid counts as an action pid.
  async runAction(action, argValue = null, { input = null, background = false, onJobExit = null } = {}) {
    if (this.stopped || !this.argv) return { ok: false, error: "stopped" };
    let argv = action.input ? actionArgv(action.command, action.arg, null, { input: true }) : actionArgv(action.command, action.arg, argValue);
    if (argv[0] === basename(this.plugin.file)) argv = [...this.argv, ...argv.slice(1)];
    const env = await this.env("MenuAction");
    // stopped or the hub was paused while we waited for the keychain — don't launch
    if (this.stopped) return { ok: false, error: "stopped" };
    if (this.core.estop()) return { ok: false, error: "estop" };
    const stdin = typeof input === "string" ? `${input}\n` : null;
    if (background) {
      let jobPid = null;
      const job = spawnJob(argv, {
        env,
        cwd: this.plugin.dir,
        stdin,
        // the pid is the plugin's only while the leader lives (B4)
        onLeaderExit: (pid) => this.actionPids.delete(pid),
        onExit: (x) => {
          this.actionPids.delete(jobPid);
          const m = /(?:^|\n)reason=([a-z0-9][a-z0-9-]{0,47})\s*$/.exec(x.tail || "");
          const message = actionMessage(x.tail);
          onJobExit?.({ ok: x.code === 0, code: x.code, signal: x.signal, durationMs: x.durationMs, ...(x.error ? { error: x.error } : {}), ...(m ? { reason: m[1] } : {}), ...(message ? { message } : {}) });
        },
      });
      if (job.error) return { ok: false, error: job.error };
      this.actionPids.add((jobPid = job.pid));
      return { ok: true, job };
    }
    let killer = null;
    let actPid = null;
    const r = await runOnce(argv, {
      env,
      stdin,
      cwd: this.plugin.dir,
      timeoutMs: this.core.config.plugins.actionTimeoutMs,
      maxBytes: 256 * 1024,
      onSpawn: (kill, pid) => {
        this.kills.add((killer = kill));
        if (pid) this.actionPids.add((actPid = pid));
      },
      onLeaderExit: (pid) => this.actionPids.delete(pid),
    });
    this.kills.delete(killer);
    this.actionPids.delete(actPid);
    const out = String(r.stdout || "");
    const m = /(?:^|\n)reason=([a-z0-9][a-z0-9-]{0,47})\s*$/.exec(out);
    const message = actionMessage(out);
    return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: r.timedOut, durationMs: r.durationMs, error: r.error, ...(m ? { reason: m[1] } : {}), ...(message ? { message } : {}) };
  }
  // reason (G18) — what the streamable process is told before SIGTERM: updated | policy | removed | shutdown.
  async stop(reason = null) {
    this.stopped = true;
    this.streamGen++;
    this.timer?.cancel?.();
    for (const kill of this.kills) kill();
    this.kills.clear();
    this.watcher?.close();
    await this.stream?.stop(reason);
  }
}

// The plugin's own explanation of an action refusal (contract 2): a `message=<text>` line among the last 5 non-empty
// stdout lines (the last such one). The text is sanitized like activity= phrases (control and formatting characters, length up to
// 120 graphemes). → string | null
export function actionMessage(stdout) {
  const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-5);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("message=")) continue;
    const v = cleanPhrase(lines[i].slice(8).replace(/^"(.*)"$/s, "$1"));
    return v || null;
  }
  return null;
}

// A wall-clock timer. A single long setTimeout on macOS runs on mach_absolute_time, which stops while the system
// sleeps: sleep time is added to the delay (a "0 9 * * *" run after a night's sleep would slip by a day).
// Hence steps no longer than stepMs and a check of Date.now() against the target on every step. → { cancel() }
export function wallTimer(targetMs, fn, { stepMs = 60_000 } = {}) {
  const h = { t: null, done: false, cancel() {
    this.done = true;
    clearTimeout(this.t);
  } };
  const arm = () => {
    if (h.done) return;
    const left = targetMs - Date.now();
    if (left <= 0) {
      h.done = true;
      fn();
      return;
    }
    h.t = setTimeout(arm, Math.min(left, stepMs));
    h.t.unref?.();
  };
  arm();
  return h;
}

// The policy the running instance was started with still holds: effects, actions, officialness, tier and the registry it came
// from (G19). The registry's display label is not compared here: a new label (a second registry was added, a name changed) does not
// restart the plugin — the host updates it in place (sameLabel, B7).
function samePolicy(a, b) {
  if (!b) return false;
  const eff = (x) => [...(x.effects || [])].sort().join(",");
  return eff(a) === eff(b) && Boolean(a.actions) === Boolean(b.actions) && Boolean(a.official) === Boolean(b.official) && (a.tier || null) === (b.tier || null) && (a.registry || null) === (b.registry || null);
}
const sameLabel = (a, b) => (a.registryLabel ?? null) === (b?.registryLabel ?? null);

export class PluginHost {
  constructor(core) {
    this.core = core;
    this.instances = new Map();
    this.dirWatcher = null;
    this.rescanTimer = null;
  }
  dirs() {
    const p = this.core.config.paths;
    return [
      [this.core.config.builtinPluginsDir, "builtin"],
      [p.plugins, "installed"],
      [p.pluginsLocal, "local"],
    ];
  }
  discover() {
    const seen = new Map();
    for (const [dir, source] of this.dirs()) {
      const { plugins, warnings } = scanDir(dir, source);
      for (const w of warnings) this.core.warn(null, w);
      for (const pl of plugins) {
        if (pl.meta.platforms.length && !pl.meta.platforms.includes(PLATFORM)) continue;
        if (seen.has(pl.id)) {
          this.core.warn(pl.id, msg("warn.plugin.idTaken", { source: seen.get(pl.id).source, file: pl.file }));
          continue;
        }
        seen.set(pl.id, pl);
      }
    }
    return seen;
  }
  async start() {
    await this.rescan();
    // first full scan: migrating old notification kinds — only for plugins installed now (core)
    this.core.pluginsScanned?.([...this.discover().keys()]);
    const dirs = this.dirs().map(([d]) => d); // the Watcher will pick up missing ones later
    // recursively: folder plugins are updated inside Plugins/<id>/
    this.dirWatcher = new Watcher(dirs, () => this.rescan(), { debounceMs: 1000, recursive: true });
    this.dirWatcher.start();
    // FSEvents loses events when there are many watchers — a safety rescan.
    const every = this.core.config.plugins?.rescanIntervalMs;
    if (every > 0) {
      this.rescanTimer = setInterval(() => this.rescan(), Math.max(every, 5000));
      this.rescanTimer.unref?.();
    }
  }
  // Rescans run in a chain, not overlapping.
  rescan() {
    this.chain = (this.chain || Promise.resolve()).then(() => this.rescanNow()).catch((e) => this.core.warn(null, `rescan: ${e.message}`));
    return this.chain;
  }
  async rescanNow() {
    const found = this.discover();
    for (const [id, inst] of this.instances) {
      const pl = found.get(id);
      let drop = !pl || pl.file !== inst.plugin.file || pl.mtimeMs !== inst.plugin.mtimeMs;
      // Same files, but the policy may have changed (lock, blocklist, consent): re-evaluate the running ones too.
      if (!drop) {
        const policy = await this.core.policyFor(pl);
        drop = !policy.allowed || !samePolicy(policy, inst.plugin.granted);
        // only the registry label changed (B7): the running instance keeps going, its state gets the new label
        if (!drop && !sameLabel(policy, inst.plugin.granted)) {
          inst.plugin.granted = { ...inst.plugin.granted, registryLabel: policy.registryLabel ?? null };
          this.core.pluginRelabeled?.(id, inst.plugin.granted);
        }
      }
      if (drop) {
        await inst.stop(!pl ? "removed" : pl.file !== inst.plugin.file || pl.mtimeMs !== inst.plugin.mtimeMs ? "updated" : "policy");
        this.instances.delete(id);
        // the same id remains on disk — a restart: events move to the new instance (core.pluginRemoved)
        this.core.pluginRemoved(id, { keepEvents: Boolean(pl) });
      }
    }
    for (const [id, pl] of found) {
      if (this.instances.has(id)) continue;
      const policy = await this.core.policyFor(pl);
      if (!policy.allowed) {
        this.core.warn(id, msg("warn.plugin.denied", { why: policy.reason || "policy" }));
        continue;
      }
      pl.granted = policy;
      for (const w of pl.warnings) this.core.warn(id, w);
      const inst = new PluginInstance(this, pl);
      this.instances.set(id, inst);
      this.core.pluginAdded(pl);
      inst.start();
    }
    this.core.finishCarried();
  }
  get(id) {
    return this.instances.get(id) || null;
  }
  // Whose process this is: an ongoing standard run or a live streamable process (not the plugin's descendants). A plugin action
  // (<agenthub.action>, started by a human) — only with { actions: true }: terminal routes (contract 3) and MCP calls
  // through hub connections let it through. → plugin (scanner object with granted) or null.
  pluginByPid(pid, { actions = false } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    for (const inst of this.instances.values()) {
      if (inst.stopped) continue;
      if (inst.runPids.has(pid) || (inst.stream && inst.stream.pid === pid)) return inst.plugin;
      if (actions && inst.actionPids.has(pid)) return inst.plugin;
    }
    return null;
  }
  // Something the core puts into every run's environment changed: the language (AGENTHUB_LANG) or the hub pause (AGENTHUB_PAUSED,
  // contract 3). streamable plugins restart (the environment is set at start), interval ones get an extra run;
  // reason is AGENTHUB_REFRESH_REASON (LanguageChanged | Paused | Resumed). Plugins not launched at start
  // (not-executable: no argv) are left alone. Changes go in one chain, not overlapping: a streamable has a single process.
  restartAll(reason) {
    this.restartChain = (this.restartChain || Promise.resolve()).then(() => this.restartAllNow(reason)).catch((e) => this.core.warn(null, `restart (${reason}): ${e.message}`));
    return this.restartChain;
  }
  relang() {
    return this.restartAll("LanguageChanged");
  }
  async restartAllNow(reason) {
    const jobs = [];
    for (const inst of this.instances.values()) {
      if (inst.stopped || !inst.argv) continue;
      if (inst.plugin.meta.type === "streamable") jobs.push(inst.restartStream(reason));
      else inst.runStandard(reason);
    }
    await Promise.all(jobs);
  }
  // Restart one plugin with a fresh environment (a secret written in the app — G8, or another service-side change): a streamable
  // one is stopped (it gets {"type":"stopping","reason":"restart","cause":reason}) and started again; a standard one gets an
  // extra run. reason is AGENTHUB_REFRESH_REASON. → false — no such plugin (or not launched).
  restartPlugin(id, reason = "Manual") {
    const inst = this.instances.get(id);
    if (!inst || inst.stopped || !inst.argv) return Promise.resolve(false);
    if (inst.plugin.meta.type === "streamable") return inst.restartStream(reason).then(() => true);
    inst.runStandard(reason);
    return Promise.resolve(true);
  }
  send(id, obj) {
    return this.instances.get(id)?.send(obj) ?? false;
  }
  refresh(id, reason) {
    const inst = this.instances.get(id);
    if (!inst) return false;
    inst.refresh(reason);
    return true;
  }
  async stop() {
    clearInterval(this.rescanTimer);
    this.dirWatcher?.close();
    await Promise.all([...this.instances.values()].map((i) => i.stop("shutdown")));
    this.instances.clear();
  }
}
