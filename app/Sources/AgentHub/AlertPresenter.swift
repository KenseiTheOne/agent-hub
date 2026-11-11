import AgentHubKit
import AppKit
import SwiftUI

/// Confirmations and refusals. The confirmation text and cost are written by the **core** (428 reply, in the hub language); the shell
/// doesn't change them, doesn't decide whether confirmation is needed, and only passes the human's consent via a token.
/// The permissions window and plugin removal are custom modal windows following the prototype (Consent.dc.html), the rest is NSAlert.
@MainActor
final class AlertPresenter: ConfirmPresenter {
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = request.level == .confirmCost ? .critical : .warning
        alert.messageText = request.title
            ?? (request.level == .confirmCost
                ? tr("Подтвердите: действие тратит квоту или выходит в сеть", "Confirm: this uses quota or the network")
                : tr("Подтвердите действие", "Confirm the action"))
        var info = request.text
        if let cost = request.cost, !cost.isEmpty { info += "\n\n" + tr("Чем это обойдётся: ", "Cost: ") + cost }
        if let ms = request.expiresInMs { info += "\n\n" + tr("Подтверждение действует \(ms / 1000) с", "Valid for \(ms / 1000) s") }
        alert.informativeText = info
        // "Details" (tag, commit) — small grey text under the main text: visible, but not competing with it
        if let d = request.details, !d.isEmpty {
            let field = NSTextField(wrappingLabelWithString: tr("Подробности: ", "Details: ") + d)
            field.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
            field.textColor = .secondaryLabelColor
            field.isSelectable = true
            field.preferredMaxLayoutWidth = 300
            field.frame = NSRect(origin: .zero, size: field.fittingSize)
            alert.accessoryView = field
        }
        // the button is the action itself ("Update") if the shell named it; for core confirmations — "Run"
        alert.addButton(withTitle: request.button ?? tr("Выполнить", "Run"))
        let cancel = alert.addButton(withTitle: tr("Отмена", "Cancel"))
        cancel.keyEquivalent = "\u{1b}"
        // default (Return) is "Run" only for a regular confirmation; for a cost — no default button
        if request.level == .confirmCost { alert.buttons.first?.keyEquivalent = "" }
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// Plugin permissions window: a list with "why"; "new" only on the increment during an update (the daemon decides).
    func consent(_ request: ConsentRequest) async -> Bool {
        ModalWindow.run(width: 520) { done in ConsentSheet(request: request, done: done) }
    }

    func report(title: String, detail: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: tr("Понятно", "OK"))
        alert.runModal()
    }
}

/// A modal window with SwiftUI content and the prototype's glass. `done(true/false)` closes it.
@MainActor
enum ModalWindow {
    static func run<V: View>(width: CGFloat, @ViewBuilder content: (@escaping (Bool) -> Void) -> V) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        var result = false
        let panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
        let finish: (Bool) -> Void = { ok in
            result = ok
            NSApp.stopModal()
        }
        // Esc closes the window as "Cancel" (removal, permissions, install permissions window)
        panel.onCancel = { finish(false) }
        let root = content(finish)
            .frame(width: width)
            .environment(\.colorScheme, .dark)
            .background(GlassBackground(tint: hexColor(0x282830, 0.84), radius: 26))
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        panel.contentView = host
        panel.setContentSize(host.fittingSize)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .modalPanel
        panel.isMovableByWindowBackground = true
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.runModal(for: panel)
        panel.orderOut(nil)
        return result
    }
}

/// A borderless window that accepts the keyboard (Esc, Return, text fields). `onCancel` — Esc (`cancelOperation`):
/// in modal windows it's "Cancel", even if the cancel button has its own Return or the focus is on a checkbox.
final class KeyPanel: NSPanel {
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func cancelOperation(_ sender: Any?) {
        if let onCancel { onCancel() } else { super.cancelOperation(sender) }
    }
}

