# Daemon extension points

This is the **contract** for everyone extending Agent Hub (stage 5 primitives, stage 6 session answers, stage 4 push,
the bridge, the stage 8 plugin registry, built-in plugins). Only its owner edits the core (`daemon/lib/core.mjs`,
`server.mjs`, `peer.mjs`, `runner.mjs`, `output.mjs`, `meta.mjs`, `ctx.mjs`); everything else is added as **new files**
in the directories below. If you need a core change, describe it in your report rather than making it yourself. The same
modules can also live outside the source tree, on one Mac, in `<AGENTHUB_HOME>/Extensions` — loaded only after a human
approves each file in the app (below, "External extensions"); they survive hub updates.

| What | Where | Picked up |
|---|---|---|
| Core primitive | `daemon/lib/primitives/<name>.mjs` | at daemon start |
| HTTP route | `daemon/lib/routes/<name>.mjs` | at daemon start |
| Background service | `daemon/lib/services/<name>.mjs` | at daemon start, **before** plugins |
| Built-in plugin | `plugins/<id>.<interval>.<ext>` or `plugins/<id>/<id>.<interval>.<ext>` | on the fly (the directory is watched) |
| Installed plugin | `<AGENTHUB_HOME>/Plugins/<id>/…` | on the fly |
| Local plugin (development) | `<AGENTHUB_HOME>/Plugins/local/…` | on the fly |
| External extension | `<AGENTHUB_HOME>/Extensions/{services,routes,primitives,terminals}/<name>.mjs` | at daemon start after the built-in ones of its kind, or right after a human approves it in the app ([below](#external-extensions-homeextensions)) |
| Own plugin (2026-11-09) | a folder in your tool's repository `agenthub/<id>/` → a copy in `<AGENTHUB_HOME>/Plugins/<id>/` | a request via `agenthub plugins install --from <folder>` or "Add from folder…", a human installs it in the app; after that the hub watches the folder itself ([`plugins-registry.md`](plugins-registry.md), "Own sources") |

Files whose name starts with `_` or `.` are not loaded (samples: `routes/_example.mjs`, `services/_example.mjs`).
Modules load in alphabetical order of file name. A module load error does not crash the daemon — a `load-error` is
written to the journal.

## State directory and test mode

- By default `~/Library/Application Support/AgentHub/`: `hub.sock`, `journal.jsonl`, `config.json`, `ESTOP`,
  `Plugins/`, `plugins.lock` (stage 8), `Registry/` (registry catalog, quarantine), `PluginData/<id>/`, `Cache/<id>/`,
  `Cache/usage.json` (the Claude subscription quota from the `usage` service, 0600; format in [`api.md`](api.md)),
  `Cache/claude-sessions.json` (metadata of live Claude Code sessions from the `sessions` service, 0600; contract 3, format
  below, "Plugin environment"), `logs/`, `push-state.json` (the push service), `launch/` (0700, `session.launch` prompts;
  the actions service deletes abandoned ones older than 10 min).
- `AGENTHUB_HOME=<dir>` — all of the same in a temporary directory (tests, manual checks). The socket path must be
  ≤ 103 bytes: use a short `mktemp -d /tmp/ah-XXXX`.
- The live daemon's built-in plugins are a **copy** in `<home>/Builtin` (0700/0600, executables 0700; inventory
  `.agenthub-builtin.json`): `agenthub install --apply` (the full installation with launchd) puts it there and
  `agenthub builtin update` refreshes it, and `config.json` gets `builtinPluginsDir: "<home>/Builtin"`. An edit in
  `<repo>/plugins` does not reach the running hub until the copy is refreshed (`agenthub builtin` — whether it matches the
  repo and whether the daemon runs on it, from `/state.hub.builtinDir`). Without an installation and in test mode
  (`AGENTHUB_HOME`) — as before, from `<repo>/plugins`; `agenthub install --apply` with launchd from an environment where
  `AGENTHUB_HOME` points elsewhere refuses (the LaunchAgent brings up the live hub, and the copy would go to the wrong
  place).
- Other test variables: `AGENTHUB_BUILTIN_PLUGINS` (instead of `<repo>/plugins` and the copy), `AGENTHUB_CLAUDE_HOME`
  (instead of `~/.claude`), `AGENTHUB_SERVICES=none|a,b` (which services start), `AGENTHUB_TEST_EXEC_LOG=<file>`
  (`ctx.exec` runs no programs, but writes `{file,args}` as a JSON line to the file and returns `code: 0`),
  `AGENTHUB_PLUGIN_HOME` (the plugins' HOME — a synthetic `~`; only works together with `AGENTHUB_HOME`).
- `config.json` is merged over the defaults (`daemon/lib/config.mjs`, `DEFAULTS`). Keys:
  `requirements.app`, `requirements.claudeCode`, `peer.*`, `claudeHome`, `builtinPluginsDir`, `plugins.*`,
  `journal.maxBytes`, `services.<name>.enabled` (false — the service does not start) and any `services.<name>.*` for the
  service itself.

## Extension context (`ctx`, `daemon/lib/ctx.mjs`)

The same for primitives, routes and services. The object is frozen.

| Field | What |
|---|---|
| `name` | extension name: `primitive:<name>`, `route:<file>`, `service:<name>` |
| `config`, `paths` | the daemon configuration and the state directory paths (read-only) |
| `journal.write(entry)` | a record in `journal.jsonl`; `source: ctx.name` is added. **Metadata only**: values are scalars (string ≤ 200), arrays of scalars ≤ 20; objects are dropped; the keys `tool_input`, `prompt`, `text`, `body`, `content`, `token`, `secret`, `password`, `transcript`, `stdout`, `stderr`, `env`, `message`, `input`, `output`, `answer`, `updatedInput`, … are replaced with `[hidden]` (`[скрыто]` with the Russian hub language). Never write conversation text there, not even under another key. |
| `journal.tail(n)` | the last n records |
| `state.snapshot()` | the same as `GET /state` |
| `state.plugin(id)`, `state.plugins()`, `state.worstStatus()` | copies of plugin state |
| `state.pluginEvent(id, key)` | lightweight data for event text: `{id, title, trusted, error, itemTitle, pushRules}` (no copy of the whole state; `null` — no such plugin) |
| `state.pluginSignals()` | for the "can I shut down" verdict (the idle service): `[{id, title, tier, trusted, status, type, intervalMs, lastRunAt, signalsAt, activity, needsOn}]` — without copying frames; `activity`/`needsOn` are `null` (the plugin does not report), `[]` (it reports that it is quiet) or phrases; `lastRunAt` and `signalsAt` (when the phrases last arrived) are epoch ms; `intervalMs` is the scheduled interval (`null` for cron and streamable) |
| `peer.verifySigned(pid, requirementName)` | `Promise<{ok, pid, path?, startSec?, reason?}>` — `codesign --verify --strict -R=<config.requirements[requirementName]>` on the process executable; cached by (pid, start time, path) and by file. `reason`: `no-requirement`, `bad-pid`, `no-process`, `foreign-uid`, `no-path`, `no-file`, `signature` |
| `peer.classifyPid(pid)` | the process class as the server would determine it |
| `peer.verifyHookSession(peerInfo, sessionId)` | `{ok}` or `{ok:false, reason:"peer:session-mismatch"\|"peer:no-session-file"\|"peer:not-hook"}` |
| `facts` | core facts for verifying arguments (below) |
| `sessions` | the session registry (below) |
| `emit(event)` | an event on the bus: `{type, ...}`; `type` is `[\w.:-]{1,64}`, for your own events — prefixed with the extension (`push.sent`, `bridge.connected`). `id`, `ts`, `source` are added. Goes to `ctx.on` subscribers and to SSE `GET /events`. Metadata only. |
| `on(type, fn)`, `off(type, fn)` | bus subscription; `type = "event"` — all events. The internal core event `app.peer` (`{connected, pid, startSec, path, alive?, count}` — an app-class connection opened or closed; `alive` — whether the process is alive, `count` — how many app connections remain) goes only to `on("app.peer")` subscribers, not to SSE or `on("event")` |
| `estop()` | `true` if the hub is paused (the `ESTOP` file exists; in the UI — "Pause hub"). Setting and lifting the pause restarts plugins (contract 3: `AGENTHUB_PAUSED`, `AGENTHUB_REFRESH_REASON=Paused\|Resumed`) |
| `lang()`, `t(key, params)` | the effective hub language (`ru` \| `en`, set in `<home>/settings.json`, [`api.md`](api.md)) and a core message in it (`daemon/lib/i18n.mjs`) |
| `settings.get(key)` | a shell setting from `<home>/settings.json`, read-only: `lang`, `checkPluginUpdates` (the plugins service — background update check), `checkHubUpdates` (the hub-update service), `launchAtLogin` (the app service — "Launch at login"). Only app writes them (`PUT /settings/*`); a change emits `settings.changed` with that key |
| `exec(file, args, {timeoutMs, cwd, env})` | `Promise<{code, stdout, stderr, timedOut?}>` via `execFile` (no shell); in test mode — a record in `AGENTHUB_TEST_EXEC_LOG` |
| `sendToPlugin(pluginId, obj)` | NDJSON to a streamable plugin's stdin (`{"type":"inbound",...}` from the hook and so on); `false` if it is not streamable or not running |
| `refreshPlugin(pluginId, reason)` | restart a standard plugin / `{"type":"refresh"}` for streamable |
| `restartPlugin(pluginId, reason)` | restart a plugin with a **freshly built environment** (a secret was written, a service variable changed): a streamable process gets `{"type":"stopping","reason":"restart","cause":<reason>}`, is stopped and started again; a standard one gets an extra run. `reason` — the new `AGENTHUB_REFRESH_REASON`, `[A-Z][A-Za-z]{1,31}` (`SecretChanged`); journaled as `plugin-restart`. Background jobs keep running. → `Promise<boolean>` (`false` — no such running plugin) |
| `cancelJob(jobId, requester?)` | stop a plugin's background job (`<agenthub.action background="true">`): SIGTERM to its group, SIGKILL 2 s later; journaled `job-cancel`. → `{ok, error?: "no-job"}` (the `job.cancel` primitive) |
| `rescanPlugins()` | rescan the plugin directories now and re-evaluate the policy of running ones (after install, removal, blocklist). The host also rescans by itself every `plugins.rescanIntervalMs` (60 s): fs.watch loses events |
| `onHook(handler)` | registers a `POST /hook` handler (stage 6): `handler(body, {peer, signal})`, `signal` is an `AbortSignal` for the hook connection dropping; returns an unregister function. Handlers are called in order; the first one returning something other than `undefined`/`null` sets the hook answer. No handler, ESTOP or an error → `{}`; while the hub is paused handlers are called only for `SessionStart`, `SessionEnd`, `Stop` (the answer is `{}`) |
| `providePluginEnv(name, value)` | a service gives **trusted** plugins (`builtin`, `official` and `own` — by core policy, not by metadata) an environment variable: `AGENTHUB_<NAME>` (not `AGENTHUB_SECRET_*` and not the core-reserved ones: `AGENTHUB_PLUGIN_ID`, `…_DATA_PATH`, `…_CACHE_PATH`, `AGENTHUB_REFRESH_REASON`, `AGENTHUB_LANG`, `AGENTHUB_LOCALE`, `AGENTHUB_PAUSED`); `value: null` removes it. The value is not a secret (a path to its own cache and the like). Already running plugins see it from their next run; services start before plugins. Currently: `AGENTHUB_USAGE_FILE` (the `usage` service), `AGENTHUB_HUB_SOCKET` (the hub socket path: since contract 3 the core always gives it to trusted plugins, not only with the `oauth` service — this is how a plugin calls `POST /connections/:id/mcp|http` and `/terminal/*`), `AGENTHUB_CLAUDE_SESSIONS_FILE` (the `sessions` service, contract 3: metadata of live Claude Code sessions) |
| `registerSecretsProvider(fn)` | `fn(pluginId, key, plugin) → Promise<string|undefined>`; the core calls it for every `<agenthub.secrets>` of a plugin and puts the value into the environment as `AGENTHUB_SECRET_<KEY>` (`example.token` → `AGENTHUB_SECRET_EXAMPLE_TOKEN`). One provider per daemon; currently the `secrets` service installs it (the keychain, `agent-hub.<service>` / `<entry>`; built-in plugins get any keys except `oauth.*`, installed ones only `<id>.*` (and never `oauth.*`, even for a plugin with id `oauth`), `Plugins/local` — nothing; in test mode the keychain is not read). The same service gives other services the fact `secrets.store` — `get/set/delete` of `agent-hub.oauth` / `<connection>.client|token` entries (JSON; written via stdin of `security -i`, not argv): this is how the `oauth` service stores client registrations and tokens. And the fact `secrets.api` — `list/set/remove` of a plugin's declared keys for the app routes `GET /secrets/:plugin`, `PUT|DELETE /secrets/:plugin/:key` ([`api.md`](api.md), "Secrets"; after a change the cached value is dropped and the plugin restarts via `ctx.restartPlugin` when the core offers it, else `refreshPlugin`, reason `SecretChanged`). Key: service `[a-z0-9][a-z0-9_-]{0,63}`, account `[a-z][a-z0-9_.-]{0,63}`; cache — 5 min for a found value, 1 min for a missing one |
| `setPluginPolicy(fn)` | stage 8: `fn(plugin, defaults) → {allowed, reason?, effects?, tier?}`; `tier: "official"` is respected only for `installed` (the plugins service gives it only if the verified catalog currently names the id official, the sha256 from `plugins.lock` is signed as official — by the current catalog or by the saved earlier index `Registry/attest/<id>` (a released new version does not demote the installed one until it is updated), and the files match the saved archive `Registry/archives/<id>.tar.gz`); the core still cuts the effects of non-built-in plugins down to the ceiling and gives `<agenthub.action>` to `builtin` and installed plugins only (community — never below `confirm`). No policy (the plugins service is off, not in `AGENTHUB_SERVICES` or failed at startup) — installed plugins (`Plugins/<id>`) are not admitted (`policy:no-manager` in the journal); built-in and local ones work as usual |
| `invoke({id, args, confirmToken, peer})` | call an action the same way as `POST /actions/:id`. `peer` is passed as is — pass only the real `peer` from a route handler |

### `facts`

| Method | What |
|---|---|
| `estop()` | the hub is paused (estop) |
| `lang()` | the effective hub language: `ru` \| `en` |
| `plugin(id)` | the plugin's internal state or `null` |
| `offer(id)` | a plugin offer (`{id, pluginId, kind, primitive?, args?, action?, level, label}`) |
| `session(sessionId)`, `sessionByPid(pid)`, `sessions()` | session registry records (signature-verified only) |
| `externalSession(id)`, `externalSessions()` | non-Claude agent sessions (`kind: "external"`, from trusted plugins' `agentSession=` lines): `{sessionId, pid, startSec, kind, agent, name, owner, updatedAt}`; a record whose process ended or whose pid was reused is dropped on lookup. Only `session.focus` takes them; a primitive that works on Claude Code sessions only refuses them with `external-session` |
| `appConnections()` | live `app`-class connections: `[{pid, startSec, path}]` (the app service — app supervision) |
| `stopping()` | `true` if the daemon is stopping (`POST /shutdown`, SIGTERM): closed connections are not a crash |
| `runningActions()` | plugin actions running right now (`POST /actions/:id` → the action command): `[{action, plugin, title, since}]`, plus background jobs as `{…, job, background: true}`; start — the `action.started {action, plugin, actionId}` event, end — `action` (a job: `job.started` / `job.exited`). The idle service shows them as a line "<plugin>: running "…"" |
| `jobs()`, `job(id)` | background jobs of plugins: `[{id, plugin, actionId, title, startedAt, pid}]`, one or `null` |
| `provide(name, fn)` | an extension adds its own fact (`"bridge.online"`, `"bridge.surfaces"`, `"hook.pending"` — waiting cards `[{requestId, sessionId, kind, tool, subagent}]`, `"plugins.busy"` — plugin installations in progress, `"idle.state"` — the "can I shut down" verdict, `"secrets.store"` — the keychain store for connections (the secrets service), `"secrets.api"` — plugin secrets entered in the app (the secrets service), `"oauth.connections"` — connection state without tokens, `"oauth.api"` — the oauth service for its routes, `"push.channels"` — the push service's channel registry (`register(channel) → unregister`, `list()`; below, "Push channel"), `"terminal.adapters"` — the core's terminal adapter list (built-in + approved extensions), `"extensions.api"` — the extension manager for its routes…). Each name once per daemon |
| `get(name, ...args)` | the fact value (`undefined` if there is none) |
| `pluginByPid(pid, {actions}?)` | whose process this is: a running standard run or a streamable plugin process; with `{actions: true}` also an action process or a background job (never a descendant) → `{id, source, tier, trusted, net, terminal}` or `null`. For routes that serve plugins themselves: the peer pid on the socket comes from the kernel (`peer.pid`), not from the request (`POST /connections/:id/mcp|http` and `/terminal/*` pass `{actions: true}`). The server itself also walks every ancestor of a peer (and checks the process group of each) with it to bind `peer.plugin` ([`api.md`](api.md#peer-classes)) |

### `sessions` — the Claude Code session registry

A session is **only a process whose executable passes `requirements.claudeCode`** (`com.anthropic.claude-code`, Team
ID `Q6L2SF6YDW`). The cmux shim and a planted `~/.claude/sessions/<pid>.json` with someone else's pid fail the check.

- `register(sessionId, {pid, source, status?, waitingFor?, name?, interactive?, surfaceId?, workspaceId?, effort?, ultracode?, model?, modelSource?, effortSource?, metaAt?})` →
  `Promise<{verified, reason?}>`. `source` is where the data comes from (`plugin:<id>`, `hook`). A session that fails
  the check does not enter the registry.
- `unregister(sessionId, source)` — drop a source; the record is deleted when no sources remain.
- `get(id)`, `list()`, `waitingCount()` (sessions with `status: "waiting"`).
- `external(id)`, `externalList()` — non-Claude agent sessions (see `facts.externalSession`); not part of `get`/`list`.
- A registry change → the `sessions` event on the bus.
- `interactive: true` is set by stage 6 on `SessionStart` from the hook; only such sessions can receive `allow`.

A plugin only needs to put `session=<sessionId> pid=<pid>` in an output line — the core verifies the signature itself
(see "Plugin contract"). Only trusted plugins — builtin, official and own — write such lines into the registry (status,
tab, session name); for community and local plugins the core only marks `verified` in their own frame.

## Primitive (`daemon/lib/primitives/<name>.mjs`)

Samples: `open.url.mjs`, `open.file.mjs`.

`effect=open.file <path>` opens only documents (text, Markdown, JSON/YAML, PDF, office files, images, audio, video —
`OPEN_EXT` in `open.file.mjs`) and regular folders without an extension. Everything else — executables (the x bit),
other types (`.zip`, `.swift`, a file without an extension…), package directories (`.app`, `.sparsebundle`…), Finder
aliases and files with their own handler program — is refused with `409 facts:<reason>` (the list is in
[`api.md`](api.md), "Primitives"); such things can only be revealed in Finder: `effect=open.file reveal=true <path>`.
Any folder with a dot in its name counts as a package, even an ordinary one (`site.com`, `notes.d`): `open` decides by
the extension and might launch or mount it, so the hub only reveals it — decision 2026-11-11, kept on purpose; point
a plugin at such a folder with `reveal=true`.

```js
export const name = "session.stop";          // [a-z][\w]*(\.[a-zA-Z][\w]*)+ ; unique
export const level = "confirm";              // "immediate" | "confirm" | "confirm-cost"
export const remoteAllowed = false;          // a flag for future remote channels (currently only visible in /state)
export const appOnly = true;                 // optional: accept only from app
export const safeUnderEstop = false;         // optional: true — also works while the hub is paused (harmless things only)
export const argsSchema = {                  // extra arguments → 400 args:<name>:unknown
  sessionId: { type: "string", required: true, positional: true, pattern: "^[0-9a-fA-F-]{36}$" },
  // type: "string"|"integer"|"number"|"boolean"; required, positional, pattern, maxLength, min, max, enum, default
};
// third argument: { peer, plugin (id of the offering plugin or null), config }; may be async
export function verifyFacts(args, facts, { peer, plugin }) {
  return facts.session(args.sessionId) ? { ok: true } : { ok: false, reason: "unknown-session" };  // → 409 facts:<reason>
}
// the confirmation text is written by the core (this code is part of the core), not by a plugin; lang is the effective
// hub language (ru | en), strings come from the lib/i18n.mjs table: t(lang, "prim.<name>", {…})
export function describe(args, facts, lang = "ru") {
  const s = facts.session(args.sessionId);
  return { text: t(lang, "prim.session.stop", { who: s?.name, sessionId: args.sessionId }), cost: null };   // cost — the "price" for confirm-cost
}
export async function run(args, ctx) {       // ctx + ctx.requester (peer) + ctx.plugin (id of the offering plugin or null)
  const s = ctx.facts.session(args.sessionId); // the pid comes from the core registry, not from the arguments
  const r = await ctx.exec("/bin/kill", ["-TERM", String(s.pid)]);
  return { ok: r.code === 0, code: r.code }; // only scalars reach the response and the journal
}
```

Rules the core enforces **regardless of the module**:

- `session.respond|launch|stop|interrupt`, `process.*` — only from `app` (`appOnly` is forced, `safeUnderEstop` is
  ignored for them).
- Primitives are only generic or about Claude Code. Control of external agents is not added to the core: those are
  declared actions of their plugins (below, "Plugin actions").
- A level other than `immediate` — only from `app` and only with a confirmation (see [`api.md`](api.md), 428).
- While the hub is paused (estop) only primitives with `safeUnderEstop: true` work (currently `open.url`, `open.file`);
  everything else gets 423.
- A third-party plugin can offer only `open.*`, `session.focus`, `terminal.focus` and `cmux.focus` (`Plugins/local` —
  only `open.*`), whatever its `<agenthub.effects>` says. **New plugins should use `session.focus <sessionId>`**
  (contract 3): the core terminal layer finds the session tab, so the plugin does not need to know the terminal or read
  its files. `terminal.focus <surfaceId> [workspaceId=…]` switches to a tab by its id (the `surfaceId` a session record
  carries); **`cmux.focus` is its deprecated former name** — still accepted until the next contract (the same arguments
  and refusals; `/state.primitives[]` marks it `aliasOf: "terminal.focus", deprecated: true`; the registry linter warns;
  in `<agenthub.effects>` either name allows the other).
- A primitive module may export `aliasOf: "<name>"` — a deprecated alias of another primitive (`cmux.focus` →
  `terminal.focus`); the core accepts both names as one in `<agenthub.effects>` (`PRIMITIVE_ALIASES` in `core.mjs`).
- `verifyFacts` is called before every run — both for plugin offers and for direct calls from the app.
- Optional `checkOffer(args) → {ok, reason?}` — the part of `verifyFacts` that needs no facts (synchronous): the core calls
  it when a plugin's frame offers the primitive (`effect=`, `href=`), and a refusal drops the button with a journal
  warning instead of rendering a button every press of which fails (`open.url`: a scheme other than http/https, re-review 71).
- Optional `pluginOf(rawArgs, facts) → plugin id | null` — the plugin the call acts on (`job.cancel` → the job's plugin):
  on a test hub (`AGENTHUB_TEST_TIER=own`) cli may call an app-only primitive whose `pluginOf` names a test-tier plugin
  (re-review 75). The arguments are not validated yet when it is called.

## Route (`daemon/lib/routes/<name>.mjs`)

```js
export const routes = [
  {
    method: "POST",                 // GET | POST | PUT | DELETE
    path: "/bridge/next/:id",       // parameters — :name
    peers: ["bridge"],              // who may use it: a subset of app | cli | hook | bridge
    maxBody: 64 * 1024,             // optional
    raw: false,                     // true — the handler writes to res itself (a stream); the body is not read
    handler: async ({ req, res, params, query, body, peer, ctx }) => ({ status: 200, body: { ok: true } }),
  },
];
```

- Built-in routes ([`api.md`](api.md)) cannot be overridden; a repeated `method path` is a `load-error` and the route is
  skipped.
- The peer class is checked before the handler is called; a wrong class → `403 {"error":"peer:<class>"}`.
- A process of an untrusted plugin (community, local — the plugin process, its action or a descendant of either; found by
  pid, ancestors and process group, `peer.plugin`) gets `403 peer:untrusted-plugin` on every route unless the route sets
  `untrustedPlugin: true` ([`api.md`](api.md#peer-classes), "Plugin processes"). Don't set it on anything that reads
  sessions or changes state.
- `body` is the parsed JSON (or `undefined`); not JSON → 400. Returning `undefined` → 204.
- `peer`: `{class, pid, path, startSec, reason?, claudePid?, plugin?}` — `plugin: {id, trusted, tier, source, pid}`
  when the client is a plugin process or its descendant (`pid` there is the plugin process).

## Service (`daemon/lib/services/<name>.mjs`)

```js
export const name = "push";                  // otherwise the file name
export async function start(ctx) { ... }     // ctx.on subscriptions, timers (.unref()), ctx.facts.provide, ctx.onHook
export async function stop(ctx) { ... }      // remove subscriptions and timers; ctx is the same as for start
```

- They start **before** plugins (policy and secrets apply from the first scan), in alphabetical order; a `start` error →
  `service-error` in the journal, the daemon keeps running. `stop(ctx)` gets the same ctx as `start`: one process (tests)
  may hold several cores, and you must stop only your own.
- `config.services.<name>.enabled = false` or `AGENTHUB_SERVICES` without this name — it does not start.
- Network, Keychain — only in their own services, only on the user's command and with tests on doubles.
- Current services: `app` (app supervision: restarting a crashed pinned AgentHub.app from the build path and launching
  it at daemon start, a limit of 3 per 10 min, `services.app.supervise: false` turns it off; in test mode the real app is
  not launched — only the `services.app.test.launch` double, the process table is `services.app.test.processes`;
  [`api.md`](api.md), section "App supervision"), `actions` (the cmux bridge, `bridge.online`/`bridge.channel`, the
  bridge state in `/state.bridge`), `hook`, `sessions` (contract 3: session registry → `Cache/claude-sessions.json`, the
  `AGENTHUB_CLAUDE_SESSIONS_FILE` variable for trusted plugins; metadata only, at most once every 2 s;
  `services.sessions.enabled: false` turns it off), `oauth` (OAuth 2.1 connections to external services and calls to
  their MCP on behalf of trusted plugins — which ones is declared by the plugins themselves with the
  `<agenthub.connection>` tag, below; [`api.md`](api.md) "Connections"; network — only the hosts of a declared connection
  and a temporary code receiver on 127.0.0.1; tokens — only in the keychain via `secrets.store`; in test mode — the
  `services.oauth.<id>.resource` doubles on 127.0.0.1 and `services.secrets.securityPath`), `plugins` (the registry),
  `push` (delivery through a channel list: macOS always, `services.push.channels` from `config.json`, channels other
  services register — below, "Push channel"), `secrets`, `terminal` (contract 3: "read the tab screen" and "type a line into the tab" of a Claude Code session
  for trusted plugins with the `<agenthub.terminal>` permission, the `/terminal/*` routes, the `terminal.api` fact; the
  terminal layer `lib/terminals/` — one built-in adapter per terminal, below "Terminal adapter"; `services.terminal` —
  rate limits and `launch`, the terminal new sessions open in), `usage` (the Claude subscription quota → `Cache/usage.json`, the `AGENTHUB_USAGE_FILE` variable for trusted
  plugins; network — only `api.anthropic.com`; the Claude Code token never leaves the service: not to disk, the journal,
  the bus or plugins; an expired one is not refreshed. In test mode — doubles only: `services.usage.securityPath`,
  `services.usage.credentialsFile`, `services.usage.url` on 127.0.0.1/localhost; `services.usage.live: true` — the real
  keychain and host even in a test directory, for a live check).

### Push channel

The push service decides *whether and when* to notify (rules, quiet hours, kinds, limits —
[`daemon/lib/push/README.md`](../daemon/lib/push/README.md)); *where* is a channel list (`daemon/lib/push/channels.mjs`). The
macOS banner (`mac`: the shell, osascript without an acknowledgement) is always on and always first. More channels:

- **from `config.json`** — `services.push.channels`, built-in types:

  ```json
  { "services": { "push": { "channels": [
      { "type": "webhook", "url": "https://hooks.example.com/agent-hub/<secret>", "events": ["sessions", "problems"] },
      { "type": "ntfy", "url": "https://ntfy.sh/<topic>", "security": true, "id": "phone" } ] } } }
  ```

  `webhook` — `POST` of the JSON payload below; `ntfy` — a JSON publish to the server root with the topic from the URL's
  path (`title`, `message`, `click` = `href`, priority 5 for security). `url` — `https://` anywhere, plain `http://` only to
  this Mac (`localhost`, `127.0.0.0/8`, `[::1]`), no `user:password@`; redirects are refused (an https URL can't be bent to
  http); a 10 s timeout. `events` (optional) — the kinds (`sessions`, `updates`, `problems`, `other`, `plugin`, `security`;
  `hub` — any hub event, `digest` — the morning digest) or keys `<plugin>:<key>` with a trailing `*` (`mail:*`); no list —
  everything. `security: true` — the channel also gets security banners (a re-pinned app build, tampering signals: the kind
  `security` and the `bannerAlways` rules); without it they never leave this Mac. `id` (`[a-z][a-z0-9-]{0,31}`, default
  `<type>-<n>`), `label`, `enabled: false`. A bad entry is skipped with `push-channel-invalid {index, reason}` in the
  journal. The URL often carries a secret (a webhook path, an ntfy topic): it never reaches the journal, `/state` or events —
  failures are `push-channel-error {channel, key, code}`.
- **from a service** (built-in or an approved extension):

  ```js
  export async function start(ctx) {
    off = ctx.facts.get("push.channels")?.register({
      id: "pager",                // [a-z][a-z0-9-]{0,31}, not "mac", unique
      label: "Pager",             // optional
      security: false,            // optional: true — also security banners
      events: ["sessions"],       // optional: as in config.json
      send: async (payload) => ({ ok: true }),   // → {ok, code?}; called in the background with a timeout
    });
  }
  export async function stop() { off?.(); }
  ```

  The fact exists while the push service runs (a service that starts before `push` alphabetically registers on the
  `services.started` bus event; extension services start after all built-in ones).

Payload (metadata and the banner text only): `{source: "agent-hub", title, subtitle, body, plugin, key, kind, digest, href,
ts}`. Banner buttons (`actions`) stay with the shell: they are offer ids of this hub. Channels get exactly what the banner
would show at that moment — the engine's quiet hours, digest and kind switches apply before any channel.

## Terminal adapter (`daemon/lib/terminals/<id>.mjs`)

Everything the hub does with the terminal tab of a Claude Code session goes through the terminal layer
(`daemon/lib/terminals/index.mjs`): switch to the tab (`session.focus`, `terminal.focus`), read the end of the screen and
type a line (`/terminal/*`), press Esc (`session.interrupt`), open a new tab with a session (`session.launch`). A terminal
is an **adapter file** — a separate kind of extension, not a plugin: it ships with the hub (`daemon/lib/terminals/`, found by a
directory scan) or lives on one Mac as an approved extension (`<home>/Extensions/terminals/`, below), has no permissions of its
own and is never installed from a registry. The core and the shell never name a terminal; the
shell draws from what `/state` says.

| Adapter | Where the session is | focus | read-screen | send-text | send-esc | launch | How |
|---|---|---|---|---|---|---|---|
| `cmux` | `~/.cmuxterm/claude-hook-sessions.json` (cmux hooks), same pid and start time | yes | yes | yes | yes | yes | the cmux bridge (`bridge/`) — the adapter's internal detail; without it every operation answers `bridge-offline` |
| `tmux` | a tmux server is the nearest terminal among the process's ancestors; the pane by `pane_tty` | yes | yes | yes | yes | yes | a known tmux binary (`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `/usr/bin`) that is the server's executable, as is or after resolving links — a server running any other binary is not reached (`-L`/`-S` from its argv): `select-window`/`select-pane`/`switch-client` (+ the window of the client's terminal), `capture-pane`, `send-keys -l` with the same field checks as the bridge, `send-keys Escape`, `new-window -d` |
| `iterm2` | iTerm2 (or its `iTermServer`) is the nearest ancestor; the tab by `tty of session` | yes | — | — | — | yes | `/usr/bin/osascript`, values only in `argv` |
| `terminal-app` | Terminal.app is the nearest ancestor; the tab by `tty of tab` | yes | — | — | — | yes | `/usr/bin/osascript` (`do script` for a new window) |

Non-Claude agent sessions (`/state.externalSessions`, `agentSession=<id> pid=<pid>`) are located the same way, by pid: tmux,
iTerm2 and Terminal.app find their tab from the process ancestors and tty, so `session.focus` works there. **cmux cannot focus
them**: the cmux adapter knows a tab only from `~/.cmuxterm/claude-hook-sessions.json`, which cmux's Claude Code hooks write,
and the bridge has no "surface by pid/tty" operation — such a session in cmux has no tab (`terminal: null`, not focusable).
Adding it needs a new allowlisted bridge operation (`bridge/`), not a core change.

iTerm2 and Terminal.app declare no screen, typing or Esc: their AppleScript cannot check the Claude Code input field
before and after typing (Terminal.app can type only through `do script`, always with Enter, or keystrokes into whatever
window is in front), so the hub does not offer it. The first AppleScript call asks macOS for the Automation permission.
Other hosts (Ghostty, kitty, WezTerm, Alacritty, Warp, VS Code) stop the ancestor walk and have no adapter yet: such a
session has no tab (`terminal: null`).

Detection (`_proc.mjs`) reads only the process table — parent, executable path (`proc_pidpath`), start time — through the
core facts `processInfo`, `processPath`, `processArgv`; no command runs, and the process environment (`TERM_PROGRAM`,
`TMUX`) is not read. The controlling terminal (`processTty`, `ps -o tty=`) is asked only when an operation runs. Tools run
through the `terminalExec` fact (`Core` option `terminalExec`): a test hub without a double gets `refuseExec`
(`terminal-test-mode`), `AGENTHUB_TEST_EXEC_LOG` only writes the call to the file — a test copy never touches a real
terminal.

```js
export const id = "tmux";                    // the adapter id: /state.sessions[].terminal, the journal, the response to a plugin
export const label = "tmux";                 // what the shell shows
export const capabilities = ["focus", "read-screen", "send-text", "send-esc", "launch"]; // only these are offered
export const via = null;                     // "bridge" — operations run through the cmux bridge (the shell shows its state)
export function locate(session, facts) {}    // → {target: {terminal, tab, …}} | {error} | null; cheap: called on every /state
export function idle(target) {}              // the session is free according to the terminal (a hint)
export function running(target) {}           // optional: a turn is running (session.interrupt); none — the registry status
export function available(facts) {}          // optional: {ok} | {error} — can run right now (cmux: bridge-offline)
export function installed({ exists }) {}     // optional: on this Mac (Settings → Terminal, picking where to launch)
export function findTab({ surfaceId, workspaceId }, facts) {} // optional: a tab by its id (terminal.focus)
export async function focus(target, facts) {}                       // focus
export async function readScreen(target, facts, { lines }) {}       // read-screen → {ok, promptFound, promptEmpty, busy}
export async function sendText(target, text, facts) {}              // send-text: only into an empty field, no turn running
export async function sendKey(target, "escape", facts) {}           // send-esc
export async function launch({ cwd, name, sessionId, promptFile }, facts) {} // launch: runs bridge/launch.sh in a new tab
export function registered(sessionId, facts, { workspaceId }) {}   // optional: the launched session appeared (default: the registry)
export const order = 20;                     // optional, built-in adapters only: the place in the list (lower first, default 100; cmux 10, tmux 20, iterm2 30, terminal-app 40)
export const autoLaunch = false;             // optional: "auto" never picks it for session.launch by "installed" (tmux)
export const messages = {                    // optional: human texts for the adapter's own error codes, ru and en
  ru: { "no-remote": "Включите удалённое управление в настройках терминала" },
  en: { "no-remote": "Turn on remote control in the terminal settings" },
};
// available(facts) may answer { error: "no-remote", setup: true }: "needs setup" — the shell shows messages[error] as a hint
```

`order` sorts only the built-in adapters. An approved extension adapter (`<home>/Extensions/terminals/`, below) always
comes after all of them, extension adapters among themselves by file name; its `order` is accepted and ignored. Order
matters only for a session two adapters could claim, so an extension adapter cannot take a session a built-in one
knows.

`messages` — codes `[a-z0-9][a-z0-9-]{0,47}`, one line ≤ 200 characters each, at most 40; the hub language first, the other
as a fallback. The shell shows them for `available()` reasons and for refusals of the adapter's operations (`409 facts:<code>`,
`terminal:<code>`); built-in codes keep the shell's own texts.

A capability counts only when it is declared **and** its function exists. What is missing is refused before anything
runs: `/terminal/*` — `409 terminal:unsupported {terminal, capability}`; primitives — `409 facts:focus-unsupported`,
`facts:esc-unsupported`, `facts:launch-unsupported`; the shell disables the button with a tooltip naming the terminal.
A new terminal is a file: `daemon/lib/terminals/<id>.mjs` (found by a directory scan, `_*.mjs` are helpers) or an approved
`<home>/Extensions/terminals/<id>.mjs` (after the built-in ones; an id a built-in adapter has is refused). The plugin contract
(routes, the `<agenthub.terminal>` permission, error codes) does not change.

`/state` exposes the layer: `sessions[].terminal` (the adapter id, contract 3, a string), `focusable`, and
`terminalInfo {adapter, label, capabilities, focusable, via}` (or `null`); `terminals {adapters: [{id, label,
capabilities, via, installed, available, reason, reasonText, needsSetup, messages, source, sessions}], launch: {adapter,
why} | null, prefer}` — Settings → Terminal ([`api.md`](api.md)). `session.launch` opens the tab in `services.terminal.launch` (an adapter id) or, with `"auto"` (the default),
in the terminal most live sessions run in, otherwise in the first installed of cmux, iTerm2, Terminal (tmux only by the
setting or by its sessions: a new window would land in a detached server).

## External extensions (`<home>/Extensions`)

The extension points above live in the hub's source tree, which an installed hub rebuilds from a release tag on every update.
For your own daemon code on one Mac — a push channel to your pager, a route for your tool, a primitive, an adapter for your
terminal — put the module in the state directory instead:

```
<AGENTHUB_HOME>/Extensions/
  services/<name>.mjs      — a service (the contract above: name, start(ctx), stop(ctx))
  routes/<name>.mjs        — routes (export const routes = [...], above)
  primitives/<name>.mjs    — a primitive (name, level, argsSchema, verifyFacts, describe, run — above)
  terminals/<id>.mjs       — a terminal adapter (above)
```

The module contracts are exactly those of the built-in modules, `ctx` included. What differs:

- **A human approves every file.** An extension is code inside the daemon with the daemon's full rights (sessions, plugin
  secrets, the user's files, programs, network) — not a plugin: no permissions, no registry review. The daemon lists what it
  finds in `/state.extensions` (status `pending`), the app shows the consent text (`consent`, the hub language: it says
  exactly this) with the path and sha256 and, on "Approve", calls the app-only `POST /extensions/approve {path, sha256}`
  ([`api.md`](api.md), "Extensions"). The approval is the sha256 of these bytes in `Registry/ext-approvals.json`: a changed
  file is `changed` and does not load until approved again; the daemon keeps approvals in memory too, so an entry another
  process writes into the file while the daemon runs grants nothing. Approved at runtime — it loads right away; otherwise at
  the next daemon start. Revoked (`POST /extensions/revoke`) — a loaded module shows `revoked` (it runs until the daemon
  restarts, not counted as waiting) and stops loading at the next start.
- **What runs is what was hashed**: the daemon reads the file once, checks its sha256 and imports those bytes (a `data:`
  URL). So an extension is **one self-contained file**: `import` of `node:*` built-ins works, relative imports don't
  (`import-failed`); hub helpers come through `ctx` (`ctx.t`, `ctx.exec`, `ctx.facts`, …) for services, routes and
  primitives. **A terminal adapter has no `ctx`**: its functions get only `facts` (the process facts `processInfo`,
  `processPath`, `processArgv`, `processTty`, the `terminalExec` runner, the session registry). The helpers the built-in
  adapters share — `daemon/lib/terminals/_exec.mjs` (`LAUNCH_SH`, `shQuote`), `_proc.mjs` (`hostOf`, `ttyOf`),
  `_screen.mjs` (`analyzeScreen`, `typeLine`) — are not part of it: copy what you need into your file. Importing hub
  files by an absolute `file:` URL works but is not a contract — they change between versions.
- **The file must be yours**: owned by your user, not writable by group or others (`unsafe-file`), ≤ 1 MB, a name
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}.mjs`; `_*.mjs` and `.*` are skipped like in the source tree.
- **Built-ins win**: a service name, primitive name, route method and path (`:params` compared by position) or terminal id a
  built-in module (or an earlier extension) already has is refused (`name-taken`); a route file with one such route is
  refused whole.
- **Order**: extension primitives and terminal adapters right after the built-in primitives, extension services after the
  built-in services (before plugins; the same `services.<name>.enabled` and `AGENTHUB_SERVICES` switches), extension routes
  after the built-in routes. Within a kind — by file name.
- **Journal**: `extension-load`, `extension-denied` (pending or changed), `extension-error`, `extension-approved`,
  `extension-revoked`; `/state.extensions` and the `extensions.changed` event show the same for the app (a file added while the
  daemon runs is noticed by `fs.watch` and a rescan every `extensions.rescanMs`, 30 s).
- **Updates**: `Extensions/` is in the state directory, which hub updates (`docs/hub-updates.md`) and `agenthub builtin
  update` never touch: extensions keep running across hub versions. A hub update can change `ctx` or a fact an extension
  relies on — the module contracts in this document are the compatibility promise; anything else (hub files, internal
  facts) is not.
- **Off switch**: `extensions.enabled: false` in `config.json` — the folder is not even scanned. Tests:
  `AGENTHUB_TEST_EXTENSIONS=1` together with `AGENTHUB_HOME` (not the live directory) approves every file automatically.

## Plugin contract (what the core understands)

The format follows SwiftBar; design section 2 has the details. Here is what is actually implemented. A step-by-step
guide for plugin authors built on this contract (a first plugin, debugging, examples, publishing) is
[`writing-plugins.md`](writing-plugins.md).

**File name:** `{id}.{interval}.{ext}` (interval `\d+(ms|s|m|h|d)`, at least 1 s), `{id}.{ext}` (no interval — runs at
start, on `refresh`/`watch`, or per `<agenthub.schedule>`), or a folder `{id}/` with such a file.
`.md .txt .json .lock .log` and names starting with `_`/`.` are ignored. Running: `.mjs/.js/.cjs` — with the current
node, `.py` — `/usr/bin/python3`, `.sh/.bash/.zsh` — with the corresponding shell, anything else — by the x bit.

**Metadata** — `<agenthub.X>…</agenthub.X>` tags in the first 64 KB of the file (for a binary — the
`com.kensei.agenthub.meta` xattr, text or base64): `title`, `version`, `desc`, `author.*`, `type`
(`standard|streamable`), `schedule` (cron, 5 fields), `platforms` (`macos,windows`), the repeatable `watch`, `fsRead`,
`fsWrite`, `exec`, `secrets`, `net`, `terminal` (contract 3) (an entry "what — why"), `effects` (comma-separated, `open.*`
allowed), `<agenthub.action id="…" level="immediate|confirm|confirm-cost" title="…" cost="…" arg="name:^pattern$">command</agenthub.action>`
(without `level` — `confirm`), `<agenthub.push key="…" …>Label</agenthub.push>` (push rules,
[`daemon/lib/push/README.md`](../daemon/lib/push/README.md)),
`<agenthub.requires name="Tool" url="https://…" check="~/.tool">why</agenthub.requires>` (2026-11-09, up to 8) — a
dependency: an external program without which the plugin is useless. This is not a permission: the core only checks
whether the `check` path exists (`~/…` — relative to the plugins' HOME), and the manager catalog shows "Requires Tool" as
a link to `url` (`https://` only); if the path is missing, "Install" is dimmed with a tooltip, but installing is still
possible. A translation is the same tag with `lang="en"` and the same `name` (the text is the explanation, `title=` the
name). A `check` with masks or "..", or forbidden places, is a linter error. The plugin declares the program name: the
core and the shell know nothing about specific programs.
`<agenthub.status value="ok|wait|block|error|unknown" label="Short label">explanation</agenthub.status>` — your own
status label: the shell shows it on the tile and in the card, with the explanation as a tooltip; without the tag — the
shared table ("All good", "Needs attention", "Blocking work", "Failure", "No data"). Make it unambiguous for your plugin:
for quota `wait` is "Quota running low", for sessions — "A session is waiting for you".

**Contract 2 (2026-11-09): what a plugin declares about itself.** The hub (daemon, shell, CLI) knows no specific plugin:
no names, no icons, no notification kinds, no error texts. Everything plugin-specific comes from these tags and output.

- `<agenthub.contract>2</agenthub.contract>` — the minimum contract version the plugin requires from the hub (an integer
  ≥ 1; no tag — 1). A hub with an older contract refuses installation and update with a clear "requires a newer hub"
  (`registry:hub-too-old` / `own:hub-too-old` with `need` and `have`; the catalog marks the entry `needsHub`), not a
  linter error. Declare 2 if you use anything from this list. The core exposes its version in `/state.contract`,
  `/health.contract` and `agenthub version`.
- `<agenthub.icon symbol="star" color="#FF9F0A"></agenthub.icon>` — the tile icon: `symbol` is an SF Symbol name
  (`^[a-z0-9]+(\.[a-z0-9]+){0,7}$`, up to 64 characters), `color` is `#RRGGBB` (optional; the shell darkens the bottom of
  the gradient itself). An invalid tag is a parse warning (for an own plugin it is a folder check error) and there is no
  icon; without the tag — a neutral icon (`puzzlepiece.extension`, grey). The icon goes into `/state.plugins[].icon`, the
  index entry (`icon`), an own plugin's request and the consent window.
- `<agenthub.connection id="tix.tasks" type="mcp" url="https://mcp.example.com/mcp" scope="read" title="Tix"
  tools="get_user,filter_tasks" interval="15m" budget="100" hosts="auth.example.com">why</agenthub.connection>` — a
  connection to an external service whose sign-in the hub handles (the `oauth` service, [`api.md`](api.md)
  "Connections"): `id` is the plugin id (by default) or `<plugin id>.<name>` (the name is `a-z`, `0-9`, `-`, starting
  with a letter, up to 32; the whole id starts with a letter and is up to 64 characters, otherwise refused: it is also
  the keychain entry name). A plugin id never contains a dot, so a connection always belongs to exactly one plugin:
  `foo` cannot declare a connection of plugin `foo-bar` (before 2026-11-10 it was `<id>-…`, which allowed that); `type`
  is `mcp` (below) or `http` (contract 3 additive: a pre-registered public `client_id`, `authorize`/`token`
  endpoints, API `hosts` the token goes to, `methods`, `paths`, optional `port`; the hub proxies requests via
  `POST /connections/<id>/http` — [`writing-plugins.md`](writing-plugins.md) 8.3, [`api.md`](api.md) "Connections"); `url` is https on a host name (not an IP address) without a port or credentials; `hosts` are additional
  authorization server hosts; **the `url` host and all `hosts` must be in the plugin's `<agenthub.net>`** (linter —
  error, core — `connection-rejected`); `scope` is what to request at sign-in (space-separated words); `tools` is an
  allowlist of MCP tools (1–32), the plugin cannot call others; `interval` — at most one identical call per interval
  (the core keeps it within 5 min … 24 h, 15 min by default); `budget` — calls per sliding day (1…10000, 100 by
  default); `title` is the service name in the shell (by default the plugin name). The tag text is the "why" for the
  consent window and "Settings". A translation is the same tag with `lang="en"` and the same `id` (`title=` and text). Up
  to 4 connections. Only for `builtin`, `official`, `own` (for a third-party plugin the registry linter treats the tag as
  an error — the permission in the consent window would promise something the core will not do); in permissions it is
  the `connections` kind (address, scope, allowlist; anything new is a permission increase). The call is
  `POST /connections/<id>/mcp` via `AGENTHUB_HUB_SOCKET`, only by this plugin's process. Keychain entries are
  `agent-hub.oauth` / `<id>.client|token`; a sign-in remembers the address (`url`) it was issued for: if the address
  changes, a new sign-in is needed. A sign-in made before contract 2 (without an address) is bound to the address on
  first read if a built-in or official plugin declared the connection; an own plugin does not inherit it. The shell does
  not infer "read-only" from `scope`: what can be called is `tools`, and that is what it shows. If the plugin is removed
  but the sign-in remains, the connection is "orphaned" (`orphan: true`, only "Disconnect"); removal "with data" also
  removes the sign-in.
- `<agenthub.push … kind="plugin" was="runs|night">` — the plugin's own notification toggle (below, "`event=` keys").
- `message=<text>` in action output — an explanation of a refusal (below, "Plugin actions").

**Contract 3 (2026-11-10): sessions, pause, terminal, loud permissions.** Declare
`<agenthub.contract>3</agenthub.contract>` if the plugin does not work without these (an older hub will say "requires a
newer hub"); a plugin that can live without them may declare 2 and check the variables itself.

- **Metadata of live Claude Code sessions** — `AGENTHUB_CLAUDE_SESSIONS_FILE` (only `builtin`, `official`, `own`; the
  core `sessions` service). The path to `<home>/Cache/claude-sessions.json` (0600, atomic writes, on the bus `sessions`
  event, at most once every 2 s and only on change):

  ```json
  { "version": 1, "updatedAt": "2026-11-10T12:00:00.000Z",
    "sessions": [{ "sessionId": "<uuid>", "pid": 12345, "verified": true, "status": "idle | busy | waiting | null",
                   "model": "claude-opus-5-5", "modelId": "claude-opus-5-5 | null", "modelSource": "turn | command | null",
                   "effort": "low | medium | high | xhigh | max | null", "effortSource": "turn | command | null",
                   "ultracode": false, "surfaceId": "<cmux tab | null>", "workspaceId": "<cmux workspace | null>",
                   "name": "<session or tab name | null>", "at": "<time of the transcript record model/effort came from | null>" }] }
  ```

  Metadata only: no conversation text, no folder, no "what the session is waiting for", no session auto-title (`name` is
  `null` if the name is a title Claude Code composed from the conversation: `nameSource: auto` in
  `~/.claude/sessions/<pid>.json`, the `sessionNameSource=` line parameter). The source is the core session registry
  (only trusted plugins write to it, with `session=… pid=…` lines whose signature the core verified); the model and effort
  are brought in by the built-in sessions plugin with the `sessionModel=`, `sessionEffort=`, `sessionModelSource=`,
  `sessionEffortSource=`, `sessionAt=` parameters — it reads the transcript tail itself (`~/.claude/projects` is a
  forbidden place for registry plugins). `model` is `message.model` (or `requestedModel`) of the last `assistant`
  record, or, if the transcript has `/model` output after it ("Set model to `<x>`…" or "Kept model as `<x>`"; a `user`
  record with a string or `system`/`local_command`), `<x>`. **With `modelSource: "command"` this is a display name, not an
  id**: `Opus 5.5 (default)`, `Fable 5.2`, `Sonnet 4.5 [1m]`; with `"turn"` — an id (`claude-opus-5-5`). Compare by family
  and version (ignoring `(default)` and case) or wait for the next turn — then it is an id again. **`modelId` is always an
  id**: with `"turn"` — `model` itself, with `"command"` — the normalized name: menu marks in brackets are dropped,
  "<Family> <version>" (Opus, Sonnet, Haiku, Fable) → `claude-<family>-<version with dashes>` (`Opus 5.5 (default)` →
  `claude-opus-5-5`, `Fable 5.2` → `claude-fable-5-2`, `Sonnet 4.5 (1M context)` → `claude-sonnet-4-5`); an id inside
  the name (`claude-opus-5-5`) is kept as is; unrecognized (`Default (recommended)`, an unknown family) — `null`. The
  context mark (`[1m]`) stays only in `model` taken from a turn. `effort` is `perTurnEffort ?? effort` of the last turn,
  or, if there is `/effort` output after it ("Set effort level to <level> …"), that level. **The command wins over the
  turn** (`…Source: "command"`): for an idle session the turn may predate the command. `at` is the time of the record
  the model and effort came from (the newer of the two): the plugin compares it with the time of its own last typing into
  that tab and shows whichever is newer (a command record newer than your typing is the result of that typing, no need to
  repeat it). `verified` — the `requirements.claudeCode` signature was verified by the core when the file was written
  (the process is alive, the pid is not taken by another one); with `false`, never type into the session. The permission
  is `<agenthub.fsRead>$AGENTHUB_CLAUDE_SESSIONS_FILE — why</agenthub.fsRead>`; to run right after a write —
  `<agenthub.watch>$AGENTHUB_CLAUDE_SESSIONS_FILE — why</agenthub.watch>`. No variable — the hub is older or the service
  is off (`services.sessions.enabled: false`).
- **Switching to the session tab** — the `session.focus <sessionId>` effect (a UUID, positional, as for
  `session.interrupt`; or the id of another agent's session, `agentSession=` below): `<agenthub.effects>open.url,session.focus</agenthub.effects>`, the line
  `Go to | effect="session.focus <uuid>"`. Level "immediate" (no confirmation), available to third-party plugins too (a
  harmless ceiling, like `open.*`), not from remote channels. The terminal layer (`lib/terminals/`, `locate`) finds the
  tab via the core session registry, and the terminal adapter switches to it (the `focus` operation; for cmux — the bridge
  operation `surface.focus`). Refusals are 409 `facts:<code>`: `unknown-session` (the session is not in the registry),
  `no-terminal` (no adapter knows its tab), `pid-mismatch` (the tab belongs to another process), `focus-unsupported` (the
  adapter cannot switch), the code of an unavailable adapter (`bridge-offline` — cmux only); a failure of the switch itself —
  `200 {ok: false, result: {error}}`. The action description is "Go to tab "<session name>"" (otherwise by the start of
  `sessionId`). The plugin learns the `sessionId` from `$AGENTHUB_CLAUDE_SESSIONS_FILE` or `~/.claude/sessions/*.json`.
  In `/state.sessions[]` the core exposes `terminal` (the adapter that found the tab, or `null`), `focusable` (the tab
  was found and the adapter can switch to it) and `terminalInfo` (the adapter, its label and capabilities) — the shell
  draws the "Go to tab" button from them. Terminals: cmux, tmux, iTerm2, Terminal.app (above, "Terminal adapter").
- **The hub pause flag** — `AGENTHUB_PAUSED=1|0` in the environment of **every** run (and action), for any plugin tier:
  `1` while `ESTOP` exists ("Pause hub"), otherwise `0`. It is always passed: an explicit `0` tells the plugin that the
  hub is new enough and background work is fine (an older hub does not pass the variable — then better not do background
  work). Setting and lifting the pause (via the `/estop` route, `agenthub pause` or the file) restarts plugins, like a
  language change: streamable ones from scratch, interval ones out of turn, with `AGENTHUB_REFRESH_REASON=Paused|Resumed`.
  The core already refuses actions while paused (423); the variable is for the plugin's own deferred work.
- **Event subscriptions** (within contract 3) — `<agenthub.subscribe>plugin-id:key-prefix — why</agenthub.subscribe>`
  (up to 16; `*` instead of the id — every other plugin; an empty prefix — all keys). Only trusted (`builtin`, `official`,
  `own`, test tier) **streamable** plugins; for others the core ignores the tag with a journal warning and the linter warns.
  A permission of kind `subscribe` (needs a "why"; adding one is permission growth → consent again; `*` is a reviewer
  warning). The core (`setEvents`) sends each raised/cleared matching event as `{"type":"event","plugin","key","state",
  "title"?}` (`key` — the source's own key without `<id>:`, `title` — the sanitized row text, only on `raised`) and, every
  time the subscriber's process starts, `{"type":"eventSnapshot","events":[{plugin,key,state:"raised",title?}]}` with
  what matches now (≤ 500). At most 600 messages a minute per subscriber (the rest dropped, `subscribe-dropped` in the
  journal). Hub events (`@hub:*`) are not delivered. Actions pressed over the socket by a plugin process (the server's
  `peer.plugin`) are journaled with `byPlugin` (`action`, `action-denied`, `action-confirm-requested`).
- **Terminal: read the tab screen and type a line into the tab** of a Claude Code session — the `<agenthub.terminal>`
  permission (only `builtin`, `official`, `own`; for a community plugin it is a linter error, and the core refuses with
  `terminal:untrusted`). Entries:
  - `<agenthub.terminal>read-screen — why</agenthub.terminal>` — find out whether the input field is empty and the
    session is free (the plugin never receives the screen text);
  - `<agenthub.terminal>send /model /effort — why</agenthub.terminal>` — type a **slash command** and Enter: the first
    word of the line is one of those listed (`/`, then a-z, 0-9, `-`, up to 32 characters; up to 16 commands), followed by
    at most 3 arguments from `[A-Za-z0-9._:[]-]` up to 64 characters (`/model claude-opus-5-5[1m]`, `/effort xhigh`). A
    word without `/` is never a permission: it would allow any prompt to the agent that starts with that word;
  - `<agenthub.terminal>send * — why</agenthub.terminal>` — any prompt and any slash command, **except lines starting
    with `!`, `#`, `&`** (Claude Code modes: `!` runs a shell command immediately, without Claude Code permissions and
    bypassing the plugin's `<agenthub.exec>`; `#` writes to memory; `&` starts a background task): those need a separate
    permission;
  - `<agenthub.terminal>send ! — why</agenthub.terminal>` — lines starting with the declared mode character (`!`, `#`,
    `&`; several allowed: `send ! #`; combined with slash commands: `send /model !`). A separate permission
    (2026-11-10): `send *` does not grant it. In the consent window it is the loudest line (`risk: "terminal-mode"`:
    "runs a shell command immediately, without Claude Code permissions"), and the linter warns the reviewer. Only for a
    plugin that cannot do without it.

  Typing is loud: the consent window shows a red line "Typing into Claude Code sessions…" (`risk: "terminal"`; for
  `send *` it says plainly "any prompts and slash commands"), the registry linter warns the reviewer; extending the list
  of commands is a permission increase (the consent window again). Call it over HTTP on the hub socket
  `$AGENTHUB_HUB_SOCKET` **from the plugin's own process**: a running interval run, a streamable process or **a running
  action** (`<agenthub.action>`, started by a human). The core recognizes the plugin by the peer pid on the socket: a
  descendant such as `curl` gets `403 terminal:not-a-plugin`. An action has a budget of `actionTimeoutMs` (30 s), an
  interval run `standardTimeoutMs` (5 s): typing with checks takes ~0.5–1 s, but waiting for the answer can take up to
  20 s (bridge, cmux).

  | Route | Body | 200 response |
  |---|---|---|
  | `POST /terminal/read-screen` | `{sessionId, lines?}` (`lines` 1…30 — how many last screen lines to look at) | `{ok, sessionId, terminal, idle, foreground, promptFound, promptEmpty, busy, ready}` |
  | `POST /terminal/send-text` | `{sessionId, text}` | `{ok, sessionId, terminal}` |

  `idle` — the session is free: by the registry (Claude Code's own status is `idle`; `busy`/`waiting` are not), and
  without a status — by the terminal (cmux: `agentLifecycle: idle`); after Esc mid-turn cmux stays at `running` while
  the registry does not, and the registry decides. `foreground` — the Claude Code process is not stopped (Ctrl+Z) and is
  in the foreground group of its terminal (otherwise the shell would get the line). `promptFound`, `promptEmpty`,
  `busy` — the input field on the visible screen (`busy` — "esc to interrupt" outside the field); `promptEmpty: null` —
  there is no field. `ready` = `idle && foreground && promptFound && promptEmpty && !busy` — you can type right now
  (`send-text` will check again anyway). The line is printable ASCII without `\`, without leading or trailing spaces,
  1…200 characters: no control characters, no newline (the hub presses Enter as a single key after checking the field).
  The order of `send-text` checks: the plugin process and permission; request rate; pause (423); the line and its
  permission; the session is in the registry, the Claude Code signature verified now, the same pid and start time; the
  terminal knows the tab and it is recorded for the same pid and start time; the session is free; the process is in the
  foreground; typing rate; then the bridge: field found, empty, no turn running → typing → the field holds exactly this
  line → Enter (not after the deadline: the daemon waits for the answer ~20 s, and after the deadline Enter is not
  pressed — `504 terminal:deadline`). Rates are in `services.terminal` (`requestsPerMin` 60 per plugin, `sendPerMin` 12
  per plugin, `sendPerTabPerMin` 4 per tab; every attempt that reaches the terminal counts).

  The terminal: cmux (through its bridge) and tmux (through its CLI) support both routes; a session in iTerm2 or
  Terminal.app gets `409 terminal:unsupported {terminal, capability}` — do not retry, it will not change.

  Errors: `400 terminal:bad-text`, `args:*`; `403 terminal:not-a-plugin | untrusted | not-declared |
  text-not-declared`; `409 terminal:unknown-session | unverified | no-tab | pid-mismatch | unsupported | session-busy |
  not-foreground | process-unknown | prompt-not-found | prompt-not-empty | prompt-mismatch | bridge-offline |
  terminal-test-mode`; `423 estop`; `429 terminal:rate-limited` (`scope: requests|plugin|tab`, `retryAfterMs`); `501
  terminal:bridge-outdated`; `502 terminal:cmux-failed | tmux-failed`, `504 terminal:bridge-timeout |
  bridge-pickup-timeout | cmux-timeout | tmux-timeout | deadline` — a bridge or terminal failure; `503 terminal:disabled`
  — the service is off. What the plugin should do:
  - `prompt-not-empty` — the field holds a human draft **or** faint text: the placeholder of a fresh session
    (`Try "…"`) and Claude Code's next-prompt suggestion are indistinguishable from typed text on a text screen (cmux
    returns the screen without colors). The hub does not type into such a field; show "clear the input field" or wait.
  - `prompt-mismatch` — the line was typed, but before Enter the field did not hold exactly it (a human was typing at
    the same time). **Enter was not pressed, but the typed text stays in the field**, and the human's next Enter will send
    the mix. Do not retry automatically: show the human that a line was left in the field.
  - `prompt-not-found` — the input field was not found (a permission dialog, another screen); `session-busy`,
    `not-foreground` — wait for the next frame; `unverified`, `pid-mismatch` — do not type into this session.
  - `bridge-timeout`, `cmux-timeout`, `deadline` — the outcome is not fully known: the bridge does not press Enter after
    the deadline, and the core writes a late bridge answer to the journal (`bridge-op-late`). Check
    `claude-sessions.json` (`at` and `…Source: command`) before retrying.

  Input field recognition has been tested on synthetic Claude Code 2.1.3xx screens (a `─` rule above and below, `>` or
  `❯`, the older `│` frame); not yet on a live tab. The hub journal records every send (`terminal-send`: plugin,
  session, tab, terminal, length, `head` — the declared slash command at the start of the line, `sha` — the first 12
  characters of sha256, only together with `head`; for lines under the `*` permission both are `null`; **the whole line
  is never recorded**; duplicated in the audit log) and every refusal (`terminal-denied`). The terminal behind this is the
  core adapter layer (`daemon/lib/terminals/`, "Terminal adapter" above): cmux (through the bridge in a pinned tab,
  [`bridge/README.md`](../bridge/README.md)) and tmux type; iTerm2 and Terminal.app only switch to the tab and open new
  ones. More terminals are added as adapters without changing the plugin contract. Pause: with `AGENTHUB_PAUSED=1`, do not call at all.
- **Writing to hijack locations is loud.** `<agenthub.fsWrite>` to places through which Claude Code or the system can be
  hijacked is allowed, but the consent window shows such a permission first, as a red line "Hijack location…" with an
  explanation of what it gives, and the registry linter warns the reviewer. The places (`WRITE_RISKS` in
  `lib/registry/perms.mjs`): `claude-code` — **all of `~/.claude`** (except `~/.claude/task-runs` and
  `~/.claude/backups`), `~/.claude.json`, the `.claude` directory and `.mcp.json` of any project, managed settings;
  `autostart` — LaunchAgents/LaunchDaemons, cron, `~/.config/autostart`, systemd user, Hammerspoon, the Windows startup
  folder; `shell` — `~/.zshrc` and the other shell startup files, `/etc/paths`, sudoers, the PowerShell profile; `bin` —
  program directories on PATH and global npm packages; `terminals` — `~/.cmuxterm` (the session-to-tab binding that hub
  typing trusts), configs of cmux, ghostty, kitty, WezTerm, tmux; `ssh`; `git`; `hub` — the hub directory except its own
  `PluginData/<id>` and `Cache/<id>` (all of `PluginData`, another id and the service files directly in `Cache` —
  `claude-sessions.json`, `usage.json` — are loud). Coverage is computed by path segments: a path inside the place, an
  ancestor of the place (including `/`, `/Users`, `/System/Volumes/Data/Users/<u>`) and a mask that can reach it
  (`~/Library/LaunchAgents/*.plist`, `~/Library/*/*.plist`, `/Users/*/.zshrc`) are all loud; `..` removes exceptions. On
  the human's machine the daemon adds the real paths of places that are links (`~/.zshrc` → dotfiles,
  `local-places.mjs`). The kind of place is the `risk` field of the permission; it is not part of the permission key
  (permission growth is computed as before). Write there only what the "why" promises, and keep an allowlist of keys, a
  backup before editing and atomic writes.

**Language (UI pass 2026-11-05).** The core passes the plugin `AGENTHUB_LANG=ru|en` (the effective hub language;
`LANG` stays `en_US.UTF-8`) and on a language change restarts streamable plugins and runs interval ones out of turn. A
plugin without a translation is shown as is. Metadata translations: repeat the tag with `lang="xx"` —
`<agenthub.title lang="en">Quota</agenthub.title>`, `desc`, `status` (with `value` and `label`), `push` (the same `key`,
the label as content; the rule without `lang` must come first), permission entries `fsRead`/`exec`/…
(`<agenthub.fsRead lang="en">~/x — why in English</agenthub.fsRead>` — only an explanation, it adds no permissions; the
install permissions window shows it in the hub language — from the archive itself, with `i18n.<lang>.why` from the index
as a fallback; for a `watch` entry the "why" is separated from the path only for display); for an action — the
`title-xx`, `cost-xx` attributes. Consecutive language changes are chained: a streamable plugin always has exactly one
process; a plugin that did not start at launch (`not-executable`) is not started on a language change. A tag without
`lang` is in the plugin's default language. The action fingerprint includes all `title`/`cost` variants, so a language
change does not break a confirmation. The registry's `build-index.mjs` copies the name and description translations into
`index.json` (`i18n: {en: {title, desc}}`). The `watch` permission is stored in the `index.json` entry in the old form —
the whole metadata line with " — why", `why: null` (`indexPermissions` in `lib/registry/perms.mjs`): cores before
2026-11-05 compare the archive permissions with the entry by the whole line, newer ones split it into a path and an
explanation — one index installs on both. The plugin formats numbers and dates itself: RU «1,2 млн», «05.11 11:00»,
«пн»; EN "1.2M", "Nov 5, 11:00", "Mon".

**Content in any language (contract 3 additive).** The hub UI stays ru/en (a third UI language is out of scope).
`lang` (and the `title-xx`/`cost-xx`/`input-xx` suffixes) take any BCP-47 tag (`de`, `pt-BR`, `zh-Hant`; stored in
canonical case); a malformed code is a metadata warning (journal, linter) and the tag is skipped. The core passes
`AGENTHUB_LOCALE` — the system preferred languages, BCP-47, in order (`Settings.systemLocales`, reserved like
`AGENTHUB_LANG`) — and picks a metadata translation (title, description, statuses, push labels, connections, actions, the
catalog's and consent window's titles and "why") by the chain in `lib/i18n.mjs` `contentLang`: the hub language if the
plugin has it → the system languages up to the first ru/en one → the base text. For existing ru/en users nothing changes:
a ru (or en) system stops the chain at its own language, which step 1 already decided.

**Plugin tier (`tier`)** — `own` (2026-11-09: an own plugin from a local folder whose installation a human confirmed in
the pinned app; a copy in `Plugins/<id>`, a `plugins.lock` entry with `tier: "own"` and `own.path` — only the manager
writes it, after the consent window; it never becomes official and has no registry archive or attestation), `builtin`
(the app's directory: claude-sessions, agents, quota, spend), `official` / `community` (installed by the manager; which one is
decided by the signed catalog at check time: official only while the index names the id official with the same archive
sha256 as in `plugins.lock` and the files on disk are exactly that archive; a lock entry by itself gives no tier),
`local` (`Plugins/local`). Plugin metadata does not affect the tier (an `<agenthub.tier>` tag is just an unknown tag).
`trusted` = `builtin`, `official` or `own` (`trustedPlugin` in `core.mjs`; a test-tier local plugin counts as `own`): only
these get `<agenthub.action>` at the declared level (for `own` — as for official: without network and without a price,
including `immediate`; `community` gets actions too, never below `confirm`), their own push rules in full (`community` —
`kind="plugin"` labels only), service variables (`AGENTHUB_USAGE_FILE`, `AGENTHUB_HUB_SOCKET`, `AGENTHUB_CLAUDE_SESSIONS_FILE`, `$VARIABLE` in
`<agenthub.watch>` and `<agenthub.fsRead>`), writing to the session registry and MCP calls through the hub.

**Plugin actions.** For `builtin`, `official`, `own` and (hub 0.1.3+) `community` — never below `confirm` for community;
`local` has none (a test hub with `AGENTHUB_TEST_TIER=own` gives local plugins the own tier). For non-built-in ones —
only from the app (class `app`, at any level: `offer.appOnly`); with declared network access or a price on the action
(`cost=`, `cost-<lang>=`) — at least `confirm-cost`, except an action with `net="none"` (it promises no network: the
network floor is lifted for it alone; part of the permission key, checked by the reviewer); for an official plugin without network the core keeps the declared level, including `immediate` — no
confirmation window (decision 2026-11-09: for example, a mode toggle; the linter flags every such action for the
registry reviewer — [`plugins-registry.md`](plugins-registry.md)); otherwise a confirmation whose text the core writes.
A run at any level is journaled (`type=action`). Changing the level changes the permission
(`actions: <id> [<level>] <command>`): lowering it in an update is a permission increase, with a consent window. The
command is split into argv **without a shell** (quotes, `\`, `~/`); the first word is the name of the plugin's main file
(`my-tool.30s.mjs --action stop`) — it runs with the same interpreter as the plugin. cwd is the plugin directory, the
environment is the same as the plugin's, the timeout is 30 s. The confirmation text ends with the sanitized title of the
row that carries the button ("Button on the row "…"", ≤ 120 graphemes).

**Input actions:** `input="placeholder"` (`input-<lang>=`, `maxLength=` 1…4000, default 256), always with `arg=` — the
value is typed by a human in the app (`offer.input`), not printed by the plugin (an `arg=` on the line is refused). The
core checks it with the same rules as an argument (pattern, control and format characters, a leading `-`) and the
action's `maxLength`, and writes it to the action's **stdin** (the text, `\n`, EOF); argv is the static command (a
`{name}` word is dropped). App only for every tier; the journal and `actionResult` carry only `inputLength`.

**Background actions:** `background="true"` — the command is a job: its own process group, no timeout, stdout keeps
only an 8 KB tail (for `reason=`/`message=`), at most `plugins.maxJobsPerPlugin` (4) per plugin. `/state.plugins[].jobs`,
the idle verdict and `facts.runningActions()` list it; `job-start`/`job-exit` in the journal; `job.started`/`job.exited`
on the bus. The end goes to the plugin: `{"type":"jobExit","job","actionId","ok","code","signal","durationMs",
"cancelled"?,"reason"?,"message"?}` to a streamable process, an extra run with `AGENTHUB_REFRESH_REASON=JobExit` to a
standard one. Stopped by `job.cancel` (app), the hub pause, removing/disabling/updating the plugin and the daemon
stopping; **not** by a restart of the streamable process (language, pause flag, `ctx.restartPlugin`). A `jobExit` that
comes while that process restarts is delivered to the new one, and each start of a plugin with background actions begins
with `{"type":"jobs","running":[…]}`. The job ends when its first process exits (the rest of its group is killed; a
`setsid` descendant holding stdout can't keep it alive); running jobs are kept in `<home>/jobs.json` so the next daemon
kills those a crashed daemon left behind ([`writing-plugins.md`](writing-plugins.md) 5.2).

**A parameterized action:** `arg="taskId:^[A-Za-z0-9_-]{1,64}$"` (name `[A-Za-z][A-Za-z0-9_]{0,31}`, a pattern with
`^` and `$`, up to 200 characters; otherwise the action is dropped with a warning). In the output —
`action=<id> arg=<value>`. The core accepts the offer only if the value matches the pattern (wrapped in `^(?:…)$`), is
not empty, up to 256 characters, without Unicode control and format characters (`\p{Cc}`, `\p{Cf}`: C0/C1, bidi
overrides, zero width) and U+2028/2029, and does not start with `-`; otherwise there is no offer and a warning goes to
the journal. Before the confirmation and the run the core re-reads the file metadata from disk: the value against the
current pattern (`409 facts:bad-arg`), the command/level/pattern/version against what was in the offer
(`409 facts:action-changed`); the confirmation token is bound to this fingerprint. The value is passed **as a separate
argv element** in place of the word `{taskId}` (or at the end).
An argument from the `POST /actions/:id` body is not accepted. The action checks the facts of its own world (the lock
holder, whether the task exists) itself; a refusal is a non-zero exit code and a last stdout line `reason=<code>` (goes
to `result.reason`). **The plugin writes the refusal explanation itself** (contract 2): a `message=<text>` line among the
last 5 stdout lines (usually before `reason=`) — in the hub language (`AGENTHUB_LANG`), cleaned like `activity=` phrases
(up to 120 graphemes); it goes to `result.message`, and the shell shows it as is: ""button": text". Without `message=`
the shell writes "the plugin refused (<code>)" — the hub has no texts of its own for specific plugins' codes.

**Plugin environment:** `HOME`, `PATH` (as for agents under launchd:
`~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), `TMPDIR`, `LANG`, `USER`,
`AGENTHUB_PLUGIN_ID`, `AGENTHUB_PLUGIN_DATA_PATH`, `AGENTHUB_PLUGIN_CACHE_PATH`, `AGENTHUB_LANG` (`ru|en` — the hub UI
language), `AGENTHUB_LOCALE` (the system preferred languages, BCP-47, comma-separated, may be empty), `AGENTHUB_REFRESH_REASON`
(`FirstLaunch|Schedule|FileChanged|MenuAction|Manual|LanguageChanged|Paused|Resumed|SecretChanged|JobExit`), `AGENTHUB_PAUSED` (contract 3:
`1` — the hub is paused, `0` — it is not; always passed, see above), `OS_PLATFORM`, `OS_VERSION_MAJOR|MINOR|PATCH`,
`OS_APPEARANCE`, `OS_LAST_SLEEP_TIME`, `OS_LAST_WAKE_TIME` (ISO), `AGENTHUB_SECRET_*` for declared secrets; **only for
built-in, official and own plugins** — core service variables (`ctx.providePluginEnv`): `AGENTHUB_USAGE_FILE` — the path
to the hub quota cache `<home>/Cache/usage.json` (the `usage` service; no variable means the service is off,
`services.usage.enabled = false`: the plugin shows "quota unavailable" and does not look for the file itself; the
permission is declared as `<agenthub.fsRead>$AGENTHUB_USAGE_FILE — why</agenthub.fsRead>`); `AGENTHUB_HUB_SOCKET` — the
hub socket (contract 3: always; previously only with the `oauth` service): the plugin calls
`POST /connections/<id>/mcp` (or `/http` for a `type="http"` connection) and gets the result without a token (the core checks the process pid, trust and
the declared `<agenthub.net>` against the service host; the core enforces rate and limits), and with the
`<agenthub.terminal>` permission — `POST /terminal/read-screen|send-text`; `AGENTHUB_CLAUDE_SESSIONS_FILE` (contract 3) —
the path to `<home>/Cache/claude-sessions.json` (the `sessions` service; no variable — the hub is older or the service is
off: the plugin lives without this data). On Windows also `USERPROFILE` (= `HOME`: `os.homedir()` reads it there) and
the system `SystemRoot`, `windir`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`. Nothing else (no `NODE_OPTIONS`).

**Output:** the header is everything before the first `---`, the body after it; `Title | k=v k2="v 2"` (the separator is
the last unescaped `|`, with only parameters to its right; a split whose right side has an unquoted value with a quote
character loses to a clean split further left); `--` is a nesting level; `---` in the body is a separator. Title
escapes (hub 0.1.3): `\|` (an odd backslash run before `|`) is a literal `|`, the run shows halved; a leading
backslash run followed by `-`/`~` loses one backslash — foreign text escaped with `escapeTitle` (`daemon/lib/output.mjs`,
[`writing-plugins.md` 4.1](writing-plugins.md#41-lines)) can't add parameters. `/state` carries titles already
unescaped. Parameters:

| Parameter | Meaning |
|---|---|
| `status=ok\|wait\|block\|error\|unknown` | in the header; the worst header status is the plugin status. None — `ok`; empty output — `unknown` |
| `tileLabel="…"` | in the first header line: a short popover tile caption instead of the plugin name (the tile holds one line of ~110 pt): "Agents" instead of "Background agents". None — the plugin name |
| `tile="…"` | in the first header line: a short value for the popover tile and the panel badge: what is happening ("04:30", "2 waiting", "62%", "1 problem"), not "!" — the status icon shows alarm; the header as a whole answers "do I need to do anything" in plain words |
| `activity="…"` | in the header, **any plugin tier** (this is not a permission): "work is in progress here" — for the hub's "can I shut down" verdict (`/state.idle`, the idle service): "Run "m81-gold" running, 12 min". Not to be confused with `status=wait` ("waiting/attention"). An empty value (`activity=""`) means "I take part in the check, all quiet here": the plugin goes into "Also checked"; no key — the plugin does not take part in the verdict. Every header line may carry its own phrase; the first 4 distinct ones are taken. The phrase is cleaned (Unicode control and format characters — bidi, zero width, U+2028/2029 — and newlines → a space, except ZWJ between emoji; at most 3 combining marks per grapheme; whitespace collapsed) and cut to 120 graphemes (with "…"). Phrases of plugins that are not trusted (builtin, official, own) are shown by the hub with a "<plugin name>: " prefix (unless the phrase already starts with it) and never in the card title. A failed plugin (exit ≠ 0, timeout, empty output; `status=error` with a normal exit is a domain error, not a failure) or a silent one (no frame for more than 3 intervals, at least 2 min) is shown as "<plugin>: failure — last: <phrase> (HH:MM)" rather than the phrase as is; an empty frame with an error (exit ≠ 0 without output) does not erase the last phrases. **A streamable plugin** with non-empty `activity=`/`needsOn=` repeats its frame at least every 2 min (the built-in agents — every minute): silent for more than 5 min counts as hung. Not understood in the body: the warning `parameter activity= is understood only in the header` (in the hub language). Does not go into `params`; in the plugin state — `activity: string[] \| null` |
| `needsOn="…"` | in the header, any tier: "I will need the computer on later" — "Build at 04:30 — needs the Mac on". needsOn and nothing else gives the `quiet-needs-on` verdict ("OK, but …"). Keep it short: the shell puts the part before " — " into the card title ("OK, but build at 04:30"; only for built-in, official and own plugins, for others — "OK, but not everything will run"). The same limits, cleaning and empty-value rules as for `activity=`; the key is case-insensitive (`needson=`). In the plugin state — `needsOn: string[] \| null` |
| `effect="<primitive> <arg>…"` | offer a primitive; an argument is `key=value` or positional (`effect="open.url https://…"`) |
| `action=<id>` | an action from `<agenthub.action>`; `arg=<value>` — the argument of a parameterized action |
| `href=<url>` | the same as `effect="open.url <url>"` |
| `event=<key>` | an event for push: the core sends `event.raised` when the key appears and `event.cleared` when it disappears (the bus key is `<pluginId>:<key>`). `event.raised` carries `title` — the sanitized text of the first row with that key (≤ 120 graphemes) when it has one. Subscribed plugins get it on stdin (`<agenthub.subscribe>`, below) |
| `agentSession=<id> pid=<pid>` (+ `agent=<kind>`, `agentName="…"`) | another agent's session (within contract 3): only from builtin, official and own (and the test tier) — otherwise ignored with a warning. `<id>` — `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; the process must exist, its start time is recorded; no signature check. The core keeps it apart from the Claude registry (`/state.externalSessions`, the `sessions.external` event); the entry goes when the line disappears, the process ends or the plugin is removed; an id is held by the first plugin while its process lives. Only `session.focus` works for it (the terminal layer's `locate()` by the pid); `session.interrupt`/`session.stop` → `facts:external-session`, `/terminal/*` → `terminal:external-session` |
| `session=<sessionId> pid=<pid>` | a line about a Claude Code session: the core verifies the pid signature and writes `session: {id, pid, verified, label?}` into the item (`verified: false` → `label` in the hub language: «подпись не подтверждена», «подпись не проверить: Claude Code обновился»); verified ones go to the registry, but only from builtin, official and own (community and local do not change the session registry) |
| `sessionStatus=busy\|waiting\|idle`, `waitingFor=…`, `sessionName=…`, `sessionCwd=…`, `surfaceId=…`, `workspaceId=…` | session data for the registry |
| `sessionEffort=low\|medium\|high\|xhigh\|max`, `sessionUltracode=true\|false` | the effort of the last turn and ⚡ultracode (claude-sessions — from metadata fields of the transcript tail); an unknown value is dropped; in `/state.sessions[].effort`/`ultracode` |
| `sessionModel="…"`, `sessionModelSource=turn\|command`, `sessionEffortSource=turn\|command`, `sessionAt=<ISO 8601>` | contract 3: the session model (an id from a turn record or a name from `/model` output; letters, digits, space and `._:()[]/+-`, up to 64), where the model and effort came from (the last turn or a `/model`, `/effort` command after it — the command wins) and the time of the transcript record they came from; unknown values are dropped; in `/state.sessions[].model`/`modelSource`/`effortSource`/`metaAt` and in `Cache/claude-sessions.json`. Only trusted plugins write to the registry |
| `bash=`, `shell=`, `terminal=`, `paramN=` | **forbidden**: dropped, with a warning in the journal |
| `stat="<caption>"`, `note="…"` | a number card on the plugin page: the line title is the value ("04:30"), `stat` the caption, `note` a line under it (`color=` — its color); consecutive ones form a row |
| `gauge=<0…100>`, `gaugeLabel="…"` | in the body — a card with a fill bar (`note` on the right, children are lines under the bar); in the first header line — a ring on the plugin page (`gaugeLabel` — the caption under the number) |
| `strip=true` | the line's children form a strip of cells (`sfimage`, title, `note`; a cell with `effect` is a button): "Recent runs" |
| `details=true` | the line's children are collapsed into a second level ("Details"): process ids, cron lines, ids |
| `segment=true`, `select=true`, `selected=true` | hub 0.1.1: the line's children are the options of a segmented control (one track, the `selected=true` child highlighted) or a popup button (the current child with a chevron, a menu of all children with their `note=` dimmed); the other children carry offers; `note=` on the line — gray text beside the control. A segment that does not fit the width is drawn as a popup button |
| `toggle=on\|off` | hub 0.1.1: a switch in that state; a click runs the line's own offer (the plugin flips the state in its next frame) |
| `table=true`, `columns="A¦B"`, `cells="b¦c"`, `cellColors="¦#RRGGBB"`, `icon=true`, `group=true`, `header=true` | hub 0.1.1: the line's children are ~34 pt table rows — the title is the first column, `cells=` the others, `cellColors=` a color per cell (empty — default), `sfimage`/`iconColor` (or `status`) a state dot; a row's children with an offer are buttons on its right (`icon=true` — icon only, the title as tooltip and accessibility label), without an offer — gray notes; a `group=true` child is a collapsible subheading whose children are rows; a direct child with an offer and `header=true` is a button by the table title. `¦` (U+00A6) separates entries, empty entries keep their place |
| `chart=bars`, `values="v1,v2"`, `labels="a¦b"`, `valueLabels="…"`, `avg=`, `avgLabel=`, `highlight=last\|<index>`, `tint=none`, `tips="…"`, `height=`, `unit=`, `stack="a,b"`, `series="a1,a2;b1,b2"`, `colors="#hex,#hex"`, `legend=true` | hub 0.1.3: a bar chart card — one bar per value (or stacked layers per series, a visible layer at least 2 pt), `labels` under the bars, `valueLabels` above them, a dashed average line with its caption (bars above it tinted orange unless `tint=none`), the `highlight` bar in the plugin color or `color=`, a hover tooltip per bar (`tips`: `¦` between entries, the two characters `\n` — a line break inside one). A `segment=true`/`select=true` child sits in the card's title row; other children are drawn under the chart. `note=` — gray text right of the title |
| `chart=share` with children carrying `value=` (`note=`, `color=`) | hub 0.1.3: one rounded bar of the children's shares and a legend: dot · title · percent · `note=` on the right. No positive value — a plain line |
| `bar=<0…100>`, `barColumn=<n>` | hub 0.1.3: a thin progress bar on a body line (title, `note=` right, the bar under them; `color=` tints the bar) or a table row (`barColumn=` on the table or the row, 1-based with the title column as 1: the bar in that column with the cell text beside it; without it — a hairline under the title) |
| `max=<number>` (on `chart=bars`) | hub 0.1.3: a fixed scale top — bars above it are clipped, an `avg=` above it is not drawn. Without it the scale autoscales to the tallest bar or `avg=`, whichever is higher. Non-positive or broken — ignored |
| `spark="v1,v2"`, `sparkAvg=`, `sparkMax=`, `sparkLabel=`, `sparkNote=` | hub 0.1.3, first header line: a bar sparkline (the last bar in the plugin color). On the plugin page the header becomes a hero — `stat=` caption, the `tile=` value large, `note=` and the other header lines under it, the sparkline with its captions and a dashed average on the right; the popover tile draws it in its icon row |
| `until=<ISO-8601>` | hub 0.1.3, first header line: a countdown the app runs itself in the tile and the page header (`mm:ss`, from an hour `h:mm:ss`, stops at `00:00`); give a time zone; unparsable — ignored; keep a `tile=` for older hubs |
| anything else (`color`, `iconColor`, `sfimage`, `badge`, `badgeColor`, `link`, `tooltip`, `font`, `size`, …) | styling, passed as is in `params`. The panel uses: `color` (title and icon, on every nesting level), `iconColor` (icon only), `badgeColor` (badge tint), `link=true` (an offer line drawn as a text link, not a capsule; same gate and confirmation), `font=mono` (hub 0.1.3: the title in a monospaced font; other `font=` values are ignored). Older hubs ignore keys they do not know — no contract bump (contract 3) |

A non-zero exit code → status `error` (the output items are kept) and the `plugin-error` event. A standard timeout
(5 s) → the whole process group is killed, `error: "timeout"`. More than 1 MB of output → `output-too-large`.

**streamable:** a long-lived process; **a frame ends with a `~~~` line** (print the frame, then `~~~`). Stdin gets
NDJSON: `{"type":"fileChanged","path":…}` (per `<agenthub.watch>`), `{"type":"refresh","reason":…}`,
`{"type":"actionResult","id":…,"actionId"|"primitive":…,"arg":…,"ok":…,"code":…}` (`arg` — the checked argument or
`null`; `inputLength`, `job` when they apply), `{"type":"jobs","running":[…]}` and `{"type":"jobExit",…}`, `{"type":"inbound",…}` from extensions,
`{"type":"event","plugin","key","state":"raised|cleared","title"?}` and `{"type":"eventSnapshot","events":[…]}` (event
subscriptions, below), and
`{"type":"stopping","reason":"restart|updated|policy|removed|shutdown","cause"?}` right before the core stops it (stdin is
then closed; SIGTERM 200 ms later, SIGKILL a second after). If it crashes — restart with a 1 s → 60 s backoff, status
`error` until the next frame; the environment is built again for every restart. `plugin` events of one plugin reach SSE
at most every 250 ms (`plugins.emitMinIntervalMs`), always with the latest state; the first change after a quiet period
and the first frame after an action or a job's end go out at once.

**Process lifecycle.** Every run, streamable process and action runs in its own process group; when it ends or times
out the core kills the whole group, so children left behind die with it (a long task is `background="true"`). A restart
of the streamable process (language, pause, `ctx.restartPlugin`) kills its group too — background jobs are separate
groups and survive it.

**watch:** a path or a mask in the last segment (`~/.claude/sessions/*.json`); 300 ms debounce with a 2 s maximum wait
(`WATCH_MAX_WAIT_MS` in `runner.mjs`): writes that never pause still give a run at least every 2 s (re-review 68). If the path does not
exist but its parent directory does — the directory is watched by name (a file appearing triggers a run right away); if
the directory does not exist either — a retry every 30 s. An entry may start with a core service variable:
`<agenthub.watch>$AGENTHUB_USAGE_FILE — why</agenthub.watch>`,
`<agenthub.watch>$AGENTHUB_CLAUDE_SESSIONS_FILE — why</agenthub.watch>` (or `${NAME}/…`) — the core substitutes the path
from the same `ctx.providePluginEnv` variables that go into the plugin environment, that is, **only for built-in,
official and own plugins**; for others, and when the service is off, the entry is skipped (a warning in the journal) and
the plugin lives by the interval from its file name. This is how the built-in quota (`quota.5m.mjs`) and any trusted
plugin with such an entry run right after the usage service writes the quota cache; the interval is a fallback.
`$AGENTHUB_PLUGIN_DATA_PATH` and `$AGENTHUB_PLUGIN_CACHE_PATH` (the plugin's own directories, created before the watch
starts) are substituted for **every** tier. `~` is the plugins' HOME — the same as in their environment
(`AGENTHUB_PLUGIN_HOME` on a test bench). `<agenthub.watch recursive="true">` also watches subdirectories (`fs.watch`
recursive: macOS, Windows, Linux with Node ≥ 20); a mask then matches the file name at any depth, and `fileChanged` carries
the full path. The attribute is optional: an older hub watches the top level only (`meta.watchRecursive` keeps those
entries; the permission key is unchanged).

An unknown source shape → the plugin itself prints `status=unknown` and `event=source-broken`.

**`event=` keys** — pick them from the shared push table ([`daemon/lib/push/README.md`](../daemon/lib/push/README.md))
or describe your own rule with a `<agenthub.push key="…">Label</agenthub.push>` tag (taken in full from `builtin`,
`official` and `own`; from `community` only `kind="plugin"` rules, key and label): the rule is chosen by key, an instance suffix goes after `:` (`session-waiting:<sessionId>`,
`build-done:<YYYYMMDD>`). The title of the line with `event=` goes into the notification — metadata only. The
`kind="sessions|updates|problems|other|plugin|security"` attribute assigns the event to a switch in "Settings →
Notifications"; without it — the kind of the core rule with the same key, otherwise "other". `kind="plugin"` (contract
2) is **the plugin's own toggle**: a line with the plugin name in "Settings" (`/state.notifications.plugins`), which the
hub builds from installed plugins — no plugin, no line. `was="runs|night"` next to `kind="plugin"` is the former
contract 1 kind, used to carry over the user's choice; the deprecated `kind="runs"` and `kind="night"` are accepted as
`kind="plugin" was="…"` with a linter warning ([`daemon/lib/push/README.md`](../daemon/lib/push/README.md),
"Migration"). `security` (cannot be turned off) is declared only for tampering signals — the registry reviewer checks
every such tag (the registry's `scripts/check.sh` warns about it and about keys the core raises itself:
`app-restart-stopped`, `app-pin-changed`, `hub-update-*` and so on). A plugin event with the key of a core `security`
rule does not become an exception: the kind, the banner bypassing the shell and the core quiet hours apply only to the
hub's own events. `services.push.rules` in `config.json` does not apply to `security` rules.

## Contract versions

The core declares the plugin contract version (`CONTRACT_VERSION` in `daemon/lib/meta.mjs`; `/state.contract`,
`/health.contract`, `agenthub version`). A plugin declares the minimum it needs —
`<agenthub.contract>N</agenthub.contract>`; if it is newer than the hub's, installation and update refuse with
"requires a newer hub" (CLI, window, catalog), and an already installed plugin keeps working as is (journal
`plugin-contract-newer`).

| Version | When | What |
|---|---|---|
| 1 | before 2026-11-09 (implicit) | everything above without the version 2 items. Push kinds: `sessions`, `runs`, `night`, `updates`, `problems`, `other`, `security`. One connection and the icons of several plugins were hard-coded in the core and the shell |
| 2 | 2026-11-09…10 | **Cleaning plugin names out of the core.** `<agenthub.contract>`; `<agenthub.icon>` (tile icon and color instead of a dictionary in the shell); `<agenthub.connection>` (the plugin declares the connection, not the core; the `connections` permission; MCP calls only through its own connection, otherwise `mcp:not-owner`); `kind="plugin"` and `was=` on `<agenthub.push>` — the plugin's own toggle instead of the `runs`/`night` kinds (they are deprecated synonyms with a linter warning; carrying over turned-off ones — [`daemon/lib/push/README.md`](../daemon/lib/push/README.md)); `message=` in action output — refusal text from the plugin (the shell no longer knows plugin codes); the `blocker`, `session-died`, `workflow-*` rules moved from the core table into plugin metadata; the built-in `agents` 1.2.0, `claude-sessions` 0.4.0, `quota` 0.5.0 declare their icon, contract and own push rules (`quota` — `week-80`, `pace-85`, `token-lost`: the `quota-*` rules left the core table, and `services.push.rules` overrides by their old names no longer work — use the plugin key). Review 2026-11-10: the connection id is `<plugin id>.<name>` (not `<id>-…`), starting with a letter, up to 64; connections only for official and own plugins (linter); the address is a host name, not an IP; the daily budget up to 10000 is really enforced; "orphaned" connections; the "requires a newer hub" refusal comes before the linter, for own plugins too; a version that needs a newer hub does not count as an "available update"; an unparseable `contract` in an index entry means "requires a newer hub" for that entry, not a catalog refusal |
| 3 | since 2026-11-10 | **Sessions, pause, loud permissions** (see "Contract 3" above). `AGENTHUB_CLAUDE_SESSIONS_FILE` — metadata of live Claude Code sessions for trusted plugins (the core `sessions` service, `Cache/claude-sessions.json`: model, effort, where they came from — a turn or a `/model`/`/effort` command, record time, ultracode, tab, `verified`; no conversation text), allowed in `<agenthub.watch>` and `<agenthub.fsRead>`; session line parameters `sessionModel=`, `sessionModelSource=`, `sessionEffortSource=`, `sessionAt=` (in `/state.sessions[]` — `model`, `modelSource`, `effortSource`, `metaAt`); the built-in `claude-sessions` 0.5.0 reads the model and the `/model`, `/effort` commands from the transcript tail and declares contract 3. `AGENTHUB_PAUSED=0\|1` in every plugin run and restarting plugins when the pause is set or lifted (`AGENTHUB_REFRESH_REASON=Paused\|Resumed`). An `fsWrite` permission to a Claude Code or system hijack location — the `risk` field, a red line in the consent window (app and terminal), a registry linter warning. Shell: tooltips with the full text for all truncatable plugin texts (sidebar, header and page lines, cards, strips, popover) — as AppKit tooltips, also in an inactive app. Terminal: `<agenthub.terminal>read-screen|send </commands>|*` (only `builtin`/`official`/`own`; by command — slash commands with ≤ 3 short arguments, `*` — any line except a leading `!`, `#`, `&`; typing is `risk: "terminal"`, a red line in the consent window), the routes `POST /terminal/read-screen` (input field flags, no screen text) and `POST /terminal/send-text` (a line ≤ 200, printable ASCII without `\\`; only a Claude Code session with a verified signature, a known tab and a foreground process, an empty field and no turn running, not while paused, rate-limited, journaled without text) from the plugin's process — a run, streamable or action — through the core terminal layer (the cmux adapter → the bridge operations `read-screen`, `send-text`); `AGENTHUB_HUB_SOCKET` always for trusted plugins. Hijack locations — all of `~/.claude`, a project's `.claude`, `~/.cmuxterm` and terminal configs, global npm packages, shared hub files; `sessionNameSource=` (an auto-title does not go into the sessions file). The `session.focus <sessionId>` effect — switching to the session tab without knowing the terminal (the terminal layer: the adapter's `focus` operation; `/state.sessions[].terminal`/`focusable`), in the harmless effects ceiling of third-party plugins next to `open.*` and `cmux.focus` (`cmux.focus` — for compatibility); the `modelId` field in the sessions file (a model id even when the name comes from `/model`). **Terminal layer (AH-33, within contract 3):** built-in terminal adapters cmux, tmux, iTerm2, Terminal.app with declared capabilities; `terminal.focus` (the generic name of `cmux.focus`, which stays a deprecated alias until contract 4); `/state.sessions[].terminalInfo` and `/state.terminals` (additive: `terminal` stays a string, `focusable` stays); `409 terminal:unsupported`, `facts:esc-unsupported`, `facts:launch-unsupported`, `facts:no-launch-terminal` |

**Controls within contract 3 (hub 0.1.1).** `segment=`, `select=`, `toggle=`, `table=` and their companion keys
(`selected`, `columns`, `cells`, `cellColors`, `icon`, `group`, `header`) are plain params: the core passes them as is and
makes offers for the toggle line and for children at any depth, as for any line. They are optional and need no contract
bump — a hub 0.1.0 ignores the keys and draws the children as plain lines and capsule buttons (a toggle — as a button
with its title), so a plugin keeps `<agenthub.contract>3` and its output stays usable on both. Write the titles so that
the fallback reads well too ("Ultracode: off").

**Charts within contract 3 (hub 0.1.3).** `chart=`, `bar=`, `barColumn=`, `spark=` and their companion keys
(`values`, `labels`, `valueLabels`, `avg`, `avgLabel`, `highlight`, `tint`, `tips`, `height`, `unit`, `stack`, `series`,
`colors`, `legend`, `value`, `sparkAvg`, `sparkLabel`, `sparkNote`) are plain params as well: the core passes them as is
(the data keys `values`, `labels`, `valueLabels`, `tips`, `series`, `spark` up to 8000 characters, the rest up to
2000; a longer data key keeps its newest entries — the lists of one chart line lose the same count from the start,
with a journal warning), no contract bump. An older hub ignores them and draws the lines as plain text — a chart line as its title with its
children as lines, a `bar=` line as its title, the header as before. Numbers are plain decimals (`1234.5`, no exponent, no
thousands separator); lists are comma-separated, text lists `¦`-separated.

**Other additions within contract 3 (hub 0.1.3).** All optional, ignored by an older hub: title escapes (`\|`);
action attributes `input=`, `net="none"`, `background="true"`; community actions and `kind="plugin"` push rules;
`<agenthub.subscribe>`; `<agenthub.connection type="http">`; `<agenthub.watch recursive="true">`; `agentSession=` lines;
`until=`, `font=mono`, `max=`, `sparkMax=`; `lang` in any BCP-47 tag and `AGENTHUB_LOCALE`; `actionResult.arg`,
`{"type":"jobExit"}`, `{"type":"stopping"}`; `event.raised.title`; banner buttons and click target (`push.notify`
`actions`, `href`); `writes=` on `<agenthub.connection>` (write tools never served from the cache); `macOnly="true"` on
`<agenthub.push>` now keeps the event off the extra channels (older hubs ignore it); a `>` inside a quoted attribute
value. A plugin that relies on one of them keeps `<agenthub.contract>3</agenthub.contract>` and should read
on an older hub as the fallback each item describes.

**Contract 3 and version 2 hubs.** A version 2 hub sees `<agenthub.contract>3` and refuses with "requires a newer hub" —
so a plugin that cannot live without session metadata or the pause flag only needs to declare 3. A plugin that declared
2 does not get `AGENTHUB_CLAUDE_SESSIONS_FILE` on a version 2 hub (the `fsRead $AGENTHUB_CLAUDE_SESSIONS_FILE`
permission is in the consent window, but there is no variable — a `watch` entry using it is skipped with a warning) or
`AGENTHUB_PAUSED` (no variable — an older hub: do not do background work); the pause does not restart it. A version 2
hub shows permissions with `risk` as a regular line. A version 2 hub does not know the `<agenthub.terminal>` tag (the
metadata parser skips it, there is no permission in the window) and has no `/terminal/*` routes (`404`) — a plugin that
types into tabs needs `<agenthub.contract>3`. Nothing from contract 2 changes: contract 1 and 2 plugins work on a version
3 hub as before (the extra environment variable and the restart on pause do not bother them). Rollout order: first hub
3, then the plugins that declare contract 3.

**What breaks for contract 1 plugins on a version 2 hub.** The core table rules `blocker` (in the evening, without a
pause between repeats, kind "night"), `session-died` and `workflow-*` (kind "Agent runs") and `quota-*` moved into
plugin metadata. A contract 1 plugin that raised these keys without its own `<agenthub.push>` gets the default rule on a
version 2 hub: immediately, without the evening delay, kind "Other" — until it moves to a version with its own tags. The
built-in plugins have already moved; among own and official plugins this affects those that have not yet been updated
to contract 2. Such a plugin's icon is neutral.

**Contract 1 hubs do not know the contract version.** They do not know the `<agenthub.contract>` tag or the index
`contract` field: they install a contract 2 plugin silently and lose what they do not understand — `kind="plugin"`
rules are dropped (the v1 parser does not accept them; the plugin keeps only rules with contract 1 kinds), an
`<agenthub.connection>` does not work (it is not in the consent window: the old core ignores `connections`
permissions), and `message=` text is not shown. They have no "requires a newer hub" protection — it starts with version 2
hubs.

**Contract 2 rollout order** (the live hub is on contract 1):
1. Update the hub to version 2 (`agenthub hub update` / the installer). Turned-off "Agent runs" and "Night" are carried
   over on first start ([`daemon/lib/push/README.md`](../daemon/lib/push/README.md), "Migration").
2. Right away move own plugins that relied on core rules (for example, a runner plugin that raised `blocker`) to their
   contract 2 version from their folder (`agenthub plugins install --from …/agenthub/<id>`): the installed contract 1
   version loses the core `blocker` rule (above).
3. Only then publish the contract 2 versions of registry plugins: a contract 1 hub would install them without their own
   push rules.
4. Rolling the hub back to version 1 (`agenthub hub rollback`) does not lose notification settings (same place,
   "Migration"), but contract 2 plugins run in a reduced form on it (the paragraph above).
