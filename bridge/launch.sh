#!/bin/sh
# launch.sh <session-uuid> <name> <prompt file> — the first command of a new terminal tab for session.launch.
# The prompt file (0600, ours) is read and deleted right away; then this tab runs
#   claude --session-id <uuid> --remote-control -n <name> -- <prompt>
# A <uuid>.local marker next to the prompt file (0600, ours — the form's Remote Control switch off) drops --remote-control.
# claude comes from the tab's PATH (the cmux shim with its hooks — that's how the session lands in claude-hook-sessions.json).
# No --allow-dangerously-skip-permissions or other bypasses.
set -u
sid=${1-}
name=${2-}
pf=${3-}
case "$sid" in
  ????????-????-????-????-????????????) ;;
  *) echo "launch.sh: bad session id" >&2; exit 2 ;;
esac
case "$sid" in *[!0-9a-f-]*) echo "launch.sh: bad session id" >&2; exit 2 ;; esac
if [ -z "$name" ]; then echo "launch.sh: no name" >&2; exit 2; fi
if [ -z "$pf" ] || [ -L "$pf" ] || [ ! -f "$pf" ] || [ ! -O "$pf" ]; then
  echo "launch.sh: no prompt file" >&2
  exit 2
fi
case "$(basename "$pf")" in
  "$sid.prompt") ;;
  *) echo "launch.sh: the prompt file is not for this session" >&2; exit 2 ;;
esac
mode=$(stat -f %Lp "$pf" 2>/dev/null || stat -c %a "$pf" 2>/dev/null)
if [ "$mode" != "600" ]; then
  rm -f -- "$pf"
  echo "launch.sh: the prompt file has mode $mode, 600 is required" >&2
  exit 2
fi
rc=--remote-control
lf="$(dirname -- "$pf")/$sid.local"
if [ -f "$lf" ] && [ ! -L "$lf" ] && [ -O "$lf" ]; then
  rc=
  rm -f -- "$lf"
fi
# printf x keeps the prompt's trailing newlines
prompt=$(cat -- "$pf"; printf x)
prompt=${prompt%x}
rm -f -- "$pf"
if [ -n "$prompt" ]; then
  exec claude --session-id "$sid" $rc -n "$name" -- "$prompt"
fi
exec claude --session-id "$sid" $rc -n "$name"
