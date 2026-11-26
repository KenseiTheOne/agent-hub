import AgentHubKit
import AppKit
import SwiftUI

// The "Settings" section of the panel and its cards.

/// Language (System / Русский / English), launch at login, app pinning.
struct LanguagePicker: View {
    let store: HubStore

    static func title(_ s: LangSetting) -> String {
        switch s {
        case .system: return tr("Системный", "System")
        case .ru: return "Русский"
        case .en: return "English"
        }
    }

    var body: some View {
        // the daemon writes the language only for the pinned build (cli — 403)
        // the setting is unknown (the daemon didn't answer, and it isn't remembered for this hub) — no segment is selected
        SegmentCapsule(selection: Binding(get: { L10n.shared.settingKnown ? (LangSetting.allCases.firstIndex(of: L10n.shared.setting) ?? -1) : -1 },
                                          set: { i in Task { await store.setLang(LangSetting.allCases[i]) } }),
                       titles: LangSetting.allCases.map(Self.title))
            .disabled(!store.canAct || !store.connection.isLive)
            .tip(!store.canAct ? ActionBlock.notPinned.help : !store.connection.isLive ? ActionBlock.offline.help : "")
    }
}

struct SettingsView: View {
    /// Cards that can be scrolled to (`PanelRouter.settingsFocus`).
    enum Anchor {
        static let hubUpdate = "settings.hub-update"
        static let notifications = "settings.notifications"
        static let connections = "settings.connections"
        static let terminal = "settings.terminal"
    }

    let store: HubStore
    var router: PanelRouter? = nil
    let openJournal: () -> Void

    var body: some View {
        ScrollViewReader { proxy in
            content
                .onAppear { scrollToFocus(proxy) }
                .onChange(of: router?.settingsFocus) { _, _ in scrollToFocus(proxy) }
                // the card isn't there yet (the window opened before the daemon snapshot) — scroll once it appears
                .onChange(of: store.hubUpdate != nil) { _, _ in scrollToFocus(proxy) }
                .onChange(of: store.state?.notifications != nil) { _, _ in scrollToFocus(proxy) }
                .onChange(of: store.state?.connections != nil) { _, _ in scrollToFocus(proxy) }
                .onChange(of: store.state != nil) { _, _ in scrollToFocus(proxy) }
        }
    }

