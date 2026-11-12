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
//
// Escapes in the title (hub 0.1.3, within contract 3; escapeTitle below makes them): a `|` preceded by an odd number of
// backslashes (`\|`) is a literal `|` of the title and never a separator — foreign text printed into a title can't add
// parameters (href=, event=, action=). The run before such a `|` shows as half its backslashes, rounded down (`\\\|` →
// `\|`); backslashes anywhere else show as they are. A title that starts with backslashes and then `-` or `~` loses one
// backslash (`\--x` → `--x`): the line isn't read as a nesting level, a `---` separator or a `~~~` frame end.

import { parseMsg as msg } from "./messages/parse.mjs";

export const STATUSES = ["ok", "unknown", "wait", "block", "error"];
// Severity for the "worst status": the higher, the worse.
export const SEVERITY = { ok: 0, unknown: 1, wait: 2, block: 3, error: 4 };

const FORBIDDEN = /^(bash|shell|terminal|param\d+)$/i;
const MAX_LINES = 2000;
const MAX_VALUE = 2000;
// Chart data (hub 0.1.3: `chart=bars`, `spark=`): a value per bar and a multi-line tooltip per bar do not fit in
// MAX_VALUE for a month of days, so these keys get a larger cap. The line itself is still capped at MAX_LINE (sized so
// that a chart line with values/labels/valueLabels/tips/series all at MAX_DATA_VALUE plus the title and styling fits).
// A longer data key keeps its tail (the newest entries) — see trimDataKeys.
export const MAX_DATA_VALUE = 8000;
const DATA_KEYS = new Set(["values", "labels", "valueLabels", "tips", "series", "spark"]);
// Lists of one chart that go bar by bar (entry i of each belongs to bar i): trimmed together, by the same count.
// spark= is a list of its own (the header sparkline).
const DATA_GROUPS = [["values", "labels", "valueLabels", "tips", "series"], ["spark"]];
// Line length limit and the number of "|" that parseLine tries (right to left). Each attempt parses the whole tail
// of the line, so without limits a line `x | a=b|a=b|…|a=b junk` would take quadratic time and occupy
// the daemon event loop for long. There's one real separator right of the title; "|" further right occurs only
// inside quoted values; 16 attempts leave plenty of margin. The whole output is capped at 1 MB anyway, so the total work
// stays bounded whatever MAX_LINE is. A line over MAX_LINE is cut and keeps only its title (no parameters, see parseLine).
export const MAX_LINE = 64 * 1024;
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

