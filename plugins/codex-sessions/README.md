# codex-sessions

Built-in Agent Hub plugin (`streamable`, file `codex-sessions.mjs`, 0.1.0, contract 3): live Codex CLI sessions — which
are working, which are idle, their folder, model and effort — and a "Switch to tab" button. Read-only, no network. It
never starts Codex, its background server (`codex app-server`) or `codex agents` (that command starts the server).

**Alive.** Codex holds an advisory lock on `~/.codex/thread-writer-locks/<threadId>.lock` for as long as a process writes
that session's rollout, and deletes the file at the end. The plugin lists the directory (`.coordination.lock` and
non-UUID names are ignored) and asks `/usr/sbin/lsof -Fpn -- <files>` who holds each file. It never opens or locks a
lock file. A file nobody holds is a leftover, not a session. lsof exits 1 when some or all of the files are held by
nobody; that (even with empty output) is an answer, not a failure — only a spawn error, a timeout or another exit code
is.

**Metadata.** `~/.codex/state_5.sqlite` opened read-only (`node:sqlite` with `readOnly`, otherwise
`/usr/bin/sqlite3 -readonly -json file:…?mode=ro`): only `id, cwd, source, model, reasoning_effort, name, agent_nickname,
agent_role, created_at_ms, updated_at_ms, rollout_path` from `threads` and the parent from `thread_spawn_edges`. `title`,
`preview` and `first_user_message` are conversation text and are never selected. `name` is the session's name: the
user's or one Codex generates from the first prompt (the TUI's `thread_title.rs`); it is the row title, the way
`claude-sessions` shows Claude Code's session titles. A `rollout_path` outside `~/.codex/sessions` or
`~/.codex/archived_sessions` is ignored; without a database row the rollout is found by id in the last 60 day folders
and its first line (`session_meta`) gives `cwd`, `source` and the creation time by regular expression.

**Working or idle.** The rollout is read incrementally and the turn state is kept per file between polls. The first
look scans back from the end in 256 KB chunks until the region holds a `task_started` and a `turn_context` (or the file
start, at most 16 MB); after that each poll reads only the appended complete lines. A replaced (inode), truncated or
rewritten file (the 64 bytes before the read offset changed), or one that grew by more than 16 MB since the last poll, is
scanned afresh. Only four line types are looked at, by regular expression on the line head — never `JSON.parse`: `event_msg` `task_started` / `task_complete` / `turn_aborted` (`turn_id`, `started_at`)
and `turn_context` (the top-level `model`, `effort`, else `collaboration_mode.settings.reasoning_effort`). A
`task_started` without a later `task_complete` or `turn_aborted` with the same `turn_id` means a turn is running; the
row shows how long. Quotes inside text are escaped in JSON, so text can't fake a field. "Waiting for approval" is not
written to files and is not shown (the background server knows it, but only over WebSocket on its control socket).

**Effort.** The last turn's effort → the thread record's `reasoning_effort` → the top-level `model_reasoning_effort` in
`~/.codex/config.toml` → `default_reasoning_level` of the model in `~/.codex/models_cache.json`. The row says which one
("as of the last turn", "from config.toml", "the model's default").

**The tab.** The lock holder is the process that owns the session: a terminal `codex` (it has a tty — the tab),
`codex exec`, or Codex's background server (no tty). Since 0.15x the terminal UI hands its sessions to the shared
background server, so the holder often has no tab. Then, for a terminal (`cli`) session only, the plugin takes the terminal `codex` processes
that hold no session, whose parent isn't `codex` and that were already running when the session was created
(`created_at_ms`, else the `session_meta` line time; the process start is `ps` `lstart`), reads their working folder
(`lsof -a -d cwd -Fpn -p …`) and binds the session only when exactly one such process and one such session share the
folder. Otherwise the row shows "no tab process found" and no process — so does a session resumed in a tab opened after
it was created. Command arguments are never read (`ps -o pid=,ppid=,tty=,lstart=,comm=`).

**Rows.** One per interactive session (`cli`, IDE): working first, then idle, newest activity first. A row with a tab
process carries `agentSession=<threadId> pid=<pid> agent=codex agentName="…"`, so the hub lists it in `externalSessions`
(and permission cards keyed by the thread id attach to it), and a `session.focus <threadId>` button. In cmux the hub
can't find a non-Claude Code tab, so a session whose process runs under cmux gets a gray note instead of the button.
`codex exec` runs are rows tagged "background (codex exec)"; subagent sessions (Guardian review, spawned agents) are
nested under their live parent (an orphan is its own row). Neither is registered with the hub. The header: "Codex: 2
working · 1 idle", "Codex: 3 sessions idle", "Codex: 1 background run", "No Codex sessions", "Codex isn't installed"
(no `~/.codex`). If lsof can't run and nothing is visible — `status=unknown` + `event=source-broken`. Effort values:
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent` (anything else isn't shown).

**Polling.** Every 3 s, on `fileChanged` (`<agenthub.watch>~/.codex/thread-writer-locks/*.lock`) and on `refresh`;
a frame is printed only when it changes.

Tests: `daemon/test/plugins-codex-sessions.test.mjs` (lsof/ps doubles, a SQLite database created in the test with text
columns the plugin must not select, synthetic rollouts from `daemon/test/fixtures/codex/rollouts.mjs`).
For tests: `AGENTHUB_TEST_BIN_DIR` (lsof, ps, sqlite3), `AGENTHUB_TEST_POLL_MS`, `AGENTHUB_TEST_NOW`,
`AGENTHUB_CODEX_NO_NODE_SQLITE=1`.
