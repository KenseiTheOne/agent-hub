import AgentHubKit
import AppKit
import SwiftUI

/// The menu bar icon: a cop bot in a peaked cap (template), the emblem on the cap is the state color, when paused a "‖"
/// sign on the right, and next to it as text — "TEST" for a test copy and the number waiting (`MenuBarLook`). The icon tooltip is the state
/// (with a blocker and when paused) and the "TEST · <dir>" label for a test copy.
struct MenuBarLabel: View {
    let store: HubStore
    let router: PanelRouter
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openWindow) private var openWindow
    // @State in the macOS 27 SDK is a macro whose plugin (SwiftUIMacros) ships only with Xcode, not with the CLT.
    // So State storage is declared explicitly: the same property wrapper, without the macro.
    private let autoOpenStore = State(initialValue: false)
    private var didAutoOpen: Bool { get { autoOpenStore.wrappedValue } nonmutating set { autoOpenStore.wrappedValue = newValue } }

    var body: some View {
        let waiting = max(store.waitingCount, store.visibleCards.count)
        let idle = store.state?.idle
        let look = MenuBarLook.make(status: store.worstStatus, waiting: waiting, live: store.connection.isLive, estop: store.estop, idle: idle)
        let tip = look.tooltip(status: store.worstStatus, waiting: waiting, testMark: store.testMark, idle: idle,
                               culprit: MenuBarLook.culprit(store.state?.plugins ?? []))
        HStack(spacing: 3) {
            Image(nsImage: StatusImages.menuBarIcon(look: look, dark: scheme == .dark))
            // "TEST" for a test copy — right in the menu bar: next to the real one it must not look the same
            if let t = look.labelText(test: store.testMark != nil) { Text(t).monospacedDigit() }
        }
        .accessibilityLabel(tip)
        .help(tip)
        .onChange(of: tip, initial: true) { _, t in StatusItemTip.set(t) }
        .task {
            // openWindow exists only on a scene's view — hand it to the router (notifications, popover)
            router.openWindowAction = openWindow
            // `--open-panel`: open the panel right after launch (manual checks, screenshot)
            guard !didAutoOpen, LaunchOptions.current.openPanel else { return }
            didAutoOpen = true
            router.open(nil)
        }
    }
}

/// The menu bar icon tooltip. MenuBarExtra doesn't label its own button (`.help` on the label doesn't reach
/// it), so the tooltip is set on the NSStatusItem button directly — this application has just one.
@MainActor
enum StatusItemTip {
    private static var last: String?

    static func set(_ text: String) {
        last = text
        apply()
        // the button appears after the scene's first render
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { apply() }
    }

    private static func apply() {
        guard let text = last, let button = statusButton() else { return }
        if button.toolTip != text { button.toolTip = text }
    }

    static func statusButton() -> NSStatusBarButton? {
        for w in NSApp.windows where String(describing: type(of: w)).contains("StatusBar") {
            if let b = find(in: w.contentView) { return b }
        }
        return nil
    }

    private static func find(in v: NSView?) -> NSStatusBarButton? {
        guard let v else { return nil }
        if let b = v as? NSStatusBarButton { return b }
        for sub in v.subviews { if let b = find(in: sub) { return b } }
        return nil
    }

    /// For manual checks (`--print-status-tip`): what the button currently has.
    static var current: String? { statusButton()?.toolTip }
}

/// The menu bar popover (MenuBarExtra, .window style) per the approved prototype (Main.dc.html): glass, plugin
/// tiles, tile expansion, "Waiting for you" with an inline action, Panel / Session / Pause hub capsules.
struct PopoverView: View {
    static let width: CGFloat = 372

    let store: HubStore
    let router: PanelRouter
    private let openStore = State<String?>(initialValue: LaunchOptions.current.openTile)
    private var openTile: String? { get { openStore.wrappedValue } nonmutating set { openStore.wrappedValue = newValue } }
    // the same key as HubUpdatePopoverLine: whether there's a hub update row (for the "Updates" heading)
    private let hubDoneAck = AppStorage(wrappedValue: "", HubDefaults.key("hubUpdateDoneAck", socketPath: HubPaths.socketPath()))

