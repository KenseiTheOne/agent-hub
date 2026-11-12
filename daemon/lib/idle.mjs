// The "is it safe to shut down the computer" verdict — a single daemon answer for the popover, the menu bar icon and future
// notifications (idle service, lib/services/idle.mjs; docs/api.md "/state.idle").
//
//   verdict: quiet          — nothing is running, all participants answered: safe to shut down, nothing will be lost (sessions
//                             waiting for an answer are only an info line, see below)
//            quiet-needs-on — quiet right now, but someone will need the computer later (a plugin's needsOn=: a run at 04:30) or
//                             the hub does not know about someone (kind unknown: the sessions plugin did not answer, a failed participant)
//            busy           — work is in progress: too early to shut down. Only actually running work (busy), needsOn and
//                             unknown decide; sessions waiting for an answer do not affect the verdict unless they show work (askingWorks)
//            null           — "checking": the first WARMUP_MS after the daemon starts, until all plugins have sent their first
//                             frame (otherwise after every daemon restart the popover would first turn green with "Safe to shut down")
//   items:   [{source, kind: busy | waiting | needs-on | unknown, text, target?, plugin?, trusted?}] — one line per
//            obstacle, in order of importance; waiting is not an obstacle but info (the last line). plugin — the plugin's
//            name (on plugin lines), trusted — a phrase of a trusted plugin (builtin, official, own): only it fits a card title ("Safe, but a run at 04:30"). Phrases of other
//            plugins come with a "<name>: " prefix so they do not pass themselves off as hub lines.
//   checked: [names of sources that are all fine] — "Also checked: …"
//
// Sources: Claude Code sessions (working — busy; waiting for an answer — PermissionRequest cards and sessions in waiting —
// waiting; "Sessions" in "checked" only if the claude-sessions plugin is alive and has sent a frame, otherwise an
// unknown line "don't know about sessions"), plugins with activity= (busy) and needsOn= (needs-on), installing and building a hub
// update, installing and updating plugins, plugin actions still running.
// A session waiting for an answer (a question, a PermissionRequest permission dialog, status=waiting) does nothing by itself: the claude
// process is stopped at the question. Sleep does not affect it — after waking the question is in the same place. Shutting down closes
// the process, but the conversation is kept in the transcript (~/.claude/projects/…/<id>.jsonl, written as it goes): `claude --resume`
// opens it. The permission dialog will not come back by itself, and the asked step is not done (an interrupted tool call is
// not repeated on resume — code.claude.com/docs/en/sessions, "What a resumed session restores"): answer in the
// conversation or ask it to continue. So waiting sessions are an info line "you can answer after turning it back on", not an
// obstacle: neither "too early" nor "the question will be lost". The exception is a waiting session with visible running work (askingWorks: a card from
// a subagent, waitingFor "worker request", status=busy with a card): that is an obstacle, a busy line "working and waiting for an answer
// to a step" — shutting down cuts the work off, and `claude --resume` will not restart it.
// A failed participant (status=error) or one that went silent (stale: no frame for longer than STALE_INTERVALS intervals, and for a
// streamable one with non-empty phrases — longer than STREAM_STALE_MS) does not drop out of the check and is not shown with its phrase
// "as is": the line "<plugin>: failure — last: <phrase> (HH:MM)" is busy if the last one was work, otherwise
// unknown (the needsOn of such a plugin is also only in this line: the hub no longer knows for sure about the run at 04:30).
// The hub pause does not affect the verdict: while paused, sessions and background agents keep working (sessions ask in the terminal) — the verdict
// is computed the same way as without it.
// A plugin block (status=block) is not part of the verdict: shutting down will not make it worse; the icon shows the block as before. Such
// a plugin does not get into "checked" (an "all fine" check mark next to "Blocking work" would be misleading).
//
// The module is pure: the input is what the service collected from the core, the output is an object for /state.idle (and nextAt — when
// to recompute without events: the end of "checking" or the moment after which a plugin went silent).

import { basename } from "node:path";
import { t } from "./i18n.mjs";

