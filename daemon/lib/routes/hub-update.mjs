// Hub update HTTP (docs/hub-updates.md §6). app and cli read; only the pinned application (app class) starts a check,
// install and rollback. Hub paused — 423.
//
//   GET  /hub-update            app, cli — same as /state.hubUpdate
//   POST /hub-update/check      app      — check now (git ls-remote, ≤ 30 s; release notes are loaded
//                                          after the response — hub-update.status) → {hubUpdate, result}
//   POST /hub-update/install    app      — {version, acceptCommit?}: build and switch → 202 {hubUpdate};
//                                          tag moved to another commit — 409 hub-update:tag-moved without acceptCommit
//   POST /hub-update/rollback   app      — {version?}: to previous (or the given built one) → 202 {hubUpdate}
//   POST /hub-update/switch     app      — a built version is waiting (phase ready: waited for cards) — switch now
//   (in ready, installing the same version and rollback — 409 hub-update:ready: a built, verified version isn't silently thrown away)

import { isLabel } from "../version.mjs";

const STATUS = {
  "hub-update:estop": 423,
  "hub-update:busy": 409,
  "hub-update:not-installed": 409,
  "hub-update:not-newer": 409,
  "hub-update:unknown-version": 404,
  "hub-update:no-previous": 404,
  "hub-update:tag-moved": 409,
  "hub-update:untrusted-build": 409,
  "hub-update:not-ready": 409,
  "hub-update:ready": 409,
};

function updaterOf(ctx) {
  return ctx.facts.get("hub.updater") ?? null;
}

function wrap(fn) {
  return async (args) => {
    const u = updaterOf(args.ctx);
    if (!u) return { status: 503, body: { error: "hub-update:disabled" } };
    try {
      return await fn({ ...args, u });
    } catch (e) {
      const code = typeof e?.code === "string" && e.code.startsWith("hub-update:") ? e.code : "internal";
      if (code === "internal") args.ctx.journal.write({ type: "hub-update-error", detail: String(e?.message || e).slice(0, 160) });
      return { status: STATUS[code] || (code === "internal" ? 500 : 400), body: { error: code, hubUpdate: u.info() } };
    }
  };
}

const versionOf = (body) => (body && typeof body.version === "string" && isLabel(body.version) ? body.version : null);

export const routes = [
  {
    method: "GET",
    path: "/hub-update",
    peers: ["app", "cli"],
    handler: wrap(async ({ u }) => ({ status: 200, body: u.info() })),
  },
  {
    method: "POST",
    path: "/hub-update/check",
    peers: ["app"],
    handler: wrap(async ({ u }) => {
      const result = await u.checker.check("manual");
      return { status: 200, body: { hubUpdate: u.info(), result: { ok: result.ok, error: result.error ?? null, skipped: result.skipped ?? null } } };
    }),
  },
  {
    method: "POST",
    path: "/hub-update/install",
    peers: ["app"],
    handler: wrap(async ({ u, body, peer }) => {
      const v = versionOf(body);
      if (!v) return { status: 400, body: { error: "args:version:required" } };
      const accept = body?.acceptCommit;
      if (accept !== undefined && (typeof accept !== "string" || !/^[0-9a-f]{40}$/.test(accept))) return { status: 400, body: { error: "args:acceptCommit:type" } };
      return { status: 202, body: { hubUpdate: u.install(v, peer, { acceptCommit: accept ?? null }) } };
    }),
  },
  {
    method: "POST",
    path: "/hub-update/rollback",
    peers: ["app"],
    handler: wrap(async ({ u, body, peer }) => {
      if (body?.version !== undefined && !versionOf(body)) return { status: 400, body: { error: "args:version:type" } };
      return { status: 202, body: { hubUpdate: u.rollback(versionOf(body), peer) } };
    }),
  },
  {
    method: "POST",
    path: "/hub-update/switch",
    peers: ["app"],
    handler: wrap(async ({ u, peer }) => ({ status: 202, body: { hubUpdate: u.switchReady(peer) } })),
  },
];
