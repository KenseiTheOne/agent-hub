#!/bin/bash
# Builds AgentHub.app: swift build -c release → bundle (Info.plist, icon) → signature [→ pinning the build].
# A developer tool: by default it does not touch the LIVE install (~/Library/Application Support/AgentHub) —
# the live hub runs from a separate install Versions/<version> and is updated with the Update button
# (docs/hub-updates.md). The app version comes from the VERSION file.
#
#   scripts/bundle.sh                 sign ad hoc, do NOT pin (the default since 2026-11-06): the daemon does not
#                                     accept this build as `app` until it is pinned
#   --home <dir>                      pin this build in a test state directory (agenthub pin-app):
#                                     requirements.app = identifier "com.kensei.agenthub" and cdhash H"<cdhash>"
#   --pin-live                        pin in the LIVE hub (the default before 2026-11-06): the daemon will
#                                     launch app/build/AgentHub.app instead of Versions/current — only deliberately
#   --no-pin                          no pinning (the default; --dev-adhoc is a synonym)
#   --cert                            optional mode: sign with the "AgentHub Local Signing" certificate
#                                     (scripts/make-signing-cert.sh; requirement: agenthub install --app-cert-sha1);
#                                     no need to re-pin after every build
#   --out <dir>                       where to put AgentHub.app (default app/build)
#   --skip-build                      don't rebuild, take the existing release binary
#
# Why ad hoc + cdhash by default (decision 2026-11-05): the signature requirement lives in the daemon's config.json
# (0600, same UID), and the daemon code lives in ~/Projects; an agent of the same user can rewrite both. A separate
# keychain with a password protected only the key, not the config, so against such an agent a certificate and cdhash
# are equivalent, and against curl and other users' processes both work. Every pin is visible: the journal entry
# app-requirement-changed, the push "Agent Hub was re-pinned", a note in the panel "App rebuilt and pinned · <time>".
# The pinned cdhash is the one the kernel (csops) reports for the running process: the build is for the native
# architecture only, and `codesign -dvvv` shows exactly its CDHash (verified 2026-11-05).
#
# --cert mode: the certificate is created once by scripts/make-signing-cert.sh (on the user's command) in a SEPARATE
# keychain agenthub-signing.keychain-db with its own password and auto-lock. Before signing the script unlocks that
# keychain (a human types the password in the terminal), signs with `codesign --keychain <keychain>` and locks it right away.
# The codesign key access dialog: "Allow", not "Always Allow". No certificate — the script fails with
# a hint and does not silently fall back to ad hoc.
#   AGENTHUB_SIGNING_KEYCHAIN — path to the keychain (default ~/Library/Keychains/agenthub-signing.keychain-db).
set -euo pipefail

