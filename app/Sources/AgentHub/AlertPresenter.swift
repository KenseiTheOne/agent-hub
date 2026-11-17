import AgentHubKit
import AppKit
import SwiftUI

/// Confirmations and refusals. The confirmation text and cost are written by the **core** (428 reply, in the hub language); the shell
/// doesn't change them, doesn't decide whether confirmation is needed, and only passes the human's consent via a token.
/// Every question is the hub's own window (`HubWindow`): confirmations, refusals, permissions, typed text, removal,
/// rollback. None is modal — the answer is awaited, the main actor stays free, and the store keeps applying stream
/// events while a window is open; a second window waits for the first to end (`WindowQueue`).
@MainActor
final class AlertPresenter: ConfirmPresenter {
    /// When each core token stops being valid (a sheet reopened for the same token keeps its first deadline).
    private let deadlines = TokenDeadlines()

    /// Typed text for an input action (G1): with `confirm` — the core's confirmation with a field (its token accepts any
    /// valid text); without — the field alone (an immediate action pressed where there is no room for a field). The checks
    /// the core makes run in the window as the human types; the core's own refusal (`error`) is shown under the field
    /// until the text changes.
    func prompt(_ request: InputPrompt) async -> String? {
        let box = InputBox(text: request.text, refusal: request.error)
        let ok: Bool
        if let c = request.confirm {
            let until = deadlines.deadline(token: c.token, expiresInMs: c.expiresInMs)
            ok = await HubWindow.ask(width: 480, until: until) { done in
                ConfirmSheet(request: c, actionLabel: request.actionLabel, until: until, input: request.input, box: box, done: done)
            }
        } else {
            let own = ConfirmRequest(token: "", level: .confirm, text: tr("Текст уйдёт команде плагина.", "The text goes to the plugin's command."),
                                     title: request.actionLabel, button: tr("Отправить", "Send"))
            ok = await HubWindow.ask(width: 480) { done in
                ConfirmSheet(request: own, actionLabel: request.actionLabel, symbol: "character.cursor.ibeam", input: request.input, box: box, done: done)
            }
        }
        return ok ? box.text : nil
    }

    /// A confirmation is the hub's own window: what is asked, the parts (what's new, warnings, the cost, how it goes), the
    /// small print and two buttons. Return is the action only for a regular confirmation; for a cost there is no default.
    /// A core confirmation lives as long as its token: the small print counts the time down and the window closes by
    /// itself when it runs out — the answer is "no", and a short notice says the time ran out (`HubWindow.ask`).
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool {
        let until = deadlines.deadline(token: request.token, expiresInMs: request.expiresInMs)
        return await HubWindow.ask(width: 480, until: until) { done in ConfirmSheet(request: request, actionLabel: actionLabel, until: until, done: done) }
    }

    /// Plugin permissions window: a list with "why"; "new" only on the increment during an update (the daemon decides).
    /// It closes by itself when the consent token's lifetime runs out, like a confirmation.
    func consent(_ request: ConsentRequest) async -> Bool {
        let until = deadlines.deadline(token: request.token, expiresInMs: request.expiresInMs)
        return await HubWindow.ask(width: 520, until: until) { done in ConsentSheet(request: request, until: until, done: done) }
    }

    /// The registry key window: both fingerprints whole, what accepting means; "Don't accept" is the default answer
    /// (Return, Esc, closing the window, the token's lifetime running out).
    func registryKey(_ request: RegistryKeyConsent) async -> Bool {
        let until = deadlines.deadline(token: request.token, expiresInMs: request.expiresInMs)
        return await HubWindow.ask(width: 540, until: until) { done in RegistryKeySheet(request: request, until: until, done: done) }
    }

    func report(title: String, detail: String) async {
        _ = await report(Report(title: title, detail: detail))
    }

    /// The hub's own window instead of a system alert: the reason first, then what and where, the advice and the buttons.
    /// Esc or closing it is "OK".
    func report(_ report: Report) async -> ReportChoice {
        let result: WindowResult<ReportChoice> = await HubWindow.present(width: 460) { answer in ReportSheet(report: report, pick: answer) }
        return result.value ?? .ok
    }
}

/// How loud a confirmation's action is and which button Return presses.
enum ConfirmStyle {
    /// A blue action, Return runs it.
    case regular
    /// Costs quota or goes to the network: an orange action, no default — a deliberate click.
    case costly
    /// Removes or goes back: a red action, Return is "Cancel".
    case cautious
}

