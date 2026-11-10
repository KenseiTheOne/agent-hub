#!/bin/bash
# OPTIONAL (decision 2026-11-05): by default scripts/bundle.sh signs ad hoc and pins the build's cdhash
# (agenthub pin-app) — no certificate is needed for that. Against an agent with the same UID a certificate is no stronger than cdhash:
# the requirement lives in the daemon's config.json, which such an agent would rewrite. The certificate is for those who don't want
# to re-pin after every build (bundle.sh --cert).
#
# ONE-OFF AND ONLY ON THE USER'S COMMAND: creates a SEPARATE keychain agenthub-signing.keychain-db
# with its own password and a self-signed "AgentHub Local Signing" certificate (Code Signing) in it; prints the SHA-1
# for the daemon config. No Apple Developer ID needed. The certificate is per machine; the key isn't transferable.
#
#   scripts/make-signing-cert.sh [--yes] [--days N] [--keychain <path>]
#
#   --yes        don't ask for confirmation (a human still types the keychain password)
#   --days N     validity period (default 3650)
#   --keychain   keychain (default ~/Library/Keychains/agenthub-signing.keychain-db)
#
# Why not login and not `-T /usr/bin/codesign` with "Always Allow": then any process of the same user
# (an agent in auto mode) would silently sign its own binary with this key via /usr/bin/codesign, and the daemon would take
# it for AgentHub.app. Here the key lives in its own keychain:
#   - only a human knows the keychain password (typed in the terminal; the script neither sees nor stores it);
#   - the keychain locks itself after 60 s and on sleep (set-keychain-settings -l -u -t 60);
#   - the key has no "trusted applications" list (-T): even in an unlocked keychain codesign asks for permission
#     in a dialog — answer "Allow", NOT "Always Allow";
#   - the keychain isn't added to the search list: bundle.sh passes it to codesign explicitly (--keychain), unlocks it
#     before signing (password — a human) and locks it right after.
#
# What it does: security create-keychain (asks for the password itself) → set-keychain-settings → openssl (the system
# LibreSSL /usr/bin/openssl) → RSA 2048 key + certificate → .p12 in a 0700 temporary directory → security import
# without -T → security lock-keychain → temporary files are wiped.
# Running it again with the certificate already present changes nothing and prints its fingerprint.
#
# After it:
#   node daemon/bin/agenthub install --app-cert-sha1 <SHA1> --apply --no-launchd   # requirement in config.json
#   scripts/bundle.sh --cert                                   # build; asks for the keychain password before signing
set -euo pipefail

NAME="AgentHub Local Signing"
DAYS=3650
KEYCHAIN="$HOME/Library/Keychains/agenthub-signing.keychain-db"
YES=0
OPENSSL=/usr/bin/openssl

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --days) DAYS="$2"; shift ;;
    --keychain) KEYCHAIN="$2"; shift ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "make-signing-cert.sh: unknown argument \"$1\" (see --help)" >&2; exit 2 ;;
  esac
  shift
done

case "$DAYS" in ''|*[!0-9]*) echo "--days: a number is required" >&2; exit 2 ;; esac
case "$KEYCHAIN" in */login.keychain-db|*/login.keychain)
  echo "make-signing-cert.sh: the signing key does not go into the login keychain — a separate lockable keychain is required (see --help)" >&2
  exit 2 ;;
esac
if [ ! -t 0 ]; then
  echo "make-signing-cert.sh: a terminal is required — a human types the keychain password" >&2
  exit 2
fi

existing_sha1() {
  [ -f "$KEYCHAIN" ] || return 0
  /usr/bin/security find-certificate -c "$NAME" -Z "$KEYCHAIN" 2>/dev/null | awk '/^SHA-1 hash:/ {print $3; exit}'
}

if SHA1="$(existing_sha1)" && [ -n "$SHA1" ]; then
  echo "Certificate \"${NAME}\" already exists in $KEYCHAIN — changing nothing."
  echo "SHA-1: $SHA1"
  echo "Next: node daemon/bin/agenthub install --app-cert-sha1 $SHA1 --apply --no-launchd; scripts/bundle.sh --cert"
  exit 0
fi

if [ "$YES" != 1 ]; then
  echo "A self-signed code signing certificate \"${NAME}\" will be created (for $DAYS days)"
  echo "and imported with its private key into the separate keychain $KEYCHAIN"
  echo "(its own password, auto-lock after 60 s, no trusted applications)."
  printf 'Continue? [y/N] '
  read -r ans
  case "$ans" in y|Y|yes|да|Да) ;; *) echo "Cancelled."; exit 1 ;; esac
fi

if [ ! -f "$KEYCHAIN" ]; then
  echo "Password for the new keychain (bundle.sh will ask for it before signing; not your login password):"
  /usr/bin/security create-keychain "$KEYCHAIN"
fi
# lock on sleep and after 60 s of inactivity
/usr/bin/security set-keychain-settings -l -u -t 60 "$KEYCHAIN"
echo "Unlock the keychain for the import:"
/usr/bin/security unlock-keychain "$KEYCHAIN"

TMP="$(mktemp -d)"
chmod 700 "$TMP"
cleanup() {
  /usr/bin/security lock-keychain "$KEYCHAIN" 2>/dev/null || true
  # key — wipe it before deleting
  [ -f "$TMP/key.pem" ] && rm -P "$TMP/key.pem" 2>/dev/null || true
  [ -f "$TMP/identity.p12" ] && rm -P "$TMP/identity.p12" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
umask 077

cat > "$TMP/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = $NAME

[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -config "$TMP/openssl.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null

# The .p12 password is random and single-use: the file lives for seconds in a 0700 directory and is wiped.
P12PASS="$("$OPENSSL" rand -hex 24)"
export P12PASS
"$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
  -out "$TMP/identity.p12" -passout env:P12PASS

# Without -T: the key has no applications that can use it without asking.
/usr/bin/security import "$TMP/identity.p12" -k "$KEYCHAIN" -f pkcs12 -P "$P12PASS"
unset P12PASS

SHA1="$("$OPENSSL" x509 -in "$TMP/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"

if ! /usr/bin/security find-identity -p codesigning "$KEYCHAIN" | grep -qF "\"$NAME\""; then
  echo "The import succeeded, but the signing identity \"${NAME}\" is not visible in security find-identity — check the keychain." >&2
  exit 1
fi

echo
/usr/bin/security lock-keychain "$KEYCHAIN"
echo "Done: \"${NAME}\" in $KEYCHAIN (keychain locked)"
echo "SHA-1: $SHA1"
echo
echo "Next:"
echo "  node daemon/bin/agenthub install --app-cert-sha1 $SHA1 --apply --no-launchd"
echo "  scripts/bundle.sh --cert"