export const VERDICTS = ["quiet", "quiet-needs-on", "busy"];
export const KINDS = ["busy", "waiting", "needs-on", "unknown"];
// Hub install phases during which work is in progress (docs/hub-updates.md): ready — built and waiting for a click — does not count as work.
export const HUB_BUSY_PHASES = new Set(["building", "switching", "trial", "rolling-back"]);
// How many session names to list in a line, after that — "N more".
const MAX_NAMES = 3;
// "Checking" after the daemon starts: no longer than this, even if some plugin never sent a frame.
export const WARMUP_MS = 60_000;
// A scheduled plugin went silent: no frame for longer than this many intervals (but not less than STALE_MIN_MS).
export const STALE_INTERVALS = 3;
export const STALE_MIN_MS = 120_000;
// A streamable plugin with non-empty activity=/needsOn= repeats the frame at least every 2 min (docs/extension-points.md); silent
// for longer means it hung.
export const STREAM_STALE_MS = 5 * 60_000;
// The sessions plugin: its state decides whether "Sessions" may be put into "checked".
export const SESSIONS_PLUGIN = "claude-sessions";

// A failure of the plugin itself: error from the frame (exit ≠ 0, timeout, empty output). Signals without an error field (old form) —
// by status=error, as before.
export function pluginBroken(p) {
  if (p && "error" in p) return Boolean(p.error);
  return p?.status === "error";
}

