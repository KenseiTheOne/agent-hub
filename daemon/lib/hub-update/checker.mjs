// Background check for hub releases (docs/hub-updates.md §2) — the same approach as plugin updates
// (lib/registry/updates.mjs: resolveTiming, backoff, long waits in parts, one notification per version).
//
// About 1 min after startup and then every 6 h (+ a spread of up to 30 min): `git ls-remote --tags <origin>` →
// the highest vX.Y.Z tag newer than the current version. Error — 5 min → 15 min → 1 h → 3 h. origin not set — no network,
// every 15 min we check whether it has been set. It installs nothing: installing only via the "Update" button (class app).
//
// Switches: config.json → services.hubUpdate.checkUpdates = false (hard) and "Check for hub updates"
// (settings.json → checkHubUpdates, written only by app). One notification per version: HubUpdate/check.json → notified.
// readyNotified lives there too — "New hub version built — waiting for a restart" (the install's ready phase), also one per version.
// Release notes are the annotated tag's message (git fetch of a single tag into a temporary mirror, no tokens):
// check.json → notes[<version>] = {object, subject, body}; re-read only when the tag object changed.
//
// A Homebrew-managed hub (brew() → the brew source directory, docs/hub-updates.md §8b) never looks at git tags: the version
// comes from VERSION (and the commit from COMMIT) in the brew tree — a local read, no network. The available version is
// read live (after `brew upgrade` the shell sees it on the next status), the timer check — every 15 min — only notifies.

import { MAX_TIMER_MS, UPDATE_DEFAULTS, resolveTiming } from "../registry/updates.mjs";
import { ensureDir, hubPaths, readJson, writeJsonAtomic } from "./layout.mjs";
import { compareVersions, tagVersion } from "../version.mjs";
import { readBrewSource } from "./brew.mjs";
import { msg } from "../i18n.mjs";
import { fetchTagNotes as defaultFetchNotes, latestRelease, listTags as defaultListTags, majorOf } from "./remote.mjs";

const MAX_NOTIFIED = 200;
const HEX40 = /^[0-9a-f]{40}$/;

// A release entry from check.json or ls-remote: the tag is exactly vVERSION (not a branch or another ref), the commit is 40 hex.
// Otherwise null: the value goes into git fetch refs/tags/<tag> and into the commit check. object — the sha of the
// annotated tag object (the notes are cached by it), a lightweight tag has none.
export function validRelease(a) {
  if (!a || typeof a !== "object" || typeof a.version !== "string" || typeof a.tag !== "string") return null;
  if (tagVersion(a.tag) !== a.version || !HEX40.test(String(a.commit || ""))) return null;
  const r = { version: a.version, tag: a.tag, commit: a.commit };
  if (HEX40.test(String(a.object || ""))) r.object = a.object;
  return r;
}
// Notes from check.json: the subject is required, everything is strings.
function validNotes(n) {
  if (!n || typeof n !== "object" || !HEX40.test(String(n.object || "")) || typeof n.subject !== "string" || !n.subject) return null;
  return { object: n.object, subject: n.subject, body: typeof n.body === "string" && n.body ? n.body : null };
}
const MAX_NOTES = 20;
// Release notes (fetching the tag, up to 4 git calls per tag) — a shared budget per check.
export const NOTES_BUDGET_MS = 15_000;
const plainMap = (m) => (m && typeof m === "object" && !Array.isArray(m) ? m : {});
const MIN = 60_000;

export class HubUpdateChecker {
  // remote() — the origin address or null; current() — the version/label to compare with; setting() — the shell's
  // setting; configAllows() — services.hubUpdate.checkUpdates; onChange() — something in info() changed.
  // maxMajorJump — how many major versions ahead to look (1: from 0.x 1.x is visible, but not 2.x and not v999).
  constructor({ home, journal = null, emit = null, onChange = null, remote = () => null, brew = () => null, current = () => "0.0.0", setting = () => true, configAllows = () => true, timing = {}, prerelease = false, maxMajorJump = 1, testMode = false, random = Math.random, now = () => Date.now(), listTags = defaultListTags, fetchNotes = defaultFetchNotes, readBrew = readBrewSource, git = undefined }) {
    this.home = home;
    this.file = hubPaths(home).check;
    this.journal = journal;
    this.emitFn = emit;
    this.onChange = onChange;
    this.remote = remote;
    this.brewFn = brew;
    this.readBrew = readBrew;
    this.current = current;
    this.setting = setting;
    this.configAllowsFn = configAllows;
    this.rawTiming = timing;
    this.prerelease = prerelease;
    this.maxMajorJump = Number.isInteger(maxMajorJump) && maxMajorJump >= 0 ? maxMajorJump : 1;
    this.testMode = testMode;
    this.random = random;
    this.now = now;
    this.listTags = listTags;
    this.fetchNotes = fetchNotes;
    this.git = git;
    this.timer = null;
    this.nextAt = null;
    this.running = null;
    this.notesJob = null;
    this.stopped = false;
    this.armed = false;
    this.failures = 0;
    this.lastError = null;
    this.store = this.load();
  }

