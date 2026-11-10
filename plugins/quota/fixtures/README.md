# quota fixtures

Synthetic data shaped like the hub cache `<home>/Cache/usage.json` (written by the core service
`daemon/lib/services/usage.mjs`): `version`, `fetched_at` (last success) and `checked_at` (last attempt) in epoch
seconds, `error` — the service code (`no-token`, `token-expired`, `http-429`, `network`, …) or `null`, `rows[]` — only
`kind` (session/weekly_all/weekly_scoped), `group`, `percent`, `severity`, `resets_at`, `scope.model.display_name`,
`label`. Values are made up. `usage-broken.json` — a broken shape.
