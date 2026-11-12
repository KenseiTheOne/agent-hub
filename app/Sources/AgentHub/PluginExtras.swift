import AgentHubKit
import AppKit
import SwiftUI

// Plugin page additions of contract 3 (core gaps, 2026-11-12): an inline field for immediate input actions (G1), running
// background jobs with "Stop" (G6), the plugin's keys with "Set key…" (G8) and the `until=` countdown (G18).

// MARK: - typed input (G1)

/// An immediate action with `input`: a text field and a send button in place of the capsule. The checks the core makes
/// (one line, no leading "-", at most `maxLength`) are shown under the field before sending; the core's own refusal
/// (its pattern) comes back as a sheet with the field (HubStore.performInput).
struct OfferInputField: View {
    let store: HubStore
    let item: Item
    let offer: Offer
    let spec: OfferInput
    /// The typed text lives in the store by offer id (HubStore.inputDrafts): a refresh that shifts the rows above recreates
    /// this view, and its own state would be lost with it.
    private var text: String { get { store.inputDraft(offer.id) } nonmutating set { store.setInputDraft(offer.id, newValue) } }
    private var textBinding: Binding<String> { Binding(get: { store.inputDraft(offer.id) }, set: { store.setInputDraft(offer.id, $0) }) }
    /// The field takes the keyboard only when the human asks for it — a click on it or Tab — never by itself: when the panel
    /// window becomes key (reopened, back from another app) AppKit and SwiftUI hand the keyboard to the first text field,
    /// and typing meant for nothing in particular would land in a plugin action. `armed` — the human picked the field.
    private let focus = FocusState<Bool>()
    private let armedState = State(initialValue: false)
    private var armed: Bool { get { armedState.wrappedValue } nonmutating set { armedState.wrappedValue = newValue } }

    private var block: ActionBlock? { store.gate(offer: offer) }
    private var problem: String? {
        // an empty field is just not ready yet — no red text for it
        guard !text.isEmpty, let code = InputCheck.code(text, maxLength: spec.maxLength) else { return nil }
        return InputCheck.message(code, maxLength: spec.maxLength)
    }
    private var canSend: Bool { !text.isEmpty && problem == nil && block == nil && store.busyAction == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if let sym = item.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                    Image(systemName: sym).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                }
                TextField(spec.placeholder ?? item.title, text: textBinding)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                    .frame(minWidth: 140, maxWidth: 360)
                    .onSubmit(send)
                    .disabled(block != nil)
                    .accessibilityLabel(item.title)
                    .focused(focus.projectedValue)
                    .onChange(of: focus.wrappedValue) { _, now in
                        if !now { armed = false; return }
                        if armed || FieldFocus.isKeyboardMove(NSApp.currentEvent) { armed = true } else { focus.wrappedValue = false }
                    }
                    // until picked, a click lands here first: it arms the field and gives it the keyboard
                    .overlay {
                        if !armed && block == nil {
                            Color.clear.contentShape(Rectangle())
                                .onTapGesture { armed = true; focus.wrappedValue = true }
                                .onHover { inside in (inside ? NSCursor.iBeam : NSCursor.arrow).set() }
                        }
                    }
                Button(action: send) {
                    HStack(spacing: 5) {
                        Text(item.title)
                        if store.busyAction == offer.id { ProgressView().controlSize(.mini) }
                    }
                }
                .buttonStyle(CapsuleStyle(height: 26, expand: false))
                .disabled(!canSend)
                .help(block.map { BridgeText.help($0, primitive: offer.primitive, store) } ?? (offer.background ? JobsText.backgroundHelp : (offer.label ?? item.title)))
                if offer.background { BackgroundMark() }
            }
            if let p = problem {
                Text(p).font(.system(size: 11)).foregroundStyle(hexColor(0xFF8A80)).fixedSize(horizontal: false, vertical: true)
            } else if let c = InputCheck.counter(text, maxLength: spec.maxLength) {
                Text(c).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).monospacedDigit()
            }
        }
    }

    private func send() {
        guard canSend else { return }
        let value = text
        Task {
            if await store.perform(offer: offer, label: item.title, input: value), text == value { text = "" }
        }
    }
}

/// Why a text field got the keyboard: the human moving it (Tab, Shift-Tab) or the window handing it out by itself.
enum FieldFocus {
    static func isKeyboardMove(_ event: NSEvent?) -> Bool {
        guard let event, event.type == .keyDown else { return false }
        return event.keyCode == 48 // Tab (with or without Shift)
    }
}

/// A small mark after a button that starts a background job.
struct BackgroundMark: View {
    var body: some View {
        Image(systemName: "hourglass").font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.5))
            .help(JobsText.backgroundHelp)
            .accessibilityLabel(JobsText.backgroundHelp)
    }
}

