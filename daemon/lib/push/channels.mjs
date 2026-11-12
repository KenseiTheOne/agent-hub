// Push delivery channels (G12): where a notification the engine decided to send goes.
//
// The engine calls one `notify(msg)` (the same interface the macOS notifier always had); the channel set sends it to:
//   - `mac` — the macOS notifier (lib/push/macos.mjs): the shell's banner, osascript without an acknowledgement. Always on,
//     always first: its notifyId and its result are what the engine waits for;
//   - channels from config.json (`services.push.channels`, built-in types below);
//   - channels registered by services (built-in or approved extensions) through the push service's fact:
//       ctx.facts.get("push.channels")?.register({ id, label?, security?, events?, send(payload) }) → unregister()
// Every extra channel is called in the background (no channel can hold up another or the engine), with a timeout; a failure goes
// to the journal as `push-channel-error {channel, key, code}` — never the channel's URL or anything it was configured with.
//
// Routing:
//   - security exceptions (kind "security") and bannerAlways events (a re-pinned app build, tampering signals) go only to
//     channels marked `security: true` (mac — always): a phone notification about a re-pin is opt-in;
//   - a macOnly notification (the rule's macOnly: <agenthub.push macOnly="true"> or services.push.rules) goes to mac only;
//   - `events: [...]` narrows a channel: a notification kind (sessions, updates, problems, other, plugin, security; hub — any
//     event of the hub itself; digest — the morning digest) or a key pattern `<plugin>:<key>` with `*` at the end (`mail:*`, `@hub:hub-update*`). No list — everything.
//
// msg.extra (optional): what extra channels get instead of msg itself — a list of messages, each routed on its own. The
// morning digest uses it to keep security items (held overnight) out of non-security channels: the Mac banner lists
// everything, extra channels get the plain items as the digest and the security ones as a kind "security" message.
//
// Payload of extra channels (JSON, metadata and the banner text only): {source: "agent-hub", title, subtitle, body, plugin, key,
// kind, digest, href, ts}. Banner action buttons (`actions`) are for the shell only: they are offer ids of this hub.

import { randomUUID } from "node:crypto";