/// The text typed into a window's field. `refusal` — why the core refused the text the window opened with.
@MainActor
final class InputBox: ObservableObject {
    @Published var text: String
    private let refusedText: String?
    private let refusal: String?

    init(text: String = "", refusal: String? = nil) {
        self.text = text
        self.refusedText = refusal == nil ? nil : text
        self.refusal = refusal
    }

    func problem(maxLength: Int) -> String? { InputCheck.problem(text, maxLength: maxLength, refusedText: refusedText, refusal: refusal) }
    func canSend(maxLength: Int) -> Bool { InputCheck.canSend(text, maxLength: maxLength, refusedText: refusedText) }
}

/// The field of an input action inside a hub window: it has the keyboard from the start, the reason a text can't be
/// sent is under it as the human types, and Return sends (where the window allows a default action).
struct PromptField: View {
    @ObservedObject var box: InputBox
    let spec: OfferInput
    let submit: () -> Void
    private let focus = FocusState<Bool>()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(spec.placeholder ?? "", text: $box.text)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13))
                .focused(focus.projectedValue)
                .onSubmit(submit)
                .onAppear { focus.wrappedValue = true }
            if let p = box.problem(maxLength: spec.maxLength) {
                Text(p).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFF8A80)).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(InputCheck.counter(box.text, maxLength: spec.maxLength) ?? tr("Одна строка, до \(spec.maxLength) символов.", "One line, up to \(spec.maxLength) characters."))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).monospacedDigit()
            }
        }
    }
}

/// "Do it?": a badge, the question and what changes in one line; then either the parts the shell laid out (`layout`:
/// what's new, warnings, how it goes) or the core's text as it is, the row the button is on and the cost; the small print
/// (tag and commit, or a live countdown of how long the confirmation is still valid) on the left, "Cancel" and the action
/// on the right. The same window asks the shell's own questions (rollback, removing a key, revoking an approval) and,
/// with `input`, carries the field of an input action.
struct ConfirmSheet: View {
    let request: ConfirmRequest
    let actionLabel: String
    /// When the core's token stops being valid: the small print counts down to it (the window is closed by the queue).
    var until: Date? = nil
    /// nil — by the core's level (`confirm-cost` is costly, anything else regular).
    var style: ConfirmStyle? = nil
    /// The badge symbol; nil — by the style.
    var symbol: String? = nil
    /// An input action: the window has a field for this text, and the action waits for a text the core would accept.
    var input: OfferInput? = nil
    @ObservedObject var box = InputBox()
    let done: (Bool) -> Void
    private let orange = hexColor(0xFF9F0A)
    private let blue = hexColor(0x0A84FF)

    private var kind: ConfirmStyle { style ?? (request.level == .confirmCost ? .costly : .regular) }
    private var costly: Bool { kind != .regular }
    private var title: String {
        request.title ?? (kind == .costly ? tr("Подтвердите: действие тратит квоту или выходит в сеть", "Confirm: this uses quota or the network")
                                          : tr("Подтвердите действие", "Confirm the action"))
    }
    private var details: String? { request.details.flatMap { $0.isEmpty ? nil : $0 } }
    private var canRun: Bool { input.map { box.canSend(maxLength: $0.maxLength) } ?? true }

