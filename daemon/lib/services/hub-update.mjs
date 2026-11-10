// The hub-update service: auto-update of the hub itself (daemon + app), see docs/hub-updates.md.
//
// Release checks (lib/hub-update/checker.mjs), install and rollback (lib/hub-update/updater.mjs): the build runs as a
// separate `agenthub hub build` process, the switch is files (pin, Versions/current, built-in plugin copy),
// the restart is the daemon exiting with code 75 (launchd brings it back from the new version), and confirmation is the
// new app opening the /events stream; without confirmation, rollback (the `agenthub hub watch` watchdog or the daemon itself).
// Routes: lib/routes/hub-update.mjs; only the app class writes.
//
// Settings: services.hubUpdate in config.json:
//   brew          — the Homebrew source tree (<prefix>/opt/agent-hub/libexec), written by `agenthub setup`: versions come
//                   from there, not from git tags (§8b); read fresh, not only at start;
//   remote        — origin URL (otherwise build.json.origin of the current version); checkUpdates = false disables checks;
//   prerelease    — consider vX.Y.Z-… tags; updateCheck — {firstDelayMs, intervalMs, jitterMs, backoffMs};
//   branch        — release branch in origin (main): the tag's commit must be in its history;
//   maxMajorJump  — how many major versions ahead to look (1): a junk v999.0.0 does not hide releases;
//   deadlineMs    — how long to wait for the new version's confirmation (5 min); keepVersions — how many versions to keep (3);
//   test.self     — test directory only: the label of "our" version (the test daemon does not run from Versions);
//   test.watchdog — test directory only: whether to start the watchdog (off by default);
//   test.terminate — test directory only: a fake argv instead of SIGTERM to the app (pid last).

import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DAEMON_DIR, INSTALL } from "../config.mjs";
import { msg } from "../i18n.mjs";
import { appBundleProblem, appControl, detachedSpawnOptions, killProcessTree } from "../platform.mjs";
import { launchdNode } from "../launchd.mjs";
import { VERSION, isLabel } from "../version.mjs";
import { BUILD_DEFAULTS, buildEnv, liveCodeOf, testCodeOf } from "../hub-update/build.mjs";
import { HubUpdateChecker } from "../hub-update/checker.mjs";
import { ensureDir, hubPaths, readBuild } from "../hub-update/layout.mjs";
import { usableOrigin } from "../hub-update/remote.mjs";
import { brewSettingReader } from "../hub-update/brew.mjs";
import { readInstall, startupVerdict } from "../hub-update/trial.mjs";
import { HubUpdater } from "../hub-update/updater.mjs";
import { isTestHome, pinnedPath } from "./app.mjs";

export const name = "hub-update";

const running = new Map(); // ctx → { updater, off }

const CLI = join(DAEMON_DIR, "bin", "agenthub");

function selfLabel(ctx, testMode) {
  const t = ctx.config.services?.hubUpdate?.test;
  if (testMode) return typeof t?.self === "string" && isLabel(t.self) ? t.self : null;
  // the code comes from an install, and that install belongs to this state directory
  return INSTALL && INSTALL.home === ctx.paths.home ? INSTALL.label : null;
}

// AGENTHUB_LANG — the hub language at spawn time: the builder's and watchdog's human texts (build log, error details,
// watchdog log) follow it (bin/agenthub picks it up before the home's settings.json).
function childEnv(home, testMode, lang) {
  const env = buildEnv();
  if (testMode) env.AGENTHUB_HOME = home;
  if (lang === "ru" || lang === "en") env.AGENTHUB_LANG = lang;
  return env;
}

