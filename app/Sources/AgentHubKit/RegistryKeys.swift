import Foundation

// "The registry key changed" (docs/plugins-registry.md, "The registry key is remembered"): the hub verifies a catalog
// with the key it accepted, and a different key in `config.json` waits for a human. The shell shows the fact
// (`/state.registryKeys`, event `plugins.registry-keys`) and passes the human's answer — the daemon decides everything.

/// One key as the daemon names it: the minisign key id (a label its owner chose) and the fingerprint (32 hex of sha256
/// over the key) — the fingerprint is what a human compares.
public struct RegistryKeyRef: Codable, Sendable, Hashable {
    public var keyId: String?
    public var fingerprint: String

    public init(keyId: String? = nil, fingerprint: String) { self.keyId = keyId; self.fingerprint = fingerprint }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fingerprint = try c.decode(String.self, forKey: .fingerprint)
        keyId = ((try? c.decodeIfPresent(String.self, forKey: .keyId)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    }

    enum CodingKeys: String, CodingKey { case keyId, fingerprint }
}

/// A registry whose key in `config.json` is not the accepted one (`/state.registryKeys[]`). `was` — the accepted key,
/// `now` — the one in the file (nil — the file's value is not a key at all), `since` — when the hub first saw it.
public struct RegistryKeyChange: Codable, Sendable, Hashable, Identifiable {
    public var registry: String
    /// `official` | `community` — the most a plugin of this registry can be.
    public var trust: String?
    public var was: RegistryKeyRef
    public var now: RegistryKeyRef?
    public var since: String?
    /// The registry's name for a human, when several are configured (the consent answer carries it; the state does not).
    public var registryLabel: String?
    public var id: String { registry }

    public init(registry: String, trust: String? = nil, was: RegistryKeyRef, now: RegistryKeyRef?, since: String? = nil, registryLabel: String? = nil) {
        self.registry = registry; self.trust = trust; self.was = was; self.now = now; self.since = since; self.registryLabel = registryLabel
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        registry = try c.decode(String.self, forKey: .registry)
        trust = try? c.decodeIfPresent(String.self, forKey: .trust)
        was = try c.decode(RegistryKeyRef.self, forKey: .was)
        now = try? c.decodeIfPresent(RegistryKeyRef.self, forKey: .now)
        since = try? c.decodeIfPresent(String.self, forKey: .since)
        registryLabel = RegistrySource.label(try? c.decodeIfPresent(String.self, forKey: .registryLabel))
    }

    enum CodingKeys: String, CodingKey { case registry, trust, was, now, since, registryLabel }

    /// What a human sees as the registry's name; nil — the only (default) registry, which needs no name.
    public var shownName: String? { registryLabel ?? (registry == "default" ? nil : registry) }

    /// The list of a `plugins.registry-keys` event or of `/state.registryKeys`; an entry that does not decode is skipped.
    public static func list(from value: JSONValue?) -> [RegistryKeyChange]? {
        guard case .array(let items)? = value else { return nil }
        return items.compactMap { item in
            guard let raw = try? JSONEncoder().encode(item) else { return nil }
            return try? JSONDecoder().decode(RegistryKeyChange.self, from: raw)
        }
    }
}

/// The key window (`428 consent-required`, `kind: "registry-key"`, from `POST /registry/key/accept`): both keys and a
/// single-use token that lives `expiresInMs` and is bound to the registry, the new fingerprint and the app's pid.
public struct RegistryKeyConsent: Decodable, Sendable, Hashable {
    public var token: String
    public var expiresInMs: Int?
    public var change: RegistryKeyChange

    public init(token: String, expiresInMs: Int? = nil, change: RegistryKeyChange) {
        self.token = token; self.expiresInMs = expiresInMs; self.change = change
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        expiresInMs = try? c.decodeIfPresent(Int.self, forKey: .expiresInMs)
        change = try RegistryKeyChange(from: decoder)
        // the window compares two keys: without the new one there is nothing to accept
        guard change.now != nil else { throw DecodingError.dataCorruptedError(forKey: .token, in: c, debugDescription: "no new key") }
    }

    enum CodingKeys: String, CodingKey { case token, expiresInMs }
}

/// The result of `POST /registry/key/accept`.
public enum RegistryKeyOutcome: Sendable {
    /// The key is accepted. `fetched: false` — the catalog signed with it could not be fetched (`fetchError` — the code):
    /// the catalog is empty until the next successful fetch.
    case accepted(fetched: Bool, fetchError: String?)
    case needsConsent(RegistryKeyConsent)
    case denied(status: Int, code: String)
}

/// Texts of the key banner and the key window.
public enum RegistryKeyText {
    public static func bannerTitle(_ k: RegistryKeyChange) -> String {
        if let n = k.shownName { return tr("Ключ реестра «\(n)» сменился", "The key of the \"\(n)\" registry has changed") }
        return tr("Ключ реестра плагинов сменился", "The plugin registry key has changed")
    }