    var body: some View {
        let tint = costly ? orange : hexColor(0x4C9DFF)
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol ?? (request.layout != nil ? "arrow.down" : (costly ? "exclamationmark" : "questionmark")))
                    .font(.system(size: 16, weight: .bold)).foregroundStyle(tint)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 10).fill(tint.opacity(0.16)))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.system(size: 16, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                    if let sub = request.layout?.subtitle {
                        Text(sub).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(.white.opacity(0.72))
                    }
                }
                .frame(minHeight: 34, alignment: .center)
                Spacer(minLength: 0)
            }
            if let layout = request.layout {
                if layout.heading != nil || !layout.points.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(tr("Что нового", "What's new").uppercased()).font(.system(size: 10.5, weight: .semibold)).kerning(0.6).foregroundStyle(.white.opacity(0.45))
                        if let h = layout.heading {
                            Text(h).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(Array(layout.points.enumerated()), id: \.offset) { _, point in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Circle().fill(.white.opacity(0.4)).frame(width: 4, height: 4).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 3.5 }
                                Text(point).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.86)).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
                }
                ForEach(Array(layout.warnings.enumerated()), id: \.offset) { _, w in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(orange)
                        Text(w).font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 14).fill(orange.opacity(0.12)))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(orange.opacity(0.4), lineWidth: 0.5))
                }
                if let note = layout.note {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "arrow.right").font(.system(size: 11, weight: .bold)).foregroundStyle(hexColor(0x4C9DFF))
                        Text(note).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.86)).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Text(request.text).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.86))
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                let row = request.extraRow(actionLabel: actionLabel)
                let cost = request.cost.flatMap { $0.isEmpty ? nil : $0 }
                if row != nil || cost != nil {
                    VStack(spacing: 0) {
                        if let row { line(tr("Кнопка в строке", "Button on the row"), row) }
                        if row != nil, cost != nil { Rectangle().fill(.white.opacity(0.09)).frame(height: 0.5) }
                        if let cost { line(tr("Чем обойдётся", "Cost"), cost) }
                    }
                    .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
                }
            }
            if let input {
                // Return in the field runs the action only where the window has a default action
                PromptField(box: box, spec: input) { if kind == .regular, canRun { done(true) } }
            }
            HStack(spacing: 8) {
                if let details {
                    Text(details).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.white.opacity(0.38))
                        .lineLimit(1).truncationMode(.middle).textSelection(.enabled).help(details)
                } else if let until {
                    // how long the core still accepts this confirmation; at zero the window closes by itself
                    TimelineView(CountdownSchedule(end: until)) { ctx in
                        Text(WindowExpiry.confirmText(until: until, now: ctx.date))
                            .font(.system(size: 10.5, design: .monospaced)).monospacedDigit()
                            .foregroundStyle(WindowExpiry.isLast(until: until, now: ctx.date) ? orange : .white.opacity(0.38))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                let action = request.button ?? tr("Выполнить", "Run")
                switch kind {
                case .regular:
                    Button(tr("Отмена", "Cancel")) { done(false) }.buttonStyle(CapsuleStyle(height: 32, expand: false))
                    Button(action) { done(true) }
                        .buttonStyle(CapsuleStyle(fill: blue, stroke: .clear, height: 32, expand: false))
                        .keyboardShortcut(.defaultAction)
                        .disabled(!canRun)
                case .costly:
                    Button(tr("Отмена", "Cancel")) { done(false) }.buttonStyle(CapsuleStyle(height: 32, expand: false))
                    Button(action) { done(true) }
                        .buttonStyle(CapsuleStyle(fill: orange, stroke: .clear, text: .black, height: 32, expand: false))
                        .disabled(!canRun)
                case .cautious:
                    Button(action) { done(true) }
                        .buttonStyle(CapsuleStyle(fill: hexColor(0xFF453A, 0.2), stroke: hexColor(0xFF453A, 0.4), text: hexColor(0xFF8A80), height: 32, expand: false))
                        .disabled(!canRun)
                    Button(tr("Отмена", "Cancel")) { done(false) }
                        .buttonStyle(CapsuleStyle(fill: blue, stroke: .clear, height: 32, expand: false))
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(22)
    }

    private func line(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label).foregroundStyle(.white.opacity(0.45)).frame(width: 116, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            Text(value).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .font(.system(size: 12.5))
        .padding(.horizontal, 14).padding(.vertical, 9)
    }
}

/// "It didn't work": a badge and the reason as the headline, rows (action, tab, the plugin's facts), the advice, the
/// small-print code on a line of its own — whole, wrapped, selectable (it is what gets pasted into a bug report, so it
/// is never cut) — and the buttons on the right. Esc and Return close it as "OK".
struct ReportSheet: View {
    let report: Report
    /// nil — closed without a choice (the same as "OK").
    let pick: (ReportChoice?) -> Void
    private let orange = hexColor(0xFF9F0A)

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark").font(.system(size: 16, weight: .bold)).foregroundStyle(orange)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 10).fill(orange.opacity(0.16)))
                VStack(alignment: .leading, spacing: 4) {
                    Text(report.title).font(.system(size: 16, weight: .bold)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    if !report.detail.isEmpty {
                        Text(report.detail).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.72))
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                }
                .frame(minHeight: 34, alignment: .center)
                Spacer(minLength: 0)
            }
            if !report.rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(report.rows.enumerated()), id: \.offset) { i, row in
                        if i > 0 { Rectangle().fill(.white.opacity(0.09)).frame(height: 0.5) }
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(row.label).foregroundStyle(.white.opacity(0.45))
                                .frame(width: 104, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.value).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                if let note = row.note, !note.isEmpty {
                                    Text(note).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .font(.system(size: 12.5))
                        .padding(.horizontal, 14).padding(.vertical, 9)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
            }
            if let hint = report.hint {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "arrow.right").font(.system(size: 11, weight: .bold)).foregroundStyle(hexColor(0x4C9DFF))
                    Text(hint).font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let code = report.code, !code.isEmpty {
                Text(code).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.white.opacity(0.45))
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                Spacer(minLength: 8)
                if report.canFocus {
                    Button(FocusText.action) { pick(.focus) }.buttonStyle(CapsuleStyle(height: 32, expand: false))
                }
                if report.canRetry {
                    Button(RetryText.button) { pick(.retry) }.buttonStyle(CapsuleStyle(height: 32, expand: false))
                }
                Button(tr("Понятно", "OK")) { pick(.ok) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
    }
}

