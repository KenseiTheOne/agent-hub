// Parsing plugin output in the SwiftBar format.
//
//   Header (lines before the first `---`)  → the menu line
//   ---
//   Body: `Title | key=value key2="value with spaces"`, nesting via the `--` prefix
//
// Our parameters: status, effect, action, event, activity, needsOn. Styling (color, sfimage, …) passes as is.
// activity= / needsOn= (header only, any plugin tier — it's not a permission): "I have work going on right now" and "I'll
// need the computer on later". The text is sanitized (Unicode control and formatting characters, line breaks
// → space; ZWJ between emoji stays; at most MAX_MARKS combining marks per grapheme) and cut to
// MAX_PHRASE graphemes; an empty value means "taking part in the check, quiet right now".
// `bash=`/`shell=`/`terminal=`/`paramN=` are forbidden: dropped with a warning.
// For streamable, frames are separated by a `~~~` line (splitFrames / FrameSplitter).

import { parseMsg as msg } from "./messages/parse.mjs";

export const STATUSES = ["ok", "unknown", "wait", "block", "error"];
// Severity for the "worst status": the higher, the worse.
export const SEVERITY = { ok: 0, unknown: 1, wait: 2, block: 3, error: 4 };

const FORBIDDEN = /^(bash|shell|terminal|param\d+)$/i;
const MAX_LINES = 2000;
const MAX_VALUE = 2000;
// Line length limit and the number of "|" that parseLine tries (right to left). Each attempt parses the whole tail
// of the line, so without limits a line `x | a=b|a=b|…|a=b junk` would take quadratic time and occupy
// the daemon event loop for long. There's one real separator right of the title; "|" further right occurs only
// inside quoted values; 16 attempts leave plenty of margin.
export const MAX_LINE = 16 * 1024;
const MAX_SPLIT_TRIES = 16;
// The raw line is cut to this limit before trimEnd and level parsing (see parseOutput).
const RAW_LINE_CAP = MAX_LINE * 2;

// activity= and needsOn=: phrase length and how many phrases of one kind are taken from the header.
export const MAX_PHRASE = 120;
export const MAX_PHRASES = 4;

// How many combining marks (\p{M}) to keep per grapheme: "я́", keycap "1️⃣" and most scripts
// fit; a hundred diacritics over one letter (spilling outside the line and over neighbors) don't.
export const MAX_MARKS = 3;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// A phrase for the "safe to shut down" verdict: no control or formatting characters (bidi, zero width), no
// U+2028/2029 — but ZWJ (U+200D) between emoji stays (👨‍👩‍👧 doesn't fall apart into three people); at most MAX_MARKS
// combining marks per grapheme; whitespace collapsed; no longer than MAX_PHRASE graphemes (with "…" at the end if cut).
export function cleanPhrase(v) {
  let s = String(v ?? "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, (m, off, str) => {
      if (m === "\u200D" && /\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*$/u.test(str.slice(Math.max(0, off - 8), off)) && /^\p{Extended_Pictographic}/u.test(str.slice(off + 1, off + 3))) return m;
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  const parts = [];
  for (const { segment } of GRAPHEMES.segment(s)) {
    let k = 0;
    parts.push(segment.replace(/\p{M}/gu, (m) => (++k > MAX_MARKS ? "" : m)));
  }
  if (parts.length > MAX_PHRASE) return parts.slice(0, MAX_PHRASE - 1).join("").trimEnd() + "…";
  return parts.join("");
}

export function worstStatus(list) {
  let worst = "ok";
  for (const s of list) if (s in SEVERITY && SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

// Parameters `k=v k2="v 2" k3='v 3'`. → { params, ok } (ok=false if the line has junk instead of parameters)
export function parseParams(text) {
  const params = {};
  const re = /\s*([A-Za-z_][\w.-]*)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S*))/y;
  let pos = 0;
  let any = false;
  text = text.trimEnd();
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return { params, ok: false };
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    params[m[1]] = m[2] !== undefined || m[3] !== undefined ? raw.replace(/\\(.)/g, "$1") : raw;
    pos = re.lastIndex;
    any = true;
  }
  return { params, ok: any };
}

