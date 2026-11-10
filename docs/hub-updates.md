# Hub auto-update (daemon + app) — design and release procedure

User decisions (2026-11-06, do not change):

1. **A new version = a tagged release** `vX.Y.Z` in `agent-hub`, not every commit. The source is the repository's
   `origin` (the GitHub repository `KenseiTheOne/agent-hub`); we learn about releases with `git ls-remote` (the repository is
   public; a private origin uses the user's git credentials from the keychain), the hub has no tokens of its own. Tests use a local bare repository.
2. **The live hub runs from a separate installation** `~/Library/Application Support/AgentHub/Versions/<version>/`; the
   developer's working folder (`~/path/to/agent-hub`) does not affect the live hub. A failed build leaves us on the
   previous version; rolling back to the previous version is possible.
3. **Installed with an "Update" button**, like plugins; one notification per version; the check runs a minute after
   startup, then every 6 h with jitter, backing off on errors (the approach of `lib/registry/updates.mjs`).

## 1. Directory layout

```
<home> = ~/Library/Application Support/AgentHub          (AGENTHUB_HOME — a test directory)
├── Versions/                                            0700
│   ├── current  -> 0.2.0                                a relative symlink — the pointer to the current version
│   ├── previous -> 0.1.0                                a symlink — where "Roll back to …" leads
│   ├── 0.2.0/
│   │   ├── src/              sources from the tag (git fetch refs/tags/v0.2.0 + the main branch), .build removed after building
│   │   │   ├── daemon/…      the daemon runs from here (launchd → Versions/current/src/daemon/bin/agenthubd)
│   │   │   └── plugins/…     this version's built-in plugins (the source of the <home>/Builtin copy)
│   │   ├── AgentHub.app      built by scripts/build-release.sh from the same tag, signed ad hoc
│   │   └── build.json        {version, label, tag, commit, origin, cdhash, requirement, builtAt, selfTest, …}
│   ├── 0.1.0-dev.6ceb3d8/    a version created by migrating from a working folder without a tag (the label is the commit)
│   └── .staging-0.3.0-<rnd>/ a build in progress; it enters Versions/<version> only as a whole (rename)
├── HubUpdate/                                           0700
│   ├── check.json            the last check: the available version, when, which versions were already announced, which
│   │                         commit the hub saw for each version's tag (commits) and which tags moved (moved)
│   ├── install.json          install/rollback: phase, step, error, log path, what was there before the switch (prev)
│   ├── install.lock          a lock for phase transitions between processes (O_EXCL; an abandoned one older than 10 s is removed)
│   └── history.json          which builds the hub pinned itself: label → cdhash (rollback only to those)
├── logs/hub-update-<label>-<time>.log                   build log (git, swift, codesign, self-test)
├── Builtin/                                             a copy of the current version's built-in plugins (as before)
└── config.json                                          requirements.app + appPin (pinning) — as before
```

**The pointer is the `Versions/current` symlink, not a config entry.** Switching is `symlink(<version>, current.tmp-…)`
+ `rename(current.tmp-…, current)`: rename is atomic, so at any moment `current` points either to the old or to the new
version. launchd reads the path every time it starts the process, so the plist is not rewritten on update:
`ProgramArguments = [node, <home>/Versions/current/src/daemon/bin/agenthubd]`, `WorkingDirectory =
<home>/Versions/current/src`. Node resolves the main module symlink, and the running daemon knows its real version
(`DAEMON_DIR` = `…/Versions/0.2.0/src/daemon`). `previous` uses the same technique; it is informational (where to roll
back to), the truth is `current`.

**The hub version has a single source of truth: the `VERSION` file at the repository root** (`0.1.0`). It is read by the
daemon (`lib/version.mjs` → `/state.version`, the `start` record), the bridge and `scripts/bundle.sh` (the app's
`CFBundleShortVersionString`). `daemon/package.json` and `claude-plugin/.claude-plugin/plugin.json` are derived copies:
`scripts/set-version.sh` writes them, and the `version.test.mjs` test fails if they diverge from `VERSION`.

The version directory label: for a release — `X.Y.Z` (from the tag `vX.Y.Z`; the tag must match the `VERSION` inside
it); for a migration without a tag — `X.Y.Z-dev.<commit7>` (a pre-release: any release `vX.Y.Z` or higher counts as
newer); with `--allow-dirty` — `X.Y.Z-dev.<commit7>.dirty`.

## 2. Discovering and comparing versions

(A hub installed with Homebrew does not look at tags at all — its versions come from the brew tree, §8b.)

`git ls-remote --tags <origin>` (the user's environment, `GIT_TERMINAL_PROMPT=0`, a 30 s timeout) → tags of the form
`vMAJOR.MINOR.PATCH` (with `-pre` only when `services.hubUpdate.prerelease = true`); for an annotated tag the commit is
taken from the `^{}` line. The new version is the highest by semver (numbers compare as numbers, a pre-release is lower
than the release, `+…` build labels are ignored), strictly greater than the current one. `origin` is
`services.hubUpdate.remote` in config.json, otherwise `build.json.origin` of the current version (the migration writes
the working folder's `git remote get-url origin` there). Not configured — no network; a check every 15 min looks
whether it has been configured. Tags with a major version above the current one + `services.hubUpdate.maxMajorJump` (1)
are not considered (journal `hub-update-skipped`): a garbage `v999.0.0` does not hide real releases. A release record is
accepted only if the tag is exactly `vVERSION` and the commit is 40 hex digits (both from `ls-remote` and from
`check.json` on load).

**The release description is the annotated tag message** (`git tag -a v0.3.0 -m "…"`): the first line is the subject,
the rest is the body. **Single-language**: a tag message has no translation, so the shell and push show it as is in any
UI language (in the English UI — "What's new: <tag text>"). It is written in the language of whoever installs the hub; if
two languages are ever needed, a second body block marked `[en]` would be a separate parsing improvement
(`parseTagNotes`, `HubUpdateText.releaseNotes`). The hub reads it without tokens or APIs, with the same git and the
user's credentials: for the available release and the current version (if their tag is annotated and the hub has not
yet read its object, the sha from `ls-remote`) — `git init --bare` in a temporary service mirror
`HubUpdate/.notes-<rnd>` (deleted right away), `git fetch --depth=1 --filter=tree:0 --no-tags <origin>
+refs/tags/<tag>:refs/tags/<tag>` (only the tag object and its commit; the tree filter if the server supports it), a
check that the mirror holds exactly that tag object, `%(contents:subject)`/`%(contents:body)` (git strips a PGP
signature itself). Cache — `check.json → notes[<version>] = {object, subject, body}`: re-read only when the tag object
changes (a rewritten tag never shows the old description). An error is not a check error: a `hub-update-notes` record,
retried on the next check. A lightweight tag has no description; the shell shows only the version. The builder puts the
same description into `build.json → tagInfo.notes` (a migration from a commit with an annotated tag too). The text is
data from origin: subject ≤ 200 characters, body ≤ 2000, control characters and direction-changing characters are
removed; the shell shows it as plain text (no markup), the popover shows the subject in two lines, the confirmation
window and "Settings" show the subject and up to 2–3 lines of the body. The shell and push do not repeat the version in
the subject (it is right next to it anyway): a leading "Agent Hub vX.Y.Z:" / "— " is cut, a subject consisting only of
a version ("Agent Hub 0.3.0", "v0.3.0") counts as empty — then the first body line becomes the subject, and without a
body there is no description (`HubUpdateText.releaseNotes`, `releaseSubject` in `lib/services/push.mjs`). So the tag
message is about what is new (§9), not "Agent Hub X".
The tag and commit are not shown in the popover, the window or "Settings" — they are under "Details" (the confirmation
window — small grey text under the main text, "Settings" — an expandable block) and in the build log; the exception is a
moved tag (both commits are in the window text, since they are what needs checking).

**A moved tag.** `check.json.commits` remembers which commit each version's tag pointed to when the hub first saw it. If
the tag of the same version now points to another commit — journal `hub-update-tag-moved {version, old, new}` (and the
audit log), event `hub-update.tag-moved` and the push "Agent Hub release tag moved" (immediately, banner bypassing the
shell), and the version is marked `available.moved`. "Update" installs it only with `acceptCommit` = the new commit: the
shell shows both commits in the confirmation window, and the popover and "Settings" show the line "Release tag X moved
to another commit · check the commit before installing". The event and push apply only to versions newer than the
current one (those can be installed): a moved tag of an **already installed** version is only written to the journal
(`hub-update-tag-moved`) — there is nothing to install.

Schedule and backoff are as for plugins (`resolveTiming` from `lib/registry/updates.mjs`): the first check after
`firstDelayMs` = 1 min (+ up to a minute of jitter), then `intervalMs` = 6 h + `jitterMs` up to 30 min; on error —
5 min → 15 min → 1 h → 3 h (no longer than the interval). Outside test mode — at most once an hour. Switches:
`config.json → services.hubUpdate.checkUpdates = false` (hard) and "Check for hub updates" in "Settings"
(`settings.json → checkHubUpdates`, written by app only). One notification per version: `check.json.notified`.

## 3. Installation — step by step

Only the pinned app (class `app`) starts it: `POST /hub-update/install {version}`. Refusals: hub paused —
`423 hub-update:estop`; another installation in progress — `409 hub-update:busy`; the hub does not run from `Versions`
(not migrated) — `409 hub-update:not-installed`; the version is not among those found — `404 hub-update:unknown-version`;
not newer than the current one — `409 hub-update:not-newer`.

| # | Step | Where | What is atomic | On error |
|---|---|---|---|---|
| 1 | `install.json` ← `{phase: building, step: clone}`, event `hub-update.status` | daemon | file: tmp + rename | — |
| 2 | **Build in a separate process** `node <current daemon>/bin/agenthub hub build …` (the daemon is not blocked; the builder has an overall deadline — the sum of step deadlines with a margin, ≈ 51 min: each git network command — 5 min, `build-release.sh` — 30 min, self-test — 1 min; when a step deadline or the overall deadline passes, the process is killed **together with its descendants** (git-remote-https, swift-build, swift-frontend — from the `ps` table, `killProcessTree` in `lib/platform.mjs`; the process group does not change, so the installer's Ctrl-C and launchd reach them as before), the result is taken from the process exit, not from the closing of its streams that a grandchild could hold open; the node for the builder and the watchdog is the daemon's `argv0` (the `/opt/homebrew/bin/node` link from the plist), not the Cellar path that `brew upgrade node` removes; no node — `node-missing`; the origin address goes via stdin, not argv; the builder reports its step as `{"step": "clone|build|verify|selftest|promote"}` lines on stdout — the daemon writes it to `install.step`, the result is the last line): less than 1 GB free on the volume — `no-space` before starting; `git init` + `git fetch <origin> refs/tags/<tag> refs/heads/main` into `.staging-…/src` (not `clone --branch`: that would pick a branch with the same name; the origin address does not stay in the clone, and credentials in the address are replaced with `***` in the log), the tag commit is checked against `ls-remote`, **the tag commit must be in the history of `origin/main`** (`git merge-base --is-ancestor`, otherwise `not-on-main`: a tag on an unreviewed branch is not installed; the branch is `services.hubUpdate.branch`), `VERSION` is checked against the tag, `src/scripts/build-release.sh --out .staging-…` (from the **new** tag: `build-native.sh` + `bundle.sh --no-pin`), verification: the bundle, `codesign --verify --strict`, identifier `com.kensei.agenthub`, cdhash; **a self-test of the new daemon** `node src/daemon/bin/agenthubd --self-test` in a temporary directory (loads all core modules, opens the socket, `/health`, the peercred addon) — the version in the answer must match; `build.json`; `rename(.staging-…, Versions/<version>)` | child process, log `logs/hub-update-…log` | the version directory appears as a whole (rename) | `phase: failed`, `error: clone-failed / not-on-main / no-space / build-failed / verify-failed / selftest-failed / version-mismatch / commit-mismatch / build-timeout / node-missing` (if the builder did not start or was killed on deadline, the daemon writes the reason line to the log: "Show log" leads to the file), journal `hub-update-failed`, push; the live hub is untouched; the directory of a version that failed is deleted |
| 3 | The daemon re-verifies the finished version itself: the expected cdhash and commit come **from the builder's answer** (the child process's stdout), not from `build.json` in the same writable directory; `build.json` and the cdhash of the bundle on disk (an asynchronous `codesign`, the daemon's event loop does not stall) must match it; the hub pause | daemon | — | as in step 2 |
| 3a | **Someone is waiting for an answer**: the hub's PermissionRequest cards (a restart removes them — the questions fall back to the regular terminal dialog) or sessions waiting for an answer (a restart will not touch them, but interrupting is not nice): no switch, `phase: ready`, `install.waitingCards` / `waitingSessions`, event `hub-update.ready {waiting, notify}`; popover — "Hub X is built" · "Waiting for an answer: N — the restart will remove their cards" (sessions only — "Sessions waiting for an answer: N — better answer first") · "Restart" (`POST /hub-update/switch`: re-verify the bundle and the pause, then step 4). In `ready`, installing the same version and rolling back give `409 hub-update:ready` (a built and verified version is never silently thrown away); the shell hides "Update to X" and disables "Roll back". The first time for this version (`HubUpdate/check.json → readyNotified`, survives daemon restarts and repeated "Update"; installation only, not rollback) — one push notification "A new Agent Hub version is built — waiting for restart" (decision 2026-11-07). A daemon restart in `ready` — `failed: interrupted` (build again) | daemon + shell | — | — |
| 4 | `install.json` ← `phase: switching` **together** with the snapshot `prev = {requirement, appPin, current, previous}` and `restorePin` — as one write, before the app leaves. If it is not written, the switch does not start (`failed: state-write`) | daemon | tmp + rename | — |
| 4a | **The app leaves**: `core.updating = true` and `core.stopping = true` (app supervision no longer intervenes — the app exiting is not a "crash"), event `hub-update.restarting {version}` → the app quits by itself **without** `POST /shutdown` (`NSApp.terminate` on the next pass of the main loop, and `applicationShouldTerminate` with `hubRestarting` answers `.terminateNow`: an asynchronous `.terminateLater` answer inside the nested terminate loop would never see its task finish); if it does not leave within 5 s — SIGTERM to the pinned build's process (`/shutdown` does not stop the daemon at this time) | daemon + app | — | — |
| 5 | While the app was leaving: **the daemon is stopping** (SIGTERM, logout) — no switch (`failed: interrupted`; a SIGTERM after the switch still exits with code 75); **a pause was set** — no switch, supervision is in force again, the previous app is launched (by supervision; if the restart limit is exhausted it is not launched, `app-launch-skipped reason=hub-update-relaunch why=limited`; with no supervision the update service launches `appPin.path` by the same rules as supervision: only a pin of the current `requirements.app`, the bundle is ours, the signature on disk verified, otherwise `app-launch-skipped` with `why`), `failed: estop` | daemon | — | — |
| 6 | **Pinning** the new build: `requirements.app = identifier + cdhash of the new one`, `appPin = {by: "agenthub hub-update", path: Versions/<version>/AgentHub.app, version}`; the daemon re-reads it right away itself (`appPin.check("hub-update")`) — the change is recorded in the journal `app-requirement-changed` and `app-pin.json`, so the new daemon will not see it as "tampering at startup". Instead of the "re-pinned" push there is "Agent Hub updated" after confirmation | daemon | config.json: tmp 0600 + rename | roll back steps 6–8 (see §4), `phase: failed`, `error: switch-failed`, the previous version's app is launched again |
| 7 | **The pointer**: `previous → <old>`, then `current → <new>` | daemon | `current`: symlink + rename | same |
| 8 | **Built-in plugins** — the `<home>/Builtin` copy from `Versions/<new>/src/plugins` (`syncBuiltin`), `builtinPluginsDir` → the copy | daemon | file by file (like `agenthub builtin update`) | same |
| 9 | `install.json` ← `phase: trial, deadlineAt = +5 min`; **the watchdog** — a separate process of the old (verified, working) version `agenthub hub watch` (detached, in its own process group — launchd does not kill it together with the daemon) | daemon | tmp + rename | — |
| 10 | **Daemon restart**: a normal stop (`stopHub`) and exit with code **75** — launchd (`KeepAlive.SuccessfulExit = false`) brings the daemon up again, now from `Versions/current` = the new version. If it is not up within 20 s, the watchdog runs `launchctl kickstart gui/<uid>/com.kensei.agenthub` | daemon, launchd, watchdog | — | the watchdog rolls back on timeout |
| 11 | The new daemon: after 2 s the app service sees no app and launches `appPin.path` (the new app) — even with "Launch at login" off: the update service marks such a start with the fact `hub.update.startVerdict` (`confirm-wait`; returning to the previous version — `finalize-failed`, `restore`), and the app service does not take it for a login; with supervision off, the update service launches it | new daemon | — | — |
| 12 | **Confirmation**: the pinned (new) app opened the `/events` stream → transition `trial → done` under the `install.lock` lock and only for the same installation (`startedAt`): the watchdog may already have started rolling back → journal `hub-update-installed`, event `hub-update.installed`, push "Agent Hub updated to X"; old versions are pruned (keep `current`, `previous` and `keepVersions − 2` more; 3 in total by default) | new daemon | tmp + rename | — |
| 13 | **No confirmation by `deadlineAt`** (the new daemon did not come up, the app did not connect): transition `trial → rolling-back` under the same lock (whoever comes first — confirmation or rollback — decides), the watchdog rolls back the files (§4), kills the new app's processes (by the version's bundle path — including one that never connected), `launchctl kickstart -k` — the previous version comes up and writes `hub-update-failed why=trial-timeout`, push "The update failed — the hub stayed on X" | watchdog / daemon | as in §4 | — |

If the watchdog died (sleep, reboot), the update service makes the same judgement at startup: `phase: trial` and this is
the version being installed — it waits for the app until `deadlineAt` (if it came up after the deadline, the deadline is
counted from its start, once: `deadlineExtended`), otherwise it rolls back the files itself and exits with code 75; this
is the previous version (the watchdog rolled back) — it closes the installation as `failed` with a journal record and a
push. The daemon died during `building` or `ready` — `failed: interrupted`, staging is deleted; during `switching` or
`rolling-back` — the files are rolled back from `prev`. No snapshot (an old-format record) — the files are not touched
at all: a rollback from an empty snapshot would wipe the pin and the pointers. If the new version's daemon performed the
snapshot rollback, the outcome (journal, push "failed · the hub is on <previous>") is written by the previous version
after the restart (`rolled-back` → `finalize-failed`), not by the departing daemon.

Every installation builds from scratch: an existing `Versions/<version>` (anyone with the same UID could have put it
there) is never reused.

## 4. Rollback

**File rollback** (one function, `restoreFiles(prev)`, for a failed switch, the watchdog and the daemon): only from a
`capturePrev()` snapshot (all fields present), otherwise it touches nothing; `config.json` — `requirements.app` and
`appPin.path` as they were, `appPin.by = "agenthub hub-update rollback"` (the `app-requirement-changed` journal record
says who restored it) (tmp + rename), `current`/`previous` — the previous targets (symlink + rename),
`Builtin` — a copy from `Versions/<previous>/src/plugins`. Each rollback step is independent: a failure of one is
written to the journal, the rest still run.

**"Roll back to <previous>"** in "Settings": `POST /hub-update/rollback` (app only, not while paused) — the same switch
path (steps 4–13), only the target is `Versions/previous` (already built), there is no build, `op: rollback`. Only a
build that the hub itself pinned for that label is pinned (`HubUpdate/history.json`: written on every switch, migration
and emergency rollback; including the build we left): the bundle on disk and `build.json` must match the record,
otherwise `untrusted-build` or `verify-failed`. The button says "Roll back to X", and if X is newer than the current one
— "Return to X"; if it matches the available version it is not shown (that is "Update to X"). At least one previous
version is kept: pruning after confirmation never touches `current` and `previous`.

In an emergency, if the daemon does not come up at all, from your own terminal:
`node "$HOME/Library/Application Support/AgentHub/Versions/previous/src/daemon/bin/agenthub" hub rollback --apply`
— the same file rollback to `previous`, killing the app of the version we are leaving, and `launchctl kickstart -k`
(the CLI works with files and does not need the daemon). Like the shell buttons: only from a human's terminal (stdin is
a TTY; an agent in Bash has no TTY — refusal, code 3), not while paused (code 4; `--under-estop` — deliberately), the
`previous` bundle is verified (`codesign`) against `build.json` and the pin history. A `hub-update-cli` record goes to
the journal and the audit log; if the daemon is alive, the CLI waits up to 5 s for it to record the pin change itself
(`app-pin.json`), and only then runs `kickstart -k`.

## 5. Pinning and supervision

- **Supervision does not take an update for a crash**: from step 4 on `core.stopping = true` — the app service launches
  nothing; the daemon exits with code 75 and its new copy starts with clean supervision.
- **"Launch at login" is off** — a restart into the new version is not taken for a login: the start the installation is
  waiting for (`hub.update.startVerdict`) launches the app as usual; bringing back the previous app after a switch that
  did not happen (step 5) has the reason `relaunch`, bypassing the setting.
- **It does not launch the old copy**: by the restart `appPin.path` already points to the new build and
  `requirements.app` holds its cdhash; the old copy at `Versions/<old>/AgentHub.app` is "the wrong signature" for the new
  daemon (`pin-mismatch`), so it neither launches it nor accepts it as `app`.
- **Not "tampering"**: the pin change is written by the same process that expects it; the `app-requirement-changed`
  record with `by: "agenthub hub-update"` and the version stays in the journal and audit log, and the re-pin push is
  suppressed only for this expected change (the fingerprint matched the cdhash from the builder's answer or from the pin
  history) — it is replaced by the push "Agent Hub updated" · "X (was Y) · pinned build <cdhash:12>" (§6). The panel
  note "The app was rebuilt and pinned" is not shown for such a change if the installation confirms it (`by` from
  hub-update, fingerprint = the current version's build, installation `done`); otherwise the source is labeled "by a hub
  update" rather than "source unknown". A rollback (watchdog, new or previous daemon) restores the previous pin: its
  fingerprint is written to `install.json` (`restorePin`) **before** the files are rolled back, and any daemon accepts
  this change as expected while the installation is in the rollback phase — only if the hub itself pinned that build for
  the previous version (`history.json`); instead of "re-pinned" there is "The update failed". A change made by anyone
  else (with the same `by` but without an installation in progress) still produces "re-pinned".
- **A path change is not an alarm either**: `appPin.path` changes on every update and rollback (to
  `Versions/<label>/AgentHub.app`). The push "The pinned build path changed" · "The daemon now launches … If it wasn't
  you, open the journal" is suppressed only if the path leads into `Versions/<label>` of the target or previous version
  of an installation that is in progress (`switching`, `trial`, `rolling-back`) or finished less than 2 min ago
  (`install.json` is read from disk: the new daemon may see the change before the hub-update service comes up). The
  `app-pin-path-changed` record in the journal and audit log stays. A path to any other place triggers the push as
  always, during an installation too (the expected fingerprint does not count for the path: with the same signature it
  matches the current one).
- The daemon drops AgentHub.app connections when the pin changes — by then the old app has already quit.
- **Hub pause** blocks starting an installation or rollback (`423`) and the switch (step 3: built, but paused — no
  switch, `failed: estop`, the built version is deleted together with the failed installation; after the pause is lifted
  "Update" builds it again — another 2–5 min). The same if the pause was set while the app was leaving before the
  switch.
- **Permissions**: `install`, `rollback`, `check`, `PUT /settings/hub-updates` — `app` only; reading — `app` and `cli`.

## 6. API and events

| Route | Who | What |
|---|---|---|
| `GET /hub-update` | app, cli | the same as `/state.hubUpdate` |
| `POST /hub-update/check` | app | check now (waits for the `ls-remote` answer, ≤ 30 s; the release description is fetched after the answer, 15 s budget, → `hub-update.status`) → `hubUpdate` |
| `POST /hub-update/install {version, acceptCommit?}` | app | `202 {hubUpdate}` — the build has started; refusals — §3; a moved tag without `acceptCommit` — `409 hub-update:tag-moved` |
| `POST /hub-update/rollback {version?}` | app | `202` — switching to `previous` (or the given built version); `404 hub-update:no-previous`, `409 hub-update:untrusted-build` |
| `POST /hub-update/switch` | app | `202` — the built version was waiting (`ready`), restart into it now; `409 hub-update:not-ready` |
| (in `ready`) | app | `install` of the same version and `rollback` — `409 hub-update:ready` |
| `PUT /settings/hub-updates {enabled}` | app | "Check for hub updates" |
| `POST /registry/check-updates` | app | "Check now" for plugin updates → `pluginUpdates` |

`/state.hubUpdate`:

```json
{
  "installed": true, "running": "0.2.0", "label": "0.2.0",
  "current": {"label": "0.2.0", "version": "0.2.0", "tag": "v0.2.0", "commit": "abc…", "builtAt": "…",
              "notes": {"subject": "Agent Hub 0.2.0: …", "body": "…"}},
  "previous": {"label": "0.1.0", "version": "0.1.0"},
  "enabled": true, "setting": true, "config": true, "configured": true,
  "checkedAt": "…", "nextCheckAt": "…", "error": null,
  "available": {"version": "0.3.0", "tag": "v0.3.0", "commit": "…", "notes": {"subject": "…", "body": null}},
  "install": {"phase": "idle|building|switching|trial|done|failed", "op": "install|rollback", "label": "0.3.0",
              "step": "clone|build|verify|selftest|promote|switch|restart|confirm", "error": null, "log": "…/logs/…log",
              "startedAt": "…", "finishedAt": null, "from": "0.2.0", "waiting": null, "waitingCards": null, "waitingSessions": null},
  "blocked": null
}
```

`blocked` — why the buttons are disabled: `estop`, `not-installed`, `busy`, `null`. `source` — where new versions come
from: `git` (tags in origin) or `brew` (the Homebrew tree in `brew`, §8b; then `available` has `brew: true`, no tag).

SSE events: `hub-update.status {hubUpdate}` — any change (like `plugins.updates`); `hub-update.available {version}` —
once per version (push); `hub-update.restarting {label, op}` — the app quits without `/shutdown`;
`hub-update.installed {label, from, op}` and `hub-update.failed {label, error, log}` — push; `hub-update.ready
{label, waiting, notify}` — waiting for a second press (`notify: true` — push, once per version);
`hub-update.tag-moved {version, old, new}` — push. Journal: `hub-update-check`, `hub-update-available`,
`hub-update-start`, `hub-update-built`, `hub-update-switch`, `hub-update-installed`, `hub-update-failed`,
`hub-update-restore`, `hub-update-pruned`, `hub-update-ready` (`notify`), `hub-update-confirm`,
`hub-update-confirm-skipped`, `hub-update-deadline-extended`, `hub-update-tag-moved`, `hub-update-tag-accepted`,
`hub-update-skipped`, `hub-update-cli`, `settings-changed key=checkHubUpdates`.

Pruning (after confirmation, after a failure and on `finalize-failed`): versions — `current`, `previous` and the newest
up to `keepVersions`; versions that failed — right away; build logs — except those of `current` and `previous`, at most
10 and no older than 30 days; `hub-update-watch.log` — the last 128–256 KB.

Push (rules in `lib/push/rules.mjs`; for hub events the title is "Agent Hub", the subtitle is the gist, the body is the
detail, without repeating "Agent Hub / Agent Hub"): `hub-update` — "A new Agent Hub version is available" · "0.3.0 —
<description subject>. Currently 0.2.0 · update from the Agent Hub menu" (macOS only); `hub-update-ready` — "A new Agent
Hub version is built — waiting for restart" · "0.3.0. Waiting for an answer: 2 — the restart will remove their cards,
the questions will go to the terminal. Restart from the Agent Hub menu or in Settings" (sessions only — "Sessions
waiting for an answer: 2 — better answer first"; macOS only, once per version); `hub-update-installed` — "Agent Hub
updated" · "0.3.0 (was 0.2.0) · pinned build <cdhash:12>" (rollback: "Agent Hub returned to the previous version" ·
"0.1.0 (was 0.2.0) · …"); `hub-update-failed` — "The Agent Hub update failed" · "0.3.0: build error. The hub stayed on
0.2.0 · log: <path>" (always a banner, during quiet hours too); `hub-update-tag-moved` — "Agent Hub release tag moved" ·
"0.4.0: <old> → <new>. Installation only after confirmation: the window will show both commits". A pinned build path
change made by our own installation produces no push (§5). The time in the build log name is local, as in the UI.

## 7. Shell texts (ru / en)

The version is shown everywhere as a human label: "0.2.0"; after a migration without a tag ("0.1.0-dev.6ceb3d8") —
«0.1.0 (сборка из коммита)» / "0.1.0 (build from a commit)", with `.dirty` — «(сборка из рабочей папки)». The commit
and tag appear only under "Details" and in the log (§2, "The release description").

Popover (a line above the plugins, like a plugin update; labels are not truncated, buttons size to their labels):
- «Новая версия хаба: 0.3.0» · the release description subject (up to two lines, truncated with an ellipsis) ·
  «Сейчас 0.2.0» · button «Обновить» / "New hub version: 0.3.0" · … · "Now 0.2.0" · "Update";
- «Обновляю хаб до 0.3.0: загрузка исходников…» → «сборка…» → «проверка…» → «перезапуск…» (the step comes from the
  builder, §6 `install.step`) / "Updating the hub to 0.3.0: downloading sources…" → "building…" → "checking…" →
  "restarting…";
- built, someone is waiting: «Хаб 0.3.0 собран» · «Ждут ответа: 2 — перезапуск снимет их карточки» (sessions only —
  «Ждут ответа сессии: 2 — лучше сначала ответить») · «Перезапустить» / "Hub 0.3.0 is built" ·
  "Waiting for an answer: 2 — a restart drops their cards" · "Restart";
- «Обновление хаба до 0.3.0 не удалось» · «Хаб остался на 0.2.0 · подробности в Настройках» · «Подробнее» / "Hub update
  to 0.3.0 failed" · "Still on 0.2.0 · details in Settings" · "Details";
- after a successful update — for a day (or until "Got it"): «Хаб обновлён до 0.3.0» · description subject · «Было 0.2.0»
  / "The hub is updated to 0.3.0" · … · "Was 0.2.0"; if a newer one comes out — that one right away. Rollback —
  «Хаб возвращён на 0.2.0» · «Было 0.3.0» even when 0.3.0 is "available" (it is the version we left); after "Got it" (or
  a day) — not «Новая версия хаба: 0.3.0 · Обновить» but «0.3.0 можно поставить снова» · «Сейчас 0.2.0 после отката ·
  в Настройках» without a button; in "Settings" the button is «Поставить 0.3.0 снова». A newer one (0.3.1) is a regular
  "New hub version".

"Settings" (the section subtitle is "language, autostart, notifications, hub and plugin updates, cmux bridge, app
pinning") → the «Обновления хаба» / "Hub updates" card:
- «Текущая версия: 0.2.0» with the release description under it (the subject and up to two body lines) /
  "Current version: …";
- the switch «Проверять обновления хаба» / "Check for hub updates" and an explanation ("Several times a day…" — no
  hard-coded interval);
- the check line: «Проверено: <time> · новых версий нет» / «доступна 0.3.0» / «Проверка не удалась (<code>) · повтор
  <time>» / «Проверка выключена»; when available — «Что нового в 0.3.0: <description>» (subject up to two lines, body up
  to two, the text itself puts the ellipsis at the end of the visible line; only for a hub from `Versions` — a hub from
  a working folder has neither a version nor a button, and the description of a release found earlier in `check.json` is
  not shown); if the available version's tag moved — an orange line «Тег релиза 0.4.0 перенесён на другой коммит ·
  проверьте коммит перед установкой (окно покажет оба)» above the buttons;
- installation status: «Обновление до 0.3.0: сборка…», «Откат на 0.1.0: перезапуск…», «Собрано 0.3.0 — ждёт
  перезапуска. Ждут ответа: 2 — …», «Не удалось обновить до 0.3.1: ошибка сборки» + «Лог: <path>» and «Показать лог»;
  the outcome of the previous installation is not shown if the hub no longer runs from `Versions` (returned to the
  working folder) or the outcome is about another label; a failure follows the same rule as in the popover (a day, while
  there is nothing newer; a failed rollback — a day regardless of what is available: its label is an old version);
  "interrupted" — «хаб перезапустился во время установки — нажмите «Обновить», чтобы собрать заново»;
- buttons: the main one — «Перезапустить» (`ready`) or «Обновить до 0.3.0» (if the same version just failed —
  «Обновить до 0.3.1 ещё раз»; not shown during a build or in `ready` of the same version), «Проверить сейчас»,
  «Откатить на 0.1.0 (сборка из коммита)» (disabled in `ready`); if they do not fit in a row, rollback moves to the next
  line;
- «Подробности» (expandable): «Текущая: 0.2.0 · тег v0.2.0 · коммит abc1234 · собрана <time> · отпечаток
  <cdhash:12>» (as in the pin card), «Доступна: 0.3.0 · тег v0.3.0 · коммит …», «Прежняя: …»;
- not migrated: «Хаб работает из рабочей папки — обновления по кнопке недоступны. Сначала переведите его в отдельную
  установку: установщиком из папки репозитория agent-hub — bash scripts/install.sh --origin .» and the full command with
  "Copy" (`bash <repo>/scripts/install.sh --origin <repo>`, from `/state.hub.cli`; a path under the home directory —
  `~/…`, with a space — `"$HOME/…"`, otherwise in single quotes; a test directory also gets `--home <dir> --no-launchd`,
  so the copied command does not install the live hub). After that the update origin is **this working folder**: the
  check looks at the tags of its clone (§8a, item 3), not GitHub; to update from GitHub use the installer without
  `--origin` or `services.hubUpdate.remote` in config.json. `agenthub hub migrate --apply` works too.

Confirmation windows (NSAlert): «Обновить хаб до 0.3.0?» — the release description, «Сейчас: 0.2.0», a moved tag (both
commits) and a major version change if any, and what will happen («Хаб соберёт версию из тега отдельно…»), paragraphs
separated by an empty line; «Подробности: тег v0.3.0 · коммит abc1234» in small grey text under it; buttons «Обновить»
and «Отмена». «Откатить на 0.1.0?» — «Хаб вернётся на 0.1.0: она уже собрана, перезапуск займёт несколько секунд.
Сейчас: 0.2.0.», under the text the previous version's "Details" (fingerprint — «отпечаток <cdhash:12>»), buttons
«Откатить» and «Отмена». Core confirmations (428) — as before: «Подтвердите действие» and «Выполнить».

- moved tag — «Тег релиза 0.3.0 перенесён на другой коммит» · «проверьте коммит перед установкой».

"Plugin updates" in "Settings" get a "Check now" button (`POST /registry/check-updates`).

## 8. Initial migration

Usually the installer does it (§8a) — it is the same code (`buildAndSwitch`); `hub migrate` remains for moving from your
own working folder (including with `--allow-dirty`).

`agenthub hub migrate [--apply] [--from <repo>] [--allow-dirty] [--no-launchd]` from the working folder:
1. the source is `--from` or this CLI's repository; a tag on `HEAD` (`vX.Y.Z`, equal to `VERSION`) → label `X.Y.Z`; no
   tag → `X.Y.Z-dev.<commit7>`; a working tree with changes — refusal, `--allow-dirty` takes the files as they are
   (label `….dirty`);
2. build into `Versions/<label>` with the same builder (`hub build`, the source is the local repository, no network);
3. pin the new build, `current` (and `previous` if there was a version), copy the built-in plugins from the version;
4. a plist with paths through `Versions/current`, `bootout` + `bootstrap` (like `agenthub install --apply`).
Without `--apply` — only the plan. From a test directory (`AGENTHUB_HOME`) — only with `--no-launchd`. `--apply` — only
from a human's terminal (stdin is a TTY) and not while paused (`--under-estop`), like the emergency rollback. An origin
address with credentials (`https://user:token@…`) is refused: the token would end up in `build.json`, the journal and
logs; remove it from the address and keep it in the git keychain (the `osxkeychain` credential helper).

`scripts/bundle.sh` remains a developer tool and **by default does not touch the live installation**: it builds
`app/build/AgentHub.app` without pinning. To pin into a test directory — `--home <dir>`, into the live one — only with an
explicit `--pin-live` (the default before 2026-11-06). After migration, `agenthub install --apply` writes a plist with
`Versions/current` paths and takes the built-in copy from the current version, not from the working folder;
`agenthub builtin update` without `--from` also uses the current version.

## 8a. The installer (user decision 2026-11-07)

The repository is public, and the hub has no tokens of its own. The installer is **one self-contained file**,
`scripts/install.sh`: you can keep it, copy it anywhere and run it in Terminal (`bash install.sh`) or rename it to
`Установить Agent Hub.command` (`chmod +x`) and open it with a double click (the window waits for Enter before closing).
It also runs as a one-liner straight from GitHub:
`curl -fsSL https://raw.githubusercontent.com/KenseiTheOne/agent-hub/main/scripts/install.sh | bash` (the answer is read
from `/dev/tty`). After that — updates by tags (§2–§3); tagged versions are also published as GitHub releases (below,
"The path to releases").

```
bash install.sh [--origin <url|path>] [--plan] [--under-estop]     install (or repair the same version)
bash install.sh --uninstall [--purge] [--force]                     uninstall (agenthub uninstall of the installed version)
```

The installer picks node by the same rule as the launchd job (`launchdNode`, lib/launchd.mjs): first a suitable one
(≥ 22 with the `include/node/node_api.h` headers) from `/opt/homebrew/bin` and `/usr/local/bin`, otherwise the first
`node` on PATH (nvm, fnm, volta). The builder uses the same node to build the addon and run the new version's self-test,
and it is the one that goes into the plist: an old node in the Homebrew locations will not end up in launchd. If a
tagless branch is already installed (`X.Y.Z-dev.<commit>`) and main has new commits, labels are compared by history
(`merge-base --is-ancestor`), and the installer refuses with the hint "create the tag vX.Y.Z": the "Update" button
takes releases only.

1. **Checks** (all at once, as a list "missing: … — how to install", code 3): macOS ≥ 26 (`sw_vers`); Command Line
   Tools (`xcode-select -p` — before the first git call: without them `/usr/bin/git` opens an install window), git,
   swift and clang (`xcrun --find`), macOS SDK ≥ 26 (`xcrun --sdk macosx --show-sdk-version`); node ≥ 22 with headers
   (`include/node/node_api.h` — for the peercred addon). node is also looked up in `/opt/homebrew/bin`,
   `/usr/local/bin`: a `.command` window does not always see the PATH from `~/.zshrc`.
2. **Terminal**: confirmation is typing "y" in a human's terminal; when run through a pipe, the answer is read from
   `/dev/tty`; no terminal (a script, an agent session) — refusal (code 3). `--yes` (no question) — only together with
   `--home <test dir>`.
3. **Sources**: the `main` branch from origin — `git fetch --depth=1` into a temporary directory (`mktemp -d` in
   `$TMPDIR`, deleted at the end). The default origin is public, so git needs no credentials (a private `--origin` may make git
   ask for a login in the terminal once; after that the hub takes the credentials from the keychain itself). It is
   `https://github.com/KenseiTheOne/agent-hub.git`; `--origin` — another address or a **local clone**
   (`--origin ~/path/to/agent-hub`: no network at all; the update check then looks at that
   clone's tags). An address with credentials (`https://user:token@…`) is refused.
4. **Then — code from the downloaded branch**: `node <clone>/daemon/bin/agenthub hub install --origin … --apply`
   (`lib/hub-update/cli.mjs`). The installer has no build logic of its own — the same path as migration and updates:
   - what to install (`resolveInstallTarget`): `git ls-remote --tags` (like the update check: only `vX.Y.Z` releases,
     no pre-releases), a temporary bare mirror of the `main` branch in `$TMPDIR/agenthub-install-<rnd>` (the plan creates
     nothing in the hub directory); it takes the highest tag **whose commit is in main's history** (tags not on main are
     listed as "not installed"); no tags — `main` itself, label `X.Y.Z-dev.<commit7>` (X.Y.Z from its `VERSION`,
     "0.1.0 (build from a commit)" in the shell);
   - what is already installed: **the same version** (`Versions/current` = this label) — check and repair without
     rebuilding: the bundle is verified against `build.json` and the pin history, the pin of this build and the built-in
     copy, the plist, whether the daemon answers (it must be **this installation's daemon**: `GET /hub-update` —
     `installed` and the same label, the launchd job is loaded, and the pid from `/health` is the job's pid; otherwise
     "answers, but the wrong one" — the job is restarted, and a previous daemon that did not leave after `bootout` gives
     an honest refusal); all fine — "nothing to do", code 0. If the pin changed but the job is not restarted (the daemon
     is alive), the previous app copy (`appPin.path` before the repair) gets SIGTERM right here; **another version** —
     refusal (code 5): newer — "install it with the "Update" button" (that has a trial run and rollback), older —
     "rollback is in Settings; for a clean install — `agenthub uninstall`"; an update in progress
     (`building|ready|switching|trial|rolling-back`) — refusal;
   - **a hub from a working folder** (as the author had before 2026-11-07: the plist leads into the repository, `app/build`
     is pinned) — this is the migration: the same `buildAndSwitch` as `hub migrate`; `config.json` (settings, registry),
     `settings.json`, the journal, `Plugins/`, `PluginData/` stay as they were, only the pin, `Versions/current` and
     `builtinPluginsDir` change;
   - plan → "Install? [y/N]" → build with `buildVersion` (tag — `fetchTag` from origin, checking "on main" and the
     commit; branch — a clone of the mirror; `build-release.sh` from these sources, signature verification,
     `--self-test`) → pinning (`appPin.by = "agenthub hub install"`, shown in the shell as "by the hub installer"),
     `Versions/current`, the built-in copy, `history.json`, `install.json {phase: done, op: setup}`, a
     `hub-update-cli op=setup` record in the journal;
   - **launchd**: a plist in `~/Library/LaunchAgents` (the daemon through `Versions/current`, node — `launchdNode()`:
     `/opt/homebrew/bin/node`, otherwise `/usr/local/bin/node`, otherwise this node), `bootout` (wait until the previous
     daemon is gone), the previous app copy (`appPin.path` before installation, for example `app/build/AgentHub.app`)
     gets SIGTERM — supervision will no longer bring it up, `bootstrap`, wait for `/health` (15 s),
     `open -g Versions/<label>/AgentHub.app`;
   - result: where it is installed, how to update, the CLI path, how to uninstall; **the Claude Code hook** — the
     installer does not touch `~/.claude` and prints `claude --plugin-dir "<home>/Versions/current/src/claude-plugin"`
     (per session; the path is in the installation's `peer.hookPaths`) and a pointer to the permanent installation
     through a marketplace ([`claude-plugin/README.md`](../claude-plugin/README.md)).

**`agenthub uninstall [--apply] [--purge] [--no-launchd]`** (and `hub uninstall`; from the installer — `--uninstall`):
`bootout` (the daemon stops normally, SIGTERM; with the job removed, KeepAlive will not bring it up), the plist is
deleted; wait until the socket stops answering (if it does not — the daemon was started by hand: **nothing is deleted**,
code 1, a hint with the pid; to delete from under it — `--force`, and even then the socket of an answering daemon is not
touched); the app (builds of all versions and `appPin.path`) gets SIGTERM: the daemon is gone, supervision will not bring
it up, and the app itself will not bring up the daemon — there is no job; `Versions/`, `HubUpdate/`, `Builtin/`, build
logs `logs/hub-update-*` and `builtinPluginsDir` in `config.json` (if it pointed at the deleted copy) are removed.
Settings (`config.json`, `settings.json`), the journal, `Plugins/`, `PluginData/` stay — `--purge` removes them (the
whole hub directory only if it has a hub marker: `config.json`, `journal.jsonl`, `Versions/` or `HubUpdate/` — and no
foreign entries at the top level; otherwise refusal, code 2). It prints what is left, how to remove the secrets from the
keychain and the hook from Claude Code. During an update — refusal (`--force` — deliberately). `--apply` — only from a
human's terminal, with a "y/N" question. `--no-launchd` — only for a test directory (refused for the live one, code 2:
the job would stay loaded with a plist pointing at the deleted `Versions/current`).

**Test mode.** `--home <dir>` (= `AGENTHUB_HOME`) and `--yes`. launchd from a test directory — only with the
`AGENTHUB_TEST_LAUNCHCTL` double and a temporary `HOME` (the plist goes into `$HOME/Library/LaunchAgents`; the real home
directory is refused, `launchdAllowed`); the test job carries `AGENTHUB_HOME` in its environment and this process's
node. Otherwise — `--no-launchd`. Tests: `daemon/test/hub-install.test.mjs`.

**The path to releases.** Homebrew (§8b) is done: a formula over the release tarball of the same source tree. The
repository is public: (1) the installer runs as a one-liner
`curl -fsSL https://raw.githubusercontent.com/KenseiTheOne/agent-hub/main/scripts/install.sh | bash` — it reads the
answer from `/dev/tty`; (2) not done yet: the version source is in one place (`resolveInstallTarget` and the check
in `checker.mjs`), and the builder takes a source kind (`source.kind`: `tag`, `commit`, `dir`) — a GitHub release with
a prebuilt signed bundle would become one more kind (`release`: download the archive, verify the signature, no swift);
everything else (pinning, `Versions/`, launchd, the trial run) stays the same.

## 8b. Homebrew (user decision 2026-11-10)

Homebrew is the main way to install for others: no `.dmg` and no Apple Developer ID — the app is still built from
source on the user's Mac and signed ad hoc, exactly as by the installer. The tap is `KenseiTheOne/homebrew-tap`
(`Formula/agent-hub.rb`).

```
brew install KenseiTheOne/tap/agent-hub     the formula: source tree + the agenthub command, nothing is built
agenthub setup [--plan] [--no-launchd]      = agenthub hub install --brew --apply: build, pin, launchd, start
brew upgrade agent-hub                      a new version in the brew tree → "Update" in the hub menu
agenthub uninstall --apply; brew uninstall agent-hub     in this order
```

**The formula** builds nothing and never touches `~/Library` or launchd. `url` is the GitHub release tarball
(`archive/refs/tags/vX.Y.Z.tar.gz`) with its `sha256`; `head` is the git repository. `depends_on "node"` (≥ 22 with headers, as the
hub needs), `depends_on macos: :tahoe`. `install`: the whole tree into `libexec` except `docs/` screenshots
and `CLAUDE.md`; `libexec/COMMIT` — the release commit, only when the build directory has `.git` (`head`); a tarball has
none — then no file, and the hub works without it; `bin/agenthub` — a wrapper `env -u NODE_OPTIONS <brew node> <opt_libexec>/
daemon/bin/agenthub`. `skip_clean "libexec"`: otherwise brew rewrites `#!/usr/bin/env node` shebangs in the tree to its
node path. `caveats` print the next steps; `test` runs `agenthub version`. Homebrew 7 trusts a third-party formula when
it is installed by its full name (`brew install KenseiTheOne/tap/agent-hub`), so `brew upgrade agent-hub` works later.
The Command Line Tools cannot be a formula dependency: `agenthub setup` checks them (xcode-select, swift, clang, SDK ≥ 26)
before building.

**`agenthub setup`** finds the tree by its own location: node resolves the `bin` symlink, so the CLI runs from
`<prefix>/Cellar/agent-hub/<v>/libexec`, and the source recorded is the stable `<prefix>/opt/agent-hub/libexec` (the
opt link survives upgrades). `hub install --brew <dir>` takes any tree (tests). Everything else is §8a: the plan, "y/N"
in a human's terminal, the same `buildAndSwitch` with **source kind `brew`** (`lib/hub-update/build.mjs`: the real keg
directory is copied into `Versions/.staging-…/src` without `.git`, `node_modules`, `app/.build`, `app/build` and the old
peercred build; read-only keg files get the owner write bit; `COMMIT` must match the commit the check saw — otherwise
`commit-mismatch`; `VERSION` must match — otherwise `version-mismatch`; the formula is gone — `brew-missing`), pinning,
`Versions/current`, the built-in copy, the launchd job. `build.json → brew` records where the build came from.

**The update source** is `config.json → services.hubUpdate.brew = <prefix>/opt/agent-hub/libexec`, written by setup
after the switch and **read fresh** by the daemon (cached by the file's mtime): setup and uninstall change it while the
daemon runs, no restart. Set — **brew mode**: the hub never runs `git ls-remote` (a `remote` in the config is ignored);
the version is `VERSION` in the brew tree, the commit `COMMIT` (optional), both local reads. The available version is
read **live** on every `/state.hubUpdate` (after `brew upgrade` the shell sees it on its next status), the background
check every 15 min (`unconfiguredMs`, no jitter) only records `checkedAt` and sends the one-per-version "A new Agent Hub
version is available" push; "Check now" works as before. No major-jump filter and no moved-tag tracking (the human ran
`brew upgrade` themselves); no release notes (no annotated tag). "Update" (`POST /hub-update/install {version}`) for an
`available.brew` release starts the builder as `agenthub hub build --brew <dir> [--commit <c>]` (no origin, no stdin
URL); the rest — verification, the `ready` phase, switch, trial run, watchdog, rollback — is §3–§5 unchanged. The brew
tree is gone (`brew uninstall agent-hub` while the hub stays) — the check fails with `hub-update:brew-missing` («пакет
Homebrew agent-hub не найден — переустановите его…»), the hub keeps running.

`/state.hubUpdate` gains `source: "git" | "brew"` and `brew: <dir> | null`; `available` in brew mode is
`{version, tag: null, commit: <c> | null, brew: true}`.

Repeated `agenthub setup`: the same version — repair (§8a) plus the source check («обновления: из Homebrew»); brew has
a **newer** version than the installed hub — setup only records the brew source and says to press "Update" (the button
gives the trial run and rollback; the CLI never switches versions itself); brew has an **older** one — refusal (code 5).
A hub installed from git switches to brew this way, and back: `scripts/install.sh` (a git install or repair) clears the
brew source. `agenthub uninstall` clears it too and, for a brew-managed hub (or a CLI running from the keg), reminds:
`brew uninstall agent-hub`. `agenthub hub status` prints the source line, `agenthub version` — "(Homebrew package)".

Texts (ru/en): the Settings card — «Хаб установлен через Homebrew: новые версии приходят командой brew upgrade
agent-hub…» / "The hub is installed with Homebrew: new versions come with brew upgrade agent-hub…"; the check line —
«Проверено: <time> · новых версий нет · обновления приходят из Homebrew: brew upgrade agent-hub» or «в Homebrew есть
0.2.0»; the step — «копирование исходников из Homebrew…»; the confirmation window — «Хаб соберёт эту версию из пакета
Homebrew отдельно…», "Details" — «Homebrew · коммит abc1234»; "Details" in Settings — «Источник: Homebrew · <dir>».
Tests: `daemon/test/hub-brew.test.mjs`, the "Homebrew-managed hub" test in `hub-update.test.mjs`,
`HubUpdateTests.homebrewManagedHub` in the app.

## 9. How to cut a release

```sh
cd ~/path/to/agent-hub
scripts/set-version.sh 0.2.0          # VERSION + daemon/package.json + claude-plugin/.claude-plugin/plugin.json
(cd daemon && env -u NODE_OPTIONS node --test 'test/*.test.mjs') && scripts/app-test.sh   # tests are green
git commit -am "Agent Hub 0.2.0"
# tag = VERSION with a "v" (the builder checks it); the message is the release description for the popover, the window
# and "Settings": the first -m is what's new in one line (without "Agent Hub 0.2.0" — the hub shows the version itself),
# the following -m are details (or -F notes.md).
# The description is single-language (§2): the hub shows it as is in any UI language — write it in your users' language
git tag -a v0.2.0 -m "The \"Can I shut down\" card and a one-file installer" \
  -m "A verdict above the popover tiles: what is running, who is waiting for an answer." -m "The installer is scripts/install.sh, no tokens."
git push origin main v0.2.0
```

The hub sees the tag on the next check (≤ 6 h) or on "Check now", shows "A new hub version is available: 0.2.0" and
installs it on "Update". If a tag was already published with a mistake, do not rewrite it — release `v0.2.1` instead.

Then the Homebrew formula (§8b), in `KenseiTheOne/homebrew-tap`: `url` = `…/archive/refs/tags/v0.2.0.tar.gz` and its
`sha256` (`curl -fsSL <url> | shasum -a 256`) in `Formula/agent-hub.rb`, `brew audit --strict --formula KenseiTheOne/tap/agent-hub`,
commit and push the tap. Brew-managed hubs see the version after `brew upgrade agent-hub`.

## 10. Limits

- The watchdog and the rollback are written in the code of the **previous** version (proven by running); if the new
  version breaks its own confirmation mechanism, the watchdog rolls back on timeout. If launchd does kill the watchdog
  together with the daemon, the judgement in the new daemon at startup remains (it will not help if the new daemon does
  not load at all) — then the emergency `hub rollback --apply` from `Versions/previous`.
- After migration, a hook started with `claude --plugin-dir <working folder>/claude-plugin` is not in the new daemon's
  `peer.hookPaths` (which has `Versions/current/src/…` and the real version directory). An installed Claude Code plugin
  (`~/.claude/plugins/**`) is not affected.
- The build runs `swift build` in the background: 2–5 min of CPU; meanwhile the daemon and the app work as usual.
- Release provenance is verified like this: the tag is exactly `vX.Y.Z`, its commit is in the history of `origin/main`,
  it is the same commit the check saw (a move only with explicit confirmation), the jump is at most one major version,
  and before building there is a confirmation window with the tag and commit. A tag signature (`git verify-tag`) is not
  required: whoever can push to `main` with the user's credentials can also cut a release. Closing this gap means signed
  annotated tags with a Touch ID-protected key (a user decision, not done).
- `history.json`, `install.json` and `Versions/` have the same UID as the agents: they are tripwires (every pin is in
  the journal and audit log, a foreign change triggers a push), not protection against a process that rewrites the
  daemon too.
