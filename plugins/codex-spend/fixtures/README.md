# codex-spend fixtures

`usage.json` — a synthetic `account/usage/read` answer of `codex app-server`: `summary.lifetimeTokens` and
`dailyUsageBuckets[{startDate, tokens}]` with a duplicate date (2026-11-21) that must be summed. Values are made up.
Rollout lines for the tests are built by `daemon/test/fixtures/codex/rollouts.mjs` (every text field is a placeholder).
