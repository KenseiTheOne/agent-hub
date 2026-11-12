// Connections to external services via OAuth (oauth service, lib/services/oauth.mjs; docs/api.md "Connections").
//
//   GET  /connections                  — app, cli: connection state (without tokens)
//   POST /connections/:id/connect      — app only: start sign-in → { authorizeUrl, expiresAt, connection };
//                                        the shell opens the sign-in page
//   POST /connections/:id/cancel       — app only: abort an ongoing sign-in
//   POST /connections/:id/disconnect   — app only: "Disconnect" — remove the registration and tokens from the keychain
//   POST /connections/:id/mcp          — a trusted plugin's process (cli class, identified by pid: a run, the streamable
//                                        process or an action a human started): call an allowlisted MCP tool
//                                        { tool, args, fresh? } → result; fresh: true — a write or an explicit refresh,
//                                        past the interval cache (lib/services/oauth.mjs)
//   POST /connections/:id/http         — the same callers, a type="http" connection (G7): proxy one HTTP request to a declared
//                                        API host with the bearer token { method?, host?, path, query?, headers?, body?, fresh? }
//                                        → { ok, response: { status, headers, body, encoding, json?, truncated? }, fetchedAt,
//                                        nextAt, why, fresh, … } (GET/HEAD cached per interval unless fresh; other methods — writes)

import { pluginAllowed } from "../services/oauth.mjs";

const svcOf = (ctx) => ctx.facts.get("oauth.api") || null;
const unavailable = { status: 503, body: { error: "oauth:disabled" } };
const ERR_STATUS = { orphan: 409, "no-keychain": 409, "port-busy": 409, keychain: 500, "keychain-read": 503, discovery: 502, register: 502, net: 502, http: 502 };

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
      // only a plugin process the hub launched itself (the peer pid comes from the core, not from the request): a run,
      // the streamable process, or an action a human started (a write after a button press, like /terminal/*)
      const pl = ctx.facts.pluginByPid?.(peer.pid, { actions: true }) ?? null;
      const why = pluginAllowed(pl, c);
      if (why) {
        ctx.journal.write({ type: "mcp-denied", connector: c.id, plugin: pl?.id || null, pid: peer.pid ?? null, error: why });
        return { status: 403, body: { error: why } };
      }
      if (!body || typeof body !== "object" || typeof body.tool !== "string") return { status: 400, body: { error: "args:tool:required" } };
      if (body.fresh !== undefined && typeof body.fresh !== "boolean") return { status: 400, body: { error: "args:fresh:type" } };
      return c.call(pl, body.tool, body.args, { fresh: body.fresh === true });
    },
  },
  {
    method: "POST",
    path: "/connections/:id/http",
    peers: ["cli"],
    maxBody: 96 * 1024,
    handler: async ({ params, body, ctx, peer }) => {
      const { res, c } = conn(ctx, params.id);
      if (res) return res;
      // the same caller rule as /mcp: a process the hub launched for the plugin that declared the connection (pid from the core)
      const pl = ctx.facts.pluginByPid?.(peer.pid, { actions: true }) ?? null;
      const why = pluginAllowed(pl, c);
      if (why) {
        const error = why.replace(/^mcp:/, "http:");
        ctx.journal.write({ type: "http-denied", connector: c.id, plugin: pl?.id || null, pid: peer.pid ?? null, error });
        return { status: 403, body: { error } };
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "args:body:type" } };
      return c.httpRequest(pl, body);
    },
  },
];
