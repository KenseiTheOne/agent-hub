// Core part: the processes plugins leave running — background jobs (G6: start, the job table, exit, cancel, kill,
// jobs.json and the orphans of a dead daemon) and the processes of streamable plugins across daemon lives
// (streams.json, the stdin backlog).
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "../platform.mjs";
import { writeJsonAtomic } from "../statefile.mjs";
import { inputDecls } from "./action-rules.mjs";
import { SNAPPY_MS } from "./frames.mjs";

// A cancelled or orphaned background job: SIGTERM, then SIGKILL after this long (G6); if its end is still not reported this long
// after the SIGKILL, the job is ended as "orphaned" (B2).
export const JOB_KILL_GRACE_MS = 2000;
// jobExit messages kept for a streamable plugin while it has no process to write to (a restart, B1).
const PENDING_JOB_EXITS_MAX = 50;

export class CoreJobs {
  // The daemon stops: background jobs do not outlive it (their process groups are separate) — SIGTERM, up to a second to exit,
  // then SIGKILL.
  async stopAllJobs() {
    const jobs = [...this.jobs.values()];
    if (!jobs.length) return;
    for (const j of jobs) {
      j.cancelled ||= "shutdown";
      j.kill("SIGTERM");
    }
    const until = Date.now() + 1000;
    while (jobs.some((j) => this.jobs.has(j.id)) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    for (const j of jobs) if (this.jobs.has(j.id)) j.kill("SIGKILL");
    for (const j of jobs) {
      clearTimeout(j.killTimer);
      clearTimeout(j.forceTimer);
    }
  }

  // ---------- background jobs (G6) ----------
  maxJobs() {
    const n = this.config.plugins?.maxJobsPerPlugin;
    return Number.isInteger(n) && n > 0 ? n : 4;
  }
  jobsOf(pluginId) {
    return [...this.jobs.values()].filter((j) => j.plugin === pluginId);
  }
  // Running jobs plus those being started right now (B5): the per-plugin limit counts both. Jobs of a removed or updated
  // instance (detached, being killed — task 67) are not counted (task 84): the new instance's job list is empty, so a limit
  // reached by them would refuse a press with nothing to show; they end within two kill grace periods anyway.
  jobsCount(pluginId) {
    return this.jobsOf(pluginId).filter((j) => !j.detached).length + (this.jobsStarting.get(pluginId) || 0);
  }
  // Metadata of the jobs (the jobs fact, /state.plugins[].jobs): no kill handles. For one plugin (its /state entry and the
  // {"type":"jobs"} message) only the jobs of its current instance: a job of a removed or updated instance is being killed
  // (task 67) — the new instance never hears its jobExit, so it must not hear of it at all. The full list (no pluginId) keeps
  // them while their processes live.
  jobList(pluginId = null) {
    return [...this.jobs.values()].filter((j) => !pluginId || (j.plugin === pluginId && !j.detached)).map((j) => ({ id: j.id, plugin: j.plugin, actionId: j.actionId, title: j.title, startedAt: j.startedAt, pid: j.pid }));
  }
  // Start a background action (invoke step 6). → the action result: {ok: true, job, pid} | {ok: false, error}
  // The slot is reserved before the first await (B5): two presses at once cannot both pass the limit while the keychain answers.
  async startJob(inst, target, title) {
    const pluginId = target.offer.pluginId;
    if (this.jobsCount(pluginId) >= this.maxJobs()) return { ok: false, error: "jobs-limit" };
    this.jobsStarting.set(pluginId, (this.jobsStarting.get(pluginId) || 0) + 1);
    const jobId = randomBytes(8).toString("hex");
    let r;
    try {
      r = await inst.runAction(target.action, inputDecls(target.action).row ? target.argValue : null, {
        input: target.input ?? null,
        background: true,
        onJobExit: (x) => this.jobExited(jobId, x),
      });
    } finally {
      const n = (this.jobsStarting.get(pluginId) || 1) - 1;
      if (n > 0) this.jobsStarting.set(pluginId, n);
      else this.jobsStarting.delete(pluginId);
    }
    if (!r?.ok || !r.job) return { ok: false, error: r?.error || "spawn" };
    // the process start time: after a daemon crash the next daemon kills the group only if this very process still runs (B3)
    const startSec = this.processStartSec(r.job.pid);
    const job = { id: jobId, plugin: pluginId, actionId: target.action.id, title: this.jobTitle(pluginId, title, target), startedAt: new Date().toISOString(), pid: r.job.pid, startSec, kill: r.job.kill, inst, started: Date.now() };
    this.jobs.set(jobId, job);
    this.persistJobs();
    this.syncJobs(pluginId);
    this.journal.write({ type: "job-start", plugin: pluginId, actionId: job.actionId, job: jobId, pid: job.pid });
    this.emit({ type: "job.started", plugin: pluginId, actionId: job.actionId, job: jobId, pid: job.pid });
    return { ok: true, job: jobId, pid: job.pid };
  }
  // A job's title (task 73): the action's title plus its row argument ("Start dev server web"); if a running job of the plugin
  // already has that title, the start time is added ("Long (14:05:31)", "Long (14:05:31 #2)" within one second) — two running
  // jobs are never shown the same.
  jobTitle(pluginId, title, target) {
    const arg = inputDecls(target.action).row && target.argValue != null ? ` ${target.argValue}` : "";
    let out = `${title}${arg}`.slice(0, 200);
    if (this.jobList(pluginId).some((j) => j.title === out)) {
      const d = new Date();
      const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
      const base = `${out.slice(0, 180)} (${hms}`;
      out = `${base})`;
      // started within the same second
      for (let n = 2; this.jobList(pluginId).some((j) => j.title === out); n++) out = `${base} #${n})`;
    }
    return out;
  }
  // /state.plugins[].jobs follows the job table; the change goes out at once (not coalesced).
  syncJobs(pluginId) {
    const st = this.plugins.get(pluginId);
    if (!st) return;
    st.jobs = this.jobList(pluginId).map(({ plugin, ...j }) => j);
    this.emitPlugin(pluginId, { now: true });
  }
  jobExited(jobId, x) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    this.persistJobs();
    clearTimeout(job.killTimer);
    clearTimeout(job.forceTimer);
    const ok = x.code === 0 && !job.cancelled;
    this.journal.write({ type: "job-exit", plugin: job.plugin, actionId: job.actionId, job: jobId, ok, code: x.code ?? null, signal: x.signal ?? null, ms: Date.now() - job.started, ...(job.cancelled ? { cancelled: job.cancelled } : {}), ...(x.reason ? { reason: x.reason } : {}), ...(x.error ? { error: String(x.error).slice(0, 80) } : {}) });
    this.emit({ type: "job.exited", plugin: job.plugin, actionId: job.actionId, job: jobId, ok, code: x.code ?? null, signal: x.signal ?? null, ...(job.cancelled ? { cancelled: job.cancelled } : {}) });
    // the same plugin instance is still running: it hears about the end (a removed or restarted one does not)
    if (this.host.get(job.plugin) !== job.inst || !this.plugins.has(job.plugin)) return;
    this.syncJobs(job.plugin);
    this.snappy.set(job.plugin, Date.now() + SNAPPY_MS);
    if (this.plugins.get(job.plugin)?.type === "streamable") {
      const m = {
        type: "jobExit",
        job: jobId,
        actionId: job.actionId,
        ok,
        code: x.code ?? null,
        signal: x.signal ?? null,
        durationMs: x.durationMs ?? Date.now() - job.started,
        ...(job.cancelled ? { cancelled: job.cancelled } : {}),
        ...(x.reason ? { reason: x.reason } : {}),
        ...(x.message ? { message: x.message } : {}),
      };
      // no process to write to (the stream is restarting: language, pause, secret) — kept until it starts again (B1)
      if (!this.host.send(job.plugin, m)) {
        const q = this.pendingJobExits.get(job.plugin) || [];
        if (q.length < PENDING_JOB_EXITS_MAX) q.push(m);
        this.pendingJobExits.set(job.plugin, q);
      }
    } else this.host.refresh(job.plugin, "JobExit");
  }
  // A streamable process (re)started (B1): what it may have missed — the jobs running now ({"type":"jobs","running":[…]}, for a plugin
  // with background actions) and the jobExit messages that came while it had no process.
  sendJobState(id) {
    const pending = this.pendingJobExits.get(id) || [];
    this.pendingJobExits.delete(id);
    const hasJobs = Boolean(this.pluginMeta.get(id)?.meta?.actions?.some((a) => a.background)) || this.jobList(id).length > 0;
    if (hasJobs) this.host.send(id, { type: "jobs", running: this.jobList(id).map(({ plugin, ...j }) => j) });
    for (const m of pending) this.host.send(id, m);
  }
  // SIGTERM, SIGKILL after jobKillGraceMs; if the end is still not reported jobKillGraceMs after that (B2: kill() cannot reach the
  // process any more), the job is ended as orphaned — it must not hang in the table and in "Can I shut down?" forever.
  stopJob(job, why) {
    if (job.cancelled) return;
    job.cancelled = why;
    job.kill("SIGTERM");
    job.killTimer = setTimeout(() => {
      job.kill("SIGKILL");
      job.forceTimer = setTimeout(() => this.jobExited(job.id, { code: null, signal: null, reason: "orphaned" }), this.jobKillGraceMs);
      job.forceTimer.unref?.();
    }, this.jobKillGraceMs);
    job.killTimer.unref?.();
  }
  // Stop every job of a plugin (removed, disabled, updated): SIGTERM, SIGKILL after JOB_KILL_GRACE_MS.
  // The instance is gone (removed, disabled, updated, policy changed): its jobs are detached from the plugin id (task 67) and
  // stopped; they stay in the table (the idle verdict, jobs.json) until their processes end — not in the new instance's
  // per-plugin limit (jobsCount, task 84).
  killJobs(pluginId, why) {
    for (const job of this.jobsOf(pluginId)) {
      job.detached = true;
      this.stopJob(job, why);
    }
  }
  // The start time (seconds) of a live process, or null when it cannot be learned (no peercred addon).
  processStartSec(pid) {
    const sys = this.peer?.sys;
    if (!sys?.available || typeof sys.pidInfo !== "function" || !Number.isInteger(pid) || pid <= 1) return null;
    try {
      const info = sys.pidInfo(pid);
      return Number.isFinite(info?.startSec) ? info.startSec : null;
    } catch {
      return null;
    }
  }
  // <home>/jobs.json (0600): the running jobs, rewritten on every start and end (B3). Job groups are detached from the daemon,
  // so a crashed daemon leaves them running; the next one reads this file (reapOrphanJobs).
  jobsFile() {
    return join(this.config.paths.home, "jobs.json");
  }
  persistJobs() {
    const jobs = [...this.jobs.values()].map((j) => ({ job: j.id, plugin: j.plugin, actionId: j.actionId, pid: j.pid, pgid: j.pid, startSec: j.startSec ?? null }));
    try {
      writeJsonAtomic(this.jobsFile(), { jobs }, { mode: 0o600 });
    } catch (e) {
      this.journal.write({ type: "jobs-persist-error", detail: String(e.message).slice(0, 120) });
    }
  }
  // A process group recorded by a previous daemon: is it provably still that process? The leader must be alive with the
  // recorded start time — a pid since reused by another process is left alone, and without a start time (no peercred addon)
  // nothing is ever killed. → "unverified" (the record cannot be checked) | "gone" | "alive"
  orphanState(e) {
    if (!e || !Number.isInteger(e.pid) || e.pid <= 1 || e.pid === process.pid || !Number.isFinite(e.startSec)) return "unverified";
    const now = this.processStartSec(e.pid);
    return now === null || now !== e.startSec ? "gone" : "alive";
  }
  // The platform layer: the process group on POSIX, the process tree on Windows.
  signalOrphan(e, sig) {
    killTree({ pid: Number.isInteger(e.pgid) && e.pgid > 1 ? e.pgid : e.pid }, sig);
  }
  // Daemon start (B3): job groups left by a daemon that died without stopping them. A group is killed (SIGTERM, SIGKILL a second
  // later) only when it is provably the same process (orphanState). Journaled as job-orphan-killed / job-orphan-skipped.
  reapOrphanJobs() {
    const saved = this.readState(this.jobsFile());
    if (saved === undefined) {
      // a damaged file (its copy is kept as jobs.json.bad) is replaced by the current table; no file — nothing to do
      if (existsSync(this.jobsFile())) this.persistJobs();
      return;
    }
    const entries = Array.isArray(saved?.jobs) ? saved.jobs.slice(0, 200) : [];
    for (const e of entries) {
      const state = this.orphanState(e);
      if (state === "unverified") {
        this.journal.write({ type: "job-orphan-skipped", plugin: typeof e?.plugin === "string" ? e.plugin.slice(0, 64) : null, pid: Number.isInteger(e?.pid) ? e.pid : null, reason: "unverified" });
        continue;
      }
      if (state === "gone") continue; // gone, or the pid belongs to another process now
      this.signalOrphan(e, "SIGTERM");
      const later = setTimeout(() => {
        if (this.processStartSec(e.pid) === e.startSec) this.signalOrphan(e, "SIGKILL");
      }, 1000);
      later.unref?.();
      this.journal.write({ type: "job-orphan-killed", plugin: typeof e.plugin === "string" ? e.plugin.slice(0, 64) : null, job: typeof e.job === "string" ? e.job.slice(0, 16) : null, actionId: typeof e.actionId === "string" ? e.actionId.slice(0, 64) : null, pid: e.pid });
    }
    this.persistJobs();
  }

