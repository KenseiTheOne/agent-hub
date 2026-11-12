// Plugin secrets entered in the app (secrets service, lib/services/secrets.mjs; docs/api.md "Secrets").
//
//   GET    /secrets/:plugin        — app only: the plugin's declared keys (<agenthub.secrets>) with their state
//                                    (set | unset | denied | error | unavailable), never values
//   PUT    /secrets/:plugin/:key   — app only: { value } → write the keychain entry (stdin of `security -i`, not argv),
//                                    drop the cached value, restart the plugin with a fresh environment
//   DELETE /secrets/:plugin/:key   — app only: delete the entry, the same follow-up
//
// The value never reaches the journal, the bus or a response.

const unavailable = { status: 503, body: { error: "secrets:disabled" } };
const apiOf = (ctx) => ctx.facts.get("secrets.api") || null;

export const routes = [
  {
    method: "GET",
    path: "/secrets/:plugin",
    peers: ["app"],
    handler: async ({ params, ctx }) => {
      const api = apiOf(ctx);
      return api ? api.list(params.plugin) : unavailable;
    },
  },
  {
    method: "PUT",
    path: "/secrets/:plugin/:key",
    peers: ["app"],
    maxBody: 8 * 1024,
    handler: async ({ params, body, ctx }) => {
      const api = apiOf(ctx);
      if (!api) return unavailable;
      if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "args:value:required" } };
      return api.set(params.plugin, params.key, body.value);
    },
  },
  {
    method: "DELETE",
    path: "/secrets/:plugin/:key",
    peers: ["app"],
    maxBody: 1024,
    handler: async ({ params, ctx }) => {
      const api = apiOf(ctx);
      return api ? api.remove(params.plugin, params.key) : unavailable;
    },
  },
];
