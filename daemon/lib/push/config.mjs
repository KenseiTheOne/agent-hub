// Push settings: services.push in <home>/config.json on top of the defaults.

import { parseHM, systemTimeZone, validTimeZone } from "./clock.mjs";

export const PUSH_DEFAULTS = Object.freeze({
  // IANA time zone; null — the system one.
  timezone: null,
  // Quiet hours while the human is away: only urgent banners show right away (quietException: what a plugin marked
  // quiet="true", the tampering signals), the rest are held and merged into one digest banner when they end.
  quietStart: "23:00",
  quietEnd: "08:00",
  // From this hour until quiet hours an evening blocker (hold="evening") is sent right away; during the day it waits for this hour.
  eveningAt: "21:00",
  // HID idle below the threshold — the human is at the Mac, above — away (quiet hours hold banners for the digest,
  // a waiting session's banner waits for the human to come back).
  idleThresholdMs: 10 * 60_000,
  // How long to wait for the shell to confirm it displayed the notification before showing a banner via osascript.
  ackTimeoutMs: 3000,
  // Accept POST /push/ack from the cli class (while the app build isn't pinned — requirements.app).
  acceptCliAck: false,
  tickMs: 30_000,
  // Raising the same key again within the window after it was cleared isn't sent (debounce).
  flapCooldownMs: 10 * 60_000,
  // After a restart: events that were active wait this long to be raised again, then count as cleared.
  staleGraceMs: 10 * 60_000,
  digestMaxItems: 30,
  // Limit of new notifications from one plugin per minute (trusted / third-party). Beyond the limit — a single
  // "notifications muted" notification, the remaining events are only remembered. Hub events (@hub) have no limit.
  maxPerPluginPerMin: 20,
  maxPerUntrustedPerMin: 5,
  // How many records (event keys) the engine keeps per plugin; beyond that the ones cleared longest ago are evicted.
  maxEntriesPerPlugin: 500,
  maxEntriesPerUntrusted: 100,
  // Overrides and additions to the event table: { "<name>": {label, hold, awayDelayMs, …} }.
  rules: {},
});

function num(v, d, min = 0) {
  return Number.isFinite(v) && v >= min ? v : d;
}

// Keys of services.push the service reads; anything else (for example a channel removed from the hub) is ignored —
// the push service writes one push-config-ignored line to the journal at startup (ignoredKeys).
export const PUSH_KEYS = Object.freeze([...Object.keys(PUSH_DEFAULTS), "enabled"]);
export function ignoredKeys(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw).filter((k) => !PUSH_KEYS.includes(k)).slice(0, 20);
}

export function resolvePushConfig(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const D = PUSH_DEFAULTS;
  const hm = (v, d) => parseHM(v) ?? parseHM(d);
  const tz = validTimeZone(r.timezone) ? r.timezone : systemTimeZone();
  return {
    timezone: tz,
    quietStart: hm(r.quietStart, D.quietStart),
    quietEnd: hm(r.quietEnd, D.quietEnd),
    eveningAt: hm(r.eveningAt, D.eveningAt),
    idleThresholdMs: num(r.idleThresholdMs, D.idleThresholdMs),
    ackTimeoutMs: num(r.ackTimeoutMs, D.ackTimeoutMs, 50),
    acceptCliAck: r.acceptCliAck === true,
    tickMs: num(r.tickMs, D.tickMs, 1000),
    flapCooldownMs: num(r.flapCooldownMs, D.flapCooldownMs),
    staleGraceMs: num(r.staleGraceMs, D.staleGraceMs),
    digestMaxItems: num(r.digestMaxItems, D.digestMaxItems, 1),
    maxPerPluginPerMin: num(r.maxPerPluginPerMin, D.maxPerPluginPerMin, 1),
    maxPerUntrustedPerMin: num(r.maxPerUntrustedPerMin, D.maxPerUntrustedPerMin, 1),
    maxEntriesPerPlugin: num(r.maxEntriesPerPlugin, D.maxEntriesPerPlugin, 10),
    maxEntriesPerUntrusted: num(r.maxEntriesPerUntrusted, D.maxEntriesPerUntrusted, 10),
    rules: r.rules && typeof r.rules === "object" ? r.rules : {},
  };
}
