# codex-quota

Built-in Agent Hub plugin (`streamable`, file `codex-quota.mjs`, 0.1.0, contract 3): the Codex (ChatGPT plan) limits —
the 5-hour window and the week — presented like `quota`. The plugin never touches the token: it never reads
`~/.codex/auth.json` and never calls chatgpt.com. Codex itself makes the network call.

**Live source.** The plugin starts `codex app-server` (stdio, newline-delimited JSON-RPC): `initialize` (clientInfo
`agent_hub`), the `initialized` notification, `account/rateLimits/read` (`excludeResetCreditDetails: true`), then closes
stdin (the server exits on EOF); a server still alive a second later gets SIGTERM, then SIGKILL. Timeout 20 s. The child
gets the plugin's environment without the hub's `AGENTHUB_*` variables and with
`CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1` (the short-lived server doesn't connect to remote control).

**How often.** Each start makes Codex refresh its own caches and databases under `~/.codex` (models, plugins, the state
database), so calls are rare (`callDue`): at most every 15 minutes; after 5 minutes when a session file (the newest
rollout by mtime) changed since the last call; after "API key", "not signed in" or "codex not found" only once an hour.
A manual refresh asks after 1 minute in any state. Between calls the card shows the cached answer and the last reason. This doesn't start Codex's shared background server and doesn't
write `config.toml` (checked on a real machine: the config checksum is the same before and after, no
`~/.codex/app-server-control`). The last live answer and the call time are kept in `PluginData/limits.json` (0600).
`codex` is looked up in `PATH`, then `/Applications/Codex.app/Contents/Resources/codex`.

**Windows by length.** `rateLimits.primary/secondary` (and the buckets in `rateLimitsByLimitId`) are mapped by
`windowDurationMins` / `window_minutes`, not by position: 300 → the 5-hour card, 10080 → the week; other lengths get
their own label; a narrower bucket is a scoped card. (Older Codex files had the week in `primary` and no `secondary`.)

**Fallback.** When the call fails (timeout, error, crash) or there is no live answer yet, the newest
`event_msg`/`token_count` with `rate_limits` from the 12 most recently modified rollouts of the newest 31 day folders
(`~/.codex/sessions/*/*/*/rollout-*.jsonl` — a long session stays in the folder of the day it started; last 512 KB of each; only lines containing `token_count` and `rate_limits` are parsed, only the snapshot and timestamp
are kept) — marked "from session files, N min ago". `codex exec --ephemeral` writes no rollout, so this can be old.
Older than an hour → stale: `status=unknown`, "not updating: … · data from …".

**Quiet states.** No `codex` and no `~/.codex` — "Codex isn't installed", nothing is spawned. `codex` without
`~/.codex` — "Not signed in to Codex", nothing is spawned. Not signed in (`…authentication required…`) — "Not signed in
to Codex — no quota" with `codex login`. An API key (`chatgpt authentication required…`) — "a key has no subscription
limits". Paused hub — no call, cached numbers. An answer of an unknown shape — `status=unknown` + `event=source-broken`.

**Header, events, status** — as in `quota`: "Week 64% · resets fri 27.11 02:00"; `week-80` and `pace-85` (once per
quota week: the key carries the week's reset date, UTC), kind `problems`; any main window ≥ 100% or Codex's
`rateLimitReachedType` — `status=block`.

Tests: `daemon/test/plugins-codex-quota.test.mjs` with a fake `codex` (`daemon/test/fixtures/codex/fake-codex.mjs`:
modes ok, nologin, apikey, hang, bad, crash). Fixture: `fixtures/rate-limits.json` (synthetic).
For tests: `AGENTHUB_TEST_BIN_DIR`, `AGENTHUB_TEST_NOW`, `AGENTHUB_CODEX_REFRESH_MS`, `AGENTHUB_CODEX_RPC_TIMEOUT_MS`.