  // ---------- streamable plugin processes across daemon lives ----------
  // A streamable plugin runs in its own process group, like a job: a daemon that dies without stopping it (SIGKILL, a crash)
  // leaves it running, and the next daemon would start a second copy next to it. So the live ones are recorded in
  // <home>/streams.json (0600) — {streams: [{plugin, pid, pgid, startSec}]}, rewritten on every start and exit — and the next
  // daemon stops what is left (reapOrphanStreams), with the same "provably the same process" guard as for jobs.
  streamsFile() {
    return join(this.config.paths.home, "streams.json");
  }
  persistStreams() {
    const streams = [...this.streams.values()].map((x) => ({ plugin: x.plugin, pid: x.pid, pgid: x.pid, startSec: x.startSec ?? null }));
    try {
      writeJsonAtomic(this.streamsFile(), { streams }, { mode: 0o600 });
    } catch (e) {
      this.journal.write({ type: "streams-persist-error", detail: String(e.message).slice(0, 120) });
    }
  }
  // A streamable process started (lib/host.mjs → pluginStarted) / is gone with its whole group (StreamProcess onGone).
  streamStarted(id, pid) {
    if (!Number.isInteger(pid) || pid <= 1) return;
    this.streams.set(pid, { plugin: id, pid, startSec: this.processStartSec(pid) });
    this.persistStreams();
  }
  streamGone(pid) {
    if (this.streams.delete(pid)) this.persistStreams();
  }
  // Daemon start: streamable processes of a daemon that died without stopping them. SIGTERM to each provable leftover, SIGKILL
  // to the ones still there a second later. → a promise that resolves when they are gone (init waits for it before plugins
  // start, so a plugin never runs twice). Journaled as stream-orphan-killed / stream-orphan-skipped.
  reapOrphanStreams() {
    const saved = this.readState(this.streamsFile());
    if (saved === undefined) {
      if (existsSync(this.streamsFile())) this.persistStreams();
      return Promise.resolve();
    }
    const entries = Array.isArray(saved?.streams) ? saved.streams.slice(0, 500) : [];
    const killed = [];
    for (const e of entries) {
      const plugin = typeof e?.plugin === "string" ? e.plugin.slice(0, 64) : null;
      const state = this.orphanState(e);
      if (state === "unverified") {
        this.journal.write({ type: "stream-orphan-skipped", plugin, pid: Number.isInteger(e?.pid) ? e.pid : null, reason: "unverified" });
        continue;
      }
      if (state === "gone") continue;
      this.signalOrphan(e, "SIGTERM");
      this.journal.write({ type: "stream-orphan-killed", plugin, pid: e.pid });
      killed.push(e);
    }
    this.persistStreams();
    if (!killed.length) return Promise.resolve();
    return (async () => {
      const until = Date.now() + 1000;
      const left = () => killed.filter((e) => this.processStartSec(e.pid) === e.startSec);
      while (left().length && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      for (const e of left()) this.signalOrphan(e, "SIGKILL");
      const hard = Date.now() + 500;
      while (left().length && Date.now() < hard) await new Promise((r) => setTimeout(r, 25));
    })();
  }
  // The daemon is crashing (uncaughtException, bin/agenthubd): a synchronous signal to every streamable process group. The ones
  // that ignore it stay in streams.json for the next daemon.
  killStreamsSync(signal = "SIGTERM") {
    for (const x of this.streams.values()) {
      try {
        killTree({ pid: x.pid }, signal);
      } catch {}
    }
  }
  // The daemon is crashing (uncaughtException, bin/agenthubd): no time for stopAllJobs — a synchronous signal to every job group.
  // jobs.json stays as it is: a job that ignores SIGTERM is killed by the next daemon (reapOrphanJobs).
  killJobsSync(signal = "SIGTERM") {
    for (const j of this.jobs.values()) {
      try {
        j.kill(signal);
      } catch {}
    }
  }
  // A streamable plugin's stdin is full (B6): its messages are dropped until it reads again; the journal hears once a minute.
  stdinBacklog(id) {
    const at = this.backlogNoted.get(id) || 0;
    if (Date.now() - at < 60_000) return;
    this.backlogNoted.set(id, Date.now());
    this.journal.write({ type: "stdin-backlog", plugin: id });
  }
  // The job.cancel primitive (app only). Not under the pause: setting it already stops every job (setPaused → stopJob "paused")
  // and no action can start one while paused, so job.cancel, like every app-only primitive, answers 423 there. → { ok, error? }
  cancelJob(jobId, peerInfo = null) {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: "no-job" };
    this.journal.write({ type: "job-cancel", plugin: job.plugin, actionId: job.actionId, job: jobId, peer: peerInfo?.class ?? null, pid: peerInfo?.pid ?? null });
    this.stopJob(job, "cancelled");
    return { ok: true };
  }
}
