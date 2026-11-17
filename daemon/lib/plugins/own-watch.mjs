// PluginManager part: watching the folders of installed own plugins — fs.watch plus a reconciliation timer, the quiet
// update when permissions are the same, the folder states for the lists and /state.ownPlugins (ownInfo).
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { statSync, watch as fsWatch } from "node:fs";
import { pickLang } from "../i18n.mjs";
import { inspectSource } from "../registry/own-source.mjs";
import { contractTooNew } from "./index-format.mjs";

// Own sources: fingerprint reconciliation once a minute and folder watcher debounce.
export const OWN_DEFAULTS = Object.freeze({ checkMs: 60_000, debounceMs: 1500 });

export class ManagerOwnWatch {
  // ---------- watching own folders ----------

  startOwn(opts = {}) {
    this.ownOpts = { ...OWN_DEFAULTS, ...opts };
    this.ownStarted = true;
    clearInterval(this.ownTimer);
    this.ownTimer = setInterval(() => this.checkOwnAll("timer"), Math.max(this.ownOpts.checkMs, 100));
    this.ownTimer.unref?.();
    this.checkOwnAll("start");
  }

  stopOwn() {
    this.ownStarted = false;
    clearInterval(this.ownTimer);
    this.ownTimer = null;
    for (const t of this.ownDebounce.values()) clearTimeout(t);
    this.ownDebounce.clear();
    for (const w of this.ownWatchers.values()) {
      try {
        w.watcher?.close();
      } catch {}
    }
    this.ownWatchers.clear();
  }

  // Watchers — one per own plugin folder from lock; no folder — no watcher (timer reconciliation
  // picks it up when it appears and sets one again).
  syncOwnWatch() {
    if (!this.ownStarted) return;
    const want = new Map(Object.values(this.lock().plugins).filter((e) => e.tier === "own" && e.own?.path).map((e) => [e.id, e.own.path]));
    for (const [id, w] of this.ownWatchers) {
      if (want.get(id) === w.path && w.watcher) continue;
      try {
        w.watcher?.close();
      } catch {}
      this.ownWatchers.delete(id);
    }
    for (const [id, path] of want) {
      if (this.ownWatchers.has(id)) continue;
      let watcher = null;
      try {
        if (statSync(path).isDirectory()) {
          watcher = fsWatch(path, { recursive: true, persistent: false }, () => this.scheduleOwn(id));
          watcher.on("error", () => {
            try {
              watcher.close();
            } catch {}
            const w = this.ownWatchers.get(id);
            if (w?.watcher === watcher) w.watcher = null;
          });
        }
      } catch {
        watcher = null;
      }
      this.ownWatchers.set(id, { path, watcher });
    }
  }

  scheduleOwn(id) {
    clearTimeout(this.ownDebounce.get(id));
    const t = setTimeout(() => {
      this.ownDebounce.delete(id);
      if (this.ownStarted) this.checkOwn(id, "watch");
    }, this.ownOpts.debounceMs);
    t.unref?.();
    this.ownDebounce.set(id, t);
  }

  checkOwnAll(reason = "check") {
    for (const id of [...this.ownState.keys()]) if (this.lockEntry(id)?.tier !== "own") this.ownState.delete(id);
    // a watcher that didn't exist (no folder) or died — set it up again
    for (const [id, w] of this.ownWatchers) if (!w.watcher) this.ownWatchers.delete(id);
    this.syncOwnWatch();
    const out = {};
    for (const e of Object.values(this.lock().plugins)) if (e.tier === "own") out[e.id] = this.checkOwn(e.id, reason);
    return out;
  }

