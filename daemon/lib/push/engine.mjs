// Push logic: plugin events → deciding "to whom, when and how many times".
//
// Input — bus events `event.raised` / `event.cleared` (key `<pluginId>:<key>`) and the timer tick.
// Output — a notification through the channel set (lib/push/channels.mjs: the macOS banner — shell or osascript — plus the
// configured and registered channels) or a morning digest item. The engine sees one `mac.notify(msg)`; msg.kind — the rule's
// kind (channels route by it), msg.actions / msg.href — banner buttons and the click target (G5, below).
//
// Rules (design section 6):
//   - one state, one message: while the key is raised there are no repeats; after it's cleared a repeat within
//     the rule's cooldownMs is suppressed (debounce; for quota — a week);
//   - presence by HID idle time: less than idleThresholdMs (10 min) or "don't know" — the human is at the Mac;
//   - quiet hours (23:00–08:00) while the human is away: only rules with quietException (urgent) show a banner right
//     away, the rest are held and merged into one digest banner on the first tick after quiet hours end; at the Mac —
//     banners as usual;
//   - hold="evening" (a plugin's evening blocker): during the day waits for 21:00, from 21:00 — immediately; repeats once per "night's day";
//   - awayDelayMs (a session is waiting): at the Mac — a banner right away; away — a banner once the human is back at the
//     Mac or the event has been pending longer than awayDelayMs, whichever comes first (during quiet hours — the digest);
//   - third-party plugin events — without the plugin's text;
//   - banner buttons and click target (G5): the push.notify of a plugin event carries `actions` — up to 2 offers of the
//     children of the line with event= (taken at send time, so they are the live offers) — and `href` — the line's href=,
//     http(s) only; only when the banner shows the row text (trusted plugins, a community event its reviewed rule describes);
//   - Settings toggles (lib/push/prefs.mjs): an event of a disabled kind goes nowhere — not macOS,
//     osascript or the digest; the journal gets push-muted. Decided on raise and before every send
//     (evening blocker, waiting session, digest): disabled at send time — not sent (enabled before sending —
//     sent as usual); raised while the kind was disabled — not delivered even after it's enabled. The "security" kind
//     (security exceptions) can't be disabled; the "plugin" kind is the plugin's own toggle (prefs.pluginToggle).
//
// All dependencies (time, idle, senders, storage) are passed in from outside — in tests they're doubles.

import { makeClock, parseHM } from "./clock.mjs";
import { defaultPrefs, kindAllowed, normPrefs } from "./prefs.mjs";
import { DEFAULT_RULES, SECURITY, applyOverride, buildRules, kindOf, matchRule, pluginRules } from "./rules.mjs";
import { t as tr } from "../i18n.mjs";

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;
// The hub's own event source (lib/services/push.mjs HUB_SOURCE): its events have no per-plugin limits.
const HUB = "@hub";
// State is saved once per batch of operations (when the queue empties), but no less often than every this many ms.
const SAVE_EVERY_MS = 2000;

export function clean(s, n) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
}