  timing() {
    return resolveTiming(this.rawTiming, { testMode: this.testMode });
  }
  configAllows() {
    try {
      return this.configAllowsFn() !== false;
    } catch {
      return true;
    }
  }
  settingAllows() {
    try {
      return this.setting() !== false;
    } catch {
      return true;
    }
  }
  enabled() {
    return this.configAllows() && this.settingAllows();
  }
  configured() {
    if (this.brewDir()) return true;
    try {
      return typeof this.remote() === "string" && Boolean(this.remote());
    } catch {
      return false;
    }
  }
  // The Homebrew source directory or null (the hub follows git tags).
  brewDir() {
    try {
      const d = this.brewFn?.();
      return typeof d === "string" && d ? d : null;
    } catch {
      return null;
    }
  }
  // The version in the brew tree newer than the current one → {version, tag: null, commit|null, brew: true} | null.
  brewAvailable(dir = this.brewDir()) {
    if (!dir) return null;
    let s;
    try {
      s = this.readBrew(dir);
    } catch {
      return null;
    }
    if (!s?.ok) return null;
    const c = compareVersions(s.version, this.current());
    return c !== null && c > 0 ? { version: s.version, tag: null, commit: s.commit ?? null, brew: true } : null;
  }

  load() {
    const d = readJson(this.file);
    if (d && d.version === 1 && d.notified && typeof d.notified === "object" && !Array.isArray(d.notified)) {
      const commits = {};
      for (const [v, c] of Object.entries(plainMap(d.commits))) if (HEX40.test(String(c))) commits[v] = c;
      const moved = {};
      for (const [v, m] of Object.entries(plainMap(d.moved))) if (m && HEX40.test(String(m.old)) && HEX40.test(String(m.new))) moved[v] = { old: m.old, new: m.new, at: typeof m.at === "string" ? m.at : null };
      const readyNotified = {};
      for (const [v, at] of Object.entries(plainMap(d.readyNotified))) if (typeof at === "string") readyNotified[v] = at;
      const notes = {};
      for (const [v, n] of Object.entries(plainMap(d.notes))) {
        const ok = validNotes(n);
        if (ok) notes[v] = ok;
      }
      return { version: 1, notified: d.notified, checkedAt: typeof d.checkedAt === "string" ? d.checkedAt : null, latest: validRelease(d.latest), commits, moved, readyNotified, notes };
    }
    return { version: 1, notified: {}, checkedAt: null, latest: null, commits: {}, moved: {}, readyNotified: {}, notes: {} };
  }
  save() {
    try {
      const keys = Object.keys(this.store.notified);
      if (keys.length > MAX_NOTIFIED) {
        keys.sort((a, b) => String(this.store.notified[a]).localeCompare(String(this.store.notified[b])));
        for (const k of keys.slice(0, keys.length - MAX_NOTIFIED)) delete this.store.notified[k];
      }
      const ready = Object.keys(this.store.readyNotified || {});
      if (ready.length > MAX_NOTIFIED) {
        ready.sort((a, b) => String(this.store.readyNotified[a]).localeCompare(String(this.store.readyNotified[b])));
        for (const k of ready.slice(0, ready.length - MAX_NOTIFIED)) delete this.store.readyNotified[k];
      }
      ensureDir(hubPaths(this.home).dir);
      writeJsonAtomic(this.file, this.store);
    } catch (e) {
      this.log({ type: "warning", detail: msg("warn.fileNotWritten", { file: "HubUpdate/check.json", why: e.code || e.message }) });
    }
  }
  log(e) {
    try {
      this.journal?.(e);
    } catch {}
  }
  emit(ev) {
    try {
      this.emitFn?.(ev);
    } catch {}
  }
  changed() {
    try {
      this.onChange?.();
    } catch {}
  }

