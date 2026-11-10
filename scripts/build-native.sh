#!/bin/sh
# Builds the peercred N-API addon with clang from Command Line Tools against the installed node's headers.
# No node-gyp and no Xcode. Output: daemon/native/peercred/build/peercred.node
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/daemon/native/peercred/peercred.c"
OUT_DIR="$ROOT/daemon/native/peercred/build"
NODE=${NODE:-node}

# Drop NODE_OPTIONS: the cmux preload crashes child node processes.
INC=$(env -u NODE_OPTIONS "$NODE" -p "require('path').resolve(process.execPath, '../../include/node')")
if [ ! -f "$INC/node_api.h" ]; then
  echo "build-native: $INC/node_api.h not found — node headers are required (Homebrew node installs them)" >&2
  exit 1
fi
CC=${CC:-clang}
if ! command -v "$CC" >/dev/null 2>&1; then
  echo "build-native: no $CC — install Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
"$CC" -O2 -Wall -Wextra -Wno-unused-parameter -std=c11 \
  -bundle -undefined dynamic_lookup \
  -I"$INC" -o "$OUT_DIR/peercred.node.tmp" "$SRC"
mv "$OUT_DIR/peercred.node.tmp" "$OUT_DIR/peercred.node"
echo "build-native: $OUT_DIR/peercred.node"
