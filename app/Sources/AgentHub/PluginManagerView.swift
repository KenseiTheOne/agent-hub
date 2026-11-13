import AgentHubKit
import AppKit
import SwiftUI

/// Plugin manager (docs/plugins-registry.md) following the Consent.dc.html prototype: installed plugins (built-in, from
/// the registry, `Plugins/local`) and the catalog from the signed `index.json`. Install and update go through the permissions window
/// from the daemon (428 → consent by token). The daemon decides everything; here — clear states: registry not connected,
/// catalog loading, network or signature error, empty.
struct PluginManagerView: View {
    let store: HubStore

    private enum Tab: Hashable { case installed, catalog }
    private let tabStore = State(initialValue: LaunchOptions.current.managerCatalog ? Tab.catalog : Tab.installed)
    private var tab: Tab { get { tabStore.wrappedValue } nonmutating set { tabStore.wrappedValue = newValue } }
    private let autoFetchedStore = State(initialValue: false)
    private var autoFetched: Bool { get { autoFetchedStore.wrappedValue } nonmutating set { autoFetchedStore.wrappedValue = newValue } }

    private var catalog: RegistryCatalog? { store.catalog }
    /// The tab as a segment index — via the State storage's projectedValue (written from a Binding closure).
    private var tabIndex: Binding<Int> {
        let t = tabStore.projectedValue
        return Binding(get: { t.wrappedValue == .installed ? 0 : 1 }, set: { t.wrappedValue = $0 == 0 ? .installed : .catalog })
    }
    private var isApp: Bool { store.peer?.isApp ?? false }
    /// Width of the catalog area: it determines one or two columns of cards.
    private let catalogWidthStore = State<CGFloat>(initialValue: 1000)
    private var catalogWidth: CGFloat { get { catalogWidthStore.wrappedValue } nonmutating set { catalogWidthStore.wrappedValue = newValue } }
    /// The catalog width from which cards go into two columns (measured 2026-11-05: a row of update buttons with permission growth
    /// fits into a card from ~760 pt; the margin is for long version names and EN/RU).
    static let twoColumnMinWidth: CGFloat = 780

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    banners
                    switch tab {
                    case .installed: installedList
                    case .catalog: catalogArea
                    }
                }
                .padding(.horizontal, 20).padding(.bottom, 20)
            }
        }
        .task {
            await store.loadRegistry()
            if tab == .catalog { autoFetch() }
        }
        .onChange(of: tab) { _, t in if t == .catalog { autoFetch() } }
    }

    /// The catalog has never been loaded, the registry is connected, we are the pinned build: load on first visit.
    private func autoFetch() {
        guard !autoFetched, let c = catalog, c.configured, c.generatedAt == nil, store.fetchError == nil, isApp else { return }
        autoFetched = true
        Task { await store.fetchCatalog() }
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 10) {
            HStack {
                Text(tr("Плагины", "Plugins")).font(.system(size: 17, weight: .bold)).fixedSize()
                Spacer(minLength: 8)
                Button(tr("Добавить из папки…", "Add from folder…")) { pickFolder() }
                    .buttonStyle(CapsuleStyle(height: 28, expand: false))
                    .fixedSize()
                    .disabled(store.registryBusy != nil || store.estop || !isApp)
                    .help(store.estop ? tr("Хаб на паузе", "Hub is paused")
                          : !isApp ? tr("Только закреплённая сборка приложения", "Pinned app build only")
                          : tr("Свой плагин из локальной папки (например, <репозиторий>/agenthub/<id>): проверю её и покажу окно согласия",
                               "Your own plugin from a local folder (e.g. <repository>/agenthub/<id>): I'll check it and show the consent window"))
            }
            .frame(maxWidth: .infinity)
            SegmentCapsule(selection: tabIndex,
                           titles: [tr("Установленные", "Installed"), tr("Каталог", "Catalog")])
                .fixedSize()
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if catalog?.verified == true {
                    Label(tr("индекс реестра подписан", "registry index signed"), systemImage: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1).fixedSize()
                        .foregroundStyle(hexColor(0x7EE29B))
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Capsule().fill(Color(red: 48 / 255, green: 209 / 255, blue: 88 / 255).opacity(0.14)))
                        .help(catalog?.generatedAt.map { tr("Каталог собран \($0.prefix(10)), подпись проверена ключом реестра", "Catalog built \($0.prefix(10)), signature checked with the registry key") } ?? "")
                }
                if catalog?.configured == true {
                    Button { Task { await store.fetchCatalog() } } label: {
                        if store.fetching { ProgressView().controlSize(.small).frame(width: 28, height: 28) }
                        else {
                            Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .semibold))
                                .frame(width: 28, height: 28).background(Circle().fill(Color.white.opacity(0.1)))
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(store.registryBusy != nil || !isApp)
                    .help(isApp ? tr("Обновить каталог: скачать index.json и проверить подпись", "Refresh catalog: download index.json and check its signature")
                                : tr("Обновлять каталог может только закреплённая сборка приложения", "Only the pinned app build can refresh the catalog"))
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: registry states

    @ViewBuilder private var banners: some View {
        ownRequestsList
        // daemon extensions from <home>/Extensions (G4): approved here, like own plugins
        ExtensionsSection(store: store)
        if let e = store.registryError {
            Notice(color: .orange, icon: "exclamationmark.triangle", title: e)
        }
        if store.peer != nil, !isApp {
            Notice(color: .yellow, icon: "lock", title: tr("Ставить, обновлять и удалять плагины может только закреплённая сборка приложения", "Only the pinned app build can install, update or remove plugins"),
                   detail: PinAdvice.shared.openPinned)
        }
        if store.estop {
            Notice(color: .red, icon: "pause.circle", title: tr("Хаб на паузе — установка и обновление плагинов выключены", "Hub paused — installing and updating plugins is off"))
        }
        if let c = catalog, !c.configured {
            NotConnected(catalog: c, builtin: (store.state?.plugins ?? []).filter { $0.tier == .builtin }.map(\.title), recheck: { Task { await store.loadRegistry() } })
        } else if let code = store.fetchError ?? catalog?.error {
            Notice(color: .red, icon: "xmark.octagon", title: Explain.text(code: code, status: 0, label: tr("Каталог", "Catalog")), detail: tr("Код: \(code)", "Code: \(code)"),
                   actionTitle: isApp ? tr("Повторить", "Retry") : nil, onAction: retryFetch)
        }
    }

    private func retryFetch() { Task { await store.fetchCatalog() } }

    /// Folder picker — the system dialog (outside the button handler, like the other modal windows), then the request and the consent
    /// window from the daemon.
    private func pickFolder() {
        Task { @MainActor in
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.prompt = tr("Выбрать", "Choose")
            panel.message = tr("Папка плагина (<id> с файлом <id>.<интервал>.<расширение>) или репозиторий с agenthub/<id>",
                               "The plugin folder (<id> with <id>.<interval>.<ext>) or a repository with agenthub/<id>")
            NSApp.activate(ignoringOtherApps: true)
            guard panel.runModal() == .OK, let url = panel.url else { return }
            await store.addFromFolder(url.path)
        }
    }

    // MARK: own plugin requests

    /// Requests from the terminal or scripts (`agenthub plugins install --from`): only a human can install them, here.
    @ViewBuilder private var ownRequestsList: some View {
        let list = store.ownRequests
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(tr("Ждут подтверждения", "Waiting for your approval")).font(.system(size: 13, weight: .semibold))
                ForEach(list) { q in ownRequestRow(q) }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(hexColor(0xBF9BFF, 0.12)))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(hexColor(0xBF9BFF, 0.35), lineWidth: 0.5))
        }
    }

    private func ownRequestRow(_ q: OwnRequest) -> some View {
        HStack(alignment: .top, spacing: 12) {
            PluginTile(id: q.id, size: 36, radius: 10, icon: q.icon)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(q.displayTitle).font(.system(size: 13, weight: .semibold))
                    if let v = q.version { Text(v).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)) }
                }
                Text(tr("из папки \(q.shownPath)", "from folder \(q.shownPath)"))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.62)).lineLimit(1).truncationMode(.middle)
                    .help(q.path ?? "")
                if let m = q.migrate {
                    Text(m.text(title: q.displayTitle)).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            Button(tr("Проверить и установить", "Review and install")) { Task { @MainActor in await store.approveOwn(q.requestId, title: q.displayTitle) } }
                .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 28, expand: false))
                .fixedSize()
                .disabled(store.registryBusy != nil || store.estop || !isApp)
                .help(store.estop ? tr("Хаб на паузе", "Hub is paused") : !isApp ? tr("Только закреплённая сборка приложения", "Pinned app build only")
                      : tr("Покажу окно согласия: папка, версия, отпечаток содержимого, права", "Shows the consent window: folder, version, contents fingerprint, permissions"))
            Button(tr("Отклонить", "Decline")) { Task { await store.declineOwn(q.requestId) } }
                .buttonStyle(CapsuleStyle(height: 28, expand: false))
                .fixedSize()
                .disabled(store.registryBusy != nil || !isApp)
        }
    }

    // MARK: installed

    private struct Row: Identifiable {
        var id: String
        var title: String
        var desc: String
        var version: String?
        var tier: PluginTier
        var sfimage: String?
        var update: CatalogPlugin?
        var officialPending = false
        var note: String?
        var permissions: [PluginPermission]
        /// Own plugin: the folder and its state.
        var own: OwnSourceInfo? = nil
        /// The registry it came from, only when several exist (G19).
        var registry: String? = nil
        var removable: Bool { tier.removable }
    }

    private var rows: [Row] {
        var out: [Row] = []
        let cat = Dictionary((catalog?.plugins ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for p in store.state?.plugins ?? [] where p.tier == .builtin {
            out.append(Row(id: p.id, title: p.title, desc: p.desc ?? "", version: p.version, tier: .builtin, sfimage: p.header.first?.sfImage,
                           permissions: []))
        }
        for i in store.installed?.installed ?? [] {
            let live = store.plugin(i.id)
            let c = cat[i.id]
            out.append(Row(id: i.id, title: live?.title ?? c?.displayTitle ?? i.title ?? i.id, desc: live?.desc ?? c?.desc ?? "",
                           version: i.version, tier: i.officialPending ? .official : (live?.tier ?? i.tier), sfimage: live?.header.first?.sfImage,
                           update: c?.updateKind != nil ? c : nil, officialPending: i.officialPending,
                           note: i.disabled.map { tr("Заблокирован реестром: \($0)", "Blocked by the registry: \($0)") } ?? i.own?.statusText ?? (live == nil ? tr("не запущен", "not running") : nil),
                           permissions: i.permissions, own: i.own, registry: i.registryLabel ?? live?.registryLabel))
        }
        for l in store.installed?.local ?? [] {
            let live = store.plugin(l.id)
            out.append(Row(id: l.id, title: live?.title ?? l.id, desc: tr("Локальный (для разработки): может только открывать ссылки и файлы", "Local (development): can only open links and files"),
                           version: l.version, tier: .local, sfimage: "hammer",
                           note: l.disabled.map { tr("Заблокирован реестром: \($0)", "Blocked by the registry: \($0)") }, permissions: l.permissions))
        }
        return out
    }

    @ViewBuilder private var installedList: some View {
        let list = rows
        if list.isEmpty {
            Text(tr("Плагинов нет", "No plugins")).foregroundStyle(.secondary).padding(.top, 20)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, r in
                    if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                    row(r)
                }
            }
            .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
        }
        if catalog?.configured == false {
            Text(tr("Официальные плагины ставятся из каталога — после подключения реестра они появятся во вкладке «Каталог». Свой плагин из папки — «Добавить из папки…».",
                    "Official plugins are installed from the catalog — once the registry is connected they appear in the Catalog tab. Your own plugin from a folder — Add from folder…."))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
        }
    }

    private func row(_ r: Row) -> some View {
        HStack(spacing: 12) {
            PluginTile(id: r.id, sfimage: r.sfimage, size: 36, radius: 10)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(r.title).font(.system(size: 13, weight: .semibold))
                    TierBadge(tier: r.tier, pending: r.officialPending, path: r.own?.shownPath, fullPath: r.own?.path, registry: r.registry)
                    if let v = r.version { Text(v).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)) }
                }
                if !r.desc.isEmpty { Text(r.desc).font(.system(size: 12)).foregroundStyle(.white.opacity(0.62)).lineLimit(1) }
                if let n = r.note {
                    Text(n).font(.system(size: 11.5)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        .help(r.own?.errors.joined(separator: "\n") ?? "")
                }
            }
            Spacer(minLength: 8)
            if let u = r.update { updateButton(u) }
            if r.own?.status == "update" { ownUpdateButton(r) }
            if !r.permissions.isEmpty || r.tier != .builtin {
                // the modal window runs outside the button handler (Task): inside it SwiftUI does not deliver clicks to the window
                Button(tr("Права", "Permissions")) { Task { @MainActor in PermissionsWindow.show(title: r.title, id: r.id, tier: r.tier, permissions: r.permissions) } }
                    .buttonStyle(CapsuleStyle(height: 28, expand: false))
            }
            if r.removable {
                Button(tr("Удалить", "Remove")) { confirmRemove(r.id, title: r.title) }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(hexColor(0xFF8A80))
                    .disabled(store.registryBusy != nil || !isApp)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
    }

    /// Own plugin: the folder has a new version with new permissions — the consent window (the daemon takes it from the folder).
    private func ownUpdateButton(_ r: Row) -> some View {
        Button(tr("Обновить", "Update") + " · " + PluginUpdateLine.growsLabel) { Task { await store.install(r.id) } }
            .buttonStyle(CapsuleStyle(fill: hexColor(0xFF9F0A, 0.2), stroke: hexColor(0xFF9F0A, 0.45), text: hexColor(0xFFC56B), height: 28, expand: false))
            .fixedSize()
            .disabled(store.registryBusy != nil || store.estop || !isApp)
            .help(tr("Новая версия из папки просит больше прав — покажу окно прав", "The new version in the folder asks for more permissions — you'll see the permissions window"))
    }

    /// The removal window is started from a Task, not directly in the button handler: a modal loop started inside
    /// a SwiftUI button action did not receive clicks (live check 2026-11-05 — "Remove" could not be pressed).
    private func confirmRemove(_ id: String, title: String) {
        Task { @MainActor in
            guard let purge = RemoveWindow.ask(title: title, id: id) else { return }
            await store.remove(id, purge: purge)
        }
    }

    // MARK: catalog

    @ViewBuilder private var catalogArea: some View {
        // several registries (G19): one status line each — its error or when it was fetched
        if let c = catalog, c.multiRegistry {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(c.registries) { r in
                    Label(r.statusLine, systemImage: r.error != nil ? "exclamationmark.triangle" : r.configured ? "checkmark.seal" : "questionmark.circle")
                        .font(.system(size: 11.5))
                        .foregroundStyle(r.error != nil ? hexColor(0xFFC56B) : .white.opacity(0.6))
                        .lineLimit(2)
                        .help(r.tierLabel ?? "")
                }
                if !c.shadowed.isEmpty {
                    Text(tr("Скрыты как дубли: ", "Hidden as duplicates: ") + c.shadowed.map { "\($0.id) (\($0.registry) → \($0.by))" }.joined(separator: ", "))
                        .font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        if let c = catalog, c.configured {
            if store.fetching {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(tr("Загружаю каталог и проверяю подпись…", "Loading the catalog and checking its signature…")).foregroundStyle(.secondary)
                }
                .padding(.top, 30).frame(maxWidth: .infinity)
            } else if c.generatedAt == nil, store.fetchError ?? c.error != nil {
                // loading has just failed — the banner with the reason and "Retry" is above; no second call to action
                EmptyView()
            } else if c.generatedAt == nil {
                VStack(spacing: 10) {
                    Image(systemName: "shippingbox").font(.system(size: 28)).foregroundStyle(.secondary)
                    Text(tr("Каталог ещё не загружен", "The catalog isn't loaded yet")).font(.system(size: 14, weight: .semibold))
                    Button(tr("Загрузить", "Load")) { Task { await store.fetchCatalog() } }
                        .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 30, expand: false))
                        .disabled(!isApp || store.registryBusy != nil)
                }
                .padding(.top, 30).frame(maxWidth: .infinity)
            } else if c.plugins.isEmpty {
                Text(tr("В каталоге пока нет плагинов", "No plugins in the catalog yet")).foregroundStyle(.secondary).padding(.top, 30).frame(maxWidth: .infinity)
            } else {
                // Grid, not LazyVGrid: cards in one row have the same height, as in the mockup. Two columns only when
                // a card has room for the installed plugin's button row ("Update to X" + "Remove"): in a narrow
                // window (panel from 960 pt) — one column, otherwise the buttons pushed the Grid past the scroll edge.
                let cols = catalogWidth >= Self.twoColumnMinWidth ? 2 : 1
                Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                    ForEach(Array(stride(from: 0, to: c.plugins.count, by: cols)), id: \.self) { i in
                        GridRow(alignment: .top) {
                            catalogCard(c.plugins[i])
                            if cols == 2 {
                                if i + 1 < c.plugins.count { catalogCard(c.plugins[i + 1]) } else { Color.clear.gridCellUnsizedAxes([.horizontal, .vertical]) }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { catalogWidth = $0 }
                Text(tr("Плагины сообщества показывают статусы, открывают ссылки и файлы, переводят во вкладку и запускают свои команды — каждая с подтверждением. Одобрять, останавливать и запускать агентов умеют только встроенные, официальные и свои (из вашей папки).",
                        "Community plugins show statuses, open links and files, switch to a tab and run their own commands — each one asks you first. Only built-in, official and your own plugins (from your folder) can approve, stop or launch agents."))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
            }
        } else if catalog == nil {
            HStack(spacing: 10) { ProgressView().controlSize(.small); Text(tr("Загружаю…", "Loading…")).foregroundStyle(.secondary) }
                .padding(.top, 30).frame(maxWidth: .infinity)
        }
    }

    private func catalogCard(_ p: CatalogPlugin) -> some View {
        HStack(alignment: .top, spacing: 14) {
            PluginTile(id: p.id, size: 52, radius: 14, icon: p.icon).shadow(color: .black.opacity(0.35), radius: 6, y: 3)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(p.displayTitle).font(.system(size: 14, weight: .bold))
                    Text(p.version).font(.system(size: 12)).foregroundStyle(.secondary)
                    // the registry name joins the tier label only when several registries exist (registryLabel non-nil)
                    if let reg = p.registryLabel { TierBadge(tier: p.tier, registry: reg, note: p.capped ? RegistryText.cappedHelp : nil) }
                    else if p.tier == .official { TierBadge(tier: .official) }
                }
                if let a = p.author { AuthorLine(author: a) }
                if let d = p.desc { Text(d).font(.system(size: 12)).lineSpacing(3).fixedSize(horizontal: false, vertical: true) }
                ForEach(p.requires, id: \.name) { req in RequirementLine(requirement: req) }
                Text(permSummary(p)).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                catalogButton(p).padding(.top, 4)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5))
    }

    private func permSummary(_ p: CatalogPlugin) -> String {
        var seen = Set<String>()
        return p.permissions.map(\.shortKindLabel).filter { seen.insert($0).inserted }.joined(separator: " · ")
    }

    @ViewBuilder private func catalogButton(_ p: CatalogPlugin) -> some View {
        if p.builtin {
            Text(tr("встроен в приложение", "built into the app")).font(.system(size: 11.5)).foregroundStyle(.secondary)
        } else if let own = p.installedOwn, let inst = p.installed {
            // an own plugin with this id is installed: the catalog does not update it; getting the catalog plugin back is only explicit, via the window
            // marked "Will replace your own … from the folder" (removal — under "Installed")
            VStack(alignment: .leading, spacing: 6) {
                Text(tr("Установлен свой \(inst) · \(own.shown)", "Your own \(inst) is installed · \(own.shown)"))
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xBF9BFF)).lineLimit(2).truncationMode(.middle)
                    .help(tr("Каталог его не обновляет: обновления приходят из папки", "The catalog doesn't update it: updates come from the folder"))
                if p.blocked == nil, p.platformOk {
                    Button(tr("Вернуть из каталога", "Install from catalog")) { Task { await store.install(p.id, fromRegistry: true) } }
                        .buttonStyle(CapsuleStyle(height: 28, expand: false))
                        .fixedSize()
                        .disabled(store.registryBusy != nil || store.estop || !isApp)
                        .help(store.estop ? tr("Хаб на паузе", "Hub is paused") : !isApp ? tr("Только закреплённая сборка приложения", "Pinned app build only")
                              : tr("Заменит свой плагин плагином \(p.version) из каталога — сначала окно согласия", "Replaces your own plugin with \(p.version) from the catalog — consent window first"))
                }
            }
        } else if let inst = p.installed {
            // installed: "Installed" (and the version if the catalog has another), "Update to X" for a newer version,
            // "Roll back to X" for an older one, "Remove" — the same confirmation window as in the installed list.
            // Blocked by the registry — the reason and "Remove" (updating to a blocked version is not allowed).
            VStack(alignment: .leading, spacing: 6) {
                if let b = p.blocked {
                    Text(tr("Заблокирован реестром: \(b)", "Blocked by the registry: \(b)")).font(.system(size: 11.5)).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let kind = p.updateKind {
                    Text(installedNote(inst, older: kind.isRollback, grows: p.updateGrows))
                        .font(.system(size: 11.5)).foregroundStyle(p.updateGrows ? hexColor(0xFFC56B) : .white.opacity(0.55))
                        .fixedSize(horizontal: false, vertical: true)
                }
                // the row does not fit (narrow card, long label) — buttons stacked, not past the card edge
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { installedButtons(p) }
                    VStack(alignment: .leading, spacing: 6) { installedButtons(p) }
                }
            }
        } else if let b = p.blocked {
            Text(tr("Заблокирован реестром: \(b)", "Blocked by the registry: \(b)")).font(.system(size: 11.5)).foregroundStyle(.red)
        } else if let need = p.needsHubText {
            // the plugin needs a newer contract than this hub has: not installable — a clear line instead of a linter refusal
            Text(need).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
        } else if !p.platformOk {
            Text(tr("не для этой системы", "not for this system")).font(.system(size: 11.5)).foregroundStyle(.secondary)
        } else {
            // a declared dependency is missing — the button is dimmed (installing is still possible) and a hint says what is missing
            let missing = p.missingRequirements.first
            VStack(alignment: .leading, spacing: 4) {
                Button(tr("Установить", "Install")) { Task { await store.install(p.id) } }
                    .buttonStyle(CapsuleStyle(fill: missing == nil ? hexColor(0x0A84FF) : Color.white.opacity(0.1), stroke: missing == nil ? .clear : Color.white.opacity(0.18),
                                              text: missing == nil ? .white : .white.opacity(0.6), height: 28, expand: false))
                    .disabled(store.registryBusy != nil || store.estop || !isApp)
                    .help(store.estop ? tr("Хаб на паузе", "Hub is paused") : !isApp ? tr("Только закреплённая сборка приложения", "Pinned app build only") : missing?.missingHint ?? "")
                if let m = missing {
                    Text(m.missingHint).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// "Installed version X" above the buttons; with permission growth — "… · the new one asks for more permissions" (the daemon will show
    /// the permissions window), on a rollback — "… · older in the catalog".
    private func installedNote(_ inst: String, older: Bool, grows: Bool) -> String {
        var s = tr("Установлена версия \(inst)", "Installed: \(inst)")
        if older { s += tr(" · в каталоге более старая", " · the catalog has an older one") }
        if grows { s += " · " + PluginUpdateLine.growsLabel }
        return s
    }

    @ViewBuilder private func installedButtons(_ p: CatalogPlugin) -> some View {
        if p.blocked == nil, p.updateKind != nil, p.needsHub == nil {
            updateButton(p, growsInLabel: false).fixedSize()
        } else if p.blocked == nil, p.updateKind != nil, let need = p.needsHubText {
            Text(tr("Новая версия: нужен хаб новее", "New version: needs a newer hub")).font(.system(size: 12, weight: .semibold)).fixedSize()
                .foregroundStyle(hexColor(0xFFC56B))
                .padding(.horizontal, 14).frame(height: 28).background(Capsule().fill(Color.white.opacity(0.1)))
                .help(need)
        } else {
            Text(tr("Установлен", "Installed")).font(.system(size: 12, weight: .semibold)).fixedSize()
                .padding(.horizontal, 14).frame(height: 28).background(Capsule().fill(Color.white.opacity(0.1)))
        }
        Button(tr("Удалить", "Remove")) { confirmRemove(p.id, title: p.displayTitle) }
            .buttonStyle(CapsuleStyle(fill: hexColor(0xFF453A, 0.16), stroke: hexColor(0xFF453A, 0.35), text: hexColor(0xFF8A80), height: 28, expand: false))
            .fixedSize()
            // in the catalog — like the other catalog buttons: disabled while the hub is paused and without a pinned build
            // (decision 2026-11-05; in the installed list removal is still available while paused — the daemon allows it)
            .disabled(store.registryBusy != nil || store.estop || !isApp)
            .help(store.estop ? tr("Хаб на паузе", "Hub is paused")
                  : !isApp ? tr("Только закреплённая сборка приложения", "Pinned app build only")
                  : tr("Удалить плагин (данные — по выбору в окне)", "Remove the plugin (its data — your choice in the dialog)"))
    }

    /// "Update to X", "Update" (the archive of the same version was rebuilt) or "Roll back to X" (the catalog version is older
    /// than the installed one — a confirmation window first). With permission growth — orange; `growsInLabel` — append
    /// "new permissions" to the button itself (installed list; in a catalog card this is a line above the buttons).
    /// The daemon will show the permissions window (428), as on install.
    private func updateButton(_ p: CatalogPlugin, growsInLabel: Bool = true) -> some View {
        let grows = p.updateGrows
        let kind = p.updateKind ?? .rebuild
        let base: String = switch kind {
        case .newer(let v): tr("Обновить до \(v)", "Update to \(v)")
        case .older(let v): tr("Откатить до \(v)", "Roll back to \(v)")
        case .rebuild: tr("Обновить", "Update")
        }
        return Button(grows && growsInLabel ? base + " · " + PluginUpdateLine.growsLabel : base) {
            Task { @MainActor in
                // rollback — only after an explicit "Roll back" (the window runs outside the button handler, like removal)
                if case .older(let v) = kind, !RollbackAlert.ask(title: p.displayTitle, from: p.installed ?? "?", to: v) { return }
                await store.install(p.id)
            }
        }
            // rollback — a calm grey capsule (no inviting blue), permission growth — orange, update — blue
            .buttonStyle(CapsuleStyle(fill: grows ? hexColor(0xFF9F0A, 0.2) : kind.isRollback ? Color.white.opacity(0.1) : hexColor(0x0A84FF),
                                      stroke: grows ? hexColor(0xFF9F0A, 0.45) : kind.isRollback ? Color.white.opacity(0.18) : .clear,
                                      text: grows ? hexColor(0xFFC56B) : .white, height: 28, expand: false))
            .disabled(store.registryBusy != nil || store.estop || !isApp)
            .help(store.estop ? tr("Хаб на паузе", "Hub is paused")
                  : !isApp ? tr("Только закреплённая сборка приложения", "Pinned app build only")
                  : grows ? tr("Новая версия просит больше прав — покажу окно прав", "The new version asks for more permissions — you'll see the permissions window")
                  : kind == .rebuild ? tr("Архив той же версии в реестре пересобран", "The registry rebuilt the archive of the same version") : "")
    }
}

/// "Registry not connected": what it gives, what is missing and how to connect. The command uses the full CLI path (agenthub
/// is not on PATH) and AGENTHUB_HOME if the hub is not in the default directory; the daemon picks up the setting without
/// a restart — "Check again" re-reads the state.
struct NotConnected: View {
    let catalog: RegistryCatalog
    /// Titles of the built-in plugins from the state: the note names them without the shell knowing any plugin.
    var builtin: [String] = []
    var recheck: () -> Void = {}
    private let openStore = State(initialValue: true)
    private var open: Bool { get { openStore.wrappedValue } nonmutating set { openStore.wrappedValue = newValue } }

    var command: String {
        catalog.connectCommand(url: tr("<адрес index.json>", "<index.json URL>"), key: tr("<файл ключа .pub>", "<key file .pub>"))
    }

    private var missingURL: Bool { catalog.missing.contains("index-url") }
    private var missingKey: Bool { catalog.missing.contains("public-key") }

    private var title: String {
        if missingURL && missingKey { return tr("Каталог плагинов не подключён — хаб не знает, откуда брать плагины", "Plugin catalog isn't connected — the hub doesn't know where to get plugins") }
        if missingURL { return tr("Каталог плагинов подключён не до конца — нет адреса каталога", "Plugin catalog is half set up — the catalog address is missing") }
        return tr("Каталог плагинов подключён не до конца — нечем проверить подпись", "Plugin catalog is half set up — there's no key to check its signature")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "shippingbox").font(.system(size: 13, weight: .semibold))
            Text(RegistryText.worksWithout(builtin: builtin))
                .font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
            Text(missingText).font(.system(size: 12)).foregroundStyle(.orange)
            DisclosureGroup(isExpanded: Binding(get: { open }, set: { open = $0 })) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(tr("1. Выполните в Терминале (адрес каталога и файл открытого ключа — от владельца реестра):",
                            "1. Run this in Terminal (the catalog address and public key file come from the registry owner):"))
                        .font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack(alignment: .top) {
                        Text(command).font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 6)
                        Button(tr("Скопировать", "Copy")) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(command, forType: .string)
                        }
                        .buttonStyle(CapsuleStyle(height: 24, expand: false))
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.25)))
                    HStack(spacing: 8) {
                        Text(tr("2. Хаб подхватит настройку сам, перезапускать не нужно.", "2. The hub picks it up by itself — no restart needed."))
                            .font(.system(size: 11.5)).foregroundStyle(.secondary)
                        Spacer(minLength: 6)
                        Button(tr("Проверить снова", "Check again"), action: recheck).buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 24, expand: false))
                    }
                }
                .padding(.top, 4)
            } label: {
                Text(tr("Как подключить", "How to connect")).font(.system(size: 12, weight: .semibold))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5))
    }

    private var missingText: String {
        if missingURL && missingKey { return tr("Не хватает адреса каталога и открытого ключа, которым хаб проверяет подпись.", "Missing the catalog address and the public key the hub checks signatures with.") }
        if missingURL { return tr("Ключ подписи есть, не хватает адреса каталога (services.plugins.indexUrl).", "The signing key is set; the catalog address (services.plugins.indexUrl) is missing.") }
        return tr("Адрес каталога есть, не хватает открытого ключа подписи (services.plugins.publicKey).", "The catalog address is set; the public signing key (services.plugins.publicKey) is missing.")
    }
}

