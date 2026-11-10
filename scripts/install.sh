#!/bin/bash
# Agent Hub installer — one self-contained file: copy it anywhere and run it in Terminal
# (`bash install.sh`), or rename it to "Install Agent Hub.command" (chmod +x) and double-click it.
#
#   bash install.sh                       install the latest release (tag vX.Y.Z on main) from origin; no tags — main
#   bash install.sh --origin <url|path>   another origin: a git URL or a local clone (~/path/to/agent-hub)
#   bash install.sh --plan                only show what would happen (changes nothing)
#   bash install.sh --uninstall [--purge] remove the installed hub (agenthub uninstall); --purge — also settings,
#                                         the journal, plugins and their data; --force — even if an update is stuck
#   bash install.sh --under-estop         install even though the hub is paused (ESTOP) — deliberately
#
# What it does: checks macOS 26, Command Line Tools (git, swift, clang), node ≥ 22 with headers; fetches the main branch
# from origin via git (the public repository needs no credentials; the hub has no tokens of its own) into a temporary
# directory and runs `agenthub hub install` from there — the same code that builds updates from the button: a build in
# ~/Library/Application Support/AgentHub/Versions/<version>, pinning the build, a copy of the built-in plugins, the
# launchd job, launch. A hub running from a working folder is moved to Versions (settings and data stay).
# Running it again is safe: the same version — check and repair without rebuilding; another one — refusal with a hint
# to update with the Update button. The installer does not set up the Claude Code hook (does not touch ~/.claude) — it prints the command.
#
# Confirmation — by typing "y" in the terminal; without a terminal (from a script, from an agent session) the installer refuses.
# For tests: --home <dir> (a test AGENTHUB_HOME) and --yes (no question; only together with --home),
# --no-launchd (don't touch launchd). Details: docs/hub-updates.md §8a.
set -euo pipefail

DEFAULT_ORIGIN="https://github.com/KenseiTheOne/agent-hub.git"
ORIGIN="$DEFAULT_ORIGIN"
TEST_HOME=""
YES=0
PLAN=0
UNINSTALL=0
PURGE=0
NO_LAUNCHD=0
FORCE=0
UNDER_ESTOP=0
MIN_MACOS=26
MIN_NODE=22

say() { printf '%s\n' "$*"; }
err() { printf 'install.sh: %s\n' "$*" >&2; }

# Double-clicking a .command: the Terminal window closes immediately — wait for Enter.
pause_if_command() {
  case "$0" in
    *.command) [ -t 0 ] && { printf '\nPress Enter to close the window.'; read -r _ || true; } ;;
  esac
}
trap 'pause_if_command' EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --origin) ORIGIN="${2:?--origin: a git URL or a repository path is required}"; shift ;;
    --home) TEST_HOME="${2:?--home: a directory is required}"; shift ;;
    --yes) YES=1 ;;
    --plan) PLAN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --no-launchd) NO_LAUNCHD=1 ;;
    --force) FORCE=1 ;;
    --under-estop) UNDER_ESTOP=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; trap - EXIT; exit 0 ;;
    *) err "unknown argument \"$1\" (--help for help)"; exit 64 ;;
  esac
  shift
done

# An origin URL with credentials (https://user:token@…, https://user@…) — refuse right away, before git and before any output with
# the URL: the token would end up in the terminal, in git fetch (and via the credential helper — in the keychain), and then in build.json,
# the journal and logs. The same rule as hasUserinfo in daemon/lib/hub-update/remote.mjs: ssh://user@host (a name only, no
# password) — allowed. In messages the URL has "***" instead of the credentials.
redact_origin() {
  # ssh://user@host — a name without a password is not a secret (like redactUrl in remote.mjs)
  if printf '%s' "$1" | grep -qiE '^(ssh|git\+ssh|ssh\+git)://[^/@:]*@'; then printf '%s' "$1"; return; fi
  printf '%s' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/@]*@#\1***@#'
}
origin_userinfo() {
  local rest scheme info
  case "$1" in *://*) ;; *) return 1 ;; esac
  scheme="${1%%://*}"
  rest="${1#*://}"
  rest="${rest%%/*}"
  case "$rest" in *@*) info="${rest%@*}" ;; *) return 1 ;; esac
  [ -n "$info" ] || return 1
  case "$info" in *:*) return 0 ;; esac
  case "$(printf '%s' "$scheme" | tr '[:upper:]' '[:lower:]')" in ssh|git+ssh|ssh+git) return 1 ;; esac
  return 0
}
if origin_userinfo "$ORIGIN"; then
  err "origin URL with credentials ($(redact_origin "$ORIGIN")) — refusing: the token would end up in the journal, the logs and build.json."
  err "  remove them from the URL: git takes the login and token from the keychain (credential helper osxkeychain)"
  exit 2
