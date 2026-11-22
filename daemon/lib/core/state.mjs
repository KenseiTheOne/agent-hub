// Core part: assembling GET /state (snapshot) — the core's own keys in their fixed order, the sections services supply
// (ctx.provideState), where the hub lives (hubInfo) and the terminal adapters (terminalsInfo).
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { join } from "node:path";
import { DAEMON_DIR, REPO_DIR } from "../config.mjs";
import { CONTRACT_VERSION } from "../meta.mjs";
import { SEVERITY } from "../output.mjs";
import { liveStateDir, samePath } from "../platform.mjs";
import { terminalsInfo } from "../terminals/index.mjs";
import { msg } from "../i18n.mjs";
import { VERSION } from "../version.mjs";

// GET /state sections that services supply (ctx.provideState, Core.snapshot). A name is a JSON key of /state.
const STATE_SECTION_RE = /^[a-z][A-Za-z0-9]{0,39}$/;
// The core's own keys of /state — a service cannot provide them.
const CORE_STATE_KEYS = new Set(["version", "contract", "now", "pid", "estop", "status", "waitingSessions", "severity", "plugins", "sessions", "externalSessions", "primitives", "appPin", "lang", "hub", "terminals", "extensions", "damagedFiles", "limits", "hook", "builtinPlugins", "heldPlugins", "peer", "seq"]);
// Slots with a fixed place among the core's keys (clients decode /state by these names): null until a service fills one.
export const SERVICE_STATE_SLOTS = new Set(["pluginUpdates", "ownPlugins", "registryKeys", "hubUpdate", "idle", "connections", "bridge"]);
// Setting sections the core builds; a service adds its own fields to them (they show in GET /settings too).
const EXTENSIBLE_STATE = new Set(["launchAtLogin", "notifications"]);

