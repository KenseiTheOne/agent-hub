#!/bin/bash
# Builds a hub version for a standalone install (docs/hub-updates.md): the peercred addon and AgentHub.app without
# pinning. The update builder (lib/hub-update/build.mjs) runs it from the NEW version's sources — each
# version knows how to build itself. Does not touch the live install: the daemon pins and switches after verification.
#
#   scripts/build-release.sh --out <dir>        → <dir>/AgentHub.app (ad hoc signature),
#                                                 daemon/native/peercred/build/peercred.node in these sources
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out: a directory is required}"; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-release.sh: unknown argument \"$1\"" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$OUT" ] || { echo "build-release.sh --out <dir>" >&2; exit 2; }
echo "==> version $(cat "$ROOT/VERSION")"
echo "==> peercred addon"
"$ROOT/scripts/build-native.sh"
# The prebuilt app from the tag's GitHub release (scripts/prebuilt.mjs): signed by CI, matched to this commit by
# version, commit, sha256 and cdhash. Hubs of any version run this script from the new tag, so all of them get it.
# Anything wrong (offline, no release yet, a fork, a bad signature) → the local swift build below, as before.
NODE_BIN="${NODE:-$(command -v node || true)}"
if [ -n "$NODE_BIN" ] && env -u NODE_OPTIONS "$NODE_BIN" "$ROOT/scripts/prebuilt.mjs" fetch --out "$OUT"; then
  exit 0
fi
echo "==> AgentHub.app (not pinned)"
"$ROOT/scripts/bundle.sh" --no-pin --out "$OUT"
