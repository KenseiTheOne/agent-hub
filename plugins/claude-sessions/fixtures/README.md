# claude-sessions fixtures

Synthetic data shaped like the live sources (field names and types were taken by reading keys, values are made up;
there is no conversation text):

- `agents.json` — output of `claude agents --json`: `pid, cwd, kind, startedAt, sessionId, name, status, waitingFor`.
  The name `beta | bash=evil` checks that foreign text cannot override line parameters.
- `session.template.json` — `~/.claude/sessions/<pid>.json`; `procStart` is `ps -o lstart` with TZ=UTC.
- `cmux.template.json` — `~/.cmuxterm/claude-hook-sessions.json`; text fields are replaced with placeholders and are
  not read by the plugin.

`{{PID_*}}`, `{{START_*}}`, `{{HOME}}`, `{{NOW_SEC}}`, … are substituted by the test: live pids are its own child
`sleep` processes, a dead one is a child process that has exited.
- `transcript.synthetic.jsonl` — the tail of `~/.claude/projects/<folder>/<sessionId>.jsonl` shaped like Claude Code
  records (record types and effort field names follow Claude Code's code, not other people's transcripts): `assistant`
  with `effort` and `perTurnEffort`, an `ultra_effort_enter` attachment, an API error (`isApiErrorMessage` — not
  counted), traps — the text `"effort":"max"` inside a message and `effort` in a tool input. Texts are «СИНТЕТИКА-…»
  placeholders; the test checks that none of them reaches the output.
