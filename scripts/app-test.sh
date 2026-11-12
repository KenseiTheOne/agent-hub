#!/bin/bash
# Shell app tests (Swift Testing). With Command Line Tools, swiftbuild does not always pass the Testing macro
# plugin to the compiler (`TestingMacros ... not found`), so its path is set explicitly.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS="$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
# Parallel is safe: every test case has its own language (the .hubLang trait, a task-local L10n.$scope —
# app/README.md "Test language"), so suites no longer switch a process-wide language under each other.
exec swift test --package-path "$ROOT/app" -Xswiftc -plugin-path -Xswiftc "$PLUGINS" "$@"