// MARK: - background jobs (G6)

/// "Running in the background": the plugin's jobs with the elapsed time and "Stop". One TimelineView for the whole card
/// (a tick per second only while jobs exist).
struct PluginJobsCard: View {
    let store: HubStore
    let plugin: PluginState

    private var block: ActionBlock? { store.gate(primitive: "job.cancel", needsBridge: false) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(JobsText.header).font(.system(size: 13, weight: .semibold))
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(plugin.jobs) { job in row(job, now: ctx.date) }
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
    }

    private func row(_ job: PluginJob, now: Date) -> some View {
        let title = job.title ?? plugin.actions.first { $0.id == job.actionId }?.title ?? job.actionId ?? job.id
        return HStack(spacing: 8) {
            Image(systemName: "gearshape.2").font(.system(size: 12)).foregroundStyle(pluginAccent(plugin))
            Text(title).font(.system(size: 12.5)).lineLimit(1).reportsTruncation(title, font: .system(size: 12.5))
            Text(JobsText.elapsed(since: job.startDate, now: now)).font(.system(size: 12)).monospacedDigit().foregroundStyle(.white.opacity(0.55))
            Spacer(minLength: 8)
            Button {
                Task { await store.cancelJob(job) }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "stop.fill").font(.system(size: 9))
                    Text(JobsText.stop)
                    if store.busyAction == "job.cancel" { ProgressView().controlSize(.mini) }
                }
            }
            .buttonStyle(CapsuleStyle(height: 24, expand: false))
            .disabled(block != nil || store.busyAction != nil)
            .help(block.map { BridgeText.help($0, primitive: "job.cancel", store) } ?? tr("Остановить задачу (SIGTERM, через 2 с — SIGKILL)", "Stop the job (SIGTERM, SIGKILL after 2 s)"))
        }
    }
}

// MARK: - plugin keys (G8)

/// "Keys": the keys the plugin declares (`<agenthub.secrets>`) with their state; "Set key…" opens a sheet with a secure
/// field, "Remove" asks first. Loaded when the page opens and on `secrets.changed`; no answer (an unpinned copy, no
/// service) or no declared keys — no section.
struct PluginSecretsCard: View {
    let store: HubStore
    let pluginId: String

    var body: some View {
        // a VStack, not a Group: an empty Group has no view to hang `.task` on, so the keys would never load
        VStack(spacing: 0) {
            if let list = store.secrets[pluginId], !list.secrets.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(tr("Ключи", "Keys")).font(.system(size: 13, weight: .semibold))
                    ForEach(list.secrets) { s in row(s) }
                    if let more = list.moreText {
                        Text(more).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
            }
        }
        .task(id: pluginId) { await store.loadSecrets(pluginId) }
    }

    private func row(_ s: PluginSecret) -> some View {
        let busy = store.secretBusy == "\(pluginId)/\(s.key)"
        let locked = !store.canAct || !store.connection.isLive || store.secretBusy != nil
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: s.state == .set ? "key.fill" : "key").font(.system(size: 12))
                .foregroundStyle(s.state == .set ? hexColor(0x30D158) : .white.opacity(0.5))
                .frame(width: 16).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.key).font(.system(size: 12.5, design: .monospaced)).textSelection(.enabled)
                    BadgeView(text: s.stateText, color: s.state == .set ? "green" : s.state == .unset ? "orange" : s.state == .denied ? nil : "red")
                }
                if let why = s.why, !why.isEmpty {
                    Text(why).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
                }
                if let d = s.deniedText {
                    Text(d).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                }
                if let env = s.env {
                    Text(tr("Плагин получает его в \(env)", "The plugin gets it as \(env)")).font(.system(size: 11)).foregroundStyle(.white.opacity(0.4))
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            if busy { ProgressView().controlSize(.small) }
            if s.editable {
                Button(s.state == .set ? tr("Заменить…", "Replace…") : tr("Задать ключ…", "Set key…")) { enter(s) }
                    .buttonStyle(CapsuleStyle(height: 24, expand: false))
                    .disabled(locked)
                    .help(locked && !store.canAct ? ActionBlock.notPinned.help : "")
                if s.state == .set {
                    Button(tr("Удалить", "Remove")) { remove(s) }
                        .buttonStyle(CapsuleStyle(height: 24, expand: false))
                        .disabled(locked)
                }
            }
        }
    }

    private func enter(_ s: PluginSecret) {
        let plugin = store.plugin(pluginId)?.title ?? pluginId
        var value = ""
        let ok = ModalWindow.run(width: 460) { done in
            SecretEntrySheet(plugin: plugin, secret: s, done: { v in value = v ?? ""; done(v != nil) })
        }
        guard ok, !value.isEmpty else { return }
        Task { await store.writeSecret(plugin: pluginId, key: s.key, value: value) }
    }

    private func remove(_ s: PluginSecret) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = tr("Удалить ключ \(s.key)?", "Remove the key \(s.key)?")
        alert.informativeText = tr("Запись удалится из связки ключей macOS, плагин перезапустится без неё.",
                                   "The entry is removed from the macOS keychain, and the plugin restarts without it.")
        alert.addButton(withTitle: tr("Удалить", "Remove"))
        let cancel = alert.addButton(withTitle: tr("Отмена", "Cancel"))
        cancel.keyEquivalent = "\u{1b}"
        alert.buttons.first?.keyEquivalent = ""
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await store.writeSecret(plugin: pluginId, key: s.key, value: nil) }
    }
}