    /// There's a hub or plugin update row — they get their own heading, otherwise they read as "Waiting for you" items.
    private var hasUpdateLines: Bool {
        if let info = store.hubUpdate, HubUpdateText.line(info, ackedDone: hubDoneAck.wrappedValue == HubUpdateText.doneKey(info)) != nil { return true }
        return PluginUpdateLine.make(store.pluginUpdates) != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            connectionLine
            // "Safe to shut down?" — above the tiles (mockup F)
            IdleVerdictCard(store: store, router: router)
            if let plugins = store.state?.pluginsByAttention, !plugins.isEmpty {
                Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                    ForEach(Array(stride(from: 0, to: plugins.count, by: 3)), id: \.self) { i in
                        GridRow {
                            ForEach(plugins[i..<min(i + 3, plugins.count)]) { p in tile(p) }
                            if plugins.count - i < 3 { ForEach(0..<(3 - (plugins.count - i)), id: \.self) { _ in Color.clear.frame(height: 1) } }
                        }
                    }
                }
                if let id = openTile, let p = store.plugin(id) { detail(p) }
            } else if store.state != nil {
                Text(tr("Плагинов нет — установите их в «Плагинах»", "No plugins — install some in Plugins"))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.62))
            }
            attention
            ownRequestLine
            // hub and plugin updates — in their own block with a heading: under "Waiting for you" they looked like its items, though
            // they aren't waiting for the user
            if hasUpdateLines {
                VStack(alignment: .leading, spacing: 8) {
                    Text(tr("Обновления", "Updates")).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.55)).padding(.horizontal, 4)
                    // "Details" on a failed update: Settings opens right on the "Hub updates" card (log, "Retry update")
                    HubUpdatePopoverLine(store: store, openSettings: { router.settingsFocus = SettingsView.Anchor.hubUpdate; router.open(.settings) })
                    updatesLine
                }
            }
            Rectangle().fill(Color.white.opacity(0.1)).frame(height: 0.5)
            capsules
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(width: Self.width)
        .environment(\.colorScheme, .dark)
        .background(GlassBackground(tint: hexColor(0x18181E, 0.74), radius: 18))
        .background(TransparentWindow(onWindow: { [router] w in router.popoverWindow = w }))
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 10) {
            AppLogo(size: 30)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text("Agent Hub").font(.system(size: 14, weight: .bold))
                    if let t = store.testMark { TestBadge(text: t) }
                }
                Text(updatedText).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
            }
            Spacer()
            Menu {
                Button(tr("Плагины…", "Plugins…")) { router.open(.manager) }
                Button(tr("Журнал…", "Log…")) { router.open(.journal) }
                Button(tr("Настройки…", "Settings…")) { router.open(.settings) }.keyboardShortcut(",")
                // disabled without a connection; refusals are gathered into one sheet (HubStore.refreshAll)
                // "Update" elsewhere in the interface means installing a new version; here it means polling again
                Button(tr("Опросить плагины заново", "Refresh all plugins")) {
                    Task { await store.refreshAll() }
                }
                .keyboardShortcut("r")
                .disabled(!store.connection.isLive)
                LanguageMenu(store: store)
                if !store.connection.isLive { Button(tr("Переподключиться", "Reconnect")) { store.reconnect() } }
                Divider()
                Button(tr("Выйти из Agent Hub", "Quit Agent Hub")) { NSApp.terminate(nil) }.keyboardShortcut("q")
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Color.white.opacity(0.10)))
            } primaryAction: {
                router.open(.manager)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .help(tr("Плагины (удерживайте — журнал, настройки, язык, выход)", "Plugins (hold for log, settings, language, quit)"))
        }
    }

    private var updatedText: String {
        switch store.connection {
        case .live:
            guard let t = store.lastEventAt else { return tr("хаб работает", "hub running") }
            let s = Int(Date().timeIntervalSince(t))
            if s < 20 { return tr("обновлено только что", "updated just now") }
            return s >= 60 ? tr("обновлено \(s / 60) мин назад", "updated \(s / 60) min ago") : tr("обновлено \(s) с назад", "updated \(s) s ago")
        case .connecting: return tr("подключаюсь…", "connecting…")
        case .offline: return tr("хаб не отвечает", "hub not responding")
        }
    }

    @ViewBuilder private var connectionLine: some View {
        if case .offline(let why) = store.connection {
            Label(store.daemonLaunch.offlineTitle, systemImage: "bolt.horizontal.circle")
                .font(.system(size: 11.5)).foregroundStyle(.orange).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                .help(store.daemonLaunch.offlineHint ?? why)
        }
        if store.estop {
            // wraps instead of truncating: when paused in an open popover the line would otherwise be cut off with an ellipsis
            Label(tr("Хаб на паузе — ответы, запуски и действия выключены", "Hub paused — replies, launches and actions are off"), systemImage: "pause.circle.fill")
                .font(.system(size: 11.5, weight: .medium)).foregroundStyle(hexColor(0xFFB3AD)).fixedSize(horizontal: false, vertical: true)
                .help(pauseHubHelp)
        }
    }

    // MARK: tiles

    private func tile(_ p: PluginState) -> some View {
        let on = openTile == p.id
        return Button {
            openTile = on ? nil : p.id
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top) {
                    Image(systemName: pluginSymbol(p)).font(.system(size: 15)).foregroundStyle(.white.opacity(0.8))
                    // `spark=` on the first header line: a mini sparkline between the icon and the status (the tile has
                    // no spare height under the value, so it takes the icon row)
                    if let spark = p.header.first(where: { !$0.separator })?.spark, !spark.isEmpty {
                        SparkBars(values: spark, avg: p.header.first(where: { !$0.separator })?.sparkAvg, highlight: pluginAccent(p), spacing: 1.5, radius: 1,
                                  fixedTop: p.header.first(where: { !$0.separator })?.sparkMax)
                            .frame(height: 16)
                            .padding(.horizontal, 3)
                    } else {
                        Spacer()
                    }
                    StatusGlyph(status: p.status, size: 15)
                }
                .padding(.bottom, 4)
                // `until=` on the first header line: the value counts down to the moment (G18)
                if let until = p.header.first(where: { !$0.separator })?.until {
                    CountdownText(until: until, font: .system(size: 15, weight: .bold)).tracking(-0.15).lineLimit(1)
                } else {
                    Text(p.tileValue).font(.system(size: 15, weight: .bold)).tracking(-0.15).lineLimit(1).minimumScaleFactor(0.7)
                        .reportsTruncation(p.tileValue, font: .system(size: 15, weight: .bold))
                }
                Text(p.tileLabel).font(.system(size: 11)).foregroundStyle(.white.opacity(0.62)).lineLimit(1).truncationMode(.tail)
                    .reportsTruncation(p.tileLabel, font: .system(size: 11))
            }
            .padding(10)
            .frame(maxWidth: .infinity, minHeight: 76, maxHeight: 76, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(on ? 0.16 : 0.07)))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(on ? 0.28 : 0.06), lineWidth: on ? 1 : 0.5))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .hoverHelp(PluginText.tileHelp(p))
    }

    /// Up to four top-level body lines for the tile's short detail. Controls (2026-11-12) show their value, not a bare
    /// label: a segment or popup — "Model: Opus 5.5" (its `selected=true` child), a switch — "Ultracode: off"; a table —
    /// its title. A label-only line right before a control group ("For new sessions") is skipped: alone it says nothing.
    /// `mono` — the line asked for `font=mono`.
    static func detailLines(_ body: [Item]) -> [(text: String, mono: Bool)] {
        var out: [(text: String, mono: Bool)] = []
        for (i, it) in body.enumerated() where !it.separator && it.level == 0 && it.params["size"] == nil {
            if it.isSegment || it.isSelect {
                var chosen: String?
                for c in body[(i + 1)...] {
                    if c.level == 0 { break }
                    if c.level == 1, c.isSelected { chosen = c.title; break }
                }
                out.append((chosen.map { "\(it.title): \($0)" } ?? it.title, it.isMono))
            } else if let on = it.toggleState {
                out.append(("\(it.title): \(on ? tr("вкл", "on") : tr("выкл", "off"))", it.isMono))
            } else if !it.isTable, it.offer == nil, it.stat == nil,
                      i + 1 < body.count, body[i + 1].level == 0, body[i + 1].isSegment || body[i + 1].isSelect || body[i + 1].toggleState != nil {
                continue
            } else {
                out.append((it.stat.map { "\($0): \(it.title)" } ?? it.title, it.isMono))
            }
            if out.count == 4 { break }
        }
        return out
    }

    /// Up to three offers of the plugin's header (G5): the same buttons as in the page header — same gate, confirmation
    /// and spinner. Fixed-height tiles have no room for them, so they live in the expanded detail card only.
    static func headerOffers(_ p: PluginState) -> [(item: Item, offer: Offer)] {
        Array(p.header.filter { !$0.separator }.compactMap { it in it.offer.map { (it, $0) } }.prefix(3))
    }

    private func detail(_ p: PluginState) -> some View {
        let offers = Self.headerOffers(p)
        return VStack(alignment: .leading, spacing: 8) {
            Button { router.open(.plugin(p.id)) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    let headFont = Font.system(size: 12, weight: .semibold, design: p.header.first(where: { !$0.separator })?.isMono == true ? .monospaced : .default)
                    Text(p.headline).font(headFont).lineLimit(2).multilineTextAlignment(.leading)
                        .reportsTruncation(p.headline, font: headFont)
                    ForEach(Array(Self.detailLines(p.body).enumerated()), id: \.offset) { _, line in
                        let font = Font.system(size: 12, design: line.mono ? .monospaced : .default)
                        Text(line.text).font(font).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                            .reportsTruncation(line.text, font: font)
                    }
                    if p.status == .error, let e = p.error {
                        Text(e).font(.system(size: 12)).foregroundStyle(hexColor(0xFF8A80)).lineLimit(1).reportsTruncation(e, font: .system(size: 12))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // the header and rows are truncated here (two lines and one) — the tooltip has the full text, then where a click leads
            .hoverHelp(PluginText.help(p.headline, tr("Открыть в панели", "Open in panel")))
            if !offers.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(offers.enumerated()), id: \.offset) { _, o in
                        OfferButton(store: store, item: o.item, offer: o.offer, style: CapsuleStyle(height: 24, expand: false), inlineInput: false)
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.22)))
    }

    // MARK: "Waiting for you" (in the prototype — "You're needed"; the interface uses the polite form everywhere)

    private struct Need: Identifiable {
        var id: String
        var status: HubStatus
        var question = false
        var title: String
        var sub: String
        var action: String
        var red: Bool
        var effort: String? = nil
        var ultracode = false
        var run: @MainActor () -> Void
    }

    private var needs: [Need] {
        var out: [Need] = []
        // plugin blockers first: they won't resolve without you
        for p in store.state?.pluginsByAttention ?? [] where p.status >= .block {
            let (title, sub) = p.attentionLines
            out.append(Need(id: "p:\(p.id)", status: p.status, title: title, sub: sub,
                            action: tr("Показать", "Show"), red: true, run: { router.open(.plugin(p.id)) }))
        }
        for c in store.visibleCards {
            let who = c.sessionName ?? String(c.sessionId.prefix(8))
            let age = c.age.map { " · \(Fmt.duration($0))" } ?? ""
            out.append(Need(id: "card:\(c.requestId)", status: .wait, question: c.kind == .question,
                            title: c.kind == .question ? tr("\(who) спрашивает", "\(who) asks") : tr("\(who) ждёт разрешения", "\(who) needs permission"),
                            sub: (c.kind == .question ? (c.questions.first?.header ?? tr("вопрос", "question")) : (c.summary ?? c.tool ?? tr("инструмент", "tool"))) + age,
                            action: tr("Ответить", "Reply"), red: false, run: { router.open(.sessions) }))
        }
        let carded = Set(store.visibleCards.map(\.sessionId))
        for s in store.sessions where s.isWaiting && !carded.contains(s.sessionId) {
            // "Go to tab" only if it works now (the terminal can switch, its bridge is up) — otherwise "Show": the panel says why
            let focusReq = store.isDemo(s) ? nil : store.focusRequest(sessionId: s.sessionId)
            let canFocus = focusReq != nil && store.canFocus(s)
            let lines = s.attentionLines
            out.append(Need(id: "s:\(s.sessionId)", status: .wait,
                            title: lines.title,
                            sub: lines.sub, action: canFocus ? tr("Перейти", "Go to tab") : tr("Показать", "Show"), red: false,
                            effort: s.effortLabel, ultracode: s.ultracode == true,
                            run: {
                                if canFocus, let req = focusReq {
                                    router.closePopover()
                                    Task { await store.perform(id: req.primitive, args: req.args, label: tr("Перейти во вкладку", "Switch to tab")) }
                                } else { router.open(.sessions) }
                            }))
        }
        return Array(out.prefix(5))
    }

    @ViewBuilder private var attention: some View {
        let list = needs
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(tr("Ждут вас", "Needs you")).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.55)).padding(.horizontal, 4).padding(.bottom, 2)
                ForEach(list) { n in
                    HStack(spacing: 10) {
                        StatusGlyph(status: n.status, size: 20, question: n.question)
                        VStack(alignment: .leading, spacing: 1) {
                            AttentionTitle(title: n.title, effort: n.effort, ultracode: n.ultracode)
                            // the gist (what's waiting, what failed) — up to two lines, like update rows: in Russian it doesn't fit on one
                            Text(n.sub).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        // the whole width between the icon and the button goes to the text column (not shared with a flexible capsule)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button(n.action) { n.run() }
                            .buttonStyle(PillStyle(fill: n.red ? Color(red: 1, green: 69 / 255, blue: 58 / 255).opacity(0.85) : hexColor(0x0A84FF)))
                    }
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
                }
            }
        }
    }

    // MARK: plugin updates

    /// "Update available: Mail 0.4.0" with "Update" — straight into the manager's update flow (the daemon's permissions sheet if permissions
    /// grow). Several — "Plugin updates: N", a row per plugin (the version is always visible, "more permissions" only for
    /// those that need them) and "Open" — the plugin manager, where each has its own "Update".
    /// A request for an own plugin from a folder (`agenthub plugins install --from`): only a human installs it — "Open" leads to
    /// Plugins, where the request has "Review and install".
    @ViewBuilder private var ownRequestLine: some View {
        let list = store.ownRequests
        if let first = list.first {
            HStack(spacing: 10) {
                Image(systemName: "folder.badge.plus").font(.system(size: 16)).foregroundStyle(hexColor(0xBF9BFF)).frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(list.count == 1 ? tr("Ждёт подтверждения: свой плагин «\(first.displayTitle)»", "Waiting for approval: your own plugin \"\(first.displayTitle)\"")
                                         : tr("Ждут подтверждения: свои плагины — \(list.count)", "Waiting for approval: \(list.count) own plugins"))
                        .font(.system(size: 12.5, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(tr("из папки \(first.shownPath)", "from folder \(first.shownPath)"))
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(1).truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(tr("Открыть", "Open")) { router.open(.manager) }
                    .buttonStyle(PillStyle(fill: hexColor(0xBF9BFF, 0.35)))
                    .help(tr("«Плагины» → «Проверить и установить»: окно согласия с правами", "Plugins → Review and install: the consent window with permissions"))
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
        }
    }

    @ViewBuilder private var updatesLine: some View {
        if let line = PluginUpdateLine.make(store.pluginUpdates) {
            let isApp = store.peer?.isApp ?? false
            HStack(alignment: line.single == nil ? .top : .center, spacing: 10) {
                Image(systemName: "arrow.down.circle.fill").font(.system(size: 18)).foregroundStyle(hexColor(0x4DA3FF)).frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    // wraps instead of truncating: the version at the end of the title must be visible
                    Text(line.title).font(.system(size: 12.5, weight: .semibold)).lineLimit(2).truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = line.detail {
                        Text(detail).font(.system(size: 11.5)).foregroundStyle(line.grows ? hexColor(0xFFC56B) : .white.opacity(0.55)).lineLimit(2).truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(line.rows) { r in
                        HStack(spacing: 4) {
                            Text(r.name).lineLimit(1).truncationMode(.tail)
                            Text(r.version).lineLimit(1).fixedSize()
                            if r.grows {
                                Text(PluginUpdateLine.growsLabel).lineLimit(1).fixedSize().foregroundStyle(hexColor(0xFFC56B))
                            }
                        }
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.62))
                    }
                    if line.more > 0 {
                        Text(PluginUpdateLine.moreLabel(line.more)).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.45))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(line.button) {
                    router.open(.manager)
                    if let id = line.single { Task { await store.install(id) } }
                }
                .buttonStyle(PillStyle(fill: line.grows ? hexColor(0xFF9F0A, 0.85) : line.single == nil ? Color.white.opacity(0.14) : hexColor(0x0A84FF)))
                .disabled(line.single != nil && (store.estop || !store.connection.isLive || store.registryBusy != nil || !isApp))
                .help(line.single == nil ? tr("Открыть «Плагины»: у каждого — своя кнопка «Обновить»", "Open Plugins: each one has its own Update button")
                      : store.estop ? tr("Хаб на паузе", "Hub is paused")
                      : !isApp ? tr("Только закреплённая сборка приложения", "Pinned app build only")
                      : tr("Обновить в «Плагинах» (при росте прав — окно прав)", "Update in Plugins (a permissions window if it asks for more)"))
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
        }
    }

    // MARK: capsules

    private var capsules: some View {
        HStack(spacing: 8) {
            Button { router.open(nil) } label: { Label(tr("Панель", "Panel"), systemImage: "sidebar.left") }
                .buttonStyle(CapsuleStyle())
                .keyboardShortcut("p")
            // like "New session" in the panel: the form opens even without the bridge (it shows how to start it)
            let launchBlock = store.gate(primitive: "session.launch", needsBridge: false)
            Button { router.open(.launch) } label: { Label(tr("Сессия", "Session"), systemImage: "plus") }
                .buttonStyle(CapsuleStyle())
                .disabled(launchBlock != nil)
                .help(launchBlock?.help ?? "")
            PauseHubButton(store: store)
        }
        .labelStyle(.titleAndIcon)
    }
}

/// The "Pause hub" / "Resume hub" button (internal name — ESTOP): one for the popover and the panel.
struct PauseHubButton: View {
    let store: HubStore
    var height: CGFloat = 32
    /// At the bottom edge of the sidebar card the shape is concentric with the card, not a capsule.
    var concentric = false

    var body: some View {
        if store.estop {
            // the daemon allows resuming only to the pinned build (cli — 403)
            Button { Task { await store.setEstop(false) } } label: { Label(tr("Снять паузу", "Resume hub"), systemImage: "play.fill") }
                .buttonStyle(CapsuleStyle(fill: Color(red: 1, green: 69 / 255, blue: 58 / 255).opacity(0.45), stroke: Color(red: 1, green: 120 / 255, blue: 110 / 255).opacity(0.5), text: .white, height: height, concentric: concentric))
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .disabled(!store.canAct)
                .help(store.canAct ? resumeHubHelp : ActionBlock.notPinned.help)
        } else {
            Button { Task { await store.setEstop(true) } } label: { Label(tr("Пауза хаба", "Pause hub"), systemImage: "pause.circle") }
                .buttonStyle(CapsuleStyle(fill: Color(red: 1, green: 69 / 255, blue: 58 / 255).opacity(0.16), stroke: Color(red: 1, green: 120 / 255, blue: 110 / 255).opacity(0.35), text: hexColor(0xFFB3AD), height: height, concentric: concentric))
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .disabled(!store.connection.isLive)
                .help(pauseHubHelp)
        }
    }
}

/// The "Language ▸ System / Русский / English" submenu: writes the daemon setting (pinned build only).
struct LanguageMenu: View {
    let store: HubStore

    var body: some View {
        Menu(tr("Язык", "Language")) {
            ForEach(LangSetting.allCases, id: \.self) { s in
                Button {
                    Task { await store.setLang(s) }
                } label: {
                    if L10n.shared.settingKnown, L10n.shared.setting == s { Label(LanguagePicker.title(s), systemImage: "checkmark") } else { Text(LanguagePicker.title(s)) }
                }
            }
        }
        .disabled(!store.canAct || !store.connection.isLive)
    }
}

/// Logo: the same cop bot in a peaked cap as in the menu bar, white on a 160° indigo gradient (the tile from the mockup).
/// Without resources — the old outline cube.
struct AppLogo: View {
    var size: CGFloat = 30

    var body: some View {
        Group {
            if let glyph = MenuBarArt.glyph {
                Image(nsImage: glyph).renderingMode(.template).resizable().interpolation(.high)
                    .frame(width: size * 0.78, height: size * 0.78)
                    .foregroundStyle(.white)
            } else {
                Image(systemName: "cube").font(.system(size: size * 0.57, weight: .medium)).foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .background(RoundedRectangle(cornerRadius: size * 0.27).fill(LinearGradient(colors: [hexColor(0x5E5CE6), hexColor(0x2F2CB8)], startPoint: UnitPoint(x: 0.33, y: 0), endPoint: UnitPoint(x: 0.67, y: 1))))
        .overlay(RoundedRectangle(cornerRadius: size * 0.27).strokeBorder(Color.white.opacity(0.3), lineWidth: 0.5))
    }
}

/// The test copy label "TEST · /tmp/ahl": a yellow capsule, so it isn't confused with the real hub.
struct TestBadge: View {
    let text: String
    var size: CGFloat = 10.5

    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .heavy, design: .rounded))
            .foregroundStyle(.black)
            .lineLimit(1).truncationMode(.middle)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(hexColor(0xFFD60A)))
            .help(tr("Тестовая копия: оболочка подключена не к хабу по умолчанию, а к \(text.components(separatedBy: " · ").last ?? "")",
                     "Test copy: this app is connected to a hub other than the default one: \(text.components(separatedBy: " · ").last ?? "")"))
    }
}

