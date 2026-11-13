# Changelog

Releases are git tags `vX.Y.Z` (also published as GitHub releases); the current version is in [`VERSION`](VERSION).
The plugin contract has its own version history in
[`docs/extension-points.md`](docs/extension-points.md#contract-versions).

## 0.1.3 — 2026-11-13

Everything below stays within plugin contract **3**: each addition is an optional attribute, parameter, field or route
that an older hub ignores, so plugins keep declaring `<agenthub.contract>3</agenthub.contract>`.

### Security

- **Escaping in plugin titles.** Foreign text printed last on a line (a log line, a PR title, a tab name) could add
  parameters after its own `|` — `href=`, `event=`, the plugin's own `action=`/`arg=`. Now a `|` preceded by an odd
  number of backslashes (`\|`) is a literal `|` of the title, never a separator (the backslash run shows halved); a
  leading backslash run followed by `-`/`~` loses one backslash, so foreign `--x`, `---` or `~~~` stay text. Backslashes
  anywhere else show as before, and `/state` carries the titles unescaped. A split whose right side starts inside a
  quoted value (an unquoted value there holds a quote character, as in `note="a | href=…"`) now loses to a clean split
  further left, and an unquoted value may not start with a quote. A line over the limit (now 64 KB, was 16 KB — a
  chart line with every data key at its maximum fits) keeps only its title and no parameters, since the cut may fall
  inside a quoted value; a streamable line over 1 MB is dropped up to its end instead of its tail becoming a new line.
  `escapeTitle` is meant for a whole title. Copyable `escapeTitle`/`quoteValue` helpers for JS and Python are in
  [`writing-plugins.md` 4.1](docs/writing-plugins.md#41-lines) (the hub's own `escapeTitle` is in `daemon/lib/output.mjs`).
- **Built-in plugins audited** for foreign text: all of it already went through their `clean()` (`|` → `¦`, no leading
  `-`/`~`, no control characters) and quoting helpers. `claude-sessions` now takes the session id of a remembered
  stopped session from the checked key of its memory file, not the stored object, and prints a non-integer pid as `?`.
- **Untrusted plugins on the hub socket.** The server recognizes plugin processes by the peer pid, its ancestors (at
  any depth) and the process group of each (every plugin process leads its own group: runs, streamable processes,
  actions and background jobs; the native `pidInfo` now reports `pgid`) and binds `peer.plugin`. A process of a
  community or local plugin, or any child of it, gets only `GET /health` and `GET /peer`; everything else is
  `403 peer:untrusted-plugin`, journaled (`denied` with `plugin`, once a minute per plugin and route). Before, such a
  process was plain `cli`: it read every session with its folder, pressed `immediate` actions of built-in plugins and
  could pause the hub. Trusted plugins (builtin, official, own) are unchanged; `GET /peer` shows `plugin: {id, trusted}`.
  Not a hard boundary against the same UID: a process that leaves both the tree and the group (`setsid`, then a double
  fork) is plain `cli` again ([`api.md`](docs/api.md#peer-classes)).
- **Test switches don't follow `$HOME`.** `AGENTHUB_TEST_TIER`, `AGENTHUB_TEST_EXTENSIONS` and the self-test compare
  `AGENTHUB_HOME` with the live directory of the account's real home too, so `HOME=/tmp/x` with `AGENTHUB_HOME` pointing
  at the live directory no longer turns them on there.
- **A dead plugin process loses its identity at once.** A run, action or job pid was attributed to the plugin until its
  output closed — a descendant holding stdout kept a pid of an exited process trusted, and a reused pid could pass
  `/connections/*/mcp|http` and `/terminal/*` as the plugin. Now the pid is dropped when the process itself exits (a
  streamable process too), and a job whose leader exited never signals its group id again.
- **tmux runs only a known binary.** The adapter used the executable path of the nearest ancestor whose name looked like
  `tmux…`; now it runs one of the standard tmux paths that is that executable (after resolving links), or doesn't reach
  the session at all.
- **Connection budget holds under parallel calls.** A call let through the daily-budget gate is counted at once (a
  reservation released if it never reaches the network), not after the keychain read: parallel requests of a plugin
  could all pass the gate before the first was recorded.
- **Stricter HTTP connection requests.** A `path` with an encoded separator, dot or percent (`%2F`, `%5C`, `%2E`, `%25`),
  a malformed escape or `;` (`..%2F`, `..;/`, `%252e`) is `400 args:path:invalid` instead of being resolved past the
  declared prefix by the service or a proxy; request headers are an allow-list only (fixed headers plus `…-Version`
  API version headers — `X-Override-URL`, `X-Envoy-*`, `x-middleware-subrequest` and other `X-…` are refused); the query
  key `_method` is `403 http:query-not-allowed`.

- **A plugin's process group stays the plugin's until its run ends.** A descendant left in the group of a run, action,
  job or streamable process (`( sleep 1; curl … ) &`, a child that outlives its parent) was a plain `cli` once the
  group's first process exited — an untrusted plugin's background child got the full CLI view of the socket for the rest
  of the run. Now the group counts until the run is over and the group killed (re-review 63).
- **`net="none"` holds on the hub's own proxy.** An action that promised no network (or its background job) could still
  reach a service through `POST /connections/:id/mcp|http`. Now its process gets `403 net:none` there, journaled as
  `mcp-denied`/`http-denied` with the action id (re-review 66).
- **Plugin processes while they stop.** A streamable plugin told `stopping` (restart, update, removal) and the
  background jobs of a removed or updated instance being killed were attributed to nobody for about a second and got
  the plain `cli` view. They stay the plugin's until gone now — with its trust on a restart of the same instance, as an
  untrusted plugin otherwise. A connection whose process was already gone when classified (`peer:no-process`,
  `peer:no-pid`) gets only `/health` and `/peer`. A stream's process group is forgotten once it has no member left
  (review 3).
- **Linter `*.key` catches multi-dot names again.** `"example.com.key"`, `"tls.server.key"`, `` `${host}.local.key` ``
  and `"--key-file=my.site.key"` passed since re-review 69; now only SF Symbol names in `sfimage=` and `symbol="…"` are
  exempt, and a bare dotted string ending in `.key` is flagged. The registry's vendored `perms.mjs` is the same file
  (review 3).

### Plugin contract (additive, contract 3)

- **Typed input for actions.** `<agenthub.action … input="Placeholder" input-ru="…" arg="name:^pattern$" maxLength="N">`:
  the app shows a text field (`offer.input: {placeholder, maxLength, pattern}`); `POST /actions/:id {"input": "…"}` is
  accepted from the app only, whatever the tier. The core checks the text like an argument (pattern, control
  characters, a leading `-`, `maxLength` up to 4000, default 256 → `400 input:*`) and writes it to the action's stdin
  (text + `\n`, EOF) — never argv; the journal and `actionResult` carry only `inputLength`. At a confirm level the text
  may be typed in the confirmation (the 428 carries `input`).
- **`net="none"` on an action** lifts the `confirm-cost` floor that `<agenthub.net>` puts on every action, for that
  action only (a `cost=` still counts); it is part of the permission key, and the linter accepts `immediate` +
  `net="none"` with a reviewer warning.
- **Background actions** (`background="true"`): own process group, no 30 s timeout, at most 4 per plugin
  (`409 facts:jobs-limit`), listed in `/state.plugins[].jobs` and the "Can I shut down?" verdict, journaled (`job-start`,
  `job-exit`, `job-cancel`), SSE `job.started`/`job.exited`; at the end a streamable plugin gets
  `{"type":"jobExit",…}`, a standard one an extra run with `AGENTHUB_REFRESH_REASON=JobExit`. Stopped by the new
  app-only `job.cancel` primitive, the hub pause, removing/disabling/updating the plugin and the daemon stopping — not by
  restarts of the streamable process. A `jobExit` that comes while the streamable process restarts is delivered to the
  new process, which also starts with `{"type":"jobs","running":[…]}`. A job is its first process: when it exits, the
  rest of its group is killed, and a descendant that left the group (`setsid`) holding stdout can't keep the job alive
  (stdout is closed a second later); a cancelled job whose end can't be observed ends as `reason: "orphaned"`. Running
  jobs are recorded in `<home>/jobs.json` (0600): a crashing daemon signals their groups on the way out, and the next one
  kills groups whose first process still has the recorded pid and start time (`job-orphan-killed`). Two presses at once
  can no longer start more jobs than the limit.
- **Community plugins get actions and push rules.** Actions never below `confirm`, app only, journaled.
  `kind="plugin"` push rules are taken with their key and label only (no quiet, away, hold, cooldown or other kinds), so
  a banner shows the reviewed label and the row text under the plugin's own switch in Settings (at most 5 a minute,
  quiet hours → the morning digest). The linter gives warnings instead of errors.
- **The confirmation names the row** that carries the button (sanitized, ≤ 120 graphemes; also `row` in the 428).
- **Banner buttons and click target.** Up to 2 direct children of the line with `event=` that carry an offer (not
  `input=` actions) become notification buttons (`push.notify` `actions: [{offer, label, level}]`, pressed through
  `POST /actions/:offer` like the panel button), and the event line's `href=` (checked like `open.url`) becomes the
  click target (`push.notify` `href`). Only when the banner shows the row text (trusted plugins, community keys with a
  reviewed rule).
- **`event.raised` carries `title`** — the sanitized text of the row with the key (≤ 120 graphemes).
- **Event subscriptions.** `<agenthub.subscribe>plugin-id:key-prefix — why</agenthub.subscribe>` (up to 16; `*` instead of
  the id — every other plugin) for trusted streamable plugins: each matching raised/cleared event arrives on stdin as
  `{"type":"event","plugin","key","state":"raised|cleared","title"?}`, and every (re)start of the process brings
  `{"type":"eventSnapshot","events":[…]}` with what is raised now; at most 600 messages a minute per subscriber. A new
  permission kind `subscribe` (needs a "why"; adding one asks for consent again; the index checks its shape and the
  terminal installer names it); the linter warns that the tag is
  ignored for community, local and standard plugins and flags `*` for the reviewer. Actions a plugin presses over the
  socket are journaled with `byPlugin` (`action`, `action-denied`, `action-confirm-requested`).
- **Other agents' sessions.** A trusted plugin's line `agentSession=<id> pid=<pid> [agent=<kind>] [agentName="…"]`
  registers a session of kind `external` (the process must exist, its start time is recorded; no signature check):
  `/state.externalSessions` and the `sessions.external` SSE event — `/state.sessions` stays Claude Code only. Only
  `session.focus` works for it (the tab found by the pid in tmux, iTerm2 and Terminal.app; cmux knows only its Claude
  Code tabs); `session.interrupt`/`session.stop` refuse with `facts:external-session`, `/terminal/*` with
  `terminal:external-session` (they accept the external id instead of failing with `args:sessionId:pattern`). The entry
  goes when the line disappears, the process ends or the plugin is removed.
- **HTTP connections** — `<agenthub.connection type="http">`: OAuth 2.1 for services without MCP with a pre-registered
  public `client_id` (no secret, no dynamic registration), declared `authorize`/`token` endpoints, PKCE S256, the same
  loopback sign-in in the app (optional fixed `port`), the token in the keychain, refreshed by the hub.
  `POST /connections/:id/http {method, host?, path, query?, headers?, body?, fresh?}` proxies a request to a declared API
  host (`hosts`, all hosts in `<agenthub.net>`) with the bearer token: declared `methods` and `paths` only, request and
  response headers from allow-lists, no redirects followed, the response body capped at 256 KB (base64 for binary).
  Reads (`GET`/`HEAD`) use the interval cache unless `fresh`; other methods are writes (sent within budget and backoff —
  else `429 http:wait` — and they make cached reads stale). `/connections` items carry `type`, `apiHosts`, `methods`,
  `paths`; the linter warns the reviewer about the token hosts and write methods.
- **MCP from action processes and writes.** A button the human pressed can call its connection too, not only a run or
  a streamable process. `POST /connections/:id/mcp {…, fresh: true}` — a write or an explicit refresh: past the interval
  cache, waits for the service, still within the daily budget and backoff (`429 mcp:wait` — not sent); the result is not
  cached, a tool error starts no backoff, and a successful fresh call makes the plugin's cached reads of that connection
  stale.
- **Plugin content in any language.** Plugins get `AGENTHUB_LOCALE` (the system preferred languages, BCP-47, in order);
  `lang="…"` and `title-…`/`cost-…`/`input-…` accept any BCP-47 tag (malformed — a journal and linter warning);
  translations are picked by hub language → system languages (up to the first ru/en one) → base text, so ru/en users see
  no change. `/state.lang.locales` lists the system languages. The hub UI itself stays ru/en. A change of the system
  languages alone re-translates plugin labels within a minute (no plugin restart); the daemon reads the OS language
  list once a minute for both the hub language and the locales.
- **`<agenthub.watch>`**: `$AGENTHUB_PLUGIN_DATA_PATH`/`$AGENTHUB_PLUGIN_CACHE_PATH` are substituted for every tier, `~`
  is the plugins' HOME (`AGENTHUB_PLUGIN_HOME` on a test bench), and `recursive="true"` watches subdirectories — a
  separate permission (`watch:<path> recursive`), so an update that adds it asks for consent.
- **Streamable lifecycle.** Before SIGTERM the process gets `{"type":"stopping","reason":…}` (`restart` with `cause`,
  `updated`, `policy`, `removed`, `shutdown`) and has 200 ms; every automatic restart builds the environment again (a
  secret written meanwhile is seen); `actionResult` carries `arg` (the checked value, `null` without one).
- **Rendering keys.** `max=` on `chart=bars` and `sparkMax=` on the header sparkline fix the scale top (taller bars
  clipped; without them the scale follows the tallest bar or `avg=`); `until=<ISO-8601>` on the first header line is a
  live countdown the app runs in the tile and the page header; `font=mono` draws a line in a monospaced font.
- **Chart elements** for any plugin ([`writing-plugins.md` 4.4](docs/writing-plugins.md#44-charts)): `chart=bars` — a
  bar chart card (captions under and above the bars, a dashed average with bars above it tinted, a highlighted bar in
  the plugin color, a multi-line hover tooltip per bar, stacked series with a 2 pt minimum per visible layer, an optional
  legend, a segment or popup child in the title row); `chart=share` — one bar of shares with a legend; `bar=0…100` — a
  thin progress bar on a body line or, with `barColumn=`, in a table column; `spark=` on the first header line — a
  sparkline in the page header (which then shows the tile value large) and in the popover tile. The chart data keys
  (`values`, `labels`, `valueLabels`, `tips`, `series`, `spark`) may be up to 8000 characters instead of 2000.
- **Chart data over 8000 characters keeps the newest entries.** Entries are dropped from the start, the lists of one
  chart line (`values`, `labels`, `valueLabels`, `tips`, each `series` row) lose the same count so bars stay aligned, a
  numeric `highlight=` moves with them, `spark=` is trimmed on its own, and each trimmed key leaves a journal warning.
  Before, the keys were cut at the end, dropping the newest days silently.

- **An input action bound to a row: `inputPattern=`.** `<agenthub.action … arg="thread:^t[0-9]{1,9}$" input="Your reply"
  inputPattern="^[^<>]{1,500}$">`: the typed text is checked against `inputPattern`, and `arg=` becomes an ordinary row
  argument — the line carries `action=reply arg=t2`, the value goes to argv, the text still only to stdin; the
  confirmation, `offer.label` and `actionResult.arg` name the row's value. Without `inputPattern=` an input action works
  as before (re-review 65).
- **The confirmation names the pressed row.** The same button on rows with different titles was one offer, and every
  window quoted the first row ("delete the prod database?" confirmed as "harmless question"). Now each such row has its
  own offer; a child button that only repeats the action's title (banner buttons, `--Approve` under a request) is
  confirmed with its parent row's title. An offer on a single row keeps its id (re-review 64).
- **No dead link buttons.** `href=`/`effect="open.url …"` with a link `open.url` never opens (`message://`, `mailto:`,
  credentials in the URL) no longer renders a button that answers `409 facts:scheme`; the core drops it when it reads the
  frame and journals a warning. Primitives may export `checkOffer(args)` for such checks (re-review 71).
- **`writes=` on `<agenthub.connection type="mcp">`.** The tools of the allowlist that change something
  (`writes="create_task,update_task"`) are never served from the interval cache, as if every call carried
  `fresh: true`; a name not in `tools=` rejects the declaration. `GET /connections` and `/state` show `writes`
  (re-review 76).
- **`macOnly="true"` works again.** An `<agenthub.push>` rule with it (or `services.push.rules.<name>.macOnly`) goes to
  the Mac banner only, never to webhook, ntfy or service channels; held overnight, its item stays in the Mac digest and
  out of what the extra channels get. Community plugins may declare it. Before, it was parsed and ignored (re-review 70).
- **`>` inside a quoted attribute value** (`arg="text:^[^<>]{1,500}$"`) no longer ends the metadata tag; the action was
  dropped with a misleading "input= needs arg=" warning (re-review 72).
- **Contract feature `input-pattern`.** An index entry whose action declares `inputPattern=` lists the feature
  `input-pattern` in its `contract.features`, so a hub that doesn't know the attribute shows "Requires a newer hub"
  instead of installing an action it would read differently (`CONTRACT_FEATURES`, `daemon/lib/registry/perms.mjs`).

### Daemon

- **launchd bootstrap is retried.** `agenthub hub migrate --apply`, the hub update and `agenthub install --apply`
  boot the old daemon out and bootstrap the new one; a bootstrap in the moment launchd is still removing the job fails
  ("Bootstrap failed: 5: Input/output error") and left the hub with no daemon. Now it is retried for ~7 s
  (`bootstrapJob` in `daemon/lib/launchd.mjs`) and the last error is printed when it gives up.
- **Frame rate.** `plugin` SSE events are coalesced per plugin to at most one per 250 ms (`plugins.emitMinIntervalMs`),
  the latest state always delivered; the first change after a quiet period and the first frame after an action or a
  job's end go out at once.
- **Plugin secrets from the app.** `GET /secrets/:plugin` (declared keys with `set`/`unset`/`denied`, never values),
  `PUT /secrets/:plugin/:key {value}` (written via the stdin of `security -i`) and `DELETE …` — app only, only declared
  keys the plugin would receive. The cached value is dropped and the plugin restarts with
  `AGENTHUB_REFRESH_REASON=SecretChanged` through the new `ctx.restartPlugin(id, reason)`; SSE `secrets.changed`, journal
  `secret-set` (no values). The service part of a key may now be up to 64 characters (any plugin id; it was 32). The
  list never reads a value: a cached key answers from the cache, any other is an existence check (`security` without
  `-w`); at most 32 keys (`more` counts the rest); "why" follows the content language chain; a test-tier own plugin's
  own keys are not shown as denied.
- **Test tier.** `AGENTHUB_TEST_TIER=own` on a test hub (an `AGENTHUB_HOME` other than the live directory) gives
  `Plugins/local` plugins the own tier (`plugins[].testTier`) and lets cli press their actions — to test actions, push
  rules and secrets without the pinned app. Never on the live hub.
- **Daemon extensions outside the source tree.** `<home>/Extensions/{services,routes,primitives,terminals}/*.mjs` — the
  same modules as the built-in ones, kept in the state directory (they survive hub updates). Each file is code inside
  the daemon with its full rights, so it loads only after a human approved its sha256 in the app: `/state.extensions`
  (and `GET /extensions`) lists the files with `pending`/`changed`/`approved`/`revoked`/`error` and the consent text;
  the app-only `POST /extensions/approve {path, sha256}` records the approval in `Registry/ext-approvals.json` and loads
  it right away (two approvals at once load it once), `POST /extensions/revoke {path}` drops it (a module still loaded
  is `revoked` until the restart, not counted as waiting). One self-contained file, imported from a `data:` URL; names of
  built-ins are refused; files must be the user's and not group/world-writable; every decision is journaled
  (`extension-*`); SSE `extensions.changed`. `extensions.enabled: false` turns the folder off;
  `AGENTHUB_TEST_EXTENSIONS=1` auto-approves on a test hub only.
- **Push channels.** Delivery goes through a channel list: the macOS banner always, plus `services.push.channels` in
  `config.json` (`webhook` — POST JSON; `ntfy` — publish to a topic; `https://`, or `http://` only to this Mac; an
  optional `events` filter by kind or key prefix) and channels services register through the `push.channels` fact.
  Security banners (a re-pinned app build, tampering signals) go only to channels marked `security: true` — also when
  held overnight: the morning digest reaches other channels without them, and they follow as a separate `security`
  message. Channel URLs never reach the journal (`push-channel-error {channel, key, code}`); a bad channel (an ntfy
  topic with a broken `%` escape) is skipped on its own, not the whole push service.
- **Terminal adapters are found by a directory scan** (`order`, `autoLaunch` exports) and may come from
  `Extensions/terminals`; an adapter can ship its own ru/en error texts (`messages`) and say "needs setup"
  (`available()` → `{error, setup: true}`): `/state.terminals.adapters[]` gains `reasonText`, `needsSetup`, `messages`,
  `source`.
- **A streamable process that doesn't read stdin** no longer grows the daemon's memory: past 1 MB waiting in the pipe its
  messages are dropped until it reads again (`stdin-backlog` in the journal, once a minute).
- **Index entries gated by feature.** An entry whose plugin uses an attribute added after hub 0.1.2 (`background`,
  `input`, `net="none"`, community actions, `subscribe`, `type="http"`, recursive watch) writes `contract` as
  `{"version": 3, "features": [...]}`; hub 0.1.2 reads any non-integer `contract` as "Requires a newer hub" (instead of
  `registry:archive-permissions` or a silently broken install), and this hub checks each feature it knows
  (`needsHub.features` lists unknown ones). The registry's `build-index` adopts it after syncing `perms.mjs`
  ([`plugins-registry.md`](docs/plugins-registry.md#contract-3-additions-after-hub-012-2026-11-12-gating-index-entries)).
- **Several plugin registries.** `services.plugins.registries: [{name, indexUrl, publicKey, trust: official|community}]`
  after the old scalar pair (still the registry `default`, trust official). Each registry has its own key, files
  (`Registry/sources/<name>/`) and rollback protection; a community registry never makes a plugin official; the same id
  in two registries — the earlier one wins in the catalog (`shadowed`, journal `registry-shadowed`), and an installed
  plugin stays pinned to its registry (`plugins.lock` `registry`); a registry's blocklist covers its own plugins, an
  official registry's — all. The catalog, installed list, updates, the consent window and `/state.plugins[]` carry
  `registry`, `registryLabel` (null with only `default`) and `tierLabel` ("official plugin · corp"); a running plugin
  picks up a new label without a restart.

- **No phantom jobs after a plugin update.** The jobs of a removed or updated plugin instance are no longer listed for the
  new instance: its first `{"type":"jobs"}` and `/state.plugins[].jobs` leave them out (the new process never got their
  `jobExit` and showed them running forever). They are still stopped and journaled (re-review 67).
- **watch fires under constant writes.** The 300 ms debounce now has a 2 s maximum wait: a log written every 100 ms gives
  a run at least every 2 s instead of none until the writes stop (re-review 68).
- **Distinguishable job titles.** A job's title carries its `arg=` value ("Start dev server web"); a second running job
  with the same title gets its start time ("Long (14:05:31)") (re-review 73).
- **`job.cancel` from cli on a test hub.** With `AGENTHUB_TEST_TIER=own` a script may stop a test-tier plugin's job
  (`POST /actions/job.cancel`); jobs of other plugins stay app-only. Primitives may export `pluginOf(args, facts)` to
  take part in this exception (re-review 75).
- **Actions never read a connection from the cache.** A call to `/connections/:id/mcp|http` from an action process or a
  background job (a human pressed the button) is served fresh, like `fresh: true`; a second identical write no longer
  comes back as `ok: true, fresh: false` without reaching the service (re-review 76).
- **Push channels in `/state`.** `notifications.channels` lists where notifications go — `mac` first, then the
  config.json and service channels: `id`, `type`, `label`, `security`, `events`, never a URL or token (re-review 70).
- **Linter `*.key`.** The source check matches file paths only (a last word with `/`, `\`, `~`, `*`, or a single-dot
  name); an SF Symbol such as `sfimage=person.badge.key` no longer fails the registry CI or an own-folder install
  (re-review 69). The registry's vendored `scripts/vendor/perms.mjs` is the same file.
- **Stable ids for one button on several rows.** The per-row offer id of re-review 64 included the row text, so a live
  header text or a second copy appearing changed it and an open confirmation or banner button got `404`. The first row
  text keeps the base id, further ones get ids by order (review 3).
- **Background jobs read connections from the cache.** Only a foreground action process forces fresh calls — on `/http`
  now even with an explicit `"fresh": false`, like `/mcp`; a job passes `fresh: true` itself when it needs it. Replaces
  the job part of re-review 76 (review 3).
- **Job limit after an update.** Jobs of the old instance that are being killed no longer count toward the new
  instance's `maxJobsPerPlugin` (`409 facts:jobs-limit` with an empty job list) (review 3).
- **The "notifications muted" notice of a `macOnly` rule stays on the Mac** (review 3).

### App

- **Session buttons are labelled.** "Interrupt" (orange, a raised hand) and "End" (red) are capsules with text instead of a
  bare hand icon and a small red dot; the button column has one width in every row, so effort badges stay aligned.
- **Remote Control switch in "New session".** It used to be a disabled switch that always read "on"; now it works: off
  launches the session without `--remote-control` (`session.launch` argument `remote`, a 0600 `<uuid>.local` marker next
  to the prompt file that `launch.sh` reads and deletes). On by default, as before.
- **Typed input.** An immediate action with `input` draws a text field and a send button in place of its capsule on the
  plugin page; at a confirm level (and wherever there is no room for a field — table rows, the popover, banner
  buttons) the field is in the confirmation (the 428 `input` flow: the token is reused when the core refuses the text
  with `400 input:*`, and the confirmation reopens with the reason). One line, no leading `-` and `maxLength` are checked
  as you type; `input:*` refusals read in ru/en. Input offers are app only, so an unpinned copy disables them.
- **The confirmation names the row** (`row` from the 428) unless the core's text already quotes it.
- **Running in the background.** The plugin page lists `plugins[].jobs` with the elapsed time and "Stop"
  (`job.cancel`); `job.started`/`job.exited` update the list between frames; a button that starts a job has an
  hourglass mark.
- **Popover buttons.** The expanded tile card shows up to three offers of the plugin's header as buttons — the same
  gate, confirmation and spinner as on the page (tiles keep their fixed height). `--open-tile <plugin id>` starts the
  popover with that tile expanded (snapshots).
- **Banner buttons.** `push.notify` `actions` become notification buttons (a category per button set, registered before
  the banner; a button that asks first brings the app forward for the confirmation); a click on the banner opens `href`
  when given, otherwise the plugin page. Without the fields — the plain "Open" banner as before.
- **Keys.** The plugin page has a "Keys" section for the keys a plugin declares (`GET /secrets/:plugin`): state, "Set
  key…" (a secure field with the value rules checked as you type) and "Remove" (asks first); re-read on
  `secrets.changed`.
- **Rendering.** `max=`, `sparkMax=`, `until=` (a live countdown in the tile and the page header) and `font=mono`; the
  plugin page shows every connection the plugin declares, not just the first. The chart elements are drawn in
  `app/Sources/AgentHub/PluginCharts.swift`, with parsing and layer arithmetic in AgentHubKit (`PluginBarChart`,
  `PluginShareChart`, `Item.bar`/`spark`).
- **Other agents.** Sessions shows `externalSessions` as a separate "Other agents" group with only "Go to tab"
  (`session.focus`); they are not counted with Claude sessions. The permission kind `subscribe` reads "Event
  subscription".
- **Community plugins.** The manager and Settings → Notifications say they run their own commands (each asks first) and
  notify under their own switch (at most 5 a minute, quiet hours → the morning digest).
- **Hub extensions.** Plugins shows "Hub extensions" (`/state.extensions`, `extensions.changed`): each file with its
  kind and state, a "waiting" badge (also on "Plugins" in the sidebar), "Review…" — a sheet with the core's consent text
  verbatim, the kind, name, file, size and full SHA-256, "Show in Finder" and "Approve these bytes" (no Return shortcut;
  `409 extensions:changed` says to look again) — "Revoke" with a confirmation, and the "restart required" note. Never
  from the popover.
- **Terminal adapters** in Settings → Terminal show the adapter's own `reasonText` (a setup hint when `needsSetup`) and
  mark adapters from `Extensions/terminals`.
- **Several registries.** When more than one registry is configured (`registryLabel` non-null), the tier label in the
  manager, the catalog cards and the install consent sheet names the registry ("official · corp"), and the catalog shows
  one status line per registry (its error or when it was fetched) plus the ids hidden as duplicates. With only the
  default registry everything looks as before.
- **HTTP connections.** A `type="http"` connection says which hosts, methods and paths the hub calls instead of the MCP
  tools line; `409 oauth:port-busy` reads in ru/en.
- **Charts.** The average line stays on the plot, its caption ("avg $330") moved under the chart next to a dashed
  sample of the line: on the plot it covered the bars' value captions.
- **Segmented controls.** An option declined in the confirmation ("No"), refused or failed lights the real selection
  again at once; it used to stay lit for another 1.5 s waiting for a page that never brings it.
- **Notification channels in Settings.** Settings → Notifications says "macOS banners and N more channels" and lists
  each channel that takes notifications off the Mac (name, webhook/ntfy/hub service, its filter, whether it gets
  security exceptions), with a note on `services.push.channels` and `macOnly` (re-review 70).
- **`font=mono` everywhere it is promised.** Table rows (the title and its cells, a bar cell's text, gray notes in the
  row), buttons and text links now use the monospaced font too (re-review 74).
- **Tests don't depend on the macOS language.** Each test case runs with its own language (`.hubLang` trait, a
  task-local `L10n.$scope`), so the suite passes on an English system and parallel suites can't switch each other's
  language (re-review 62).
- **`font=mono` on cards too.** Number, bar and strip cards (and strip cells), chart titles and `chart=share` legend
  rows, `bar=` lines, table `group=true` headings and the popover's expanded tile card now draw a `font=mono` title
  monospaced as well, so it holds everywhere `writing-plugins.md` promises (review 3).
- **"Catalog not connected" names the built-in plugins from the state** (their own titles) instead of a fixed list in
  the shell, so it stays right after the rename and with Spend (review 3).
- **Tests: the language setting is scoped too.** `L10n.shared.setting` and `settingKnown` live in the test case's
  `LangScope` like the language, so parallel suites can't race on them; `PluginChartsTests` carries the `.hubLang`
  trait like every other suite (review 3).

### Built-in plugins

- **Names.** The plugins about Claude Code carry its name: Claude Code Sessions, Claude Code Background Agents, Claude
  Code Quota, Claude Code Spend (ru: «Claude Code Сессии», «… Фоновые агенты», «… Квота», «… Расход»). Plugin ids stay,
  so settings, data and notification switches carry over; the popover tiles keep short captions (`tileLabel`).
- **New: Spend (`spend`)** — a journal of Claude Code token spend ([`plugins/spend`](plugins/spend/README.md)), built on
  the chart elements: a header with today's cost large, its tokens and requests, yesterday's total and a 14-day
  sparkline with the average; cards for yesterday (flagged when it is over 1.5× the average), the last 7 days and this
  month; "By day" cost bars for 14 or 30 days (a switch on the page) with the average and a tooltip per day; "Tokens by
  day" stacked by cache read, cache write and output with a per-day breakdown in the tooltip, and a table of the token
  types with their share of the cost; where the 7-day cost goes (background Workflow runs, the sessions themselves,
  subagents); models over 7 days with bars. Numbers are short ("$3.0k", "1.75B").
  - Read-only, from the transcripts in `~/.claude/projects` (main sessions, subagents, Workflow agents): only usage
    numbers, model, time and request id are taken; message text never reaches the output or the index. Requests are
    deduplicated across lines and files; days are local.
  - Incremental indexing in `PluginData/spend/index.json`: files older than the month start and 30 days are not opened,
    the first run shows progress, later runs read only appended bytes.
  - The cost is an API list price equivalent with a price table and an as-of date inside the plugin — not a bill.
    Unknown models are counted in tokens only.
  - An optional notification when today's cost passes a threshold picked on the page (`daily-over`, its own switch).
  - The plugin uses the generic contract only (two actions, the chart elements, a table, a popup); no effects.
- **Quota 0.5.2: push labels without the plugin name.** «Неделя ≥ 80%» / "Week ≥ 80%" and «Не обновляется: нужен вход в
  Claude» / "Not updating: sign in to Claude": with the new title the banner read "Claude Code Quota · Quota: week ≥ 80%"
  (review 3).
- **The "broken" frames keep the tile caption.** When Background Agents (1.2.2), Spend (0.2.2) or Sessions (0.5.2)
  can't render, the frame still carries `tileLabel`, so the popover tile keeps its short name instead of the long title
  (review 3).

### Docs

- **Contract 3 is frozen** ([`extension-points.md`](docs/extension-points.md#contract-versions)): nothing in it changes
  meaning or goes away; only optional items an older hub ignores may join it, and each registry contract feature is
  named there (`daemon/test/contract-freeze.test.mjs` checks both). Removals wait for contract 4.
- [`writing-plugins.md`](docs/writing-plugins.md) now covers the process lifecycle (process groups killed when a run or
  action ends, background jobs, restarts of a streamable process, the `stopping` message), the frame cost and the
  ≤ 4/s coalescing, secret cache timings (5 min found, 1 min missing) and key limits, chart autoscale vs `max=`, the
  banner click target and buttons, `effect=` arguments with spaces (nested quotes), foreign text in titles with the
  `escapeTitle`/`quoteValue` helpers, the test tiers (`AGENTHUB_TEST_TIER`, `AGENTHUB_TEST_EXTENSIONS`) and which hub
  APIs a plugin process may call.
- Corrected: contract examples declare 3; "trusted" lists include `own` everywhere; the menu bar icon reacts only to
  `block`/`error` of plugins (its orange "waiting" counts sessions and question cards, not `status=wait`);
  `session.focus` reaches other agents' sessions by pid except in cmux; the README no longer presents the demo plugins
  of the screenshots as part of the repository.
- [`plugins-registry.md`](docs/plugins-registry.md): reviewer rules for foreign text in output, community actions and
  push rules, `net="none"`, `background="true"`, `input=`, `<agenthub.subscribe>` and the hub socket.
- Re-review corrections: header buttons in the popover's expanded tile card (up to three) and how a run interval
  drifts (it counts from the end of the previous run; `<agenthub.schedule>` for clock times) are documented; an agent
  session in cmux has no switch (neither `session.focus` nor `terminal.focus`); input actions take the test-hub CLI
  exception too; §9.1 says what the CLI class may press on the live hub versus a test hub; extension terminal adapters
  ignore `order` and get no `ctx`, only `facts`. The linter now says a community `immediate` action with network or
  `cost=` is raised to `confirm-cost`, not `confirm`, and the action confirmation text puts a period after the command.
- Review 3 corrections: "Input actions" in [`extension-points.md`](docs/extension-points.md) describes both forms
  (with and without `inputPattern=`, which also joins the "other additions within contract 3" list); community push
  rules take `macOnly="true"` as well as the label (writing-plugins, api, extension-points, plugins-registry, the push
  README); the `avg=` caption sits under the chart beside a dashed sample, default «среднее» / "average".

## 0.1.2 — 2026-11-11

### Terminal layer: cmux is one terminal among several (AH-33)

- The core no longer builds terminal work on cmux. Everything the hub does with a session's tab — switch to it, read the
  end of the screen, type a line, press Esc, open a new tab with a session — goes through built-in terminal adapters
  (`daemon/lib/terminals/<id>.mjs`, a separate kind of extension, not a plugin), each declaring what it supports:
  **cmux** (all five, through the bridge — now the adapter's internal detail; behaviour unchanged), **tmux** (all five,
  through the server's own tmux binary: pane by tty, `send-keys -l` with the same input-field checks as the bridge),
  **iTerm2** and **Terminal.app** (switch to the tab and open a new tab, through `osascript` with values in argv; no
  screen reading, typing or Esc — their AppleScript cannot check the input field safely).
- The session's terminal is detected from the process table (the nearest terminal among the ancestors of the Claude Code
  process; cmux — from its own session file); the process environment is not read. `/state.sessions[].terminalInfo`
  `{adapter, label, capabilities, focusable, via}` and `/state.terminals` (adapters, availability, session counts, where
  new sessions open) are new; `terminal` (a string) and `focusable` stay as in contract 3.
- `terminal.focus` — the generic name of `cmux.focus`; `cmux.focus` stays an accepted, deprecated alias until the next
  contract (`/state.primitives[].aliasOf`, a registry linter warning; either name satisfies `<agenthub.effects>`).
- Capability gaps are refused clearly: `409 terminal:unsupported {terminal, capability}` on `/terminal/*`,
  `facts:esc-unsupported`, `facts:launch-unsupported`, `facts:no-launch-terminal` on primitives. `session.interrupt` and
  `session.launch` work in any terminal that supports them; `services.terminal.launch` picks the launch terminal (`auto`
  by default: the terminal most sessions run in, otherwise the first installed of cmux, iTerm2, Terminal).
- A test hub never runs a real terminal tool (`terminal-test-mode`); tests use command doubles.
- Shell: a **Terminal** card in Settings (each terminal with its capabilities, session count and state; the cmux bridge
  status and start command moved under the cmux row; where new sessions open). Session rows show the terminal, and
  "Go to tab" / Esc are disabled with a tooltip naming the terminal when it can't; the bridge banner appears only for
  sessions in cmux. Texts say "terminal tab" instead of "cmux tab".

### Notifications: macOS banners only (the chat-bot channel is removed)

- The Telegram channel is gone from the hub: the bot module and its manual check (`daemon/lib/push/telegram.mjs`,
  `send-test.mjs`), the `services.push.telegram.*` settings, the `agent-hub.telegram` entry in `agenthub uninstall`'s
  keychain list, the `telegram` flag in `/state.notifications`, and the Settings line "Telegram is off
  (config.json)". An existing bot entry in the keychain is not touched; delete it yourself if you set one up. The
  `telegram` secrets service stays reserved, so no plugin can read a leftover bot token.
- Old keys in `config.json` are ignored without errors: any key of `services.push` the service doesn't know gives one
  `push-config-ignored {keys}` journal line at startup.
- What quiet hours do now: while you are away from the Mac (no keyboard or mouse for `idleThresholdMs`, 10 min), banners
  are held and arrive as one digest banner ("Overnight: N") when quiet hours end; urgent ones (`quietException`: pin and
  build path changes, a moved release tag, an update stopped for tampering, a failed hub update, a plugin's
  `quiet="true"`) show right away. At the Mac, banners show as usual. A waiting session's banner (`awayDelayMs`, a
  plugin's `away=`) shows at once at the Mac; while you are away it waits until you are back or the delay has passed.
- `macOnly` (plugin tag and `services.push.rules` field) no longer means anything and is ignored; plugins that declare
  it still parse cleanly. Update notices (`plugin-update`, `hub-update`, `hub-update-ready`) used to skip the digest
  because they were "macOS only"; now they wait for it like other non-urgent banners.
- Settings → Notifications: the "how" line says "macOS banners" and when you count as away; the quiet hours
  explanation describes the digest.

### Own plugins

- An own plugin updated from its folder automatically (same permissions, no consent window) now shows a banner "Plugin
  updated — "<title>" updated to <version>" (or "updated from its folder (version …)" when the version stayed), key
  `@hub:plugin-own-updated:<id>:<version>`, kind `updates`: the "Hub and plugin updates" switch turns it off. The
  journal record `plugin-own-updated` is unchanged.
- A plugin folder writable by your group (umask 002) is no longer refused: the request and the consent window carry
  `risk: "group-writable"`, the CLI prints a `!!! WARNING` line under "Request created", the app shows a red risk line
  in the consent window (`chmod -R g-w <folder>` fixes it), and the journal gets `risk` in `plugin-own-requested` and a
  `plugin-own-risk` line on every install from such a folder, automatic updates included. A world-writable folder, a
  foreign owner or a foreign ACL is still a refusal.

### Registry: official means "in the signed catalog right now"

- An installed official plugin that a newer verified index no longer lists (or lists as community) runs as community
  from the next policy check — as before — and now the transition is journaled once: `plugin-tier-lowered {reason:
  "not-in-catalog"|"community"|"archive"}`, and `plugin-tier-restored` if it comes back. `Registry/tiers.json` keeps the
  mark across restarts. The UI shows only the tier it has now.
- A catalog pair on disk that fails verification (half-written by another process, damaged) no longer drops the
  verified catalog already in memory, so official plugins are not demoted by a transient read; download and signature
  failures already kept the last verified catalog.

### Docs

- `open.file`: a folder with a dot in its name (`site.com`, `notes.d`) is treated as a package and only revealed in
  Finder — kept on purpose (decision 2026-11-11), now stated in `api.md`, `extension-points.md` and `writing-plugins.md`.

## 0.1.1 — 2026-11-10

### Plugin page controls

- Four new kinds of body lines on the plugin page, optional within contract 3 (a hub 0.1.0 draws their children as
  plain lines and buttons): `segment=true` — a segmented control from the children (`selected=true` is the current
  one), falling back to a popup button when it does not fit; `select=true` — a popup button with a menu of the children
  (`note=` dimmed); `toggle=on|off` — a switch that runs the line's own offer; `table=true columns="A¦B"` — ~34 pt rows
  with `cells=`, `cellColors=`, a state dot, buttons and icon-only buttons (`icon=true`) from row children, gray notes,
  collapsible `group=true` subheadings (remembered while the app runs) and `header=true` buttons by the table title.
  Consecutive segment/select/toggle lines share a label column. Every clickable part uses the usual offer gate,
  confirmation and busy spinner ([`docs/writing-plugins.md`](docs/writing-plugins.md#43-controls)).

## 0.1.0 — 2026-11-10

The first public release, under the [MIT license](LICENSE). It covers all the work below, grouped by date.

### 2026-11-10 — Panel styling for plugin lines

- New optional line params (contract 3, older hubs ignore them): `link=true` draws an offer line (`effect=`/`href=`/
  `action=`) as a text link instead of a capsule, with the same gate and confirmation; `iconColor=` colors only the
  `sfimage` icon; `badgeColor=` tints the badge. `color=` now also colors the title of nested lines.

### 2026-11-10 — Install with Homebrew

- **`brew install KenseiTheOne/tap/agent-hub` + `agenthub setup`**: the formula (tap `KenseiTheOne/homebrew-tap`)
  installs the release source tree into `libexec` and the `agenthub` command, depends on Homebrew's `node` and builds
  nothing itself; `agenthub setup` (= `agenthub hub install --brew --apply`) builds the hub from that tree with the same
  builder as updates (source kind `brew`: the tree is copied without `.git` and old build products), pins the build,
  copies the built-in plugins, adds the launchd job and starts the hub. It checks the Command Line Tools first.
- **A Homebrew-managed hub follows Homebrew, not git tags**: `config.json → services.hubUpdate.brew` records the source
  (`<prefix>/opt/agent-hub/libexec`, read fresh by the daemon); the update check reads `VERSION` (and the formula's
  `COMMIT`) from there with no network, and a newer version gets the usual "Update" button — build, trial run,
  rollback. `/state.hubUpdate` gains `source: "git" | "brew"` and `brew`; error `hub-update:brew-missing` when the formula
  is gone.
- Shell and CLI texts (ru/en): "updates come from Homebrew: brew upgrade agent-hub", "copying sources from Homebrew…",
  the confirmation window and "Details" name Homebrew; `agenthub hub status`, `agenthub version` ("Homebrew package")
  and `agenthub uninstall` (which clears the brew source and reminds to run `brew uninstall agent-hub`) know about it.
  `scripts/install.sh` keeps working; installing from git switches a brew-managed hub back to git tags.

### 2026-11-10 — Plugin contract 3: Claude sessions and the terminal for plugins

- **Live Claude Code session metadata for plugins**: `Cache/claude-sessions.json` (0600, no conversation text) and the
  `AGENTHUB_CLAUDE_SESSIONS_FILE` variable for trusted plugins — model, `modelId`, effort and where they came from (the
  last turn or a `/model` / `/effort` command), ultracode, tab, `verified`.
- **Pause flag**: `AGENTHUB_PAUSED=0|1` in every plugin run; setting and lifting the hub pause restart plugins
  (`AGENTHUB_REFRESH_REASON=Paused|Resumed`).
- **Terminal for plugins** behind the `<agenthub.terminal>` permission: "read the screen" (input field flags only) and
  "type into the tab" of a Claude Code session through a terminal adapter layer (cmux first, via the bridge); slash
  commands from a declared list, `send *` without Claude Code mode characters, a separate `send !` permission for lines
  starting with `!`, `#`, `&`; only verified, idle, foreground sessions, not while paused, rate-limited and audited.
- **`session.focus <sessionId>`**: switching to a session's tab without knowing the terminal; the shell's "Go to" buttons
  use it, `cmux.focus` is kept for compatibility.
- **Loud consent** for writes to hijack locations (Claude Code settings, autostart, shell startup files, PATH, SSH,
  git, the hub directory) and for typing into tabs; the registry linter warns the reviewer.
- Built-in `claude-sessions` 0.5.0 reads the model and the `/model`, `/effort` commands from the transcript tail.
- Shell: AppKit tooltips with the full text, shown right away and only for truncated text.
- **Everything the hub shows is in the hub language** (Russian or English): daemon errors and warnings (journal
  `detail`, API error details, linter and parser warnings, hub-update details, build and watchdog logs) and the CLI
  output, from one message table (`daemon/lib/i18n.mjs` + `daemon/lib/messages/`). Codes and journal types are unchanged.

### 2026-11-10 — Plugin contract 2: the core knows no plugins; Windows findings

- **Everything plugin-specific is declared by the plugin**, and the hub builds the UI from the declarations:
  `<agenthub.contract>` with a clear "requires a newer hub" refusal, `<agenthub.icon>`, `<agenthub.connection>` (MCP
  address, scope, tool allowlist, interval and budget; the host must be in the plugin's `net`; a new connection is a
  permission increase), `message=` texts for action refusals.
- **Notifications**: only shared kinds in the core plus a per-plugin toggle; the old `runs` / `night` kinds are carried
  over from `settings.json` without losing the user's choice and survive a hub rollback.
- Built-in plugins declare their own push rules and icons (`agents` 1.2.0, `claude-sessions` 0.4.0, `quota` 0.5.0).
- **Fixes from a Windows check of the daemon** (the rest is groundwork in [`docs/windows.md`](docs/windows.md)):
  `osVars()` returned `null` without OS commands and broke plugin runs on Linux; `open.file` opens only known document
  types (packages, Finder aliases and files with an assigned app can only be revealed in Finder), re-checked before
  running; `isAbsolutePath` instead of `startsWith("/")`, JSON with a BOM, `samePath`, a clear error for a corrupted
  `config.json`, portable tests with skip reasons.

### 2026-11-09 — App/daemon lifecycle, hub auto-update, "can I shut down", own plugins

- **Lifecycle**: quitting the app stops the daemon (`POST /shutdown`); if the app crashes while the daemon is alive, the
  daemon relaunches it (up to 3 times in 10 min); "Launch at login" controls the pair; launchd `KeepAlive` only on
  failure.
- **Hub auto-update**: versions by `vX.Y.Z` tags on `origin/main`, installed into `Versions/<version>` with
  `current` / `previous`, a trial run with a watchdog and rollback, an "Update" button with notes from the tag message;
  a one-file installer (`scripts/install.sh`), `hub migrate` and `uninstall`. See [`docs/hub-updates.md`](docs/hub-updates.md).
- **"Can I shut down"**: `/state.idle` with the `quiet` / `quiet-needs-on` / `busy` verdict, a popover card and new
  menu bar icon states; sessions waiting for an answer do not block shutdown.
- **Sidebar**: wider, status in words with a severity dot, the full line in a tooltip.
- **Notifications settings**: a master switch, kinds and quiet hours; security notifications cannot be muted.
- **Connections**: signing into an external service through its site (official MCP server, OAuth 2.1 + PKCE, tokens in
  the keychain).
- **Own plugin sources**: installing a plugin from a local folder via a request and a consent window in the pinned app,
  the `own` tier, automatic updates when permissions stay the same, migration from the catalog and back; "Requires …"
  in the catalog from plugin metadata. See [`docs/plugins-registry.md`](docs/plugins-registry.md#own-sources-2026-11-09).
- `quota` 0.4.2: the header always shows the current week and its reset.
- Project rules: the hub and plugins are developed separately; the core knows no plugin names.

### 2026-11-06 — Plugin update checks, event-driven quota, review fixes

- **Background plugin update checks** against the signed catalog: every 6 h, a badge on "Plugins", an "Update" line in
  the popover, one notification per version, a switch in Settings; an installed official plugin is not demoted when a
  new version is released.
- `quota.5m`: refreshes when the quota service writes its cache (`watch`); a text for `keychain-unavailable`.
- 63 findings of a large review of the core, the shell and the built-in plugins fixed: linear output parsing, push
  limits, untrusted plugins cannot impersonate sessions, hook events while paused, an audit journal, re-pinning in the
  shell, notification routing, broken-off sessions in "Sessions", the read budget of `agents`, and more.

### 2026-11-05 — Pinning by cdhash, plugin catalog, languages, quota service

- **App pinning by build fingerprint (cdhash)** instead of a mandatory certificate: `bundle.sh` signs ad hoc and records
  the requirement via `agenthub pin-app`; every change goes to the journal and a banner.
- **Plugin tiers** `builtin` / `official` / `community` / `local`; third-party tool integrations moved out of the core
  into the registry. Built-in plugins run from a copy in `<home>/Builtin` (`agenthub builtin [update]`).
- **Plugin manager**: a catalog from a signed index, installation with consent, removal and updates.
- **Russian and English** with a switch in the app; the language is passed to plugins (`AGENTHUB_LANG`).
- **A quota service in the core** (`usage`): the Claude Code token never leaves the service, plugins get only the cache.
- Sessions: effort and ultracode from the last turn; the cmux bridge in `/state`, "Go to" buttons disabled without the
  bridge, with the start command shown.
- Shell: traffic lights inside the sidebar card, one corner radius; the popover closes when windows open; a right-click
  menu on the icon (Panel, Pause hub, Quit); "ESTOP" renamed to "Pause hub".
- New app icon and menu bar icon with a "waiting" emblem.

### 2026-11-05 — First version

- **Daemon `agenthubd`** (Node ESM) on a Unix socket: a SwiftBar-style plugin contract without `bash=`, peer
  verification by process and code signature, action confirmations decided by the core, ESTOP, a metadata-only
  journal, push notifications, secrets from the Keychain.
- **Shell**: a SwiftUI menu bar app following the approved prototype.
- **Hook** for answering Claude Code sessions from the hub and the **cmux bridge**.
- **Built-in plugins**: `claude-sessions`, `agents`, `quota`.