/// The hub's windows: a borderless glass panel with SwiftUI content that floats over everything, takes the keyboard and
/// brings the app forward — and is **not modal**. The caller awaits the answer:
///
///     Button("Remove") { Task { if await HubWindow.confirm(…) { await store.remove(…) } } }
///
/// That is the one rule for every window, wherever it is asked from (a button handler, a store action, a menu item):
/// start a task and await. Nothing here runs a nested event loop, so the main actor is free while a window is open —
/// the store goes on applying stream events — and a SwiftUI button handler is as good a place to start from as any.
/// One window is on screen at a time; the next one waits (`WindowQueue`). However a window ends — a button, Esc,
/// being closed, its deadline, the app quitting (`closeAll`) — the awaiting side is resumed once.
@MainActor
enum HubWindow {
    static let queue = WindowQueue()
    /// The window on screen now (the snapshot keys draw it).
    private(set) static var current: NSWindow?

    /// Show `content` and wait for how the window ends. `answer(value)` — the human's answer, `answer(nil)` — cancelled.
    /// `until` — when the window stops making sense (a token's lifetime): it is closed then, the result is `.expired`.
    static func present<Value: Sendable, V: View>(width: CGFloat, until: Date? = nil,
                                                  @ViewBuilder content: @escaping (_ answer: @escaping (Value?) -> Void) -> V) async -> WindowResult<Value> {
        await queue.present(until: until) { answer in
            let panel = make(width: width, content: content { answer($0) })
            // Esc and any other way the window gets closed are "cancelled"
            panel.onCancel = { answer(nil) }
            panel.onClose = { answer(nil) }
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            current = panel
            return {
                panel.onCancel = nil
                panel.onClose = nil
                panel.orderOut(nil)
                if current === panel { current = nil }
            }
        }
    }

    /// A yes/no window: `done(true)` — agreed. Esc, closing, the deadline and quitting are all "no". The deadline also
    /// leaves a short notice behind, so the human knows why the window went away; the caller does not wait for it.
    static func ask<V: View>(width: CGFloat, until: Date? = nil, @ViewBuilder content: @escaping (_ done: @escaping (Bool) -> Void) -> V) async -> Bool {
        let result: WindowResult<Bool> = await present(width: width, until: until) { answer in content { answer($0) } }
        if result == .expired { Task { await expiredNotice() } }
        return result == .answer(true)
    }

    /// "The request timed out": a refusal-style window that closes by itself after `ExpiryNotice.seconds`.
    static func expiredNotice() async {
        let report = ExpiryNotice.report
        let _: WindowResult<ReportChoice> = await present(width: 460, until: Date().addingTimeInterval(ExpiryNotice.seconds)) { answer in
            ReportSheet(report: report, pick: answer)
        }
    }

    /// The shell's own question in the confirmation window (rollback, removing a key, revoking an approval).
    static func confirm(title: String, text: String, button: String, style: ConfirmStyle = .regular) async -> Bool {
        let request = ConfirmRequest(token: "", level: .confirm, text: text, title: title, button: button)
        return await ask(width: 480) { done in ConfirmSheet(request: request, actionLabel: button, style: style, done: done) }
    }

