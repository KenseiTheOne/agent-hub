# Agent Hub on Windows — groundwork

Status as of 2026-11-10. There is no Windows shell and none is planned for now (decision 2026-11-10): without a tray
icon and autostart the daemon is of little use there. This file records what a check of the daemon on Windows found,
what has already been moved into the core, and what is postponed until the shell is ported.

## Background

On 2026-11-09…10 the Node daemon was run on Windows and audited there. The result was a patch (82 files, against
the tree of that time — "the audited tree" below) with hand-off notes. The patch does not apply to the current tree as
a whole: after the audit, main received more changes and the core cleanup (contract v2). Paths and names below follow the patch; when porting, carry
them over by meaning.

On Windows with the patch: 341 tests pass, 0 fail, 53 are skipped (macOS only). Nobody has run the whole patch on a
Mac.

## Already moved over (2026-11-10)

Bugs that also exist on macOS/Linux, hardening that is useful on macOS, and cheap portability without changing
macOS behavior. Tests: `daemon/test/portability.test.mjs` (each fails without its fix), plus `peer.test.mjs`.

| Finding | Where it lives now |
|---|---|
| `osVars()` returned `null` on the first call when the OS has no `OS_*` commands (Linux, Windows): `buildEnv` crashed, a streamable plugin did not start | `runner.mjs` `osVars`/`collectOsVars` — the cache is updated in `.then` |
| An absolute path was checked with `startsWith("/")` | `platform.mjs` `isAbsolutePath` (on win32 — only with a drive letter: "/x", "\\x" and UNC are not, even though `win32.isAbsolute` accepts them); `host.mjs` `watchPaths`, `plugins.mjs` `loadRequests` |
| Directory comparison: copies of `resolve(a) === resolve(b)` all over the core | `platform.mjs` `samePath` (on win32 — case-insensitive and without a trailing separator; on POSIX also by realpath when both paths exist: APFS is case-insensitive); `core.mjs` hubInfo/bridgeInfo, `plugins.mjs` connect, `services/app.mjs`, `services/push.mjs`, `selftest.mjs`, `builtin-copy.mjs`, `hub-update/cli.mjs` (uninstall), `bin/agenthub` |
| The live hub directory via `defaultHome({})` — without `XDG_STATE_HOME`/`LOCALAPPDATA` | `liveStateDir()` in `core.mjs`, `plugins.mjs`, `launchd.mjs` (`stateDirs`, `daemonLocation`, `plistXml`) |
| A BOM in `config.json`/`settings.json`: the daemon did not start, the language was lost | `config.mjs` `readJsonFile` (UTF-16 gives a clear error) for every reader of these files |
| A corrupted `config.json` printed a stack trace instead of a line | `bin/agenthub`, `bin/agenthubd`: one line, exit code 1 |
| `install`/`uninstall` without launchd crashed (ENOENT, `process.getuid`) | `launchd.mjs` `hasLaunchd`; refusal with code 2 and a `--no-launchd` hint. The test variable `AGENTHUB_TEST_NO_LAUNCHD=1` does not lift the protection of the live directory in `uninstall --no-launchd` (that check is by platform) |
| Without the peercred addon a session was treated as "process exited" | `peer.mjs`: reason `no-peercred` |
| `open.file`: the list of forbidden types was incomplete for `open` on macOS too (`.pyw`, `.jnlp`, `.afploc`, `.term`, `.wflow`…) | `primitives/open.file.mjs`: an allowlist `OPEN_EXT`, directories only without an extension, everything else only reveal; a Finder alias and `OpenWith` are refused (`platform.mjs` `launchRedirect`; found by the port review, not in the patch); the type is checked again in `run()` — the swap window is narrowed, not closed ([`api.md`](api.md)) |
| Tests: hanging when setup fails, no skip reasons outside macOS | `helpers.mjs` (`IS_DARWIN`, `onlyDarwin`, `FILE_MODES`, `ensureNative`), `core.test`, `plugins-contract.test`; skips with a reason only in `actions-bridge`, `app-pin`, `cli`, `builtin-copy`, `peer`, `server`, `plugins-contract` (the rest is T4) |
| The text check of `agents.mjs` in `review-fixes.test` | kept (the `win32` guard in `psStartsUtc` cannot be checked by behavior on a Mac), with a behavior check next to it; remove together with A15 |