/// "Requires <program>" in a catalog card: the plugin declares the name and the link (`<agenthub.requires>`); whether it is present on
/// this Mac is checked by the daemon at the declared path.
struct RequirementLine: View {
    let requirement: PluginRequirement

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: requirement.present ? "checkmark.circle" : "exclamationmark.circle")
                .foregroundStyle(requirement.present ? hexColor(0x7EE29B) : hexColor(0xFFC56B))
            if let url = requirement.link {
                Link(requirement.label, destination: url).foregroundStyle(hexColor(0x6CB4FF))
            } else {
                Text(requirement.label)
            }
            Text(requirement.present ? tr("· установлен", "· installed") : tr("· не найден на этом Mac", "· not found on this Mac"))
                .foregroundStyle(.white.opacity(0.5))
        }
        .font(.system(size: 11.5, weight: .semibold))
        .help([requirement.note, requirement.check.map { tr("Проверяю: \($0)", "Checking: \($0)") }].compactMap { $0 }.joined(separator: "\n"))
    }
}

/// Plugin author: the name, then the GitHub login as a profile link.
struct AuthorLine: View {
    let author: PluginAuthor

    var body: some View {
        HStack(spacing: 4) {
            if let n = author.name { Text(n).foregroundStyle(.white.opacity(0.7)) }
            if author.name != nil && author.github != nil { Text("·").foregroundStyle(.white.opacity(0.4)) }
            if let g = author.github {
                if let url = author.profileURL {
                    Link("@\(g)", destination: url).foregroundStyle(hexColor(0x6CB4FF))
                        .help(tr("Профиль автора на GitHub", "Author's GitHub profile"))
                } else {
                    Text("@\(g)").foregroundStyle(.white.opacity(0.7))
                }
            }
        }
        .font(.system(size: 11.5))
    }
}