/// The prototype's glass: blur of the window behind + a dark translucent tint. With `radius` — its own shape and a 0.5
/// white .18 stroke (popover); without it (panel) — the whole window, no own frame: edge and radius are the system's.
struct GlassBackground: View {
    var tint: Color
    var radius: CGFloat? = nil

    var body: some View {
        let glass = ZStack {
            VisualEffect(material: .hudWindow)
            tint
            // the prototype's dark tinted glass (there it sits over a dark desk with colored blobs): a slight
            // cool-warm sheen, so on a light desk the glass doesn't come out flat grey
            LinearGradient(colors: [hexColor(0x1D3046, 0.35), hexColor(0x452941, 0.30)], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
        if let radius {
            glass
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5))
        } else {
            glass
        }
    }
}

struct VisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = .active
        // the glass is always dark, as in the prototype — on the light macOS theme too
        v.appearance = NSAppearance(named: .darkAqua)
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) { v.material = material }
}

/// A host window without its own background: SwiftUI draws the glass itself (MenuBarExtra popover and the screenshot window).
/// `onWindow` — get the window (the popover hands it to the router to close it before opening another window).
struct TransparentWindow: NSViewRepresentable {
    var onWindow: ((NSWindow) -> Void)? = nil

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            guard let w = v.window else { return }
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = true
            w.contentView?.wantsLayer = true
            w.contentView?.superview?.wantsLayer = true
            // tooltips (HoverTip) — even when the app is inactive: the popover is viewed over another application
            w.allowsToolTipsWhenApplicationIsInactive = true
            onWindow?(w)
        }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// The panel window: transparent, no title, with an empty toolbar in the unified style. The empty toolbar gives
