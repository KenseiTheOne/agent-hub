// Pinning the AgentHub.app build: requirements.app in the daemon's config.json and watching for its changes.
//
// By default (decision 2026-11-05) the app is signed ad hoc, and the daemon recognizes the app class by the cdhash of a specific
// build: requirements.app = `identifier "com.kensei.agenthub" and cdhash H"<cdhash>"`. scripts/bundle.sh calls
// `agenthub pin-app <AgentHub.app>` after every build, and exactly one build is valid: the previous one after
// re-pinning gets 403 peer:app-signature. The "AgentHub Local Signing" certificate (`bundle.sh --cert`) is
// an optional mode for those who don't want to re-pin after every build.
//
// Why cdhash is no worse than a certificate against an agent with the same UID: the requirement lives in config.json (0600, same
// UID), and the daemon code in ~/Projects; such an agent can rewrite both. A separate keychain with a password protected
// only the key, not the config. Both work against curl and foreign processes. So this isn't a protection but a tripwire:
// the daemon logs every requirement change (old and new fingerprint, who — per the writer) and
// raises the hub event `@hub:app-pin-changed` (notification), and the shell shows the time of the last
// pin. If an agent re-pins, the human will see it. An agent can suppress that too (by rewriting the daemon) — the limit
// is the same as in design §3: only Touch ID closes it fully.
//
// Picked up without a restart: fs.watch on the state directory, polling every pollMs and a check before every
// app classification (peer.setBeforeAppCheck) — by the file signature (ino, size, mtime, ctime), without parsing if
// the file didn't change. A change → config.requirements.app, app verdict caches reset (peer.forget), generation bump
// (the server closes connections of previous builds), a log entry, the `app-pin.changed` event on the bus and SSE.
// The last seen requirement is in <home>/app-pin.json (0600): a change made while the daemon was down
// is noticed at startup (source=start).
//
// appPin.path is tracked the same way — the bundle the daemon launches at startup and after a crash (app service).
// Its change under the same requirement (`agenthub pin-app <a build copy in another directory>`) — an
// app-pin-path-changed entry (also in the audit log) and the `app-pin.path-changed` event (push), like a pin change.
//
// The cdhash of the build on disk is read by lib/app-sign.mjs (codesign — macOS only); here is the cross-platform part.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { fileSig, readJsonFile } from "./config.mjs";
import { dirname, join } from "node:path";
import { msg } from "./i18n.mjs";

export const APP_BUNDLE_ID = "com.kensei.agenthub";
const HEX40 = /^[0-9a-f]{40}$/;

const sha = (s) => createHash("sha256").update(s).digest("hex");
export const requirementSha = (req) => (typeof req === "string" && req ? sha(req).slice(0, 32) : null);

// The requirement "exactly this build".
export function cdhashRequirement(cdhash) {
  const h = String(cdhash || "").toLowerCase();
  if (!HEX40.test(h)) throw new Error(msg("err.cdhash"));
  return `identifier "${APP_BUNDLE_ID}" and cdhash H"${h}"`;
}

// Requirement fingerprint for the log and the shell. Canonical forms are cdhash:<hex> and cert:<sha1>; any other
// string — req:<sha256/16> (the change is then caught by full string comparison, not the fingerprint).
export function pinFingerprint(req) {
  if (typeof req !== "string" || !req.trim()) return { kind: "none", value: null, label: "none" };
  const cd = /^identifier "com\.kensei\.agenthub" and cdhash H"([0-9a-f]{40})"$/.exec(req);
  if (cd) return { kind: "cdhash", value: cd[1], label: `cdhash:${cd[1]}` };
  const cert = /^identifier "com\.kensei\.agenthub" and certificate leaf = H"([0-9a-f]{40})"$/.exec(req);
  if (cert) return { kind: "cert", value: cert[1], label: `cert:${cert[1]}` };
  const v = sha(req).slice(0, 16);
  return { kind: "other", value: v, label: `req:${v}` };
}

// Write requirements.app (and pin info — appPin) to config.json: a 0600 temp file + rename,
// other config fields are untouched. A broken config.json isn't overwritten.
export function writeAppRequirement(configPath, requirement, meta = {}) {
  let cfg = {};
  if (existsSync(configPath)) {
    try {
      cfg = readJsonFile(configPath);
    } catch (e) {
      throw new Error(msg("err.config.parseKeep", { why: e.message }));
    }
  }
  const old = cfg.requirements?.app ?? null;
  cfg.requirements = { ...(cfg.requirements || {}), app: requirement };
  cfg.appPin = { pinnedAt: new Date().toISOString(), requirementSha: requirementSha(requirement), ...meta };
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return { old, requirement };
}

