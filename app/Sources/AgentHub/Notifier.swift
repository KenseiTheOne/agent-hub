import AgentHubKit
import AppKit
import UserNotifications

/// macOS notifications on the `push.notify` event (the daemon's push service): a `UNUserNotificationCenter` banner with a single
/// "Open" button (replies only in the panel card). Once shown — `POST /push/ack`, and the daemon doesn't duplicate
/// the banner via osascript. If notifications are disallowed we don't acknowledge: then the daemon shows the banner.
/// Our own banner only in the pinned build (class `app`): the daemon rejects an unpinned build's ack (403), and without this
/// check every notification would arrive twice (ours and osascript after 3 s).
/// Permission is requested on the first notification, not at launch; that notification itself is shown by the daemon
/// (the human's answer to the permission prompt takes longer than the ack window — otherwise there'd be a duplicate too), the following ones by the shell.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    nonisolated static let category = "agenthub.event"
    nonisolated static let openAction = "agenthub.open"

    private let store: HubStore
    private let onOpen: @MainActor (NotifyTarget) -> Void
    private let center = UNUserNotificationCenter.current()

    init(store: HubStore, onOpen: @escaping @MainActor (NotifyTarget) -> Void) {
        self.store = store
        self.onOpen = onOpen
        super.init()
        center.delegate = self
        registerCategory()
    }

    /// The "Открыть" / "Open" button — in the hub language; re-registered when the language changes.
    func registerCategory() {
        let open = UNNotificationAction(identifier: Self.openAction, title: tr("Открыть", "Open"), options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [open], intentIdentifiers: [])])
    }

    func show(_ n: PushNotify) {
        guard store.peer?.isApp == true else { return } // the ack won't be accepted — the daemon will show the banner
        Task {
            guard await authorized() else { return } // no ack — the daemon will show osascript
            let content = UNMutableNotificationContent()
            content.title = n.title
            if let s = n.subtitle, !s.isEmpty { content.subtitle = s }
            if let b = n.body, !b.isEmpty { content.body = b }
            content.categoryIdentifier = Self.category
            content.userInfo = ["plugin": n.plugin ?? "", "key": n.key ?? ""]
            content.threadIdentifier = n.plugin ?? "agenthub"
            let req = UNNotificationRequest(identifier: n.notifyId, content: content, trigger: nil)
            do {
                try await center.add(req)
                await store.ackNotify(n.notifyId)
            } catch {}
        }
    }

    private func authorized() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional: return true
        case .notDetermined:
            // ask, but don't show this notification: while the human is answering, the daemon will already show it itself
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            return false
        default: return false
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let plugin = response.notification.request.content.userInfo["plugin"] as? String
        let key = response.notification.request.content.userInfo["key"] as? String
        let action = response.actionIdentifier
        guard action == Self.openAction || action == UNNotificationDefaultActionIdentifier else { return }
        await MainActor.run { onOpen(NotifyTarget.of(plugin: plugin, key: key)) }
    }
}