## Postponed

Everything below is needed only on Windows (or only makes sense together with other postponed parts). Port it
together with the shell.

### Daemon transport and authenticity

- **M2. The pipe name ignores `AGENTHUB_HOME`.** On Windows the channel is `\\.\pipe\agenthub-<user>`, not a file in
  the directory: the CLI of a test directory controlled the live hub, and a second daemon got EADDRINUSE. In the patch:
  `platform.mjs` `transportPath` (+ `winPathKey`: a hash of the directory realpath in the pipe name, except for the
  default directory), the same formula in `hook/agenthub-hook` and `claude-plugin/hook/agenthub-hook`, recomputing the
  address after `mkdir` in `server.mjs`. On POSIX the socket lives in the directory — no bug.
- **A4. Pipe name squatting.** While there is no daemon, any user of the machine can take the pipe name. In the patch:
  `<home>/hub.key` (0600), `GET /proof` (HMAC-SHA256 with that key over a client nonce) — `config.mjs` (`hubProof`,
  `proofMatches`, `readHubKey`), `server.mjs`, `bin/agenthub` (requests only over a connection that proved itself),
  both hooks. The macOS protocol does not change.
- **A27.** `server.mjs`: a clear EADDRINUSE message ("the pipe is taken by another daemon or a stranger") — needed
  because of M2/A4.
- **A28.** The hook on Windows: a pipe with the path hash and `/proof` before sending `tool_input` — part of M2/A4. The
  copy `claude-plugin/hook/agenthub-hook` must match `hook/agenthub-hook`. The hook is not tested on Linux either.

### Paths to system programs and launching

- **A1. `posixTool`: `/usr/bin/xattr|security|osascript|codesign`, `/usr/sbin/ioreg`.** On Windows a root path without
  a drive letter resolves to `<cwd drive>:\usr\bin\*.exe`, which any user can create (RCE, reproduced). In the patch
  such paths are `null` on Windows: `platform.mjs` `posixTool`, `app-sign.mjs` (`codesignCommand`), `peer.mjs`
  (codesign — fail closed, not open), `push/idle.mjs`, `services/secrets.mjs`, `meta.mjs` (the chat-bot module the patch also touched was removed on
  2026-11-11).
  **Required before running the daemon on Windows at all.**
  The same class of bug in code added after the audit — the patch did not see it; close it together with A1 when
  porting:
  - `hub-update/build.mjs` (≈ line 313) — `runLogged(["/bin/bash", script, …])` when building a new version
    (`hub install`, auto-update by tags);
  - `hub-update/cli.mjs` `launchctlFor` — `"/bin/launchctl"` for the live directory; it only checks "is it live",
    not the platform;
  - `services/secrets.mjs` `start` — `"/usr/bin/security"` without a darwin check (`services/usage.mjs` already has
    one: `process.platform === "darwin" ? "/usr/bin/security" : null`);
  - `keychain.mjs` and `registry/own-source.mjs` (`ls -le`) — `env: { PATH: "/usr/bin:/bin" }`; in own-source the
    command is already `null` outside macOS (`aclListCommand`).
- **A2.** `ctx.exec` and `runOnce` refuse root paths without a drive letter (`driveRelativeRoot` in `platform.mjs`,
  `ctx.mjs`, `runner.mjs`) — the second line of the same defense.
- **A12.** `.ps1` with UTF-8 input and output: a launcher with `chcp 65001` (`platform.mjs` `windowsArgv`) — PowerShell 5.1.
- **A13.** Killing MSYS (Git Bash) process trees: `spawnTree` with an `AGENTHUB_TREE` marker in the environment and
  `sweepMsysTree` (`platform.mjs`, `runner.mjs`). On POSIX the process group takes care of descendants.