  // An available release relative to the current version (after a rollback the same tag is "available" again). The tag was moved to
  // another commit after the hub saw it — moved: {old, new}; installed only with explicit confirmation.
  available() {
    if (this.brewDir()) return this.brewAvailable();
    const l = validRelease(this.store.latest);
    if (!l) return null;
    const a0 = latestRelease([l], this.current(), { prerelease: true });
    if (!a0) return null;
    const { object, ...a } = a0;
    // notes only for the tag object that is in origin now (the tag was rewritten — the old ones are not shown)
    const notes = this.notesOf(a.version, object);
    if (notes) a.notes = notes;
    const m = this.store.moved?.[a.version];
    return m && m.new === a.commit ? { ...a, moved: { old: m.old, new: m.new, at: m.at ?? null } } : a;
  }

  // Release notes of a version (the annotated tag's message) → {subject, body} | null. object — the tag object's sha,
  // if known: notes of another object (the tag was rewritten) do not count.
  notesOf(version, object = undefined) {
    const n = validNotes(this.store.notes?.[version]);
    if (!n || (object !== undefined && object !== n.object)) return null;
    return { subject: n.subject, body: n.body };
  }

  // Fetch the notes of releases the hub shows (available and current) if their tag object has not been read yet.
  // An error is not a check error: a journal entry, retried on the next check.
  // budgetMs — for all notes together (each git call has its own timeout — no more than what is left): the check must not hang
  // longer than it is waited for.
  async refreshNotes(releases, { budgetMs = NOTES_BUDGET_MS } = {}) {
    if (!this.store.notes || typeof this.store.notes !== "object") this.store.notes = {};
    let changed = false;
    const until = Date.now() + budgetMs;
    for (const r of releases) {
      if (!r?.object || validNotes(this.store.notes[r.version])?.object === r.object) continue;
      const left = until - Date.now();
      if (left < 1000) {
        this.log({ type: "hub-update-notes", ok: false, version: r.version, error: "hub-update:notes-budget", detail: null });
        continue;
      }
      try {
        const n = await this.fetchNotes({ remote: this.remote(), tag: r.tag, object: r.object, dir: hubPaths(this.home).dir, timeoutMs: left, ...(this.git ? { git: this.git } : {}) });
        if (n?.subject) {
          this.store.notes[r.version] = { object: r.object, subject: n.subject, body: n.body ?? null };
          changed = true;
        }
      } catch (e) {
        this.log({ type: "hub-update-notes", ok: false, version: r.version, error: e?.code || "hub-update:notes", detail: e?.detail || null });
      }
    }
    const keys = Object.keys(this.store.notes);
    if (keys.length > MAX_NOTES) {
      const keep = new Set(releases.map((r) => r?.version));
      for (const k of keys) if (!keep.has(k) && Object.keys(this.store.notes).length > MAX_NOTES) delete this.store.notes[k];
      changed = true;
    }
    return changed;
  }

  maxMajor() {
    const m = majorOf(this.current());
    return m === null ? null : m + this.maxMajorJump;
  }

  // A human confirmed installing a moved tag (saw both commits): from now on this commit is known.
  acceptMoved(version, commit) {
    const m = this.store.moved?.[version];
    if (!m || m.new !== commit) return false;
    delete this.store.moved[version];
    this.store.commits[version] = commit;
    this.save();
    this.log({ type: "hub-update-tag-accepted", version, commit, old: m.old });
    return true;
  }

  // The tag of the same version now points to a different commit than the hub saw: journal, event (push with a banner always),
  // the version is marked moved until explicitly confirmed.
  trackCommit(rel) {
    const known = this.store.commits[rel.version];
    if (!known) {
      this.store.commits[rel.version] = rel.commit;
      const keys = Object.keys(this.store.commits);
      if (keys.length > MAX_NOTIFIED) for (const k of keys.slice(0, keys.length - MAX_NOTIFIED)) delete this.store.commits[k];
      return;
    }
    if (known === rel.commit) {
      if (this.store.moved[rel.version]) {
        delete this.store.moved[rel.version]; // the tag was moved back to the previous commit
        this.log({ type: "hub-update-tag-restored", version: rel.version, commit: rel.commit });
      }
      return;
    }
    const was = this.store.moved[rel.version];
    if (was && was.new === rel.commit) return; // already known
    const at = new Date(this.now()).toISOString();
    this.store.moved[rel.version] = { old: known, new: rel.commit, at };
    this.log({ type: "hub-update-tag-moved", version: rel.version, tag: rel.tag, old: known, new: rel.commit });
    // notify about the version the hub would offer to install; a move of an old tag — journal only
    if (latestRelease([rel], this.current(), { prerelease: true })) this.emit({ type: "hub-update.tag-moved", version: rel.version, tag: rel.tag, old: known, new: rel.commit });
  }

