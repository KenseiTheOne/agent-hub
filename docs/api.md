# Daemon HTTP API

HTTP/1.1 **only** on the Unix socket `<home>/hub.sock` (mode 0600, the `<home>` directory 0700;
`<home>` = `~/Library/Application Support/AgentHub` or `AGENTHUB_HOME`). No TCP is opened for the API at all. The only
exception is a temporary sign-in code receiver on `127.0.0.1` (section "Connections"): up to 5 min, one request, not
the API. The host in the URL does not matter, but the `Host` header must be a plain name (`hub`):
`curl --unix-socket "$HOME/Library/Application Support/AgentHub/hub.sock" http://hub/state`.
Node answers `400` to a `Host` holding the percent-encoded socket path — which is what AsyncHTTPClient sends by default
for `http+unix://`; the shell sends `Host: hub`.
Request and response bodies are JSON (`content-type: application/json`), with a 64 KB body limit (`/hook` — 1 MB).

## Peer classes

The class is determined **once at accept** from the client pid (`LOCAL_PEERPID`, the `daemon/native/peercred` addon)
and is bound to the connection:

| Class | How it is determined | What it may do |
|---|---|---|
| `app` | the executable is inside `AgentHub.app/Contents/MacOS/` **and** `codesign --verify --strict -R=<requirements.app>` passes | everything |
| `hook` | the process is `agenthub-hook` (a path from `peer.hookPaths`; for an interpreter — `argv[1]`) **and** among its ancestors (up to 4 levels by ppid) there is a process passing `requirements.claudeCode`; its pid is remembered (`claudePid`) | only `POST /hook` (+ `/health`, `/peer`) |
| `bridge` | the bridge process (`peer.bridgePaths`) | only its own routes (stage 5) (+ `/health`, `/peer`) |
| `cli` | everything else, including `curl` | reading (`/state`, `/events` without `hook.*` events, `/journal`) and `immediate` actions, except app-only ones |
| `foreign` | another uid (the 0600 socket does not allow this; just in case) | nothing, `403 peer:uid` |

Requirements are strings in `config.json` (`requirements.app`, `requirements.claudeCode`), not in code:

- `requirements.app` is `null` by default → the `app` class is unreachable (everything is `cli`). The default mode
  (decision 2026-11-05) is an ad hoc build pinned by cdhash: `identifier "com.kensei.agenthub" and cdhash H"<build cdhash>"`
  (`scripts/bundle.sh` → `agenthub pin-app <AgentHub.app>`). One build is in force: any other (a rebuild, an old copy) →
  `cli` with the reason `peer:app-signature`. An optional mode is
  `identifier "com.kensei.agenthub" and certificate leaf = H"<sha1 of the AgentHub Local Signing certificate>"`
  (`agenthub install --app-cert-sha1 <sha1> --apply`, `bundle.sh --cert`).
- The daemon re-reads `requirements.app` **without a restart**: fs.watch on the directory, a poll every 5 s and a check
  before every classification of a process from `AgentHub.app` (`lib/app-pin.mjs`). On a change, app verdicts are reset,
  connections of processes from `AgentHub.app` are closed (including SSE), and their requests are classified again.
  Every change is a journal record `app-requirement-changed` (`old`, `new` — fingerprints `cdhash:<hex>` /
  `cert:<sha1>` / `req:<sha256/16>` / `none`; `by`, `under` — as stated by `agenthub pin-app`, otherwise «неизвестно»;
  `source`), the SSE event `app-pin.changed` and the push `@hub:app-pin-changed` (the banner is always `osascript`;
  `POST /push/ack` does not suppress it). A change made while the daemon was stopped, or between reading the config and
  starting, is noticed at startup (`<home>/app-pin.json`, 0600, `source=start`). The request that first noticed the
  change gets an answer under the new pin on the same connection (the others are closed).
- `requirements.claudeCode` = `identifier "com.anthropic.claude-code" and anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"`.
  The real binary `~/.local/share/claude/versions/<version>` is verified, not the cmux shim.

The signature is verified for the **running process**: the peercred addon (`codeInfo`, the csops system call) gets the
process's cdhash, flags, identifier and Team ID from the kernel, and `codesign --verify --strict -R=<requirement> <pid>`
verifies the process itself. The verdict is cached by cdhash (another binary at the same path — another cdhash — a new
check): `codesign` on the 200 MB Claude binary takes ~1 s, repeated checks come from the cache. For the app the cache key
is the cdhash plus the process itself (pid + start time): `--strict` also checks the bundle seal (Info.plist,
resources), so a copy of the bundle with the same executable but a modified Info.plist does not inherit the real
build's verdict. If auto-update deleted the version file while the process is alive, it is accepted if the kernel
confirms the same cdhash, not ad hoc, with the same identifier and Team ID, and that cdhash has already passed the
requirement (`<home>/verified-code.json`, 0600). A failure of the check itself (timeout, EAGAIN) is not cached. Without
`codeInfo` (doubles) — a file-based check, cached by (realpath, dev:ino, mtime, ctime, birthtime, size).
A process with `--probe-action` in argv never gets the `app` class (`peer:app-probe`); release builds do not have that
flag. No addon → all clients are `cli` (`peer:no-peercred`), process signatures are not checked (fail closed, not open).

**Limit:** a pid-based check does not protect against an attacker running as the same UID who passes an open fd to
another process, rewrites `config.json` (re-pins their own build) and the daemon code, or signs their binary with the
same key. So against an agent of the same user, cdhash and certificate are equivalent. A re-pin is visible in the
journal, in push and in the panel, but not forbidden (an accepted v1 risk, see design §3; Touch ID would close it).

## Error codes

An error response is `{"error": "<code>", ...}`. The code is stable and never translated; human text next to it
(`detail`, linter `errors`, hub-update `detail`) is in the hub language at the moment it was produced.

| HTTP | `error` | When |
|---|---|---|
| 400 | `json`, `body`, `args:<field>:<required\|type\|unknown\|pattern\|too-long\|range\|enum>` | body/arguments |
| 403 | `peer:cli`, `peer:hook`, `peer:bridge`, `peer:uid` | the route or action is not available to the class |
| 403 | `peer:app-signature`, `peer:app-requirement-missing` | the executable is in `AgentHub.app`, but the signature failed / no requirement is set (for actions) |
| 403 | `peer:no-claude-ancestor` | `agenthub-hook` without a signed Claude Code among its ancestors |
| 403 | `peer:session-mismatch`, `peer:no-session-file` | the hook's `session_id` did not match `~/.claude/sessions/<claudePid>.json` |
| 403 | `confirm:invalid` | the confirmation token is foreign, expired, used or from another pid |
| 404 | `not-found` | no such route/action/plugin |
| 405 | `method` | wrong method |
| 409 | `facts:<reason>` | the arguments did not match the core facts (`facts:scheme`, `facts:unknown-session`, …) |
| 413 | `too-large` | the body exceeds the limit |
| 423 | `estop` | the hub is paused (hub pause; internal name estop, file `ESTOP`) |
| 428 | `confirm-required` | a confirmation is needed (see below) |
| 429 | `terminal:rate-limited` | more often than allowed (the `/terminal/*` routes, contract 3): `scope`, `retryAfterMs` |
| 500 | `internal` | daemon error |

## Routes

### `GET /health` — all classes
`{"ok":true,"pid":123,"uptimeMs":4567,"contract":2}` — `contract` is the plugin contract version the core understands
(`daemon/lib/meta.mjs` CONTRACT_VERSION; changelog in [`extension-points.md`](extension-points.md), "Contract versions").

### `GET /peer` — all classes
Your class: `{"class":"cli","reason":null,"pid":4242}`. For debugging the app signature.

