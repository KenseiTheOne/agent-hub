// Background check for registry plugin updates.
//
// About 1 min after the daemon starts and then every 6 h (with jitter) the plugins service downloads the signed index
// the same way as the "Refresh catalog" button (PluginManager.fetchCatalog: https, size limit, minisign
// with the public key from the config, rollback protection). There is no other path to the network here. A network or signature error — backoff
// 5 min → 15 min → 1 h → 3 h (no longer than the interval), the daemon does not crash. Registry not connected — no network, a check
// every 15 min whether it has been connected.
//
// The result is a list of available updates for installed plugins (PluginManager.pluginUpdates: id, installed
// and new version, whether permissions grow and which ones). It installs nothing: an update goes only through the plugin
// manager with a permissions window (428), like an install.
//
// One notification per new plugin version: the plugins.update-available event (the push service turns it into
// "Update available: Mail 0.4.0" — the name from the catalog, as in the popover), and <home>/Registry/updates.json (0600, atomic)
// remembers which "id@version" have already been reported: later checks and daemon restarts do not repeat it.
// No notifications are sent before the first check after startup (the push service starts after the plugins service).
//
// Switch: config.json → services.plugins.checkUpdates = false (hard, for the config owner) and the setting
// "Check for plugin updates" in the shell (<home>/settings.json → checkPluginUpdates, written only by app,
// PUT /settings/plugin-updates). The check runs only if both are on. Off — no network, no
// notifications; the list from an already downloaded catalog (via the button in the manager) is still visible.
//
// Fine tuning (services.plugins.updateCheck): firstDelayMs (60000), intervalMs (6 h), jitterMs (30 min),
// backoffMs ([5 min, 15 min, 1 h, 3 h]). Outside test mode — no more often than once an hour and no earlier than 10 s after startup.
// At most 90 days; delays longer than the setTimeout limit (2^31−1 ms ≈ 24.8 days) are waited out in parts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../plugins.mjs";
import { msg } from "../i18n.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const UPDATE_DEFAULTS = Object.freeze({
  firstDelayMs: MIN,
  intervalMs: 6 * HOUR,
  jitterMs: 30 * MIN,
  backoffMs: [5 * MIN, 15 * MIN, HOUR, 3 * HOUR],
  unconfiguredMs: 15 * MIN,
});
const MAX_NOTIFIED = 500;
// Node runs a setTimeout with a delay above 2^31−1 ms after 1 ms: a long wait is done in parts.
export const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_DELAY_MS = 90 * 24 * HOUR;

// The check schedule from the config ({firstDelayMs, intervalMs, jitterMs, backoffMs, unconfiguredMs}) with lower
// bounds outside test mode. Shared by plugin and hub updates (lib/hub-update/checker.mjs).
export function resolveTiming(rawIn, { testMode = false } = {}) {
  const raw = rawIn && typeof rawIn === "object" ? rawIn : {};
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_DELAY_MS) : d);
  const t = {
    firstDelayMs: num(raw.firstDelayMs, UPDATE_DEFAULTS.firstDelayMs),
    intervalMs: num(raw.intervalMs, UPDATE_DEFAULTS.intervalMs),
    jitterMs: num(raw.jitterMs, UPDATE_DEFAULTS.jitterMs),
    backoffMs: Array.isArray(raw.backoffMs) && raw.backoffMs.length && raw.backoffMs.every((x) => Number.isFinite(x) && x >= 0) ? raw.backoffMs.map((x) => Math.min(x, MAX_DELAY_MS)) : UPDATE_DEFAULTS.backoffMs,
    unconfiguredMs: num(raw.unconfiguredMs, UPDATE_DEFAULTS.unconfiguredMs),
  };
  if (!testMode) {
    t.firstDelayMs = Math.max(10_000, t.firstDelayMs);
    t.intervalMs = Math.max(HOUR, t.intervalMs);
    t.backoffMs = t.backoffMs.map((x) => Math.max(MIN, x));
    t.unconfiguredMs = Math.max(MIN, t.unconfiguredMs);
  }
  return t;
}

