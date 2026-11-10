// Signatures in the minisign format (Ed25519) on node:crypto, without external programs.
//
// The module is self-contained (node:* only): the agent-hub-plugins registry copies it too (scripts/vendor/).
//
// Public key (same as minisign):
//   untrusted comment: minisign public key <KEYID>
//   base64( "Ed" || keyId[8] || pk[32] )
// Signature (.minisig):
//   untrusted comment: <text>
//   base64( "ED" || keyId[8] || sig[64] )         ← sig = Ed25519(BLAKE2b-512(file)); "Ed" — no prehash
//   trusted comment: <text>
//   base64( globalSig[64] )                        ← Ed25519(sig || trusted comment)
// The secret key is NOT in the minisign format (that one uses scrypt encryption) but JSON {"keyId":"<hex>","pkcs8":"<base64>"}:
// it lives only in the CI environment secret and in temporary test directories.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";

const PK_ALG = Buffer.from("Ed");
const SIG_PREHASHED = "ED";
const SIG_LEGACY = "Ed";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function keyIdHex(id) {
  // minisign prints keyId as an uppercase little-endian number
  return Buffer.from(id).reverse().toString("hex").toUpperCase();
}

// Key errors: an English message plus msgKey — the hub CLI shows it in the hub language (lib/i18n.mjs errText); the
// module stays self-contained.
function keyError(msgKey, text) {
  return Object.assign(new Error(text), { msgKey: `minisign.${msgKey}`, params: {} });
}

function lines(text) {
  return String(text).replace(/\r\n/g, "\n").split("\n");
}

// Public key parsing: a two-line file or a single base64 line. → { keyId: Buffer(8), key: KeyObject }
export function parsePublicKey(text) {
  if (typeof text !== "string" || !text.trim()) throw keyError("empty", "empty public key");
  const ls = lines(text).map((l) => l.trim()).filter(Boolean);
  const b64 = ls.find((l) => !l.startsWith("untrusted comment:"));
  const raw = Buffer.from(b64 || "", "base64");
  if (raw.length !== 42 || !raw.subarray(0, 2).equals(PK_ALG)) throw keyError("notKey", "not a minisign Ed25519 public key");
  const keyId = raw.subarray(2, 10);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(raw.subarray(10)) }, format: "jwk" });
  return { keyId, key, keyIdHex: keyIdHex(keyId) };
}

function parseSecretKey(secret) {
  const obj = typeof secret === "string" ? JSON.parse(secret) : secret;
  if (!obj || typeof obj.keyId !== "string" || !/^[0-9a-f]{16}$/.test(obj.keyId) || typeof obj.pkcs8 !== "string") {
    throw new Error("secret key: expected JSON {keyId, pkcs8}");
  }
  const key = createPrivateKey({ key: Buffer.from(obj.pkcs8, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("secret key is not Ed25519");
  return { keyId: Buffer.from(obj.keyId, "hex"), key };
}

// A new key pair. Call only where the key cannot leak: tests in a temporary directory, a one-off generation
// by the user (the registry's scripts/keygen.mjs). → { publicKey: <minisign text>, secretKey: <JSON>, keyId }
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const pk = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const pub = Buffer.concat([PK_ALG, keyId, pk]).toString("base64");
  return {
    keyId: keyIdHex(keyId),
    publicKey: `untrusted comment: minisign public key ${keyIdHex(keyId)}\n${pub}\n`,
    secretKey: JSON.stringify({ keyId: keyId.toString("hex"), pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") }),
  };
}

function blake(buf) {
  return createHash("blake2b512").update(buf).digest();
}

function cleanComment(s, fallback) {
  const v = String(s ?? fallback).replace(/[\r\n]+/g, " ");
  return v.length > 1024 ? v.slice(0, 1024) : v;
}

// → .minisig text (BLAKE2b-512 prehash, like minisign -S by default)
export function sign(message, secret, { trustedComment, untrustedComment } = {}) {
  const { keyId, key } = parseSecretKey(secret);
  const sig = edSign(null, blake(Buffer.from(message)), key);
  const tc = cleanComment(trustedComment, `timestamp:${Math.floor(Date.now() / 1000)}`);
  const global = edSign(null, Buffer.concat([sig, Buffer.from(tc, "utf8")]), key);
  return [
    `untrusted comment: ${cleanComment(untrustedComment, "signature from agent-hub-plugins")}`,
    Buffer.concat([Buffer.from(SIG_PREHASHED), keyId, sig]).toString("base64"),
    `trusted comment: ${tc}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

// → { ok: true, keyId, trustedComment } | { ok: false, reason }
// reason: sig-format | key-format | key-mismatch | signature | global-signature
export function verify(message, sigText, publicKeyText) {
  let pub;
  try {
    pub = parsePublicKey(publicKeyText);
  } catch {
    return { ok: false, reason: "key-format" };
  }
  const ls = lines(sigText);
  if (ls.length < 4 || !ls[0].startsWith("untrusted comment:") || !ls[2].startsWith("trusted comment: ")) return { ok: false, reason: "sig-format" };
  const raw = Buffer.from(ls[1].trim(), "base64");
  const global = Buffer.from(ls[3].trim(), "base64");
  if (raw.length !== 74 || global.length !== 64) return { ok: false, reason: "sig-format" };
  const alg = raw.subarray(0, 2).toString("latin1");
  if (alg !== SIG_PREHASHED && alg !== SIG_LEGACY) return { ok: false, reason: "sig-format" };
  const keyId = raw.subarray(2, 10);
  const sig = raw.subarray(10);
  if (!keyId.equals(pub.keyId)) return { ok: false, reason: "key-mismatch" };
  const msg = alg === SIG_PREHASHED ? blake(Buffer.from(message)) : Buffer.from(message);
  let good = false;
  try {
    good = edVerify(null, msg, pub.key, sig);
  } catch {}
  if (!good) return { ok: false, reason: "signature" };
  const tc = ls[2].slice("trusted comment: ".length);
  let gGood = false;
  try {
    gGood = edVerify(null, Buffer.concat([sig, Buffer.from(tc, "utf8")]), pub.key, global);
  } catch {}
  if (!gGood) return { ok: false, reason: "global-signature" };
  return { ok: true, keyId: pub.keyIdHex, trustedComment: tc };
}