// One line → { title, params } (the separator is the last `|` with only parameters to its right).
// A line longer than MAX_LINE is cut (parseOutput warns), at most MAX_SPLIT_TRIES "|" are tried.
export function parseLine(line) {
  if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE);
  let idx = line.lastIndexOf("|");
  for (let tries = 0; idx >= 0 && tries < MAX_SPLIT_TRIES; tries++) {
    const { params, ok } = parseParams(line.slice(idx + 1));
    if (ok) return { title: line.slice(0, idx).trimEnd(), params };
    idx = idx > 0 ? line.lastIndexOf("|", idx - 1) : -1;
  }
  return { title: line, params: {} };
}

// effect value: `<primitive> [arg...]`; an argument is `key=value` or positional.
export function parseEffectSpec(spec) {
  const s = String(spec).trim();
  const m = /^([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)(?:\s+([\s\S]*))?$/.exec(s);
  if (!m) return null;
  const tokens = tokenize(m[2] || "");
  if (!tokens) return null;
  return { primitive: m[1], tokens };
}

// Space-separated tokens; quotes "…" and '…' may appear inside a token (key="a b"). null — an unclosed quote.
export function tokenize(text) {
  const out = [];
  let cur = "";
  let has = false;
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && i + 1 < text.length) cur += text[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (q) return null;
  if (has) out.push(cur);
  return out;
}

function cap(v) {
  return typeof v === "string" && v.length > MAX_VALUE ? v.slice(0, MAX_VALUE) : v;
}

// Parsing one frame. → { header: Item[], body: Item[], status, events: string[], warnings: string[],
//   activity: string[] | null, needsOn: string[] | null }
// Item: { title, level, separator?, params, status?, effect?, action?, event?, href?, activity?, needsOn? }
// frame activity / needsOn: null — no key in the header (the plugin doesn't take part in the verdict); [] — the key is there but empty
// ("checked — quiet"); otherwise non-empty phrases from the header lines in order (no repeats, at most MAX_PHRASES).
export function parseOutput(text) {
  const warnings = [];
  const header = [];
  const body = [];
  const events = [];
  let status = null;
  let inBody = false;
  let activity = null;
  let needsOn = null;
  const addPhrase = (list, v) => {
    const out = list || [];
    const p = cleanPhrase(v);
    if (p && !out.includes(p) && out.length < MAX_PHRASES) out.push(p);
    return out;
  };
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > MAX_LINES) warnings.push(msg("out.lines", { n: MAX_LINES }));
  for (let rawLine of lines.slice(0, MAX_LINES)) {
    // Cut the raw line before any regexes: `\s+$` on a long whitespace run before a non-whitespace character
    // is quadratic. The margin over MAX_LINE is for `--` levels and indentation stripped below; rest is cut again.
    const rawCut = rawLine.length > RAW_LINE_CAP;
    if (rawCut) rawLine = rawLine.slice(0, RAW_LINE_CAP);
    const line = rawLine.trimEnd();
    if (line.trim() === "---") {
      if (!inBody) inBody = true;
      else body.push({ title: "", level: 0, separator: true, params: {} });
      continue;
    }
    if (line.trim() === "" && !inBody) continue;
    if (line.trim() === "") continue;
    let level = 0;
    let rest = line;
    if (inBody) {
      // `--` is a nesting level; a `---` left after the levels is a submenu separator
      while (rest.startsWith("--") && !/^---\s*$/.test(rest)) {
        rest = rest.slice(2);
        level++;
      }
      if (level > 0 && /^-{3}\s*$/.test(rest)) {
        body.push({ title: "", level, separator: true, params: {} });
        continue;
      }
      rest = rest.replace(/^\s+/, "");
    }
    if (rawCut || rest.length > MAX_LINE) {
      warnings.push(msg("out.line", { n: MAX_LINE }));
      rest = rest.slice(0, MAX_LINE);
    }
    const { title, params } = parseLine(rest);
    const item = { title: cap(title), level, params: {} };
    for (const [k, v] of Object.entries(params)) {
      const key = k.toLowerCase();
      if (FORBIDDEN.test(key)) {
        warnings.push(msg("out.forbidden", { key }));
        continue;
      }
      if (key === "status") {
        if (STATUSES.includes(v)) item.status = v;
        else warnings.push(msg("out.status", { value: v }));
      } else if (key === "effect") {
        item.effect = cap(v);
      } else if (key === "action") {
        item.action = cap(v);
      } else if (key === "event") {
        if (/^[\w.:/-]{1,128}$/.test(v)) item.event = v;
        else warnings.push(msg("out.event", { value: String(v).slice(0, 40) }));
      } else if (key === "href") {
        item.href = cap(v);
      } else if (key === "activity" || key === "needson") {
        const field = key === "activity" ? "activity" : "needsOn";
        if (inBody) {
          warnings.push(msg("out.headerOnly", { field }));
          continue;
        }
        item[field] = cleanPhrase(v);
        if (field === "activity") activity = addPhrase(activity, v);
        else needsOn = addPhrase(needsOn, v);
      } else {
        item.params[k] = cap(v);
      }
    }
    if (item.event) events.push(item.event);
    if (!inBody) {
      if (item.status && status === null) status = item.status;
      else if (item.status) status = worstStatus([status, item.status]);
      header.push(item);
    } else body.push(item);
  }
  if (header.length === 0 && body.length === 0) return { header, body, status: "unknown", events, warnings, empty: true, activity: null, needsOn: null };
  return { header, body, status: status ?? "ok", events: [...new Set(events)], warnings, empty: false, activity, needsOn };
}

