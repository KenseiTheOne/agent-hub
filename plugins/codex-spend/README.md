# codex-spend

Built-in Agent Hub plugin (`streamable`, file `codex-spend.mjs`, 0.1.0, contract 3): Codex token spend by day, session,
model and token type, presented like `spend` but in tokens only — Codex runs on a subscription, there are no prices.

**Source on this Mac:** rollouts in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `~/.codex/archived_sessions/`.
Only four line types are parsed (filtered by the line head before `JSON.parse`): `session_meta` (id, cwd, source,
fork/parent ids), `turn_context` (turn id, model), `token_usage_record` and `event_msg`/`token_count`. Of
`event_msg`/`thread_settings_applied` only the thread id on the line head is matched (the line isn't parsed). Message
lines are never parsed; no text reaches the output, the index or a log.

**Counting.**
- New format (Codex 0.159+): sum `token_usage_record.usage` (one API response each), deduplicated by `response_id`.
  A record counts only in the file of its own thread (`payload.thread_id`). In such a file `token_count` repeats the
  record and is ignored.
- Old format: `token_count.info.last_token_usage`, deduplicated by `timestamp` + total + last total. A `token_count`
  whose running total equals the file's previous one is a repeat (a resumed session repeats its last count) and is
  skipped.
- Forks and spawned agents (`forked_from_id`, `parent_thread_id` or a subagent source in the file's own
  `session_meta`): Codex copies the parent's lines into the child's file with fresh timestamps (an agent spawn drops
  the parent's `token_usage_record` lines but keeps its `token_count` events). `token_count` lines in that copied
  prefix are skipped. The prefix ends at the child's own `thread_settings_applied` (Codex 0.159 writes it right after
  the copy), at its first own `token_usage_record`, or — in a file from an older Codex without that marker — at the
  first pause of 1.5 s between lines (the copy is written in one burst).
- The model of a request: its `turn_id` → that turn's `turn_context.model` (otherwise the file's last model).
- Token kinds: new input = `input − cached`, cached input, output (reasoning is part of output; its share is a gray line).
- Sessions by kind from `session_meta.source`: terminal, editor, `codex exec`, subagents.
- Files are read oldest name first.

**Indexing.** Incremental, per file: size, mtime, inode, offset, format, last model, thread id in
`PluginData/index.json` (0600, with the fork prefix state and the last running total) with daily buckets per model and per session and hashed dedupe keys. The horizon is the
earlier of the month start and 29 days back; older files aren't opened. `.jsonl.zst` rollouts are counted, not read (a
line in "Details"). Rescans every 30 s and on `fileChanged` (`<agenthub.watch>~/.codex/sessions`).

**All Codex (server).** `codex app-server` is asked `account/usage/read` (same short JSON-RPC session as
`codex-quota`, with `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1`). Each call makes Codex refresh its own
caches and databases under `~/.codex`, so calls are rare: at most every 15 minutes, or after 5 minutes when a session
file changed since the last call; a manual refresh after 5 minutes. After "API key", "not signed in" or "codex not
found" only once an hour (a manual refresh still asks). Its `dailyUsageBuckets` (duplicate dates summed,
negatives as 0) are a second bar chart "All Codex · as Codex reports" next to "sessions on this Mac", with
`lifetimeTokens`. The server's numbers include `--ephemeral` runs and other devices; its days may be UTC days. Kept in
`PluginData/server.json`. Not signed in / API key / no answer — a gray line with the reason; no `~/.codex` — nothing is
spawned.

**Page:** header "Codex today 8.5K tokens · 7 requests" (and "all Codex today — …" from the server once it has filled today; it lags, a zero is not shown), yesterday / 7 days /
month, by day (stacked: cached, new input, output), by token type, all Codex, where requests come from (`chart=share`),
sessions over 7 days (folder · start, the full path in the tooltip), models over 7 days, details.

Tests: `daemon/test/plugin-codex-spend.test.mjs` (new/old formats, forks, model by turn, archived, incremental cache,
the server chart through the fake `codex`). Fixture: `fixtures/usage.json` (synthetic `account/usage/read` answer with a
duplicate date). For tests: `AGENTHUB_TEST_BIN_DIR`, `AGENTHUB_TEST_NOW`, `AGENTHUB_CODEX_USAGE_MS`,
`AGENTHUB_CODEX_SPEND_TICK_MS`.