fi
ORIGIN_SHOWN="$(redact_origin "$ORIGIN")"

if [ "$YES" = 1 ] && [ -z "$TEST_HOME" ]; then
  err "--yes only together with --home <test dir>: a human confirms a live install in the terminal"
  exit 2
fi
if [ -n "$TEST_HOME" ]; then
  mkdir -p "$TEST_HOME"
  TEST_HOME="$(cd "$TEST_HOME" && pwd)"
  export AGENTHUB_HOME="$TEST_HOME"
fi
HUB_HOME="${AGENTHUB_HOME:-$HOME/Library/Application Support/AgentHub}"

# ---------- dependencies ----------
# also look for node where Homebrew and the nodejs.org installer put it: a .command window does not always see the PATH from ~/.zshrc.
EXTRA_PATH="${AGENTHUB_TEST_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin}"
[ -n "$EXTRA_PATH" ] && PATH="$PATH:$EXTRA_PATH"
export PATH

missing=()
if [ "$(uname -s)" != "Darwin" ]; then
  err "Agent Hub runs on macOS only"
  exit 3
fi
macos="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if [ "${macos%%.*}" -lt "$MIN_MACOS" ] 2>/dev/null; then
  missing+=("macOS $MIN_MACOS (Tahoe) or newer — now $macos. Update the system: System Settings → General → Software Update")
fi
# Command Line Tools — before the first git call: without them /usr/bin/git opens an install dialog instead of answering
if ! xcode-select -p >/dev/null 2>&1; then
  missing+=("Command Line Tools (git, swift, clang): xcode-select --install — then run the installer again")
else
  command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1 || missing+=("git (from Command Line Tools): xcode-select --install")
  if ! xcrun --find swift >/dev/null 2>&1; then
    missing+=("swift (from Command Line Tools): xcode-select --install")
  else
    sdk="$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || echo 0)"
    if [ "${sdk%%.*}" -lt "$MIN_MACOS" ] 2>/dev/null; then
      missing+=("macOS $MIN_MACOS SDK in Command Line Tools — now $sdk. Update them: System Settings → General → Software Update (or download Command Line Tools from developer.apple.com)")
    fi
  fi
  xcrun --find clang >/dev/null 2>&1 || missing+=("clang (from Command Line Tools): xcode-select --install")
fi
# node — by the same rule as the launchd job (daemon/lib/launchd.mjs, launchdNode): first a suitable one from the Homebrew and
# nodejs.org locations (/opt/homebrew/bin, /usr/local/bin — launchd will run those), otherwise the first node on PATH (nvm, fnm,
# volta). Suitable — version ≥ MIN_NODE with the include/node/node_api.h headers next to it (the addon is built against them). Otherwise
# the installer would check one node while the daemon under launchd would start with another, old one.
node_version() { env -u NODE_OPTIONS "$1" -p 'process.versions.node' 2>/dev/null || echo 0; }
node_headers() { [ "$(env -u NODE_OPTIONS "$1" -p "require('fs').existsSync(require('path').resolve(process.execPath, '../../include/node/node_api.h'))" 2>/dev/null)" = "true" ]; }
node_ok() { local v; v="$(node_version "$1")"; [ "${v%%.*}" -ge "$MIN_NODE" ] 2>/dev/null && node_headers "$1"; }
NODE=""
IFS=: read -r -a node_dirs <<< "$EXTRA_PATH"
for d in ${node_dirs[@]+"${node_dirs[@]}"}; do
  [ -n "$d" ] && [ -x "$d/node" ] && node_ok "$d/node" && { NODE="$d/node"; break; }
done
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE" ]; then
    missing+=("node $MIN_NODE or newer: brew install node (Homebrew — https://brew.sh) or the installer from nodejs.org")
  else
    nv="$(node_version "$NODE")"
    if [ "${nv%%.*}" -lt "$MIN_NODE" ] 2>/dev/null; then
      missing+=("node $MIN_NODE or newer — now $nv ($NODE): brew upgrade node")
    elif ! node_headers "$NODE"; then
      missing+=("node headers (include/node/node_api.h next to $NODE) — needed to build the addon; brew install node and the nodejs.org installer provide them")
    fi
  fi