- **A14.** `killTree`: do not call `taskkill /T /F` on the pid of a process that has already exited — Windows reuses
  pids quickly.
- **A11.** Plugin environment: `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles*`, `SystemDrive`, `USERNAME`
  and `PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` (`runner.mjs` `WIN_SYSTEM_ENV`): Python writes to a pipe in ANSI, and
  without `APPDATA` it does not see `pip --user` packages.

### open.file on Windows (A3b)

Only a local `C:\…` path — not UNC (a network logon with NTLM happens already at stat), not `\\?\`/`\\.\`, not an NTFS
ADS stream (`openPathProblem`); an allowlist of types for ShellExecute (`openTypeProblem`, `x.{CLSID}` directories are
bundles); quoting in `explorer /select,"…"` and `ctx.exec(..., { verbatim: true })`; explorer exits with code 1 even on
success (`openOk`); `realpathSync.native` (the long name instead of 8.3). Files: `platform.mjs`,
`primitives/open.file.mjs`, `ctx.mjs`. The shared part (the allowlist, the repeated check in `run()`) has already been
moved over.

### Files, encodings, plugins

- **A5. EBUSY when updating or removing a running plugin.** `PluginHost.hold`/`stopAndWait`, `ctx.holdPlugin`,
  `holdPlugins`, error `registry:busy`, async `remove`, a deferred move on blocklist (`disabled.moved=false`).
  Files: `host.mjs`, `ctx.mjs`, `plugins.mjs`, `services/plugins.mjs`, `routes/plugins.mjs`, `L10n.swift`
  (+`registry:busy`). It changes the `ctx` contract and stops the plugin on every update — no benefit on macOS.
- **A6.** `fsutil.mjs` `renameRetry`: retry rename on EPERM/EBUSY/EACCES (`plugins.mjs`, `builtin-copy.mjs`,
  `services/usage.mjs`). On macOS it is an empty wrapper.
- **A7.** Journal rotation while `.1` is open (EPERM): delete `.1` and retry, otherwise keep writing to the current
  file (`journal.mjs`).
- **A9.** Script metadata in UTF-16 with a BOM and the warning "zeros in the script — UTF-16 without a BOM?"
  (`meta.mjs`): that is how PowerShell 5.1 (`>`, `Out-File`) and Notepad write. `meta.mjs` is a vendored file
  (sync-vendor in agent-hub-plugins and other plugin repositories).
- **A10.** `.exe`/`.com` plugins: `isExecutableFile`, metadata from the NTFS stream `<file>:com.kensei.agenthub.meta`,
  a warning about `.cmd`/`.bat` (`meta.mjs`). Windows has no x bit and no xattr.
- **A25.** `localSourcePath`: a registry mirror on Windows — only a local drive, UNC and `file://host` are refused
  (bypassing `allowNetwork` via SMB); `resolve(baseDir)` for archive (`plugins.mjs`, `bin/agenthub` `registryUrlOk`).

### Lifecycle and push

- **A17.** `agenthub stop` (POST `/shutdown` from cli), SIGBREAK, SIGHUP as console close,
  `core.onShutdownRequest` (`bin/agenthub`, `bin/agenthubd`, `server.mjs`, `core.mjs`). When porting, reconcile it
  with the existing `/shutdown` (currently `app` only; exit code 0 and KeepAlive). The route in the patch admits
  `cli`, and on Windows without peer verification `cli` means **any process of the user**: it can be opened to cli
  only together with a `GetNamedPipeClientProcessId` check or with `/proof` (A4).
