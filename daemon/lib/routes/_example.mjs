// Sample routes module (files starting with `_` are not loaded). Contract: docs/extension-points.md.
// Copy it to lib/routes/<name>.mjs without the underscore.

export const routes = [
  {
    method: "GET",
    path: "/example/:id",
    // Who may call it: a subset of ["app", "cli", "hook", "bridge"].
    peers: ["app"],
    // maxBody: 64 * 1024,   // for POST/PUT, 64 KB by default
    // raw: true,            // the handler writes to res itself (stream, SSE)
    handler: async ({ params, query, body, peer, ctx }) => {
      ctx.journal.write({ type: "example", id: params.id, peer: peer.class });
      return { status: 200, body: { id: params.id } };
    },
  },
];