/// Permissions window: "Install "X"?", signature and sha256, permissions, a warning for community, "Cancel" / "Install".
struct ConsentSheet: View {
    let request: ConsentRequest
    let done: (Bool) -> Void
    /// The permissions list was scrolled to the end (or fit entirely): only then can the human agree.
    private let seenStore = State(initialValue: false)
    private var seenAll: Bool { get { seenStore.wrappedValue } nonmutating set { seenStore.wrappedValue = newValue } }
    /// The list doesn't fit and must be scrolled — then a "Scroll — more permissions below" line appears under it.
    private let scrollStore = State(initialValue: false)
    private var needsScroll: Bool { get { scrollStore.wrappedValue } nonmutating set { scrollStore.wrappedValue = newValue } }

    private var name: String { request.title ?? request.id }
    private var grows: Bool { request.addedCount > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                PluginTile(id: request.id, size: 52, radius: 14, icon: request.icon)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 16, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                    // where it's installed from: the registry (signature and sha256) or an own folder (path and content fingerprint)
                    Text((request.source ?? ConsentSource(kind: "registry")).line)
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .lineLimit(2).truncationMode(.middle).fixedSize(horizontal: false, vertical: true)
                        .help(request.source?.path ?? "")
                }
            }
            if let m = request.migrate {
                OwnNoticeBox(icon: m.from == "catalog" ? "exclamationmark.triangle.fill" : "arrow.triangle.swap", color: hexColor(0xFF9F0A),
                             text: m.text(title: name, toRegistry: !request.isOwn))
            }
            if let src = request.source, src.isOwn {
                VStack(alignment: .leading, spacing: 4) {
                    Text(src.path ?? src.shownPath).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.6))
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text(src.writableNote).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.7)).fixedSize(horizontal: false, vertical: true)
                    // writable by the group (umask 002): allowed, but as loud as a takeover location
                    if let w = src.riskWarning { RiskLine(title: w.title, text: w.text).padding(.top, 2) }
                    if request.changedSinceRequest {
                        Text(tr("Содержимое папки сменилось после заявки — в окне то, что будет установлено сейчас.", "The folder changed after the request — this window shows what will be installed now."))
                            .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                // for an own plugin the registry reviewer is you: what a reviewer would check (immediate actions, push
                // rules "regardless of switches") — is here
                if !src.warnings.isEmpty {
                    OwnNoticeBox(icon: "eye.trianglebadge.exclamationmark", color: hexColor(0xFFD60A),
                                 text: tr("Проверьте сами — у своего плагина нет ревьюера реестра:", "Check this yourself — your own plugin has no registry reviewer:")
                                     + "\n" + src.warnings.prefix(6).map { "• " + $0 }.joined(separator: "\n"))
                }
            }
            // the total permission count is visible before scrolling; the most significant ones (own buttons, running programs, writing) are on top
            Text(PluginPermission.summary(request.permissions)).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                ConsentList(permissions: request.permissions, markAdded: request.update)
            }
            .scrollIndicators(.visible)
            .frame(maxHeight: 420)
            .fixedSize(horizontal: false, vertical: true)
            .onScrollGeometryChange(for: Bool.self) { g in
                g.contentSize.height <= g.containerSize.height + 1 || g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 8
            } action: { _, atEnd in
                if atEnd { seenAll = true }
            }
            .onScrollGeometryChange(for: Bool.self) { g in g.contentSize.height > g.containerSize.height + 1 } action: { _, more in
                if more { needsScroll = true }
            }
            // the banner is on its own line under the list, not over it: over it, it covered the last visible permission and the path.
            // The space for it is kept after scrolling too (transparent) — the buttons under the list don't jump.
            if needsScroll {
                HStack {
                    Spacer()
                    Label(tr("Прокрутите — ниже ещё права", "Scroll — more permissions below"), systemImage: "chevron.down")
                        .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.black)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Capsule().fill(hexColor(0xFFD60A)))
                    Spacer()
                }
                .opacity(seenAll ? 0 : 1)
                .accessibilityHidden(seenAll)
                .allowsHitTesting(false)
            }
            Text(note).font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if request.tier == .community {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(hexColor(0xFF9F0A))
                    Text(tr("Код стороннего автора работает с вашими правами пользователя. Хаб не даст ему управлять агентами, но изолировать сам процесс не может.",
                            "Third-party code runs with your user permissions. The hub won't let it control agents, but it can't sandbox the process itself."))
                        .font(.system(size: 12)).foregroundStyle(hexColor(0xFFD9A0)).fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14).fill(hexColor(0xFF9F0A, 0.14)))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(hexColor(0xFF9F0A, 0.35), lineWidth: 0.5))
            }
            HStack(spacing: 10) {
                Spacer()
                Button(tr("Отмена", "Cancel")) { done(false) }
                    .buttonStyle(CapsuleStyle(height: 32, expand: false))
                    .keyboardShortcut(.cancelAction)
                Button(primary) { done(true) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false))
                    .disabled(!seenAll)
                    .help(seenAll ? "" : tr("Сначала просмотрите все права — прокрутите список до конца", "Review all permissions first — scroll to the end of the list"))
            }
        }
        .padding(20)
    }

    private var title: String {
        let v = request.version ?? ""
        if request.isOwn, request.migrate != nil { return tr("Поставить свой «\(name)» \(v) из папки?", "Install your own \"\(name)\" \(v) from the folder?") }
        if request.isOwn, !request.update { return tr("Установить свой плагин «\(name)» \(v)?", "Install your own plugin \"\(name)\" \(v)?") }
        if request.update {
            return grows ? tr("«\(name)» \(v) просит больше прав", "\"\(name)\" \(v) asks for more permissions") : tr("Обновить «\(name)» до \(v)?", "Update \"\(name)\" to \(v)?")
        }
        return tr("Установить «\(name)»?", "Install \"\(name)\"?")
    }

    private var primary: String {
        if request.migrate != nil { return tr("Заменить", "Replace") }
        return request.update ? (grows ? tr("Согласиться и обновить", "Agree and update") : tr("Обновить", "Update")) : tr("Установить", "Install")
    }

    private var note: String {
        var s = tr("Плагин получит только эти права — хаб не даст ему больше.", "The plugin gets only these permissions — the hub won't grant more.")
        if grows { s += " " + tr("Новых прав: \(request.addedCount) — они отмечены.", "New permissions: \(request.addedCount) — they're marked.") }
        if let ms = request.expiresInMs { s += " " + tr("Согласие действует \(ms / 1000) с.", "Consent is valid for \(ms / 1000) s.") }
        return s
    }
}

