#!/bin/bash
# Bump the hub version: VERSION (the single source of truth) and its derived copies, daemon/package.json and
# claude-plugin/.claude-plugin/plugin.json. Release procedure: docs/hub-updates.md §9.
#   scripts/set-version.sh 0.2.0
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="${1:-}"
if ! [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "set-version.sh X.Y.Z[-pre] (now: $(cat "$ROOT/VERSION"))" >&2
  exit 2
fi
printf '%s\n' "$V" > "$ROOT/VERSION"
for f in "$ROOT/daemon/package.json" "$ROOT/claude-plugin/.claude-plugin/plugin.json"; do
  env -u NODE_OPTIONS node -e '
    const fs = require("fs"); const [f, v] = process.argv.slice(1);
    const t = fs.readFileSync(f, "utf8");
    const n = t.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`);
    if (n === t && !t.includes(`"version": "${v}"`)) { console.error(`no version field: ${f}`); process.exit(1); }
    fs.writeFileSync(f, n);
  ' "$f" "$V"
done
echo "version $V: VERSION, daemon/package.json, claude-plugin/.claude-plugin/plugin.json"
echo "next: tests, git commit, git tag -a v$V -m \"Agent Hub $V\", git push origin main v$V"
