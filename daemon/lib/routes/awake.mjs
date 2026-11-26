// "Keep the Mac awake with the lid closed" over HTTP (lib/services/awake.mjs). The app and the command line both read
// and switch: the flag is machine-wide and harmless to flip, so `agenthub awake on|off` needs no application.
//
//   GET  /awake   app, cli — a fresh look at the flag, the rule and the battery → {awake} (same as /state.awake)
//   POST /awake   app, cli — {on: bool}: switch the flag → 200 {awake}
//                            400 args:on:type; 409 awake:unsupported (no lid), awake:not-granted (no sudoers rule, or
//                            sudo refused the switch — `agenthub awake grant`); 500 awake:failed (the command ran, the
//                            flag did not change; or the daemon is on its final exit and is returning sleep)
// Service off (services.awake.enabled = false) — 503 awake:disabled.

const STATUS = {
  "awake:unsupported": 409,
  "awake:not-granted": 409,
  "awake:failed": 500,
};

function wrap(fn) {
  return async (args) => {
    const svc = args.ctx.facts.get("awake.api") ?? null;
    if (!svc) return { status: 503, body: { error: "awake:disabled" } };
    return fn({ ...args, svc });
  };
}

export const routes = [
  {
    method: "GET",
    path: "/awake",
    peers: ["app", "cli"],
    handler: wrap(async ({ svc }) => ({ status: 200, body: { awake: await svc.fresh() } })),
  },
  {
    method: "POST",
    path: "/awake",
    peers: ["app", "cli"],
    handler: wrap(async ({ svc, body, peer }) => {
      if (!body || typeof body.on !== "boolean") return { status: 400, body: { error: "args:on:type" } };
      const r = await svc.set(body.on, peer);
      if (r.error) return { status: STATUS[r.error] || 500, body: { error: r.error, awake: r.awake } };
      return { status: 200, body: { awake: r.awake } };
    }),
  },
];