/// State banner above the list: a colored icon, text, a detail and a button.
struct Notice: View {
    let color: Color
    let icon: String
    let title: String
    var detail: String? = nil
    var actionTitle: String? = nil
    var onAction: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(color).font(.system(size: 14, weight: .semibold))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12.5, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                if let detail { Text(detail).font(.system(size: 11.5)).foregroundStyle(.secondary).textSelection(.enabled) }
            }
            Spacer(minLength: 6)
            if let actionTitle, let onAction {
                Button(actionTitle, action: onAction).buttonStyle(CapsuleStyle(fill: .white, stroke: .clear, text: .black, height: 26, expand: false))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(color.opacity(0.14)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(color.opacity(0.3), lineWidth: 0.5))
    }
}

/// The prototype's capsule switch: background white .08, stroke .12, selected segment white .20 with a shadow, h28.
struct SegmentCapsule: View {
    @Binding var selection: Int
    let titles: [String]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(titles.enumerated()), id: \.offset) { i, t in
                Button { selection = i } label: {
                    Text(t).font(.system(size: 12, weight: .semibold))
                        .padding(.horizontal, 14).frame(height: 24)
                        .background(Capsule().fill(Color.white.opacity(selection == i ? 0.20 : 0)).shadow(color: .black.opacity(selection == i ? 0.3 : 0), radius: 2, y: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == i ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Capsule().fill(Color.white.opacity(0.08)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
    }
}

/// Plugin tier badge (the daemon decides the tier: install location and the registry's signed index).
struct TierBadge: View {
    let tier: PluginTier
    var pending = false
    /// Own plugin: the folder path for the "own · <path>" label (with "~") and the full one for the tooltip.
    var path: String? = nil
    var fullPath: String? = nil
    /// The registry name (only when several registries exist): "official · corp".
    var registry: String? = nil
    /// An extra tooltip line (a registry that caps its entries at community).
    var note: String? = nil

    var body: some View {
        Text(text)
            .font(.system(size: 10.5, weight: .bold)).foregroundStyle(color)
            .lineLimit(1).truncationMode(.middle)
            .padding(.horizontal, 7).padding(.vertical, 1.5)
            .background(Capsule().fill(color.opacity(0.18)))
            // an own plugin's path is truncated in the middle only if the row lacks room; other labels — in full
            .fixedSize(horizontal: path == nil, vertical: false)
            .help(help)
    }

    private var text: String {
        if pending { return tr("официальный · доступно обновление", "official · update available") }
        if tier == .own, let path { return tier.label + " · " + path }
        return tier.label + (registry.map { " · " + $0 } ?? "")
    }

    private var help: String {
        if pending {
            return tr("Установлена не та сборка, что в подписанном каталоге: до обновления плагин работает с правами плагина сообщества (каждая своя команда — с подтверждением, уведомления — только по проверенным правилам).",
                      "The installed build differs from the signed catalog: until you update, the plugin runs with community permissions (each own command asks first, notifications only by reviewed rules).")
        }
        if tier == .own {
            return tr("Свой плагин: вы сами подтвердили его установку из папки \(fullPath ?? path ?? "?"). Работает копия; правки без новых прав хаб ставит сам.",
                      "Your own plugin: you approved installing it from \(fullPath ?? path ?? "?"). A copy runs; edits without new permissions install by themselves.")
        }
        if let registry { return [RegistryText.from(registry), note].compactMap { $0 }.joined(separator: "\n") }
        return ""
    }

    private var color: Color {
        if pending { return .orange }
        switch tier {
        case .builtin: return hexColor(0x6CB4FF)
        case .official: return hexColor(0x7EE29B)
        case .own: return hexColor(0xBF9BFF)
        case .community: return .secondary
        case .local: return .orange
        }
    }
}

/// A loud permission line: a write to a location used to hijack Claude Code or the system (contract 3).
struct RiskLine: View {
    let title: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(hexColor(0xFF6961))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 12, weight: .bold)).foregroundStyle(hexColor(0xFF8A80))
                    .fixedSize(horizontal: false, vertical: true)
                Text(text).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(hexColor(0xFF453A, 0.18)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(hexColor(0xFF453A, 0.55), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// Permission list (permissions window and "Permissions"): a kind tile, the kind and "what" on a line, "why" below; "new" — only on growth.
struct ConsentList: View {
    let permissions: [PluginPermission]
    var markAdded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(PluginPermission.byWeight(permissions, addedFirst: markAdded).enumerated()), id: \.offset) { i, p in
                if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: symbol(p.kind)).foregroundStyle(.white).font(.system(size: 12, weight: .semibold))
                        .frame(width: 28, height: 28).background(RoundedRectangle(cornerRadius: 8).fill(color(p.kind)))
                    // the permission kind, then "what and why" in plain words, below — the technical entry in small type
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(p.kindLabel).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
                            if markAdded && p.added {
                                Text(tr("новое", "new")).font(.system(size: 10.5, weight: .bold)).foregroundStyle(.black)
                                    .padding(.horizontal, 6).padding(.vertical, 1).background(Capsule().fill(hexColor(0xFF9F0A)))
                            }
                        }
                        Text(p.plainText ?? tr("зачем — не указано", "why — not stated"))
                            .font(.system(size: 12.5, weight: .medium)).foregroundStyle(p.plainText == nil ? .red : .white)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(p.technical).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.45))
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        // hijack location (contract 3) — a separate loud line: what it means
                        if let w = p.riskWarning { RiskLine(title: w.title, text: w.text).padding(.top, 5) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 9).padding(.horizontal, 12)
                .background(p.risk != nil ? hexColor(0xFF453A, 0.12) : markAdded && p.added ? hexColor(0xFF9F0A, 0.1) : .clear)
            }
        }
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.black.opacity(0.22)))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private func symbol(_ k: String) -> String {
        switch k {
        case "net": return "globe"
        case "secrets": return "key"
        case "effects", "actions": return "arrow.up.forward.square"
        case "push": return "bell.badge"
        case "exec": return "terminal"
        case "terminal": return "keyboard"
        case "fsWrite": return "square.and.pencil"
        case "watch": return "eye"
        default: return "folder"
        }
    }

    private func color(_ k: String) -> Color {
        switch k {
        case "net": return hexColor(0x0A84FF)
        case "secrets": return hexColor(0xBF5AF2)
        case "effects", "actions": return hexColor(0x30D158)
        case "push": return hexColor(0xFF375F)
        case "exec": return hexColor(0x8E8E93)
        case "terminal": return hexColor(0xFF6482)
        case "fsWrite": return hexColor(0xFF453A)
        default: return hexColor(0xFF9F0A)
        }
    }
}
