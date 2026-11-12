# spend fixtures

Synthetic Claude Code transcript lines for `daemon/test/plugin-spend.test.mjs`: no real sessions, projects or
conversation text. Every text field carries the marker `SYNTHETIC-PRIVATE-TEXT`, which must never reach the plugin's
output or its index file.

- `session.jsonl` — the main session (`<project>/<sessionId>.jsonl`): request A written as two content-block lines
  (output grows 10 → 400), request B with 5 min and 1 h cache writes, request C without a `requestId` in fast mode, a
  `<synthetic>` notice, user and tool-result lines with the word "usage" in their text.
- `agent-sub.jsonl` — a subagent (`<sessionId>/subagents/agent-*.jsonl`): a copy of request A (counted once) and a
  Haiku 5.5 request with a prompt over 100K tokens.
- `agent-wf.jsonl` — a Workflow agent (`<sessionId>/subagents/workflows/wf_*/agent-*.jsonl`): a Fable 5.2 request
  (priced like Fable 5.1) and an unknown model (tokens only, no cost).

Times are UTC; the test runs in `Asia/Tokyo`, where 14:30Z and 15:30Z on Nov 10 fall on different local days.