    /// The system folder picker, in the same line as the hub's windows and just as non-modal. nil — cancelled.
    static func chooseFolder(message: String? = nil, startAt: URL? = nil) async -> URL? {
        let picked: WindowResult<URL> = await queue.present { answer in
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.prompt = tr("Выбрать", "Choose")
            if let message { panel.message = message }
            if let startAt { panel.directoryURL = startAt }
            panel.level = .modalPanel
            NSApp.activate(ignoringOtherApps: true)
            panel.begin { response in answer(response == .OK ? panel.url : nil) }
            current = panel
            return {
                // already gone when the human answered; still on screen when the app is quitting
                if panel.isVisible { panel.cancel(nil) }
                if current === panel { current = nil }
            }
        }
        return picked.value
    }

    /// The app is quitting: end every window as cancelled, so nobody is left waiting.
    static func closeAll() { queue.cancelAll() }

    /// The panel itself — the one place a hub window is built (the snapshot keys go through `present` too).
    static func make<V: View>(width: CGFloat, content: V) -> KeyPanel {
        let panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
        let root = content
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
        // over the panel, the popover and other apps' windows, and it stays when the human switches to another app
        // (to look something up before answering) — an NSPanel would hide then
        panel.level = .modalPanel
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.center()
        return panel
    }

    /// Size the window to its content again (content that settles after the first frame, before a snapshot).
    static func refit(_ window: NSWindow) {
        guard let host = window.contentView else { return }
        window.setContentSize(host.fittingSize)
    }
}

/// A borderless window that accepts the keyboard (Esc, Return, text fields). `onCancel` — Esc (`cancelOperation`):
/// in the hub's windows it's "Cancel", even if the cancel button has its own Return or the focus is on a checkbox.
/// `onClose` — the window was closed by something other than its own buttons.
final class KeyPanel: NSPanel {
    var onCancel: (() -> Void)?
    var onClose: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func cancelOperation(_ sender: Any?) {
        if let onCancel { onCancel() } else { super.cancelOperation(sender) }
    }
    override func close() {
        super.close()
        onClose?()
    }
}

/// Permissions window: "Install "X"?", signature and sha256, permissions, a warning for community, "Cancel" / "Install".
struct ConsentSheet: View {
    let request: ConsentRequest
    /// When the consent token stops being valid: the note counts down to it (the window is closed by the queue).
    var until: Date? = nil
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
                    // several registries (G19): which one it installs from
                    Text((request.source ?? ConsentSource(kind: "registry")).line + (request.registryLabel.map { " · " + RegistryText.from($0) } ?? ""))
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
            if let until {
                // how long the daemon still accepts this consent; at zero the window closes by itself
                TimelineView(CountdownSchedule(end: until)) { ctx in
                    Text(note + " " + WindowExpiry.consentText(until: until, now: ctx.date))
                        .font(.system(size: 11.5)).monospacedDigit().foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(note).font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
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
    static func ask(title: String, id: String = "") async -> Bool? {
        let box = PurgeBox()
        let ok = await HubWindow.ask(width: 420) { done in RemoveSheet(title: title, id: id, box: box, done: done) }
        return ok ? box.purge : nil
    }
}

/// Plugin rollback: the catalog version is older than the installed one (the daemon flags an update by the archive sha256, and the registry
/// may have reissued an old release). "Roll back" is not the default: Return is "Cancel".
@MainActor
enum RollbackWindow {
    static func ask(title: String, from: String, to: String) async -> Bool {
        await HubWindow.confirm(
            title: tr("Откатить «\(title)» до \(to)?", "Roll \"\(title)\" back to \(to)?"),
            text: tr("Установлена версия \(from), а в каталоге реестра — более старая \(to). Так бывает, когда реестр отзывает выпуск. Плагин будет заменён версией \(to); его данные сохранятся.",
                     "Version \(from) is installed, and the registry catalog has an older \(to). This happens when the registry withdraws a release. The plugin will be replaced with \(to); its data is kept."),
            button: tr("Откатить", "Roll back"), style: .cautious)
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
    static func show(title: String, id: String, tier: PluginTier, permissions: [PluginPermission]) async {
        _ = await HubWindow.ask(width: 520) { done in
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