  info() {
    const on = this.enabled();
    const brew = this.brewDir();
    return {
      // where new versions come from: git tags in origin or the Homebrew tree (`brew upgrade agent-hub`)
      source: brew ? "brew" : "git",
      brew,
      enabled: on,
      setting: this.settingAllows(),
      config: this.configAllows(),
      configured: this.configured(),
      checkedAt: this.store.checkedAt,
      nextCheckAt: on && this.nextAt ? new Date(this.nextAt).toISOString() : null,
      error: on ? this.lastError : null,
      checking: this.inFlight === true,
      available: this.available(),
    };
  }

  // One notification per version.
  notifyNew() {
    if (!this.armed || !this.enabled() || this.stopped) return false;
    const a = this.available();
    if (!a || this.store.notified[a.version]) return false;
    this.store.notified[a.version] = new Date(this.now()).toISOString();
    this.save();
    this.log({ type: "hub-update-available", version: a.version, tag: a.tag, commit: a.commit, from: this.current() });
    this.emit({ type: "hub-update.available", version: a.version, tag: a.tag, from: this.current() });
    return true;
  }

  // A built version is waiting for a restart (ready phase): whether to notify — once per version (check.json →
  // readyNotified, survives a daemon restart and reinstalling the same version). → true — notify now.
  claimReadyNotice(label) {
    if (typeof label !== "string" || !label) return false;
    if (!this.store.readyNotified || typeof this.store.readyNotified !== "object") this.store.readyNotified = {};
    if (this.store.readyNotified[label]) return false;
    this.store.readyNotified[label] = new Date(this.now()).toISOString();
    this.save();
    return true;
  }