fi
if [ ${#missing[@]} -gt 0 ]; then
  err "missing:"
  for m in "${missing[@]}"; do printf '  - %s\n' "$m" >&2; done
  exit 3
fi

# ---------- terminal for confirmation ----------
# node asks "Install? [y/N]" and checks that this is a human's terminal. Launched through a pipe — take
# the answer from /dev/tty; no terminal at all (a script, an agent session) — refuse.
STDIN_TTY=0
if [ "$YES" = 0 ] && [ "$PLAN" = 0 ]; then
  if [ -t 0 ]; then
    STDIN_TTY=0
  elif { : </dev/tty; } 2>/dev/null; then
    STDIN_TTY=1
  else
    err "a terminal is required: the installer asks for confirmation. Run it yourself in Terminal."
    exit 3
  fi
fi
run_node() {
  if [ "$STDIN_TTY" = 1 ]; then env -u NODE_OPTIONS "$NODE" "$@" </dev/tty; else env -u NODE_OPTIONS "$NODE" "$@"; fi
}

common=()
[ "$YES" = 1 ] && common+=(--yes)
[ "$NO_LAUNCHD" = 1 ] && common+=(--no-launchd)
[ "$PLAN" = 0 ] && common+=(--apply)
if [ "$FORCE" = 1 ] && [ "$UNINSTALL" = 0 ]; then
  err "--force only together with --uninstall"
  exit 64
fi

# ---------- uninstall ----------
if [ "$UNINSTALL" = 1 ]; then
  CLI="$HUB_HOME/Versions/current/src/daemon/bin/agenthub"
  if [ ! -f "$CLI" ]; then
    err "no install in $HUB_HOME (Versions/current) — nothing to remove. A hub running from a working folder is removed by its CLI: node <repository>/daemon/bin/agenthub uninstall --apply"
    exit 1
  fi
  args=(uninstall ${common[@]+"${common[@]}"})
  [ "$PURGE" = 1 ] && args+=(--purge)
  [ "$FORCE" = 1 ] && args+=(--force)
  run_node "$CLI" "${args[@]}"
  exit $?
fi

# ---------- sources: the main branch into a temporary directory ----------
case "$ORIGIN" in
  *://*|*@*:*) ;;
  *) ORIGIN="$(cd "${ORIGIN/#\~/$HOME}" 2>/dev/null && pwd)" || { err "--origin: no directory $ORIGIN"; exit 1; } ;;
esac
ORIGIN_SHOWN="$(redact_origin "$ORIGIN")"
BOOT="$(mktemp -d "${TMPDIR:-/tmp}/agenthub-install.XXXXXX")"
cleanup() { rm -rf "$BOOT"; pause_if_command; }
trap cleanup EXIT
say "Agent Hub: fetching the installer from $ORIGIN_SHOWN (main branch)…"
git init -q "$BOOT/src"
# the default origin is public: no credentials needed (a private --origin may make git ask for a login in the terminal)
if ! git -C "$BOOT/src" fetch -q --depth=1 --no-tags "$ORIGIN" "+refs/heads/main:refs/remotes/origin/main"; then
  err "could not fetch the main branch from $ORIGIN_SHOWN."
  err "  check the network and the address: git ls-remote $ORIGIN_SHOWN"
  err "  or install from your own clone: bash $0 --origin ~/path/to/agent-hub"
  exit 1
fi
git -C "$BOOT/src" -c advice.detachedHead=false checkout -q --detach refs/remotes/origin/main
CLI="$BOOT/src/daemon/bin/agenthub"
if [ ! -f "$CLI" ]; then
  err "main from $ORIGIN_SHOWN has no daemon/bin/agenthub — is this not the Agent Hub repository?"
  exit 1
fi
set +e
[ "$UNDER_ESTOP" = 1 ] && common+=(--under-estop)
run_node "$CLI" hub install --origin "$ORIGIN" ${common[@]+"${common[@]}"}
code=$?
set -e
if [ "$code" = 64 ]; then
  err "this version of main has no \"agenthub hub install\" command — the branch is older than the installer"
fi
exit "$code"
