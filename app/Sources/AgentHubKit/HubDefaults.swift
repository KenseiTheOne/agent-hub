import Foundation

/// The shell's memory in UserDefaults is per hub (socket), not for the whole bundle: a test copy (`--home`, `AGENTHUB_HOME`,
/// `scripts/bundle.sh --home`) with the same bundle id writes to the same domain, and its "It's me", "Got it" and the window height for
/// screenshots would otherwise dismiss the live hub's notes and change its panel.
public enum HubDefaults {
    /// Keys bound to the socket: `<base>:<socket path>`.
    public static let scopedBases = ["hubLang", "hubLangSetting", "pinNoteAck", "hubUpdateDoneAck"]
    /// Old bundle-wide keys (before 2026-11-07) — both the live and test copies wrote them; removed at startup.
    public static let legacyKeys = ["pinNoteAck", "hubUpdateDoneAck"]

    public static func key(_ base: String, socketPath: String) -> String { "\(base):\(socketPath)" }

    /// Autosave the panel window frame: only the live directory and without `--panel-width`/`--panel-height` (a screenshot run
    /// sets the size itself — it must not become the live hub's panel size).
    public static func autosavesPanelFrame(arguments: [String] = CommandLine.arguments,
                                           environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        if arguments.contains("--panel-width") || arguments.contains("--panel-height") { return false }
        return HubPaths.home(arguments: arguments, environment: environment) == HubPaths.defaultHome
    }

    /// Remove the memory of hubs whose directories no longer exist (setups in /tmp), and the old bundle-wide keys. `keep` — the socket
    /// of this launch (its keys stay even if the directory does not exist yet). → the removed keys.
    @discardableResult
    public static func prune(_ defaults: UserDefaults = .standard, keep: String,
                             dirExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> [String] {
        var removed: [String] = []
        for k in defaults.dictionaryRepresentation().keys.sorted() {
            if legacyKeys.contains(k) {
                defaults.removeObject(forKey: k)
                removed.append(k)
                continue
            }
            guard let base = scopedBases.first(where: { k.hasPrefix($0 + ":") }) else { continue }
            let sock = String(k.dropFirst(base.count + 1))
            guard sock != keep, sock.hasPrefix("/") else { continue }
            if !dirExists((sock as NSString).deletingLastPathComponent) {
                defaults.removeObject(forKey: k)
                removed.append(k)
            }
        }
        return removed
    }
}