### `GET /state` — app, cli
Snapshot:
```jsonc
{
  "version": "0.1.0", "contract": 3, "now": "2026-11-04T13:00:00.000Z", "pid": 123, "seq": 57,   // contract — the core's plugin contract version
  "estop": false,
  "status": "wait",                      // the worst plugin status: ok < unknown < wait < block < error
  "waitingSessions": 1,                  // verified sessions with status=waiting
  "severity": {"ok":0,"unknown":1,"wait":2,"block":3,"error":4},
  "plugins": [{
    "id": "quota", "source": "builtin|installed|local", "tier": "builtin|official|community|local",
    "trusted": true, "official": false, "file": "/…/quota.5m.mjs",
    "type": "standard|streamable", "title": "Quota", "desc": "…", "lang": "en", "version": "1.0.0", "interval": "5m", "schedule": null,
    "author": {"name": "Kensei", "github": "KenseiTheOne"},          // <agenthub.author.*>; {} — not specified
    "statusLabels": {"wait": {"label": "Quota running low", "hint": "…"}},   // <agenthub.status>, in the hub language
    "effects": ["open.url"],
    "actions": [{"id":"skip","level":"confirm","title":"Skip task","arg":{"name":"taskId","pattern":"^[A-Za-z0-9_-]{1,64}$"}}],
    "pushRules": [{"key":"build-blocked","label":"…","hold":"evening","kind":"plugin"}],   // <agenthub.push>, trusted plugins only
    "icon": {"symbol":"gauge.with.dots.needle.50percent","color":"#0A84FF"},   // <agenthub.icon>; null — not declared
    "contract": 2,                        // <agenthub.contract>; 1 — not declared
    "connections": [{"id":"tix","title":"Tix","note":"…","url":"https://mcp.example.com/mcp","host":"mcp.example.com","hosts":[],
                     "scope":"read","tools":["get_user"],"intervalMs":900000,"budget":100}],   // <agenthub.connection>, trusted plugins only
    "status": "ok", "error": null, "lastRunAt": "…", "durationMs": 31, "pid": null, "events": ["week-80"],
    "header": [Item], "body": [Item]
  }],
  "sessions": [{"sessionId":"…","pid":2220,"startSec":1792600000,"status":"waiting","waitingFor":"permission prompt",
                "name":"…","cwd":"~/…","surfaceId":"…","workspaceId":"…","sources":["plugin:claude-sessions"],"interactive":false,"updatedAt":0,
                "effort":"high","ultracode":false,"model":"claude-opus-5-5","modelSource":"turn","effortSource":"command",
                "metaAt":"2026-11-10T12:00:00.000Z","terminal":"tmux","focusable":true,
                "terminalInfo":{"adapter":"tmux","label":"tmux","capabilities":["focus","read-screen","send-text","send-esc","launch"],
                                "focusable":true,"via":null}}],
  "primitives": [{"name":"open.url","level":"immediate","remoteAllowed":false,"appOnly":false,"safeUnderEstop":true},
                 {"name":"cmux.focus","level":"immediate","remoteAllowed":false,"appOnly":false,"safeUnderEstop":false,
                  "aliasOf":"terminal.focus","deprecated":true}],
  "terminals": {"adapters":[{"id":"cmux","label":"cmux","capabilities":["focus","read-screen","send-text","send-esc","launch"],
                             "via":"bridge","installed":true,"available":false,"reason":"bridge-offline","sessions":0},
                            {"id":"iterm2","label":"iTerm2","capabilities":["focus","launch"],"via":null,"installed":true,
                             "available":true,"reason":null,"sessions":2}],
                "launch":{"adapter":"iterm2","why":"sessions"},"prefer":"auto"},
  "appPin": {"kind":"cdhash","fingerprint":"cdhash:<40 hex>","changedAt":"2026-11-05T09:53:53.645Z","by":"agenthub pin-app",
             "under":"terminal","source":"check","old":"none","path":"/…/agent-hub/app/build/AgentHub.app","generation":1},
  "lang": {"setting":"system","effective":"en","system":"en"},
  "hub": {"home":"/tmp/ahl","testMode":true,"builtinDir":"/tmp/ahl/Builtin","builtin":"copy","cli":"/…/agent-hub/daemon/bin/agenthub"},
  "launchAtLogin": {"setting":true,"launchAgent":"ok"},
  "notifications": {"enabled":true,"kinds":{"sessions":true,"updates":true,"problems":true,"other":true},
                    "plugins":[{"id":"builder","title":"Builder","on":false,"labels":["Build won't start"],"legacy":true}],
                    "quiet":{"enabled":true,"start":"23:00","end":"08:00","from":"config"},
                    "security":[{"key":"app-pin-changed","plugin":"@hub","label":"Agent Hub re-pinned"},
                                {"key":"tamper","plugin":"builder","pluginTitle":"Builder","label":"Tampering marker"}],
                    "service":true,"awayAfterMs":600000},
  "connections": [{"id":"tix","title":"Tix","note":"tickets assigned to you","plugin":"tix","host":"mcp.example.com",
                   "tools":["get_user","filter_tasks"],"state":"connected","scope":"read",
                   "intervalMs":900000,"dailyBudget":100,"calls24h":12,"nextAt":"2026-11-09T12:15:00.000Z","why":null,"error":null}],
  "idle": {"verdict":"busy","since":"2026-11-07T10:02:00.000Z",
           "items":[{"source":"plugin:agents","kind":"busy","text":"Run \"m81-gold\" running, 12 min","target":"plugin:agents","plugin":"Agents","trusted":true},
                    {"source":"plugin:builder","kind":"needs-on","text":"Build at 04:30 — needs the Mac on","target":"plugin:builder","plugin":"Builder","trusted":true},
                    {"source":"sessions","kind":"waiting","text":"1 session is waiting for an answer: my-session — you can answer after turning the Mac back on","target":"sessions"}],
           "checked":["Mail","Updates in progress"]},
  "bridge": {"online":false,"since":null,"version":null,"command":"/…/agent-hub/bridge/agenthub-bridge","home":"/tmp/ahl","defaultHome":false},
  "pluginUpdates": {"enabled":true,"setting":true,"config":true,"configured":true,
                    "checkedAt":"2026-11-05T21:05:51.676Z","nextCheckAt":"2026-11-06T03:21:40.000Z","error":null,
                    "items":[{"id":"builder","title":"Builder","installed":"0.4.0","version":"0.4.1","sha256":"<64 hex>",
                              "tier":"official","permissionsGrow":true,
                              "added":[{"kind":"watch","what":"$AGENTHUB_USAGE_FILE","why":"the usage service wrote a fresh quota: …"}]}]},
  "hubUpdate": {"installed":true,"running":"0.2.0","label":"0.2.0","current":{"label":"0.2.0","tag":"v0.2.0","commit":"…"},
                "previous":{"label":"0.1.0"},"enabled":true,"configured":true,"available":{"version":"0.3.0","tag":"v0.3.0"},
                "install":{"phase":"idle"},"blocked":null},
  "peer": {"class":"cli","reason":null}
}
```
`hubUpdate` — updating the hub itself (the hub-update service, section "Hub updates" below and
[`hub-updates.md`](hub-updates.md); `null` — no such service).
`idle` — **can the computer be shut down** (the idle service, `daemon/lib/idle.mjs`; `null` — no such service): one daemon
answer for the popover, the menu bar icon and future notifications; on a change — the `idle.verdict` event. `verdict`:
`quiet` — nothing is running and all participants answered; `quiet-needs-on` — quiet, but someone will need the computer
later (a plugin's `needsOn=`) or the hub does not know about some source (an `unknown` line); `busy` — work is in
progress. Sessions waiting for an answer **do not change** the verdict (decision 2026-11-09): they do nothing by
themselves; sleep does not affect them — the question is still there after waking; shutdown closes the process, but the
conversation is saved (the transcript is written as it goes) and `claude --resume` reopens it, though the question
window will not come back by itself and the asked step is not done (an interrupted tool call is not repeated on resume —
code.claude.com/docs/en/sessions, "What a resumed session restores"). **The exception** (review 2026-11-09): the waiting
session shows ongoing work — a card from a subagent (`subagent` in the `hook.pending` fact: the hook had an `agent_id`),
`waitingFor` "worker request" or `status=busy` with a card (while a permission dialog is open, Claude Code sets
`waiting`: the PermissionRequest hook runs in parallel with the dialog; `busy` with a card means the registry has not
caught up or other work is running). Such a session is a `busy` obstacle "1 session is working and waiting for an
answer on a step: …": shutdown will cut off the subagents and commands, and `--resume` will not restart them. Other
background work of a waiting session (Bash, Monitor) is not visible in its status — the shell writes "no work in sight"
and says so in the line tooltip; `null` means "checking": the first 60 s after the daemon starts, until all plugins have
sent their first frame (otherwise after every daemon restart the popover would first turn green with "OK to shut down";
the shell shows the regular icon and no card). `items` — one line per obstacle, in order: work (`busy`: working
sessions, then waiting sessions with visible work; plugins' `activity=`; building and installing a hub update — phases
`building`, `switching`, `trial`, `rolling-back`, but no longer `ready`; installing and updating plugins; plugin actions
still running), "don't know" (`unknown`), `needs-on`, and last a summary that is not an obstacle: waiting for an answer
(`waiting`: PermissionRequest cards and sessions in `waiting` — "2 sessions are waiting for an answer: … — you can
answer after turning the Mac back on"; "Sessions" is then absent from `checked` — there is already a line about them).
Hub texts are in its language, plugin phrases as the plugin sent them (it gets `AGENTHUB_LANG`); phrases of plugins that
are neither built-in nor official get a "<name>: " prefix (so a third-party plugin cannot pass its line off as a hub
line). `target` — where the line leads: `sessions`, `settings`, `manager`, `plugin:<id>`; `plugin` — the plugin name on
its lines; `trusted` — a phrase from a built-in or official plugin: only such a phrase goes into the card title ("OK, but
build at 04:30"). `checked` — names of sources where all is well: "Sessions" (only if the `claude-sessions` sessions
plugin is alive and sent a frame; no frame or the plugin itself failing — an `unknown` line "Don't know about sessions:
the sessions plugin did not answer"; a frame exists but the plugin reported `status=unknown`/`error` with its own reason
— "Don't know about sessions: <reason>", for example "claude not found — …"; no plugin at all — from the session
registry, as before), plugins that report `activity=`/`needsOn=` with an empty value (except a failed or blocked
plugin), "Updates" (if the hub-update or plugins service exists). **A failed or silent participant** (a failure of the
plugin itself — exit ≠ 0, timeout, empty output; `status=error` without such a failure is a domain error, for example a
plugin task that failed — not a failure: the plugin phrases are taken as usual; no frame for more than 3 intervals, but
at least 2 min; for a streamable plugin with non-empty phrases — more than 5 min) does not drop out of the check, but its
phrases are not shown as is: a line "Builder: failure — last: <phrase> (HH:MM)" / "Builder is not answering — last: …"
— `busy` if the last thing was work, otherwise `unknown` (such a plugin's needsOn does not get its own line). An empty
frame with an error (exit ≠ 0 without output) does not erase the plugin's last phrases. `since` — when `verdict`
changed. **The hub pause does not affect the verdict**: while paused, sessions and scheduled work keep running (sessions
ask in the terminal), and shutdown would interrupt them just the same. A plugin block (`status=block`) is not part of the
verdict — shutdown will not make it worse; the icon shows the block as before.
`launchAtLogin` — "Launch at login" (`settings.json → launchAtLogin`, `PUT /settings/launch-at-login`; app supervision
below); `launchAgent` — the daemon job's KeepAlive from the plist in `~/Library/LaunchAgents` (`ok`; `outdated` — a plist
from before 2026-11-06 with `KeepAlive true`: the off setting does not work with it, and the shell locks the switch with
the hint `agenthub install --apply`; `missing`; `unknown`); no key — not checked (the app service is off, a test directory
without `services.app.test.launchAgent`). `hub.cli` — the full path to this daemon's CLI: the shell substitutes it into
hint commands (`agenthub pin-app`).
`ownPlugins` — own plugins from local folders (the plugins service, 2026-11-09; `null` — no such service): `{requests:
[{requestId, id, title, version, path, pathShort, fingerprint, permissions, update, migrate, createdAt, expiresAt, by}],
problems: [{id, title, status: missing|broken|update|paused, error}]}` — installation requests waiting for a human in the
app (`POST /registry/own/request`, `agenthub plugins install --from`), and own plugins whose folder disappeared, broke or
waits for consent to new permissions. The popover shows a line "Waiting for confirmation: own plugin "…"" with "Open".
Details: [`plugins-registry.md`](plugins-registry.md), "Own sources".
`pluginUpdates` — the background update check of registry plugins (the plugins service, `daemon/lib/registry/updates.mjs`;
`null` — no such service). The daemon downloads the signed index itself the same way as `POST /registry/fetch` (the same
signature and rollback checks): ~1 min after start and every 6 h (+ up to 30 min of jitter), on error — backoff 5 min →
15 min → 1 h → 3 h; registry not connected — no network, a re-check every 15 min. It installs nothing. `items` — installed
plugins for which the verified catalog has a **newer** version (a rollback and a rebuild of the same version are not
included; neither is a blocked new version or a foreign platform): `installed` → `version`, `permissionsGrow` — the new
version asks for permissions beyond the agreed ones, `added` — which ones (in the hub language). `enabled` — the check is
running: both the shell setting (`setting`, `PUT /settings/plugin-updates`) and `services.plugins.checkUpdates`
(`config`, false in `config.json` overrides the setting). `error` — the code of the last failed check
(`registry:not-found`, `registry:fetch`, `registry:http`, signature errors) or `null` (when off — always `null`, the
previous error is cleared); `checkedAt` — the last successful one; `nextCheckAt` — the next check or retry after an
error, `null` if off. `title` and `added` are in the hub language: when it changes, a `plugins.updates` event arrives with
the translation.
`sessions[].effort` — the effort of the session's last turn (`low` | `medium` | `high` | `xhigh` | `max`, otherwise
`null`), `ultracode` — `true`/`false` from the last ultracode marker, `null` — no markers. The source is the
claude-sessions plugin (the `sessionEffort=` / `sessionUltracode=` parameters; in the session transcript tail it reads
only the effort fields, never the conversation text). For an idle session the value may be stale: it is the level of the
last turn. Contract 3: `model` — the session model (`message.model` of the last turn record, for example
`claude-opus-5-5`, or a name from `/model` output after it — `Opus 5.5 (default)`; letters, digits, space and
`._:()[]/+-`, up to 64), `modelSource` and `effortSource` — where the model and effort came from: `turn` (the last turn)
or `command` (a `/model` or `/effort` command after it — it wins over the turn), `metaAt` — the time of the transcript
record the model and effort came from (the newer of the two, ISO 8601). The source is the same trusted-plugin line
parameters: `sessionModel=`, `sessionModelSource=`, `sessionEffortSource=`, `sessionAt=`; an unknown value is `null`.
`nameSource` — where the session name comes from (the `sessionNameSource=` parameter; `auto` — a title Claude Code
composed from the conversation, `derived` — from the folder and branch): `/state` shows the name as is, but an `auto`
name is not put into `Cache/claude-sessions.json` (`name: null`). These fields and the `Cache/claude-sessions.json` file
(below, "Other files") are metadata only. `terminal` and `focusable` (contract 3) are computed by the core on every
response and are not stored in the registry: `terminal` — the id of the terminal layer adapter (`lib/terminals/`) that
found the session tab (`cmux`, `tmux`, `iterm2`, `terminal-app`; a string, as in contract 3), otherwise `null`;
`focusable` — the tab was found and the adapter can switch to it (`session.focus`); `terminalInfo` — `{adapter, label,
capabilities, focusable, via}` or `null`: what the hub can do in that terminal (`focus`, `read-screen`, `send-text`,
`send-esc`, `launch`), `via: "bridge"` — through the cmux bridge. The adapter's availability (the cmux bridge) is not
included — see `bridge` and `terminals`.
`terminals` — Settings → Terminal ([`extension-points.md`](extension-points.md#terminal-adapter-daemonlibterminalsidmjs)):
`adapters[]` — every built-in terminal adapter with its `capabilities`, `via`, `installed` (the app or binary is on this
Mac; `null` — unknown), `available`/`reason` (can run operations now; cmux without the bridge — `false`,
`bridge-offline`), `sessions` (live sessions detected in it); `launch` — where `session.launch` opens a new tab
(`{adapter, why}`: `setting` — `services.terminal.launch`, `sessions` — most live sessions run there, `installed` — the
first installed of cmux, iTerm2, Terminal) or `null` — no terminal can; `prefer` — the setting (`auto` by default).
`bridge` — the cmux bridge (the actions service; `null` if there is no such service): `online` — connected and polling
(stopped polling for more than 40 s — `false` and the `bridge.disconnected` event with `reason: "stale"`),
`since`/`version` — since when and which version, `command` — the bridge script path (the first of
`peer.bridgePaths`), `home`/`defaultHome` — whether the start command needs `AGENTHUB_HOME=…`. The bridge is the cmux
adapter's detail: without it the shell disables "Go to tab" and Esc only for sessions in cmux and shows the command with
"Copy" (`AGENTHUB_HOME=<dir> <command>` if the directory is not the default) — in the session list when such sessions
exist, and in Settings → Terminal under the cmux row.
`appPin` — what is pinned in `requirements.app` (`kind`: `cdhash` | `cert` | `other` | `none`) and when that requirement
appeared; `by`/`under` — as stated by whoever wrote it (`agenthub pin-app`), not a verified fact. `by` is a code or a
command: `agenthub pin-app`, `manual` (config.json changed bypassing pin-app), `unknown`; the human-readable text is
built by the shell (the note "The app was rebuilt and pinned · <time> · from a Claude Code session") and by push in the
hub language. `old` — the fingerprint before this change: `none` — the first pin (the note "The app was pinned", the push
"Agent Hub pinned"), `unknown` — the daemon does not remember what it was; `null` — the change was recorded by a daemon
older than 2026-11-05. Removing the pin — the push "Agent Hub pin removed", re-pinning — "Agent Hub re-pinned". `path` —
the bundle the daemon launches at startup and after a crash (`appPin.path`, realpath); `null` — no path (`--cert` mode,
a record from before 2026-11-06).
`hub` — where the hub lives: `home` — the state directory; `testMode` — this is not the default directory
(`AGENTHUB_HOME`), and the shell draws the «ТЕСТ · <directory>» label; `builtin` — where built-in plugins come from:
`copy` (`<home>/Builtin`, the copy that `agenthub install --apply` and `agenthub builtin update` put there), `repo` (the
working tree `<repo>/plugins`), `custom`. `builtinDir` — the directory the daemon runs on **now** (it reads
`builtinPluginsDir` at startup); `agenthub builtin` uses it to check whether the daemon has moved to the copy.
`author` — the author's name and GitHub login (the login only per GitHub rules; the shell shows the name first and the
login as a link to the profile); the same field in `GET /registry/catalog` comes from the index.
`title`, `desc`, `actions[].title`, `statusLabels` — in the effective hub language (the `lang` variants of the metadata).
`Item`: `{title, level, separator?, status?, event?, params:{color,sfimage,…}, offer?, session?}`;
`offer`: `{id, kind:"effect"|"action", primitive, action, level, label}` — `id` is passed to `POST /actions/:id`;
for a parameterized action the argument (from `arg=` in the output) is already part of the offer and the `label`;
`tier` — the plugin tier: `builtin` (the app's directory), `local` (`Plugins/local`), and for installed ones `official`
or `community` — by the verified signed catalog **at check time** (the id is named `official`, the archive sha256 is the
same as in `plugins.lock`, the files on disk are exactly that archive), never from the plugin metadata and not from a
lock entry alone; if the registry owner demoted the tier, after `POST /registry/fetch` the plugin runs as `community`;
`trusted` = `builtin` or `official`;
`session`: `{id, pid, verified: true|false|null, label?: "signature not verified"}` (`label` in the hub language; `null` — the check is still running).

### `GET /events` — app, cli (SSE)
`text/event-stream`. Each event: `id: <seq>`, `event: <type>`, `data: <JSON>` (the JSON carries the same `id`, `type`,
`ts`). Every 15 s — a `: ping` comment. On connect a `snapshot` arrives (`{state: <as GET /state>}`); with a
`Last-Event-ID` header — the missed events from a buffer of the last 500, if they are there, otherwise a `snapshot` again.
In a replay the `plugin` event carries the plugin's **current** state (the buffer does not store frame snapshots), and
events of an already removed plugin are skipped — its `plugin.removed` follows in the same tail.
`seq` is an integer starting at the daemon start timestamp (ms × 1000, fits in 2^53): the previous instance's numbers are
always below the new instance's start, so after a daemon restart the client gets a `snapshot`, not a foreign tail.

| `event` | `data` |
|---|---|
| `snapshot` | `{state}` |
| `plugin` | `{plugin: <plugin state>, status: <worst status>}` — only when the plugin state changed |
| `plugin.removed` | `{plugin: id, restart?: true}` — `restart`: the host removed the plugin to restart it (the same id on disk; it comes back with the next `plugin`), this is not a removal; if it does not come back, a `plugin.removed` without `restart` follows |
| `sessions` | `{sessions: [...]}` |
| `estop` | `{on: bool}` |
| `action` | `{action: id, ok, plugin, primitive}` |
| `event.raised` / `event.cleared` | `{plugin, key: "<plugin>:<key>", status?}` — from plugins' `event=` and `plugin-error` |
| `push.notify` | `{notifyId, title, subtitle, body, plugin, key, digest}` — show a macOS notification (the push service, [`daemon/lib/push/README.md`](../daemon/lib/push/README.md)); the shell shows a banner and answers `POST /push/ack` |
| `hook.card` / `hook.card.removed` / `hook.paused` | session answer cards, metadata only ([`hook.md`](hook.md)) |
| `app-pin.changed` | `{appPin: <as in /state>, old: "<fingerprint>"}` — `requirements.app` changed (a build was re-pinned) |
| `app-pin.path-changed` | `{appPin: <as in /state, with path>, old: "<previous path>"\|null}` — `appPin.path` changed with the same requirement (the bundle the daemon launches); connections are not dropped |
| `hub.stopping` | `{reason: "shutdown"}` — the daemon is stopping on `POST /shutdown` (the app is quitting); connections close next |
| `app.restart-stopped` | `{restarts, windowMs}` — the app keeps crashing, supervision (the app service) stopped restarting it; the push service → a notification |
| `settings.changed` | `{lang: {setting, effective, system}}` — the hub language changed; `{checkPluginUpdates: bool}` — the "Check for plugin updates" switch; `{notifications: <as in /state>}` — "Settings → Notifications" |
| `hub-update.status` | `{hubUpdate: <as in /state>}` — something in the hub update changed: the check, the available version, installation progress, the hub pause (`blocked`) |
| `hub-update.available` | `{version, tag, from}` — a new release was found; once per version (`HubUpdate/check.json`), push "A new Agent Hub version is available" |
| `hub-update.restarting` | `{label, op}` — the hub is switching to another version: the app quits by itself **without** `POST /shutdown` |
| `hub-update.installed` | `{label, from, op, cdhash}` — the new version is confirmed (its app opened the stream); push "Agent Hub updated" |
| `hub-update.failed` | `{label, from, op, error, log}` — the installation or rollback failed; push "The Agent Hub update failed" |
| `hub-update.ready` | `{label, op, waiting, notify}` — the version is built and verified, but cards are waiting: restart only via `POST /hub-update/switch`. `notify: true` — the first time for this version (`HubUpdate/check.json → readyNotified`, only `op: install`): push "A new Agent Hub version is built — waiting for restart" (`@hub:hub-update-ready:<label>`) |
| `hub-update.tag-moved` | `{version, tag, old, new}` — the tag of the version the hub would offer moved to another commit; push "Agent Hub release tag moved" (immediately, during quiet hours, banner bypassing the shell) |
| `connections.changed` | `{connections: <as in /state>}` — an OAuth connection changed state: sign-in started, completed, cancelled, expired, "Disconnect", a new MCP call (`calls24h`, `nextAt`, `why`); no tokens (section "Connections") |
| `idle.verdict` | `{idle: <as in /state>}` — the "can I shut down" verdict, its lines or "checked" changed (the idle service; recomputed on any bus event, at most once per tick) |
| `action.started` | `{action, plugin, actionId}` — a plugin action started running; the end is the `action` event |
| `plugins.busy` | `{busy: [{id, op: "install"\|"update", title, version, since}]}` — a plugin installation / update started or ended (downloading and checking the archive, writing files) |
| `plugins.own-request` | `{requestId, plugin, version}` — a new own-plugin request; `{requestId, plugin, done: installed\|declined}` — the request is gone. The shell re-reads `/registry/installed` |
| `plugins.own` | `{plugin, status}` — the state of an own plugin's folder changed (`ok`, `update`, `paused`, `missing`, `broken`) |
| `plugins.own-updated` | `{plugin, version, from, files}` — an own plugin's folder changed without new permissions, and the hub installed the new copy by itself (no consent window); the push service shows "Plugin updated — "<title>" updated to <version>" (`@hub:plugin-own-updated:<id>:<version>`, kind `updates`) |
| `plugins.updates` | `{pluginUpdates: <as in /state>}` — something in `pluginUpdates` changed: the list of available updates, a check error, the next check time (including a retry after the same error), the switch or the hub language (titles) |
| `plugins.update-available` | `{plugin, title, installed, version, permissionsGrow}` — a new version of an installed plugin, **once** per "id@version" (also across restarts: `Registry/updates.json`); the push service → a macOS notification "Update available: Builder 0.4.1" — the title from the verified catalog in the hub language, as in the popover (`@hub:plugin-update:<id>:<version>`, no flap window) |
| `bridge.connected` / `bridge.disconnected` / `bridge.op` / `bridge.launch.registered` / `bridge.launch.timeout` | the cmux bridge and session launches ([`bridge/README.md`](../bridge/README.md)); `bridge.disconnected` with `reason: "stale"` — the bridge stopped polling without `bye`, `bridge.connected` with `reason: "resumed"` — it is polling again |
| `usage.updated` | `{ok, error}` — the usage service refreshed the quota cache (`error` — a code or `null`; no rows and no token) |
| `plugins.catalog` / `plugins.installed` / `plugins.removed` / `plugins.blocked` / `plugins.quarantined` | the plugin manager ([`plugins-registry.md`](plugins-registry.md)) |
| `<ext>.*` | other extension events (`source` — who sent it) |

### `POST /actions/:id` — app, cli
`:id` is an `offer.id` from `/state` (a plugin offer: the arguments come from the offer, `args` from the body are
ignored) **or** a primitive name (`open.url`) with arguments in the body. A declared plugin action (`<agenthub.action>`)
can only be called through an offer.

Body: `{"args": {...}, "confirmToken": "…"}` (both optional).

The order of core checks: target → peer class → hub pause (estop) → arguments of a direct primitive call → `verifyFacts`
→ confirmation → run. Arguments are checked **after** the peer class: `POST /actions/session.stop` with an empty body from
cli gets `403 peer:cli`, not `400 args:…` (UI pass 2026-11-05).

- Level `immediate` and not app-only — `app` and `cli`.
- Levels `confirm`/`confirm-cost` and app-only primitives (`session.respond|launch|stop|interrupt`, `process.*`) —
  **`app` only**; otherwise `403 peer:cli`. Actions of non-built-in plugins — **always `app` only**, at any level (the
  offer has `"appOnly": true`): an official (or own) plugin without declared network access may declare `immediate`
  (since 2026-11-09 — for example, a mode toggle) — then without a confirmation window, but not from cli; with network
  access or a price on the action (`cost=`) — at least `confirm-cost`.
- The core decides on confirmation: the first request without a token →
  `428 {"error":"confirm-required","needsConfirm":true,"token":"…","level":"confirm","text":"<core text>","cost":null|"…","expiresInMs":120000}`.
  The app shows `text`/`cost` in an `NSAlert` and repeats the request with `confirmToken`. The token is single-use,
  lives 120 s, and is bound to the action with its arguments, to the plugin action fingerprint (command, level, argument
  pattern, plugin version and tier) and to the requester's pid: a token issued for one version's text gives
  `403 confirm:invalid` after the plugin is updated.
- Success: `200 {"ok":true|false,"result":{…scalars only…}}`. After the action a standard plugin is restarted, a
  streamable one gets `actionResult` on stdin.
- A plugin action: the core writes the confirmation text in the hub language (`lib/i18n.mjs`) —
  `«<название>» (<уровень>) просит: «<title>» для <значение>. Выполнится: <команда>` / `"<title>" (<tier>) asks to: …`,
  where the command is shown as it will run: the value replaces the word `{name}`, or without it goes at the end
  (`my-tool.30s.mjs --action skip ABC-1`); the price comes from the core (`confirm-cost`: "The command may access the
  network: <hosts>") plus the author's words marked "According to the plugin: …". `title`/`cost` are taken in the hub
  language from the `title-xx`/`cost-xx` metadata, if present; all variants are part of the action fingerprint, so a
  language change does not cause `facts:action-changed`. Before the confirmation and the run the core re-reads the plugin
  file metadata from disk: an argument that does not match the current pattern — `409 facts:bad-arg`; the command, level,
  pattern, version or plugin tier changed (the file was replaced before a rescan, updated, demoted) —
  `409 facts:action-changed`. The command is argv without a shell, the argument value is a separate element. `result`:
  `code`, `timedOut`, `durationMs`, `reason` (the action's last stdout line `reason=<code>` — the plugin's own
  machine-readable refusal reason) and `message` (contract 2: a `message=<text>` line among the last 5 stdout lines — an
  explanation for the human in the hub language, the plugin gets `AGENTHUB_LANG`; cleaned like `activity=` phrases, up to
  120 graphemes). The shell shows a refusal as ""<button>": <message>"; without `message` — "the plugin refused
  (<reason>)". The hub has no texts of its own for specific plugins' codes.

### `POST /estop` — app, cli (hub pause)
In the UI it is «Пауза хаба» / "Pause hub", lifting it — «Снять паузу» / "Resume hub" (the button, the banner, the icon
menu and the app menu use one label); the internal name of the route, event and file is still `estop`/`ESTOP`.
`{"on": true}` — turn on (any of app/cli, `agenthub pause`; creates the file `<home>/ESTOP`). `{"on": false}` — lift,
**app only** (or delete the file by hand). Response `{"estop": bool}`. The pause can also be turned on by creating the
file — the daemon sees it right away (fs.watch) and checks it on every action.
Contract 3: every plugin run gets `AGENTHUB_PAUSED=1` while paused and `0` otherwise, and setting or lifting the pause
(both by route and by file) restarts plugins, like a language change: streamable ones from scratch, interval ones out of
turn, with `AGENTHUB_REFRESH_REASON=Paused|Resumed`. This way a plugin with deferred background work (for example,
typing a command into a tab once the session is free) holds it back while paused.
While paused: all actions except `open.url`/`open.file` (`safeUnderEstop`) → 423 — answering sessions from the hub,
launching, interrupting and stopping sessions, switching to tabs (`session.focus`, `terminal.focus`; `cmux.focus` — its
deprecated alias),
plugin action buttons, installing and updating plugins; `/hook` → `{}` (sessions ask in the terminal as usual; handlers
still receive `SessionStart`, `SessionEnd` and `Stop` while paused — the interactive session registry stays in sync with
Claude). Statuses, plugin polling, notifications, opening links and files, and removing plugins keep working.

### `GET /settings` — app, cli; `PUT /settings/lang`, `PUT /settings/plugin-updates`, `PUT /settings/hub-updates`, `PUT /settings/launch-at-login`, `PUT /settings/notifications` — app only
The hub language (UI pass 2026-11-05). `GET` → `{"lang": {"setting": "system"|"ru"|"en", "effective": "ru"|"en", "system": "ru"|"en"}, "checkPluginUpdates": {"setting": true}}`
(the same as `GET /state.lang`). `PUT /settings/lang {"lang": "system"|"ru"|"en"}` → `200 {"lang": {...}}`;
cli — `403`, an invalid value — `400 args:lang:enum`. Stored in `<home>/settings.json` (0600) — not in `config.json`,
which the build pin watches. "system" = ru if the first macOS language (`defaults read -g AppleLanguages`) is Russian,
otherwise en; re-checked once a minute. On a change — the journal record `settings-changed`, the SSE event
`settings.changed {lang}`, plugins get the new `AGENTHUB_LANG` (streamable ones restart — consecutive changes are chained,
one process; interval ones run out of turn), plugin labels from metadata are translated, and the texts of
confirmations, hook refusals and notifications are built in the new language.

`PUT /settings/plugin-updates {"enabled": true|false}` — "Check for plugin updates" (same place,
`settings.json → checkPluginUpdates`, `true` by default) → `200 {"checkPluginUpdates": {"setting"}, "pluginUpdates":
<as in /state>}`; cli — `403 peer:cli`, not a boolean — `400 args:enabled:type`. Journal `settings-changed`
(`key: checkPluginUpdates`), events `settings.changed {checkPluginUpdates}` and `plugins.updates`. Turned on — the first
check in ~1 min; turned off — no network and no notifications (the already known list stays in `/state`).

`PUT /settings/hub-updates {"enabled": true|false}` — "Check for hub updates" (`settings.json → checkHubUpdates`, `true`
by default; 2026-11-06, [`hub-updates.md`](hub-updates.md)) → `200 {"checkHubUpdates": {"setting"}, "hubUpdate": <as in
/state>}`; cli — `403`, not a boolean — `400 args:enabled:type`. Journal `settings-changed` (`key: checkHubUpdates`),
event `settings.changed {checkHubUpdates}`. `GET /settings` also returns `checkHubUpdates: {setting}`.

`PUT /settings/launch-at-login {"enabled": true|false}` — "Launch at login" (`settings.json → launchAtLogin`, `true` by
default; decision 2026-11-07): the daemon + app pair → `200 {"launchAtLogin": {"setting"}}`; cli — `403`, not a boolean
— `400 args:enabled:type`. Journal `settings-changed` (`key: launchAtLogin`), event `settings.changed {launchAtLogin}`;
`GET /settings` and `/state` return `launchAtLogin: {setting, launchAgent?}`. It takes effect at the next daemon start
(how — "App supervision", item "Launch at login"). The app's former registration in "Login Items"
(`SMAppService.mainApp`) is not needed — the shell removes it, but only based on a state snapshot showing that the
daemon will launch the app at login: `launchAtLogin` is present, `appPin` has a `path`, `launchAgent` is not `missing`.
Otherwise the registration stays (the "run agenthub pin-app" banner says what is missing).

`PUT /settings/notifications` — "Settings → Notifications" (`settings.json → notifications`, 2026-11-09;
`daemon/lib/push/prefs.mjs`, [`daemon/lib/push/README.md`](../daemon/lib/push/README.md)). The body is a partial edit:
`{"enabled"?: bool, "kinds"?: {"sessions"|"updates"|"problems"|"other": bool}, "plugins"?: {"<plugin id>": bool},
"quiet"?: {"enabled"?: bool, "start"?: "HH:MM", "end"?: "HH:MM"}}` → `200 {"notifications": <as in /state>}`. cli and an
unpinned build — `403`; errors — `400`: `args:body:type|keys`, `args:enabled:type`, `args:kinds:type`, `args:kinds:enum`
(including `security` — security exceptions cannot be turned off — and the former contract 1 kinds `runs`/`night`),
`args:plugins:type|id|too-many`, `args:quiet:type|keys|time`, `args:quiet:empty` (start = end).

**Contract 2 (2026-11-09).** There are four core kinds — `sessions`, `updates`, `problems`, `other` (plus the
non-switchable `security`). Everything a plugin declared with `kind="plugin"` is silenced by **its own toggle** —
`plugins.<id>`; the daemon builds the `notifications.plugins: [{id, title, on, labels, legacy?}]` lines from installed
trusted plugins with such rules (the title in the hub language, `labels` — the labels of its rules): no plugin — no
line. Migrating former settings: turned-off `kinds.runs`/`kinds.night` in `settings.json` turn off the toggle (without an
explicit choice) of a plugin whose rule declared that kind (`kind="runs|night"` — a deprecated synonym, or
`kind="plugin" was="runs|night"`); such an inference is fixed right away as an explicit `plugins.<id> = false` (journal
`settings-migrated {plugin, from}`), and the line is marked `legacy: true` until the human touches it. The migration
happens once (only for plugins installed at the first scan) and survives a hub rollback to a contract 1 core: in
`settings.json` the turned-off `runs`/`night` stay in `notifications.kinds`, and the plugin toggles live in the top-level
key `pluginNotifications` ([`daemon/lib/push/README.md`](../daemon/lib/push/README.md), "Migration"). Journal
`settings-changed` (`key: notifications`, `value` — the edit body), event `settings.changed {notifications: <in full>}`;
the push service applies it right away. `GET /settings` and `/state` return `notifications`: `enabled`, `kinds`,
`plugins`, `quiet` with `from` (`settings` — set here; `config` — `services.push.quietStart/quietEnd` from config.json
while nothing is set here; equal start and end there mean "no quiet hours", `enabled: false`; `default` — 23:00–08:00)
and `timezone` (the zone in which the daemon computes quiet hours: `services.push.timezone` or the system one),
`awayAfterMs` (the idle threshold after which the human counts as away from the Mac, `services.push.idleThresholdMs`:
quiet hours then hold banners for the digest), `security` — the list of what cannot be turned off (hub events and trusted
plugins' rules with `kind="security"`: `key`, `plugin`, `pluginTitle?`, `label` in the hub language), `service` (the push
service is not turned off in config.json). macOS banners are the only channel (a daemon before 2026-11-11 also sent a
flag for a second channel; the app ignores unknown keys). A turned-off kind does not arrive at all — no `push.notify`, no osascript, no
digest; it stays in the plugin's `/state` and in the journal (`push-muted`).

### Connections — `GET /connections` (app, cli), `POST /connections/:id/connect|cancel|disconnect` (app only), `POST /connections/:id/mcp` (a plugin process)
The hub signs into external services via OAuth 2.1 and calls their MCP servers on behalf of plugins (the `oauth`
service, `daemon/lib/services/oauth.mjs`, `lib/oauth.mjs`, `lib/mcp-client.mjs`; routes — `lib/routes/connections.mjs`;
decision 2026-11-09). **The core does not know which connections exist** (contract 2): plugins declare them themselves
with the tag `<agenthub.connection id=… type="mcp" url="https://…" scope=… tools=… interval=… budget=… title=…>why</…>`
([`extension-points.md`](extension-points.md)). The core takes a declaration only from trusted plugins
(builtin/official/own), with the plugin id or `<plugin id>.<name>` (the whole id starts with a letter, up to 64), and
only if the `url` host (and the authorization server `hosts`) is in the plugin's `<agenthub.net>`; otherwise — the
journal record `connection-rejected {plugin, connection, why: id|net|duplicate|taken}` and no connection. A plugin
restart (`plugin.removed` with `restart: true`) does not touch the connection: an ongoing sign-in and the result cache
stay. If the plugin was removed (or stopped declaring the connection) but the sign-in remains in the keychain, the
connection is **orphaned**: listed with `orphan: true`, only `disconnect` (`connect` — `409 oauth:orphan`, plugin calls —
`409 oauth:orphan`); after a daemon restart such connections are found via `Cache/oauth-<id>.json` (call timestamps,
plugin id and title, no tokens); "Disconnect" removes the sign-in, the line and this file (journal
`connection-orphaned`). If the plugin comes back, it is a regular connection again with the previous sign-in. Removing a
plugin "with data" (`POST /registry/remove` with `purge`, event `plugins.removed {purge: true}`) also removes the
sign-in of its connections (journal `connection-purged`). For an own plugin a connection is a `connections` permission
in the consent window (address, scope, allowlist; anything new is a permission increase). No service —
`503 oauth:disabled`; an unknown `:id` — `404`. The examples below use a `tix` connection to
`https://mcp.example.com/mcp`.

**Sign-in** (`POST /connections/tix/connect`, no body needed) → `200 {authorizeUrl, expiresAt, connection}`. The shell
opens the `authorizeUrl` page (the default browser); the confirmation happens on the service's site, the hub shows no
window of its own. Before that the core:
- discovers the authorization server: a request without a token → `401` with `WWW-Authenticate … resource_metadata=` →
  resource metadata (RFC 9728; only from the same origin as the resource; `resource` must match) → server metadata
  (RFC 8414; `issuer` must match). Without `S256` in `code_challenge_methods_supported`, without
  `registration_endpoint` or without `none` among the client authentication methods — refusal `oauth:discovery`. All
  addresses are https on the connection's hosts (the `url` host and `hosts` from the declaration); in test mode also a
  double on 127.0.0.1/localhost. Metadata is cached for an hour;
- registers a **public** client (RFC 7591: `token_endpoint_auth_method: none`, no client_secret; `grant_types` — the
  intersection of `authorization_code`, `refresh_token` with what the server declares — sometimes only
  `authorization_code`; both 200 and 201 responses are success). The registration is kept and reused at the next sign-in
  if the same receiver port is free (otherwise a new registration with a new redirect address);
- starts a **temporary receiver** `http://127.0.0.1:<random port>/oauth/callback` — the only place where the daemon
  listens on TCP: 127.0.0.1 only, only `GET` on this path, a 5 min lifetime (`loginTimeoutMs`), one acceptance: the first
  request with the correct `state` (constant-time comparison) and the correct `iss` (RFC 9207: if the server declared
  it, a response without `iss` is not accepted) closes the receiver; a foreign `state` — `400`, the sign-in keeps
  waiting; `error=access_denied` — the sign-in is cancelled;
- PKCE `S256` (verifier — 32 random bytes), `state` — 24 bytes, `scope` — the words from the plugin declaration that the
  server lists (for example `read`: then the server itself enforces "read-only"), `resource=<MCP address>` (RFC 8707).
  The code, verifier and state live only in memory.

The code exchange (`code_verifier`, `resource`, `redirect_uri`, `client_id`) happens before answering the browser: the
page tells the truth ("<name from the declaration> connected — you can close this tab" / "it did not work"; the name is
escaped), in the hub language. Errors (`connection.error` and the route response `error`, `oauth:<code>`): `discovery`
(the details are in the response `reason` and `connection.errorReason`: `resource-mismatch`, `issuer-url`, `no-s256`,
`no-public-client`, …; `no-resource-metadata`/`no-as-metadata` can also come from a server failure), `register`,
`exchange`, `invalid-grant`, `denied`, `iss-mismatch`, `timeout`, `keychain`, `keychain-read` (`503`: the keychain did
not answer), `no-keychain` (`409`: the secrets service is off, or in test mode there is no `security` double), `net`,
`http`. `POST …/cancel` — abort an ongoing sign-in (the state returns to what it was). A repeated `connect` aborts the
previous sign-in.

**Storage.** The client registration and tokens live **only in the keychain**, through the `secrets` service (the
`secrets.store` fact): service `agent-hub.oauth`, entries `<id>.client` and `<id>.token` (the connection id; before
contract 2 the same names — an existing sign-in is kept), the value is JSON in base64url. A token remembers the resource
address it was issued for (`resource`): if the plugin changed `url`, the old token is not sent to the new address, the
connection becomes `disconnected` (journal `oauth-resource-changed`), and a new sign-in is needed. An entry from before
contract 2 does not remember an address: on first read it is bound to the declared address (journal
`oauth-resource-pinned`) if a built-in or official plugin declared the connection; for an own plugin it is not accepted
(journal `oauth-resource-unknown`, a new sign-in is needed): an own plugin with the same id could have appeared after the
official one was removed. Writes go through stdin of `security -i` (`lib/keychain.mjs`), not argv. `oauth.*` keys are
never given to plugins (`denyReason` → `reserved`, including a plugin with id `oauth`). Neither the token, the code nor
the verifier ever reaches the journal, the bus, SSE, `/state`, route responses or plugins; the service reads the token
itself from the keychain on every call. `security -i` reads a line of at most 4095 characters: a longer entry is not
written as one line (`writeItem` → `too-large` without calling `security`, the previous entry stays intact), and the
store splits the value into parts `<entry>.<a|b><n>` with a header `parts_<generation>_<n>_<sha256>` (the header is
written last, the parts of the previous generation are deleted afterwards). A keychain read failure (timeout, a locked
keychain, a code ≠ 44) is not "no entry": at startup the connection stays `unknown` with the `keychain-read` error and is
re-read after `reloadMs` (60 s) or on a plugin call; during a call — an `error` backoff, without marking a sign-in
failure. **"Disconnect"** (`POST …/disconnect`) deletes both entries; if the token was not deleted —
`500 oauth:keychain-delete`, the state is unchanged (the sign-in stays in the keychain), and the "Disconnect" button
stays. The hub does not try to revoke the granted access on the service side (MCP servers usually do not declare a
`revocation_endpoint`) — the shell suggests doing it in the service's settings.

**Expiry and revocation.** If the server issued a refresh token, the service refreshes access itself (ahead of time if
less than 1 min remains, and on a `401` from MCP; a new refresh token replaces the old one — rotation; only the core
refreshes). No refresh token (the server did not issue one), it was revoked (`invalid_grant`) or the server answered
`401` — the `expired` state: the shell says "Sign-in expired or access revoked — connect again", the plugin gets
`409 oauth:expired`, journal `oauth-expired`. A network failure or `5xx` during refresh is not expiry: the plugin gets
`200` with `error: oauth:refresh`, an `error` backoff, the refresh token is intact. A `403` from MCP (except
`invalid_token`; `insufficient_scope` — the sign-in lacks permissions) is not expiry either: `error: mcp:forbidden`,
`connection.error: forbidden` (`errorReason` — the error from `WWW-Authenticate`), a `why: forbidden` backoff for an
hour.

**An MCP call on behalf of a plugin** (`POST /connections/tix/mcp {tool, args}`, peer class `cli`). The core recognizes
the plugin by the peer pid on the socket (the `pluginByPid` fact: a running standard run or a streamable process, not an
action and not a descendant); the plugin must be **trusted** (builtin/official/own), **the one that declared the
connection**, and have the service host in `<agenthub.net>`; the tool must be on the declaration's allowlist
(`tools=`). Refusals: `403 mcp:not-a-plugin|mcp:untrusted|mcp:not-owner|mcp:net-not-declared|mcp:tool-not-allowed`,
`400 args:tool:required|args:args:type`, `413 too-large` (arguments > 8 KB),
`409 oauth:not-connected|oauth:expired|oauth:unavailable` (with `connection`). A `200` response:
`{ok, result: <the tools/call result: content, structuredContent?> | null, fetchedAt, nextAt, why, intervalMs,
calls24h, dailyBudget, fresh, pending?, error?, errorText?}`. A result with `isError` (not a rate limit) is not a
successful refresh: it is not stored in memory, `lastOkAt` does not move, the previous result stays,
`error: mcp:tool-error` and `errorText` — the service text as one line up to 300 characters (repeated in answers from
memory until a successful call), a `why: tool-error` backoff. The protocol is Streamable HTTP: `initialize` and
`notifications/initialized` once per session (`Mcp-Session-Id`, `MCP-Protocol-Version`), the response is JSON or SSE; if
the server forgot the session (`404`) — one retry with a new one.

**The core enforces the rate, not the plugin.** The same request (plugin + tool + arguments) runs at most once per
`intervalMs` (`interval=` from the declaration, 15 min by default; the core keeps it within 5 min … 24 h); between calls
the plugin gets the previous result from the service's memory (`fresh: false`). Daily budget: at most `dailyBudget − 4`
calls in 24 h (`budget=` from the declaration, 100 by default; core limits 1…10000; the core knows nothing about the
service's plans) (`why: budget`). A service rate limit — `RATE_LIMIT_EXCEEDED` in a JSON-RPC error or in a tool result
(`retryAfter` — seconds, ms or an epoch timestamp; 1 min … 24 h), `429` with `Retry-After` — backoff (`why: rate-limit`;
without `retryAfter` — 15 min → 30 min → 1 h → 3 h → 6 h); `x-ratelimit-remaining ≤ 2` — wait for
`x-ratelimit-reset` (`why: http-limit`); other failures — 1 → 2 → 5 → 10 min (`why: error`). If the service does not
answer within `callWaitMs` (3 s) — `pending: true`, the call completes in the background and lands in the service's
memory. Call timestamps, the backoff and the sign-in failure mark survive restarts: `<home>/Cache/oauth-<id>.json` (0600;
only times — at least as many timestamps as the daily budget, otherwise a budget above 500 could not be enforced — plus
the plugin id and title, no tokens or content). Response content lives only in daemon memory. Journal:
`mcp-call {connector, plugin, tool, ok, error?, ms}`, `mcp-call-failed {kind, status, waitS}`, `mcp-denied`.

`/state.connections` and `GET /connections` → `[{id, title, note, plugin, orphan?, host, tools, state, since, error,
errorReason, scope, expiresAt, refresh, login: {startedAt, expiresAt} | null, intervalMs, dailyBudget, calls24h,
lastOkAt, nextAt, why, keychain}]`; `state`: `unknown` (the keychain has not been read yet), `unavailable` (no keychain),
`disconnected`, `connecting`, `connected`, `expired`; `title` and `note` come from the plugin declaration in the hub
language (without `title=` — the plugin name). A change — the `connections.changed {connections}` event; appearance and
disappearance — journal `connection-added`, `connection-removed`. The sign-in journal: `oauth-login-start {port,
scope}`, `oauth-client-registered {grants}`, `oauth-connected {scope, refresh, expiresInS}`,
`oauth-login-failed {error}`, `oauth-login-cancelled`, `oauth-refreshed {rotated}`, `oauth-refresh-failed`,
`oauth-disconnected`; the secrets service — `secret-store {op, account, ok}`.

Settings (`config.json → services.oauth`): `enabled`; `<id>.intervalMs` and `<id>.dailyBudget` — over the plugin
declaration, within the same core limits; `<id>.loginTimeoutMs` (300000), `<id>.callWaitMs` (3000), `<id>.reloadMs`
(60000 — re-read the keychain if it did not answer at startup); in test mode — `<id>.resource` and `<id>.hosts` (a double
on 127.0.0.1; overriding is not accepted in the live hub). The service gives trusted plugins the `AGENTHUB_HUB_SOCKET`
variable — the hub socket path.

### Terminal — `POST /terminal/read-screen`, `POST /terminal/send-text` (a trusted plugin process, contract 3)

"Read the tab screen" and "type a line into the tab" of a Claude Code session (the `terminal` service,
`daemon/lib/services/terminal.mjs`; routes — `lib/routes/terminal.mjs`; the terminal layer — `lib/terminals/`: the cmux
adapter runs operations through the bridge, [`bridge/README.md`](../bridge/README.md), the tmux adapter through the tmux
CLI; iTerm2 and Terminal.app do not support these routes — `409 terminal:unsupported {terminal, capability}`). Class `cli`, but only the
plugin's own process is admitted — a running run, a streamable process or a running action (the fact
`pluginByPid(pid, {actions: true})`: the peer pid from the kernel) — of a trusted plugin (builtin/official/own) that
declared `<agenthub.terminal>`: `read-screen` for the first route, `send </commands>|*` for the second (by command — a
declared slash command at the start and at most 3 arguments from `[A-Za-z0-9._:[]-]`; with `*` — any line except a
leading `!`, `#`, `&`). Why not a primitive: control primitives are accepted only from the app and with a confirmation,
while a plugin also needs background typing per its own setting; the human granted the permission once in the consent
window (as a red line).

| Route | Body | 200 |
|---|---|---|
| `POST /terminal/read-screen` | `{sessionId, lines?}` (1…30) | `{ok, sessionId, terminal, idle, foreground, promptFound, promptEmpty, busy, ready}` — flags only, no screen text |
| `POST /terminal/send-text` | `{sessionId, text}` | `{ok, sessionId, terminal}` |

Checks in order: the plugin and permission (`403 terminal:not-a-plugin|untrusted|not-declared`), the plugin's overall
request rate (`429`, `scope: requests`), the pause (`423 estop`), the body (`400 body`, `args:sessionId:*`,
`args:<field>:unknown`, `args:text:too-long`, `terminal:bad-text` — not printable ASCII, `\`, leading/trailing spaces),
the line against the permission (`403 terminal:text-not-declared`), the session in the registry
(`409 terminal:unknown-session`), the Claude Code signature now and the same start time (`409 terminal:unverified`), the
terminal knows the tab and it belongs to the same pid and start time (`409 terminal:no-tab|pid-mismatch`), the terminal
supports the operation (`409 terminal:unsupported`, with `terminal` and `capability`), for typing —
the session is free (`409 terminal:session-busy`: the registry status, without it — the terminal's), the process is not
stopped and is in the foreground of its terminal (`409 terminal:not-foreground|process-unknown`) and the typing rate per
plugin and per tab (`429`, `scope: plugin|tab`). Then the terminal:
`409 terminal:bridge-offline|no-tab|prompt-not-found|prompt-not-empty|session-busy|prompt-mismatch|terminal-test-mode`,
`501 terminal:bridge-outdated` (a bridge without these operations), `502 terminal:cmux-failed|tmux-failed`,
`504 terminal:bridge-timeout|bridge-pickup-timeout|cmux-timeout|tmux-timeout|deadline` (Enter only before the `enterBy` deadline the
daemon puts into the operation; a late bridge answer is `bridge-op-late` in the journal). No service —
`503 terminal:disabled`. Journal: `terminal-send {plugin, sessionId, surfaceId, workspaceId, terminal, tab, len, sha, head,
ok, error}` (`surfaceId`/`workspaceId` — cmux only, `tab` — the adapter's tab key) (head — the declared slash command at the start of the line, sha — 12 characters of the line's sha256, only
together with head; for a line under the `*` permission both are `null`; duplicated in the audit log),
`bridge-op-late {op, opId, sessionId, surfaceId, ok, error, lateMs}` (also in the audit log) and
`terminal-denied {plugin, op, sessionId, error}` (a refusal by the overall rate — at most once a minute per plugin); bus —
`terminal.send {plugin, sessionId, ok, error}`. The whole line and the screen text never go anywhere. Settings —
`services.terminal`: `requestsPerMin` (60), `sendPerMin` (12), `sendPerTabPerMin` (4).

### Hub updates — `GET /hub-update` (app, cli), `POST /hub-update/check|install|rollback|switch` (app only)
Auto-update of the hub itself (daemon + app) by releases — `vX.Y.Z` tags in origin; design, installation steps, rollback
and limits — [`hub-updates.md`](hub-updates.md). The `hub-update` service (`daemon/lib/services/hub-update.mjs`), routes
— `daemon/lib/routes/hub-update.mjs`. No service — `503 hub-update:disabled`.

| Route | Body | Response |
|---|---|---|
| `GET /hub-update` | — | `200 <hubUpdate>` (the same as `/state.hubUpdate`) |
| `POST /hub-update/check` | — | "Check now": `git ls-remote --tags <origin>` (≤ 30 s; the release description from the tag is fetched after the answer, with an overall 15 s budget — a `hub-update.status` will follow; works even with the setting off, but not with `services.hubUpdate.checkUpdates = false`) → `200 {hubUpdate, result: {ok, error, skipped}}` |
| `POST /hub-update/install` | `{"version": "0.3.0", "acceptCommit"?: "<40 hex>"}` | `202 {hubUpdate}` — the build has started in a separate process; progress comes as `hub-update.status` events. If the tag moved to another commit after the hub saw it (`available.moved`) — only with `acceptCommit` = the new commit, otherwise `409 hub-update:tag-moved` |
| `POST /hub-update/rollback` | `{"version"?: "<label>"}` | `202 {hubUpdate}` — switching to `Versions/previous` (or the given built version) without building; only to a build the hub itself pinned for that label (`HubUpdate/history.json`), otherwise `409 hub-update:untrusted-build` |
| `POST /hub-update/switch` | — | `202 {hubUpdate}` — a built and verified version is waiting for a second press (`install.phase: ready`: PermissionRequest cards were waiting) — restart into it now; nothing to switch to — `409 hub-update:not-ready` |

Refusals (`{error, hubUpdate}`): `423 hub-update:estop` (hub paused), `409 hub-update:busy` (an installation is in
progress), `409 hub-update:not-installed` (the daemon runs from a working folder — `agenthub hub migrate`),
`409 hub-update:not-newer`, `404 hub-update:unknown-version` (not the one the check found),
`404 hub-update:no-previous`, `409 hub-update:tag-moved`, `409 hub-update:untrusted-build`, `409 hub-update:not-ready`,
`409 hub-update:ready` (a built version is waiting for a restart: installing the same version or rolling back would
silently throw it away — `switch` first), `400 args:version:*`, `400 args:acceptCommit:type`; cli and others —
`403 peer:<class>`.

`/state.hubUpdate`: `installed` (from `Versions/<label>`), `running` (the code's VERSION), `label`, `current` and
`previous` (`{label, version, tag, commit, builtAt, dirty, cdhash, notes}`), `versions` (built ones, newest first),
`enabled`, `setting`, `config`, `configured` (origin is known), `checkedAt`, `nextCheckAt`, `error` (`hub-update:remote`,
`hub-update:remote-timeout`), `checking`, `available` (`{version, tag, commit, notes?, moved?: {old, new, at}}` or
`null`; tags more than `services.hubUpdate.maxMajorJump` = 1 major version above the current one are not considered),
`install` (`{phase: idle|building|ready|switching|trial|rolling-back|done|failed|rolled-back, op:
install|rollback|migrate, label, step, error, detail, log, from, startedAt, finishedAt, commit, waiting, waitingCards,
waitingSessions}`; during a build `step` is the builder step `clone → build → verify → selftest → promote`, then the
daemon's `verify`, `switch`, `restart`, `confirm`; `waiting` — in `ready`: how many are waiting for an answer (the
larger of `waitingCards` — the hub's PermissionRequest cards, which a restart removes — and `waitingSessions` — sessions
waiting for an answer)), `blocked` (`estop`, `not-installed`, `busy` or `null`). `notes` — the release description:
`{subject, body}` from the message of the annotated `vX.Y.Z` tag (a lightweight tag or a tagless build — `null`/absent),
data from origin: subject ≤ 200 characters, body ≤ 2000, control characters removed; the shell shows them as plain text,
without markup. Installation error codes beyond those in [`hub-updates.md`](hub-updates.md): `not-on-main` (the tag
commit is outside origin's release branch), `no-space`, `untrusted-build`, `tag-moved`, `state-write` (`install.json` was
not written — the switch did not start), `interrupted` (including the daemon stopping while the app was leaving).

During the switch (`phase: switching`) a `POST /shutdown` from the departing app answers 202 but does not stop the
daemon: it exits by itself with code **75**, and launchd brings it up from `Versions/current` (the new version).

### `POST /shutdown` — app only (daemon and app lifecycle, 2026-11-06)
"We close the hub — we close the daemon too": on quit (the "Quit Agent Hub" item in the icon menu and the popover, ⌘Q,
logout) the pinned app asks the daemon to exit. No body needed. The response `202 {"ok":true,"stopping":true}` goes out
**before** stopping; then the same stop as on SIGTERM (`daemon/lib/lifecycle.mjs`), and exit with code **0**. The
LaunchAgent (`KeepAlive = {SuccessfulExit: false}`) does not restart a normal exit, but does restart a crash (code ≠ 0).
cli, hook, bridge and an unpinned build get `403 peer:<class>` (`peer:app-signature`), and the daemon keeps running. A
repeated request during the stop gets 202 again. The record `shutdown-requested` (`peer`, `pid`; duplicated in the audit
log), the SSE event `hub.stopping {reason: "shutdown"}`, then `stop` with `reason: "shutdown"`.

What others see during the stop: connections close, the socket is removed. A pending `PermissionRequest` hook loses its
connection — `agenthub-hook` prints `{}` and exits with code 0 (a fraction of a second), Claude Code shows its regular
permission dialog in the terminal. A new hook no longer sees the socket — `{}` right away («демон не запущен»), see
[`hook.md`](hook.md).

**Who brings the daemon up again:** RunAtLoad at login; the app itself at startup — if there is no socket or the
connection is refused, it runs `launchctl print gui/<uid>/com.kensei.agenthub` (is the job loaded) and
`launchctl kickstart gui/<uid>/com.kensei.agenthub` (without `-k`) and waits up to 10 s for the socket, at most once
every 30 s (if the socket never appears — for example, kickstart hit a process that was still stopping and returned 0
for nothing — the attempt does not count towards the pause, and the next reconnect tries again); a diagnostic run does
not bring the daemon up; no job — the banner "The hub service is not installed — run agenthub install". Only for the
default directory: a test copy (`--home`, `AGENTHUB_HOME`) does not touch launchd.

### App supervision (the `app` service)
"The hub is dead but the daemon is alive — the daemon brings the hub back" (`daemon/lib/services/app.mjs`, logic —
`daemon/lib/app-supervisor.mjs`, platform — `appControl` in `daemon/lib/platform.mjs`). It has no routes of its own.

- **The app crashed or was killed.** The last `app`-class connection closed, its process is gone (pid and start time —
  from the kernel), and no `/shutdown` came → the record `app-lost`; after `restartDelayMs` (2 s) — a check: is there an
  `app` connection or a process at the pinned build's path (the executable in `<bundle>/Contents/MacOS/`: candidates come
  from `ps -x -o pid=,comm=`, where `comm` is only argv[0], and `proc_pidpath` confirms each one's path against the bundle
  realpath) — then nothing (`app-launch-skipped why=connected|running`); if not — `open -g <bundle>` (no shell) and the
  record `app-launch reason=lost`. The process is alive (a re-pin closed the connections, the stream dropped) — wait for
  a reconnect, but look again after `verifyMs`: if the process disappeared without ever connecting, it is a crash
  (`app-lost later=true`, `app-launch reason=lost-later`, counted towards the limit). While there is a process but no
  connection (including after launch until the first connection), the check repeats every `verifyMs`.
- **Diagnostic runs** of the pinned build (`--probe-peer`, `--snapshot-panel`, `--quit-after-snapshot`,
  `--snapshot-menubar`, `--print-status-item`, `--show-popover`, `--self-test-*` in argv) are class `app`, but
  supervision does not see their connections (`APP_DIAGNOSTIC_ARGS` in `lib/peer.mjs`): such a process exits by itself,
  and its exit is not a crash. In such a run the shell does not bring up the daemon either (`QuitPolicy.startsDaemon`).
- **The daemon started** (RunAtLoad, kickstart) → after `restartDelayMs`: no app — launch it (`app-launch
  reason=start`); started at the app's own request — the process is already there, nothing to do.
- **"Launch at login" is off** (`settings.json → launchAtLogin: false`, decision 2026-11-07) — neither the daemon nor
  the app starts at login. launchd still brings up the daemon (RunAtLoad), so the daemon tells a login apart from a
  kickstart requested by the app itself: after `restartDelayMs` it looks for the app — an `app`-class connection, a
  process at the pinned build's path or any open `GET /events` stream (an unpinned copy is class `cli`). Found —
  `app-login-gate decision=stay why=connected|running|stream`, the daemon stays (a process without a connection — then
  the regular `lost-later` check). `ps` did not answer — `app-login-gate decision=retry why=unknown`, a retry after
  `verifyMs`, but no later than `loginGraceMs` from start; if it still has not answered by the deadline — decide by
  connections and streams. Not found — `app-login-gate decision=wait ms=…` and once more after `loginGraceMs` (30 s) from
  the service start (after a kickstart the app waits up to 10 s for the socket); still nothing — `app-login-gate
  decision=exit`, a normal stop (`stop reason=login-off`, stderr says `"Launch at login" is off and the app did not show up`) with code 0:
  launchd (`KeepAlive.SuccessfulExit=false`) does not restart it. The app is not launched. An old LaunchAgent
  (`KeepAlive true`, a plist from before 2026-11-06; `/state.launchAtLogin.launchAgent = "outdated"`) — do not exit
  (launchd would bring the daemon up again after 10 s, for the whole session): `app-login-gate decision=stay
  why=launch-agent-outdated` and a `warning` "reinstall: agenthub install --apply".
  Exceptions: a start the hub update is waiting for (`hub.update.startVerdict` — `confirm-wait`, `finalize-failed`,
  `restore`: a trial run of the new version and a return to the previous one) launches the app as with the setting on;
  bringing the app back after a switch that did not happen has the reason `relaunch`, bypassing the setting and not
  counted as a crash. If the setting is turned on while the daemon was waiting, the app is launched. A crashed app is
  restarted regardless of the setting; `supervise: false` does not launch the app, but the exit with the setting off
  still applies.
- **After a launch**, after `verifyMs` (15 s) — a check that the app is alive; if not, it is a new crash
  (`app-launch reason=verify`).
- **Limit:** at most `maxRestarts` (3) restarts after crashes within `windowMs` (10 min). Then it stops:
  `app-restart-stopped` (`restarts`, `windowMs`; duplicated in the audit log), the SSE event `app.restart-stopped` and
  the push `@hub:app-restart-stopped` "Agent Hub keeps crashing — restarts stopped: 3 restarts in 10 min. Open Agent Hub
  yourself; details — agenthub logs" (the banner goes straight to `osascript`: there is no app). If the app opens the
  `GET /events` stream as `app` again (a human opened it), it is `app-supervise-resumed`, and supervision is in force with
  a clean window (past restarts are forgotten). A one-off connection (`--probe-peer`: a request and exit) does not lift
  the stop: one `app-restart-stopped` record and one notification per stop episode.
- **A temporary skip** — `why` `unknown` (the process table could not be read), `pin-mismatch` (the wrong signature —
  for example, the bundle is being rebuilt), `verify-error` (`codesign` did not answer within 15 s or did not start),
  `path-missing`, `path-unsafe`: the check repeats after `verifyMs`, at most `maxRestarts` times within `windowMs`; if it
  does not pass — the same stop, `app-restart-stopped why=<reason>` and the push "Cannot launch Agent Hub (<reason>)…".
- **The build path** — only `config.json → appPin.path` (written by `agenthub pin-app`, which `scripts/bundle.sh` calls;
  the path is a realpath), and only if `appPin.requirementSha` matches the current `requirements.app`. No path (`--cert`
  mode, a pin from before 2026-11-06) — the daemon does not launch the app, neither at startup nor after a crash:
  `app-launch-skipped why=no-path` (decision 2026-11-07; there is no longer a fallback "bundle of the last connection" or
  an `app-path-seen` record). The shell sees a pin without `path` in `/state.appPin` and shows the banner "The hub does
  not know where to launch the app from… Run agenthub pin-app" with a ready command. A path is acceptable only if the
  bundle and all directories above it belong to the user (or root) and are not group- or world-writable
  (`appBundleProblem` in `lib/platform.mjs`; otherwise `why=path-unsafe`, and `pin-app` does not record such a path;
  `/tmp` is allowed only in test mode). Before launching, the signature of the bundle on disk is checked against
  `requirements.app` (`codesign --verify --strict -R=…`): not confirmed — no launch (`why=pin-mismatch`, or
  `why=verify-error` if `codesign` gave no answer). Final `why` values: `no-pin`, `no-path`, `test-mode`,
  `unsupported`.
- **A path change** with the same requirement (`agenthub pin-app <a copy of the build in another directory>`) is noticed
  like a pin change (`AppPinWatcher`, `<home>/app-pin.json → path`): the record `app-pin-path-changed` (`old`, `new`,
  `source`; duplicated in the audit log), the SSE event `app-pin.path-changed` (`appPin` with the new `path`, `old`) and
  the push `@hub:app-pin-path-changed` "The path of the pinned Agent Hub build changed" (immediately, during quiet hours,
  banner bypassing the shell). The path is visible in `/state.appPin.path` and in "Settings" next to the fingerprint.
- **Settings** `services.app`: `supervise` (`false` — no supervision, record `app-supervise on=false`),
  `restartDelayMs`, `verifyMs`, `maxRestarts`, `windowMs`, `loginGraceMs` (30000 — how long to wait for the app with
  "Launch at login" off).
- **Test mode** (a non-default directory): the real app is never launched; the LaunchAgent is checked only via
  `services.app.test.launchAgent` (the plist path). Instead of `open` — only the double command
  `services.app.test.launch` (argv without a shell, the bundle path as the last argument); without it —
  `app-launch-skipped why=test-mode`. `services.app.test.processes` — a process table file instead of `ps` (lines
  `<pid> <path>`).

### `POST /plugins/:id/refresh` — app, cli
Restart a plugin (`AGENTHUB_REFRESH_REASON=Manual`). `202 {"ok":true}` or 404.

### `GET /journal?limit=N` — app, cli
`{"entries": [...]}` — the last N (1–1000, 100 by default) records of `journal.jsonl`; right after a rotation the missing
ones are read from the tail of `journal.jsonl.1`. Metadata only.

### `POST /hook` — hook only
The body is the Claude Code hook's stdin as is. The core checks `session_id` against `sessionId` from
`<claudeHome>/sessions/<claudePid>.json` (otherwise `403 peer:session-mismatch`), then calls the `ctx.onHook` handlers
(stage 6) as `h(body, {peer, signal})`; `signal` fires if `agenthub-hook` closed the connection before the answer (Claude
killed the hook — it was answered in the terminal). The response is JSON for the hook's stdout; no handler, a hub pause
or an error → `{}` (while paused, handlers are called only for `SessionStart`, `SessionEnd`, `Stop`, and the answer is
still `{}`). The journal gets `hook_event_name`, `session_id`, `claudePid`, `handled`; `tool_input` — never.

## Extension routes

| Route | Classes | Description |
|---|---|---|
| `GET /hook/cards`, `GET /hook/cards/:id` | app | session permission and question cards — [`hook.md`](hook.md) |
| `GET /hook/status` | app, cli | metadata of cards and interactive sessions — [`hook.md`](hook.md) |
| `POST /actions/session.respond` | app | an answer to a card: `{requestId, decision: once\|deny\|answer, answers?}` — [`hook.md`](hook.md) |
| `POST /push/ack` | app (cli — only with `services.push.acceptCliAck`) | `{"id": notifyId}` → `{ok}`; `400 body`, `403 peer:<class>`. Suppresses the duplicate osascript banner — [`daemon/lib/push/README.md`](../daemon/lib/push/README.md); it does not suppress the `@hub:app-pin-changed` notification (that one never goes to the shell) |
| `GET /registry/catalog`, `GET /registry/installed` | app, cli | the registry catalog and installed plugins — [`plugins-registry.md`](plugins-registry.md) |
| `POST /registry/check-updates` | app | "Check now" for plugin updates: the same check as the background one (a new version is announced once) → `200 {pluginUpdates, result: {ok, error, skipped}}` |
| `POST /registry/own/request` | app, cli | a request for an own plugin from a local folder `{path}` (absolute or `~/…`; a repository root — the plugin from `agenthub/<id>/`) → `200 {pending, requestId, id, title, version, path, pathShort, fingerprint, permissions, migrate}` or `{already}`; it installs nothing. Without a pinned app — `409 own:no-app`; the check failed — `422 own:lint` with `errors` (in the hub language); the plugin needs a newer contract than the hub (`<agenthub.contract>`) — `409 own:hub-too-old` with `need` and `have`; path problems — `own:not-found`, `own:not-dir`, `own:no-plugin`, `own:ambiguous` (`ids`); a request for the same id from another folder is waiting — `409 own:request-conflict` (`pending: {requestId, path, pathShort}`); 10 are already waiting — `429 own:too-many-requests`. `migrate.from: "catalog"` (`tier`, `title`) — the id matches a catalog plugin that is not installed. Requests survive daemon restarts |
| `POST /registry/own/approve`, `/registry/own/decline` | app | `{requestId}` → always `428 consent-required` with a consent window (`source: {kind:"own", path, pathShort, fingerprint, writable: {mine, others, parentOpen, acl}, warnings}`, `migrate`, `changedSinceRequest`); the request folder was replaced — `409 own:path-changed`; `{requestId, consentToken}` → installs exactly the bytes shown in the window; while paused — 423. `decline` drops the request. A diagnostic shell run (`--snapshot-consent`) gets only the window and does not reset the human's window |
| `POST /registry/fetch`, `/registry/install`, `/registry/remove` | app | the plugin manager; installation — `428 consent-required` with a permissions window, then `consentToken` (the catalog changed the sha256 or the tier while the window was open — `409 registry:catalog-changed`; the plugin needs a newer contract than the hub — `409 registry:hub-too-old` with `need`/`have`, and the catalog marks such an entry `needsHub: {need, have}`; the consent window carries the `icon` from the archive metadata); `{id, source: "registry"}` — from the catalog over an own plugin (a window with `migrate.from: "own"`). A diagnostic shell run (`peer.diagnostic`: `--snapshot-consent` and the other `APP_DIAGNOSTIC_ARGS` flags) changes nothing: any non-GET route gives `403 peer:diagnostic`, except `install` and `own/approve` — those return only the window (`428` or `409 consent:nothing`). Without a signed app — `agenthub plugins install|remove <id>` from your own terminal: a TTY is required, and Claude Code must not be among the process ancestors (by signature or name; `CLAUDECODE` in the environment is also refused, `terminal:agent`) |
| `POST /bridge/hello`, `GET /bridge/next`, `POST /bridge/result/:id`, `POST /bridge/bye` | bridge | the cmux bridge channel — [`bridge/README.md`](../bridge/README.md) |
| `POST /terminal/read-screen`, `POST /terminal/send-text` | a trusted plugin process (cli by pid) | terminal, contract 3 — above, "Terminal" |

## Action primitives

| Primitive | Level | Arguments | Details |
|---|---|---|---|
| `open.url`, `open.file` | immediate, also work while the hub is paused | `url` / `path` | `daemon/lib/primitives/` |
| `session.focus` | immediate (for cli and third-party plugins too) | `sessionId` | below |
| `terminal.focus` | immediate (for cli and third-party plugins too) | `surfaceId`, `workspaceId?` | below |
| `cmux.focus` | **deprecated** alias of `terminal.focus` until the next contract — new plugins use `session.focus` | `surfaceId`, `workspaceId?` | below |
| `session.interrupt`, `session.stop` | confirmation, app only | `sessionId` | below, [`bridge/README.md`](../bridge/README.md) |
| `session.launch` | priced confirmation, app only, only from the form | `cwd`, `name`, `prompt` | below, [`bridge/README.md`](../bridge/README.md) |
| `session.respond` | immediate, app only (the card itself is the consent) | `requestId`, `decision`, `answers?` | [`hook.md`](hook.md) |

`session.focus <sessionId>` (contract 3) — switch to the tab of a Claude Code session from the core registry. The
terminal layer (`daemon/lib/terminals/`, `locate`) finds the tab, and the adapter switches to it (`focus`; cmux — the
bridge operation `surface.focus`). `remoteAllowed: false`. Refusals before switching — 409 `facts:unknown-session` (not
in the registry), `facts:no-terminal` (no adapter knows the tab), `facts:pid-mismatch` (the terminal tab belongs to
another process), `facts:focus-unsupported` (the adapter cannot switch), `facts:bridge-offline` (the cmux adapter
without the bridge); a switch failure — 200 `{ok: false, result: {error, terminal}}` with the adapter code
(`bridge-outdated`, `bridge-timeout`, `tmux-failed`, `osascript-failed` — macOS did not allow controlling the terminal,
`terminal-test-mode` — a test hub never touches real terminals, …). The action text: "Go to tab "<session name>"" (a
conversation-based auto-title is not shown), otherwise "…session <first 8 characters of the id>…".

`terminal.focus <surfaceId> [workspaceId=…]` — switch to a terminal tab by its id (the `surfaceId` of a session record):
the first adapter that knows the id (`findTab`; today cmux, through the bridge). Refusals — 409 `facts:actions-off`,
`facts:bridge-offline`, `facts:unknown-surface`, `facts:workspace-mismatch`, `facts:focus-unsupported`. `cmux.focus` is
the same primitive under its former name: accepted until the next contract, `/state.primitives[]` marks it
`aliasOf: "terminal.focus", deprecated: true`, and in `<agenthub.effects>` either name allows the other.

`session.interrupt <sessionId>` — Esc in the session's tab through its terminal adapter, only while a turn is running
(cmux: `agentLifecycle: running`; terminals without their own turn state, tmux: the registry status `busy`). Refusals —
409 `facts:unknown-session`, `facts:no-terminal`, `facts:pid-mismatch`, `facts:esc-unsupported` (iTerm2, Terminal.app),
`facts:bridge-offline` (cmux), `facts:not-running`.

`session.launch` — a new tab in the launch terminal (`/state.terminals.launch`: `services.terminal.launch` or auto).
Refusals besides the folder and name checks — `facts:no-launch-terminal` (no terminal can open a tab),
`facts:launch-unsupported`, `facts:bridge-offline` (cmux). The confirmation text names the terminal ("new iTerm2 tab").
The launch is tracked until the session appears (cmux — its session file, other terminals — the core registry):
events `bridge.launch.registered` / `bridge.launch.timeout` (names kept for compatibility) now carry `terminal`.

`open.file` opens only document types (text, Markdown, JSON/YAML, PDF, office files, images, audio, video — `OPEN_EXT`
in `open.file.mjs`) and regular folders (without an extension). A file with the x bit — `409 facts:executable`, other
types — `facts:risky-type`, a directory with an extension (`.app`, `.sparsebundle`, `.playground`…) or with the
"package" flag — `facts:bundle`, a Finder alias under any name — `facts:alias`, a file with its own opening program
(`com.apple.LaunchServices.OpenWith`) — `facts:open-with`; all of these can only be revealed in Finder (`reveal: true`).
An ordinary folder with a dot in its name (`site.com`, `notes.d`) is treated as a package too and only revealed: this is
deliberate (decision 2026-11-11) — the extension is what `open` would act on.
The type is checked once more before running `open`. This narrows the link-swap window but does not close it: `open`
gets a path, not a descriptor, and a swap a fraction of a second before it runs will get through — the primitive is meant
for files that no foreign process swaps.

The `409 facts:<reason>` codes of primitives are in [`bridge/README.md`](../bridge/README.md) and [`hook.md`](hook.md).
Control of external agents is not among the primitives: those are declared actions of their plugins
(`<agenthub.action>`, [`extension-points.md`](extension-points.md)) — described in the plugins' own READMEs. The plugin
explains a refusal of such an action itself (`message=`, see `POST /actions/:id` above).

## Journal `journal.jsonl`

One JSON line per record, mode 0600, rotated at 8 MB into `journal.jsonl.1`. `type` and other codes are stable; human
text (`detail` of `warning`, the `[hidden]`/`[скрыто]` placeholder) is rendered in the hub language when the record is
written, so older records keep the language they were written in. The records `estop`, `estop-set`,
`app-requirement-changed`, `shutdown-requested` and `app-restart-stopped` are duplicated into `journal-audit.jsonl`
(0600, rotated at 1 MB into `.1`): a flood of other records cannot push them out. Plugin warnings (`warning`) — at most
20 per minute from one plugin (an exact repeat — once per 10 min); beyond that, one `warning` record with
`suppressed: N` at the next warning after the minute changes. Types: `start`, `stop`, `plugin-add`, `plugin-remove`,
`plugin-exit`, `warning`, `action`, `action-denied`, `action-confirm-requested`, `denied`, `estop`, `estop-set`,
`app-requirement-changed`, `shutdown-requested`, `hook`, `hook-denied`, `service-start`, `service-error`, `load-error`
(`stop` carries `reason`: `shutdown`, `login-off`, `SIGTERM`, `SIGINT`) and extension types: app supervision (the app
service) — `app-supervise` (`on`, `testMode`, `launch`), `app-lost`, `app-launch` (`reason`:
`start`/`lost`/`verify`/`lost-later`/`relaunch`, `ok`, `code`, `path`, `restarts`), `app-launch-skipped` (`reason`,
`why`), `app-restart-stopped` (`restarts`, `windowMs`, `why?`), `app-supervise-resumed`, `app-supervise-error`,
`app-login-gate` (`decision`: `wait` with `ms` / `retry` with `why=unknown` and `ms` / `stay` with `why` / `exit` with
`waitedMs`; before 2026-11-07 also `app-path-seen`); pinning — `app-pin-path-changed` (`old`, `new`, `source`; in the
audit log); push — `push-start`, `push-sent`, `push-held`, `push-deferred`, `push-suppressed`, `push-fallback`,
`push-digest`, `push-error`, `push-muted` (`key`, `rule`, `kind`, `reason: kind|all`; `key: "digest"` with `count` —
items of turned-off kinds not sent in the morning); answers — `hook-session`, `hook-session-end`, `hook-card`,
`hook-answer`, `hook-cancel`, `hook-skip`, `hook-paused`; bridge — `bridge-op`, `bridge-stale`; quota — `usage-fetch`
(when the outcome changes: `ok`, the `error` code, the number of rows), `usage-write-error`, `usage-error`; registry —
`registry-*`, `plugin-installed`, `plugin-consent-requested`, `plugin-removed-by-user`, `plugin-installed-terminal`,
`plugin-consent-declined`, `plugin-blocked`, `plugin-unblocked`, `plugin-quarantined`, `registry-update-check`
(background check: `ok`, `error`, `failures`; when the outcome changes), `plugin-update-available` (`plugin`, `from`,
`version`, `permissionsGrow` — once per version; for an own plugin — on every new folder content); own sources —
`plugin-own-requested` (`plugin`, `version`, `by`, `migrate?`), `plugin-own-rejected`, `plugin-own-declined`,
`plugin-own-updated` (`from`, `version`, `sha256`), `plugin-own-source` (`status`, `error`, `reason` — when the folder
state changes), and `plugin-installed` carries `source: "own"` and `migrate`; secrets — `secret-lookup`,
`secret-denied` (only the key and the outcome, never values).
Metadata only (see [`extension-points.md`](extension-points.md), `journal.write`).

## Other files in the state directory

`Cache/usage.json` (0600, atomic writes) — the Claude subscription quota from the `usage` service
(`daemon/lib/services/usage.mjs`): `{version: 1, fetched_at, checked_at, error, rows: [{kind, group, percent,
severity, resets_at, scope?: {model: {display_name}}, label?}]}`. `fetched_at` — the last success, `checked_at` — the
last attempt (epoch seconds); `error` — a code: `no-token` (not signed in: no keychain entry — `security` returned 44 —
and no `.credentials.json`; rows are wiped), `keychain-unavailable` (the keychain could not be read: a 5 s timeout, the
access dialog was denied, locked after sleep, other `security` codes; rows stay, this is not a sign-out),
`token-expired` (the token is not refreshed — we wait for Claude Code to refresh it; rows stay), `http-401|403|429|<n>`,
`network`, `timeout`, `too-large`, `bad-response`, `no-endpoint` (test mode without a double) or `null`. There is no
token in the file. `retry_at` (epoch seconds; only after a network or API error) — when the service will call the API
again: the backoff survives a daemon restart (the new instance waits until it ends, no longer than an hour). Rows whose
`resets_at` has already passed remain from the last success — their percentage means nothing after the reset, and plugins
ignore them. Every 3 min (backoff: 401 — 10 min, 403 — 1 h, 429 — 15 min, other — 5 min; without a token — only a
keychain check, no request; the overall request deadline is `timeoutMs`, 8 s, and a slow response does not extend it)
the service takes the Claude Code OAuth token from the keychain (`/usr/bin/security find-generic-password -s
"Claude Code-credentials" -w`; with the daemon's `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR` or
`services.usage.claudeConfigDir` — the entry with the suffix `-<sha256(NFC(directory))[:8]>`, as Claude Code does), with
a fallback to `<Claude config directory>/.credentials.json`, and makes `GET https://api.anthropic.com/api/oauth/usage`
(`Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, no redirects, body ≤ 256 KB). Plugins get the path as
`AGENTHUB_USAGE_FILE` (only builtin, official and own); `<agenthub.watch>$AGENTHUB_USAGE_FILE` runs the plugin right
after the cache is written (for example, quota). The switch is `services.usage.enabled: false`.

`Cache/claude-sessions.json` (0600, atomic writes; contract 3) — metadata of live Claude Code sessions from the
`sessions` service (`daemon/lib/services/sessions.mjs`), taken from the core session registry:

```json
{ "version": 1, "updatedAt": "2026-11-10T12:00:00.000Z",
  "sessions": [{ "sessionId": "<uuid>", "pid": 12345, "verified": true, "status": "idle | busy | waiting | null",
                 "model": "claude-opus-5-5", "modelId": "claude-opus-5-5 | null", "modelSource": "turn | command | null",
                 "effort": "low | medium | high | xhigh | max | null", "effortSource": "turn | command | null",
                 "ultracode": false, "surfaceId": "<cmux tab | null>", "workspaceId": "<cmux workspace | null>",
                 "name": "<session or tab name | null>", "at": "<time of the transcript record model/effort came from | null>" }] }
```

`verified` — the process's `requirements.claudeCode` signature was verified by the core at write time (as for
`session=`; cached by pid and start time): if the process exited or the pid is taken by another one — `false`. Only
sessions with a verified signature enter the registry, so `false` means "it was, but cannot be confirmed now": never
type into such a session. The `/model` and `/effort` commands win over the last turn (`modelSource`/`effortSource:
"command"`): for an idle session the turn may predate the command. `modelId` is always a model id: with
`modelSource: "turn"` — `model` itself, with `"command"` (`model` holds the name from `/model` output,
"Opus 5.5 (default)") — the normalized name (`claude-opus-5-5`; bracketed marks are dropped, families Opus, Sonnet,
Haiku, Fable), unknown — `null`. The plugin compares `at` with the time of its own last typing into that tab and shows
whichever is newer. There is no conversation text, no folder and no "what the session is waiting for" (`waitingFor`) in
the file. It is rewritten on the bus `sessions` event, at most once every 2 s (`services.sessions.minIntervalMs`) and only
when the content changes; at service start — an empty list. Plugins get the path as `AGENTHUB_CLAUDE_SESSIONS_FILE` (only
builtin, official and own); the permission is
`<agenthub.fsRead>$AGENTHUB_CLAUDE_SESSIONS_FILE — why</agenthub.fsRead>`, and
`<agenthub.watch>$AGENTHUB_CLAUDE_SESSIONS_FILE` runs the plugin right after a write. The switch is
`services.sessions.enabled: false` (then there is no variable).

`push-state.json` (0600) — what was sent and the digest queue (the push service); `launch/` (0700) — `session.launch`
prompt files (0600, deleted after reading; the actions service cleans up abandoned ones older than 10 min); `Registry/` —
the registry catalog, quarantine, disabled plugins ([`plugins-registry.md`](plugins-registry.md));
`Registry/updates.json` (0600, atomic) — which "id@version" the background check has already announced (`notified`) and
the time of the last successful check.
