import Foundation

/// A built-in plugin as the Plugins page shows it (`GET /state.builtinPlugins`, events `plugins.held` and `settings.changed`):
/// every built-in the daemon found, running or not, with its on/off switch. The hub doesn't know built-ins by name — the list,
/// titles and requirements all come from the plugins' own metadata.
public struct BuiltinPluginInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var desc: String?
    public var version: String?
    public var icon: PluginIcon?
    /// The person's switch (`settings.json → builtinOff`).
    public var enabled: Bool
    public var running: Bool
    /// Why it isn't running: "off" (turned off) or "requires" (a declared requirement is missing); nil — runs.
    public var held: String?
    /// Declared requirements (`<agenthub.requires>`) with the plugin's own name and note in the hub language.
    public var requires: [PluginRequirement]

    public init(id: String, title: String, desc: String? = nil, version: String? = nil, icon: PluginIcon? = nil,
                enabled: Bool = true, running: Bool = true, held: String? = nil, requires: [PluginRequirement] = []) {
        self.id = id; self.title = title; self.desc = desc; self.version = version; self.icon = icon
        self.enabled = enabled; self.running = running; self.held = held; self.requires = requires
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? id
        desc = try? c.decodeIfPresent(String.self, forKey: .desc)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        icon = try? c.decodeIfPresent(PluginIcon.self, forKey: .icon)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? true
        running = (try? c.decode(Bool.self, forKey: .running)) ?? false
        held = try? c.decodeIfPresent(String.self, forKey: .held)
        requires = c.lossyList(PluginRequirement.self, forKey: .requires) ?? []
    }

    enum CodingKeys: String, CodingKey { case id, title, desc, version, icon, enabled, running, held, requires }

    public var missingRequirements: [PluginRequirement] { requires.filter { !$0.present } }

    /// The list from an event or a reply field; nil — the field is absent or not a list.
    public static func list(from v: JSONValue?) -> [BuiltinPluginInfo]? {
        guard case .array? = v, let raw = try? JSONEncoder().encode(v) else { return nil }
        let wrapped = Data("{\"l\":".utf8) + raw + Data("}".utf8)
        struct W: Decodable {
            var l: [BuiltinPluginInfo]
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: K.self)
                l = c.lossyList(BuiltinPluginInfo.self, forKey: .l) ?? []
            }
            enum K: String, CodingKey { case l }
        }
        return (try? JSONDecoder().decode(W.self, from: wrapped))?.l
    }
}

/// A plugin of any source the daemon found but doesn't run (`GET /state.heldPlugins`, event `plugins.held`): a built-in turned
/// off, or a plugin whose declared requirement is missing. It has no section; the Plugins page says why.
public struct HeldPluginInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    /// builtin | installed | local
    public var source: String
    /// "off" | "requires"
    public var reason: String
    public var requires: [PluginRequirement]

    public init(id: String, source: String, reason: String, requires: [PluginRequirement] = []) {
        self.id = id; self.source = source; self.reason = reason; self.requires = requires
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = (try? c.decode(String.self, forKey: .source)) ?? "local"
        reason = (try? c.decode(String.self, forKey: .reason)) ?? "requires"
        requires = c.lossyList(PluginRequirement.self, forKey: .requires) ?? []
    }

    enum CodingKeys: String, CodingKey { case id, source, reason, requires }

    public var missingRequirements: [PluginRequirement] { requires.filter { !$0.present } }

    public static func list(from v: JSONValue?) -> [HeldPluginInfo]? {
        guard case .array? = v, let raw = try? JSONEncoder().encode(v) else { return nil }
        let wrapped = Data("{\"l\":".utf8) + raw + Data("}".utf8)
        struct W: Decodable {
            var l: [HeldPluginInfo]
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: K.self)
                l = c.lossyList(HeldPluginInfo.self, forKey: .l) ?? []
            }
            enum K: String, CodingKey { case l }
        }
        return (try? JSONDecoder().decode(W.self, from: wrapped))?.l
    }
}

/// Texts of the Plugins page about held plugins — built only from what the plugin declared (the requirement's own name and note).
public enum HeldText {
    /// "Requires Codex — not found: the program this plugin reads" / nil when nothing is missing.
    public static func requirementLine(_ missing: [PluginRequirement]) -> String? {
        guard !missing.isEmpty else { return nil }
        return missing.map { r in
            let head = tr("Нужен \(r.name) — не найден", "Requires \(r.name) — not found")
            if let note = r.note, !note.isEmpty { return "\(head): \(note)" }
            return head
        }.joined(separator: "\n")
    }

    /// The status under a built-in's switch.
    public static func builtinStatus(_ b: BuiltinPluginInfo) -> String? {
        if !b.enabled { return tr("Выключен: не запускается и не показывается", "Off: not run and not shown") }
        if b.held == "requires" || !b.missingRequirements.isEmpty {
            return (requirementLine(b.missingRequirements) ?? "") + tr(". Появится сам, когда программа найдётся.", ". It shows up by itself once the program is found.")
        }
        return nil
    }
}

extension HubState {
    /// Applies `plugins.held` / `settings.changed` fields to the state: the built-in list and the held list. → whether something changed
    @discardableResult
    public mutating func applyHeld(_ data: JSONValue) -> Bool {
        var changed = false
        if let list = BuiltinPluginInfo.list(from: data["builtinPlugins"]) { builtinPlugins = list; changed = true }
        if let list = HeldPluginInfo.list(from: data["heldPlugins"]) { heldPlugins = list; changed = true }
        return changed
    }
}