export async function start(ctx) {
  const cfg = ctx.config.services?.hubUpdate && typeof ctx.config.services.hubUpdate === "object" ? ctx.config.services.hubUpdate : {};
  const home = ctx.paths.home;
  const testMode = isTestHome(home);
  const self = selfLabel(ctx, testMode);
  // Why the daemon started, read before resume() rewrites install.json: a trial run of the new version
  // (confirm-wait), a return to the previous one (restore, finalize-failed). Such a start waits for the app: the app
  // service launches it even with "Launch at login" off (expectApp).
  let startVerdict = null;
  try {
    startVerdict = startupVerdict(readInstall(home), self);
  } catch {}
  const test = testMode && cfg.test && typeof cfg.test === "object" ? cfg.test : {};
  const journal = (e) => ctx.journal.write(e);
  const remote = () => {
    if (typeof cfg.remote === "string" && cfg.remote) return cfg.remote;
    const b = self ? readBuild(home, self) : null;
    return usableOrigin(b?.origin);
  };
  // A Homebrew-managed hub (§8b): `agenthub setup` and `agenthub uninstall` write the setting while the daemon runs, so it is
  // read from config.json each time (cached by mtime). Set — no git tags at all, versions come from the brew tree.
  const readBrew = brewSettingReader();
  const brew = () => readBrew(ctx.paths.config);
  let updater = null;
  const checker = new HubUpdateChecker({
    home,
    journal,
    emit: (ev) => ctx.emit(ev),
    onChange: () => updater?.changed(),
    remote,
    brew,
    current: () => self || VERSION,
    setting: () => ctx.settings.get("checkHubUpdates"),
    configAllows: () => cfg.checkUpdates !== false,
    timing: cfg.updateCheck,
    prerelease: cfg.prerelease === true,
    ...(Number.isInteger(cfg.maxMajorJump) && cfg.maxMajorJump >= 0 ? { maxMajorJump: cfg.maxMajorJump } : {}),
    testMode,
  });
  const apps = appControl({ testMode, test: ctx.config.services?.app?.test, pidPath: (pid) => ctx.facts.processPath?.(pid) ?? null });
  const life = ctx.lifecycle;
  updater = new HubUpdater({
    home,
    configPath: ctx.paths.config,
    self,
    version: VERSION,
    journal,
    emit: (ev) => ctx.emit(ev),
    estop: () => ctx.estop(),
    life,
    checker,
    opts: {
      ...(Number.isFinite(cfg.deadlineMs) && cfg.deadlineMs > 0 ? { deadlineMs: testMode ? cfg.deadlineMs : Math.max(60_000, cfg.deadlineMs) } : {}),
      ...(Number.isInteger(cfg.keepVersions) && cfg.keepVersions >= 2 ? { keepVersions: cfg.keepVersions } : {}),
      ...(testMode && Number.isFinite(test.appQuitMs) ? { appQuitMs: test.appQuitMs } : {}),
      ...(testMode && Number.isFinite(test.launchDelayMs) ? { launchDelayMs: test.launchDelayMs } : {}),
      ...(typeof cfg.branch === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(cfg.branch) && !cfg.branch.startsWith("-") ? { branch: cfg.branch } : {}),
    },
    codeOf: testMode ? testCodeOf : liveCodeOf,
    spawnBuilder: (job) => {
      // the origin URL goes via stdin, not argv (ps shows argv; the URL may contain credentials)
      const node = childNode();
      return runBuilder(node, builderArgv(home, job), {
        env: childEnv(home, testMode, ctx.lang()),
        stdin: JSON.stringify({ remote: job.remote || "" }) + "\n",
        timeoutMs: testMode && Number.isFinite(test.builderTimeoutMs) ? test.builderTimeoutMs : builderTimeoutMs(),
        onStep: job.onStep,
      });
    },
    spawnWatchdog: () => {
      if (testMode && test.watchdog !== true) return null;
      const node = childNode();
      if (!node) throw new Error(msg("hub.err.nodeMissing"));
      ensureDir(hubPaths(home).logs);
      const fd = openSync(join(hubPaths(home).logs, "hub-update-watch.log"), "a", 0o600);
      try {
        // its own process group (detached): launchd kills the daemon's group when it exits, and the watchdog must survive that
        const child = spawn(node, [CLI, "hub", "watch", "--home", home], { env: childEnv(home, testMode, ctx.lang()), ...detachedSpawnOptions(), stdio: ["ignore", fd, fd] });
        // a spawn error arrives asynchronously (EAGAIN, EMFILE): without a handler it is an uncaughtException mid-shutdown
        child.on("error", (e) => journal({ type: "warning", detail: msg("hub.warn.watchdogFailed", { why: e.code || e.message }) }));
        child.unref();
        return child.pid ?? null;
      } finally {
        closeSync(fd);
      }
    },
    terminate: (pid) => {
      if (testMode) {
        const argv = Array.isArray(test.terminate) && test.terminate.every((a) => typeof a === "string" && a) ? test.terminate : null;
        if (argv) execFile(argv[0], [...argv.slice(1), String(pid)], () => {});
        return;
      }
      process.kill(pid, "SIGTERM");
    },
    launchApp: (path) => apps.launch(path).then((r) => journal({ type: "app-launch", reason: "hub-update", ok: Boolean(r?.ok), code: r?.code ?? null, path, skipped: r?.skipped ?? null })),
    // bundle processes by path (a new app that never connected) get SIGTERM
    killApp: async (appPath) => {
      for (const pid of (await apps.processes(appPath)) || []) {
        try {
          if (testMode) {
            const argv = Array.isArray(test.terminate) && test.terminate.every((a) => typeof a === "string" && a) ? test.terminate : null;
            if (argv) execFile(argv[0], [...argv.slice(1), String(pid)], () => {});
          } else process.kill(pid, "SIGTERM");
          journal({ type: "hub-update-app-terminated", pid, path: appPath });
        } catch {}
      }
    },
    // the previous app quit for the switch, but there will be no switch
    relaunchApp: () => relaunchPrevious({ sup: ctx.facts.get("app.supervisor"), apps, configPath: ctx.paths.config, requirement: ctx.config.requirements?.app ?? null, testMode, journal }),
    // PermissionRequest cards and waiting sessions: a daemon restart removes the cards (they fall back to the terminal); a
    // session waiting for terminal input without a hub card is not affected by the restart, but it is better not to interrupt it either
    waiting: () => {
      const cards = ctx.facts.get("hook.pending");
      const n = Array.isArray(cards) ? cards.length : 0;
      let sessions = 0;
      try {
        for (const x of ctx.facts.sessions?.() || []) if (x?.status === "waiting") sessions++;
      } catch {}
      return { cards: n, sessions };
    },
    hasSupervisor: () => Boolean(ctx.facts.get("app.supervisor")),
    processAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e?.code === "EPERM";
      }
    },
  });
  try {
    ctx.facts.provide("hub.update", () => (running.get(ctx)?.updater === updater ? updater.info() : null));
    ctx.facts.provide("hub.updater", () => updater);
    ctx.facts.provide("hub.update.expectsPin", (fp) => updater.expectsPin(fp));
    ctx.facts.provide("hub.update.startVerdict", () => startVerdict);
  } catch {}
  const onPeer = (ev) => {
    if (ev?.connected && ev.stream) updater.onAppStream();
  };
  const onSettings = (ev) => {
    if (ev && "checkHubUpdates" in ev) checker.settingChanged();
  };
  const onEstop = () => updater.changed();
  const onStarted = () => updater.resume();
  // Built and waiting for restart (ready): the waiting count in hubUpdate.install is computed at broadcast time; hook cards
  // and sessions change without the service, so recompute on their events (the fingerprint in changed() drops redundant ones).
  const WAITING_EVENTS = ["hook.card", "hook.card.removed", "hook.paused", "sessions"];
  const onWaiting = () => {
    if (updater.state?.phase === "ready") updater.changed();
  };
  ctx.on("app.peer", onPeer);
  ctx.on("settings.changed", onSettings);
  ctx.on("estop", onEstop);
  ctx.on("services.started", onStarted);
  for (const t of WAITING_EVENTS) ctx.on(t, onWaiting);
  running.set(ctx, {
    updater,
    off: () => {
      ctx.off("app.peer", onPeer);
      ctx.off("settings.changed", onSettings);
      ctx.off("estop", onEstop);
      ctx.off("services.started", onStarted);
      for (const t of WAITING_EVENTS) ctx.off(t, onWaiting);
    },
  });
  ctx.journal.write({ type: "hub-update-service", self, testMode, remote: Boolean(remote()), brew: brew() });
  checker.start();
}