    private func scrollToFocus(_ proxy: ScrollViewProxy) {
        guard let id = router?.settingsFocus else { return }
        if id == Anchor.hubUpdate, store.hubUpdate == nil { return }
        if id == Anchor.notifications, store.state?.notifications == nil { return }
        if id == Anchor.connections, store.state?.connections == nil { return }
        if id == Anchor.terminal, store.state == nil { return }
        // after layout: the "Hub updates" card is third; at the usual window height it's at the bottom edge
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .top) }
            router?.settingsFocus = nil
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                card {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(tr("Язык", "Language")).font(.system(size: 13, weight: .semibold))
                        LanguagePicker(store: store)
                        Text(tr("«Системный» — русский, если он первый в языках macOS, иначе английский. Язык меняется сразу и для плагинов; менять его может только закреплённая сборка приложения.",
                                "\"System\" means Russian if it's first in your macOS languages, otherwise English. It switches right away, plugins included; only the pinned app build can change it."))
                            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                card { LaunchAtLoginSettings(store: store) }
                // only when there is a switch at all (a lid, and a daemon that knows about it)
                if let awake = store.awake, awake.supported { card { AwakeSettings(store: store, info: awake) } }
                card { NotificationsSettings(store: store, openJournal: openJournal) }.id(Anchor.notifications)
                card { ConnectionsSettings(store: store) }.id(Anchor.connections)
                if let h = store.hubUpdate { card { HubUpdateSettings(store: store, info: h) }.id(Anchor.hubUpdate) }
                if let u = store.state?.pluginUpdates { card { PluginUpdatesSettings(store: store, info: u) } }
                if let pin = store.state?.appPin {
                    card {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(tr("Закрепление приложения", "App pinning")).font(.system(size: 13, weight: .semibold))
                            Text(pin.kind == "none" ? tr("Не закреплено — подтверждения не работают", "Not pinned — confirmations won't work")
                                 : "\(pin.kind == "cert" ? tr("По сертификату", "By certificate") : tr("По отпечатку сборки", "By build fingerprint")) · \(pin.changedDate.map(Fmt.dateTime) ?? "?") · \(pin.originText)")
                                .font(.system(size: 12))
                            Text(tr("Отпечаток: \(pin.shortFingerprint) · записал: \(pin.byText)", "Fingerprint: \(pin.shortFingerprint) · written by: \(pin.byText)"))
                                .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                            // the bundle the hub launches at login and after a crash (appPin.path): a change is visible here
                            if let path = pin.path {
                                Text(tr("Хаб запускает: \(path)", "Hub launches: \(path)"))
                                    .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else if PinPathHint.needed(pin) {
                                // without a path the daemon doesn't launch the app — neither at login nor after a crash (decision 2026-11-07)
                                Text(tr("Путь сборки не записан — хаб не запустит приложение ни при входе, ни после падения. Выполните: \(PinPathHint.command(hub: store.state?.hub, bundlePath: store.peer?.isApp == true ? Bundle.main.bundlePath : nil))",
                                        "The build path isn't recorded — the hub won't launch the app at login or after a crash. Run: \(PinPathHint.command(hub: store.state?.hub, bundlePath: store.peer?.isApp == true ? Bundle.main.bundlePath : nil))"))
                                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Button(tr("Открыть журнал", "Open log"), action: openJournal).buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF))
                        }
                    }
                }
                card { TerminalSettings(store: store) }.id(Anchor.terminal)
                card {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tr("Служба хаба", "Hub service")).font(.system(size: 13, weight: .semibold))
                        Text(store.connection.isLive ? tr("Хаб работает", "Hub running") : tr("Хаб не отвечает", "Hub not responding")).font(.system(size: 12))
                        Text(store.client.socketPath).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                        // the Claude Code hook as the hub sees it (`/state.hook`); an older daemon — nothing
                        if let hook = store.state?.hook {
                            if let line = HookText.lastEvent(hook) {
                                Text(line).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7)).padding(.top, 4)
                            } else if HookText.shows(hook) {
                                Text(HookText.title).font(.system(size: 12, weight: .semibold)).padding(.top, 4)
                                Text(HookText.detail(hook)).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
                                Text(HookText.command(hook)).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
        }
    }

    private func card<V: View>(@ViewBuilder _ v: () -> V) -> some View {
        v().padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
    }
}

/// Notifications (2026-11-09): a master switch, per-kind switches, quiet hours and security exceptions that can't be
/// turned off. The daemon writes the settings (`PUT /settings/notifications`, pinned build only); a disabled kind
/// doesn't arrive at all, but stays in the popover and the log.
struct NotificationsSettings: View {
    let store: HubStore
    let openJournal: () -> Void