/// A banner in the consent window (switch etc.): icon, text.
struct OwnNoticeBox: View {
    let icon: String
    let color: Color
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).foregroundStyle(color)
            Text(text).font(.system(size: 12)).foregroundStyle(.white.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(color.opacity(0.14)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(color.opacity(0.35), lineWidth: 0.5))
    }
}

/// Plugin removal: human-readable text without file names, "Delete" is not the default, the data checkbox is unchecked.
/// A custom window rather than NSAlert: on macOS 26 the NSAlert suppression checkbox state read as "on" even with the box
/// unchecked (live check 2026-11-05 — purge: true with an empty box).
@MainActor
enum RemoveWindow {
    /// → nil — cancel; otherwise purge.
    static func ask(title: String, id: String = "") -> Bool? {
        let box = PurgeBox()
        let ok = ModalWindow.run(width: 420) { done in RemoveSheet(title: title, id: id, box: box, done: done) }
        return ok ? box.purge : nil
    }
}

/// Plugin rollback: the catalog version is older than the installed one (the daemon flags an update by the archive sha256, and the registry
/// may have reissued an old release). "Roll back" is not the default.
@MainActor
enum RollbackAlert {
    static func ask(title: String, from: String, to: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = tr("Откатить «\(title)» до \(to)?", "Roll \"\(title)\" back to \(to)?")
        alert.informativeText = tr("Установлена версия \(from), а в каталоге реестра — более старая \(to). Так бывает, когда реестр отзывает выпуск. Плагин будет заменён версией \(to); его данные сохранятся.",
                                   "Version \(from) is installed, and the registry catalog has an older \(to). This happens when the registry withdraws a release. The plugin will be replaced with \(to); its data is kept.")
        alert.addButton(withTitle: tr("Откатить", "Roll back")).keyEquivalent = ""
        let cancel = alert.addButton(withTitle: tr("Отмена", "Cancel"))
        cancel.keyEquivalent = "\r"
        return alert.runModal() == .alertFirstButtonReturn
    }
}

