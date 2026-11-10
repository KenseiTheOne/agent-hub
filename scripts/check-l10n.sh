#!/bin/bash
# Shell translation check (UI pass 2026-11-05): app/Sources has no Cyrillic in string literals
# outside tr("…", "…") / pluralRu / plural(…). Comments do not count. Exit code 1 — untranslated strings found.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bad=$(grep -rnE '"[^"]*[А-Яа-яЁё][^"]*"' "$ROOT/app/Sources" --include='*.swift' \
  | grep -vE '^\S+:[0-9]+:\s*(//|///)' \
  | grep -vE 'tr\(|pluralRu\(|plural\(|ru: \(' \
  | grep -vE 'case "ru"|"Русский"' || true)
if [ -n "$bad" ]; then
  echo "Untranslated strings (wrap them in tr(\"…\", \"…\")):"
  echo "$bad"
  exit 1
fi
echo "Shell translation: no strings outside tr()."