    private var canEdit: Bool { store.connection.isLive && store.canAct }
    private var lockHelp: String { !store.canAct ? ActionBlock.notPinned.help : !store.connection.isLive ? ActionBlock.offline.help : "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let n = store.state?.notifications {
                content(n)
            } else {
                // the daemon stores the settings: without its answer (or with an older daemon) we don't make anything up
                HStack {
                    Text(tr("Уведомления", "Notifications")).font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Text(tr("неизвестно", "unknown")).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                }
                if store.connection.isLive {
                    Text(tr("Служба хаба старше этой настройки — обновите хаб", "The hub service predates this setting — update the hub"))
                        .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private func content(_ n: NotificationsInfo) -> some View {
        Toggle(tr("Уведомления", "Notifications"),
               isOn: Binding(get: { n.enabled }, set: { v in Task { await store.setNotifications(.object(["enabled": .bool(v)])) } }))
            .toggleStyle(.switch).font(.system(size: 13, weight: .semibold))
            .disabled(!canEdit).tip(lockHelp)
        if NotifyPermissionText.shows(NotifyPermissionModel.shared.status, hubEnabled: n.enabled) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "bell.slash").font(.system(size: 11)).foregroundStyle(hexColor(0xFFC56B))
                VStack(alignment: .leading, spacing: 2) {
                    Text(NotifyPermissionText.title).font(.system(size: 12, weight: .semibold))
                    Text(NotifyPermissionText.detail).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Button(NotifyPermissionText.button) { NotifyPermissionModel.openSystemSettings() }
                    .buttonStyle(CapsuleStyle(fill: .white.opacity(0.12), stroke: .white.opacity(0.14), text: .white, height: 26, expand: false))
            }
        }
        Text(NotificationsText.channels(n))
            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        // channels that take notifications off this Mac (re-review 70): names and kinds from the daemon, never addresses
        if !n.externalChannels.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(NotificationsText.externalHeader).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.8))
                ForEach(n.externalChannels) { c in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "arrow.up.forward.app").font(.system(size: 10)).foregroundStyle(.white.opacity(0.6))
                        Text(NotificationsText.channelRow(c)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Text(NotificationsText.externalExplain)
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 12)
        }
        if !n.service {
            Text(tr("Служба уведомлений выключена в config.json (services.push.enabled) — не приходит ничего, даже исключения безопасности.",
                    "The notification service is off in config.json (services.push.enabled) — nothing arrives, not even security exceptions."))
                .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
        }

        VStack(alignment: .leading, spacing: 6) {
            ForEach(NotificationsInfo.kinds, id: \.self) { kind in
                VStack(alignment: .leading, spacing: 1) {
                    Toggle(NotificationsText.kindTitle(kind),
                           isOn: Binding(get: { n.enabled && n.kindOn(kind) },
                                         set: { v in Task { await store.setNotifications(.object(["kinds": .object([kind: .bool(v)])])) } }))
                        .toggleStyle(.switch).font(.system(size: 12.5))
                    Text(NotificationsText.kindDetail(kind))
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                }
            }
            // plugins' own toggles (contract 2): rows come from installed plugins with kind="plugin" rules;
            // no plugin — no row
            if !n.plugins.isEmpty {
                Text(NotificationsText.pluginsHeader).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.8))
                    .padding(.top, 4)
                ForEach(n.plugins) { p in
                    VStack(alignment: .leading, spacing: 1) {
                        Toggle(isOn: Binding(get: { n.enabled && p.on },
                                             set: { v in Task { await store.setNotifications(.object(["plugins": .object([p.id: .bool(v)])])) } })) {
                            HStack(spacing: 6) {
                                PluginTile(id: p.id, size: 16, radius: 4)
                                Text(p.title)
                            }
                        }
                        .toggleStyle(.switch).font(.system(size: 12.5))
                        Text(NotificationsText.pluginDetail(p, community: store.plugin(p.id)?.tier == .community))
                            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                        if p.legacy && !p.on {
                            Text(NotificationsText.pluginLegacyNote)
                                .font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .padding(.leading, 12)
        // the master switch is off — kinds aren't touched (their values are kept until it's turned back on)
        .disabled(!canEdit || !n.enabled).opacity(n.enabled ? 1 : 0.55).tip(lockHelp)
        Text(NotificationsText.mutedExplain)
            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        Button(tr("Открыть журнал", "Open log"), action: openJournal).buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF))

        Divider().opacity(0.4).padding(.vertical, 2)
        quietHours(n)

        Divider().opacity(0.4).padding(.vertical, 2)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "lock.fill").font(.system(size: 11)).foregroundStyle(.white.opacity(0.7))
                Text(tr("Не отключаются", "Can't be turned off")).font(.system(size: 12.5, weight: .semibold))
            }
            ForEach(n.security) { item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").foregroundStyle(.white.opacity(0.5))
                    Text(NotificationsText.securityTitle(item)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(NotificationsText.securityExplain)
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private func quietHours(_ n: NotificationsInfo) -> some View {
        let q = n.quiet
        Toggle(tr("Тихие часы", "Quiet hours"),
               isOn: Binding(get: { q.enabled }, set: { v in Task { await store.setNotifications(.object(["quiet": .object(["enabled": .bool(v)])])) } }))
            .toggleStyle(.switch).font(.system(size: 12.5, weight: .semibold))
            .disabled(!canEdit).tip(lockHelp)
        HStack(spacing: 8) {
            Text(tr("с", "from")).font(.system(size: 12))
            timePicker(q.start) { v in ["start": .string(v)] }
            Text(tr("до", "to")).font(.system(size: 12))
            timePicker(q.end) { v in ["end": .string(v)] }
        }
        .disabled(!canEdit || !q.enabled).opacity(q.enabled ? 1 : 0.55).tip(lockHelp)
        Text(NotificationsText.quietExplain)
            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        if let src = NotificationsText.quietSource(q) {
            Text(src).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        }
        if let zone = NotificationsText.quietZone(q) {
            Text(zone).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func timePicker(_ value: String, patch: @escaping (String) -> [String: JSONValue]) -> some View {
        Picker("", selection: Binding(get: { value }, set: { v in
            guard v != value else { return }
            Task { await store.setNotifications(.object(["quiet": .object(patch(v))])) }
        })) {
            ForEach(NotificationsText.timeOptions(including: value), id: \.self) { Text($0).tag($0) }
        }
        .labelsHidden().pickerStyle(.menu).fixedSize()
        .font(.system(size: 12, design: .monospaced))
    }
}

/// "Check for plugin updates": the daemon's background check of the signed catalog (every 6 h). The daemon writes the setting
/// (pinned build only); `services.plugins.checkUpdates = false` in config.json overrides it.
struct PluginUpdatesSettings: View {
    let store: HubStore
    let info: PluginUpdates

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // the header — like the neighbouring "Hub updates" card
            Text(tr("Обновления плагинов", "Plugin updates")).font(.system(size: 13, weight: .semibold))
            Toggle(tr("Проверять обновления плагинов", "Check for plugin updates"),
                   isOn: Binding(get: { info.setting }, set: { v in Task { await store.setCheckPluginUpdates(v) } }))
                .toggleStyle(.switch).font(.system(size: 12.5))
                .disabled(!store.connection.isLive || !info.config || !store.canAct)
                .tip(!store.canAct ? ActionBlock.notPinned.help : "")
            // the interval — in the same wording as "Hub updates" (HubUpdateText.checkExplain)
            Text(tr("Несколько раз в день хаб скачивает подписанный каталог реестра и сообщает о новых версиях установленных плагинов — одним уведомлением на версию. Сам ничего не ставит: обновление — кнопкой «Обновить» в «Плагинах». Менять настройку может только закреплённая сборка приложения.",
                    "A few times a day the hub downloads the signed registry catalog and tells you about new versions of installed plugins — one notification per version. It never installs anything itself: update with the Update button in Plugins. Only the pinned app build can change this setting."))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            let status = PluginUpdatesStatus.line(info)
            Text(status.text).font(.system(size: 11.5)).foregroundStyle(status.warn ? hexColor(0xFFC56B) : .white.opacity(0.55))
                .fixedSize(horizontal: false, vertical: true)
            // the same check as the background one (a new version notification — once)
            Button(store.hubUpdateBusy == "plugins-check" ? tr("Проверяю…", "Checking…") : tr("Проверить сейчас", "Check now")) { Task { await store.checkPluginUpdatesNow() } }
                .font(.system(size: 12))
                .disabled(!store.connection.isLive || !store.canAct || !info.config || !info.setting || !info.configured || store.hubUpdateBusy != nil)
                .tip(!store.canAct ? ActionBlock.notPinned.help : "")
        }
    }
}

/// "Terminal" in settings: the terminal adapters of the hub — which terminals sessions run in now (detected per session), what
/// the hub can do in each (capability chips), where a new session opens. The cmux bridge is the cmux adapter's detail and sits
/// under its row. A daemon before the terminal layer (no `/state.terminals`) — only the bridge, as before.
struct TerminalSettings: View {
    let store: HubStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("Терминал", "Terminal")).font(.system(size: 13, weight: .semibold))
            if let ts = store.state?.terminals {
                Text(tr("Хаб сам определяет терминал каждой сессии и делает в нём только то, что этот терминал умеет.",
                        "The hub detects each session's terminal and does only what that terminal supports."))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(ts.adapters.enumerated()), id: \.element.id) { i, a in
                        if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                        row(a)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
                launchLine(ts)
                Text(tr("iTerm2 и Terminal: при первом переходе macOS спросит, можно ли хабу управлять приложением (Конфиденциальность и безопасность → Автоматизация).",
                        "iTerm2 and Terminal: on the first switch macOS asks whether the hub may control the app (Privacy & Security → Automation)."))
                    .font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).fixedSize(horizontal: false, vertical: true)
            } else {
                BridgeSettings(store: store)
            }
        }
    }

    private func dot(_ a: TerminalsInfo.Adapter) -> Color {
        if a.via == "bridge", !store.bridgeOnline, a.installed != false || a.sessions > 0 { return .orange }
        if a.installed == false, a.sessions == 0 { return .gray }
        return TerminalText.ready(a, bridgeOnline: store.bridgeOnline) ? .green : .orange
    }

    @ViewBuilder private func row(_ a: TerminalsInfo.Adapter) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(dot(a)).frame(width: 7, height: 7)
                Text(a.label).font(.system(size: 12.5, weight: .semibold))
                // an adapter from <home>/Extensions/terminals (approved by a human in Plugins → Extensions)
                if a.isExtension { BadgeView(text: tr("расширение", "extension"), color: "purple") }
                Spacer(minLength: 8)
                Text(TerminalText.status(a, bridgeOnline: store.bridgeOnline)).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55))
            }
            // the adapter's own words for why it can't run, or what to set up first
            if let why = a.reasonText, !a.available || a.needsSetup {
                Label(why, systemImage: a.needsSetup ? "wrench.and.screwdriver" : "info.circle")
                    .font(.system(size: 11.5)).foregroundStyle(a.needsSetup ? hexColor(0xFFC56B) : .white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 15)
            }
            HStack(spacing: 5) {
                ForEach(["focus", "read-screen", "send-text", "send-esc", "launch"], id: \.self) { c in
                    let on = a.supports(c)
                    Text(TerminalText.capability(c)).font(.system(size: 10.5, weight: .medium))
                        .strikethrough(!on, color: .white.opacity(0.35))
                        .foregroundStyle(on ? .white.opacity(0.85) : .white.opacity(0.3))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(on ? Color.white.opacity(0.10) : Color.clear))
                        .overlay(Capsule().strokeBorder(Color.white.opacity(on ? 0 : 0.12), lineWidth: 0.5))
                        .tip(on ? tr("\(a.label): поддерживается", "\(a.label): supported") : TerminalText.unsupported(terminal: a.label, capability: c))
                }
            }
            .padding(.leading, 15)
            // the cmux bridge — the cmux adapter's detail: its state and how to start it
            if a.via == "bridge" { BridgeSettings(store: store, compact: true).padding(.leading, 15) }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    @ViewBuilder private func launchLine(_ ts: TerminalsInfo) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "plus.rectangle.on.rectangle").font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
            if let a = ts.launchAdapter {
                Text(tr("Новые сессии открываются в \(a.label)", "New sessions open in \(a.label)") + (TerminalText.launchWhy(ts.launch?.why).map { " · \($0)" } ?? ""))
                    .font(.system(size: 12))
            } else {
                Text(ActionBlock.noLaunchTerminal.help).font(.system(size: 12)).foregroundStyle(.orange)
            }
        }
        .tip(tr("Выбрать терминал: services.terminal.launch в config.json хаба (id терминала или auto).",
                 "To choose the terminal: services.terminal.launch in the hub's config.json (a terminal id or auto)."))
    }
}

