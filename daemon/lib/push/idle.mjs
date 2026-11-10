// Whether someone is at the Mac: HIDIdleTime from `ioreg -c IOHIDSystem` (nanoseconds since the last
// key press or mouse movement). Read-only, no permissions and no writes.

export const IOREG = "/usr/sbin/ioreg";
export const IOREG_ARGS = ["-c", "IOHIDSystem", "-d", "4"];

// ioreg text → idle milliseconds, or null if the field is not found.
export function parseHidIdle(text) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text ?? ""));
  if (!m) return null;
  const ns = Number(m[1]);
  if (!Number.isFinite(ns) || ns < 0) return null;
  return Math.floor(ns / 1e6);
}

// exec — ctx.exec (or a double). The result is cached for cacheMs so a burst of events does not call ioreg
// once per event. An error or unfamiliar output → null ("don't know").
export function createPresence({ exec, cacheMs = 10_000, now = Date.now }) {
  let cached = null;
  let cachedAt = -Infinity;
  return async function idleMs() {
    const t = now();
    if (t - cachedAt < cacheMs) return cached;
    let v = null;
    try {
      const r = await exec(IOREG, IOREG_ARGS, { timeoutMs: 3000 });
      v = r.code === 0 ? parseHidIdle(r.stdout) : null;
    } catch {
      v = null;
    }
    cached = v;
    cachedAt = t;
    return v;
  };
}
