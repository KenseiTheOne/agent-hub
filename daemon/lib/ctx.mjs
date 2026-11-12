// Extension context — everything primitives, routes and services receive.
// The contract is described in docs/extension-points.md; it changes only together with that document.

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { t } from "./i18n.mjs";

// Runs an external program for primitives. In test mode (AGENTHUB_TEST_EXEC_LOG) it does not run it
// but appends {file,args} as a JSON line to the file and returns code 0.
export function makeExec(config) {
  return function exec(file, args = [], { timeoutMs = 15_000, cwd, env } = {}) {
    if (config.testExecLog) {
      appendFileSync(config.testExecLog, JSON.stringify({ file, args }) + "\n");
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, cwd, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(err && err.killed ? { timedOut: true } : {}) });
      });
    });
  };
}

// name — the extension name (for the log: the source field).
export function makeCtx(core, name) {
  const journal = {
    write: (entry) => core.journal.write({ source: name, ...entry }),
    tail: (n) => core.journal.tail(n),
  };
  return Object.freeze({
    name,
    config: core.config,
    paths: core.config.paths,
    journal,
    // Read-only: a snapshot of what GET /state returns.
    state: Object.freeze({
      snapshot: () => core.snapshot(),
      plugin: (id) => core.pluginState(id),
      plugins: () => core.pluginStates(),
      // Plugin event details (title, trust, error, push rules, title of the line with event=<key>) —
      // without copying the whole state; null — no such plugin.
      pluginEvent: (id, key) => core.pluginEventInfo(id, key),
      worstStatus: () => core.worstStatus(),
      // For the "can it be shut down" verdict: [{id, title, tier, status, activity, needsOn}] — without copying frames.
      pluginSignals: () => core.pluginSignals(),
    }),
    peer: Object.freeze({
      verifySigned: (pid, requirementName) => core.peer.verifySigned(pid, requirementName),
      classifyPid: (pid) => core.peer.classifyPid(pid),
      verifyHookSession: (peerInfo, sessionId) => core.peer.verifyHookSession(peerInfo, sessionId),
      interactiveProcess: (pid) => (core.peer.interactiveProcess ? core.peer.interactiveProcess(pid) : { ok: false, reason: "no-check" }),
      // Whether the process is stopped and in its terminal's foreground group (typing into the tab, contract 3).
      // → { stopped, foreground } | null (cannot tell)
      procState: (pid) => core.peer.sys?.procState?.(pid) ?? null,
    }),
    facts: core.facts,
    sessions: core.sessions,
    // An event on the shared bus: goes to ctx.on subscribers and to SSE GET /events.
    emit: (event) => core.emit({ source: name, ...event }),
    on: (type, fn) => core.on(type, fn),
    off: (type, fn) => core.off(type, fn),
    estop: () => core.estop(),
    // The effective UI language (ru | en, lib/i18n.mjs) and a core message translated into it.
    lang: () => core.lang(),
    t: (key, params) => t(core.lang(), key, params),
    // Shell settings (<home>/settings.json, lib/i18n.mjs Settings) — read-only: lang, checkPluginUpdates,
    // checkHubUpdates, launchAtLogin.
    // Only the app class writes them (PUT /settings/*); a change emits settings.changed.
    settings: Object.freeze({ get: (key) => core.settings.get(key) }),
    exec: core.exec,
    // NDJSON into stdin for streamable plugins (inbound from the hook etc.).
    sendToPlugin: (pluginId, obj) => core.host.send(pluginId, obj),
    refreshPlugin: (pluginId, reason = "Manual") => core.host.refresh(pluginId, reason),
    // Restart a plugin with a fresh environment (G8: a secret was written): streamable — stop and start again, standard — an
    // extra run. reason — AGENTHUB_REFRESH_REASON ([A-Z][A-Za-z]{1,31}, e.g. "SecretChanged"). → Promise<boolean>
    restartPlugin: (pluginId, reason = "Manual") => core.restartPlugin(pluginId, reason),
    // Stop a background job (G6; the job.cancel primitive). → { ok, error? }
    cancelJob: (jobId, requester = null) => core.cancelJob(jobId, requester),
    // Rescan the plugin directories now (after install/removal/blocklist) and re-evaluate the policy
    // of plugins already running. → Promise.
    rescanPlugins: () => core.host.rescan(),
    onHook: (handler) => core.onHook(handler),
    registerSecretsProvider: (fn) => core.setSecretsProvider(fn),
    // An environment variable for trusted plugins (builtin, official and own) — a service cache path etc.; null — remove.
    // Name — AGENTHUB_<NAME> (not AGENTHUB_SECRET_* and not those taken by the core). The values are not secrets: plugins'
    // environment gets only what is fine to show under "Permissions".
    providePluginEnv: (name, value) => core.setPluginEnv(name, value),
    setPluginPolicy: (fn) => core.setPluginPolicy(fn),
    invoke: (req) => core.invoke(req),
    // Daemon lifecycle for the hub update service (lib/services/hub-update.mjs, docs/hub-updates.md): start
    // a switch (app supervision does not interfere, /shutdown does not stop it), cancel it, restart
    // (exit with code 75 — launchd brings the daemon back up from Versions/current), re-read the pin now.
    lifecycle: Object.freeze({
      begin: () => core.beginUpdate(),
      abort: () => core.abortUpdate(),
      restart: () => core.runShutdown("update"),
      // stop normally with code 0 (app service: "Launch at login" is off and the app never showed up)
      stop: (reason) => core.runShutdown(reason),
      checkPin: () => core.appPin?.check("hub-update"),
      appConnections: () => core.appConnections(),
      updating: () => core.updating,
      // the daemon is stopping normally (SIGTERM, /shutdown): do not start a version switch
      shuttingDown: () => core.shuttingDown === true,
    }),
  });
}