    /// What it means now and what the human is to do. Without a new key (`now == nil`) there is nothing to accept.
    public static func bannerDetail(_ k: RegistryKeyChange, canAccept: Bool) -> String {
        guard k.now != nil else {
            return tr("В config.json вместо ключа реестра записано что-то другое. Хаб проверяет каталог прежним ключом. Верните прежний ключ в config.json или запишите туда настоящий.",
                      "config.json now holds something that is not a registry key. The hub keeps checking the catalog with the previous key. Put the previous key back into config.json or write a real one there.")
        }
        let fact = tr("В config.json записан другой ключ, которым проверяется подпись каталога. Пока вы его не примете, хаб проверяет каталог прежним ключом и не ставит ничего, что подписано новым.",
                      "config.json now holds a different key for checking the catalog's signature. Until you accept it, the hub keeps checking the catalog with the previous key and installs nothing signed with the new one.")
        return canAccept ? fact : fact + " " + terminalHint(k)
    }

    /// For a copy of the app that cannot accept (not the pinned build): the terminal way.
    public static func terminalHint(_ k: RegistryKeyChange) -> String {
        let cmd = terminalCommand(k)
        return tr("Принять можно в закреплённой сборке приложения или командой \(cmd) в своём терминале.",
                  "It can be accepted in the pinned app build or with \(cmd) in your own terminal.")
    }

    public static func terminalCommand(_ k: RegistryKeyChange) -> String {
        k.registry == "default" ? "agenthub plugins trust-key" : "agenthub plugins trust-key \(k.registry)"
    }

    public static var review: String { tr("Сравнить ключи…", "Compare the keys…") }

    public static func windowTitle(_ k: RegistryKeyChange) -> String {
        if let n = k.shownName { return tr("Принять новый ключ реестра «\(n)»?", "Accept the new key of the \"\(n)\" registry?") }
        return tr("Принять новый ключ реестра плагинов?", "Accept the new plugin registry key?")
    }

    /// The line under the title: which registry it is and when the hub first saw the new key.
    public static func windowSubtitle(_ k: RegistryKeyChange) -> String {
        let tier = k.trust == "official" ? tr("официальный реестр", "official registry") : tr("реестр сообщества", "community registry")
        guard let s = k.since, let d = PluginUpdatesStatus.parseDate(s) else { return tier }
        return tr("\(tier) · новый ключ замечен \(Fmt.dateTime(d))", "\(tier) · new key first seen \(Fmt.dateTime(d))")
    }

    public static var what: String {
        tr("В config.json записан другой ключ, которым проверяется подпись каталога плагинов. Хаб сам его не менял: ключ мог сменить владелец реестра — или программа на этом компьютере.",
           "config.json now holds a different key for checking the plugin catalog's signature. The hub did not change it: the registry's owner may have replaced the key — or a program on this computer did.")
    }

    public static var acceptedLabel: String { tr("Принятый ключ", "Accepted key") }
    public static var newLabel: String { tr("Новый ключ", "New key") }
    public static func keyId(_ id: String) -> String { tr("идентификатор ключа \(id)", "key id \(id)") }

    /// What accepting means, in the window's warning box.
    public static var meaning: String {
        tr("Если принять, хаб будет доверять каталогу и обновлениям плагинов, подписанным новым ключом, а подписанное прежним перестанет проходить проверку. Принимайте, только если ключ меняли вы сами или о смене объявил владелец реестра и отпечаток нового ключа совпадает с опубликованным.",
           "If you accept, the hub will trust the catalog and plugin updates signed with the new key, and whatever is signed with the previous one will stop passing the check. Accept only if you changed the key yourself, or the registry's owner announced the change and the new key's fingerprint matches the published one.")
    }

    /// What declining means (the default answer).
    public static var keep: String {
        tr("Если не принимать, ничего не изменится: хаб продолжит проверять каталог прежним ключом. Чтобы убрать предупреждение, верните прежний ключ в config.json.",
           "If you don't accept, nothing changes: the hub keeps checking the catalog with the previous key. To clear the warning, put the previous key back into config.json.")
    }

    public static var accept: String { tr("Принять новый ключ", "Accept the new key") }
    public static var decline: String { tr("Не принимать", "Don't accept") }

    public static var notAcceptedTitle: String { tr("Ключ реестра не принят", "The registry key was not accepted") }
    public static var changedAgain: String {
        tr("Ключ в config.json сменился ещё раз, пока было открыто окно, — сравните ключи заново.", "The key in config.json changed again while the window was open — compare the keys again.")
    }
    public static var acceptedNoCatalogTitle: String { tr("Ключ принят, каталог не загружен", "The key is accepted, the catalog is not loaded") }
    public static func acceptedNoCatalog(_ why: String) -> String {
        tr("Новый ключ принят, но каталог, подписанный им, загрузить не удалось: \(why) Каталог пуст до следующей удачной загрузки — откройте «Плагины» и загрузите его ещё раз.",
           "The new key is accepted, but the catalog signed with it could not be loaded: \(why) The catalog is empty until the next successful load — open Plugins and load it again.")
    }
}
