// Core part: plugin output → state. The result of a standard run or a frame of a streamable plugin (with the
// frame-rate limit) is parsed, its rows become the plugin's state, events are raised and cleared, effect=/action=/href=
// become offers; the `plugin` event goes out coalesced (G9).
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { cleanPhrase, parseEffectSpec, parseOutput } from "../output.mjs";
import { argsFromTokens, validateArgs } from "../schema.mjs";
import { msg, pickLang, t } from "../i18n.mjs";
import { actionAppOnly, actionFingerprint, actionLevel, checkActionArg, inputDecls, sha } from "./action-rules.mjs";
import { effectAllowed, testTierPlugin } from "./tiers.mjs";

// After an action the plugin's next frame goes out without the coalescing wait (G9), if it comes within this time.
export const SNAPPY_MS = 2000;

export class CoreFrames {
  // The `plugin` event (G9): per plugin at most one per plugins.emitMinIntervalMs (250 ms → ≤ 4/s), the latest state
  // always arrives (a trailing timer re-reads the state when it fires). Without a wait: the first change after a quiet
  // period, the first one after an action (snappy — set by invoke) and now=true. An unchanged state is not sent.
  emitPlugin(id, { now = false } = {}) {
    const st = this.plugins.get(id);
    if (!st) return;
    const gap = this.config.plugins?.emitMinIntervalMs ?? 0;
    const t = Date.now();
    // the "after an action" pass is used up only by an event that really goes out (flushPlugin), not by an unchanged state
    const snappy = this.snappy.get(id);
    if (snappy !== undefined) {
      if (snappy >= t) now = true;
      else this.snappy.delete(id);
    }
    const last = this.emitAt.get(id) ?? -Infinity;
    if (now || !(gap > 0) || t - last >= gap) {
      this.flushPlugin(id);
      return;
    }
    if (this.emitTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.emitTimers.delete(id);
      this.flushPlugin(id);
    }, gap - (t - last));
    timer.unref?.();
    this.emitTimers.set(id, timer);
  }
  flushPlugin(id) {
    clearTimeout(this.emitTimers.get(id));
    this.emitTimers.delete(id);
    const st = this.plugins.get(id);
    if (!st) return;
    const sig = sha(JSON.stringify({ ...st, lastRunAt: null, durationMs: null }));
    if (st._sig === sig) return;
    Object.defineProperty(st, "_sig", { value: sig, enumerable: false, writable: true, configurable: true });
    this.emitAt.set(id, Date.now());
    this.snappy.delete(id);
    this.emit({ type: "plugin", plugin: this.pluginState(id), status: this.worstStatus() });
  }

  // Result of a standard run.
  applyRun(id, r) {
    if (r.timedOut) return this.pluginFailed(id, "timeout");
    if (r.overflow) return this.pluginFailed(id, "output-too-large");
    if (r.error) return this.pluginFailed(id, r.error);
    // killed by a signal (SIGSEGV, SIGABRT, SIGKILL from the system): a fragment of output is not a state of the source
    if (r.code === null && r.signal) return this.pluginFailed(id, `signal ${r.signal}`);
    this.applyFrame(id, r.stdout, { exitCode: r.code, durationMs: r.durationMs });
  }

  // A frame of a streamable plugin (lib/host.mjs). Parsing a frame and rebuilding the state is work the daemon does on its
  // only thread, so a plugin cannot make it do that without bound: per plugin at most plugins.maxFramesPerSec frames a second
  // are applied (a token bucket with a second's worth of burst — a plugin that prints a few frames in a row is not slowed
  // down). Above that the frames are coalesced: the latest one waits for the next free slot and replaces the one that waited
  // before it. The journal gets one line when frames start being dropped (plugin-throttled) and then at most one a minute
  // with the number dropped since. Standard plugins are not affected: their runs are limited by minIntervalMs.
  streamFrame(id, text, { overflow = false } = {}) {
    const rate = this.config.plugins?.maxFramesPerSec ?? 0;
    if (!(rate > 0)) return this.applyFrame(id, text, { overflow });
    const now = Date.now();
    let f = this.frameRate.get(id);
    if (!f) this.frameRate.set(id, (f = { tokens: rate, at: now, pending: null, timer: null, dropped: 0, notedAt: 0 }));
    f.tokens = Math.min(rate, f.tokens + ((now - f.at) * rate) / 1000);
    f.at = now;
    if (!f.pending && f.tokens >= 1) {
      f.tokens -= 1;
      return this.applyFrame(id, text, { overflow });
    }
    if (f.pending) {
      f.dropped++;
      if (now - f.notedAt >= 60_000) {
        this.journal.write({ type: "plugin-throttled", plugin: id, maxFramesPerSec: rate, dropped: f.dropped });
        f.notedAt = now;
        f.dropped = 0;
      }
    }
    f.pending = { text, overflow };
    if (f.timer) return;
    f.timer = setTimeout(() => this.flushFrame(id), Math.max(1, Math.ceil(((1 - f.tokens) * 1000) / rate)));
    f.timer.unref?.();
  }
  // Apply the frame that waits for its slot, if any.
  flushFrame(id) {
    const f = this.frameRate.get(id);
    if (!f) return;
    clearTimeout(f.timer);
    f.timer = null;
    const p = f.pending;
    f.pending = null;
    if (!p) return;
    const now = Date.now();
    const rate = this.config.plugins?.maxFramesPerSec || 1;
    f.tokens = Math.max(0, Math.min(rate, f.tokens + ((now - f.at) * rate) / 1000) - 1);
    f.at = now;
    this.applyFrame(id, p.text, { overflow: p.overflow });
  }

  // Plugin output frame → state.
  applyFrame(id, text, { exitCode = 0, durationMs = null, overflow = false } = {}) {
    const st = this.plugins.get(id);
    const pl = this.pluginMeta?.get(id);
    if (!st || !pl) return;
    const parsed = parseOutput(text);
    for (const w of parsed.warnings) this.warn(id, w);
    if (overflow) this.warn(id, msg("warn.frame.cut"));
    this.clearOffers(id);
    const offers = new Set();
    const sessionsSeen = new Set();
    // non-Claude agent sessions of this frame (G13): ids registered by this plugin; the rest of its entries are dropped below
    const externalSeen = new Set();
    let externalChanged = false;
    // offers placed in this frame: [{ out, offer }] — the same offer on rows with different texts is split below (task 64)
    const placed = [];
    const mapItem = (item, parentTitle = null) => {
      const out = { title: item.title, level: item.level, params: item.params };
      if (item.separator) out.separator = true;
      if (item.status) out.status = item.status;
      if (item.event) out.event = item.event;
      // the event line's href= — the banner click target (G5, pluginEventInfo); not part of /state (non-enumerable)
      if (item.event && item.href) Object.defineProperty(out, "_href", { value: item.href, enumerable: false, writable: true, configurable: true });
      const offer = this.makeOffer(pl, st, item, parentTitle);
      if (offer) {
        offers.add(offer.id);
        out.offer = {
          id: offer.id,
          kind: offer.kind,
          primitive: offer.primitive || null,
          action: offer.action?.id || null,
          level: offer.level,
          label: offer.label,
          ...(offer.appOnly ? { appOnly: true } : {}),
          // G1: the app renders a text field (placeholder in the hub language, maxLength, the plugin's pattern for a hint)
          ...(offer.input ? { input: { ...offer.input } } : {}),
          // G6: pressing starts a background job (listed in plugins[].jobs)
          ...(offer.action?.background ? { background: true } : {}),
        };
        placed.push({ out, offer });
      }
      if (item.params.session && item.params.pid) {
        const pid = Number(item.params.pid);
        const sid = String(item.params.session);
        sessionsSeen.add(sid);
        const known = this.sessionMap.get(sid);
        out.session = { id: sid, pid, verified: known && known.pid === pid ? true : null };
        // Only trusted plugins write to the shared session registry (status, tab, name — what cards are dismissed by and where "Go to
        // tab" leads): builtin, official and own. A session line from community and local is
        // only a signature check mark in their own frame.
        if (st.trusted) this.noteSession(id, sid, pid, item.params);
        else this.markSession(id, sid, pid);
      }
      if (item.params.agentSession !== undefined) {
        const r = this.noteExternal(pl, item.params);
        if (r.id) externalSeen.add(r.id);
        if (r.changed) externalChanged = true;
      }
      return out;
    };
    // each item knows its parent row's title (the nearest earlier item one level up): a child button that only repeats
    // the action's title is confirmed with its parent row's text (task 64)
    const mapList = (list) => {
      const titles = [];
      return list.map((item) => {
        const lvl = Number.isInteger(item.level) && item.level > 0 ? item.level : 0;
        titles.length = lvl;
        const out = mapItem(item, lvl > 0 ? (titles[lvl - 1] ?? null) : null);
        titles[lvl] = item.separator ? null : item.title;
        return out;
      });
    };
    st.header = mapList(parsed.header);
    st.body = mapList(parsed.body);
    this.splitSharedOffers(placed, offers);
    // activity= / needsOn=: an empty frame with an error (exit ≠ 0 with no output) is not a new state of the source: the last
    // known phrases stay (as with pluginFailed), and the verdict shows them as "failure — last: …" (lib/idle.mjs).
    // Otherwise a plugin that reported "run at 04:30" would silently drop out of the check and the card would turn green.
    if (!(parsed.empty && exitCode !== 0 && exitCode !== null)) {
      st.activity = parsed.activity ?? null;
      st.needsOn = parsed.needsOn ?? null;
      // when the phrases last arrived — "(HH:MM)" in the "not responding — last: …" line; not in the plugin state
      // (otherwise every frame would change the label and broadcast plugin)
      Object.defineProperty(st, "_signalsAt", { value: Date.now(), enumerable: false, writable: true, configurable: true });
    }
    let status = parsed.status;
    if (exitCode !== 0 && exitCode !== null) status = "error";
    st.status = status;
    st.error = exitCode !== 0 && exitCode !== null ? `exit ${exitCode}` : parsed.empty ? "empty-output" : null;
    st.lastRunAt = new Date().toISOString();
    st.durationMs = durationMs;
    this.pluginOffers.set(id, offers);
    // sessions that disappeared from the plugin output
    for (const s of [...this.sessionMap.values()]) {
      if (s.sources.includes(`plugin:${id}`) && !sessionsSeen.has(s.sessionId)) this.dropSessionSource(s.sessionId, `plugin:${id}`);
    }
    // agent sessions that disappeared from the output (or whose process ended) go too; one sessions.external event per frame
    if (this.dropExternal(id, externalSeen, { emit: false }) || externalChanged) this.emitExternal();
    const events = exitCode !== 0 && exitCode !== null ? [...parsed.events, "plugin-error"] : parsed.events;
    this.setEvents(id, events, { status });
    this.emitPlugin(id);
  }

  setEvents(pluginId, keys, { status } = {}) {
    const prev = this.activeEvents.get(pluginId) || new Set();
    const next = new Set(keys);
    // title — the sanitized text of the row carrying event=<key> (≤ 120 graphemes), when there is one: the app, the push
    // service and subscribers (G11) learn what was raised without reading the whole frame
    for (const k of next) {
      if (prev.has(k)) continue;
      const title = this.eventTitle(pluginId, k);
      this.emit({ type: "event.raised", plugin: pluginId, key: `${pluginId}:${k}`, status: status || null, ...(title ? { title } : {}) });
      this.deliverEvent(pluginId, k, "raised", title);
    }
    for (const k of prev) {
      if (next.has(k)) continue;
      this.emit({ type: "event.cleared", plugin: pluginId, key: `${pluginId}:${k}` });
      this.deliverEvent(pluginId, k, "cleared", null);
    }
    if (next.size) this.activeEvents.set(pluginId, next);
    else this.activeEvents.delete(pluginId);
    const st = this.plugins.get(pluginId);
    if (st) st.events = [...next];
  }

  // Task 64: an offer id is a hash of plugin, action and arguments, so the same button on two rows is one offer — and its
  // confirmation would name whichever row came first. Where one id sits on rows with different texts, each row text gets its
  // own offer, so the 428 names the row that was pressed and a token issued for one row does not act on another.
  // Task 79: the row text is not part of the new id — a live row text (a time in the header) or a second copy appearing would
  // change the id every frame, and an open confirmation window or banner buttons would get 404. The first row text (in frame
  // order: header, then body) keeps the base id, the n-th distinct one gets sha(id|#n). The action and arguments of all the
  // copies are identical, so whichever copy an id lands on next frame runs the same thing. offers — the frame's id set,
  // updated in place.
  splitSharedOffers(placed, offers) {
    const byId = new Map();
    for (const p of placed) {
      if (!byId.has(p.offer.id)) byId.set(p.offer.id, []);
      byId.get(p.offer.id).push(p);
    }
    for (const [id, list] of byId) {
      // distinct row texts in frame order → the id of that copy; copies with one text share it
      const ids = new Map();
      for (const p of list) {
        const row = p.offer.row ?? "";
        if (!ids.has(row)) {
          const n = ids.size;
          const nid = n === 0 ? id : sha(`${id}|#${n}`).slice(0, 16);
          // the registry holds the first copy of each text (makeOffer wrote the last copy under the base id)
          this.offers.set(nid, { ...p.offer, id: nid });
          offers.add(nid);
          ids.set(row, nid);
        }
        p.out.offer.id = ids.get(row);
      }
    }
  }

  clearOffers(pluginId) {
    for (const oid of this.pluginOffers.get(pluginId) || []) this.offers.delete(oid);
    this.pluginOffers.delete(pluginId);
  }

  // Plugin offer (effect=, action=, href=) → an entry in the offer registry or null.
  // parentTitle — the title of the row the item hangs under (null at the top level), task 64.
  makeOffer(pl, st, item, parentTitle = null) {
    let spec = null;
    if (item.action) {
      if (!st.actions.length) {
        this.warn(pl.id, msg("warn.action.unavailable", { action: item.action, source: pl.source }));
        return null;
      }
      const action = pl.meta.actions.find((a) => a.id === item.action);
      if (!action) {
        this.warn(pl.id, msg("warn.action.undeclared", { action: item.action }));
        return null;
      }
      const raw = item.params.arg;
      let args;
      let input = null;
      if (action.input) {
        // the value of an input action is typed by a human in the app (G1): the frame cannot put one in. With inputPattern=
        // (task 65) the action's arg= is a row argument: the frame binds the button to its row like any parameterized action.
        const d = inputDecls(action);
        if (d.row) {
          const v = checkActionArg(d.row, raw);
          if (v.error) {
            this.warn(pl.id, `action=${item.action}: arg ${v.error}`);
            return null;
          }
          args = { [d.row.name]: v.value };
        } else if (raw !== undefined) {
          this.warn(pl.id, msg("warn.action.inputArg", { action: item.action }));
          return null;
        }
        input = { placeholder: pickLang(action.input.placeholder, action.i18n, "input", this.lang()), maxLength: action.input.maxLength, pattern: d.text.pattern };
      } else if (action.arg) {
        const v = checkActionArg(action.arg, raw);
        if (v.error) {
          this.warn(pl.id, `action=${item.action}: arg ${v.error}`);
          return null;
        }
        args = { [action.arg.name]: v.value };
      } else if (raw !== undefined) {
        this.warn(pl.id, msg("warn.action.argUndeclared", { action: item.action }));
        return null;
      }
      const shown = args ? ` ${Object.values(args)[0]}` : "";
      const title = pickLang(action.title, action.i18n, "title", this.lang());
      spec = { kind: "action", action, args, ...(input ? { input } : {}), level: actionLevel(pl, action), appOnly: actionAppOnly(pl) || Boolean(action.input), testTier: testTierPlugin(pl), fp: actionFingerprint(pl, st.tier, action), label: title ? `${title}${shown}` : `${t(this.lang(), "action.label", { command: action.command })}${shown}` };
    } else {
      let primitive;
      let tokens;
      if (item.effect) {
        const e = parseEffectSpec(item.effect);
        if (!e) {
          this.warn(pl.id, msg("warn.effect.parse", { effect: item.effect.slice(0, 60) }));
          return null;
        }
        ({ primitive, tokens } = e);
        if (!effectAllowed(primitive, st.effects)) {
          this.warn(pl.id, msg("warn.effect.denied", { primitive }));
          return null;
        }
      } else if (item.href) {
        primitive = "open.url";
        tokens = [item.href];
      } else return null;
      const prim = this.primitives.get(primitive);
      if (!prim) {
        this.warn(pl.id, msg("warn.effect.noPrimitive", { primitive }));
        return null;
      }
      const t = argsFromTokens(prim.argsSchema, tokens);
      if (t.error) {
        this.warn(pl.id, `${primitive}: ${t.error}`);
        return null;
      }
      const v = validateArgs(prim.argsSchema, t.args, { coerce: true });
      if (v.error) {
        this.warn(pl.id, `${primitive}: ${v.error}`);
        return null;
      }
      // task 71: what the primitive would refuse on every press anyway (open.url: a scheme other than http/https —
      // message://, file:, mailto:) gets no button: a warning instead of a button that can only answer 409
      if (prim.checkOffer) {
        let c;
        try {
          c = prim.checkOffer(v.args);
        } catch {
          c = { ok: false, reason: "check-error" };
        }
        if (!c?.ok) {
          this.warn(pl.id, msg("warn.effect.refused", { primitive, reason: String(c?.reason || "rejected").slice(0, 40) }));
          return null;
        }
      }
      let label = primitive;
      try {
        label = prim.describe?.(v.args, this.facts, this.lang())?.text || primitive;
      } catch {}
      spec = { kind: "effect", primitive, args: v.args, level: prim.level, label };
    }
    const id = sha(`${pl.id}|${spec.kind}|${spec.primitive || spec.action.id}|${JSON.stringify(spec.args || {})}`).slice(0, 16);
    // G10: the row that carries the button — its title (sanitized, ≤ 120 graphemes) goes into the confirmation text. A child
    // button whose text only repeats the action's title (or is empty) is confirmed with its parent row's text (task 64): "Approve"
    // under "Request r7: wipe the cache" says what is approved. The same offer on rows with different texts is split into one
    // offer per row after the frame is mapped (splitSharedOffers).
    let row = cleanPhrase(item.title || "") || null;
    const actionTitle = spec.kind === "action" ? pickLang(spec.action.title, spec.action.i18n, "title", this.lang()) : null;
    if (parentTitle && (!row || row === spec.label || (actionTitle && row === cleanPhrase(String(actionTitle))))) row = cleanPhrase(parentTitle) || row;
    const offer = { id, pluginId: pl.id, ...spec, row };
    this.offers.set(id, offer);
    return offer;
  }
}
