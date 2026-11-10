// Switching the live installation to a built version and rolling back (docs/hub-updates.md §3, steps 5–8, and §4).
// Files only: the pin (config.json → requirements.app, appPin), the Versions/current and previous pointers,
// the copy of built-in plugins <home>/Builtin. Restarting the daemon and the app is the caller's job (update service,
// watchdog, CLI).
//
// Each step is atomic by itself (tmp + rename). Order: pin → pointer → built-in plugins. A step failure
// rolls back the steps already done (restoreFiles) using the prev snapshot taken before the first step.

import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { readJsonFile } from "../config.mjs";
import { dirname } from "node:path";
import { requirementSha, writeAppRequirement } from "../app-pin.mjs";
import { msg } from "../i18n.mjs";
import { pointConfigAtCopy, syncBuiltin } from "../builtin-copy.mjs";
import { ensureDir, currentLabel, hubPaths, previousLabel, readBuild, setLink, versionApp, versionPlugins } from "./layout.mjs";

function readConfig(configPath) {
  if (!existsSync(configPath)) return {};
  return readJsonFile(configPath);
}

function writeConfig(configPath, cfg) {
  ensureDir(dirname(configPath));
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
}

// The snapshot was taken by capturePrev() (all fields present). An empty or foreign object isn't a snapshot: rolling back with it would wipe
// the pin and the pointers ("there was nothing"), so restoreFiles doesn't apply it.
export function isSnapshot(prev) {
  return Boolean(prev) && typeof prev === "object" && !Array.isArray(prev) && ["requirement", "appPin", "current", "previous"].every((k) => Object.prototype.hasOwnProperty.call(prev, k));
}

// What was there before the switch — exactly what a rollback restores.
export function capturePrev(home, configPath = hubPaths(home).config) {
  const cfg = readConfig(configPath);
  return {
    requirement: typeof cfg.requirements?.app === "string" ? cfg.requirements.app : null,
    appPin: cfg.appPin && typeof cfg.appPin === "object" ? cfg.appPin : null,
    builtinPluginsDir: typeof cfg.builtinPluginsDir === "string" ? cfg.builtinPluginsDir : null,
    current: currentLabel(home),
    previous: previousLabel(home),
  };
}

// Pinning the new build: a cdhash requirement and the bundle path in Versions/<label> (supervision launches it).
export function pinVersion(home, label, build, { configPath = hubPaths(home).config, by = "agenthub hub-update", under = "hub" } = {}) {
  if (!build?.requirement || requirementSha(build.requirement) === null) throw Object.assign(new Error(msg("hub.detail.noRequirement")), { code: "hub-update:verify-failed" });
  return writeAppRequirement(configPath, build.requirement, { by, under, cdhash: build.cdhash, path: versionApp(home, label), version: label });
}

// Switch: pin, current → label (previous → the old current), built-in plugins from the version.
// prev — the capturePrev() snapshot. On failure — roll back what was done and throw with a code (hub-update:switch-failed).
// steps(s) — notification about a step (pin, link, builtin).
export function applySwitch({ home, label, build = readBuild(home, label), prev, configPath = hubPaths(home).config, onStep = () => {}, by, under } = {}) {
  if (!build) throw Object.assign(new Error(msg("hub.detail.noBuild", { label })), { code: "hub-update:unknown-version" });
  const p = hubPaths(home);
  const done = [];
  try {
    onStep("pin");
    pinVersion(home, label, build, { configPath, ...(by ? { by } : {}), ...(under ? { under } : {}) });
    done.push("pin");
    onStep("link");
    if (prev.current && prev.current !== label) setLink(p.previous, prev.current);
    setLink(p.current, label);
    done.push("link");
    onStep("builtin");
    const r = syncBuiltin({ src: versionPlugins(home, label), home });
    pointConfigAtCopy(configPath, r.dest);
    done.push("builtin");
    return { done };
  } catch (e) {
    const restore = restoreFiles({ home, prev, configPath });
    throw Object.assign(new Error(msg("hub.detail.switch", { label, why: e.message })), { code: "hub-update:switch-failed", step: ["pin", "link", "builtin"][done.length], restore });
  }
}

// Restore files to the prev snapshot. Steps are independent: a failure of one goes to errors, the rest run. Not a snapshot
// (isSnapshot) — touch nothing: { ok: false, skipped: true }. The pin is restored with the same requirement and
// path, but appPin.by = by ("agenthub hub-update rollback"): the app-requirement-changed log entry says who restored it.
// → { ok, errors: [{step, message}], skipped? }
export function restoreFiles({ home, prev, configPath = hubPaths(home).config, by = "agenthub hub-update rollback" }) {
  if (!isSnapshot(prev)) return { ok: false, skipped: true, errors: [{ step: "snapshot", message: msg("hub.detail.noSnapshot") }] };
  const p = hubPaths(home);
  const errors = [];
  try {
    const cfg = readConfig(configPath);
    cfg.requirements = { ...(cfg.requirements || {}) };
    const same = cfg.requirements.app === prev.requirement;
    if (prev.requirement) cfg.requirements.app = prev.requirement;
    else delete cfg.requirements.app;
    if (prev.appPin) cfg.appPin = same || !by ? prev.appPin : { ...prev.appPin, by, under: "hub", pinnedAt: new Date().toISOString() };
    else delete cfg.appPin;
    if (prev.builtinPluginsDir) cfg.builtinPluginsDir = prev.builtinPluginsDir;
    writeConfig(configPath, cfg);
  } catch (e) {
    errors.push({ step: "pin", message: e.message });
  }
  try {
    if (prev.current) setLink(p.current, prev.current);
    else setLink(p.current, null);
    if (prev.previous) setLink(p.previous, prev.previous);
    else setLink(p.previous, null);
  } catch (e) {
    errors.push({ step: "link", message: e.message });
  }
  try {
    if (prev.current && existsSync(versionPlugins(home, prev.current))) syncBuiltin({ src: versionPlugins(home, prev.current), home });
  } catch (e) {
    errors.push({ step: "builtin", message: e.message });
  }
  return { ok: errors.length === 0, errors };
}
