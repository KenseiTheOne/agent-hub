// The app service: daemon supervision of AgentHub.app (decision 2026-11-06).
// "If the hub is dead but the daemon is alive, the daemon restores the hub. Closing the hub closes the daemon too."
//
// Logic: lib/app-supervisor.mjs; platform (finding the process, launching, checking the bundle signature): appControl
// from lib/platform.mjs. This file wires it to the core: app-class connections (internal bus event app.peer), "daemon
// stopping" (POST /shutdown, signal) and the pinned build path.
//
// The path comes only from config.json → appPin.path (written by `agenthub pin-app`, which scripts/bundle.sh calls), and
// only if appPin belongs to the current requirements.app (requirementSha matches). Without it (--cert mode, an entry from
// before 2026-11-06) the daemon does not launch the app: app-launch-skipped why=no-path, and the shell shows a banner
// "run agenthub pin-app" (decision 2026-11-07; the "bundle of the last connection" fallback is gone). The path is valid
// only if the bundle and the directories above it are ours and not writable by others (appBundleProblem in
// lib/platform.mjs; otherwise why=path-unsafe).
// Before launch, the bundle signature on disk is checked against requirements.app: the daemon does not launch a copy
// rebuilt without pinning (app-launch-skipped why=pin-mismatch), nor a bundle whose signature could not be verified
// (codesign did not finish within 15 s: why=verify-error).
//
// "Launch at login" (settings.json → launchAtLogin, written only by app; decision 2026-11-07) covers the daemon + app pair.
// When off, a daemon started at login does not launch the app and, if the app has not shown up within loginGraceMs,
// exits normally with code 0 (lib/app-supervisor.mjs, journal entry app-login-gate). A daemon started by the app
// (kickstart) sees its connection, process or event stream and stays. A start awaited by a hub update (fact
// hub.update.startVerdict) launches the app regardless of the setting.
// Exiting on the disabled setting assumes a LaunchAgent with KeepAlive {SuccessfulExit: false}. Under an old plist
// (KeepAlive true, before 2026-11-06) the daemon does not exit but logs a warning "reinstall the LaunchAgent: agenthub
// install --apply"; /state.launchAtLogin.launchAgent = "outdated", and the shell disables the toggle with that hint
// (fact app.launchAgent, lib/launchd.mjs launchAgentState).
//
// Settings: services.app in config.json:
//   supervise        — false: no supervision (default true); a disabled "Launch at login" still applies then;
//   loginGraceMs     — how long after start to wait for the app when "Launch at login" is off (30000);
//   restartDelayMs   — pause before checking after the app disappears and after the daemon starts (2000);
//   verifyMs         — how long after launch to check that the app is alive (15000);
//   maxRestarts, windowMs — at most 3 restarts after a crash within 10 min;
//   test.launchAgent — test mode only: a plist path instead of ~/Library/LaunchAgents/com.kensei.agenthub.plist
//                      (without it the LaunchAgent is not checked in test mode: null);
//   test.launch, test.processes — test mode only (non-default directory): a fake command instead of the
//                      real launch and a process table file instead of ps. In test mode the real
//                      app is never launched.

import { readJsonFile } from "../config.mjs";
import { requirementSha } from "../app-pin.mjs";
import { AppSupervisor, superviseOptions } from "../app-supervisor.mjs";
import { installPlan, launchAgentState } from "../launchd.mjs";
import { appBundleProblem, appControl, liveStateDir, samePath } from "../platform.mjs";

export const name = "app";

const running = new Map(); // ctx → { sup, off }

// A non-default directory (AGENTHUB_HOME pointing elsewhere) is a test copy: the real app is left alone.
// The default directory is computed from the same environment without AGENTHUB_HOME (on Windows and Linux it depends on LOCALAPPDATA and
// XDG_STATE_HOME).
export function isTestHome(home, { env = process.env, platform } = {}) {
  return Boolean(home) && !samePath(home, liveStateDir({ env, ...(platform ? { platform } : {}) }), platform ? { platform } : {});
}

export function pinnedPath(configPath, requirement) {
  if (!requirement) return { why: "no-pin" };
  let cfg = null;
  try {
    cfg = readJsonFile(configPath);
  } catch {}
  const m = cfg?.appPin;
  if (!m || typeof m !== "object" || m.requirementSha !== requirementSha(requirement) || typeof m.path !== "string") return { why: "no-path" };
  return { path: m.path };
}

// A daemon start awaited by a hub update (lib/hub-update/trial.mjs startupVerdict): a trial run of the new
// version and a return to the previous one. An interrupted build (interrupted) is not one: such a start is ordinary.
const UPDATE_STARTS = new Set(["confirm-wait", "finalize-failed", "restore"]);

// KeepAlive of the daemon job: the live hub uses the plist in ~/Library/LaunchAgents (read-only), a test hub uses test.launchAgent.
export function launchAgentOf(ctx, testMode) {
  if (process.platform !== "darwin" && !testMode) return null;
  const p = testMode ? ctx.config.services?.app?.test?.launchAgent : installPlan({ uid: 0 }).target;
  return typeof p === "string" && p ? launchAgentState(p) : null;
}

export async function start(ctx) {
  const opts = superviseOptions(ctx.config.services?.app);
  if (!opts.supervise) ctx.journal.write({ type: "app-supervise", on: false });
  const testMode = isTestHome(ctx.paths.home);
  const adapter = appControl({ testMode, test: ctx.config.services?.app?.test, pidPath: (pid) => ctx.facts.processPath?.(pid) ?? null });
  const pinned = () => {
    const requirement = ctx.config.requirements?.app ?? null;
    const p = pinnedPath(ctx.paths.config, requirement);
    if (!p.path) return p;
    const problem = appBundleProblem(p.path, { testMode });
    if (problem) return { why: problem };
    return { path: p.path, requirement };
  };
  const launchAgent = () => launchAgentOf(ctx, testMode);
  try {
    ctx.facts.provide("app.launchAgent", launchAgent);
  } catch {} // already present from a previous start in this core
  const sup = new AppSupervisor({
    adapter,
    pinned,
    connections: () => ctx.facts.appConnections?.() ?? [],
    stopping: () => Boolean(ctx.facts.stopping?.()),
    journal: (e) => ctx.journal.write(e),
    emit: (e) => ctx.emit(e),
    options: opts,
    launchAtLogin: () => ctx.settings.get("launchAtLogin") !== false,
    streams: () => Number(ctx.facts.eventStreams?.() ?? 0) || 0,
    expectApp: () => UPDATE_STARTS.has(ctx.facts.get("hub.update.startVerdict")),
    launchAgent,
    exit: (reason) => {
      // hub version switch: the daemon restarts on its own anyway
      if (ctx.lifecycle?.updating?.()) return;
      ctx.lifecycle?.stop?.(reason);
    },
  });
  const onPeer = (ev) => sup.onPeer(ev);
  ctx.on("app.peer", onPeer);
  running.set(ctx, { sup, off: () => ctx.off("app.peer", onPeer) });
  // without supervision there is no fact: the hub-update service then launches the new app itself (hasSupervisor)
  if (opts.supervise) {
    ctx.facts.provide("app.supervisor", () => sup);
    ctx.journal.write({ type: "app-supervise", on: true, testMode, launch: adapter.supported });
  }
  sup.start();
}

export async function stop(ctx) {
  const r = running.get(ctx);
  if (!r) return;
  running.delete(ctx);
  r.off();
  r.sup.stop();
}
