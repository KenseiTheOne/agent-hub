// The job.cancel primitive — stop a background job of a plugin (<agenthub.action background="true">, G6): SIGTERM to the job's
// process group, SIGKILL two seconds later. A job is started by a human in the app, so only the app stops it (app-only); it is
// immediate — stopping takes nothing that cannot be started again. Job ids come from /state.plugins[].jobs[].id.

import { t } from "../i18n.mjs";

export const name = "job.cancel";
export const level = "immediate";
export const remoteAllowed = false;
export const appOnly = true;

export const argsSchema = {
  job: { type: "string", required: true, positional: true, pattern: "^[0-9a-f]{16}$" },
};

export function verifyFacts(args, facts) {
  return facts.job?.(args.job) ? { ok: true } : { ok: false, reason: "no-job" };
}

export function describe(args, facts, lang = "ru") {
  const j = facts?.job?.(args.job);
  const plugin = j ? facts.plugin?.(j.plugin)?.title || j.plugin : null;
  return { text: t(lang, "prim.job.cancel", { title: j?.title || args.job, plugin }), cost: null };
}

export async function run(args, ctx) {
  return ctx.cancelJob(args.job, ctx.requester);
}