/// "Set key…": a secure field with the documented restrictions checked as you type. `done(nil)` — cancelled.
struct SecretEntrySheet: View {
    let plugin: String
    let secret: PluginSecret
    let done: (String?) -> Void
    private let valueStore = State(initialValue: "")
    private var value: String { get { valueStore.wrappedValue } nonmutating set { valueStore.wrappedValue = newValue } }

    private var problem: String? { value.isEmpty ? nil : SecretValue.problem(value) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(tr("Ключ для «\(plugin)»", "Key for \"\(plugin)\"")).font(.system(size: 16, weight: .bold))
            Text(secret.key).font(.system(size: 12, design: .monospaced)).foregroundStyle(.white.opacity(0.7))
            if let why = secret.why, !why.isEmpty {
                Text(why).font(.system(size: 12)).foregroundStyle(.white.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
            }
            SecureField(tr("Значение ключа", "Key value"), text: valueStore.projectedValue)
                .textFieldStyle(.roundedBorder)
                .onSubmit { if value.count > 0, problem == nil { done(value) } }
            if let p = problem {
                Text(p).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFF8A80)).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(SecretValue.hint).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button(tr("Отмена", "Cancel")) { done(nil) }
                    .buttonStyle(CapsuleStyle(height: 28, expand: false))
                    .keyboardShortcut(.cancelAction)
                Button(tr("Сохранить", "Save")) { done(value) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 28, expand: false))
                    .disabled(value.isEmpty || problem != nil)
            }
        }
        .padding(22)
    }
}

// MARK: - countdown (G18 `until=`)

/// Ticks once a second until the moment, then stops (one last entry at the end).
struct CountdownSchedule: TimelineSchedule {
    let end: Date

    func entries(from start: Date, mode: TimelineScheduleMode) -> AnySequence<Date> {
        let stop = end.addingTimeInterval(1)
        return AnySequence(sequence(first: start) { d in
            let n = d.addingTimeInterval(1)
            return n <= stop ? n : nil
        })
    }
}

/// `until=` as a live `mm:ss` / `h:mm:ss`, `00:00` once the moment has passed.
struct CountdownText: View {
    let until: Date
    var font: Font = .system(size: 12)

    var body: some View {
        if until <= Date() {
            Text(Countdown.text(until: until)).font(font).monospacedDigit()
        } else {
            TimelineView(CountdownSchedule(end: until)) { ctx in
                Text(Countdown.text(until: until, now: ctx.date)).font(font).monospacedDigit()
            }
        }
    }
}

// MARK: - external extensions (G4)

/// Plugins → "Hub extensions": the files in `<home>/Extensions` with their state. Approving is a security decision — only
/// here, through a sheet with the core's consent text, the kind, the path and the fingerprint; never one click from the popover.
struct ExtensionsSection: View {
    let store: HubStore

