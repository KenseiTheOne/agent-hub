// POST /push/ack — the shell acknowledges that it showed the `push.notify` notification itself.
// Without an acknowledgement within ackTimeoutMs the push service shows a banner via osascript.
// App only; cli — only with services.push.acceptCliAck=true (while the app build is not pinned —
// requirements.app). An acknowledgement allows nothing, it only suppresses a duplicate banner.

import { ack } from "../push/acks.mjs";

export const routes = [
  {
    method: "POST",
    path: "/push/ack",
    peers: ["app", "cli"],
    maxBody: 1024,
    handler: ({ body, peer, ctx }) => {
      if (peer.class !== "app" && ctx.config.services?.push?.acceptCliAck !== true) {
        return { status: 403, body: { error: `peer:${peer.class}` } };
      }
      const id = body?.id;
      if (typeof id !== "string" || !/^[\w-]{8,64}$/.test(id)) return { status: 400, body: { error: "body" } };
      return { status: 200, body: { ok: ack(id) } };
    },
  },
];
