# quota

Built-in Agent Hub plugin (`standard`, file `quota.5m.mjs`). Read-only, no network. Since 0.4.0 it runs right
after every cache write by the usage service (`<agenthub.watch>$AGENTHUB_USAGE_FILE`: the core substitutes the path,
for built-in and official plugins only), and the 5 min interval is a fallback (previously: polling every 30 s with a
cache refreshed every 3 min). After updating the repository run `agenthub builtin update`: the old `quota.30s.mjs`
is removed from the `<home>/Builtin` copy, so there will be no second quota.

**Source:** the hub cache `<home>/Cache/usage.json`, written every 3 min by the core service `usage`
(`daemon/lib/services/usage.mjs`: the Claude Code OAuth token from the keychain, `GET /api/oauth/usage`). The path is
in the `AGENTHUB_USAGE_FILE` variable, which the core gives only to built-in and official plugins. No variable means
the service is off (`services.usage.enabled = false` in the daemon's `config.json`) or the daemon was not restarted
after `agenthub builtin update`: "Quota unavailable" with a hint. The plugin does not need a statusline plugin.
`rows[]` rows: `session` (5 h), `weekly_all`, `weekly_scoped` (per model).

**The header always shows the current value** (since 0.4.2): «Неделя 72% · сброс пн 10.11 09:00» / "Week 72% · resets …".
The forecast ("by reset it will be ≈…") and "week ≥ 80%" do not go into the header — only as event lines in the body
and as the status color.

**Shows:** percentages and reset time, pace (a linear forecast to the reset; no forecast for the first 5% of the
window). The 5-hour window has its own card with its own "N% of window elapsed"; "N% of week elapsed" is one line
under the weekly cards. A service error (not logged in, token expired, HTTP 429, no network) is shown briefly in the
header when the data is stale; if the old numbers already show the week at ≥ 80% or the limit exhausted, the number
goes into the same header with a tail ("· not updating: … · data from 10 h ago"). The pace forecast uses fresh data
only.

**Events:** `week-80` (week ≥ 80%), `pace-85` (85% at the current pace will be reached before the reset), `token-lost`
(`no-token` / `http-401`; the event sits on the header itself, which already states the reason). Keychain unreadable
(`keychain-unavailable`: locked, dialog denied, timeout) — "no keychain access — will retry later",
without `token-lost` (since 0.4.1). Any row ≥ 100% — `status=block`. A cache older than an hour — `unknown` without an
event. An unknown shape → `status=unknown` + `event=source-broken`; the text of that line (also the push text) is in the
hub language (`usage.json: rows не массив` / `usage.json: rows is not an array`, since 0.4.1).

Icon: `<agenthub.icon symbol="gauge.with.dots.needle.50percent" color="#0A84FF">`, contract 2 (since 0.5.0). The
plugin declares the notification rules for its events itself (`<agenthub.push>`, since 0.5.0; before that they were
in the core table): `week-80` and `pace-85` — at most once a week (the key includes the reset date: every quota week
has its own), `token-lost` — immediately; all of them use the `problems` kind ("Failures and warnings"), with labels
in ru and en.

Tests: `daemon/test/plugins-quota.test.mjs`; fixtures in `fixtures/` (synthetic).
