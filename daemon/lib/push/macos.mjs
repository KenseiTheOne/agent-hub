// macOS notification: first via the shell (the `push.notify` event in SSE), without an acknowledgement — osascript.
// It is the always-on channel of the channel set (lib/push/channels.mjs).

import { randomUUID } from "node:crypto";

export const OSASCRIPT = "/usr/bin/osascript";

// The text is passed as arguments (`on run argv`), not pasted into the script: no escaping
// and no AppleScript substitution from the event text.
export function osascriptArgs({ title, subtitle, body }) {
  return [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
    "-e",
    "end run",
    String(body ?? ""),
    String(title ?? "Agent Hub"),
    String(subtitle ?? ""),
  ];
}

// emit — ctx.emit; waitAck — from acks.mjs; exec — ctx.exec.
// notify() returns right away: waiting for the acknowledgement happens in the background, the result is in .done.
// msg.bannerAlways — osascript right away, without `push.notify` in SSE: such a notification cannot be dismissed via
// POST /push/ack (the hub event @hub:app-pin-changed — the just-pinned build must not be able to dismiss it).
export function createMacNotifier({ emit, waitAck, exec, ackTimeoutMs = 3000, journal = () => {} }) {
  const banner = async (msg) => {
    try {
      const r = await exec(OSASCRIPT, osascriptArgs(msg), { timeoutMs: 5000 });
      if (r.code !== 0) journal({ type: "push-error", channel: "osascript", code: r.code, key: msg.key ?? null });
      return { channel: "osascript", ok: r.code === 0 };
    } catch {
      journal({ type: "push-error", channel: "osascript", code: -1, key: msg.key ?? null });
      return { channel: "osascript", ok: false };
    }
  };
  return {
    notify(msg) {
      const notifyId = randomUUID();
      if (msg.bannerAlways) return { notifyId, done: banner(msg) };
      emit({
        type: "push.notify",
        notifyId,
        title: msg.title,
        subtitle: msg.subtitle,
        body: msg.body,
        plugin: msg.plugin ?? null,
        key: msg.key ?? null,
        digest: Boolean(msg.digest),
        // G5: banner buttons — up to 2 offers {offer, label, level} of the event line's children; pressing one is POST /actions/:offer
        // like a panel button (not immediate — the app's confirmation). href — the event line's href= (http/https, checked like
        // open.url): the banner click opens it, null — the plugin page. Both are absent for hub events and third-party text.
        actions: Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : [],
        href: typeof msg.href === "string" ? msg.href : null,
      });
      const done = waitAck(notifyId, ackTimeoutMs).then((acked) => (acked ? { channel: "app", ok: true } : banner(msg)));
      return { notifyId, done };
    },
  };
}
