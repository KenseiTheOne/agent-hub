// Terminal for trusted plugins (contract 3; service lib/services/terminal.mjs, layer lib/terminals/).
//
//   POST /terminal/read-screen  { sessionId, lines? }  — input field flags of a Claude Code session tab (not text)
//   POST /terminal/send-text    { sessionId, text }    — type a line and Enter if the field is empty and the session is idle
//
// Only the plugin's own process may call it (class cli, identified by the peer pid on the socket — like
// POST /connections/:id/mcp): a running run, a streamable process or a running action (<agenthub.action>); a plugin
// descendant (curl) and the app don't get through here. The socket path is in the variable
// AGENTHUB_HUB_SOCKET (given to builtin, official and own). It isn't a primitive: control primitives
// are accepted only from the app and with confirmation, while a plugin needs background typing per its own setting.

const off = { status: 503, body: { error: "terminal:disabled" } };
const svcOf = (ctx) => {
  const s = ctx.facts.get("terminal.api");
  return s && typeof s.sendText === "function" ? s : null;
};

export const routes = [
  {
    method: "POST",
    path: "/terminal/read-screen",
    peers: ["cli"],
    maxBody: 1024,
    handler: async ({ body, peer, ctx }) => (await svcOf(ctx)?.readScreen(peer, body)) || off,
  },
  {
    method: "POST",
    path: "/terminal/send-text",
    peers: ["cli"],
    maxBody: 2048,
    handler: async ({ body, peer, ctx }) => (await svcOf(ctx)?.sendText(peer, body)) || off,
  },
];
