// The session.respond primitive — a reply to a Claude Code session request card (stage 6).
//
// Accepted only from app: the core forces session.* to be app-only (APP_ONLY in core.mjs),
// here is one more class check. Level immediate: the card in the app is the human's consent itself,
// no second NSAlert is needed. Under ESTOP the core answers 423 (app-only primitives aren't safeUnderEstop).
//
// Decisions are narrow only:
//   once   — "Allow once" (allow without updatedPermissions) for a tool permission;
//   deny   — "Deny" (deny with text, without interrupt) for a permission and for a question;
//   answer — choosing an AskUserQuestion option: allow + updatedInput = the original input + answers.
// "Always", bypass, setMode, updatedPermissions can't be expressed with arguments at all.
//
// answers — a JSON string: an array per question, an element is an array of option indexes or an "Other" string.
// presence — a slot for Touch ID (design §3), currently neither required nor checked.

import { t } from "../i18n.mjs";
import { hookStateFor } from "../hook/cards.mjs";

export const name = "session.respond";
export const level = "immediate";
export const remoteAllowed = false;
export const appOnly = true;

export const argsSchema = {
  requestId: { type: "string", required: true, pattern: "^[0-9a-f]{32}$" },
  decision: { type: "string", required: true, enum: ["once", "deny", "answer"] },
  answers: { type: "string", maxLength: 32 * 1024 },
  presence: { type: "string", maxLength: 4096 },
};

export function verifyFacts(args, facts, { peer } = {}) {
  if (peer?.class !== "app") return { ok: false, reason: "peer" };
  const st = hookStateFor(facts);
  if (!st) return { ok: false, reason: "no-hook-service" };
  const c = st.check(args.requestId, args.decision, args.answers);
  return c.ok ? { ok: true } : { ok: false, reason: c.reason };
}

export function describe(args, facts, lang = "ru") {
  const card = hookStateFor(facts)?.cards.get(args.requestId);
  const what = card ? card.summary : t(lang, "prim.session.respond.request");
  return { text: t(lang, `prim.session.respond.${args.decision === "once" ? "once" : args.decision === "deny" ? "deny" : "answer"}`, { what }), cost: null };
}

export async function run(args, ctx) {
  const st = hookStateFor(ctx.facts);
  if (!st) return { ok: false, error: "no-hook-service" };
  return st.resolve(args.requestId, args.decision, args.answers, ctx.requester);
}