export class CoreState {
  // A service's own part of GET /state (ctx.provideState). name — a section of /state: one of the service slots of the
  // layout (SERVICE_STATE_SLOTS, null without their service), a setting section the core builds (EXTENSIBLE_STATE: fn adds
  // fields to it) or a new section (appended after the core's). fn() → JSON-ready value; fn null — remove. owner — the
  // extension name (ctx.name): a section stays with whoever provided it first, a second start of the same service replaces
  // its own. The core's own keys cannot be taken.
  provideState(name, fn, owner = "core") {
    if (typeof name !== "string" || !STATE_SECTION_RE.test(name) || CORE_STATE_KEYS.has(name)) throw new Error(msg("err.state.name", { name: String(name).slice(0, 60) }));
    const cur = this.stateProviders.get(name);
    if (cur && cur.owner !== owner) throw new Error(msg("err.state.taken", { name, owner: cur.owner }));
    if (fn === null || fn === undefined) this.stateProviders.delete(name);
    else if (typeof fn !== "function") throw new Error(msg("err.state.name", { name }));
    else this.stateProviders.set(name, { fn, owner });
  }
  // → what the provider of a /state section returns; null — no provider (no such service), nothing to show, or it failed
  // (one broken service does not take GET /state down).
  statePart(name) {
    const p = this.stateProviders.get(name);
    if (!p) return null;
    try {
      return p.fn() ?? null;
    } catch {
      return null;
    }
  }
  // → the fields a service adds to a setting section the core builds; {} — none.
  stateFields(name) {
    const v = this.statePart(name);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  // → sections outside the fixed layout (a service's own new section), in the order they were provided.
  extraState() {
    const out = {};
    for (const name of this.stateProviders.keys()) {
      if (SERVICE_STATE_SLOTS.has(name) || EXTENSIBLE_STATE.has(name)) continue;
      out[name] = this.statePart(name);
    }
    return out;
  }

  // ---------- snapshot ----------
  // Where the hub lives: the state directory, whether it is a test one (not the default directory — AGENTHUB_HOME or --home
  // in the shell) and where builtin plugins come from: a copy in <home>/Builtin (agenthub install --apply / builtin update),
  // the repository working tree or a custom path. The shell draws a "TEST" badge based on testMode.
  hubInfo() {
    const home = this.config.paths?.home || null;
    const dir = this.config.builtinPluginsDir || null;
    const builtin = !dir ? null : samePath(dir, home && join(home, "Builtin")) ? "copy" : samePath(dir, join(REPO_DIR, "plugins")) ? "repo" : "custom";
    // cli — full path to this daemon's CLI: the shell shows commands with it (agenthub pin-app — the "build path
    // not recorded" banner)
    return { home, testMode: Boolean(home) && !samePath(home, liveStateDir()), builtinDir: dir, builtin, cli: join(DAEMON_DIR, "bin", "agenthub") };
  }
  // Settings → Terminal: the terminal adapters, what each supports, whether it can run now, where a new session opens
  // (lib/terminals/index.mjs terminalsInfo). services.terminal.launch — an adapter id or "auto".
  terminalsInfo(sessions = this.sessionList()) {
    try {
      const prefer = this.config.services?.terminal?.launch;
      return terminalsInfo(this.facts, { prefer: typeof prefer === "string" && prefer ? prefer : "auto", sessions });
    } catch {
      return null;
    }
  }
  snapshot(peerInfo = null) {
    const sessions = this.sessionList();
    return {
      version: VERSION,
      // plugin contract version this core understands (lib/meta.mjs CONTRACT_VERSION)
      contract: CONTRACT_VERSION,
      now: new Date().toISOString(),
      pid: process.pid,
      estop: this.estop(),
      status: this.worstStatus(),
      waitingSessions: this.waitingCount(),
      severity: SEVERITY,
      plugins: this.pluginStates(),
      sessions,
      // Non-Claude agent sessions (G13, kind "external"): a separate list so Claude session consumers see no change; only
      // session.focus works for them. Updated by the sessions.external event.
      externalSessions: (this.sweepExternal(), this.externalSessionList()),
      primitives: [...this.primitives.values()].map((p) => ({ name: p.name, level: p.level, remoteAllowed: p.remoteAllowed, appOnly: p.appOnly, safeUnderEstop: p.safeUnderEstop, ...(p.aliasOf ? { aliasOf: p.aliasOf, deprecated: true } : {}) })),
      appPin: this.appPin ? this.appPin.info() : null,
      lang: this.langInfo(),
      // Service slots (SERVICE_STATE_SLOTS): each is filled by the service that owns it (ctx.provideState) and is null without
      // it. Their place among the core's keys is part of what clients decode, so it is fixed here; what is inside is
      // described where it is built and in docs/api.md.
      pluginUpdates: this.statePart("pluginUpdates"),
      ownPlugins: this.statePart("ownPlugins"),
      registryKeys: this.statePart("registryKeys"),
      hubUpdate: this.statePart("hubUpdate"),
      launchAtLogin: this.launchAtLoginSetting(),
      // "Settings → Notifications": switches, quiet hours, security exceptions (notificationsSetting).
      notifications: this.notificationsSetting(),
      idle: this.statePart("idle"),
      connections: this.statePart("connections"),
      hub: this.hubInfo(),
      bridge: this.statePart("bridge"),
      terminals: this.terminalsInfo(sessions),
      // External daemon extensions (G4, lib/extensions.mjs): {dir, enabled, testAutoApprove, consent, pending, items: [{path, file,
      // kind, name, sha256, size, mtime, status, loaded, restartRequired, approvedSha256, error, errorText}]}; null — before init.
      extensions: this.extensions ? this.extensions.info(this.lang()) : null,
      // State files this daemon found damaged when it started and went on without (noteDamaged): [{file, backup, detail, at}],
      // file and backup — names inside the state directory (backup — the kept copy, <file>.bad, or null). Empty — all read fine.
      // A damaged config.json means the daemon runs on the defaults with the app class, extensions and the terminal bridge
      // closed (lib/config.mjs failClosed) until the file is fixed and the daemon restarted.
      damagedFiles: this.damagedFiles.map((d) => ({ ...d })),
      // Limits the shell shows next to what it starts: actionTimeoutMs — how long one plugin action may run before the hub
      // kills it (config.json → plugins.actionTimeoutMs).
      limits: { actionTimeoutMs: this.config.plugins.actionTimeoutMs },
      // The agent hook (Claude Code, Codex) as this hub sees it (lib/hook/seen.mjs): {installed, lastEventAt, reason?, installCommand} —
      // installed means a verified hook event has reached this hub (the last one at lastEventAt); the hub does not read
      // Claude Code's settings. installCommand — the command that installs the hook.
      hook: this.hookSeen.info(),
      // Built-ins with their switch (settings.json → builtinOff) and requirements: [{id, title, desc, version, icon, enabled,
      // running, held, requires: [{name, url, note, check, present}]}] — the Plugins page lists them even when off or held.
      builtinPlugins: this.builtinPluginList(),
      // Plugins of any source found but not run: turned off (built-ins) or a declared requirement missing —
      // [{id, source, reason: "off" | "requires", requires}]. Event plugins.held when the set changes.
      heldPlugins: this.heldPluginList(),
      // sections services added on their own (ctx.provideState with a new name)
      ...this.extraState(),
      ...(peerInfo ? { peer: { class: peerInfo.class, reason: peerInfo.reason || null } } : {}),
      seq: this.seq,
    };
  }
}