  start() {
    this.stopped = false;
    this.reschedule("start");
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }
  jitter(ms) {
    return ms + Math.floor(Math.max(0, Math.min(1, this.random())) * this.timing().jitterMs);
  }
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    if (this.stopped) return;
    this.nextAt = this.now() + Math.max(0, Number.isFinite(ms) ? ms : UPDATE_DEFAULTS.intervalMs);
    this.arm();
  }
  arm() {
    const left = Math.max(0, this.nextAt - this.now());
    const step = Math.min(left, MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.nextAt === null) return;
      if (this.nextAt - this.now() > 0 && step < left) return this.arm();
      this.nextAt = null;
      this.check("timer").catch(() => {});
    }, step);
    this.timer.unref?.();
  }
  reschedule(reason) {
    if (this.stopped) return;
    if (!this.enabled()) {
      clearTimeout(this.timer);
      this.timer = null;
      this.nextAt = null;
      if (this.settingAllows()) this.schedule(this.timing().unconfiguredMs);
      return;
    }
    if (this.timer && reason !== "start" && reason !== "enabled") return;
    const t = this.timing();
    this.schedule(t.firstDelayMs + Math.floor(Math.max(0, Math.min(1, this.random())) * Math.min(t.jitterMs, MIN)));
  }
  settingChanged() {
    if (this.enabled()) {
      if (!this.running) this.reschedule("enabled");
    } else {
      this.lastError = null;
      this.failures = 0;
      this.reschedule("disabled");
    }
    this.changed();
  }

  // One check. → { ok, error?, skipped?, available? }. Never throws. "Check now" (manual) runs even
  // with the shell setting off — the human asked for it; config.json = false — it does not.
  async check(reason = "manual") {
    if (this.running) return this.running;
    this.inFlight = true;
    let notesTodo = [];
    this.running = (async () => {
      const t = this.timing();
      let res;
      const manual = reason === "manual";
      if (!this.configAllows() || (!manual && !this.settingAllows())) {
        res = { ok: false, skipped: "disabled" };
        if (this.settingAllows()) this.schedule(t.unconfiguredMs);
      } else if (!this.configured()) {
        res = { ok: false, skipped: "not-configured" };
        this.schedule(t.unconfiguredMs);
      } else if (this.brewDir()) {
        res = this.checkBrew(reason, t);
      } else {
        this.changed(); // checking: true — the shell shows "Checking…"
        try {
          const tags = (await this.listTags({ remote: this.remote(), ...(this.git ? { git: this.git } : {}) })).map(validRelease).filter(Boolean);
          const best = latestRelease(tags, "0.0.0", { prerelease: this.prerelease, maxMajor: this.maxMajor() });
          const skipped = tags.filter((t) => Number.isInteger(this.maxMajor()) && majorOf(t.version) > this.maxMajor()).map((t) => t.version);
          if (skipped.length && JSON.stringify(skipped) !== JSON.stringify(this.lastSkipped || [])) this.log({ type: "hub-update-skipped", reason: "major-jump", versions: skipped.slice(0, 10), maxMajor: this.maxMajor() });
          this.lastSkipped = skipped;
          const mm = this.maxMajor();
          for (const t of tags) if ((this.prerelease || !t.version.includes("-")) && !(Number.isInteger(mm) && majorOf(t.version) > mm)) this.trackCommit(t);
          this.store.latest = best ? validRelease(best) : null;
          // notes: of the available release and of the current version (its tag may also be in origin). "Check now" is awaited by
          // the shell (45 s) — notes are fetched after the response, then changed(); a timer check — right away.
          const cur = tags.find((t) => t.version === this.current());
          notesTodo = [best, cur].filter((t) => t && t.object);
          if (!manual) {
            await this.refreshNotes(notesTodo);
            notesTodo = [];
          }
          res = { ok: true };
        } catch (e) {
          res = { ok: false, error: e?.code || "hub-update:remote", detail: e?.detail || null };
        }
        const prevError = this.lastError;
        if (res.ok) {
          this.failures = 0;
          this.lastError = null;
          this.store.checkedAt = new Date(this.now()).toISOString();
          this.save();
          if (this.enabled()) this.schedule(this.jitter(t.intervalMs));
          else this.reschedule("disabled");
        } else {
          this.failures++;
          this.lastError = res.error;
          const b = t.backoffMs[Math.min(this.failures - 1, t.backoffMs.length - 1)];
          if (this.enabled()) this.schedule(Math.min(t.intervalMs, b + Math.floor(Math.max(0, Math.min(1, this.random())) * b * 0.1)));
        }
        if (prevError !== this.lastError || reason !== "timer") {
          this.log({ type: "hub-update-check", ok: res.ok, error: res.error || null, detail: res.detail || null, reason, failures: this.failures, available: this.available()?.version ?? null });
        }
      }
      this.armed = true;
      res.available = this.available();
      return res;
    })();
    try {
      return await this.running;
    } finally {
      this.running = null;
      this.inFlight = false;
      this.changed();
      if (notesTodo.length && !this.notesJob && !this.stopped) {
        // the "new version available" notification — after the notes (push takes the release subject from available.notes)
        this.notesJob = this.refreshNotes(notesTodo)
          .then((changed) => {
            if (changed && !this.stopped) this.save();
          })
          .catch(() => {})
          .finally(() => {
            this.notesJob = null;
            this.changed();
            this.notifyNew();
          });
      } else this.notifyNew();
    }
  }

  // Homebrew mode: read the brew tree (VERSION, COMMIT) — no network. The tree is gone (the formula was uninstalled while the
  // hub stays) — hub-update:brew-missing, retried on the usual backoff. The schedule is the short one (unconfiguredMs, 15 min):
  // the check is a file read, and after `brew upgrade` the human waits for the "Update" button.
  checkBrew(reason, t) {
    const dir = this.brewDir();
    let s;
    try {
      s = this.readBrew(dir);
    } catch (e) {
      s = { ok: false, why: e?.message || String(e) };
    }
    const res = s?.ok ? { ok: true } : { ok: false, error: "hub-update:brew-missing", detail: `${dir}: ${s?.why ?? "?"}` };
    const prevError = this.lastError;
    if (res.ok) {
      this.failures = 0;
      this.lastError = null;
      this.store.checkedAt = new Date(this.now()).toISOString();
      this.save();
      if (this.enabled()) this.schedule(Math.min(t.intervalMs, t.unconfiguredMs));
      else this.reschedule("disabled");
    } else {
      this.failures++;
      this.lastError = res.error;
      const b = t.backoffMs[Math.min(this.failures - 1, t.backoffMs.length - 1)];
      if (this.enabled()) this.schedule(Math.min(t.intervalMs, b));
    }
    if (prevError !== this.lastError || reason !== "timer") {
      this.log({ type: "hub-update-check", ok: res.ok, error: res.error || null, detail: res.detail || null, reason, source: "brew", failures: this.failures, available: this.available()?.version ?? null });
    }
    return res;
  }

  // Wait for the check and the notes fetch (tests, shutdown).
  async settled() {
    while (this.running || this.notesJob) {
      try {
        await (this.running || this.notesJob);
      } catch {}
    }
  }
}