  // Reconciling an own plugin folder with the installed copy. Same content — ok; different, permission set exactly the same (including
  // loud push rules), version not older and the check passes — the new copy installs itself (while the hub is paused it waits
  // for the pause to lift); permissions grew — "update" (consent window via the "Update" button); permissions narrowed or the version is older than
  // the installed one (git checkout of an old branch) — also "update", but without a window: installed with one "Update" click;
  // lock entry not confirmed by the manager — "unverified" (only via the request window); no folder — "missing", the folder
  // fails the check, is replaced by a symlink or holds a different plugin — "broken". In the last cases the plugin runs on the
  // last copy.
  checkOwn(id, reason = "check") {
    const e = this.lockEntry(id);
    if (!e || e.tier !== "own") {
      this.ownState.delete(id);
      return null;
    }
    const prev = this.ownState.get(id) || null;
    let st;
    try {
      const src = inspectSource(e.own?.path || "", { uid: this.uid, lang: this.langNow() });
      if (src.dir !== e.own.path) st = { status: "broken", error: "own:moved" };
      else if (src.id !== id) st = { status: "broken", error: "own:id-changed" };
      else if (contractTooNew(src.meta?.contract)) st = { status: "broken", error: "own:hub-too-old", ...contractTooNew(src.meta.contract), version: src.version, fingerprint: src.fingerprint };
      else if (src.errors.length) st = { status: "broken", error: "own:lint", errors: src.errors.slice(0, 20), version: src.version, fingerprint: src.fingerprint };
      else if (!this.ownTrusted(id, e)) st = { status: "unverified", version: src.version, fingerprint: src.fingerprint };
      else if (src.fingerprint === e.sha256) st = { status: "ok", version: src.version, fingerprint: src.fingerprint };
      else {
        const prep = this.prepareOwn(e.own.path, { expectId: id, src });
        // The only place a plugin is installed with no human action. By design (see prepareOwn, samePerms): reached only for
        // an entry the manager itself approved (ownTrusted above — memory and the consent file agree), from the same real
        // folder (own:moved above), with exactly the consented permission keys, not an older version, not disabled, checks
        // passed. Anything else waits for the human in the "update" state; growth goes through the consent window.
        if (prep.needsConsent || !prep.samePerms || prep.downgrade) {
          st = { status: "update", version: src.version, fingerprint: src.fingerprint, growth: prep.growth, i18n: prep.i18n, ...(prep.downgrade ? { downgrade: true } : {}) };
        } else if (this.estop()) st = { status: "paused", version: src.version, fingerprint: src.fingerprint };
        else {
          this.commitOwn(prep, null, { auto: true });
          st = { status: "ok", version: src.version, fingerprint: src.fingerprint, updatedAt: new Date().toISOString() };
        }
      }
    } catch (err) {
      const code = err?.code || "own:error";
      st = code === "own:not-found" ? { status: "missing" } : { status: "broken", error: code, ...(err?.extra?.errors ? { errors: err.extra.errors } : {}), ...(Number.isInteger(err?.extra?.need) ? { need: err.extra.need, have: err.extra.have } : {}) };
    }
    st.checkedAt = new Date().toISOString();
    this.ownState.set(id, st);
    const sig = (x) => (x ? JSON.stringify([x.status, x.error || null, x.fingerprint || null]) : null);
    if (sig(prev) !== sig(st)) {
      if (st.status !== "ok" || (prev && prev.status !== "ok")) this.log({ type: "plugin-own-source", plugin: id, status: st.status, error: st.error || null, reason });
      this.emit({ type: "plugins.own", plugin: id, status: st.status });
      if (st.status === "missing" || st.status === "broken") {
        // remove the watcher of a vanished folder: if it reappears, timer reconciliation sets a new one
        const w = this.ownWatchers.get(id);
        if (w?.watcher) {
          try {
            w.watcher.close();
          } catch {}
          w.watcher = null;
        }
      }
      this.noteUpdates();
    }
    return st;
  }

  // For /state.ownPlugins (the plugins service, ctx.provideState): requests awaiting approval and own plugins with a
  // folder problem.
  ownInfo() {
    const lang = this.langNow();
    const problems = [];
    for (const e of Object.values(this.lock().plugins)) {
      if (e.tier !== "own") continue;
      const st = this.ownState.get(e.id);
      if (st && st.status !== "ok") problems.push({ id: e.id, title: pickLang(e.title, e.i18n, "title", lang) || e.id, status: st.status, error: st.error || null });
    }
    return { requests: this.ownRequestList(), problems };
  }
}
