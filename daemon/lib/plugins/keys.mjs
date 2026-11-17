// PluginManager part: accepted registry keys — the key a registry was first used with is remembered
// (Registry/registry-keys.json) and stays the one its catalog is verified with until a human accepts another one
// (acceptRegistryKey: the 428 window from the pinned app, or the CLI).
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileSig } from "../config.mjs";
import { parsePublicKey } from "../registry/minisign.mjs";
import { atomicWrite, CONSENT_TTL_MS, isStr, readJsonOr, RegistryError, sha256 } from "./common.mjs";
import { REGISTRY_NAME_RE, registryLabel } from "./sources.mjs";

// The accepted key of registry name in a hub directory, read without a manager (the CLI's note after it wrote another key
// into config.json). null — none accepted yet.
export function acceptedRegistryKey(home, name = "default") {
  return registryKeyIdentity(readJsonOr(join(home, "Registry", "registry-keys.json"), null)?.registries?.[name]?.key);
}

// The identity of a registry public key, whatever the text around it (the comment line, line breaks): the canonical base64 line,
// the minisign key id (a label the key's owner chose — anyone can copy it) and the fingerprint (sha256 of the id and the key
// bytes, the first 32 hex digits). null — not a minisign key.
export function registryKeyIdentity(text) {
  try {
    const p = parsePublicKey(text);
    const raw = Buffer.concat([Buffer.from("Ed"), p.keyId, Buffer.from(p.key.export({ format: "jwk" }).x, "base64url")]);
    return { key: raw.toString("base64"), keyId: p.keyIdHex, fingerprint: sha256(raw).slice(0, 32) };
  } catch {
    return null;
  }
}