// Splits a streamable stream into frames on a `~~~` line.
// Frames of a streamable plugin. Both SwiftBar styles work:
//   "frame, then ~~~" — the frame is emitted on ~~~;
//   "~~~, then frame" (SwiftBar shows the frame right away) — the frame is emitted after a short silence in the stream
//   (idleMs without new lines), without waiting for the next ~~~.
// After an emit on silence the frame isn't reset: new lines are appended to it and it's emitted again; ~~~
// closes the frame (not emitted again if nothing was added since the last emit).
export const FRAME_IDLE_MS = 150;

export class FrameSplitter {
  constructor(onFrame, maxBytes = 1024 * 1024, { idleMs = FRAME_IDLE_MS } = {}) {
    this.onFrame = onFrame;
    this.maxBytes = maxBytes;
    this.idleMs = idleMs;
    this.buf = "";
    this.cur = [];
    this.size = 0;
    this.overflow = false;
    this.dirty = false;
    this.timer = null;
  }
  emit() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    this.onFrame(this.cur.join("\n"), this.overflow);
  }
  push(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.replace(/\r$/, "").trim() === "~~~") {
        // a frame may be empty if ~~~ comes first
        if (this.cur.length || this.size) this.emit();
        clearTimeout(this.timer);
        this.timer = null;
        this.cur = [];
        this.size = 0;
        this.overflow = false;
        this.dirty = false;
      } else if (this.size + line.length <= this.maxBytes) {
        this.cur.push(line);
        this.size += line.length + 1;
        this.dirty = true;
      } else {
        this.overflow = true;
        this.dirty = true;
      }
    }
    if (this.buf.length > this.maxBytes) {
      this.buf = "";
      this.overflow = true;
    }
    if (this.dirty && this.idleMs > 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.emit(), this.idleMs);
      this.timer.unref?.();
    }
  }
  // end of stream: emit the unfinished frame as is
  end() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.buf) {
      this.cur.push(this.buf);
      this.dirty = true;
    }
    this.buf = "";
    if (this.cur.length && this.dirty) this.onFrame(this.cur.join("\n"), this.overflow);
    this.dirty = false;
    this.cur = [];
  }
}

export function splitFrames(text) {
  const frames = [];
  const s = new FrameSplitter((f) => frames.push(f));
  s.push(String(text));
  s.end();
  return frames;
}
