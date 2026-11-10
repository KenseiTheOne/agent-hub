import Foundation
import Observation

/// Plugin icons by id — from what the plugins themselves declared (`<agenthub.icon>`, contract 2): installed
/// (`/state.plugins[].icon`), the registry catalog (the index entry's `icon`), own plugin requests and consent windows. The tile
/// needs only the id (catalog, permission windows, removal), so the icons are collected in one place. The hub does not know icons of specific
/// plugins: no declaration — a neutral icon (`PluginIconBook.neutralSymbol`).
@MainActor
@Observable
public final class PluginIconBook {
    public static let shared = PluginIconBook()
    /// SF Symbol for a plugin without a declared icon.
    public nonisolated static let neutralSymbol = "puzzlepiece.extension"

    public private(set) var icons: [String: PluginIcon] = [:]

    public init() {}

    public func icon(_ id: String) -> PluginIcon? { icons[id] }

    /// The installed plugin's declaration takes precedence over the catalog: the catalog may lag behind what is installed.
    public func absorb(state: HubState?) {
        guard let state else { return }
        for p in state.plugins { set(p.id, p.icon, strong: true) }
    }

    public func absorb(catalog: RegistryCatalog?, installedIds: Set<String> = []) {
        for p in catalog?.plugins ?? [] where !installedIds.contains(p.id) { set(p.id, p.icon, strong: false) }
    }

    public func absorb(requests: [OwnRequest]) {
        for r in requests { set(r.id, r.icon, strong: false) }
    }

    public func absorb(consent: ConsentRequest) { set(consent.id, consent.icon, strong: false) }

    private var strongIds: Set<String> = []

    private func set(_ id: String, _ icon: PluginIcon?, strong: Bool) {
        if !strong && strongIds.contains(id) { return }
        if strong { strongIds.insert(id) }
        guard icons[id] != icon else { return }
        icons[id] = icon
    }
}
