// The Claude Code input field on a terminal screen, and typing a line into it safely — shared by the cmux bridge
// (bridge/agenthub-bridge.mjs imports analyzeScreen and the line limits from here, so the daemon stays self-contained) and the
// adapters that run the terminal's tool themselves (tmux). The file starts with `_`: a helper of the terminal layer.
//
// typeLine follows the bridge's send-text protocol:
//   1. read the screen: the input field is found, empty, no turn running — otherwise refuse (the line would join a human's draft);
//   2. type the line without Enter;
//   3. read again: the field holds exactly this line (nobody typed meanwhile) — only then press Enter.
// The screen text stays inside the adapter: only the input field flags leave it.

// How many last lines of the visible screen read-screen looks at (the Claude Code input field is at the bottom).
export const SCREEN_LINES_MAX = 30;
export const SCREEN_LINES_DEFAULT = 20;
const SETTLE_MS = 250;
const squash = (s) => String(s).replace(/[\s\u00a0]+/g, "");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The input field is a line starting with ">" or "❯" (with a frame "│ > …") right under a horizontal line (─), plus continuation
// lines up to the next such line. A turn is running — "esc to interrupt" is on screen outside the field. The empty field placeholder
// (pale "Try "…"") can't be told apart from typed text on a text screen — then the field counts as non-empty: refuse, don't type.
const RULE_RE = /^\s*[╭╰┌└]?[─━]{8,}[╮╯┐┘]?\s*$/;
const PROMPT_RE = /^\s*[│┃]?\s*[>❯›](?:[ \u00a0]|$)/;
const BUSY_RE = /\besc to interrupt\b/i;

// text — read-screen output. → {promptFound, promptEmpty, busy, promptText}. promptText is only for checking the typed line
// inside the bridge: it doesn't go to the daemon (the screen may show conversation text).
export function analyzeScreen(text, maxLines = SCREEN_LINES_DEFAULT) {
  const all = String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
  while (all.length && !all[all.length - 1].trim()) all.pop();
  const lines = all.slice(-Math.min(Math.max(1, maxLines | 0), SCREEN_LINES_MAX));
  for (let i = lines.length - 1; i > 0; i--) {
    if (!PROMPT_RE.test(lines[i]) || !RULE_RE.test(lines[i - 1])) continue;
    let end = i + 1;
    while (end < lines.length && !RULE_RE.test(lines[end])) end++;
    if (end >= lines.length) continue; // no bottom line — not an input field
    const body = lines
      .slice(i, end)
      .map((l, k) => {
        let x = l.replace(/^\s*[│┃]/, "").replace(/[│┃]\s*$/, "");
        if (k === 0) x = x.replace(/^\s*[>❯›]/, "");
        return x;
      })
      .join(" ")
      .replace(/[\s\u00a0]+/g, " ")
      .trim();
    const busy = lines.some((l, k) => (k < i || k >= end) && BUSY_RE.test(l));
    return { promptFound: true, promptEmpty: body === "", busy, promptText: body };
  }
  return { promptFound: false, promptEmpty: null, busy: lines.some((l) => BUSY_RE.test(l)), promptText: null };
}

export const flags = (a) => ({ promptFound: a.promptFound, promptEmpty: a.promptEmpty, busy: a.busy });

// io: { read() → {ok, text?, error?}, type(text) → {ok, error?}, enter() → {ok, error?} }. → { ok, error? }
export async function typeLine(io, text, { settleMs = SETTLE_MS, sleep = pause } = {}) {
  let r = await io.read();
  if (!r.ok) return { ok: false, error: r.error };
  let a = analyzeScreen(r.text);
  if (!a.promptFound) return { ok: false, error: "prompt-not-found" };
  if (a.busy) return { ok: false, error: "session-busy" };
  if (!a.promptEmpty) return { ok: false, error: "prompt-not-empty" };
  r = await io.type(text);
  if (!r.ok) return { ok: false, error: r.error };
  if (settleMs > 0) await sleep(settleMs);
  r = await io.read();
  if (!r.ok) return { ok: false, error: r.error };
  a = analyzeScreen(r.text);
  if (!a.promptFound || squash(a.promptText) !== squash(text)) return { ok: false, error: "prompt-mismatch" };
  r = await io.enter();
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