@MainActor
final class PurgeBox: ObservableObject {
    @Published var purge = false
}

struct RemoveSheet: View {
    let title: String
    let id: String
    @ObservedObject var box: PurgeBox
    let done: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                PluginTile(id: id, size: 44, radius: 12)
                Text(tr("Удалить «\(title)»?", "Remove \"\(title)\"?")).font(.system(size: 16, weight: .bold))
            }
            Text(tr("Плагин и его кэш будут удалены. Его данные (настройки, история) сохранятся, если не отметить ниже.",
                    "The plugin and its cache will be removed. Its data (settings, history) is kept unless you check below."))
                .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
            Toggle(tr("Удалить и данные плагина", "Also remove the plugin's data"), isOn: $box.purge).toggleStyle(.checkbox).font(.system(size: 12.5))
            HStack(spacing: 10) {
                Spacer()
                Button(tr("Удалить", "Remove")) { done(true) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0xFF453A, 0.2), stroke: hexColor(0xFF453A, 0.4), text: hexColor(0xFF8A80), height: 32, expand: false))
                Button(tr("Отмена", "Cancel")) { done(false) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
    }
}

/// "Permissions" of an installed plugin: what was granted (view only).
@MainActor
enum PermissionsWindow {
    static func show(title: String, id: String, tier: PluginTier, permissions: [PluginPermission]) {
        _ = ModalWindow.run(width: 520) { done in
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    PluginTile(id: id, size: 44, radius: 12)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tr("Права «\(title)»", "\"\(title)\" permissions")).font(.system(size: 16, weight: .bold))
                        Text(subtitle(tier: tier, empty: permissions.isEmpty))
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                if !permissions.isEmpty {
                    ScrollView { ConsentList(permissions: permissions, markAdded: false) }.frame(maxHeight: 320).fixedSize(horizontal: false, vertical: true)
                }
                HStack { Spacer(); Button(tr("Готово", "Done")) { done(true) }.buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false)).keyboardShortcut(.defaultAction) }
            }
            .padding(20)
        }
    }

    /// Subtitle by plugin tier (decided by the daemon), not by an empty list: a local plugin without permissions
    /// is not a built-in one.
    static func subtitle(tier: PluginTier, empty: Bool) -> String {
        switch tier {
        case .builtin: return tr("Встроенный плагин — часть приложения", "Built-in plugin — part of the app")
        case .local:
            return empty ? tr("Локальный плагин (Plugins/local) не запрашивал прав", "Local plugin (Plugins/local) asked for no permissions")
                         : tr("Локальный плагин (Plugins/local): права из его метаданных, реестр их не проверял", "Local plugin (Plugins/local): permissions from its metadata, not checked by the registry")
        case .official, .community:
            return empty ? tr("Плагин не запрашивал прав", "The plugin asked for no permissions") : tr("Согласованы при установке", "Agreed at installation")
        case .own:
            return empty ? tr("Свой плагин из папки не запрашивал прав", "Your own plugin from a folder asked for no permissions")
                         : tr("Свой плагин из папки: права согласованы при установке", "Your own plugin from a folder: permissions agreed at installation")
        }
    }
}
