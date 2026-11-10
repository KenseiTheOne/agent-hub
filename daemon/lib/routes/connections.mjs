// Connections to external services via OAuth (oauth service, lib/services/oauth.mjs; docs/api.md "Connections").
//
//   GET  /connections                  — app, cli: connection state (without tokens)
//   POST /connections/:id/connect      — app only: start sign-in → { authorizeUrl, expiresAt, connection };
//                                        the shell opens the sign-in page
//   POST /connections/:id/cancel       — app only: abort an ongoing sign-in
//   POST /connections/:id/disconnect   — app only: "Disconnect" — remove the registration and tokens from the keychain
//   POST /connections/:id/mcp          — a trusted plugin's process (cli class, identified by pid): call an
//                                        allowlisted MCP tool { tool, args } → result

import { pluginAllowed } from "../services/oauth.mjs";

const svcOf = (ctx) => ctx.facts.get("oauth.api") || null;
const unavailable = { status: 503, body: { error: "oauth:disabled" } };
const ERR_STATUS = { orphan: 409, "no-keychain": 409, keychain: 500, "keychain-read": 503, discovery: 502, register: 502, net: 502, http: 502 };

function conn(ctx, id) {
  const svc = svcOf(ctx);
  if (!svc) return { res: unavailable };
  const c = svc.get(id);
  if (!c) return { res: { status: 404, body: { error: "not-found" } } };
  return { svc, c };
}

export const routes = [
  {
    method: "GET",
    path: "/connections",
    peers: ["app", "cli"],
    handler: ({ ctx }) => {
      const svc = svcOf(ctx);
      return svc ? { status: 200, body: { connections: svc.list() } } : unavailable;
    },
  },
  {
    method: "POST",
    path: "/connections/:id/connect",
    peers: ["app"],
    maxBody: 1024,
    handler: async ({ params, ctx, peer }) => {
      const { res, c } = conn(ctx, params.id);
      if (res) return res;
      try {
        const r = await c.connect();
        ctx.journal.write({ type: "oauth-connect-requested", connector: c.id, peer: peer.class, pid: peer.pid ?? null });
        return { status: 200, body: { ...r, connection: c.info() } };
      } catch (e) {
        const code = e?.code || "internal";
        ctx.journal.write({ type: "oauth-connect-failed", connector: c.id, error: code, reason: e?.reason || null, status: e?.status ?? null });
        c.error = code;
        // detail (discovery: resource-mismatch, issuer-url, no-s256, …): the shell tells a network failure from a change
        // of sign-in settings on the service side
        c.errorReason = typeof e?.reason === "string" ? e.reason : null;
        c.svc.changed();
        return { status: ERR_STATUS[code] || 502, body: { error: `oauth:${code}`, ...(e?.reason ? { reason: e.reason } : {}), connection: c.info() } };
      }
    },
  },
  {
    method: "POST",
    path: "/connections/:id/cancel",
    peers: ["app"],
    maxBody: 1024,
    handler: ({ params, ctx }) => {
      const { res, c } = conn(ctx, params.id);
      if (res) return res;
      return { status: 200, body: { cancelled: c.cancel(), connection: c.info() } };
    },
  },
  {
    method: "POST",
    path: "/connections/:id/disconnect",
    peers: ["app"],
    maxBody: 1024,
    handler: async ({ params, ctx }) => {
      const { res, c } = conn(ctx, params.id);
      if (res) return res;
      const r = await c.disconnect();
      c.svc.afterDisconnect?.(c, r);
      return { status: r.ok ? 200 : 500, body: { ok: r.ok, ...(r.ok ? {} : { error: `oauth:${r.error || "keychain-delete"}` }), connection: c.info() } };
    },
  },
  {
    method: "POST",
    path: "/connections/:id/mcp",
    peers: ["cli"],
    maxBody: 16 * 1024,
    handler: async ({ params, body, ctx, peer }) => {
      const { res, c } = conn(ctx, params.id);
      if (res) return res;
      // only a plugin process the hub launched itself (the peer pid comes from the core, not from the request)
      const pl = ctx.facts.pluginByPid?.(peer.pid) ?? null;
      const why = pluginAllowed(pl, c);
      if (why) {
        ctx.journal.write({ type: "mcp-denied", connector: c.id, plugin: pl?.id || null, pid: peer.pid ?? null, error: why });
        return { status: 403, body: { error: why } };
      }
      if (!body || typeof body !== "object" || typeof body.tool !== "string") return { status: 400, body: { error: "args:tool:required" } };
      return c.call(pl, body.tool, body.args);
    },
  },
];
