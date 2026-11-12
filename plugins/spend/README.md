# spend

Built-in Agent Hub plugin (`streamable`, file `spend.mjs`, 0.2.0): a journal of Claude Code token spend — when and how
many tokens were spent, by day, model and token type, and what that would cost at API list prices. Read-only, no
network.

**Source:** Claude Code transcripts in `~/.claude/projects`: the main session files (`<project>/<sessionId>.jsonl`),
subagents (`<sessionId>/subagents/agent-*.jsonl`) and background Workflow agents
(`<sessionId>/subagents/workflows/wf_*/agent-*.jsonl`). Every model response line (`type: "assistant"`) carries
`message.usage`. From such a line the plugin takes only the usage numbers (input, cache writes split into 5 min and
1 h, cache reads, output, `speed`), `message.model`, `timestamp` and the dedupe key (`requestId`, otherwise
`message.id`). Message text is parsed in memory and dropped: it never reaches the output, the index file or a log.
Since 0.2.0 no session ids, project names or session names are taken.

**Counting.** One request is written as one line per content block with the same usage, and a copy of a request may
appear in another file; requests are deduplicated by their key, taking the maximum of each field (`output_tokens` is a
stream snapshot and may grow, so output can be slightly under-counted). Days are local calendar days. Lines with the
`<synthetic>` model (local notices) are not requests.

**Indexing.** Incremental: per file the offset of the last complete line, size, mtime and inode are kept in
`PluginData/spend/index.json` (0600, format version 2) with the daily buckets (per model, and the subagent and Workflow
shares) and the hashed dedupe keys of the kept days. Files last modified before the horizon — the earlier of the month
start and 29 days before today (the 30-day chart) — are not opened. An index of an older format is rebuilt once. The first run reads everything inside the horizon in 64 MB slices,
newest files first, and shows progress ("Indexing transcripts: N of M files"); after that the plugin rescans every
30 s (or on `refresh`) and reads only appended bytes. A replaced or truncated file is read again from the start — the
stored keys keep its requests from counting twice. While the hub is paused nothing is read; the page shows the
indexed numbers. Measured on a real machine with the 30-day horizon (≈3200 transcript files, 7.9 GB): the first
index takes ≈11 s, a later rescan reads only appended bytes (tens of ms), the index file ≈2 MB.

**Cost.** An API list price equivalent — **not a bill**: on a subscription you pay a flat fee. Prices are a table in
the plugin (`PRICES`, as of 2026-11-11, USD per million tokens): input, output and cache read per model; cache writes
are 1.25× input (5 min) and 2× input (1 h). Fast mode uses the listed fast price (Opus 5.5, Opus 5, Opus 4.6) or 2×.
Haiku 5.5 prompts over 100K tokens use its higher tier. A model missing from the table but of a known family (Fable,
Mythos, Opus, Sonnet, Haiku) is priced like the nearest version of that family and listed under "Details" as
assumed (Fable 5.2 → Fable 5.1). A model of an unknown family is counted in tokens only: "—" in the cost columns, a
"+" after a day's cost, and a line in "Details".

**Page** (design A, 2026-11-12; it uses the hub's chart elements — `chart=bars`, `chart=share`, `bar=`, `spark=`,
hub 0.1.3; an older hub draws the same lines as text):

- header — the headline "Today $X · N tokens" (menu bar, sidebar) and the page hero: "Today, by HH:MM", today's
  cost large, "N tokens · M requests", "yesterday for the whole day — $Y" and a 14-day sparkline with its average
  ("avg $Z a day"); `tile` — today's cost, `tileLabel` "Spend today" (the popover tile shows the sparkline too).
  During the first indexing — "Today ≥ $… · indexing transcripts, N%";
- a note that this is an API price equivalent, not a bill;
- three cards: yesterday (with "N× the average" in orange when it is over 1.5× the 14-day average, otherwise its
  tokens), the last 7 days with the daily mean, this month (named) "for N days";
- "By day" — cost bars for 14 or 30 days with captions (14 days), the dashed average of the complete days (counted
  from the first day with data), today in the plugin color, days above the average in orange; a tooltip per day
  (date, cost, tokens, requests); a 14 / 30 days switch (the `set-range` action, stored in `settings.json`);
- "Tokens by day" — stacked bars of cache reads, cache writes and output, a tooltip per day (date, total, cache
  read, cache write, output, new input, the API price); under it a table of the token types — today, 7 days and their
  share of the 7-day cost (from the price table: each type at its own price), with a line on how much of the tokens
  and of the cost the cache reads are;
- "Where it goes · 7 days" — background Workflow runs, the sessions themselves and subagents as shares of the cost;
- "Models · 7 days" — a row per model with its cost and a bar against the most expensive one ("priced as …" for an
  assumed price, "no price" for an unknown model);
- "Notify when today passes" — a popup with Off / $10 / $25 / $50 / $100 / $200 / $500 (the `set-alert` action);
- "Details" (collapsed): the price date, assumed and unpriced models, the output caveat, the number of indexed files.

Removed in 0.2.0 (user decision): "Today by hour", "Top sessions today" with the "Switch to the session" button, the
14-day table. Numbers are short: "$3.0k" / "$3,0 тыс.", "1.75B" / "1,75 млрд", grouped request counts.

**Events:** `daily-over:<YYYYMMDD>` — today's cost reached the chosen threshold (`<agenthub.push kind="plugin">`, so
it has its own switch in Settings → Notifications; one notification per day). No threshold — no event. The status is
always `ok` (`unknown` when there is no transcripts folder): spending is not a problem the hub should flag.

**Permissions:** `fsRead` of the three transcript masks above (usage numbers and request ids only); no effects (0.2.0
dropped `session.focus` and the sessions file); the `set-alert` and `set-range` actions (`immediate`: they only store the
threshold or the range in `PluginData/spend/settings.json`, and the same control changes it back). Contract 3, icon
`dollarsign.circle` `#30D158`.

Tests: `daemon/test/plugin-spend.test.mjs`; fixtures in `fixtures/` (synthetic, see `fixtures/README.md`).
