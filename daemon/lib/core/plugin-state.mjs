// Core part: the state of each plugin as the host (lib/host.mjs) reports it — added, removed, started, exited, failed,
// relabeled, restarted on request — its labels in the hub language, and what the rest of the hub reads from it: event
// info for push, signals for the idle verdict, the worst status, the running actions.
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { CONTRACT_VERSION } from "../meta.mjs";
import { cleanAuthor } from "../author.mjs";
import { cleanPhrase, worstStatus } from "../output.mjs";
import { contentLang, contentOf, msg, pickLang } from "../i18n.mjs";
import { actionView } from "./action-rules.mjs";
import { communityPlugin, communityPushRules, pluginConnections, testTierPlugin, trustedPlugin } from "./tiers.mjs";

// The first top-level line by which a plugin explains a fault (status=unknown|error or
// event=source-broken), otherwise the first header line; null — nothing to say.
function pluginWhy(st) {
  const top = (list) => (Array.isArray(list) ? list.filter((i) => i && !i.level && !i.separator && typeof i.title === "string" && i.title.trim()) : []);
  const all = [...top(st.header), ...top(st.body)];
  const hit = all.find((i) => i.status === "unknown" || i.status === "error" || i.event === "source-broken") ?? top(st.header)[0];
  return hit ? hit.title.trim().slice(0, 160) : null;
}

