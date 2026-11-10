# Changelog

Releases are git tags `vX.Y.Z` (also published as GitHub releases); the current version is in [`VERSION`](VERSION).
The plugin contract has its own version history in
[`docs/extension-points.md`](docs/extension-points.md#contract-versions).

## 0.1.1 — 2026-11-10

### Plugin page controls

- Four new kinds of body lines on the plugin page, optional within contract 3 (a hub 0.1.0 draws their children as
  plain lines and buttons): `segment=true` — a segmented control from the children (`selected=true` is the current
  one), falling back to a popup button when it does not fit; `select=true` — a popup button with a menu of the children
  (`note=` dimmed); `toggle=on|off` — a switch that runs the line's own offer; `table=true columns="A¦B"` — ~34 pt rows
  with `cells=`, `cellColors=`, a state dot, buttons and icon-only buttons (`icon=true`) from row children, gray notes,
  collapsible `group=true` subheadings (remembered while the app runs) and `header=true` buttons by the table title.
  Consecutive segment/select/toggle lines share a label column. Every clickable part uses the usual offer gate,
  confirmation and busy spinner ([`docs/writing-plugins.md`](docs/writing-plugins.md#43-controls)).

## 0.1.0 — 2026-11-10

The first public release, under the [MIT license](LICENSE). It covers all the work below, grouped by date.

### 2026-11-10 — Panel styling for plugin lines

- New optional line params (contract 3, older hubs ignore them): `link=true` draws an offer line (`effect=`/`href=`/
  `action=`) as a text link instead of a capsule, with the same gate and confirmation; `iconColor=` colors only the
  `sfimage` icon; `badgeColor=` tints the badge. `color=` now also colors the title of nested lines.

### 2026-11-10 — Install with Homebrew

- **`brew install KenseiTheOne/tap/agent-hub` + `agenthub setup`**: the formula (tap `KenseiTheOne/homebrew-tap`)
  installs the release source tree into `libexec` and the `agenthub` command, depends on Homebrew's `node` and builds
  nothing itself; `agenthub setup` (= `agenthub hub install --brew --apply`) builds the hub from that tree with the same
  builder as updates (source kind `brew`: the tree is copied without `.git` and old build products), pins the build,
  copies the built-in plugins, adds the launchd job and starts the hub. It checks the Command Line Tools first.
- **A Homebrew-managed hub follows Homebrew, not git tags**: `config.json → services.hubUpdate.brew` records the source
  (`<prefix>/opt/agent-hub/libexec`, read fresh by the daemon); the update check reads `VERSION` (and the formula's
  `COMMIT`) from there with no network, and a newer version gets the usual "Update" button — build, trial run,
  rollback. `/state.hubUpdate` gains `source: "git" | "brew"` and `brew`; error `hub-update:brew-missing` when the formula
  is gone.
- Shell and CLI texts (ru/en): "updates come from Homebrew: brew upgrade agent-hub", "copying sources from Homebrew…",
  the confirmation window and "Details" name Homebrew; `agenthub hub status`, `agenthub version` ("Homebrew package")
  and `agenthub uninstall` (which clears the brew source and reminds to run `brew uninstall agent-hub`) know about it.
  `scripts/install.sh` keeps working; installing from git switches a brew-managed hub back to git tags.

### 2026-11-10 — Plugin contract 3: Claude sessions and the terminal for plugins

- **Live Claude Code session metadata for plugins**: `Cache/claude-sessions.json` (0600, no conversation text) and the
  `AGENTHUB_CLAUDE_SESSIONS_FILE` variable for trusted plugins — model, `modelId`, effort and where they came from (the
  last turn or a `/model` / `/effort` command), ultracode, tab, `verified`.
- **Pause flag**: `AGENTHUB_PAUSED=0|1` in every plugin run; setting and lifting the hub pause restart plugins
  (`AGENTHUB_REFRESH_REASON=Paused|Resumed`).
- **Terminal for plugins** behind the `<agenthub.terminal>` permission: "read the screen" (input field flags only) and
  "type into the tab" of a Claude Code session through a terminal adapter layer (cmux first, via the bridge); slash
  commands from a declared list, `send *` without Claude Code mode characters, a separate `send !` permission for lines
  starting with `!`, `#`, `&`; only verified, idle, foreground sessions, not while paused, rate-limited and audited.
- **`session.focus <sessionId>`**: switching to a session's tab without knowing the terminal; the shell's "Go to" buttons
  use it, `cmux.focus` is kept for compatibility.
- **Loud consent** for writes to hijack locations (Claude Code settings, autostart, shell startup files, PATH, SSH,
  git, the hub directory) and for typing into tabs; the registry linter warns the reviewer.
- Built-in `claude-sessions` 0.5.0 reads the model and the `/model`, `/effort` commands from the transcript tail.
- Shell: AppKit tooltips with the full text, shown right away and only for truncated text.
- **Everything the hub shows is in the hub language** (Russian or English): daemon errors and warnings (journal
  `detail`, API error details, linter and parser warnings, hub-update details, build and watchdog logs) and the CLI
  output, from one message table (`daemon/lib/i18n.mjs` + `daemon/lib/messages/`). Codes and journal types are unchanged.

### 2026-11-10 — Plugin contract 2: the core knows no plugins; Windows findings

- **Everything plugin-specific is declared by the plugin**, and the hub builds the UI from the declarations:
  `<agenthub.contract>` with a clear "requires a newer hub" refusal, `<agenthub.icon>`, `<agenthub.connection>` (MCP
  address, scope, tool allowlist, interval and budget; the host must be in the plugin's `net`; a new connection is a
  permission increase), `message=` texts for action refusals.
- **Notifications**: only shared kinds in the core plus a per-plugin toggle; the old `runs` / `night` kinds are carried
  over from `settings.json` without losing the user's choice and survive a hub rollback.
- Built-in plugins declare their own push rules and icons (`agents` 1.2.0, `claude-sessions` 0.4.0, `quota` 0.5.0).
- **Fixes from a Windows check of the daemon** (the rest is groundwork in [`docs/windows.md`](docs/windows.md)):
  `osVars()` returned `null` without OS commands and broke plugin runs on Linux; `open.file` opens only known document
  types (packages, Finder aliases and files with an assigned app can only be revealed in Finder), re-checked before
  running; `isAbsolutePath` instead of `startsWith("/")`, JSON with a BOM, `samePath`, a clear error for a corrupted
  `config.json`, portable tests with skip reasons.

### 2026-11-09 — App/daemon lifecycle, hub auto-update, "can I shut down", own plugins

- **Lifecycle**: quitting the app stops the daemon (`POST /shutdown`); if the app crashes while the daemon is alive, the
  daemon relaunches it (up to 3 times in 10 min); "Launch at login" controls the pair; launchd `KeepAlive` only on
  failure.
- **Hub auto-update**: versions by `vX.Y.Z` tags on `origin/main`, installed into `Versions/<version>` with
  `current` / `previous`, a trial run with a watchdog and rollback, an "Update" button with notes from the tag message;
  a one-file installer (`scripts/install.sh`), `hub migrate` and `uninstall`. See [`docs/hub-updates.md`](docs/hub-updates.md).
- **"Can I shut down"**: `/state.idle` with the `quiet` / `quiet-needs-on` / `busy` verdict, a popover card and new
  menu bar icon states; sessions waiting for an answer do not block shutdown.
- **Sidebar**: wider, status in words with a severity dot, the full line in a tooltip.
- **Notifications settings**: a master switch, kinds and quiet hours; security notifications cannot be muted.
- **Connections**: signing into an external service through its site (official MCP server, OAuth 2.1 + PKCE, tokens in
  the keychain).
- **Own plugin sources**: installing a plugin from a local folder via a request and a consent window in the pinned app,
  the `own` tier, automatic updates when permissions stay the same, migration from the catalog and back; "Requires …"
  in the catalog from plugin metadata. See [`docs/plugins-registry.md`](docs/plugins-registry.md#own-sources-2026-11-09).
- `quota` 0.4.2: the header always shows the current week and its reset.
- Project rules: the hub and plugins are developed separately; the core knows no plugin names.

### 2026-11-06 — Plugin update checks, event-driven quota, review fixes

- **Background plugin update checks** against the signed catalog: every 6 h, a badge on "Plugins", an "Update" line in
  the popover, one notification per version, a switch in Settings; an installed official plugin is not demoted when a
  new version is released.
- `quota.5m`: refreshes when the quota service writes its cache (`watch`); a text for `keychain-unavailable`.
- 63 findings of a large review of the core, the shell and the built-in plugins fixed: linear output parsing, push
  limits, untrusted plugins cannot impersonate sessions, hook events while paused, an audit journal, re-pinning in the
  shell, notification routing, broken-off sessions in "Sessions", the read budget of `agents`, and more.

### 2026-11-05 — Pinning by cdhash, plugin catalog, languages, quota service

- **App pinning by build fingerprint (cdhash)** instead of a mandatory certificate: `bundle.sh` signs ad hoc and records
  the requirement via `agenthub pin-app`; every change goes to the journal and a banner.
- **Plugin tiers** `builtin` / `official` / `community` / `local`; third-party tool integrations moved out of the core
  into the registry. Built-in plugins run from a copy in `<home>/Builtin` (`agenthub builtin [update]`).
- **Plugin manager**: a catalog from a signed index, installation with consent, removal and updates.
- **Russian and English** with a switch in the app; the language is passed to plugins (`AGENTHUB_LANG`).
- **A quota service in the core** (`usage`): the Claude Code token never leaves the service, plugins get only the cache.
- Sessions: effort and ultracode from the last turn; the cmux bridge in `/state`, "Go to" buttons disabled without the
  bridge, with the start command shown.
- Shell: traffic lights inside the sidebar card, one corner radius; the popover closes when windows open; a right-click
  menu on the icon (Panel, Pause hub, Quit); "ESTOP" renamed to "Pause hub".
- New app icon and menu bar icon with a "waiting" emblem.

### 2026-11-05 — First version

- **Daemon `agenthubd`** (Node ESM) on a Unix socket: a SwiftBar-style plugin contract without `bash=`, peer
  verification by process and code signature, action confirmations decided by the core, ESTOP, a metadata-only
  journal, push notifications, secrets from the Keychain.
- **Shell**: a SwiftUI menu bar app following the approved prototype.
- **Hook** for answering Claude Code sessions from the hub and the **cmux bridge**.
- **Built-in plugins**: `claude-sessions`, `agents`, `quota`.