// The plugin's reason for the "Don't know about sessions: …" line — on one line; in Russian after the colon it starts lowercase
// (except abbreviations); English is left alone (there an initial capital is usually a name: "Claude not found").
function whyText(why, lang) {
  const s = typeof why === "string" ? why.replace(/\s+/g, " ").trim().slice(0, 140) : "";
  if (!s) return null;
  return lang === "ru" && /^[А-ЯЁ][а-яё]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

export function sessionName(s) {
  if (!s) return null;
  if (typeof s.name === "string" && s.name.trim()) return s.name.trim().slice(0, 60);
  if (typeof s.cwd === "string" && s.cwd) {
    const b = basename(s.cwd);
    if (b) return b.slice(0, 60);
  }
  return typeof s.sessionId === "string" ? s.sessionId.slice(0, 8) : null;
}

function names(list, lang) {
  const shown = list.slice(0, MAX_NAMES).join(", ");
  return list.length > MAX_NAMES ? `${shown}, ${t(lang, "idle.names.more", { n: list.length - MAX_NAMES })}` : shown;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// When the plugin is considered silent (epoch ms) or null — no deadline (cron, no interval, streamable without phrases).
export function staleAt(p) {
  if (!Number.isFinite(p.lastRunAt)) return null;
  if (p.type === "streamable") {
    const phrases = (p.activity || []).length + (p.needsOn || []).length;
    return phrases ? p.lastRunAt + STREAM_STALE_MS : null;
  }
  if (!Number.isFinite(p.intervalMs) || p.intervalMs <= 0) return null;
  return p.lastRunAt + Math.max(STALE_INTERVALS * p.intervalMs, STALE_MIN_MS);
}

// The plugin's phrase in a card line: for untrusted ones with a "<name>: " prefix (unless the phrase already starts with it).
function phrase(p, text) {
  const title = p.title || p.id;
  if (p.trusted === true || text.toLowerCase().startsWith(String(title).toLowerCase())) return text;
  return `${title}: ${text}`;
}

// A session waiting for an answer that shows running work: shutting down will cut it off, and `claude --resume` will not
// restart what was cut off (a background subagent, a command, a workflow — only a note in the conversation; code.claude.com/docs/en/sessions,
// "What a resumed session restores"). Signs:
//   - a card from a subagent (agent_id in the hook): there is a subagent, the others may keep going;
//   - waitingFor = "worker request": waiting on a worker request, not the main thread;
//   - status=busy with a card: Claude Code (2.1.319, vMe) sets waiting while the permission dialog is open — the
//     PermissionRequest hook runs in parallel with the dialog, so in the steady state a card has waiting; busy means the registry has not
//     caught up yet or other work is going on: "too early" is safer than cutting it off.
// Other work of a waiting session (background Bash, Monitor) is not visible in the status: Claude Code's waiting overrides busy. That
// is covered in the hint of the waiting line (shell, IdleCard.waitingHint) and in the "no work visible" subtitle.
export function askingWorks(s, subagentCard) {
  if (subagentCard === true) return true;
  if (s?.status === "busy") return true;
  return s?.status === "waiting" && typeof s.waitingFor === "string" && /^worker request$/i.test(s.waitingFor.trim());
}

// → { verdict, items, checked, nextAt }
//   sessions    — the core session registry ([{sessionId, status, name, cwd}])
//   cards       — waiting hook cards ([{sessionId, subagent?}]) or null (no hook service)
//   plugins     — [{id, title, status, trusted, type, intervalMs, lastRunAt, signalsAt, activity: string[]|null,
//                 needsOn: string[]|null}] (core.pluginSignals)
//   hubInstall  — install from /state.hubUpdate ({phase, op, label}) or null (no hub-update service)
//   pluginsBusy — running plugin installs ([{id, op, title, version}]) or null (no plugins service)
//   actions     — plugin actions still running ([{plugin, title}])
//   now, startedAt — now and the service start (ms): "checking" for the first WARMUP_MS until all plugins have sent a frame
export function computeIdle({ lang = "ru", sessions = [], cards = null, plugins = [], hubInstall = null, pluginsBusy = null, actions = [], now = Date.now(), startedAt = null } = {}) {
  const items = [];
  const checked = [];
  const titleOf = new Map(plugins.map((p) => [p.id, p.title || p.id]));
  let nextAt = null;
  const wake = (at) => {
    if (Number.isFinite(at) && at > now && (nextAt === null || at < nextAt)) nextAt = at;
  };

  // "checking": after the daemon starts, until all plugins have sent their first frame (or failed)
  if (Number.isFinite(startedAt) && now - startedAt < WARMUP_MS && plugins.some((p) => !Number.isFinite(p.lastRunAt))) {
    return { verdict: null, items: [], checked: [], nextAt: startedAt + WARMUP_MS };
  }

  // sessions: working ones are an obstacle; waiting for an answer (a card or status=waiting) is info at the end of the list, but if
  // a waiting one shows running work (askingWorks) it is also an obstacle, with its own line "working and waiting for an answer to a step"
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const cardOf = new Map(); // sessionId → whether there is a card from a subagent (order as the cards arrived)
  for (const c of cards || []) {
    const sid = c?.sessionId;
    if (typeof sid !== "string") continue;
    cardOf.set(sid, cardOf.get(sid) === true || c.subagent === true);
  }
  const waiting = [];
  const asking = [];
  const seen = new Set();
  for (const [sid, sub] of cardOf) {
    seen.add(sid);
    const s = byId.get(sid);
    (askingWorks(s, sub) ? asking : waiting).push(sessionName(s) || sid.slice(0, 8));
  }
  for (const s of sessions) {
    if (s.status !== "waiting" || seen.has(s.sessionId)) continue;
    seen.add(s.sessionId);
    (askingWorks(s, false) ? asking : waiting).push(sessionName(s));
  }
  const busySessions = sessions.filter((s) => s.status === "busy" && !seen.has(s.sessionId)).map(sessionName);
  const waitingLine = waiting.length ? { source: "sessions", kind: "waiting", text: t(lang, "idle.sessions.waiting", { n: waiting.length, names: names(waiting, lang) }), target: "sessions" } : null;
  if (busySessions.length) items.push({ source: "sessions", kind: "busy", text: t(lang, "idle.sessions.busy", { n: busySessions.length, names: names(busySessions, lang) }), target: "sessions" });
  if (asking.length) items.push({ source: "sessions", kind: "busy", text: t(lang, "idle.sessions.busy-asking", { n: asking.length, names: names(asking, lang) }), target: "sessions" });
  // the sessions source: the claude-sessions plugin (if present) is alive and has sent a frame — otherwise the hub knows nothing about sessions
  // Two "don't know" cases: no frame or the plugin itself fails (exit ≠ 0, timeout) — "did not answer"; there is a frame, but the plugin
  // reported status=unknown/error with its own reason ("claude not found…") — show that reason.
  const sp = plugins.find((p) => p.id === SESSIONS_PLUGIN);
  const spSilent = sp && (!Number.isFinite(sp.lastRunAt) || pluginBroken(sp));
  const spUnsure = sp && !spSilent && (sp.status === "error" || sp.status === "unknown");
  if (spSilent) items.push({ source: "sessions", kind: "unknown", text: t(lang, "idle.sessions.unknown"), target: `plugin:${SESSIONS_PLUGIN}` });
  else if (spUnsure) items.push({ source: "sessions", kind: "unknown", text: t(lang, "idle.sessions.unsure", { why: whyText(sp.why, lang) }), target: `plugin:${SESSIONS_PLUGIN}` });
  else if (!waiting.length && !busySessions.length && !asking.length) checked.push(t(lang, "idle.src.sessions"));

  // plugins: activity= is work; needsOn= is collected separately and goes at the end; a failure or silence gets its own line
  const needs = [];
  const unknown = [];
  for (const p of plugins) {
    const act = Array.isArray(p.activity) ? p.activity : null;
    const non = Array.isArray(p.needsOn) ? p.needsOn : null;
    if (act === null && non === null) continue; // the plugin does not take part in the verdict
    const title = p.title || p.id;
    const base = { source: `plugin:${p.id}`, target: `plugin:${p.id}`, plugin: title, trusted: p.trusted === true };
    const due = staleAt(p);
    const stale = Number.isFinite(due) && now >= due;
    if (!stale) wake(due);
    // a participant failure is only a failure of the plugin itself or silence; status=error with error=null is a domain error
    // (the plugin's scheduled task failed): the plugin ran and said itself whether it is quiet — its phrases are taken as usual
    const broken = pluginBroken(p);
    if (broken || stale) {
      const last = (act || [])[0] ?? (non || [])[0] ?? null;
      const key = broken ? "idle.plugin.failed" : "idle.plugin.stale";
      const at = Number.isFinite(p.signalsAt) ? hhmm(p.signalsAt) : null;
      const line = { ...base, kind: (act || []).length ? "busy" : "unknown", text: t(lang, key, { title, last, at }), trusted: false };
      if (line.kind === "busy") items.push(line);
      else unknown.push(line);
      continue;
    }
    for (const text of act || []) items.push({ ...base, kind: "busy", text: phrase(p, text) });
    for (const text of non || []) needs.push({ ...base, kind: "needs-on", text: phrase(p, text) });
    // "checked" — only a plugin without a failure and not blocked
    if (!(act || []).length && !(non || []).length && p.status !== "block") checked.push(title);
  }

  // updates: the hub and plugins
  let updatesBusy = false;
  if (hubInstall && HUB_BUSY_PHASES.has(hubInstall.phase)) {
    updatesBusy = true;
    const label = typeof hubInstall.label === "string" ? hubInstall.label.slice(0, 40) : null;
    const key = hubInstall.phase === "rolling-back" ? "idle.hub.rolling-back" : hubInstall.op === "rollback" ? "idle.hub.rollback" : hubInstall.phase === "building" ? "idle.hub.building" : "idle.hub.switching";
    items.push({ source: "hub-update", kind: "busy", text: t(lang, key, { label }), target: "settings" });
  }
  for (const b of pluginsBusy || []) {
    updatesBusy = true;
    items.push({ source: "plugins", kind: "busy", text: t(lang, b.op === "update" ? "idle.plugin.update" : "idle.plugin.install", { title: b.title || b.id, version: b.version || null }), target: "manager" });
  }
  if (!updatesBusy && (hubInstall !== null || pluginsBusy !== null)) checked.push(t(lang, "idle.src.updates"));

  // plugin actions still running
  for (const a of actions) {
    items.push({ source: `plugin:${a.plugin}`, kind: "busy", text: t(lang, "idle.action", { plugin: titleOf.get(a.plugin) || a.plugin, title: a.title }), target: `plugin:${a.plugin}`, plugin: titleOf.get(a.plugin) || a.plugin });
  }

  // order: work, "don't know" (the sessions plugin did not answer, a participant failure), the computer is needed, waiting for an answer (info).
  // The verdict is based on obstacles only: work → busy; needsOn or "don't know" → quiet-needs-on; waiting sessions do not change it.
  const hindrances = [...items.filter((i) => i.kind !== "unknown"), ...items.filter((i) => i.kind === "unknown"), ...unknown, ...needs];
  const verdict = hindrances.some((i) => i.kind === "busy") ? "busy" : hindrances.length ? "quiet-needs-on" : "quiet";
  const ordered = waitingLine ? [...hindrances, waitingLine] : hindrances;
  return { verdict, items: ordered, checked: [...new Set(checked)], nextAt };
}
