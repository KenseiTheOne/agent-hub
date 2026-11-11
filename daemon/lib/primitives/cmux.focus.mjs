// cmux.focus — the former name of terminal.focus (primitives/terminal.focus.mjs), deprecated: still accepted until the next
// contract so that installed plugins keep working; new plugins write terminal.focus or session.focus <sessionId>.
// The same arguments, checks and refusals; the core treats the two names as one in <agenthub.effects> (core.mjs PRIMITIVE_ALIASES).

export { level, remoteAllowed, argsSchema, verifyFacts, describe, run } from "./terminal.focus.mjs";

export const name = "cmux.focus";
export const aliasOf = "terminal.focus";
export const deprecated = true;