/// The cmux bridge: whether it's connected (since when, version) or how to start it. In Settings → Terminal it sits under the
/// cmux row (`compact`); for a daemon before the terminal layer — on its own.
struct BridgeSettings: View {
    let store: HubStore
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !compact { Text(tr("Мост cmux", "cmux bridge")).font(.system(size: 13, weight: .semibold)) }
            if let b = store.state?.bridge {
                // under the cmux row its "bridge not connected" state is already on the right: only the details when connected
                if !compact || b.online {
                HStack(spacing: 6) {
                    Circle().fill(b.online ? Color.green : Color.orange).frame(width: 7, height: 7)
                    Text((compact ? tr("Мост cmux: ", "cmux bridge: ") : "")
                         + (b.online ? tr("подключён", "connected") + (sinceText(b).map { tr(" · с \($0)", " · since \($0)") } ?? "") + (b.version.map { " · v\($0)" } ?? "")
                                     : tr("не подключён — в cmux недоступны переход во вкладки, Esc, чтение и набор, новые вкладки", "not connected — switching to tabs, Esc, reading, typing and new tabs are unavailable in cmux")))
                        .font(.system(size: compact ? 11.5 : 12)).foregroundStyle(.white.opacity(compact ? 0.7 : 1)).fixedSize(horizontal: false, vertical: true)
                }
                }
                if !b.online, !compact || cmuxInUse { BridgeNotice(store: store, place: .settings) }
                Text(tr("Мост живёт в закреплённой вкладке cmux и выполняет для хаба операции во вкладках cmux.", "The bridge lives in a pinned cmux tab and runs the hub's operations in cmux tabs."))
                    .font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(BridgeSettingsText.missing(stateKnown: store.state != nil))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
            }
        }
    }

    /// cmux is used here: installed or has sessions — only then does the compact block show the start command.
    private var cmuxInUse: Bool {
        guard let a = store.state?.terminals?.adapters.first(where: { $0.via == "bridge" }) else { return true }
        return a.installed != false || a.sessions > 0
    }

    private func sinceText(_ b: BridgeInfo) -> String? {
        guard let s = b.since else { return nil }
        return ISODate.parse(s).map(Fmt.dateTime)
    }
}