// A label without a leading plugin name: "Mail: message not sent" for plugin "Mail" → "message not sent".
export function stripTitle(label, title) {
  const l = String(label || "");
  const t = String(title || "").trim();
  if (!t) return l;
  const m = new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:·—-]\\s*`, "i").exec(l);
  const rest = m ? l.slice(m[0].length) : l;
  return rest.trim() ? rest : l;
}

// The detail says the same as the label: at least 60% of the label's significant words (three letters and up) are in the detail.
export function saysSame(label, detail) {
  const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{N}%]+/u).filter((w) => w.length >= 3);
  const lw = words(label);
  if (!lw.length) return false;
  const dw = new Set(words(detail));
  return lw.filter((w) => dw.has(w)).length / lw.length >= 0.6;
}

export class PushEngine {
  // prefs — Settings toggles (settings.json → notifications); quiet — the effective quiet hours
  // {enabled, start, end} (lib/push/prefs.mjs effectiveQuiet); absent — quiet hours from config (quietStart/quietEnd).
  constructor({ config, now = Date.now, presence = async () => null, mac, lookup = () => ({}), store = null, journal = () => {}, lang = () => "ru", prefs = null, quiet = null }) {
    this.cfg = config;
    this.lang = () => {
      try {
        return lang() || "ru";
      } catch {
        return "ru";
      }
    };
    this.now = now;
    this.prefs = prefs ? normPrefs(prefs) : defaultPrefs();
    this.setQuiet(quiet);
    this.rules = buildRules(config.rules);
    this.presence = presence;
    this.mac = mac;
    this.lookup = lookup;
    this.store = store;
    this.journal = journal;
    this.entries = new Map(); // key → entry
    this.digest = []; // [{key, subtitle, body, at}]
    this.lastDigestAt = null;
    this.startedAt = now();
    this.chain = Promise.resolve();
    this.pending = 0; // operations in the queue
    this.dirty = false; // state changed but the file isn't written yet
    this.savedAt = 0;
    this.byPlugin = new Map(); // plugin → Set(key) — for the per-plugin entry limit
    this.rate = new Map(); // plugin → { since, n, muted } — new notifications per minute
    this.drops = new Map(); // plugin → { since, n } — "no room for an entry" refusals per minute (for the journal)
    this.macPending = []; // .done of macOS notifications (for tests)
  }

  // ---------- settings ----------
  // Toggles and quiet hours from Settings — immediately, without restarting the service (settings.changed event).
  setPrefs(prefs, quiet) {
    this.prefs = normPrefs(prefs);
    if (quiet !== undefined) this.setQuiet(quiet);
  }
  setQuiet(quiet) {
    const c = this.cfg;
    const start = quiet ? parseHM(quiet.start) : null;
    const end = quiet ? parseHM(quiet.end) : null;
    this.quiet = { on: quiet ? quiet.enabled !== false : true, start: start ?? c.quietStart, end: end ?? c.quietEnd };
    this.clock = makeClock({ tz: c.timezone, quietStart: this.quiet.start, quietEnd: this.quiet.end, eveningAt: c.eveningAt, quietOn: this.quiet.on, now: this.now });
  }
  // The system time zone changed (the push service checks it on each tick if no zone is set in config.json).
  setTimeZone(tz) {
    if (!tz || tz === this.cfg.timezone) return;
    this.cfg = { ...this.cfg, timezone: tz };
    this.clock = makeClock({ tz, quietStart: this.quiet.start, quietEnd: this.quiet.end, eveningAt: this.cfg.eveningAt, quietOn: this.quiet.on, now: this.now });
    this.journal({ type: "push-timezone", timezone: tz });
  }
  kindOf(rule, e) {
    // a community plugin's own reviewed rule (G3): its own switch, like a trusted plugin's kind="plugin"
    if (rule?.community === true) return "plugin";
    return kindOf(rule, { trusted: e.trusted !== false, bare: e.bare, hub: e.plugin === HUB });
  }
  // A digest item's kind: recorded when deferred; items from a file older than 2026-11-09 have no kind — derive it from the key (otherwise
  // a security exception deferred overnight would be dropped in the morning with "Other" turned off).
  digestKind(it) {
    if (it.kind) return it.kind;
    const e = this.entries.get(it.key);
    if (e) return this.kindOf(this.ruleFor(e.bare, e.trusted !== false, this.ownRules(e), e.plugin), e);
    const i = String(it.key || "").indexOf(":");
    const plugin = i > 0 ? it.key.slice(0, i) : "";
    const bare = i > 0 ? it.key.slice(i + 1) : "";
    if (plugin !== HUB || !bare) return "other";
    return kindOf(this.ruleFor(bare, true, null, HUB), { trusted: true, bare, hub: true });
  }
  // The "plugin" kind is decided by the plugin's toggle: the id comes from the entry (or the digest item's key), the rules are its <agenthub.push>.
  allowed(kind, pluginId = null, bare = "") {
    if (kind !== "plugin" || !pluginId) return kindAllowed(this.prefs, kind);
    let rules = null;
    try {
      rules = this.lookup(pluginId, bare)?.rules || null;
    } catch {}
    return kindAllowed(this.prefs, kind, { plugin: pluginId, rules });
  }
  // Raised while the kind was disabled: don't notify now or later (not delivered even after enabling); journal — without text.
  silence(e, rule, kind) {
    if (e.silenced) return;
    e.silenced = true;
    this.journal({ type: "push-muted", key: e.key, rule: rule.name, kind, reason: this.prefs.enabled ? "kind" : "all" });
  }
  // The kind is disabled at send time (raised while enabled): don't notify now, but don't suppress forever — if it's enabled before
  // sending, it goes out as usual. push-muted — once per "disabled".
  mutedNow(e, rule, kind) {
    if (e.mutedNoted) return;
    e.mutedNoted = true;
    this.journal({ type: "push-muted", key: e.key, rule: rule.name, kind, reason: this.prefs.enabled ? "kind" : "all" });
  }

  setEntry(e) {
    this.entries.set(e.key, e);
    let s = this.byPlugin.get(e.plugin);
    if (!s) this.byPlugin.set(e.plugin, (s = new Set()));
    s.add(e.key);
  }
  dropEntry(key) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    const s = this.byPlugin.get(e.plugin);
    s?.delete(key);
    if (s && !s.size) this.byPlugin.delete(e.plugin);
  }

  // ---------- state ----------
  load() {
    const s = this.store?.load();
    if (!s) return;
    for (const e of s.entries || []) {
      if (!e || typeof e.key !== "string") continue;
      // Entries active before the restart wait to be raised again: plugins will restart and raise them again.
      if (typeof e.plugin !== "string") continue;
      // sentTg — a file from a build that still had a second channel: that state was already delivered
      const { sentTg, ...rest } = e;
      this.setEntry({ ...rest, sentMac: Boolean(e.sentMac || sentTg), stale: Boolean(e.active) });
    }
    this.digest = Array.isArray(s.digest) ? s.digest.slice(-500) : [];
    this.lastDigestAt = s.lastDigestAt ?? null;
  }
  // Writing the file is driven by the dirty flag: once per batch of operations (flush at the end of the queue), not per event.
  save() {
    this.dirty = true;
  }
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.savedAt = this.now();
    if (!this.store) return;
    try {
      this.store.save({ version: 1, entries: [...this.entries.values()], digest: this.digest, lastDigestAt: this.lastDigestAt });
    } catch {
      this.journal({ type: "push-error", channel: "store", code: -1 });
    }
  }

  // All operations run in sequence: raising and clearing the same key don't interleave. Before each one, yield the event
  // loop (setImmediate): a stream of events from a plugin must not keep the daemon on microtasks alone.
  enqueue(fn) {
    this.pending++;
    const p = this.chain
      .then(() => new Promise((r) => setImmediate(r)))
      .then(fn)
      .catch(() => this.journal({ type: "push-error", channel: "internal", code: -1 }))
      .finally(() => {
        this.pending--;
        if (this.pending === 0 || this.now() - this.savedAt >= SAVE_EVERY_MS) this.flush();
      });
    this.chain = p;
    return p;
  }
  raised(ev) {
    return this.enqueue(() => this.onRaised(ev));
  }
  cleared(ev) {
    return this.enqueue(() => this.onCleared(ev));
  }
  tick() {
    return this.enqueue(() => this.onTick());
  }
  // Wait for the queue and background macOS notifications (tests, stop).
  async idle() {
    await this.chain;
    this.flush();
    await Promise.all(this.macPending.splice(0));
  }

  // Limit on new notifications from a plugin per minute. → "ok" | "first" (the first one over the limit — a summary) | "muted"
  admit(plugin, trusted, t) {
    if (plugin === HUB) return "ok";
    const max = trusted ? this.cfg.maxPerPluginPerMin : this.cfg.maxPerUntrustedPerMin;
    let r = this.rate.get(plugin);
    if (!r || t - r.since >= MINUTE) {
      if (r?.muted) this.journal({ type: "push-throttled", plugin, dropped: r.muted });
      r = { since: t, n: 0, muted: 0 };
      this.rate.set(plugin, r);
      if (this.rate.size > 1000) for (const [k, v] of this.rate) if (t - v.since >= MINUTE) this.rate.delete(k);
    }
    if (r.n < max) {
      r.n++;
      return "ok";
    }
    r.muted++;
    return r.muted === 1 ? "first" : "muted";
  }

  // "No room for an entry" refusals in the journal: the first in a minute is written right away, the rest are only counted; the count
  // goes out as a single `push-dropped` entry with `dropped: N` once the minute is over (on the next refusal or tick).
  // Otherwise a plugin with raised keys and a stream of new event= would write an entry per event and push out the journal.
  noteDrop(plugin, t) {
    let d = this.drops.get(plugin);
    if (d && t - d.since >= MINUTE) {
      this.flushDrops(plugin, d);
      d = null;
    }
    if (!d) {
      this.drops.set(plugin, { since: t, n: 0 });
      this.journal({ type: "push-dropped", plugin, reason: "too-many-keys" });
      return;
    }
    d.n++;
  }
  flushDrops(plugin, d) {
    this.drops.delete(plugin);
    if (d.n > 0) this.journal({ type: "push-dropped", plugin, reason: "too-many-keys", dropped: d.n });
  }

  // Room for a new plugin entry: over the limit, the longest-cleared ones are evicted. → false — no room (all active).
  room(plugin, trusted) {
    if (plugin === HUB) return true;
    const keys = this.byPlugin.get(plugin);
    const max = trusted ? this.cfg.maxEntriesPerPlugin : this.cfg.maxEntriesPerUntrusted;
    if (!keys || keys.size < max) return true;
    const inactive = [...keys].map((k) => this.entries.get(k)).filter((e) => e && !e.active && !e.stale);
    inactive.sort((a, b) => (a.clearedAt ?? 0) - (b.clearedAt ?? 0));
    for (const e of inactive.slice(0, keys.size - max + 1)) this.dropEntry(e.key);
    return keys.size < max;
  }

  // ---------- rules ----------
  // own — the plugin's own rules (<agenthub.push>, trusted plugins only); they come before the common table, and on top of
  // them — the user's overrides from services.push.rules ("<plugin>:<name>" or "<name>").
  // Core security exceptions (kind "security" in DEFAULT_RULES): for a hub event — the table rule as is, without
  // config.json (neither hold, awayDelayMs, cooldownMs, label nor someone else's alias can silence it); for a plugin event
  // with the same key — without the kind, the banner bypassing the shell, quiet hours and the hub label.
  // An untrusted plugin with own rules — a community plugin (G3; the core gives rules to no other untrusted tier): only its
  // kind="plugin" rules count, and only the label — no quiet-hours exception, away, evening hold, own cooldown or security.
  ruleFor(bare, trusted, own = null, plugin = null) {
    if (!trusted) {
      const mine = own?.length ? matchRule(pluginRules(own.filter((r) => r?.kind === "plugin")), bare) : null;
      // macOnly only narrows delivery (Mac banner only), so a community plugin may ask for it too
      if (mine && mine.name !== "default") return { name: mine.name, label: mine.label || null, cooldownMs: this.cfg.flapCooldownMs, community: true, ...(mine.macOnly === true ? { macOnly: true } : {}) };
      return { name: "untrusted", label: null, cooldownMs: this.cfg.flapCooldownMs };
    }
    const core = matchRule(DEFAULT_RULES, bare);
    if (plugin === HUB && core.kind === SECURITY) return { ...core, aliases: [...(core.aliases || [])] };
    const mine = own?.length ? matchRule(pluginRules(own), bare) : null;
    let base = mine && mine.name !== "default" ? mine : matchRule(this.rules, bare);
    if (plugin !== HUB && base !== mine && kindOf(base, { trusted: true }) === SECURITY) {
      const { kind, bannerAlways, quietException, ...rest } = base;
      base = { ...rest, label: null };
    }
    const r = { ...applyOverride(base, this.cfg.rules, plugin) };
    if (r.cooldownMs == null) r.cooldownMs = this.cfg.flapCooldownMs;
    return r;
  }

  ownRules(e) {
    try {
      return this.lookup(e.plugin, e.bare)?.rules || null;
    } catch {
      return null;
    }
  }

  compose(rule, info, plugin, bare) {
    const lang = this.lang();
    // a label from the common table (not overridden by the user) — in the current language
    const def = DEFAULT_RULES.find((r) => r.name === rule.name);
    // info.label — the title the hub itself supplies for its own events (first pin, unpin)
    const label = (def && rule.label === def.label ? (info.label || tr(lang, `push.rule.${rule.name}`)) : rule.label) || tr(lang, "push.event", { key: clean(bare, 60) });
    // the row text: trusted plugins, and a community plugin's event its reviewed rule describes (G3)
    const detail = info.trusted || rule.community === true ? clean(info.itemTitle || info.error || "", 160) : "";
    // the hub's own events: the notification title is "Agent Hub" anyway — the subtitle doesn't repeat it but carries the gist
    // (label), the body is the detail; no detail — no subtitle, the label becomes the body
    if (info.hub === true) return detail && detail !== label ? { subtitle: clean(label, 80), body: detail } : { subtitle: "", body: label };
    // plugin: the subtitle is the plugin's name, and the label doesn't repeat it ("Mail: message not sent" → "message not sent");
    // if there's a detail, it's the body, and the label goes into the subtitle ("Mail · message not sent"), unless the detail already
    // says the same thing in its own words (then the subtitle is just the name)
    const title = clean(info.pluginTitle || plugin, 60);
    const own = stripTitle(label, title);
    if (!detail || detail === label || detail === own) return { subtitle: title, body: own };
    // the label itself starts with the name ("Mail isn't responding" for plugin "Mail") — it's the subtitle, no repeat
    const named = own.toLowerCase().startsWith(title.toLowerCase());
    return { subtitle: saysSame(own, detail) ? title : clean(named ? own : `${title} · ${own}`, 80), body: detail };
  }

  async present() {
    let idle = null;
    try {
      idle = await this.presence();
    } catch {
      idle = null;
    }
    // Don't know — assume the person is at the Mac: don't send outside without certainty.
    return idle == null || idle < this.cfg.idleThresholdMs;
  }

  // ---------- events ----------
  async onRaised({ plugin, key } = {}) {
    if (typeof plugin !== "string" || typeof key !== "string" || !key.startsWith(`${plugin}:`)) return;
    const bare = key.slice(plugin.length + 1);
    if (!bare) return;
    const t = this.now();
    let e = this.entries.get(key);
    if (e?.active) {
      if (e.stale) {
        e.stale = false;
        this.save();
      }
      return;
    }
    let info = {};
    try {
      info = this.lookup(plugin, bare) || {};
    } catch {}
    const trusted = info.trusted !== false;
    if (!e && !this.room(plugin, trusted)) {
      this.noteDrop(plugin, t);
      return;
    }
    const rule = this.ruleFor(bare, trusted, info.rules || null, plugin);
    if (e && e.lastSentAt != null && rule.cooldownMs > 0 && t - e.lastSentAt < rule.cooldownMs) {
      e.active = true;
      e.stale = false;
      e.clearedAt = null;
      this.journal({ type: "push-suppressed", key, rule: rule.name });
      this.save();
      return;
    }
    e = {
      key,
      plugin,
      bare,
      trusted,
      active: true,
      stale: false,
      raisedAt: t,
      clearedAt: null,
      lastSentAt: e?.lastSentAt ?? null,
      bucket: e?.bucket ?? null, // for hold="evening": the "night's day" already notified about
      held: false,
      sentMac: false,
      queued: false,
      silenced: false,
      msg: this.compose(rule, { ...info, trusted }, plugin, bare),
    };
    this.setEntry(e);
    // a disabled kind — before the rate limit: its events aren't counted and don't produce "notifications muted"
    const kind = this.kindOf(rule, e);
    if (!this.allowed(kind, e.plugin, e.bare)) {
      this.silence(e, rule, kind);
      this.save();
      return;
    }
    const admit = this.admit(plugin, trusted, t);
    if (admit !== "ok") {
      // remember but don't notify: while the key is raised there are no repeats anyway; once cleared — the next state follows the usual rules
      e.muted = true;
      if (admit === "first") {
        const { done } = this.mac.notify({ title: "Agent Hub", subtitle: e.msg.subtitle, body: tr(this.lang(), "push.throttled"), plugin, key: `${plugin}:push-throttled`, kind: this.kindOf(rule, e), actions: [], href: null });
        this.macPending.push(done);
        this.journal({ type: "push-throttled", plugin, key });
      }
      this.save();
      return;
    }
    await this.process(e, rule, t);
    this.save();
  }

  async onCleared({ key } = {}) {
    const e = this.entries.get(key);
    if (!e || !e.active) return;
    e.active = false;
    e.stale = false;
    e.held = false;
    e.clearedAt = this.now();
    this.save();
  }

  // Decision on an active entry "now". Called on raise and on every tick.
  async process(e, rule, t) {
    if (e.muted || e.silenced) return;
    // the kind is disabled now (an evening blocker waits for 21:00, a session waits for idle) — not sent now; the mark isn't permanent
    const kind = this.kindOf(rule, e);
    if (!this.allowed(kind, e.plugin, e.bare)) {
      this.mutedNow(e, rule, kind);
      return;
    }
    e.mutedNoted = false;
    const quiet = this.clock.isQuiet(t);
    if (rule.hold === "evening") {
      const bucket = this.clock.bucket(t);
      if (e.bucket === bucket) return;
      if (!this.clock.isNight(t) && !this.clock.isEvening(t)) {
        if (!e.held) {
          e.held = true;
          this.journal({ type: "push-held", key: e.key, rule: rule.name });
        }
        return;
      }
      e.held = false;
      e.bucket = bucket;
      await this.deliver(e, rule, t, quiet);
      return;
    }
    if (e.sentMac || e.queued) return;
    if (rule.awayDelayMs) {
      // away: the banner waits until the human is back at the Mac (checked on every tick) or awayDelayMs has passed
      if (await this.present()) this.sendMac(e, rule, t);
      else if (t - e.raisedAt >= rule.awayDelayMs) this.deliverAway(e, rule, t, quiet);
      return;
    }
    await this.deliver(e, rule, t, quiet);
  }

  async deliver(e, rule, t, quiet) {
    if (await this.present()) return this.sendMac(e, rule, t);
    return this.deliverAway(e, rule, t, quiet);
  }

  // The human is away: during quiet hours a non-urgent banner is held for the morning digest, otherwise it shows right away
  // (it waits in Notification Center).
  deliverAway(e, rule, t, quiet) {
    if (quiet && !rule.quietException) {
      e.queued = true;
      const kind = this.kindOf(rule, e);
      // security: a security exception or a bannerAlways event — in the morning it goes to extra channels only as its own
      // kind "security" message (security channels), never inside the plain digest (sendDigest)
      this.digest.push({ key: e.key, subtitle: e.msg.subtitle, body: e.msg.body, at: t, kind, ...(kind === "security" || rule.bannerAlways === true ? { security: true } : {}), ...(rule.macOnly === true ? { macOnly: true } : {}) });
      this.journal({ type: "push-deferred", key: e.key, rule: rule.name });
      return;
    }
    this.sendMac(e, rule, t);
  }

  // Banner buttons and click target of a plugin event (G5) — asked at send time: an event held for the evening or for the
  // human's return gets the offers of the current frame, not of the one it was raised in. Only when the banner shows the row
  // text (trusted plugins; a community event its reviewed rule describes). → { actions, href }
  extrasOf(e, rule) {
    const none = { actions: [], href: null };
    if (e.plugin === HUB || !(e.trusted !== false || rule.community === true)) return none;
    let info = null;
    try {
      info = this.lookup(e.plugin, e.bare);
    } catch {}
    if (!info) return none;
    const actions = (Array.isArray(info.actions) ? info.actions : [])
      .filter((a) => a && typeof a.offer === "string" && typeof a.label === "string")
      .slice(0, 2)
      .map((a) => ({ offer: a.offer, label: clean(a.label, 60), level: typeof a.level === "string" ? a.level : "confirm" }));
    return { actions, href: typeof info.href === "string" ? info.href : null };
  }

  sendMac(e, rule, t) {
    const kind = this.kindOf(rule, e);
    const { done, channels } = this.mac.notify({ title: "Agent Hub", subtitle: e.msg.subtitle, body: e.msg.body, plugin: e.plugin, key: e.key, kind, bannerAlways: rule.bannerAlways === true, ...(rule.macOnly === true ? { macOnly: true } : {}), ...this.extrasOf(e, rule) });
    this.macPending.push(done);
    if (this.macPending.length > 100) this.macPending.splice(0, 50);
    e.sentMac = true;
    e.lastSentAt = t;
    this.journal({ type: "push-sent", key: e.key, channel: "mac", rule: rule.name, ...(channels?.length ? { also: channels } : {}) });
  }

  // ---------- tick ----------
  async onTick() {
    const t = this.now();
    for (const [plugin, d] of this.drops) if (t - d.since >= MINUTE) this.flushDrops(plugin, d);
    // Active before the restart and not raised again — cleared.
    if (t - this.startedAt >= this.cfg.staleGraceMs) {
      for (const e of this.entries.values()) {
        if (e.stale) {
          e.stale = false;
          e.active = false;
          e.clearedAt = t;
        }
      }
    }
    for (const e of this.entries.values()) {
      if (!e.active || e.stale) continue;
      const rule = this.ruleFor(e.bare, e.trusted !== false, this.ownRules(e), e.plugin);
      if (rule.hold === "evening" || rule.awayDelayMs) await this.process(e, rule, t);
    }
    if (this.digest.length && !this.clock.isQuiet(t)) this.sendDigest(t);
    this.gc(t);
    this.save();
  }

  // One banner for everything held overnight: "Overnight: N" and the bodies in a row.
  sendDigest(t) {
    // the kind was disabled overnight — its items don't go out in the morning either (an item without a kind is from a file older than 2026-11-09: "other")
    const all = this.digest.splice(0);
    const items = all.filter((it) => {
      const i = String(it.key || "").indexOf(":");
      return this.allowed(this.digestKind(it), i > 0 ? it.key.slice(0, i) : null, i > 0 ? it.key.slice(i + 1) : "");
    });
    if (items.length < all.length) this.journal({ type: "push-muted", key: "digest", count: all.length - items.length, reason: this.prefs.enabled ? "kind" : "all" });
    if (!items.length) {
      this.lastDigestAt = t;
      return;
    }
    this.lastDigestAt = t;
    const digestOf = (list, extra = {}) => ({ title: "Agent Hub", subtitle: tr(this.lang(), "push.digest.subtitle", { n: list.length }), body: clean(list.slice(0, this.cfg.digestMaxItems).map((it) => it.body).join("; "), 240), plugin: null, key: "push:digest", digest: true, kind: null, actions: [], href: null, ...extra });
    // The banner on the Mac lists everything. Extra channels (lib/push/channels.mjs, msg.extra) get the plain items as the
    // digest and the security ones (a security exception or bannerAlways event held overnight, older files: kind
    // "security") as a separate kind "security" message — so only channels marked security: true ever see them. macOnly items
    // (the rule's macOnly) are on the Mac banner only.
    const shared = items.filter((it) => it.macOnly !== true);
    const secure = shared.filter((it) => it.security === true || this.digestKind(it) === "security");
    const plain = shared.filter((it) => !secure.includes(it));
    const extra = secure.length || shared.length < items.length ? [...(plain.length ? [digestOf(plain)] : []), ...(secure.length ? [digestOf(secure, { digest: false, kind: "security" })] : [])] : undefined;
    const { done, channels } = this.mac.notify({ ...digestOf(items), ...(extra ? { extra } : {}) });
    this.macPending.push(done);
    for (const it of items) {
      const e = this.entries.get(it.key);
      if (e) e.lastSentAt = t;
    }
    this.journal({ type: "push-digest", count: items.length, channel: "mac", ...(channels?.length ? { also: channels } : {}) });
  }

  gc(t) {
    for (const [k, e] of this.entries) {
      if (e.active || e.stale) continue;
      const rule = this.ruleFor(e.bare, e.trusted !== false, this.ownRules(e), e.plugin);
      const keep = Math.max(rule.cooldownMs || 0, 0) + DAY;
      if (t - (e.clearedAt ?? 0) > keep) this.dropEntry(k);
    }
  }

  // Debug summary (without texts).
  summary() {
    return {
      active: [...this.entries.values()].filter((e) => e.active).map((e) => e.key),
      digest: this.digest.length,
      lastDigestAt: this.lastDigestAt,
    };
  }
}