export async function stop(ctx) {
  const r = running.get(ctx);
  if (!r) return;
  running.delete(ctx);
  r.off();
  r.updater.stop();
  r.updater.checker.stop();
  // release notes may still be loading after "Check now" (a temporary mirror in HubUpdate/): let it finish,
  // but do not hold up shutdown for more than 2 s
  let t;
  await Promise.race([r.updater.checker.settled?.(), new Promise((done) => (t = setTimeout(done, 2000)))]);
  clearTimeout(t);
}

// Bring back the previous app: if supervision (the app service) exists and is on, it decides (with the restart limit
// exhausted it does not launch: the stop after crashes applies here too, journal entry app-launch-skipped why=limited).
// Without supervision (supervise:false), launch the pinned build ourselves under the same rules: the path is only an appPin
// that belongs to the current requirements.app (pinnedPath), the bundle is ours (appBundleProblem), and the signature on
// disk matches the requirement (apps.verify); otherwise app-launch-skipped with why. → "supervisor" | "launch" | null
export function relaunchPrevious({ sup, apps, configPath, requirement = null, testMode = false, journal = () => {} }) {
  if (sup?.schedule && sup.opts?.supervise !== false) {
    if (sup.limited) {
      journal({ type: "app-launch-skipped", reason: "hub-update-relaunch", why: "limited" });
      return null;
    }
    // relaunch, not start: a disabled "Launch at login" does not apply to bringing the app back
    sup.schedule("relaunch", sup.opts?.restartDelayMs ?? 2000);
    return "supervisor";
  }
  const pin = pinnedPath(configPath, requirement);
  const why = pin.path ? appBundleProblem(pin.path, { testMode }) : pin.why;
  if (why) {
    journal({ type: "app-launch-skipped", reason: "hub-update-relaunch", why });
    return null;
  }
  const path = pin.path;
  Promise.resolve(apps.verify(path, requirement))
    .then((ok) => {
      if (ok !== true) return journal({ type: "app-launch-skipped", reason: "hub-update-relaunch", why: ok === false ? "pin-mismatch" : "verify-error", path });
      return Promise.resolve(apps.launch(path)).then((r) => journal({ type: "app-launch", reason: "hub-update-relaunch", ok: Boolean(r?.ok), code: r?.code ?? null, path, skipped: r?.skipped ?? null }));
    })
    .catch(() => {});
  return "launch";
}

