// Plugin manager HTTP (stage 8). Paths are /registry/* so they don't clash with the core's POST /plugins/:id/refresh.
//
//   GET  /registry/catalog    app, cli — catalog from the verified index.json + what's installed, permission growth, blocklist
//   GET  /registry/installed  app, cli — plugins.lock + Plugins/local ("unverified")
//   POST /registry/fetch      app      — download and verify index.json(.minisig)
//   POST /registry/check-updates app    — "Check now": check installed plugins for updates
//   POST /registry/install    app      — {id, consentToken?}: without a token, 428 with the permissions sheet; with a token — install
//   POST /registry/remove     app      — {id, purge?}
//   POST /registry/own/request  app, cli — {path}: a request for an own plugin from a local folder (agenthub plugins
//                                          install --from); without a pinned application — 409 own:no-app
//   POST /registry/own/approve  app      — {requestId, consentToken?}: without a token, always 428 with the consent sheet
//   POST /registry/own/decline  app      — {requestId}
//   POST /registry/key/accept   app      — {registry, consentToken?}: the key in config.json differs from the accepted one
//                                          (/state.registryKeys); without a token, 428 with both fingerprints; with it — the
//                                          new key is accepted and the catalog is fetched again
//
// The daemon decides on consent: the token is single-use, lives 120 s, and is bound to the id, the archive and the application's pid.
// A diagnostic shell run (peer.diagnostic: --snapshot-consent) can't change anything (server.mjs); install
// and own/approve answer it with the sheet but no install (preview): 428 or 409 consent:nothing. key/accept answers it
// with its sheet too (428, a token nothing accepts) and never accepts a key.

import { managerFor, RegistryError } from "../plugins.mjs";
import { _checker as pluginsChecker } from "../services/plugins.mjs";

function mgrOf(ctx) {
  const m = managerFor(ctx.paths.home);
  if (!m) throw new RegistryError(503, "registry:disabled");
  return m;
}

function wrap(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof RegistryError) return { status: e.status, body: { error: e.code, ...e.extra } };
      args.ctx.journal.write({ type: "registry-error", detail: String(e?.code || e?.message || e).slice(0, 160) });
      return { status: 500, body: { error: "internal" } };
    }
  };
}

const idOf = (body) => (body && typeof body.id === "string" ? body.id : null);

export const routes = [
  {
    method: "GET",
    path: "/registry/catalog",
    peers: ["app", "cli"],
    handler: wrap(async ({ ctx }) => ({ status: 200, body: mgrOf(ctx).listCatalog() })),
  },
  {
    method: "GET",
    path: "/registry/installed",
    peers: ["app", "cli"],
    handler: wrap(async ({ ctx }) => ({ status: 200, body: mgrOf(ctx).listInstalled() })),
  },
  {
    method: "POST",
    path: "/registry/fetch",
    peers: ["app"],
    handler: wrap(async ({ ctx }) => ({ status: 200, body: { ok: true, ...(await mgrOf(ctx).fetchCatalog()) } })),
  },
  {
    // "Check now" for plugin updates (Settings): the same check as the background one (lib/registry/updates.mjs),
    // notifying about new versions once. → {pluginUpdates, result}
    method: "POST",
    path: "/registry/check-updates",
    peers: ["app"],
    handler: wrap(async ({ ctx }) => {
      mgrOf(ctx);
      const c = pluginsChecker();
      if (!c) return { status: 503, body: { error: "registry:disabled" } };
      const result = await c.check("manual");
      return { status: 200, body: { pluginUpdates: ctx.facts.get("plugins.updates") ?? null, result: { ok: result.ok, error: result.error ?? null, skipped: result.skipped ?? null } } };
    }),
  },
  {
    method: "POST",
    path: "/registry/install",
    peers: ["app"],
    diagnostic: "preview",
    handler: wrap(async ({ body, peer, ctx }) => {
      const id = idOf(body);
      if (!id) return { status: 400, body: { error: "args:id:required" } };
      const token = typeof body.consentToken === "string" ? body.consentToken : null;
      // source: "registry" — install from the catalog over an own plugin with the same id (migration, consent sheet)
      const source = body.source === "registry" ? "registry" : null;
      return { status: 200, body: await mgrOf(ctx).install(id, { consentToken: token, peer, source, preview: Boolean(peer.diagnostic) }) };
    }),
  },
  {
    method: "POST",
    path: "/registry/remove",
    peers: ["app"],
    handler: wrap(async ({ body, peer, ctx }) => {
      const id = idOf(body);
      if (!id) return { status: 400, body: { error: "args:id:required" } };
      return { status: 200, body: mgrOf(ctx).remove(id, { purge: body.purge === true, peer }) };
    }),
  },
  {
    // A request for an own plugin: any local process (terminal, repository script) and the application. Only a human
    // in the pinned application installs it (approve). The path is absolute or ~/…: the CLI resolves a relative one
    // against its own directory.
    method: "POST",
    path: "/registry/own/request",
    peers: ["app", "cli"],
    maxBody: 8 * 1024,
    handler: wrap(async ({ body, peer, ctx }) => {
      const path = body && typeof body.path === "string" ? body.path : null;
      if (!path) return { status: 400, body: { error: "args:path:required" } };
      return { status: 200, body: mgrOf(ctx).requestOwn(path, { peer }) };
    }),
  },
  {
    method: "POST",
    path: "/registry/own/approve",
    peers: ["app"],
    diagnostic: "preview",
    handler: wrap(async ({ body, peer, ctx }) => {
      const requestId = body && typeof body.requestId === "string" ? body.requestId : null;
      if (!requestId) return { status: 400, body: { error: "args:requestId:required" } };
      const token = typeof body.consentToken === "string" ? body.consentToken : null;
      return { status: 200, body: mgrOf(ctx).approveOwn(requestId, { consentToken: token, peer, preview: Boolean(peer.diagnostic) }) };
    }),
  },
  {
    // The registry key in config.json is not the one the hub accepted: only a human in the pinned app makes it the trust root.
    // A diagnostic shell run (peer.diagnostic) gets the window only: the same 428 body with a token nothing accepts, and
    // 403 peer:diagnostic for a request that carries a token — it never reaches the fetch below.
    method: "POST",
    path: "/registry/key/accept",
    peers: ["app"],
    diagnostic: "preview",
    handler: wrap(async ({ body, peer, ctx }) => {
      const registry = body && typeof body.registry === "string" ? body.registry : null;
      if (!registry) return { status: 400, body: { error: "args:registry:required" } };
      const token = typeof body.consentToken === "string" ? body.consentToken : null;
      const m = mgrOf(ctx);
      const r = m.acceptRegistryKey(registry, { consentToken: token, peer, preview: Boolean(peer.diagnostic) });
      // the catalog on disk was signed with the previous key and no longer verifies: take the one the new key signs
      let fetchError = null;
      try {
        const f = await m.fetchCatalog();
        fetchError = f.registries.find((x) => x.name === registry)?.error ?? null;
      } catch (e) {
        fetchError = e instanceof RegistryError ? e.code : "registry:fetch";
      }
      return { status: 200, body: { ...r, fetched: !fetchError, ...(fetchError ? { fetchError } : {}) } };
    }),
  },
  {
    method: "POST",
    path: "/registry/own/decline",
    peers: ["app"],
    handler: wrap(async ({ body, peer, ctx }) => {
      const requestId = body && typeof body.requestId === "string" ? body.requestId : null;
      if (!requestId) return { status: 400, body: { error: "args:requestId:required" } };
      return { status: 200, body: mgrOf(ctx).declineOwn(requestId, { peer }) };
    }),
  },
];