export class ManagerKeys {
  // ---------- accepted registry keys ----------
  // The key a registry's catalog is verified with is the root of trust for everything installed from it, and it is configured
  // in config.json — a file any process of this user can write (and `agenthub install --registry-pubkey` does). So the hub
  // remembers the key that was in force when the registry was first used (Registry/registry-keys.json, 0600: name → canonical
  // key, fingerprint, when and how it was accepted) and from then on verifies with THAT key. A different key in config.json
  // does not become the trust root by itself:
  //   - the catalog on disk and anything the registry still signs with the accepted key keep working (tiers, blocklist,
  //     installs) — nothing is demoted because a file was edited;
  //   - a catalog signed with the new key is refused: registry:key-changed;
  //   - the change goes to the journal once (registry-key-changed, also in the audit journal) and to /state.registryKeys;
  //   - the new key takes over only after a human accepts it: POST /registry/key/accept from the pinned app (a 428 window
  //     with both fingerprints, a single-use token) or `agenthub plugins trust-key <registry>` in a terminal (acceptRegistryKey).
  // Putting the accepted key back into config.json clears the state (registry-key-restored).
  // The limit is the one of the app pin (lib/app-pin.mjs): a process with the same UID can rewrite this file as well as
  // config.json and the daemon's code. This is a tripwire with a loud trace (registry-key-pinned on every first use,
  // registry-key-changed), not a wall.
  keyPinsPath() {
    return join(this.dirs.registry, "registry-keys.json");
  }
  readKeyPins() {
    const path = this.keyPinsPath();
    const sig = fileSig(path);
    if (this.keyPinsDisk?.sig === sig) return this.keyPinsDisk.pins;
    const pins = {};
    const j = readJsonOr(path, null);
    if (j?.version === 1 && j.registries && typeof j.registries === "object") {
      for (const [name, p] of Object.entries(j.registries)) {
        const id = REGISTRY_NAME_RE.test(name) && p && typeof p === "object" ? registryKeyIdentity(p.key) : null;
        if (!id) continue;
        const ch = p.changed && typeof p.changed === "object" ? p.changed : null;
        pins[name] = {
          ...id,
          acceptedAt: isStr(p.acceptedAt, 64) ? p.acceptedAt : null,
          by: isStr(p.by, 32) ? p.by : null,
          ...(isStr(p.previous, 64) ? { previous: p.previous } : {}),
          changed: ch && isStr(ch.seenAt, 64) ? { fingerprint: isStr(ch.fingerprint, 64) ? ch.fingerprint : null, keyId: isStr(ch.keyId, 32) ? ch.keyId : null, seenAt: ch.seenAt } : null,
        };
      }
    }
    this.keyPinsDisk = { sig, pins };
    return pins;
  }
  saveKeyPins(pins) {
    atomicWrite(this.keyPinsPath(), JSON.stringify({ version: 1, registries: pins }, null, 2) + "\n");
    this.keyPinsDisk = null;
  }
  // The configured sources with the accepted keys applied. A source whose key in config.json differs from the accepted one
  // keeps the accepted key in publicKey and gets configKey (what config.json says) and keyChanged: { was, now, since } —
  // was/now are { keyId, fingerprint }, now is null when config.json holds something that is not a key.
  withKeyPins(list) {
    let pins = this.readKeyPins();
    let dirty = false;
    const edit = () => {
      if (!dirty) pins = structuredClone(pins);
      dirty = true;
      return pins;
    };
    const short = (id) => ({ keyId: id.keyId, fingerprint: id.fingerprint });
    const out = list.map((src) => {
      if (!src.publicKey) return src;
      const now = registryKeyIdentity(src.publicKey);
      const pin = pins[src.name];
      if (!pin) {
        // not a key at all: verification fails with key-format, there is nothing to remember
        if (!now) return src;
        edit()[src.name] = { ...now, acceptedAt: new Date().toISOString(), by: "first-use", changed: null };
        this.log({ type: "registry-key-pinned", registry: src.name, keyId: now.keyId, fingerprint: now.fingerprint, by: "first-use" });
        return { ...src, keyInfo: short(now) };
      }
      if (now && now.fingerprint === pin.fingerprint) {
        if (pin.changed) {
          edit()[src.name] = { ...pin, changed: null };
          this.log({ type: "registry-key-restored", registry: src.name, fingerprint: pin.fingerprint });
        }
        return { ...src, keyInfo: short(pin) };
      }
      const fp = now?.fingerprint ?? null;
      let since = pin.changed?.seenAt || null;
      if (!pin.changed || pin.changed.fingerprint !== fp) {
        since = new Date().toISOString();
        edit()[src.name] = { ...pin, changed: { fingerprint: fp, keyId: now?.keyId ?? null, seenAt: since } };
        this.log({ type: "registry-key-changed", registry: src.name, was: pin.fingerprint, now: fp, wasKeyId: pin.keyId, nowKeyId: now?.keyId ?? null });
      }
      return { ...src, publicKey: pin.key, configKey: src.publicKey, keyInfo: short(pin), keyChanged: { was: short(pin), now: now ? short(now) : null, since } };
    });
    if (dirty) {
      try {
        this.saveKeyPins(pins);
      } catch (e) {
        this.log({ type: "registry-key-pin-error", detail: String(e?.code || e?.message || e).slice(0, 160) });
      }
    }
    return out;
  }
  // Registries whose key in config.json is not the accepted one (/state.registryKeys): [{ registry, registryLabel, trust, was,
  // now, since }]. registryLabel — as in the 428 window of acceptRegistryKey: null with only the default registry configured.
  registryKeyAlerts() {
    const list = this.sources();
    return list
      .filter((r) => r.keyChanged)
      .map((r) => ({ registry: r.name, registryLabel: registryLabel(r.name, list), trust: r.trust, was: { ...r.keyChanged.was }, now: r.keyChanged.now ? { ...r.keyChanged.now } : null, since: r.keyChanged.since }));
  }
  // The human accepts the key now in config.json as registry name's trust root. From the app: without a token — 428 with both
  // fingerprints and a single-use token (120 s, bound to the registry, the new fingerprint and the app's pid), with the token —
  // the key is accepted. confirmed: true — the terminal command, which has asked the human itself (lib/registry/terminal.mjs).
  // After that the catalog on disk (signed with the previous key) no longer verifies: the caller fetches a new one.
  // preview: true — the window only (a diagnostic snapshot of the shell, peer.diagnostic), as in installNow and approveOwn: the
  // same 428 body, but its token is not recorded (nothing can be accepted with it), the human's pending window for the
  // registry is not reset, and a request with a token is refused (403 peer:diagnostic). Never accepts a key.
  acceptRegistryKey(name, { consentToken = null, peer = null, via = "app", confirmed = false, preview = false } = {}) {
    if (preview && (consentToken || confirmed)) throw new RegistryError(403, "peer:diagnostic");
    if (this.estop()) throw new RegistryError(423, "estop");
    const src = typeof name === "string" ? this.source(name) : null;
    if (!src) throw new RegistryError(404, "registry:unknown-registry");
    const ch = src.keyChanged;
    if (!ch) throw new RegistryError(409, "registry:key-unchanged", { registry: name });
    const now = registryKeyIdentity(src.configKey);
    if (!now) throw new RegistryError(422, "registry:key-format", { registry: name });
    if (!confirmed) {
      if (!consentToken) {
        const token = randomBytes(18).toString("base64url");
        if (!preview) {
          for (const [t, p] of this.keyPending) if (p.expires < Date.now() || p.registry === name) this.keyPending.delete(t);
          this.keyPending.set(token, { registry: name, fingerprint: now.fingerprint, pid: peer?.pid ?? null, expires: Date.now() + CONSENT_TTL_MS });
        }
        this.log({ type: "registry-key-consent-requested", registry: name, now: now.fingerprint, pid: peer?.pid, ...(preview ? { preview: true } : {}) });
        throw new RegistryError(428, "consent-required", {
          needsConsent: true,
          token,
          expiresInMs: CONSENT_TTL_MS,
          kind: "registry-key",
          registry: name,
          registryLabel: registryLabel(name, this.sources()),
          trust: src.trust,
          was: { ...ch.was },
          now: { keyId: now.keyId, fingerprint: now.fingerprint },
          since: ch.since,
        });
      }
      const p = this.keyPending.get(consentToken);
      this.keyPending.delete(consentToken);
      if (!p || p.registry !== name || p.expires < Date.now() || p.pid !== (peer?.pid ?? null) || p.fingerprint !== now.fingerprint) throw new RegistryError(403, "consent:invalid");
    }
    const pins = structuredClone(this.readKeyPins());
    pins[name] = { ...now, acceptedAt: new Date().toISOString(), by: via, previous: ch.was.fingerprint, changed: null };
    this.saveKeyPins(pins);
    this.log({ type: "registry-key-accepted", registry: name, was: ch.was.fingerprint, now: now.fingerprint, wasKeyId: ch.was.keyId, nowKeyId: now.keyId, via, pid: peer?.pid ?? null });
    this.sourcesMemo = null;
    this.loadCached();
    this.applyBlocklist();
    this.changed();
    this.noteUpdates();
    return { ok: true, registry: name, key: { keyId: now.keyId, fingerprint: now.fingerprint } };
  }
}
