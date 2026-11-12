// External daemon extensions (G4, lib/extensions.mjs): the list and the human's consent.
//
//   GET  /extensions          app, cli — the same as /state.extensions: {dir, enabled, testAutoApprove, consent, pending, items}
//   POST /extensions/approve  app      — {path, sha256}: the human approved exactly these bytes (the sha256 the app showed with the
//                                        consent text); a different current sha256 → 409 extensions:changed {sha256}. Loaded right away.
//   POST /extensions/revoke   app      — {path}: drop the approval; a loaded module runs until the daemon restarts.
//
// Approvals are written only here (Registry/ext-approvals.json): app class only — a plugin process, a script or an agent cannot
// approve code that would run inside the daemon. A diagnostic app run (peer.diagnostic) is refused by the server for non-GET.

import { ExtensionError } from "../extensions.mjs";

function mgr(ctx) {
  const m = ctx.facts.get("extensions.api");
  if (!m) throw new ExtensionError(503, "extensions:unavailable");
  return m;
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof ExtensionError) return { status: e.status, body: { error: e.code, ...e.extra } };
      args.ctx.journal.write({ type: "extension-route-error", detail: String(e?.code || e?.message || e).slice(0, 160) });
      return { status: 500, body: { error: "internal" } };
    }
  };
}

export const routes = [
  {
    method: "GET",
    path: "/extensions",
    peers: ["app", "cli"],
    handler: wrap(async ({ ctx }) => {
      const m = mgr(ctx);
      m.scan();
      return { status: 200, body: m.info(ctx.lang()) };
    }),
  },
  {
    method: "POST",
    path: "/extensions/approve",
    peers: ["app"],
    maxBody: 4 * 1024,
    handler: wrap(async ({ body, peer, ctx }) => {
      const path = typeof body?.path === "string" ? body.path : null;
      const sha256 = typeof body?.sha256 === "string" ? body.sha256.toLowerCase() : null;
      if (!path) return { status: 400, body: { error: "args:path:required" } };
      if (!sha256) return { status: 400, body: { error: "args:sha256:required" } };
      return { status: 200, body: await mgr(ctx).approve(path, sha256, peer) };
    }),
  },
  {
    method: "POST",
    path: "/extensions/revoke",
    peers: ["app"],
    maxBody: 4 * 1024,
    handler: wrap(async ({ body, peer, ctx }) => {
      const path = typeof body?.path === "string" ? body.path : null;
      if (!path) return { status: 400, body: { error: "args:path:required" } };
      return { status: 200, body: mgr(ctx).revoke(path, peer) };
    }),
  },
];