export const CHANNEL_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const CHANNEL_TIMEOUT_MS = 10_000;
const KINDS = new Set(["sessions", "updates", "problems", "other", "plugin", "security", "hub", "digest"]);
const EVENT_PATTERN_RE = /^[@\w.:/*-]{1,128}$/;

// Does the notification go to this channel? msg.kind — the engine's kind of the rule; msg.bannerAlways — the security banner.
export function accepts(channel, msg) {
  if (msg?.macOnly === true) return false;
  const security = msg?.kind === "security" || msg?.bannerAlways === true;
  if (security && channel.security !== true) return false;
  const events = channel.events;
  if (!Array.isArray(events) || !events.length) return true;
  const kind = msg?.digest ? "digest" : msg?.kind || "other";
  const key = typeof msg?.key === "string" ? msg.key : "";
  return events.some((p) => {
    if (KINDS.has(p)) return p === kind || (p === "hub" && key.startsWith("@hub:"));
    if (p.endsWith("*")) return key.startsWith(p.slice(0, -1));
    return key === p;
  });
}

// What extra channels receive.
export function payloadOf(msg, now = Date.now) {
  return {
    source: "agent-hub",
    title: String(msg?.title ?? "Agent Hub"),
    subtitle: String(msg?.subtitle ?? ""),
    body: String(msg?.body ?? ""),
    plugin: msg?.plugin ?? null,
    key: msg?.key ?? null,
    kind: msg?.digest ? "digest" : msg?.kind || null,
    digest: Boolean(msg?.digest),
    href: typeof msg?.href === "string" ? msg.href : null,
    ts: new Date(now()).toISOString(),
  };
}

// A channel URL: https anywhere, http only to this Mac (localhost, 127.0.0.0/8, ::1). No credentials in the URL's user part.
// → { url } | { error }
export function checkChannelUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return { error: "bad-url" };
  }
  if (u.username || u.password) return { error: "credentials-in-url" };
  if (u.protocol === "https:") return { url: u };
  if (u.protocol !== "http:") return { error: "scheme" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) return { url: u };
  return { error: "http-not-local" };
}

// services.push.channels → { channels: [{id, type, url, events, security, label}], invalid: [{index, reason}] }.
// Types: "webhook" (POST the JSON payload) and "ntfy" (POST to an ntfy server: url = https://<server>/<topic>).
export function parseChannelConfig(raw) {
  const channels = [];
  const invalid = [];
  if (raw === undefined || raw === null) return { channels, invalid };
  if (!Array.isArray(raw)) return { channels, invalid: [{ index: -1, reason: "not-a-list" }] };
  raw.slice(0, 20).forEach((c, index) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) return invalid.push({ index, reason: "not-an-object" });
    if (c.enabled === false) return;
    if (c.type !== "webhook" && c.type !== "ntfy") return invalid.push({ index, reason: "type" });
    const u = checkChannelUrl(c.url);
    if (u.error) return invalid.push({ index, reason: u.error });
    if (c.type === "ntfy" && (!/^\/[^/]+\/?$/.test(u.url.pathname) || ntfyTopic(u.url) === null)) return invalid.push({ index, reason: "ntfy-topic" });
    if (c.events !== undefined && (!Array.isArray(c.events) || c.events.some((e) => typeof e !== "string" || !EVENT_PATTERN_RE.test(e)))) return invalid.push({ index, reason: "events" });
    if (c.security !== undefined && typeof c.security !== "boolean") return invalid.push({ index, reason: "security" });
    const id = typeof c.id === "string" && CHANNEL_ID_RE.test(c.id) ? c.id : `${c.type}-${index + 1}`;
    if (channels.some((x) => x.id === id)) return invalid.push({ index, reason: "duplicate-id" });
    channels.push({ id, type: c.type, url: u.url.href, events: c.events ? [...c.events] : null, security: c.security === true, label: typeof c.label === "string" ? c.label.slice(0, 60) : null });
  });
  return { channels, invalid };
}

// The ntfy topic of a channel URL (the only path segment, percent-decoded). null — a broken escape (`%E0%A4%A`).
function ntfyTopic(u) {
  try {
    return decodeURIComponent(u.pathname.replace(/^\/|\/$/g, ""));
  } catch {
    return null;
  }
}

// POST with a timeout, no redirects (an https URL must not be bent to plain http), the answer body is not read beyond the status.
async function post(fetchImpl, url, body, headers, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const r = await fetchImpl(url, { method: "POST", headers, body, redirect: "error", signal: ac.signal });
    try {
      await r.body?.cancel?.();
    } catch {}
    return r.ok ? { ok: true, status: r.status } : { ok: false, code: `http-${r.status}` };
  } catch (e) {
    return { ok: false, code: e?.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

// A configured channel → {id, label, security, events, send(payload)}.
export function configuredChannel(c, { fetchImpl = globalThis.fetch, timeoutMs = CHANNEL_TIMEOUT_MS } = {}) {
  const base = { id: c.id, label: c.label || c.type, security: c.security === true, events: c.events, type: c.type };
  if (c.type === "ntfy") {
    const u = new URL(c.url);
    const topic = ntfyTopic(u);
    if (topic === null) throw new Error("ntfy-topic");
    const root = `${u.origin}/`;
    return {
      ...base,
      send: (p) => {
        const title = p.subtitle ? `${p.title} · ${p.subtitle}` : p.title;
        const json = { topic, title: title.slice(0, 200), message: p.body.slice(0, 1000) || title.slice(0, 200), ...(p.href ? { click: p.href } : {}), tags: ["agent-hub"], priority: p.kind === "security" ? 5 : 3 };
        return post(fetchImpl, root, JSON.stringify(json), { "content-type": "application/json" }, timeoutMs);
      },
    };
  }
  return { ...base, send: (p) => post(fetchImpl, c.url, JSON.stringify(p), { "content-type": "application/json", "user-agent": "agent-hub-push" }, timeoutMs) };
}

// A channel a service registers: checked once at registration. → { channel } | { error }
export function checkRegistered(ch) {
  if (!ch || typeof ch !== "object") return { error: "not-an-object" };
  if (typeof ch.id !== "string" || !CHANNEL_ID_RE.test(ch.id) || ch.id === "mac") return { error: "bad-id" };
  if (typeof ch.send !== "function") return { error: "no-send" };
  if (ch.events !== undefined && ch.events !== null && (!Array.isArray(ch.events) || ch.events.some((e) => typeof e !== "string" || !EVENT_PATTERN_RE.test(e)))) return { error: "events" };
  return { channel: { id: ch.id, label: typeof ch.label === "string" ? ch.label.slice(0, 60) : ch.id, security: ch.security === true, events: ch.events ? [...ch.events] : null, send: (p) => ch.send(p), type: "service" } };
}

// The channel set: the engine's `mac`. mac — createMacNotifier(...); configured — from parseChannelConfig;
// → { notify(msg) → {notifyId, done, channels}, register(ch) → unregister | throws, list() }
export function createChannelSet({ mac, configured = [], journal = () => {}, fetchImpl = globalThis.fetch, timeoutMs = CHANNEL_TIMEOUT_MS, now = Date.now } = {}) {
  const extra = new Map();
  // one broken channel (a config that bypassed parseChannelConfig) is journaled and left out — never the whole set
  for (const c of configured) {
    try {
      extra.set(c.id, configuredChannel(c, { fetchImpl, timeoutMs }));
    } catch (e) {
      journal({ type: "push-channel-invalid", channel: c?.id ?? null, reason: e?.message === "ntfy-topic" ? "ntfy-topic" : "error" }); // never the URL
    }
  }
  const send = async (ch, payload) => {
    let r;
    try {
      r = await Promise.race([
        Promise.resolve(ch.send(payload)),
        new Promise((res) => {
          const t = setTimeout(() => res({ ok: false, code: "timeout" }), timeoutMs + 1000);
          t.unref?.();
        }),
      ]);
    } catch {
      r = { ok: false, code: "error" };
    }
    const ok = r?.ok === true;
    if (!ok) journal({ type: "push-channel-error", channel: ch.id, key: payload.key, code: typeof r?.code === "string" ? r.code.slice(0, 40) : "failed" });
    return { channel: ch.id, ok };
  };
  return {
    notify(msg) {
      const { extra: parts, ...base } = msg || {};
      const r = mac ? mac.notify(base) : { notifyId: randomUUID(), done: Promise.resolve({ channel: "none", ok: false }) };
      const sends = [];
      const ids = new Set();
      for (const m of Array.isArray(parts) ? parts : [base]) {
        const targets = [...extra.values()].filter((ch) => accepts(ch, m));
        if (!targets.length) continue;
        const payload = payloadOf(m, now);
        for (const ch of targets) {
          ids.add(ch.id);
          sends.push(send(ch, payload));
        }
      }
      if (!sends.length) return { ...r, channels: [] };
      // the engine waits for mac only; the extra channels finish in the background (tests wait for `all`)
      return { ...r, channels: [...ids], all: Promise.all([r.done, Promise.all(sends)]) };
    },
    register(ch) {
      const c = checkRegistered(ch);
      if (c.error) throw new Error(`push channel: ${c.error}`);
      if (extra.has(c.channel.id)) throw new Error(`push channel: ${c.channel.id} exists`);
      extra.set(c.channel.id, c.channel);
      journal({ type: "push-channel-registered", channel: c.channel.id, security: c.channel.security });
      return () => {
        if (extra.get(c.channel.id) === c.channel) extra.delete(c.channel.id);
      };
    },
    // For /state.notifications.channels (the app's Settings → Notifications) and tests: [{id, type, label, security, events}]
    // — never the URL or anything else the channel was configured with.
    list() {
      return [{ id: "mac", type: "mac", label: "macOS", security: true, events: null }, ...[...extra.values()].map((c) => ({ id: c.id, type: c.type, label: c.label, security: c.security, events: c.events }))];
    },
  };
}
