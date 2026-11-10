// Acknowledgements that the shell displayed a notification.
//
// The daemon sends `push.notify` with a notifyId on the bus; the shell shows a banner (UNUserNotificationCenter) and
// replies `POST /push/ack {"id": notifyId}` (route lib/routes/push.mjs). No reply within ackTimeoutMs means
// the shell isn't running or notifications are disabled for it, and the daemon shows the banner itself via osascript.
// The module is shared by the service and the route (one instance per daemon process).

const pending = new Map(); // id → { resolve, timer }

export function waitAck(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, timer });
  });
}

// true — this notification really was awaiting acknowledgement.
export function ack(id) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(true);
  return true;
}

export function pendingCount() {
  return pending.size;
}

// Drop all pending waits (service stop): each one counts as unacknowledged.
export function clearAcks() {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(false);
    pending.delete(id);
  }
}