export class CorePluginState {
  // ---------- plugin state ----------
  pluginAdded(pl) {
    this.plugins.set(pl.id, {
      id: pl.id,
      source: pl.source,
      tier: pl.granted?.tier || (pl.source === "builtin" ? "builtin" : pl.source === "local" ? "local" : "community"),
      trusted: trustedPlugin(pl),
      official: pl.granted?.official === true,
      // G19: the registry an installed plugin came from (registryLabel — null with only the default registry)
      ...(pl.granted?.registry ? { registry: pl.granted.registry, registryLabel: pl.granted.registryLabel ?? null } : {}),
      file: pl.file,
      type: pl.meta.type,
      title: pl.meta.title || pl.id,
      desc: pl.meta.desc || null,
      version: pl.meta.version,
      // author from metadata (<agenthub.author.name>, <agenthub.author.github>): the name is shown first
      author: cleanAuthor(pl.meta.author),
      interval: pl.interval,
      schedule: pl.meta.schedule,
      effects: pl.granted.effects,
      actions: pl.granted.actions ? pl.meta.actions.map((a) => actionView(pl, a)) : [],
      // Push rules from <agenthub.push> — trusted plugins (builtin, official and own) as declared; community (G3) — only
      // kind="plugin" rules, without escalation (communityPushRules): the banner gets the reviewed label and the row text.
      pushRules: trustedPlugin(pl) ? (pl.meta.push || []).map(({ wasDeclared, ...r }) => ({ ...r })) : communityPlugin(pl) ? communityPushRules(pl.meta.push) : [],
      // Background jobs running now (<agenthub.action background="true">, G6): [{id, actionId, title, startedAt, pid}].
      jobs: [],
      ...(testTierPlugin(pl) ? { testTier: true } : {}),
      // Contract 2: icon (<agenthub.icon>; none — the shell draws a neutral one), minimum contract version
      // (1 — not declared), connections (<agenthub.connection>, trusted only; the oauth service handles sign-in).
      icon: pl.meta.icon ? { ...pl.meta.icon } : null,
      contract: pl.meta.contract || 1,
      connections: [],
      status: "unknown",
      header: [],
      body: [],
      events: [],
      // activity= / needsOn= of the header (the "is it safe to shut down" verdict, lib/idle.mjs): null — the plugin does not report,
      // [] — reports that all is quiet, otherwise phrases
      activity: null,
      needsOn: null,
      lastRunAt: null,
      durationMs: null,
      error: null,
      pid: null,
    });
    this.pluginMeta.set(pl.id, pl);
    this.restarting.delete(pl.id);
    const carried = this.carriedEvents.get(pl.id);
    if (carried) {
      this.carriedEvents.delete(pl.id);
      this.activeEvents.set(pl.id, carried);
      this.plugins.get(pl.id).events = [...carried];
    }
    const conns = pluginConnections(pl);
    for (const r of conns.rejected) this.journal.write({ type: "connection-rejected", plugin: pl.id, connection: r.id, why: r.why });
    this.plugins.get(pl.id).connections = conns.list.map((c) => ({ id: c.id, title: c.title || null, note: c.note || null, url: c.url, host: c.host, hosts: c.hosts, scope: c.scope, tools: c.tools, ...(c.writes?.length ? { writes: c.writes } : {}), intervalMs: c.intervalMs, budget: c.budget, tier: c.tier, ...(c.type === "http" ? { type: "http", http: c.http } : {}) }));
    if (pl.meta.contract && pl.meta.contract > CONTRACT_VERSION) this.journal.write({ type: "plugin-contract-newer", plugin: pl.id, need: pl.meta.contract, have: CONTRACT_VERSION });
    // event subscriptions (G11): before inst.start() — the snapshot goes out when the stream process starts (pluginStarted)
    const subs = this.subscriptionsFor(pl);
    if (subs.length) this.subscriptions.set(pl.id, subs);
    else this.subscriptions.delete(pl.id);
    this.localizePlugin(pl.id, { emit: false });
    this.journal.write({ type: "plugin-add", plugin: pl.id, source: pl.source });
    this.emitPlugin(pl.id);
    this.pinLegacyToggles(pl.id);
  }
  // Plugin labels from metadata — in the effective language (the lang="xx" variant or as is).
  localizePlugin(id, { emit = true } = {}) {
    const st = this.plugins.get(id);
    const pl = this.pluginMeta.get(id);
    if (!st || !pl) return;
    const lang = this.lang();
    const i18n = pl.meta.i18n || {};
    st.title = pickLang(pl.meta.title || pl.id, i18n, "title", lang);
    st.desc = pickLang(pl.meta.desc || null, i18n, "desc", lang);
    st.lang = lang;
    const labels = {};
    for (const [k, v] of Object.entries(pl.meta.statuses || {})) labels[k] = { ...v, ...(contentOf(i18n, lang, { field: "statuses" }).statuses?.[k] || {}) };
    for (const [k, v] of Object.entries(contentOf(i18n, lang, { field: "statuses" }).statuses || {})) labels[k] ||= v;
    st.statusLabels = labels;
    for (const a of st.actions) {
      const src = pl.meta.actions.find((x) => x.id === a.id);
      if (src) a.title = pickLang(src.title, src.i18n, "title", lang);
      if (src?.input && a.input) a.input.placeholder = pickLang(src.input.placeholder, src.i18n, "input", lang);
    }
    st.pushRules = st.pushRules.map((r) => ({ ...r, label: r.labels?.[contentLang(r.labels ? Object.fromEntries(Object.entries(r.labels).map(([k, v]) => [k, { label: v }])) : null, lang, { field: "label" })] || (pl.meta.push || []).find((x) => x.key === r.key)?.label || r.label }));
    // connection name and description — in the hub language (a tag with lang="xx" and the same id)
    for (const c of st.connections || []) {
      const src = (pl.meta.connections || []).find((x) => (x.id || pl.id) === c.id);
      const tr = contentOf(i18n, lang, { field: "connections" }).connections?.[src?.id || ""] || {};
      c.title = tr.title || src?.title || null;
      c.note = tr.note || src?.note || null;
    }
    if (emit) this.emitPlugin(id);
  }
  // keepEvents — the host restarts the plugin with the same id (the file or the policy changed): raised events are not
  // cleared but carried over to the new instance (pluginAdded), and its first frame reconciles them as usual. Otherwise every
  // restart would clear and re-raise "session is waiting" and the like — and push would be sent again. If it is not added
  // back (the policy rejected it), finishCarried clears them.
  pluginRemoved(id, { keepEvents = false } = {}) {
    this.clearOffers(id);
    clearTimeout(this.emitTimers.get(id));
    this.emitTimers.delete(id);
    this.emitAt.delete(id);
    this.snappy.delete(id);
    // jobs die with the plugin instance: removed, disabled, updated or its policy changed (G6). Not on a streamable restart
    // (language, pause, secret) — that does not remove the plugin.
    this.killJobs(id, keepEvents ? "plugin-restarted" : "plugin-removed");
    // the next instance hears about its own jobs only: nothing carried over from this one (B1, B6)
    this.pendingJobExits.delete(id);
    this.backlogNoted.delete(id);
    // a frame of this instance still waiting for its turn is not a state of the next one
    clearTimeout(this.frameRate.get(id)?.timer);
    this.frameRate.delete(id);
    // restart (the same id is still on disk): services must not treat it as removal (the oauth service does not abort
    // an ongoing sign-in and does not reset its cache); if it is not added back, finishCarried reports plugin.removed without restart
    if (keepEvents) this.restarting.add(id);
    else this.restarting.delete(id);
    if (keepEvents && this.activeEvents.has(id)) {
      this.carriedEvents.set(id, this.activeEvents.get(id));
      this.activeEvents.delete(id);
    } else this.setEvents(id, []);
    this.plugins.delete(id);
    this.pluginMeta?.delete(id);
    for (const s of [...this.sessionMap.values()]) if (s.sources.includes(`plugin:${id}`)) this.dropSessionSource(s.sessionId, `plugin:${id}`);
    this.subscriptions.delete(id);
    this.subscribeRate.delete(id);
    this.dropExternal(id, new Set());
    this.journal.write({ type: "plugin-remove", plugin: id });
    this.emit({ type: "plugin.removed", plugin: id, ...(keepEvents ? { restart: true } : {}) });
  }
  // Events of restarted plugins that the host never added back — clear them.
  finishCarried() {
    for (const [id, keys] of [...this.carriedEvents]) {
      this.carriedEvents.delete(id);
      this.activeEvents.set(id, keys);
      this.setEvents(id, []);
    }
    // the restart did not happen (the policy rejected it, the file disappeared) — now this is a removal
    for (const id of [...this.restarting]) {
      this.restarting.delete(id);
      if (!this.plugins.has(id)) this.emit({ type: "plugin.removed", plugin: id });
    }
  }
  pluginStarted(id, pid) {
    this.streamStarted(id, pid);
    const st = this.plugins.get(id);
    if (st) st.pid = pid;
    // a subscriber's stream process (re)started (G11): the events raised right now that it subscribed to, as one message
    if (st && this.subscriptions.has(id)) this.host.send(id, { type: "eventSnapshot", events: this.eventSnapshotFor(id) });
    // the jobs running now and the jobExit messages it missed while it had no process (B1)
    if (st) this.sendJobState(id);
  }
  pluginExited(id, { code, signal, error }) {
    // the last frame it printed, if it was held back by the rate limit, is applied before the failure — not after it
    this.flushFrame(id);
    const st = this.plugins.get(id);
    if (!st) return;
    st.pid = null;
    this.journal.write({ type: "plugin-exit", plugin: id, code, signal, error });
    this.pluginFailed(id, error || `exit ${code ?? signal}`);
  }
  pluginFailed(id, reason) {
    const st = this.plugins.get(id);
    if (!st) return;
    st.status = "error";
    st.error = String(reason).slice(0, 200);
    st.lastRunAt = new Date().toISOString();
    // Known plugin events are not cleared: a process failure is not a new state of the source. Otherwise every
    // streamable restart or timeout would clear and re-raise, for example, "session is waiting" and "spoofing
    // marker", and push would be sent again. The next successful frame clears them.
    this.setEvents(id, [...(this.activeEvents.get(id) || []), "plugin-error"], { status: "error" });
    this.emitPlugin(id);
  }
  pluginState(id) {
    const st = this.plugins.get(id);
    return st ? structuredClone(st) : null;
  }
  pluginStates() {
    return [...this.plugins.values()].map((s) => structuredClone(s));
  }
  // Info for the event text (push service) — without a copy of the whole state: title, trust, error, own
  // push rules and the title of the row with event=<key>. → null if there is no such plugin.
  pluginEventInfo(id, key) {
    const st = this.plugins.get(id);
    if (!st) return null;
    let itemTitle = null;
    let actions = [];
    let href = null;
    for (const list of [st.header, st.body]) {
      const i = (list || []).findIndex((x) => x && x.event === key);
      if (i < 0) continue;
      const it = list[i];
      itemTitle = it.title || null;
      // G5: banner buttons — offers of the line's direct children (up to 2, no typed-input ones: a banner has no text field),
      // and the line's href= as the click target, checked like open.url. The push engine decides whether the banner shows them.
      for (let j = i + 1; j < list.length && actions.length < 2; j++) {
        const c = list[j];
        if (!c || c.level <= it.level) break;
        if (c.level !== it.level + 1 || c.separator || !c.offer?.id || c.offer.input) continue;
        actions.push({ offer: c.offer.id, label: cleanPhrase(c.title || "") || c.offer.label || c.offer.id, level: c.offer.level });
      }
      href = this.bannerHref(it._href);
      break;
    }
    return {
      id: st.id,
      title: st.title,
      trusted: st.trusted === true,
      error: st.error,
      itemTitle,
      actions,
      href,
      // community (G3): its kind="plugin" rules without escalation (communityPushRules) — the push engine shows the label and the
      // row text but keeps the untrusted limits
      pushRules: Array.isArray(st.pushRules) && (st.trusted === true || (st.tier === "community" && st.pushRules.length)) ? st.pushRules.map((r) => ({ ...r })) : null,
    };
  }
  // A banner click target (G5): the event line's href= when open.url would accept it (http/https, no credentials). → string | null
  bannerHref(raw) {
    if (typeof raw !== "string" || !raw || raw.length > 4096) return null;
    const prim = this.primitives.get("open.url");
    try {
      if (prim) return prim.verifyFacts({ url: raw }, this.facts, {})?.ok === true ? new URL(raw).href : null;
      const u = new URL(raw);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.href : null;
    } catch {
      return null;
    }
  }
  worstStatus() {
    return worstStatus([...this.plugins.values()].map((s) => s.status));
  }
  // What plugins report for the "is it safe to shut down" verdict (lib/idle.mjs) — without copying frames.
  // trusted — phrases of a builtin or official plugin (without the name prefix, fit for a card title);
  // type, intervalMs, lastRunAt, signalsAt — to notice a plugin that went silent (lib/idle.mjs, stale).
  pluginSignals() {
    return [...this.plugins.values()].map((s) => {
      const meta = this.pluginMeta?.get(s.id);
      return {
        id: s.id,
        title: s.title,
        tier: s.tier,
        trusted: s.trusted === true,
        status: s.status,
        type: s.type || "standard",
        intervalMs: meta && !meta.meta?.schedule && Number.isFinite(meta.intervalMs) ? Math.max(meta.intervalMs, this.config.plugins?.minIntervalMs || 0) : null,
        lastRunAt: s.lastRunAt ? Date.parse(s.lastRunAt) : null,
        signalsAt: s._signalsAt ?? null,
        activity: s.activity ? [...s.activity] : null,
        needsOn: s.needsOn ? [...s.needsOn] : null,
        // failure of the plugin itself (exit ≠ 0, timeout, empty output); null — the plugin ran, even if status=error
        // (that is a domain error like "a task failed", not "the plugin is broken")
        error: s.error ?? null,
        // what the plugin itself says about its fault: a top-level line with status=unknown/error or
        // event=source-broken, otherwise the first header line (for "Don't know about sessions: …")
        why: pluginWhy(s),
      };
    });
  }
  // Plugin actions running now (POST /actions/:id → runAction): [{action, plugin, title, since}] and background jobs
  // ({…, job, background: true}, G6) — the idle verdict counts both.
  runningActionList() {
    return [...[...this.runningActions.values()].map((a) => ({ ...a })), ...[...this.jobs.values()].map((j) => ({ action: j.actionId, plugin: j.plugin, title: j.title, since: j.startedAt, job: j.id, background: true }))];
  }
  // Only the registry's display label of a running plugin changed (a second registry was added, B7): the state follows it.
  pluginRelabeled(id, granted) {
    const st = this.plugins.get(id);
    if (!st || !granted?.registry) return;
    st.registry = granted.registry;
    st.registryLabel = granted.registryLabel ?? null;
    this.emitPlugin(id, { now: true });
  }

  // ---------- restarting one plugin (G8) ----------
  // A service changed something the plugin's environment is built from (a secret written in the app): a streamable plugin is
  // restarted with a fresh environment (it gets {"type":"stopping","reason":"restart","cause":reason} first), a standard one gets
  // an extra run. reason — AGENTHUB_REFRESH_REASON ([A-Z][A-Za-z]{1,31}, e.g. "SecretChanged"). Background jobs are not touched.
  // → Promise<boolean> (false — no such running plugin).
  async restartPlugin(id, reason = "Manual") {
    if (typeof reason !== "string" || !/^[A-Z][A-Za-z]{1,31}$/.test(reason)) throw new Error(msg("err.restart.reason"));
    if (!this.plugins.has(id)) return false;
    this.journal.write({ type: "plugin-restart", plugin: id, reason });
    return this.host.restartPlugin(id, reason);
  }
}