/// the macOS 26 system window radius (26 pt, like the prototype) and lowers the traffic lights to (19, 19): they end up inside
/// the sidebar card with the same margin as the menu items (`PanelMetrics`). SwiftUI draws the backing across the whole window,
/// without its own frame or rounding — the system rounds the corners itself.
struct PanelChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = FrameAutosaveGuard()
        DispatchQueue.main.async {
            guard let w = v.window else { return }
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = true
            if w.toolbar == nil {
                let tb = NSToolbar(identifier: "agenthub.panel")
                tb.displayMode = .iconOnly
                w.toolbar = tb
            }
            w.toolbarStyle = .unified
            w.titleVisibility = .hidden
            w.titlebarAppearsTransparent = true
            w.styleMask.insert(.fullSizeContentView)
            // tooltips (HoverTip) in an inactive app too: the panel is usually viewed while working in a terminal — without this
            // AppKit doesn't show tooltips until you click the window
            w.allowsToolTipsWhenApplicationIsInactive = true
        }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// The panel window frame is remembered only by the live directory without --panel-width/--panel-height: "NSWindow Frame panel" is in the shared
/// bundle domain, and a test copy or a snapshot run would otherwise change the live hub's panel size. SwiftUI sets the window's
/// autosave name again (e.g. when showing a sheet), so it's removed on those window events too.
final class FrameAutosaveGuard: NSView {
    private var tokens: [NSObjectProtocol] = []

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        tokens.forEach { NotificationCenter.default.removeObserver($0) }
        tokens = []
        guard let w = window, !HubDefaults.autosavesPanelFrame() else { return }
        Self.clear(w)
        let names: [Notification.Name] = [NSWindow.willBeginSheetNotification, NSWindow.didEndSheetNotification, NSWindow.didBecomeKeyNotification,
                                          NSWindow.willStartLiveResizeNotification, NSWindow.didUpdateNotification]
        for n in names {
            tokens.append(NotificationCenter.default.addObserver(forName: n, object: w, queue: .main) { [weak w] _ in
                MainActor.assumeIsolated { if let w { Self.clear(w) } }
            })
        }
    }

    @MainActor private static func clear(_ w: NSWindow) {
        if !w.frameAutosaveName.isEmpty { w.setFrameAutosaveName("") }
    }

    // observers are removed in viewDidMoveToWindow (window is nil when the view leaves the window)
}

/// The "Waiting for you" row title: the full name first, the effort capsule only in the remaining space. If the pair
/// "xhigh + ⚡ultracode" doesn't fit — one capsule remains; if that doesn't fit either — just the name (only it is truncated, with no gap).
struct AttentionTitle: View {
    let title: String
    let effort: String?
    let ultracode: Bool

    var body: some View {
        let name = Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        if effort == nil && !ultracode {
            // no capsule — the title gets two lines ("Demo — build is waiting for permission" doesn't fit on one in Russian)
            Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { name.fixedSize(); EffortBadge(effort: effort, ultracode: ultracode, compact: true) }
                if effort != nil && ultracode {
                    HStack(spacing: 6) { name.fixedSize(); EffortBadge(effort: effort, compact: true) }
                }
                name
            }
        }
    }
}
