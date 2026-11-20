import Foundation

/// The order of plugins in the panel's sidebar and the menu. By default — alphabetical by title; the human may arrange
/// them by hand, and that arrangement is remembered per hub (UserDefaults, `pluginOrder:<socket>`) until "Default".
///
/// Stored as plugin ids, one per line; an empty value is the default. Ids no longer installed are skipped, plugins not
/// in the saved list (installed later) go after the arranged ones, alphabetically — a new plugin does not reshuffle
/// what the human arranged.
public enum PluginOrder {
    public static let defaultsBase = "pluginOrder"

    /// The saved value → ids; empty — the default (alphabetical).
    public static func decode(_ raw: String) -> [String] {
        raw.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    public static func encode(_ ids: [String]) -> String { ids.joined(separator: "\n") }

    /// Alphabetical by title (as Finder sorts: case-insensitive, numbers by value), then by id for equal titles.
    public static func alphabetical(_ plugins: [PluginState]) -> [PluginState] {
        plugins.sorted { a, b in
            let c = a.title.localizedStandardCompare(b.title)
            return c != .orderedSame ? c == .orderedAscending : a.id < b.id
        }
    }

    /// The plugins in the saved order; nothing saved — alphabetical.
    public static func apply(_ saved: [String], to plugins: [PluginState]) -> [PluginState] {
        let rest = alphabetical(plugins)
        guard !saved.isEmpty else { return rest }
        let byId = Dictionary(plugins.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var seen = Set<String>()
        let arranged = saved.compactMap { id -> PluginState? in
            guard seen.insert(id).inserted else { return nil }
            return byId[id]
        }
        return arranged + rest.filter { !seen.contains($0.id) }
    }

    /// Move `id` to where `target` is (dropping one row onto another): the ids of `current` after the move. Unknown ids —
    /// unchanged.
    public static func move(_ id: String, onto target: String, in current: [String]) -> [String] {
        guard id != target, let from = current.firstIndex(of: id), let to = current.firstIndex(of: target) else { return current }
        var out = current
        out.remove(at: from)
        out.insert(id, at: to)
        return out
    }

    /// Move `id` one step up (`-1`) or down (`+1`); at the edge — unchanged.
    public static func step(_ id: String, by delta: Int, in current: [String]) -> [String] {
        guard let from = current.firstIndex(of: id) else { return current }
        let to = from + delta
        guard to >= 0, to < current.count else { return current }
        var out = current
        out.swapAt(from, to)
        return out
    }

    /// The full order after the visible part of it was rearranged: the places the visible ids held are filled with them
    /// in their new order; hidden ids (the sidebar does not list the sessions plugin, the menu does) keep their places.
    public static func replacing(visible: [String], in full: [String]) -> [String] {
        let shown = Set(visible)
        var next = visible.makeIterator()
        return full.map { shown.contains($0) ? (next.next() ?? $0) : $0 }
    }

    /// What to save for an arrangement: the alphabetical one is saved as "nothing" — so "Default" stays default, and a
    /// plugin installed later still lands in its alphabetical place.
    public static func toSave(_ ids: [String], plugins: [PluginState]) -> String {
        ids == alphabetical(plugins).map(\.id) ? "" : encode(ids)
    }
}