export class UpdateChecker {
  // mgr — PluginManager; setting() — the setting from settings.json (true/false); emit(ev) — the bus;
  // random() — for jitter (tests replace it); testMode — removes the lower bounds of the intervals.
  constructor({ mgr, home, journal = null, emit = null, setting = () => true, random = Math.random, testMode = false, now = () => Date.now() }) {
    this.mgr = mgr;
    this.journal = journal;
    this.emitFn = emit;
    this.setting = setting;
    this.random = random;
    this.now = now;
    this.testMode = testMode;
    this.file = join(home, "Registry", "updates.json");
    this.timer = null;
    this.nextAt = null;
    this.running = null;
    this.stopped = false;
    this.armed = false; // the first check after startup has run: notifications are allowed
    this.failures = 0;
    this.lastError = null;
    this.lastFp = null;
    this.store = this.load();
  }

  // ---------- settings ----------
  timing() {
    return resolveTiming(this.mgr.opts.updateCheck, { testMode: this.testMode });
  }

  configAllows() {
    return this.mgr.opts.checkUpdates !== false;
  }
  settingAllows() {
    try {
      return this.setting() !== false;
    } catch {
      return true;
    }
  }
  enabled() {
    return this.configAllows() && this.settingAllows();
  }

  // ---------- updates.json ----------
  load() {
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8"));
      if (d && d.version === 1 && d.notified && typeof d.notified === "object" && !Array.isArray(d.notified)) {
        return { version: 1, notified: d.notified, checkedAt: typeof d.checkedAt === "string" ? d.checkedAt : null };
      }
    } catch {}
    return { version: 1, notified: {}, checkedAt: null };
  }
  save() {
    try {
      const keys = Object.keys(this.store.notified);
      if (keys.length > MAX_NOTIFIED) {
        // old entries first (by notification time)
        keys.sort((a, b) => String(this.store.notified[a]).localeCompare(String(this.store.notified[b])));
        for (const k of keys.slice(0, keys.length - MAX_NOTIFIED)) delete this.store.notified[k];
      }
      atomicWrite(this.file, JSON.stringify(this.store, null, 2) + "\n");
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.fileNotWritten", { file: "updates.json", why: e.code || e.message }) });
    }
  }

  log(entry) {
    try {
      this.journal?.write(entry);
    } catch {}
  }
  emit(ev) {
    try {
      this.emitFn?.(ev);
    } catch {}
  }

  // ---------- what goes into /state.pluginUpdates and the plugins.updates event ----------
  info() {
    let items = [];
    try {
      items = this.mgr.pluginUpdates();
    } catch {}
    return {
      enabled: this.enabled(),
      setting: this.settingAllows(),
      config: this.configAllows(),
      configured: this.mgr.configured(),
      checkedAt: this.store.checkedAt,
      nextCheckAt: this.enabled() && this.nextAt ? new Date(this.nextAt).toISOString() : null,
      // off — errors from previous checks are not shown
      error: this.enabled() ? this.lastError : null,
      items,
    };
  }

  // The update list changed (PluginManager.noteUpdates), a check ran, the check was turned on/off, or
  // the hub language changed (names and permissions in items are in it). The event is sent only if something changed, including the time
  // of the next check: the shell does not re-read /state by itself.
  changed() {
    const info = this.info();
    const fp = JSON.stringify(info);
    if (fp !== this.lastFp) {
      this.lastFp = fp;
      this.emit({ type: "plugins.updates", pluginUpdates: info });
    }
    this.notifyNew(info.items);
  }

  // One notification per new version: the reported "id@version" values are in updates.json.
  notifyNew(items) {
    if (!this.armed || !this.enabled() || this.stopped) return 0;
    let n = 0;
    for (const u of items) {
      const key = u.notifyKey || `${u.id}@${u.version}`;
      if (this.store.notified[key]) continue;
      this.store.notified[key] = new Date(this.now()).toISOString();
      n++;
      this.log({ type: "plugin-update-available", plugin: u.id, from: u.installed, version: u.version, permissionsGrow: u.permissionsGrow });
      this.emit({ type: "plugins.update-available", plugin: u.id, title: u.title || u.id, installed: u.installed, version: u.version, permissionsGrow: u.permissionsGrow });
    }
    if (n) this.save();
    return n;
  }

  // ---------- schedule ----------
  start() {
    this.stopped = false;
    this.reschedule("start");
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  jitter(ms) {
    const j = this.timing().jitterMs;
    return ms + Math.floor(Math.max(0, Math.min(1, this.random())) * j);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    if (this.stopped) return;
    this.nextAt = this.now() + Math.max(0, Number.isFinite(ms) ? ms : UPDATE_DEFAULTS.intervalMs);
    this.arm();
  }
  // A timer until nextAt, no longer than MAX_TIMER_MS: a long wait is several timers in a row.
  arm() {
    const left = Math.max(0, this.nextAt - this.now());
    const step = Math.min(left, MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.nextAt === null) return;
      if (this.nextAt - this.now() > 0 && step < left) return this.arm();
      this.nextAt = null;
      this.check("timer").catch(() => {});
    }, step);
    this.timer.unref?.();
  }

  // Start or a switch change: on — the first check after firstDelay (+ jitter within a minute),
  // off — no timer.
  reschedule(reason) {
    if (this.stopped) return;
    if (!this.enabled()) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextAt = null;
      // turned off in config.json (not by the setting) — occasionally, without network, check whether it was turned back on
      if (this.settingAllows()) this.schedule(this.timing().unconfiguredMs);
      return;
    }
    if (this.timer && reason !== "start" && reason !== "enabled") return;
    const t = this.timing();
    this.schedule(t.firstDelayMs + Math.floor(Math.max(0, Math.min(1, this.random())) * Math.min(t.jitterMs, MIN)));
  }

  // The switch changed (settings.changed or config.json): rebuild the timer and notify the shell.
  settingChanged() {
    if (this.enabled()) {
      if (!this.running) this.reschedule("enabled");
    } else {
      // off — the previous network error is irrelevant; when turned on, the backoff count starts over
      this.lastError = null;
      this.failures = 0;
      this.reschedule("disabled");
    }
    this.changed();
  }

  // One check. → { ok, error?, skipped? }. Never throws.
  async check(reason = "manual") {
    if (this.running) return this.running;
    this.running = (async () => {
      const t = this.timing();
      let res;
      if (!this.enabled()) {
        res = { ok: false, skipped: "disabled" };
        if (this.settingAllows()) this.schedule(t.unconfiguredMs);
      } else if (!this.mgr.configured()) {
        // the registry is not connected — we do not go to the network; check later whether it was connected
        res = { ok: false, skipped: "not-configured" };
        this.schedule(t.unconfiguredMs);
      } else {
        try {
          await this.mgr.fetchCatalog();
          res = { ok: true };
        } catch (e) {
          res = { ok: false, error: e?.code || "registry:fetch" };
        }
        const prevError = this.lastError;
        if (res.ok) {
          this.failures = 0;
          this.lastError = null;
          this.store.checkedAt = new Date(this.now()).toISOString();
          this.save();
          this.schedule(this.jitter(t.intervalMs));
        } else {
          this.failures++;
          this.lastError = res.error;
          const b = t.backoffMs[Math.min(this.failures - 1, t.backoffMs.length - 1)];
          this.schedule(Math.min(t.intervalMs, b + Math.floor(Math.max(0, Math.min(1, this.random())) * b * 0.1)));
        }
        if (prevError !== this.lastError || reason !== "timer") {
          this.log({ type: "registry-update-check", ok: res.ok, error: res.error || null, reason, failures: this.failures });
        }
      }
      this.armed = true;
      // the list and the error go to the shell; new versions as a notification (once)
      this.changed();
      return res;
    })();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }
}