- **A19.** A banner on Windows: a toast via `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (the text
  goes through environment variables and CreateTextNode, `ToastNotifier.Setting` is checked, no wait for an app
  acknowledgement). `bannerCommand()` returns a descriptor `{channel,file,args,env,timeoutMs}`, the
  `createMacNotifier` parameter `osascript` → `banner`. Files: `push/macos.mjs`, `services/push.mjs`, `push/acks.mjs`,
  `push/config.mjs`, `push/rules.mjs`, `routes/push.mjs`.
- **A20.** The push engine without its own banner (`mac.local === false`): `pendingAt`, `afterApp`, `afterDigestApp`,
  `push-undelivered`, `push-sent` only on actual delivery (`push/engine.mjs`). In the patch no platform enables this
  path; `engine.mjs` changed a lot after the audit (+160 lines) — rewrite it from scratch.
- **A21.** Secrets without a keychain: `keychainCommand()` → `null` (`services/secrets.mjs`). Part of A1. (The patch
  also covered the chat-bot channel of the push service; that channel was removed on 2026-11-11.)

### The built-in agents plugin

- **A15.** Pid reuse on Windows: `procStart` as FILETIME, `Win32_Process.CreationDate` via PowerShell with a
  one-minute cache, start time verification only for sessions with runs (`plugins/agents/agents.mjs`, README). Move it
  over together with a plugin version (1.1.3).
- **A16.** `projectLabel`: "~" for the Windows home directory and the encoded project path `C--Users-…`.

### Tests and build

- **T4.** Tests on Windows: paths via `join`/`sep`, `nativePath`, `sockPath`, `fixtures/pipe-curl.mjs` (curl over a
  named pipe), `scriptArgv`, `$!` and winpid in MSYS, signals as exit codes, ":" in a file name,
  `setHome(USERPROFILE)`, `cleanup` with retries, junctions; files `test/win-*.test.mjs` (agents-plugin, exec-paths,
  fs-io, lifecycle-transport, runner-platform), `hook-helpers.mjs`.
- **T5.** `daemon/package.json`: double quotes in the `test` script (cmd.exe does not strip single ones) and `test:win`.
- **D1.** The patch documentation — port it together with the features: `api.md` (`/proof`, `/shutdown`, `hub.key`,
  `push-undelivered`), `extension-points.md` (`holdPlugin`, verbatim, open.file, `.ps1`, `.exe`, ADS, environment),
  `hook.md`, `plugins-registry.md` (`registry:busy`, mirror), `CHANGELOG.md`, `push/README.md`.

### Code after the audit that nobody has checked on Windows

The Windows audit was against the audited tree; everything that came later (including contract v2) has not been run on
Windows: `keychain.mjs` (keychain via `security -i`), `hub-update/` (building with `/bin/bash`, `/bin/launchctl`,
`git`, switching versions), `app-supervisor.mjs` (launching and finding the app process), `oauth.mjs` and
`services/oauth.mjs`, `idle.mjs`, `registry/own-source.mjs` (own plugin sources, ACL via `ls -le`). Before porting,
put them through the same audit; for absolute POSIX paths in them see A1.

## What porting the shell requires

1. Security first: A1 (with the paths from code after the audit, see A1), A2, A3b, M2, A4 (+A27, A28) — without them
   the daemon must not be run on Windows.
2. The shell: a tray icon, a panel window, autostart (Task Scheduler or a Run key instead of launchd), build pinning
   (WinVerifyTrust instead of codesign) and peer verification via `GetNamedPipeClientProcessId` instead of peercred —
   until then every client is cli (fail closed).
3. Banners (A19, A20), secrets (A21 or Credential Manager), shutdown (A17), EBUSY (A5–A7).
4. T4 tests and a run on Windows; then the D1 documentation.

## Other platforms

Linux is not supported. Bugs found on Windows that Linux shares (M1, A18, A23) are fixed, but the daemon as a whole has
not been run on Linux. Skips with a reason are not everywhere: `hub-install.test` (`/usr/bin/plutil`),
`app-lifecycle`, `push-*` and others will fail on Linux rather than skip (T4). The cmux bridge has not been tested on
Linux.

A known Linux bug (not in the patch): the hook `hook/agenthub-hook` (`socketPath`, and the copy in
`claude-plugin/hook/agenthub-hook`) without `AGENTHUB_HOME` always looks for the socket in
`~/Library/Application Support/AgentHub`, while the daemon on Linux keeps it in `$XDG_STATE_HOME/agenthub`
(`~/.local/state/agenthub`, `platform.mjs` `stateDir`). There is no socket at the hook's path, so the hook silently
answers `{}` and permission cards never arrive.