// Add the build path (appPin.path) to an already active pin — without changing requirements.app or the pin
// time. → true if written (appPin belongs to this requirement or there was none).
export function writeAppPinPath(configPath, requirement, path) {
  let cfg;
  try {
    cfg = readJsonFile(configPath);
  } catch (e) {
    throw new Error(msg("err.config.parseKeep", { why: e.message }));
  }
  if (cfg.requirements?.app !== requirement) return false;
  const m = cfg.appPin && typeof cfg.appPin === "object" ? cfg.appPin : null;
  if (m && m.requirementSha !== requirementSha(requirement)) return false;
  cfg.appPin = { ...(m || { requirementSha: requirementSha(requirement) }), path };
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
  return true;
}

export class AppPinWatcher {
  constructor({ config, peer, journal, emit, pollMs = 5000, now = () => new Date() }) {
    this.config = config;
    this.peer = peer;
    this.journal = journal;
    this.emit = emit;
    this.pollMs = pollMs;
    this.now = now;
    this.configPath = config.paths.config;
    this.statePath = join(config.paths.home, "app-pin.json");
    this.sig = null;
    this.ready = true; // start() resets until reconcile()
    this.state = null; // { requirementSha, fingerprint, kind, changedAt, by, under, source }
    this.watcher = null;
    this.timer = null;
  }

