// cmux bridge routes (stage 5). Available only to the bridge class (peer.bridgePaths in the daemon config).
// Protocol: bridge/README.md; the channel lives in the lib/services/actions.mjs service (fact bridge.channel).

function channelOf(ctx) {
  const ch = ctx.facts.get("bridge.channel");
  return ch && typeof ch.next === "function" ? ch : null;
}

const off = { status: 503, body: { error: "bridge:disabled" } };

export const routes = [
  {
    method: "POST",
    path: "/bridge/hello",
    peers: ["bridge"],
    maxBody: 4 * 1024,
    handler: ({ body, peer, ctx }) => channelOf(ctx)?.hello(peer, body) || off,
  },
  {
    method: "POST",
    path: "/bridge/bye",
    peers: ["bridge"],
    maxBody: 1024,
    handler: ({ peer, ctx }) => channelOf(ctx)?.bye(peer) || off,
  },
  {
    // Long poll: 200 {op}, or 204 if nothing arrived within `wait` ms.
    method: "GET",
    path: "/bridge/next",
    peers: ["bridge"],
    handler: async ({ res, query, peer, ctx }) => {
      const ch = channelOf(ctx);
      if (!ch) return off;
      // res "close" before the reply means the bridge dropped: do not hand it the operation
      const onClose = (fn) => res.on("close", fn);
      const out = await ch.next(peer, query.get("wait"), onClose);
      return out || undefined;
    },
  },
  {
    method: "POST",
    path: "/bridge/result/:id",
    peers: ["bridge"],
    maxBody: 4 * 1024,
    handler: ({ params, body, peer, ctx }) => channelOf(ctx)?.result(peer, params.id, body) || off,
  },
];
