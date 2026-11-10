import Foundation

/// A daemon bus event from SSE `GET /events` (the table in docs/api.md).
public enum HubEvent: Sendable {
    case snapshot(HubState)
    case plugin(PluginState, worst: HubStatus?)
    case pluginRemoved(String)
    case sessions([SessionInfo])
    case estop(Bool)
    case action(id: String, ok: Bool, plugin: String?, primitive: String?)
    case raised(key: String, plugin: String?, status: HubStatus?)
    case cleared(key: String, plugin: String?)
    /// `push.notify`: show a macOS notification (push service).
    case pushNotify(PushNotify)
    /// `hook.card` / `hook.card.removed`: a session answer card appeared / was dismissed (metadata only).
    case hookCard(requestId: String)
    case hookCardRemoved(requestId: String, reason: String?)
    /// `hook.paused`: the approval limit was exceeded — answers to sessions are paused until `until` (cards dismissed).
    case hookPaused(until: String?)
    /// `app-pin.changed`: `requirements.app` changed in the daemon config (the app build was re-pinned).
    case appPinChanged(AppPinInfo)
    /// `app-pin.path-changed`: with the same requirement, the pinned build's path changed (`appPin.path` — the bundle
    /// the daemon launches at startup and after a crash). Connections are not dropped.
    case appPinPathChanged(AppPinInfo)
    /// `plugins.updates`: the list of available plugin updates changed (or the background check switch).
    case pluginUpdates(PluginUpdates)
    /// `hub-update.status`: something in the hub update changed (the check, the available version, install progress).
    case hubUpdate(HubUpdateInfo)
    /// `hub-update.restarting`: the hub is switching to another version — the app quits by itself, without `/shutdown`;
    /// the new daemon will launch the new app (docs/hub-updates.md §3, step 4).
    case hubRestarting(label: String?)
    /// `idle.verdict`: the "is it safe to shut down" verdict changed (the daemon's idle service). nil — "checking" (verdict null:
    /// the daemon has just started, not all sources have answered) — the icon and popover as without a verdict.
    case idle(IdleVerdict?)
    /// Extension events (`push.sent`, `bridge.connected`, `plugins.installed`, …) and anything unknown.
    case other(type: String, data: JSONValue)

    private struct SnapshotData: Decodable { var state: HubState }
    private struct PluginData: Decodable { var plugin: PluginState; var status: HubStatus? }
    private struct RemovedData: Decodable { var plugin: String }
    private struct SessionsData: Decodable { var sessions: [SessionInfo] }
    private struct EstopData: Decodable { var on: Bool }
    private struct ActionData: Decodable { var action: String; var ok: Bool?; var plugin: String?; var primitive: String? }
    private struct RaisedData: Decodable { var key: String; var plugin: String?; var status: HubStatus? }
    private struct CardData: Decodable { var requestId: String; var reason: String? }
    private struct PausedData: Decodable { var until: String? }
    private struct PinData: Decodable { var appPin: AppPinInfo }
    private struct UpdatesData: Decodable { var pluginUpdates: PluginUpdates }
    private struct HubUpdateData: Decodable { var hubUpdate: HubUpdateInfo }
    private struct RestartingData: Decodable { var label: String? }
    private struct IdleData: Decodable {
        var idle: IdleVerdict?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            guard c.contains(.idle) else { throw DecodingError.keyNotFound(CodingKeys.idle, .init(codingPath: [], debugDescription: "idle")) }
            idle = try? c.decode(IdleVerdict.self, forKey: .idle)
        }
        enum CodingKeys: String, CodingKey { case idle }
    }

    /// Parsing an SSE event. Broken JSON of a known type → nil (the event is skipped, the stream lives on).
    public static func decode(_ ev: SSEEvent) -> HubEvent? {
        let data = Data(ev.data.utf8)
        let dec = JSONDecoder()
        do {
            switch ev.event {
            case "snapshot": return .snapshot(try dec.decode(SnapshotData.self, from: data).state)
            case "plugin":
                let d = try dec.decode(PluginData.self, from: data)
                return .plugin(d.plugin, worst: d.status)
            case "plugin.removed": return .pluginRemoved(try dec.decode(RemovedData.self, from: data).plugin)
            case "sessions": return .sessions(try dec.decode(SessionsData.self, from: data).sessions)
            case "estop": return .estop(try dec.decode(EstopData.self, from: data).on)
            case "action":
                let d = try dec.decode(ActionData.self, from: data)
                return .action(id: d.action, ok: d.ok ?? false, plugin: d.plugin, primitive: d.primitive)
            case "event.raised":
                let d = try dec.decode(RaisedData.self, from: data)
                return .raised(key: d.key, plugin: d.plugin, status: d.status)
            case "event.cleared":
                let d = try dec.decode(RaisedData.self, from: data)
                return .cleared(key: d.key, plugin: d.plugin)
            case "push.notify": return .pushNotify(try dec.decode(PushNotify.self, from: data))
            case "hook.card": return .hookCard(requestId: try dec.decode(CardData.self, from: data).requestId)
            case "hook.card.removed":
                let d = try dec.decode(CardData.self, from: data)
                return .hookCardRemoved(requestId: d.requestId, reason: d.reason)
            case "hook.paused": return .hookPaused(until: try dec.decode(PausedData.self, from: data).until)
            case "app-pin.changed": return .appPinChanged(try dec.decode(PinData.self, from: data).appPin)
            case "app-pin.path-changed": return .appPinPathChanged(try dec.decode(PinData.self, from: data).appPin)
            case "plugins.updates": return .pluginUpdates(try dec.decode(UpdatesData.self, from: data).pluginUpdates)
            case "hub-update.status": return .hubUpdate(try dec.decode(HubUpdateData.self, from: data).hubUpdate)
            case "hub-update.restarting": return .hubRestarting(label: (try? dec.decode(RestartingData.self, from: data))?.label)
            case "idle.verdict": return .idle(try dec.decode(IdleData.self, from: data).idle)
            default:
                return .other(type: ev.event, data: (try? dec.decode(JSONValue.self, from: data)) ?? .string(ev.data))
            }
        } catch {
            return nil
        }
    }
}

extension HubState {
    /// Apply the event to the snapshot. Returns false if the event does not change the snapshot.
    @discardableResult
    public mutating func apply(_ event: HubEvent) -> Bool {
        switch event {
        case .snapshot(let s):
            self = s
        case .plugin(let p, let worst):
            if let i = plugins.firstIndex(where: { $0.id == p.id }) { plugins[i] = p } else { plugins.append(p) }
            status = worst ?? HubStatus.worst(plugins.map(\.status))
        case .pluginRemoved(let id):
            plugins.removeAll { $0.id == id }
            status = HubStatus.worst(plugins.map(\.status))
        case .sessions(let list):
            sessions = list
            waitingSessions = list.filter(\.isWaiting).count
        case .estop(let on):
            estop = on
        case .appPinChanged(let pin), .appPinPathChanged(let pin):
            appPin = pin
        case .pluginUpdates(let u):
            pluginUpdates = u
        case .hubUpdate(let u):
            hubUpdate = u
        case .idle(let v):
            idle = v
        case .action, .raised, .cleared, .pushNotify, .hookCard, .hookCardRemoved, .hookPaused, .hubRestarting, .other:
            return false
        }
        return true
    }
}