    var body: some View {
        if let ext = store.state?.extensions, !ext.items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(tr("Расширения хаба", "Hub extensions")).font(.system(size: 13, weight: .semibold))
                    if ext.pending > 0 { BadgeView(text: tr("ждут: \(ext.pending)", "waiting: \(ext.pending)"), color: "orange") }
                    Spacer(minLength: 8)
                    if let dir = ext.dir {
                        Text(dir).font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).lineLimit(1).truncationMode(.middle)
                    }
                }
                if !ext.enabled {
                    Text(tr("Выключены в config.json (extensions.enabled) — ни одно не загружается.", "Off in config.json (extensions.enabled) — none is loaded."))
                        .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B))
                }
                ForEach(ext.items) { item in row(item, consent: ext.consent) }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(ext.pending > 0 ? hexColor(0xFF9F0A, 0.10) : Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(ext.pending > 0 ? hexColor(0xFF9F0A, 0.35) : Color.white.opacity(0.09), lineWidth: 0.5))
        }
    }

    private func row(_ item: ExtensionItem, consent: String?) -> some View {
        let locked = !store.canAct || !store.connection.isLive || store.busyAction != nil
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.needsApproval ? "exclamationmark.shield" : item.status == .error ? "xmark.octagon" : "puzzlepiece.extension")
                .font(.system(size: 13))
                .foregroundStyle(item.needsApproval ? hexColor(0xFF9F0A) : item.status == .error ? hexColor(0xFF6B6B) : .white.opacity(0.65))
                .frame(width: 18).padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.path).font(.system(size: 12.5, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                    BadgeView(text: item.kindLabel, color: nil)
                }
                Text(item.statusText).font(.system(size: 11.5)).foregroundStyle(item.needsApproval ? hexColor(0xFFC56B) : .white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
                    .help(item.errorDetail ?? "")
                if item.restartRequired {
                    Text(ExtensionItem.restartText).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if store.extensionBusy == item.path { ProgressView().controlSize(.small) }
            if item.needsApproval {
                Button(tr("Проверить…", "Review…")) { review(item, consent: consent) }
                    .buttonStyle(CapsuleStyle(height: 26, expand: false)).fixedSize()
                    .disabled(locked || item.sha256 == nil)
                    .help(!store.canAct ? ActionBlock.notPinned.help : "")
            } else if item.status == .approved, !item.autoApproved {
                Button(tr("Отозвать", "Revoke")) { revoke(item) }
                    .buttonStyle(CapsuleStyle(height: 26, expand: false)).fixedSize()
                    .disabled(locked)
            }
        }
    }

    private func review(_ item: ExtensionItem, consent: String?) {
        let ok = ModalWindow.run(width: 520) { done in ExtensionApprovalSheet(item: item, consent: consent, done: done) }
        guard ok else { return }
        Task { await store.approveExtension(item) }
    }

    private func revoke(_ item: ExtensionItem) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = tr("Отозвать одобрение \(item.path)?", "Revoke the approval of \(item.path)?")
        alert.informativeText = tr("Со следующего запуска хаб его не загрузит; уже загруженный код работает до перезапуска хаба.",
                                   "The hub won't load it from the next start; code already loaded keeps running until the hub restarts.")
        alert.addButton(withTitle: tr("Отозвать", "Revoke"))
        let cancel = alert.addButton(withTitle: tr("Отмена", "Cancel"))
        cancel.keyEquivalent = "\u{1b}"
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        Task { await store.revokeExtension(item) }
    }
}

/// The approval sheet: the core's consent text verbatim, then what exactly is approved — kind, name, path, size and the
/// full fingerprint — with "Show in Finder" to read the file. "Approve" has no Return shortcut: a deliberate click.
struct ExtensionApprovalSheet: View {
    let item: ExtensionItem
    let consent: String?
    let done: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.shield.fill").font(.system(size: 26)).foregroundStyle(hexColor(0xFF9F0A))
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.status == .changed ? tr("Расширение изменилось", "The extension changed") : tr("Загрузить расширение хаба?", "Load a hub extension?"))
                        .font(.system(size: 16, weight: .bold))
                    Text(item.statusText).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                }
            }
            if let c = consent, !c.isEmpty {
                Text(c).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 5) {
                line(tr("Вид", "Kind"), item.kindLabel)
                if let n = item.name { line(tr("Имя", "Name"), n) }
                line(tr("Файл", "File"), item.file ?? item.path, mono: true)
                if let s = item.size { line(tr("Размер", "Size"), ByteCountFormatter.string(fromByteCount: Int64(s), countStyle: .file)) }
                line("SHA-256", item.sha256 ?? "?", mono: true)
                if let old = item.approvedSha256, item.status == .changed { line(tr("Было", "Was"), old, mono: true) }
            }
            .font(.system(size: 11.5))
            HStack {
                if let f = item.file {
                    Button(tr("Показать в Finder", "Show in Finder")) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: f)]) }
                        .buttonStyle(CapsuleStyle(height: 28, expand: false))
                }
                Spacer()
                Button(tr("Отмена", "Cancel")) { done(false) }
                    .buttonStyle(CapsuleStyle(height: 28, expand: false))
                    .keyboardShortcut(.cancelAction)
                Button(tr("Одобрить эти байты", "Approve these bytes")) { done(true) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0xFF9F0A), stroke: .clear, height: 28, expand: false))
            }
        }
        .padding(22)
    }

    private func line(_ k: String, _ v: String, mono: Bool = false) -> some View {
        GridRow {
            Text(k).foregroundStyle(.secondary)
            Text(v).font(mono ? .system(size: 11, design: .monospaced) : .system(size: 11.5)).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
