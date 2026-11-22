# codex-quota fixtures

`rate-limits.json` — a synthetic `account/rateLimits/read` answer of `codex app-server` (camelCase, Codex 0.159):
`rateLimits.primary` 31% of a 300-minute window, `secondary` 64% of a 10080-minute window, `resetsAt` in epoch seconds,
`planType: "plus"`, `rateLimitsByLimitId: null`. Values are made up. The fake `codex`
(`daemon/test/fixtures/codex/fake-codex.mjs`) answers with it by default.
