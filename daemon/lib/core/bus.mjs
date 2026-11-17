// Core part: the event bus — events with ids for GET /events (emit, eventsSince), journal warnings with their rate
// limits (warn) and delivery of plugin events to subscriber plugins (G11).
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { parseSubscription, SUBSCRIBE_MAX } from "../meta.mjs";
import { cleanPhrase } from "../output.mjs";
import { msg } from "../i18n.mjs";
import { trustedPlugin } from "./tiers.mjs";

// Warnings from a single plugin to the journal per minute (Core.warn).
const WARN_PER_MIN = 20;
// Event subscriptions (G11): messages to one subscriber per minute (the rest are dropped and journaled once a minute; the
// snapshot after a restart carries the state again); events in one snapshot.
const SUBSCRIBE_PER_MIN = 600;
const SNAPSHOT_MAX = 500;

export class CoreBus {
  // ---------- bus ----------
  emit(event) {
    if (typeof event?.type !== "string" || !/^[\w.:-]{1,64}$/.test(event.type)) return null;
    const ev = { ...event, id: ++this.seq, ts: new Date().toISOString() };
    // For Last-Event-ID replay a plugin event is stored without a state snapshot (it can be large — a frame up to
    // 1 MB, with 500 events): on replay the current plugin state is substituted (eventsSince).
    this.recent.push(ev.type === "plugin" && ev.plugin && typeof ev.plugin.id === "string" ? { ...ev, plugin: undefined, pluginRef: ev.plugin.id } : ev);
    if (this.recent.length > 500) this.recent.shift();
    this.bus.emit("event", ev);
    this.bus.emit(ev.type, ev);
    return ev;
  }
  on(type, fn) {
    this.bus.on(type, fn);
  }
  off(type, fn) {
    this.bus.off(type, fn);
  }
  eventsSince(id) {
    if (!Number.isSafeInteger(id) || id < this.seqBase || id > this.seq) return null;
    const i = this.recent.findIndex((e) => e.id === id + 1);
    if (i < 0) return null;
    const tail = this.recent.slice(i);
    // Each plugin event in a replay already carries the current state, so of several with the same id only
    // the last one is needed: otherwise replay would send N identical full copies (memory and socket write volume).
    const lastFor = new Map();
    tail.forEach((e, k) => e.pluginRef !== undefined && lastFor.set(e.pluginRef, k));
    const out = [];
    for (const [k, e] of tail.entries()) {
      if (e.pluginRef === undefined) {
        out.push(e);
        continue;
      }
      if (lastFor.get(e.pluginRef) !== k) continue;
      const st = this.pluginState(e.pluginRef);
      // the plugin is gone — its plugin.removed comes later in this same tail
      if (!st) continue;
      const { pluginRef, ...rest } = e;
      out.push({ ...rest, plugin: st });
    }
    return out;
  }

  // Warning to the journal: an exact repeat at most once per 10 min; from a single plugin at most
  // WARN_PER_MIN per minute, beyond that a single "suppressed: N" entry when the minute changes (a stream of unique
  // warnings would otherwise push the whole history out of the journal).
  warn(pluginId, text) {
    const key = `${pluginId}|${text}`;
    const now = Date.now();
    if (now - (this.warned.get(key) || 0) < 10 * 60_000) return;
    let r = this.warnRate.get(pluginId);
    if (!r || now - r.since >= 60_000) {
      if (r?.dropped) this.journal.write({ type: "warning", plugin: pluginId, detail: msg("warn.suppressed", { n: r.dropped }), suppressed: r.dropped });
      r = { since: now, n: 0, dropped: 0 };
      this.warnRate.set(pluginId, r);
      if (this.warnRate.size > 1000) this.warnRate.clear();
    }
    if (r.n >= WARN_PER_MIN) {
      r.dropped++;
      return;
    }
    r.n++;
    this.warned.set(key, now);
    if (this.warned.size > 2000) this.warned.clear();
    this.journal.write({ type: "warning", plugin: pluginId, detail: text });
  }

  // ---------- event subscriptions (G11) ----------
  // <agenthub.subscribe>plugin:prefix</agenthub.subscribe> of a trusted streamable plugin → [{plugin, prefix}]; anything else is
  // ignored with a journal warning (the linter says the same before install).
  subscriptionsFor(pl) {
    const entries = pl.meta?.subscribe || [];
    if (!entries.length) return [];
    if (!trustedPlugin(pl)) {
      this.warn(pl.id, msg("warn.subscribe.untrusted"));
      return [];
    }
    if (pl.meta.type !== "streamable") {
      this.warn(pl.id, msg("warn.subscribe.standard"));
      return [];
    }
    const out = [];
    for (const e of entries) {
      const p = parseSubscription(e);
      if (!p) this.warn(pl.id, msg("warn.subscribe.bad", { entry: String(e).slice(0, 80) }));
      else if (out.length >= SUBSCRIBE_MAX) {
        this.warn(pl.id, msg("warn.subscribe.many", { n: SUBSCRIBE_MAX }));
        break;
      } else if (!out.some((x) => x.plugin === p.plugin && x.prefix === p.prefix)) out.push(p);
    }
    return out;
  }
  // Whether subscriber subId gets event key (the plugin's own key, without "<id>:") of sourceId. "*" — every plugin but itself.
  subscribed(subId, sourceId, key) {
    return (this.subscriptions.get(subId) || []).some((s) => (s.plugin === "*" ? sourceId !== subId : s.plugin === sourceId) && key.startsWith(s.prefix));
  }
  deliverEvent(sourceId, key, state, title) {
    if (!this.subscriptions.size) return;
    for (const subId of this.subscriptions.keys()) {
      if (!this.subscribed(subId, sourceId, key)) continue;
      this.sendSubscribed(subId, { type: "event", plugin: sourceId, key, state, ...(title ? { title } : {}) });
    }
  }
  sendSubscribed(subId, obj) {
    const now = Date.now();
    let r = this.subscribeRate.get(subId);
    if (!r || now - r.since >= 60_000) {
      if (r?.dropped) this.journal.write({ type: "subscribe-dropped", plugin: subId, dropped: r.dropped });
      r = { since: now, n: 0, dropped: 0 };
      this.subscribeRate.set(subId, r);
    }
    if (r.n >= SUBSCRIBE_PER_MIN) {
      r.dropped++;
      return false;
    }
    r.n++;
    return this.host.send(subId, obj);
  }
  // The events raised now that subId subscribed to (a restarting source's carried events too). → [{plugin, key, state, title?}]
  eventSnapshotFor(subId) {
    const out = [];
    const seen = new Set();
    for (const map of [this.activeEvents, this.carriedEvents]) {
      for (const [src, keys] of map) {
        for (const k of keys) {
          const full = `${src}:${k}`;
          if (seen.has(full) || !this.subscribed(subId, src, k) || out.length >= SNAPSHOT_MAX) continue;
          seen.add(full);
          const title = this.eventTitle(src, k);
          out.push({ plugin: src, key: k, state: "raised", ...(title ? { title } : {}) });
        }
      }
    }
    return out;
  }
  // The sanitized title of the first row carrying event=<key> in the plugin's current frame (≤ 120 graphemes). → string | null
  eventTitle(pluginId, key) {
    const st = this.plugins.get(pluginId);
    if (!st) return null;
    for (const list of [st.header, st.body]) {
      const it = (list || []).find((i) => i && i.event === key);
      if (it) return cleanPhrase(it.title) || null;
    }
    return null;
  }
}
