// Rules of plugin actions (<agenthub.action>) as pure functions — no Core here: the argument check, the confirmation
// level and its floors, the fingerprint a confirmation is bound to, how an action is shown in /state.plugins[].actions
// and in the confirmation text. Used by the Core parts that build offers (frames.mjs), show actions (plugin-state.mjs)
// and run them (invoke.mjs, jobs.mjs). lib/core.mjs re-exports the public names.

import { createHash } from "node:crypto";
import { LEVELS } from "../meta.mjs";
import { actionArgv } from "../runner.mjs";
import { trustedPlugin } from "./tiers.mjs";

// Action argument value: up to 256 characters, no control characters, must not look like a flag ("-…"), on top of the plugin's pattern.
const ARG_MAX = 256;

export function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

// Action argument value against the declared pattern. → { value } | { error }
// The plugin's pattern is wrapped in ^(?:…)$: "^a|b$" would otherwise let "…b" through. On top of the pattern the core rejects
// control (Cc: C0, DEL, C1) and format characters (Cf: bidi overrides, zero width, soft
// hyphen), line and paragraph separators (U+2028/2029), values that look like a flag ("-…"), and longer than ARG_MAX —
// whatever the author allows: the value ends up in the core's confirmation text and in the button label.
// max — the length limit in characters (code points): ARG_MAX for a value from the output, the action's maxLength for typed input (G1).
export function checkActionArg(spec, value, { max = ARG_MAX } = {}) {
  if (typeof value !== "string" || value === "") return { error: "required" };
  if (value.length > max * 2 || [...value].length > max) return { error: "too-long" };
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return { error: "control" };
  if (value.startsWith("-")) return { error: "option-like" };
  let re;
  try {
    re = new RegExp(`^(?:${spec.pattern})$`, "u");
  } catch {
    return { error: "pattern" };
  }
  return re.test(value) ? { value } : { error: "pattern" };
}

// Action fingerprint: what a human agrees to in the confirmation text (command, level, argument pattern)
// and whose version it is (plugin version and tier). The confirmation token key and the pre-run check use it.
export function actionFingerprint(pl, tier, action) {
  const arg = action.arg ? { name: action.arg.name, pattern: action.arg.pattern } : null;
  // input / net / background (G1, G2, G6) — only when declared: fingerprints of actions without them stay as they were
  const extra = action.input || action.net || action.background ? [action.input ?? null, action.net ?? null, action.background === true] : [];
  return sha(JSON.stringify([pl?.id ?? null, pl?.meta?.version ?? null, tier ?? null, action.id, action.command, actionLevel(pl, action), arg, action.cost ?? null, action.title ?? null, action.i18n ?? null, ...extra])).slice(0, 32);
}

// Plugin action level. Builtin — as declared. With a declared network or a declared cost (`cost=` in any
// language) — no lower than confirm-cost: a human sees the cost in the window before the run, the author cannot declare it and skip the window.
// Official and own (own) without network and without cost — as declared, including immediate (decision 2026-11-09: a plugin mode switch
// without a window; the action is still app-only — actionAppOnly — journaled, and lowering the level in an update is
// an escalation of rights, a consent window). "No network and no cost=" does not yet mean "free" (running an agent spends quota even without
// network): that an immediate action spends nothing beyond what its title says is checked by the registry reviewer
// (docs/plugins-registry.md; the linter flags every such action with a warning). Everyone else — no lower than confirm:
// in practice community plugins (G3; app-only, journaled) — a local plugin has no actions (with AGENTHUB_TEST_TIER=own on a
// test hub it is own).
// net="none" on the action (G2) lifts the floor that the plugin-level <agenthub.net> puts on it (a declared cost still counts).
export function actionLevel(pl, action) {
  if (pl?.source === "builtin") return action.level;
  const priced = ((pl?.meta?.net || []).length && action?.net !== "none") || actionHasCost(action);
  const floor = priced ? "confirm-cost" : trustedPlugin(pl) ? "immediate" : "confirm";
  return LEVELS.indexOf(action.level) >= LEVELS.indexOf(floor) ? action.level : floor;
}

// An action as /state.plugins[].actions shows it: input — the field the app renders (G1, placeholder in the hub language is set
// by localizePlugin), background — a job (G6), net — "none" (G2).
export function actionView(pl, a) {
  return {
    id: a.id,
    level: actionLevel(pl, a),
    title: a.title,
    arg: a.arg ? { ...a.arg } : null,
    ...(a.input ? { input: { placeholder: a.input.placeholder, maxLength: a.input.maxLength, ...(a.input.pattern ? { pattern: a.input.pattern } : {}) } } : {}),
    ...(a.background ? { background: true } : {}),
    ...(a.net ? { net: a.net } : {}),
  };
}

// An action's argument declarations (task 65). → { text, row }: text — what typed input is checked against (input actions only),
// row — the argument the frame's arg= binds (argv). A plain action: row = arg=. An input action: with inputPattern= the text
// pattern is that and row = arg= (may be null); without it arg= is the text pattern and there is no row argument (G1 as before).
export function inputDecls(action) {
  if (!action?.input) return { text: null, row: action?.arg || null };
  if (action.input.pattern) return { text: { name: action.arg?.name || "input", pattern: action.input.pattern }, row: action.arg || null };
  return { text: action.arg || null, row: null };
}

// The action declared a cost: cost= or cost-<lang>=.
export function actionHasCost(action) {
  if (action?.cost) return true;
  return Object.values(action?.i18n || {}).some((x) => Boolean(x?.cost));
}

// An action of a non-builtin plugin — only from the app (class app), at any level.
export function actionAppOnly(pl) {
  return pl?.source !== "builtin";
}

// The action command as it will be run: the same argv as PluginInstance.runAction (runner.mjs actionArgv:
// quotes and "\" per splitCommand rules, the value replaces the word `{name}` or goes at the end). Elements with spaces,
// quotes or "\" and empty ones — in single quotes so argument boundaries are visible. Display only.
// input — an input action (G1): the typed text is not in argv (it goes to stdin), a `{name}` word is dropped.
export function shownCommand(command, argDecl, value, { input = false } = {}) {
  let argv;
  try {
    argv = actionArgv(command, argDecl, value, { input });
  } catch {
    // unclosed quote: such an action will not run anyway (runAction throws) — shown as written
    return argDecl && !input ? `${String(command || "")} ${value}` : String(command || "");
  }
  return argv.map(quoteArg).join(" ");
}

function quoteArg(a) {
  const s = String(a ?? "");
  return s !== "" && !/[\s"'\\]/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
