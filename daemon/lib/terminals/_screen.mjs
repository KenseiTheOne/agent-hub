// The Claude Code input field on a terminal screen, and typing a line into it safely — shared by the cmux bridge
// (bridge/agenthub-bridge.mjs imports analyzeScreen and the line limits from here, so the daemon stays self-contained) and the
// adapters that run the terminal's tool themselves (tmux). The file starts with `_`: a helper of the terminal layer.
//
// typeLine is the send-text protocol of every terminal (the bridge runs it too):
//   1. read the screen: the input field is found, no turn running — otherwise refuse;
//   2. type the line without Enter;
//   3. read again: the field holds exactly this line (nobody typed meanwhile, no draft was there) — only then press Enter;
//      a draft that was there gets the typed characters erased and stays as it was;
//   4. read once more: Claude Code's own "are you sure" about exactly this command gets its "Yes".
// The screen text stays inside the adapter: only the input field flags leave it.

// How many last lines of the visible screen read-screen looks at (the Claude Code input field is at the bottom).
export const SCREEN_LINES_MAX = 30;
export const SCREEN_LINES_DEFAULT = 20;
const SETTLE_MS = 250;
const squash = (s) => String(s).replace(/[\s\u00a0]+/g, "");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The input field is a line starting with ">" or "❯" (with a frame "│ > …") right under a horizontal line (─, possibly with a label in it), plus continuation
// lines up to the next such line. A turn is running — "esc to interrupt" is on screen outside the field. The empty field placeholder
// (pale "Try "…"") can't be told apart from typed text on a text screen — then the field counts as non-empty: refuse, don't type.
const RULE_RE = /^\s*[╭╰┌└]?[─━]{8,}[╮╯┐┘]?\s*$/;
// The line above the field may carry a short label inside it (Claude Code prints the session name there: "──── name ──").
const TOP_RULE_RE = /^\s*[╭┌]?[─━]{8,}(?:[ \u00a0][^─━]{1,80}[ \u00a0][─━]+)?[╮┐]?\s*$/;
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
    if (!PROMPT_RE.test(lines[i]) || !TOP_RULE_RE.test(lines[i - 1])) continue;
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

// Claude Code asks before it applies some commands ("Switch model? … ❯ 1. Yes, switch to <id> / 2. No, go back"). The line
// was sent on purpose, so the answer is known — but only for exactly this picture: no input field, the first option is
// selected, says "Yes" and ends with the argument of the command just sent, and the next option is "No".
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function confirmsCommand(screenText, text) {
  const m = /^\/[a-z-]+ (\S{2,})$/.exec(String(text));
  if (!m) return false;
  if (analyzeScreen(screenText, SCREEN_LINES_MAX).promptFound) return false;
  const lines = String(screenText ?? "").replace(/\r/g, "").split("\n").slice(-SCREEN_LINES_MAX);
  const yes = new RegExp(`^\\s*[❯›>]\\s*1\\.\\s+Yes,\\s(?:\\S+\\s){1,4}${esc(m[1])}\\s*$`);
  for (let i = 0; i < lines.length - 1; i++) {
    if (yes.test(lines[i]) && /^\s*2\.\s+No\b/.test(lines[i + 1])) return true;
  }
  return false;
}

// io: { read() → {ok, text?, error?}, type(text) → {ok, error?}, enter() → {ok, error?}, erase?(n) → {ok, error?} }.
// → { ok, error?, flags? }. An io failure is returned as the io gave it.
//
// A field that is not empty may hold a human's draft or a pale hint of Claude Code (a suggested next message, "Try …"):
// on a text screen they look the same. With io.erase the line is typed anyway and the screen tells them apart: a hint
// vanishes at the first character (the field then holds exactly the line — go on), a draft stays — then exactly the typed
// characters are erased and the tab is left alone (prompt-not-empty). Without io.erase a non-empty field is refused at once.
// enterBy/clock — after this moment Enter is not pressed (the caller has already answered "not sent").
export async function typeLine(io, text, { settleMs = SETTLE_MS, sleep = pause, enterBy = null, clock = Date.now, withFlags = false } = {}) {
  const settle = async () => {
    if (settleMs > 0) await sleep(settleMs);
  };
  const no = (error, a) => ({ ok: false, error, ...(withFlags && a ? flags(a) : {}) });
  let r = await io.read();
  if (!r.ok) return r;
  let a = analyzeScreen(r.text);
  if (!a.promptFound) return no("prompt-not-found", a);
  if (a.busy) return no("session-busy", a);
  const before = a.promptEmpty ? "" : squash(a.promptText);
  if (before && !io.erase) return no("prompt-not-empty", a);
  r = await io.type(text);
  if (!r.ok) return r;
  await settle();
  r = await io.read();
  if (!r.ok) return r;
  let b = analyzeScreen(r.text);
  const want = squash(text);
  if (!b.promptFound || squash(b.promptText) !== want) {
    if (!before) return no("prompt-mismatch");
    // a draft: our characters are in it, and nothing else changed — take them back; anything else — someone is typing, hands off
    const now = b.promptFound ? squash(b.promptText) : "";
    if (now.length !== before.length + want.length || !now.includes(want)) return no("prompt-mismatch");
    r = await io.erase(text.length);
    if (!r.ok) return r;
    return no("prompt-not-empty", a);
  }
  if (typeof enterBy === "number" && clock() > enterBy) return no("deadline");
  r = await io.enter();
  if (!r.ok) return r;
  // the line is in: a question about exactly this command gets its "Yes"; a failure here doesn't undo the sending
  // no input field and no question yet — the screen is being redrawn: look once more
  for (let i = 0; i < 2; i++) {
    await settle();
    r = await io.read();
    if (!r.ok) break;
    if (confirmsCommand(r.text, text)) {
      await io.enter();
      return { ok: true, confirmed: true };
    }
    if (analyzeScreen(r.text).promptFound) break;
  }
  return { ok: true };
}