// The builder's argv: no origin URL (it goes via stdin, --remote-stdin). A Homebrew source — its directory (--brew; the
// commit only if the formula recorded one).
export function builderArgv(home, { label, version, tag, commit, branch, log, brew = null }) {
  if (brew) return [CLI, "hub", "build", "--home", home, "--label", label, "--version", version, "--brew", brew, ...(commit ? ["--commit", commit] : []), "--log", log];
  return [CLI, "hub", "build", "--home", home, "--label", label, "--version", version, "--tag", tag, "--commit", commit, "--branch", branch || "main", "--remote-stdin", "--log", log];
}

// node for the builder and the watchdog. process.execPath is a versioned Cellar path (/opt/homebrew/Cellar/node/X/bin/node):
// after `brew upgrade node` its directory is gone, while the daemon runs for days. Order: argv0 (as launchd started it,
// ProgramArguments[0], usually the stable link /opt/homebrew/bin/node), then execPath, then launchdNode(). If none
// works, null (the service replies hub-update:node-missing).
export function childNode({ argv0 = process.argv0, execPath = process.execPath, exists = existsSync, fallback = () => launchdNode({ fallback: null }) } = {}) {
  if (typeof argv0 === "string" && isAbsolute(argv0) && exists(argv0)) return argv0;
  if (typeof execPath === "string" && exists(execPath)) return execPath;
  const f = fallback();
  return typeof f === "string" && f && exists(f) ? f : null;
}

// Overall builder deadline: build steps have their own timeouts (BUILD_DEFAULTS: git, 5 min for each of the three
// network commands; build-release.sh, 30 min; self-test, 1 min) plus a margin; past that the whole builder is killed.
export function builderTimeoutMs(t = BUILD_DEFAULTS) {
  return 3 * t.cloneTimeoutMs + t.buildTimeoutMs + t.selfTestTimeoutMs + 5 * 60_000;
}

// The builder process: {"step": …} lines are build progress (onStep); the updater parses the result (the last line).
// On timeout, SIGKILL to the builder with all descendants (killProcessTree: git and swift are grandchildren), result {timedOut: true};
// 'close' is awaited at most graceMs after exit (a grandchild with an inherited stdout would hold it). No node or the process
// failed to start: {code: -1, error: "node-missing" | error code}. → { pid, done: Promise<{code, out, timedOut?, error?}> }
export function runBuilder(node, argv, { env, stdin = "", timeoutMs, graceMs = 2000, onStep = null, killTree = killProcessTree } = {}) {
  if (!node) return { pid: null, done: Promise.resolve({ code: -1, out: "", error: "node-missing" }) };
  let child;
  try {
    child = spawn(node, argv, { env, stdio: ["pipe", "pipe", "ignore"] });
  } catch (e) {
    return { pid: null, done: Promise.resolve({ code: -1, out: "", error: e.code || "spawn-failed" }) };
  }
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
  let out = "";
  let pending = "";
  child.stdout.on("data", (c) => {
    if (out.length < 256 * 1024) out += c;
    pending += c;
    let i;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      if (!line.startsWith('{"step":')) continue;
      try {
        onStep?.(JSON.parse(line).step);
      } catch {}
    }
    if (pending.length > 64 * 1024) pending = "";
  });
  const done = new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let grace = null;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      try {
        child.stdout.destroy();
      } catch {}
      resolve({ out, ...r, ...(timedOut ? { timedOut: true, code: -1 } : {}) });
    };
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            killTree(child.pid, "SIGKILL");
          } catch {}
          grace = setTimeout(() => finish({ code: -1 }), graceMs);
        }, timeoutMs)
      : null;
    child.on("error", (e) => finish({ code: -1, error: e.code || "spawn-failed" }));
    child.on("exit", (code) => {
      clearTimeout(grace);
      grace = setTimeout(() => finish({ code: typeof code === "number" ? code : -1 }), graceMs);
    });
    child.on("close", (code) => finish({ code: typeof code === "number" ? code : -1 }));
  });
  return { pid: child.pid ?? null, done };
}

// For tests: this core's service.
export function _updater(ctx) {
  return running.get(ctx)?.updater ?? null;
}
