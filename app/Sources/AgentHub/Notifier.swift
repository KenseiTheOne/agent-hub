import AgentHubKit
import AppKit
import UserNotifications

/// macOS notifications on the `push.notify` event (the daemon's push service): a `UNUserNotificationCenter` banner with an
/// "Open" button (replies only in the panel card). Once shown — `POST /push/ack`, and the daemon doesn't duplicate
/// the banner via osascript. If notifications are disallowed we don't acknowledge: then the daemon shows the banner.
/// Our own banner only in the pinned build (class `app`): the daemon rejects an unpinned build's ack (403), and without this
/// check every notification would arrive twice (ours and osascript after 3 s).
/// Permission is requested on the first notification, not at launch; that notification itself is shown by the daemon
/// (the human's answer to the permission prompt takes longer than the ack window — otherwise there'd be a duplicate too), the following ones by the shell.
///
/// Plugin buttons (G5): `actions` of the event become banner buttons — pressing one is `POST /actions/:offer` exactly like
/// the panel button (non-immediate → the app's confirmation sheet). macOS attaches buttons through a category, so each
/// distinct button set gets its own category, registered before the banner is added. `href` is the body click target;
/// without it the click opens the plugin page. Without these fields — the plain "Open" banner as before.
/// What macOS allows this app, for the views: read at launch, every time the app comes forward (the human returns
/// from System Settings) and whenever a banner is about to be shown. Without a bundle it stays `unknown`.
@MainActor
@Observable
final class NotifyPermissionModel {
    static let shared = NotifyPermissionModel()
    private(set) var status: NotifyPermission = .unknown

    func refresh() {
        guard Bundle.main.bundleIdentifier != nil else { return } // UNUserNotificationCenter crashes without a bundle
        Task {
            let s = await UNUserNotificationCenter.current().notificationSettings()
            set(s.authorizationStatus)
        }
    }

    func set(_ s: UNAuthorizationStatus) {
        let next: NotifyPermission
        switch s {
        case .authorized, .provisional: next = .allowed
        case .notDetermined: next = .notAsked
        case .denied: next = .denied
        default: next = .unknown
        }
        if next != status { status = next }
    }

    static func openSystemSettings() {
        NSWorkspace.shared.open(NotifyPermissionText.settingsURL(bundleId: Bundle.main.bundleIdentifier))
    }
}

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    nonisolated static let category = NotifyCategory.plain
    nonisolated static let openAction = "agenthub.open"
    /// How many button categories to keep registered (oldest dropped first): banners still on screen keep working,
    /// the registration stays small.
    static let maxCategories = 24

    private let store: HubStore
    private let onOpen: @MainActor (NotifyTarget) -> Void
    private let center = UNUserNotificationCenter.current()
    /// Button sets registered as categories, oldest first: category id → buttons (verified on every hit).
    private var buttonSets = NotifyCategory.Registry(limit: maxCategories)
    private var activeObserver: (any NSObjectProtocol)?

    init(store: HubStore, onOpen: @escaping @MainActor (NotifyTarget) -> Void) {
        self.store = store
        self.onOpen = onOpen
        super.init()
        center.delegate = self
        registerCategory()
        NotifyPermissionModel.shared.refresh()
        // the human may have changed the permission in System Settings while the app was in the background
        activeObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in NotifyPermissionModel.shared.refresh() }
        }
    }

    /// The "Открыть" / "Open" button and the plugin buttons' categories — in the hub language; re-registered when the
    /// language changes.
    func registerCategory() {
        let open = UNNotificationAction(identifier: Self.openAction, title: tr("Открыть", "Open"), options: [.foreground])
        var all: Set<UNNotificationCategory> = [UNNotificationCategory(identifier: Self.category, actions: [open], intentIdentifiers: [])]
        for set in buttonSets.sets {
            let buttons = set.actions.enumerated().map { i, a in
                // a button that asks first brings the app forward for the confirmation sheet; an immediate one runs quietly
                UNNotificationAction(identifier: NotifyCategory.actionPrefix + String(i), title: Self.title(a),
                                     options: a.level == .immediate ? [] : [.foreground])
            }
            all.insert(UNNotificationCategory(identifier: set.id, actions: buttons + [open], intentIdentifiers: []))
        }
        center.setNotificationCategories(all)
    }

    private static func title(_ a: NotifyAction) -> String { a.label + (a.level == .immediate ? "" : "…") }

    /// Register the category of this button set (if new) and wait until the center has it: a banner added before its
    /// category is known shows without buttons.
    private func ensureCategory(_ actions: [NotifyAction]) async -> String {
        let (id, changed) = buttonSets.register(actions)
        guard !actions.isEmpty else { return id }
        if changed { registerCategory() }
        // wait for the category with THESE buttons (a re-registered id may still carry the previous set for a moment)
        let titles = actions.map(Self.title)
        for _ in 0..<10 {
            if await center.notificationCategories().contains(where: { $0.identifier == id && Array($0.actions.map(\.title).prefix(titles.count)) == titles }) { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return id
    }

    func show(_ n: PushNotify) {
        guard store.peer?.isApp == true else { return } // the ack won't be accepted — the daemon will show the banner
        Task {
            guard await authorized() else { return } // no ack — the daemon will show osascript
            let content = UNMutableNotificationContent()
            content.title = n.title
            if let s = n.subtitle, !s.isEmpty { content.subtitle = s }
            if let b = n.body, !b.isEmpty { content.body = b }
            content.categoryIdentifier = await ensureCategory(n.actions)
            var info: [String: Any] = ["plugin": n.plugin ?? "", "key": n.key ?? ""]
            if !n.actions.isEmpty { info["actions"] = NotifyCategory.userInfo(n.actions) }
            if let href = n.href { info["href"] = href.absoluteString }
            content.userInfo = info
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
        NotifyPermissionModel.shared.set(settings.authorizationStatus)
        switch settings.authorizationStatus {
        case .authorized, .provisional: return true
        case .notDetermined:
            // ask, but don't show this notification: while the human is answering, the daemon will already show it itself
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            NotifyPermissionModel.shared.set(await center.notificationSettings().authorizationStatus)
            return false
        default: return false
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let plugin = info["plugin"] as? String
        let key = info["key"] as? String
        let href = (info["href"] as? String).flatMap(NotifyAction.webURL)
        let action = response.actionIdentifier
        // a plugin button: the same offer the panel would press
        if let pressed = NotifyCategory.action(id: action, userInfo: info) {
            await MainActor.run {
                Task { await store.perform(offer: pressed.asOffer, label: pressed.label) }
            }
            return
        }
        if action == UNNotificationDefaultActionIdentifier, let href {
            await MainActor.run { _ = NSWorkspace.shared.open(href) }
            return
        }
        guard action == Self.openAction || action == UNNotificationDefaultActionIdentifier else { return }
        await MainActor.run { onOpen(NotifyTarget.of(plugin: plugin, key: key)) }
    }
}