/// "Stay awake with the lid closed": nothing to set here — the switch itself is in the popover, the panel sidebar and
/// the icon menu (`AwakeToggleRow`), and the charge below which the daemon brings sleep back is the daemon's own fixed
/// number. The card says what the mode does (with that number, as the daemon sent it), what the computer runs on now,
/// and, when the hub has no rights, the command to grant them as text that can be copied (a hint can't).
struct AwakeSettings: View {
    let store: HubStore
    let info: AwakeInfo

    var body: some View {
        let live = store.connection.isLive
        VStack(alignment: .leading, spacing: 6) {
            Text(AwakeRow.title).font(.system(size: 13, weight: .semibold))
            if live, let now = AwakeText.power(info) {
                Text(now).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
            }
            Text(AwakeText.about(threshold: info.threshold))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            if live, !info.granted {
                Text(info.on ? AwakeText.onWithoutRights(threshold: info.threshold, hub: store.state?.hub) : AwakeText.notGranted(hub: store.state?.hub))
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }
}

/// "Launch at login" — the daemon + app pair (decision 2026-11-07). The setting lives in the daemon
/// (`settings.json → launchAtLogin`), only the pinned build writes it; at login launchd brings the pair up
/// (the daemon, then the daemon starts the app). Off — neither starts at login; an app opened by hand
/// brings up the daemon itself. Recovery of a crashed app works with any setting.
struct LaunchAtLoginSettings: View {
    let store: HubStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            let info = store.state?.launchAtLogin
            if let info {
                Toggle(tr("Запускать при входе", "Launch at login"),
                       isOn: Binding(get: { info.setting }, set: { v in Task { await store.setLaunchAtLogin(v) } }))
                    .toggleStyle(.switch).font(.system(size: 13, weight: .semibold))
                    .disabled(!store.connection.isLive || !store.canAct || info.agentOutdated)
                    .tip(!store.canAct ? ActionBlock.notPinned.help : !store.connection.isLive ? ActionBlock.offline.help
                          : info.agentOutdated ? LaunchAgentHint.text(hub: store.state?.hub) : "")
            } else {
                // the daemon stores the setting: without its answer it's unknown — don't draw a made-up "on"
                HStack {
                    Text(tr("Запускать при входе", "Launch at login")).font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Text(tr("неизвестно", "unknown")).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                }
                .tip(store.connection.isLive ? "" : ActionBlock.offline.help)
            }
            Text(tr("Служба хаба и приложение запускаются вместе при входе в систему. Выключено — при входе не запускается ни то, ни другое; открытое вручную приложение само поднимает службу. Упавшее приложение хаб перезапускает в обоих случаях. Менять настройку может только закреплённая сборка приложения.",
                    "The hub service and the app start together when you log in. Off — neither starts at login; when you open the app yourself, it starts the service. The hub restarts a crashed app either way. Only the pinned app build can change this setting."))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            if info?.agentOutdated == true, store.connection.isLive {
                // a LaunchAgent from before 2026-11-06 (KeepAlive true): a disabled setting under it would become a "start → exit" loop,
                // and the app couldn't be closed — the toggle is locked until the LaunchAgent is reinstalled
                Text(LaunchAgentHint.text(hub: store.state?.hub))
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if info == nil, store.connection.isLive {
                Text(tr("Служба хаба старше этой настройки — обновите хаб", "The hub service predates this setting — update the hub"))
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
