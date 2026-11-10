// Local time for push: quiet hours, the evening window, the "night's day".
//
// Everything is computed in the given time zone (IANA, e.g. "Europe/Belgrade") via Intl, not via the
// process's local zone: the daemon under launchd and the tests must see the same thing. DST transitions
// are handled by themselves: hours and minutes are taken from the zone's wall-clock time for the given moment.

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function validTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

// Moment (ms) → the zone's wall-clock time: {y, mo, d, h, mi, minutes, date: "YYYY-MM-DD"}.
export function localParts(ms, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour) % 24;
  const mi = Number(parts.minute);
  return { y, mo, d, h, mi, minutes: h * 60 + mi, date: `${parts.year}-${parts.month}-${parts.day}` };
}

// "23:00" → 1380. Invalid string → null.
export function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Whether a minute of the day falls into the window [start, end); the window may cross midnight.
export function inWindow(minutes, start, end) {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// The calendar day a moment belongs to, if the day starts at dayStart (minutes).
// With dayStart = 08:00, Thursday 01:30 belongs to Wednesday: it's "the same night" as Wednesday 21:00.
export function dayBucket(ms, tz, dayStart) {
  const p = localParts(ms, tz);
  if (p.minutes >= dayStart) return p.date;
  const prev = new Date(Date.UTC(p.y, p.mo - 1, p.d - 1));
  return prev.toISOString().slice(0, 10);
}

// A clock bound to the zone and push settings. now is a time double in tests.
// quietOn: false — quiet hours are turned off in Settings (isQuiet is always false; the evening window and the "night's day" are still computed
// from the same quietStart/quietEnd).
export function makeClock({ tz, quietStart, quietEnd, eveningAt, quietOn = true, now = Date.now }) {
  // The evening window runs from eveningAt to the start of quiet hours, if that start is in the evening (no longer than 12 h). Quiet hours from 20:00 with
  // eveningAt 21:00 would give a window 21:00 → 20:00 the next day (almost a full day) — then there's no evening window: a blocker waits for
  // the start of the night (isNight).
  const eveningLen = (((quietStart - eveningAt) % 1440) + 1440) % 1440;
  const eveningOn = eveningLen > 0 && eveningLen <= 720;
  return {
    tz,
    now,
    parts: (ms = now()) => localParts(ms, tz),
    isQuiet: (ms = now()) => quietOn !== false && inWindow(localParts(ms, tz).minutes, quietStart, quietEnd),
    // The same window, but also with quiet hours off: an evening blocker at night doesn't wait for the next evening.
    isNight: (ms = now()) => inWindow(localParts(ms, tz).minutes, quietStart, quietEnd),
    // The blocker's evening window: from eveningAt to the start of quiet hours (empty if quiet hours start before the evening).
    isEvening: (ms = now()) => eveningOn && inWindow(localParts(ms, tz).minutes, eveningAt, quietStart),
    bucket: (ms = now()) => dayBucket(ms, tz, quietEnd),
  };
}