// Parameters `k=v k2="v 2" k3='v 3'`. → { params, ok, stray } (ok=false if the line has junk instead of parameters;
// stray — an unquoted value has a quote character: the tail may start inside someone's quoted value, see parseLine)
export function parseParams(text) {
  const params = {};
  // An unquoted value can't start with a quote: `k="x …` without its closing quote (a cut line, a plugin bug) is junk,
  // not the value `"x` followed by foreign text read as more parameters.
  const re = /\s*([A-Za-z_][\w.-]*)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|((?!["'])\S*))/y;
  let pos = 0;
  let any = false;
  let stray = false;
  text = text.trimEnd();
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return { params, ok: false, stray };
    const raw = m[2] ?? m[3] ?? m[4] ?? "";
    params[m[1]] = m[2] !== undefined || m[3] !== undefined ? raw.replace(/\\(.)/g, "$1") : raw;
    if (m[4] !== undefined && /["']/.test(m[4])) stray = true;
    pos = re.lastIndex;
    any = true;
  }
  return { params, ok: any, stray };
}

// Whether the "|" at idx is escaped: an odd run of backslashes right before it.
function escapedAt(line, idx) {
  let n = 0;
  while (idx - n - 1 >= 0 && line.charCodeAt(idx - n - 1) === 92) n++;
  return n % 2 === 1;
}

// Title as shown: `\|` (an odd run before "|") → half the run and "|"; a backslash run that starts the title and ends
// in "-" or "~" loses one backslash (`\-` → `-`, `\\-` → `\-`).
// A linear scan (a regex over long backslash runs would be quadratic).
export function unescapeTitle(title) {
  const s = String(title);
  let out = s;
  if (s.includes("|")) {
    out = "";
    let i = 0;
    while (i < s.length) {
      if (s.charCodeAt(i) !== 92) {
        out += s[i++];
        continue;
      }
      let j = i;
      while (j < s.length && s.charCodeAt(j) === 92) j++;
      const n = j - i;
      if (s[j] === "|" && n % 2 === 1) {
        out += "\\".repeat((n - 1) / 2) + "|";
        j++;
      } else out += s.slice(i, j);
      i = j;
    }
  }
  return out.replace(/^(\s*)\\(\\*[-~])/, "$1$2");
}

// Foreign text (log lines, PR titles, tab and file names) → a title that shows exactly that text and can't add
// parameters or change the line's meaning: line breaks and control characters → spaces, "|" escaped (a backslash run
// before it doubled), a leading "-" or "~" (after spaces and backslashes) gets a backslash. Put your own parameters
// after it with " | " (a space before the "|"). For a whole title: the leading "-"/"~" guard is hidden only at the start
// of a title, so escape the composed title once rather than a piece glued after a prefix (that would show a "\").
// Documented in docs/writing-plugins.md (output format) for plugins to copy.
export function escapeTitle(text) {
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  let out = "";
  let run = 0; // backslashes right before the current character
  for (const ch of s) {
    if (ch === "|") out += "\\".repeat(run + 1) + "|";
    else out += ch;
    run = ch === "\\" ? run + 1 : 0;
  }
  return out.replace(/^(\s*)(\\*[-~])/, "$1\\$2");
}

// One line → { title, params } (the separator is the last unescaped `|` with only parameters to its right).
// A line longer than MAX_LINE (or one the caller already cut: cut=true) keeps only its title — the text before the
// first unescaped "|" — and no parameters: the cut may land inside a quoted value, and what follows the open quote is
// foreign text (parseOutput warns). At most MAX_SPLIT_TRIES "|" are tried; an escaped "|" isn't a try (no parameter
// parsing: the backslash runs between "|" don't overlap, the scan stays linear).
// A tail whose unquoted value holds a quote (`href=https://x"`) is most likely the inside of a quoted value with a "|"
// (`note="a | href=https://x"` printed from foreign text): such a split is kept only as a fallback — a split further
// left whose tail parses cleanly wins (S1).
export function parseLine(line, cut = false) {
  if (line.length > MAX_LINE) {
    line = line.slice(0, MAX_LINE);
    cut = true;
  }
  if (cut) {
    let first = line.indexOf("|");
    while (first >= 0 && escapedAt(line, first)) first = line.indexOf("|", first + 1);
    return { title: unescapeTitle(first >= 0 ? line.slice(0, first) : line).trimEnd(), params: {} };
  }
  let idx = line.lastIndexOf("|");
  let fallback = null;
  for (let tries = 0; idx >= 0 && tries < MAX_SPLIT_TRIES; ) {
    if (!escapedAt(line, idx)) {
      tries++;
      const { params, ok, stray } = parseParams(line.slice(idx + 1));
      if (ok && !stray) return { title: unescapeTitle(line.slice(0, idx)).trimEnd(), params };
      if (ok && !fallback) fallback = { title: unescapeTitle(line.slice(0, idx)).trimEnd(), params };
    }
    idx = idx > 0 ? line.lastIndexOf("|", idx - 1) : -1;
  }
  return fallback || { title: unescapeTitle(line), params: {} };
}

// A data key as a list: [parts, sep]. values/spark — commas; tips — "¦"; labels/valueLabels — "¦" when present,
// otherwise commas (the shell's Item.splitLabels).
function splitData(key, v) {
  const sep = key === "values" || key === "spark" ? "," : key === "tips" ? "¦" : v.includes("¦") ? "¦" : ",";
  return [v.split(sep), sep];
}

// How many leading entries to drop so that the joined list fits max (at most all but the last).
function dropToFit(parts, max) {
  let len = parts.reduce((a, p) => a + p.length, 0) + parts.length - 1;
  let d = 0;
  while (len > max && d < parts.length - 1) {
    len -= parts[d].length + 1;
    d++;
  }
  return d;
}

// The same for series= ("a1,a2;b1,b2"): d entries dropped from the head of every row.
function dropSeriesToFit(rows, max) {
  let len = rows.reduce((a, r) => a + r.reduce((b, p) => b + p.length, 0) + r.length - 1, 0) + rows.length - 1;
  const longest = Math.max(...rows.map((r) => r.length));
  let d = 0;
  while (len > max && d < longest - 1) {
    for (const r of rows) if (d < r.length - 1) len -= r[d].length + 1;
    else if (d === r.length - 1) len -= r[d].length;
    d++;
  }
  return d;
}

// Data keys over MAX_DATA_VALUE (G16): the oldest entries (the head) are dropped, not the newest; lists of one chart
// lose the same count so bar i keeps its label, caption and tooltip; a numeric highlight= moves with them. An entry
// that alone doesn't fit keeps its tail. One warning per trimmed key (core.warn puts it in the journal).
export function trimDataKeys(params, warnings = []) {
  for (const group of DATA_GROUPS) {
    const keys = group.filter((k) => typeof params[k] === "string");
    const over = keys.filter((k) => params[k].length > MAX_DATA_VALUE);
    if (!over.length) continue;
    const lists = {};
    let drop = 0;
    for (const k of keys) {
      if (k === "series") {
        lists[k] = params[k].split(";").map((r) => r.split(","));
        if (params[k].length > MAX_DATA_VALUE) drop = Math.max(drop, dropSeriesToFit(lists[k], MAX_DATA_VALUE));
      } else {
        lists[k] = splitData(k, params[k]);
        if (params[k].length > MAX_DATA_VALUE) drop = Math.max(drop, dropToFit(lists[k][0], MAX_DATA_VALUE));
      }
    }
    if (drop > 0) {
      for (const k of keys) {
        if (k === "series") params[k] = lists[k].map((r) => r.slice(Math.min(drop, r.length)).join(",")).join(";");
        else params[k] = lists[k][0].slice(Math.min(drop, lists[k][0].length)).join(lists[k][1]);
      }
      if (group.includes("values") && /^\d+$/.test(String(params.highlight ?? ""))) {
        const h = Number(params.highlight) - drop;
        if (h >= 0) params.highlight = String(h);
        else delete params.highlight;
      }
    }
    for (const k of keys) if (params[k].length > MAX_DATA_VALUE) params[k] = params[k].slice(params[k].length - MAX_DATA_VALUE);
    for (const k of over) warnings.push(msg("out.dataTrim", { key: k, n: MAX_DATA_VALUE }));
  }
  return params;
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

function cap(v, max = MAX_VALUE) {
  return typeof v === "string" && v.length > max ? v.slice(0, max) : v;
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
    const cut = rawCut || rest.length > MAX_LINE;
    if (cut) {
      warnings.push(msg("out.line", { n: MAX_LINE }));
      rest = rest.slice(0, MAX_LINE);
    }
    const { title, params } = parseLine(rest, cut);
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
        // data keys are trimmed after the loop (all lists of the line together)
        item.params[k] = DATA_KEYS.has(k) ? v : cap(v);
      }
    }
    trimDataKeys(item.params, warnings);
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
    // a line longer than maxBytes is being dropped: skip everything up to its "\n" (its tail is not a line of its own)
    this.skipLine = false;
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
      if (this.skipLine) {
        this.skipLine = false;
        continue;
      }
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
      this.dirty = true;
      this.skipLine = true;
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
    if (this.buf && !this.skipLine) {
      this.cur.push(this.buf);
      this.dirty = true;
    }
    this.buf = "";
    this.skipLine = false;
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