  // The file signature isn't remembered here: requirements.app in memory was read back in loadConfig(), and the file may
  // have changed before this point. reconcile() (after services start — otherwise the push service wouldn't hear the event)
  // re-reads config.json itself; until then check() does nothing.
  start() {
    this.sig = null;
    this.ready = false;
    try {
      const s = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (s && typeof s === "object") this.state = s;
    } catch {}
    try {
      this.watcher = watch(this.config.paths.home, { persistent: false }, (_e, name) => {
        const n = String(name || "");
        if (!n || n === "config.json" || n.startsWith("config.json.tmp")) this.check("watch");
      });
      this.watcher.on?.("error", () => {});
    } catch {}
    this.timer = setInterval(() => this.check("poll"), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    clearInterval(this.timer);
    this.timer = null;
  }

  current() {
    const r = this.config.requirements?.app;
    return typeof r === "string" && r.trim() ? r : null;
  }

  // Compare the active requirement with the last seen one (app-pin.json). First run without a requirement — silently.
  reconcile(source = "start") {
    // The file changed after loadConfig() (the signature differs from load time) — requirements.app from the file as it is
    // now: otherwise a change between them would be lost (the signature would already match and check() wouldn't see it).
    // A broken file — what was read earlier stays, the signature isn't remembered, the next check() re-reads.
    const sig = fileSig(this.configPath);
    let fileCfg = null;
    if (this.config.configLoadedSig === undefined || sig === this.config.configLoadedSig) this.sig = sig; // unchanged (or the config wasn't built by loadConfig)
    else if (sig === "absent") fileCfg = {};
    else {
      try {
        fileCfg = readJsonFile(this.configPath);
      } catch {}
    }
    if (fileCfg) {
      this.sig = sig;
      const raw = fileCfg?.requirements?.app;
      const next = typeof raw === "string" && raw.trim() ? raw : null;
      if (next !== this.current()) {
        this.config.requirements = { ...(this.config.requirements || {}), app: next };
        this.peer?.forget?.("app");
      }
    }
    this.ready = true;
    const cur = this.current();
    const curSha = requirementSha(cur);
    if (this.state && this.state.requirementSha === curSha) {
      this.reconcilePath(fileCfg, source);
      return false;
    }
    if (!this.state && cur === null) {
      this.saveState({ requirementSha: null, ...this.fpFields(null), changedAt: null, by: null, under: null, source });
      return false;
    }
    const oldFp = this.state ? { label: this.state.fingerprint ?? "none" } : { label: "unknown" };
    this.record(oldFp, cur, this.readMeta(cur), source);
    return true;
  }

  // Re-read config.json if the file changed. → true if requirements.app changed.
  check(source = "check") {
    if (this.ready === false) return false; // before reconcile() — that's its job
    const sig = fileSig(this.configPath);
    if (sig === this.sig) return false;
    let fileCfg = {};
    if (sig !== "absent") {
      try {
        fileCfg = readJsonFile(this.configPath);
      } catch {
        // the file is being written right now or is broken: leave the requirement alone, the next check reads it again
        return false;
      }
    }
    this.sig = sig;
    const raw = fileCfg?.requirements?.app;
    const next = typeof raw === "string" && raw.trim() ? raw : null;
    const old = this.current();
    if (next === old) {
      this.reconcilePath(fileCfg, source);
      return false;
    }
    this.config.requirements = { ...(this.config.requirements || {}), app: next };
    this.peer?.forget?.("app");
    this.record(pinFingerprint(old), next, this.metaFrom(fileCfg, next), source);
    return true;
  }

  // appPin.path from config.json — only if the record belongs to this requirement.
  pathFrom(fileCfg, req) {
    const m = fileCfg?.appPin;
    if (!req || !m || typeof m !== "object" || m.requirementSha !== requirementSha(req) || typeof m.path !== "string" || !m.path) return null;
    return m.path.slice(0, 1024);
  }

  // The pinned build path changed under the same requirement — log (and audit), an event for push and the shell.
  // State predating 2026-11-06 has no path field: the first seen path is logged without a notification.
  reconcilePath(fileCfg, source) {
    if (!this.state) return;
    let cfg = fileCfg;
    if (!cfg) {
      try {
        cfg = readJsonFile(this.configPath);
      } catch {
        return;
      }
    }
    const next = this.pathFrom(cfg, this.current());
    const known = Object.prototype.hasOwnProperty.call(this.state, "path");
    const old = known ? (this.state.path ?? null) : null;
    if (known && old === next) return;
    this.saveState({ ...this.state, path: next });
    if (!known && next === null) return;
    this.journal?.write({ type: "app-pin-path-changed", old, new: next, source });
    if (known) this.emit?.({ type: "app-pin.path-changed", appPin: this.info(), old });
  }

  // Pin info from config.json (written by `agenthub pin-app`) — only if it's about this very requirement:
  // otherwise someone changed requirements.app bypassing pin-app (by = "manual"). by — the writer's code or command
  // ("agenthub pin-app", "manual", "unknown"), the human-readable text is built by the shell and push in their language.
  metaFrom(fileCfg, req) {
    const m = fileCfg?.appPin;
    if (!m || typeof m !== "object" || m.requirementSha !== requirementSha(req)) return { by: "manual", under: null, pinnedAt: null, path: null };
    return {
      by: typeof m.by === "string" ? m.by.slice(0, 80) : "unknown",
      under: typeof m.under === "string" ? m.under.slice(0, 40) : null,
      pinnedAt: typeof m.pinnedAt === "string" ? m.pinnedAt.slice(0, 40) : null,
      path: this.pathFrom(fileCfg, req),
    };
  }
  readMeta(req) {
    try {
      return this.metaFrom(readJsonFile(this.configPath), req);
    } catch {
      return this.metaFrom({}, req);
    }
  }

  fpFields(req) {
    const fp = pinFingerprint(req);
    return { fingerprint: fp.label, kind: fp.kind };
  }

  record(oldFp, next, meta, source) {
    const at = this.now().toISOString();
    const fp = pinFingerprint(next);
    this.saveState({ requirementSha: requirementSha(next), fingerprint: fp.label, kind: fp.kind, old: oldFp.label, changedAt: at, by: meta.by, under: meta.under, pinnedAt: meta.pinnedAt, path: meta.path ?? null, source });
    this.journal?.write({
      type: "app-requirement-changed",
      old: oldFp.label,
      new: fp.label,
      by: meta.by,
      under: meta.under,
      pinnedAt: meta.pinnedAt,
      path: meta.path ?? null,
      source,
    });
    this.emit?.({ type: "app-pin.changed", appPin: this.info(), old: oldFp.label });
  }

  saveState(s) {
    this.state = s;
    try {
      const tmp = `${this.statePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(s) + "\n", { mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch {}
  }

  // For the /state snapshot and the shell: what is pinned and when this requirement appeared.
  info() {
    const cur = this.current();
    const fp = pinFingerprint(cur);
    const s = this.state && this.state.requirementSha === requirementSha(cur) ? this.state : null;
    return {
      kind: fp.kind,
      fingerprint: fp.label,
      changedAt: s?.changedAt ?? null,
      by: s?.by ?? null,
      under: s?.under ?? null,
      source: s?.source ?? null,
      // fingerprint before this change: "none" — the first pin, "unknown" — the daemon doesn't remember what it was; null — the change
      // was recorded before 2026-11-05 (the field didn't exist yet)
      old: s?.old ?? null,
      // the bundle the daemon launches (appPin.path); null — no path (--cert mode, a record from before 2026-11-06)
      path: s?.path ?? null,
      generation: this.peer?.appGeneration?.() ?? 0,
    };
  }
}
