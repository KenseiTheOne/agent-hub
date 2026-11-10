# agents — Workflow runs

Built-in Agent Hub plugin (`official`). Streamable: polls every 3 s, a full search for runs every 15 s
and on `refresh`. Read-only.

**Sources** (`~/.claude/projects/<project>/<session>/`):

- `subagents/workflows/wf_*/journal.jsonl` — tail read by offset; only `type`
  (`started|result|failed`), `agentId`, `phase` are taken. The `result` text and `label` are not used.
- `subagents/workflows/wf_*/agent-*.jsonl` — tail read by offset; from `assistant` lines only
  `message.usage`, `requestId`, `message.id` are taken. Message text is neither printed nor stored.
- `workflows/wf_*.json` — the result: `status`, `workflowName`, `durationMs`, `startTime`, `agentCount`, `phases[].title`.
  While a run is in progress this file does not exist; the name is taken from `workflows/scripts/<name>-<runId>.js`.
- `~/.claude/sessions/<pid>.json` (never `*.key`) — whether the session that started the run is alive: `kill -0`
  (signal 0) and the start time `TZ=UTC ps -o lstart -p` against `procStart` from the file (a whole number of hours
  of difference is the same second in another time zone). A mismatch means another process took the pid after the
  session crashed; the session is considered closed. On Windows and when `ps` fails — signal 0 only.

**Spend** = Σ over unique requests (`requestId`, otherwise `message.id`) of `input_tokens +
cache_creation_input_tokens + cache_read_input_tokens`; one request repeats in the transcript as a line for every
response block — it is counted once (maximum per field). `totalTokens` from `wf_*.json` is the sum of the agents'
final contexts, not spend; it is not used. `output_tokens` in transcripts are partial — output is shown
as "at least". Verified on 2026-11-04 against a live running run and a finished one with an independent count by
`message.id`: exact to the token. The read budget is 32 MB per tick across all files; when it runs out (including
mid-line) the run is finished reading in later ticks and is not considered fully read until then: a finished run
enters the cache only with complete numbers.

**States and events:** running (the session is alive or records are younger than 2 min); `wf-orphaned-<runId>` — no
result, no session, quiet > 5 min; `wf-failed-<runId>` — result `killed`/`failed` (for `killed` the header says
"stopped" and the tile "N stop": the sidebar badge holds 6 characters; the run was stopped via `/workflows`; the
`wait` status label is shared: "Run needs attention"); `source-broken` — a broken `wf_*.json` (details are in the hub
language: "not JSON", "no status").
The plugin declares the push rules for `wf-failed` and `wf-orphaned` itself (`<agenthub.push … kind="plugin" was="runs">`,
since 1.2.0, contract 2): in "Settings → Notifications" this is its own "Background agents" toggle; "Agent runs" that
were turned off before 2026-11-09 carry over to it. Icon: `<agenthub.icon symbol="square.stack.3d.up" color="#BF5AF2">`.
Finished runs stay visible for 12 h; their results (numbers, no text) are cached in `AGENTHUB_PLUGIN_CACHE_PATH/runs.json`.

**"Can I shut down":** the first header line carries `activity=` for the hub verdict (`/state.idle`): one run in
progress — "Run "m81-gold" running, 12 min" (time since the run started: the result, otherwise the creation of the run
folder), several — "2 runs running: a, b"; none running — `activity=""` (participates, quiet).

A workflow cannot be stopped from outside — the plugin says so ("/workflows in the session tab") and offers
`cmux.focus` to the session tab: `surfaceId`/`workspaceId` come from `~/.cmuxterm/claude-hook-sessions.json`
(identifiers only; `lastBody`, `lastSubtitle`, `launchCommand` are not read). The core verifies the tab.

Tests: `cd daemon && env -u NODE_OPTIONS node --test test/plugin-agents.test.mjs`.