IDENTITY="AgentHub Local Signing"
KEYCHAIN="${AGENTHUB_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/agenthub-signing.keychain-db}"
BUNDLE_ID="com.kensei.agenthub"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PKG="$ROOT/app"
OUT="$APP_PKG/build"
MODE="adhoc"
PIN=0
PIN_HOME=""
PIN_LIVE=0
SKIP_BUILD=0
# hub version: single source of truth is the VERSION file (docs/hub-updates.md)
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "bundle.sh: VERSION is not a version: \"$VERSION\"" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-pin|--dev-adhoc) MODE="adhoc"; PIN=0; PIN_LIVE=0; PIN_HOME="" ;;
    --cert) MODE="cert"; PIN=0 ;;
    --home) PIN_HOME="${2:?--home: a directory is required}"; PIN=1; shift ;;
    --pin-live) PIN=1; PIN_LIVE=1 ;;
    --out) OUT="${2:?--out: a directory is required}"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bundle.sh: unknown argument \"$1\" (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$PIN_HOME" in /*|"") ;; *) PIN_HOME="$PWD/$PIN_HOME" ;; esac
if [ "$PIN_LIVE" = 1 ] && [ -n "$PIN_HOME" ]; then
  echo "bundle.sh: --pin-live and --home together — pick one" >&2; exit 2
fi

# Check the keychain before building so a refusal does not cost a minute (the identity in it is checked after unlocking, before signing).
if [ "$MODE" = "cert" ]; then
  if [ ! -f "$KEYCHAIN" ] || [ ! -t 0 ]; then
    cat >&2 <<EOF
bundle.sh --cert: no signing keychain $KEYCHAIN (or no terminal — a human types the keychain password).

  Create it (once, a separate keychain):        scripts/make-signing-cert.sh
  Then put the fingerprint in the daemon config: node daemon/bin/agenthub install --app-cert-sha1 <SHA1>

  Without a certificate (the default): ad hoc and pinning the build — scripts/bundle.sh
EOF
    exit 1
  fi
fi

if [ "$SKIP_BUILD" = 0 ]; then
  echo "==> swift build -c release"
  swift build -c release --package-path "$APP_PKG"
fi
BIN_DIR="$(swift build -c release --package-path "$APP_PKG" --show-bin-path)"
[ -x "$BIN_DIR/AgentHub" ] || { echo "bundle.sh: no $BIN_DIR/AgentHub — build without --skip-build" >&2; exit 1; }

APP="$OUT/AgentHub.app"
echo "==> $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/AgentHub" "$APP/Contents/MacOS/AgentHub"

# App icon: the prebuilt app/Resources/AppIcon.icns (the "Hive" art, make-icon-from-art.swift). If missing, build it
# from the AppIcon-source.png art; the old 2×2 grid (make-icon.swift) only if the art is missing too.
ICON="$APP_PKG/Resources/AppIcon.icns"
if [ ! -f "$ICON" ]; then
  TMP_ICON="$(mktemp -d)"
  if [ -f "$APP_PKG/Resources/AppIcon-source.png" ]; then
    echo "==> icon: app/Tools/make-icon-from-art.swift (AppIcon-source.png)"
    swift "$APP_PKG/Tools/make-icon-from-art.swift" "$APP_PKG/Resources/AppIcon-source.png" "$TMP_ICON" >/dev/null
  else
    echo "==> icon: app/Tools/make-icon.swift (fallback 2×2 grid)"
    swift "$APP_PKG/Tools/make-icon.swift" "$TMP_ICON/AppIcon.iconset" >/dev/null
  fi
  iconutil -c icns "$TMP_ICON/AppIcon.iconset" -o "$ICON"
  rm -rf "$TMP_ICON"
fi
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"

# Menu bar icon: the cop-bot template and the emblem mask (22×22 pt, @1x/@2x/@3x); the app loads them from
# Contents/Resources (MenuBarArt in StatusStyle.swift). The art source (-source.png) is not put in the bundle.
for f in "$APP_PKG"/Resources/MenuBar/MenuBar{Icon,Emblem}{,@2x,@3x}.png; do
  [ -f "$f" ] || { echo "bundle.sh: no $f" >&2; exit 1; }
  cp "$f" "$APP/Contents/Resources/"
done

BUILD_NUMBER="$(date +%Y%m%d%H%M)"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>        <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>              <string>AgentHub</string>
  <key>CFBundleDisplayName</key>       <string>Agent Hub</string>
  <key>CFBundleExecutable</key>        <string>AgentHub</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key>           <string>$BUILD_NUMBER</string>
  <key>CFBundleIconFile</key>          <string>AppIcon</string>
  <key>CFBundleDevelopmentRegion</key> <string>ru</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key>    <string>26.0</string>
  <key>LSUIElement</key>               <true/>
  <key>LSApplicationCategoryType</key> <string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key>   <true/>
  <key>NSHumanReadableCopyright</key>  <string>Agent Hub</string>
</dict>
</plist>
EOF
plutil -lint -s "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

if [ "$MODE" = "adhoc" ]; then
  echo "==> codesign ad hoc (identifier $BUNDLE_ID)"
  /usr/bin/codesign --force --options runtime --timestamp=none -s - -i "$BUNDLE_ID" "$APP"
else
  # Unlock the keychain only for signing and lock it right after (and on any exit).
  trap '/usr/bin/security lock-keychain "$KEYCHAIN" 2>/dev/null || true' EXIT
  echo "==> signing keychain password ($KEYCHAIN):"
  /usr/bin/security unlock-keychain "$KEYCHAIN"
  # no -v: a self-signed certificate is not "trusted", but codesign can still sign with it
  if ! /usr/bin/security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -qF "\"$IDENTITY\""; then
    echo "bundle.sh: no signing identity \"${IDENTITY}\" in $KEYCHAIN — scripts/make-signing-cert.sh" >&2
    exit 1
  fi
  echo "==> codesign \"${IDENTITY}\" (key access dialog: \"Allow\", not \"Always Allow\")"
  /usr/bin/codesign --force --options runtime --timestamp=none --keychain "$KEYCHAIN" -s "$IDENTITY" -i "$BUNDLE_ID" "$APP"
  /usr/bin/security lock-keychain "$KEYCHAIN"
fi

/usr/bin/codesign --verify --strict "$APP"
echo "==> signature:"
/usr/bin/codesign -dvvv "$APP" 2>&1 | grep -E '^(Identifier|Authority|Signature|TeamIdentifier|CDHash)=' | sed 's/^/    /'

if [ "$MODE" = "cert" ]; then
  # the leaf certificate fingerprint, which the daemon's requirements.app expects (certificate leaf = H"<sha1>")
  TMP_CERT="$(mktemp -d)"
  (cd "$TMP_CERT" && /usr/bin/codesign -d --extract-certificates "$APP" 2>/dev/null)
  if [ -f "$TMP_CERT/codesign0" ]; then
    SHA1="$(/usr/bin/openssl x509 -inform DER -in "$TMP_CERT/codesign0" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
    echo "    leaf SHA-1=$SHA1"
    echo "    daemon requirement: identifier \"$BUNDLE_ID\" and certificate leaf = H\"$SHA1\""
    echo "    write it (once): node daemon/bin/agenthub install --app-cert-sha1 $SHA1 --apply --no-launchd"
  fi
  rm -rf "$TMP_CERT"
elif [ "$PIN" = 1 ]; then
  # pinning uses the same CLI a human would: identifier + cdhash of this build in the daemon's config.json
  if [ -n "$PIN_HOME" ]; then
    echo "==> pinning the build: agenthub pin-app (state directory: $PIN_HOME)"
    AGENTHUB_HOME="$PIN_HOME" env -u NODE_OPTIONS node "$ROOT/daemon/bin/agenthub" pin-app "$APP"
  else
    echo "==> pinning the build in the LIVE hub (--pin-live): agenthub pin-app"
    env -u NODE_OPTIONS -u AGENTHUB_HOME node "$ROOT/daemon/bin/agenthub" pin-app "$APP"
  fi
else
  CDHASH="$(/usr/bin/codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p')"
  cat >&2 <<EOF

  The build is NOT pinned (cdhash $CDHASH) — the live hub is untouched. The daemon accepts it as "app" only after
    scripts/bundle.sh --skip-build --home <test dir>             (test hub)
    scripts/bundle.sh --skip-build --pin-live                    (live hub — deliberately; usually use Update)
  Until then approvals, stops, launches and lifting ESTOP from it get 403 peer:app-signature.

EOF
fi
echo "==> done: $APP"
