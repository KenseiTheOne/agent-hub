#!/bin/bash
# Shell app tests (Swift Testing). With Command Line Tools, swiftbuild does not always pass the Testing macro
# plugin to the compiler (`TestingMacros ... not found`), so its path is set explicitly.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS="$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
# No parallelism: the app language (L10n.shared.lang) is process-wide and suites switch it; parallel runs were
# flaky (a Russian string came back in English). Sequential takes ~10 s instead of ~7.
exec swift test --package-path "$ROOT/app" -Xswiftc -plugin-path -Xswiftc "$PLUGINS" --no-parallel "$@"
