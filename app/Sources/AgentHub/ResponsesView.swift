import AgentHubKit
import SwiftUI

/// Session answer card (stage 6) after the Panel.dc.html prototype, inside the "Sessions" section, in two columns.
/// Permission: the tool and a safe summary (command name or path, no body); the only buttons are
/// "Allow once" / "Deny". AskUserQuestion: options, multiSelect, a custom answer.
/// The protocol cannot express "Always", bypass or a mode change, so they are not here and cannot be.
struct ResponseCard: View {
    let store: HubStore
    let card: HookCard
    let demo: Bool

    private let pickStore = State<[Int: Set<Int>]>(initialValue: [:])
    private let otherOnStore = State<Set<Int>>(initialValue: [])
    private let otherTextStore = State<[Int: String]>(initialValue: [:])
    private var pick: [Int: Set<Int>] { get { pickStore.wrappedValue } nonmutating set { pickStore.wrappedValue = newValue } }
    private var otherOn: Set<Int> { get { otherOnStore.wrappedValue } nonmutating set { otherOnStore.wrappedValue = newValue } }
    private var otherText: [Int: String] { get { otherTextStore.wrappedValue } nonmutating set { otherTextStore.wrappedValue = newValue } }

    private var busy: Bool { store.respondingTo != nil || store.estop || !store.connection.isLive }
    private var who: String { card.sessionName ?? tr("сессия \(card.sessionId.prefix(8))", "session \(card.sessionId.prefix(8))") }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            head
            switch card.kind {
            case .permission: permission
            case .question: questions
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5))
    }

    private var sub: String {
        let age = card.age.map { " · \(Fmt.duration($0))" } ?? ""
        return who + age + (card.subagent ? tr(" · субагент", " · subagent") : "")
    }

    private var head: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusGlyph(status: .wait, size: 22, question: card.kind == .question)
            VStack(alignment: .leading, spacing: 1) {
                Text(card.kind == .question ? (card.questions.first?.question ?? tr("Вопрос", "Question")) : tr("Разрешение", "Permission"))
                    .font(.system(size: 14, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                Text(sub).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55))
            }
            Spacer()
            if demo { Text(tr("демо", "demo")).font(.system(size: 10.5, weight: .bold)).padding(.horizontal, 6).padding(.vertical, 2).background(Capsule().fill(Color.white.opacity(0.12))) }
            if card.kind == .permission {
                Text("Claude Code ✓").font(.system(size: 10.5, weight: .bold)).foregroundStyle(hexColor(0x7EE29B))
                    .padding(.horizontal, 7).padding(.vertical, 2).background(Capsule().fill(hexColor(0x30D158, 0.16)))
                    .help(tr("Подпись Claude Code проверена хабом", "Claude Code signature verified by the hub"))
            }
            if let until = card.expiresDate {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let left = max(0, Int(until.timeIntervalSince(ctx.date)))
                    if left < 30 { Text(left > 0 ? tr("ещё \(left) с", "\(left) s left") : tr("истекает", "expiring")).font(.system(size: 11).monospacedDigit()).foregroundStyle(.orange) }
                }
            }
        }
    }

    // MARK: permission

    private var permission: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text((card.summary ?? card.tool ?? "?").replacingOccurrences(of: ": ", with: " · ")).font(.system(size: 12.5, design: .monospaced)).textSelection(.enabled)
                Text(tr("Тело команды скрыто — подробности во вкладке", "Command body hidden — see the tab for details")).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55))
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.25)))
            HStack(spacing: 8) {
                Button(tr("Разрешить один раз", "Allow once")) { send(.allowOnce) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false))
                Button(tr("Отклонить", "Deny")) { send(.deny) }
                    .buttonStyle(CapsuleStyle(height: 32, expand: false))
                tabLink
            }
            .disabled(busy)
        }
    }

    /// Jump to the card's session tab: `session.focus` if the core found the tab; for a daemon without it, `cmux.focus` on
    /// the card's tab. On a demo card the button is for screenshots (the core will reply that there is no session).
    private var focusRequest: (primitive: String, args: [String: JSONValue])? {
        if demo, card.surfaceId != nil, store.sessionFocusPrimitive { return ("session.focus", ["sessionId": .string(card.sessionId)]) }
        if let r = store.focusRequest(sessionId: card.sessionId) { return r }
        guard !store.sessionFocusPrimitive, let sf = card.surfaceId, store.focusPrimitive else { return nil }
        return ("cmux.focus", ["surfaceId": .string(sf)])
    }

    @ViewBuilder private var tabLink: some View {
        if let req = focusRequest {
            Button(tr("Открыть вкладку", "Open tab")) {
                Task { await store.perform(id: req.primitive, args: req.args, label: tr("Перейти во вкладку", "Switch to tab")) }
            }
            .buttonStyle(.plain).font(.system(size: 12.5)).foregroundStyle(store.bridgeOnline ? hexColor(0x4DA3FF) : .white.opacity(0.35))
            .disabled(!store.bridgeOnline)
            .help(store.bridgeOnline ? "" : BridgeText.disabledHelp(store))
        }
    }

    // MARK: question

    private var questions: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(card.questions.enumerated()), id: \.offset) { qi, q in
                VStack(alignment: .leading, spacing: 6) {
                    if qi > 0 { Text(q.question).font(.system(size: 13, weight: .semibold)) }
                    if q.multiSelect { Text(tr("можно выбрать несколько", "you can pick several")).font(.system(size: 11)).foregroundStyle(.secondary) }
                    VStack(spacing: 0) {
                        ForEach(Array(q.options.enumerated()), id: \.offset) { oi, o in
                            if oi > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                            optionRow(qi: qi, oi: oi, option: o, multi: q.multiSelect)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.25)))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    if card.questions.count > 1 { otherField(qi: qi) }
                }
            }
            HStack(spacing: 8) {
                if card.questions.count == 1 { otherField(qi: 0) }
                Button(tr("Ответить", "Reply")) { send(.answer(answers)) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false))
                    .disabled(!card.isComplete(answers))
            }
            .disabled(busy)
        }
    }

    private func optionRow(qi: Int, oi: Int, option: HookCard.Option, multi: Bool) -> some View {
        let on = pick[qi, default: []].contains(oi) && !otherOn.contains(qi)
        return Button {
            var set = pick[qi, default: []]
            if multi { if set.contains(oi) { set.remove(oi) } else { set.insert(oi) } } else { set = [oi] }
            pick[qi] = set
            if !multi { otherOn.remove(qi) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: multi ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(on ? hexColor(0x0A84FF) : .white.opacity(0.5))
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.system(size: 12.5, weight: .semibold))
                    if let d = option.description, !d.isEmpty { Text(d).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)) }
                }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// A custom answer replaces this question's options (protocol: per question, indices or a string).
    private func otherField(qi: Int) -> some View {
        TextField(tr("Свой ответ…", "Your answer…"), text: Binding(get: { otherText[qi] ?? "" }, set: { v in
            otherText[qi] = v
            if v.isEmpty { otherOn.remove(qi) } else { otherOn.insert(qi); pick[qi] = [] }
        }))
        .textFieldStyle(.plain).font(.system(size: 12.5))
        .padding(.horizontal, 12).frame(height: 32)
        .background(Capsule().fill(Color.white.opacity(0.08)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
    }

    private var answers: [QuestionAnswer] {
        card.questions.indices.map { qi in
            if otherOn.contains(qi) { return .other(otherText[qi] ?? "") }
            return .options(pick[qi, default: []].sorted())
        }
    }

    private func send(_ choice: RespondChoice) {
        Task { await store.respond(card, choice) }
    }
}

/// Synthetic cards for `--demo-cards` (screenshots without a live session or a certificate).
enum DemoCards {
    static var all: [HookCard] {
        let soon = ISO8601DateFormatter().string(from: Date().addingTimeInterval(95))
        return [
            HookCard(requestId: "demo0000000000000000000000000001", sessionId: "00000000-0000-4000-8000-00000000d001",
                     sessionName: tr("Демо — сборка", "Demo — build"), kind: .permission, tool: "Bash", summary: "Bash: npm", expiresAt: soon),
            HookCard(requestId: "demo0000000000000000000000000002", sessionId: "00000000-0000-4000-8000-00000000d002",
                     sessionName: tr("Демо — релиз", "Demo — release"), kind: .question, questions: [
                        .init(question: tr("Какой выпуск собрать?", "Which release to build?"), header: tr("Выпуск", "Release"), multiSelect: false, options: [
                            .init(label: tr("Патч", "Patch"), description: tr("только исправления", "fixes only")),
                            .init(label: tr("Минор", "Minor"), description: tr("с новым API", "with new API")),
                        ]),
                     ], expiresAt: soon),
        ]
    }
}

/// Synthetic sessions for `--demo-sessions` (screenshots of effort and "Go to" buttons without live Claude Code processes):
/// there are no processes behind them, and actions on them are not sent (`HubStore.isDemo`).
enum DemoSessions {
    static var all: [SessionInfo] {
        var list = [
            SessionInfo(sessionId: "00000000-0000-4000-8000-00000000e001", status: "waiting", name: tr("Демо — тесты", "Demo — tests"), cwd: "~/Projects/Demo/Game",
                        surfaceId: "00000000-0000-4000-8000-00000000f001", effort: "high"),
            SessionInfo(sessionId: "00000000-0000-4000-8000-00000000e002", status: "busy", name: tr("Демо — хаб", "Demo — hub"), cwd: "~/Projects/Demo/hub",
                        surfaceId: "00000000-0000-4000-8000-00000000f002", effort: "xhigh", ultracode: true),
            SessionInfo(sessionId: "00000000-0000-4000-8000-00000000e003", status: "idle", name: tr("Демо — заметки", "Demo — notes"), cwd: "~/docs",
                        surfaceId: "00000000-0000-4000-8000-00000000f003", effort: "medium"),
            SessionInfo(sessionId: "00000000-0000-4000-8000-00000000e004", status: "idle", name: tr("Демо — фон", "Demo — background"), cwd: "~", effort: "low"),
            // "Waiting for you": the "xhigh + ⚡ultracode" pair does not fit next to the name, so one capsule stays and the name is shown in full
            SessionInfo(sessionId: "00000000-0000-4000-8000-00000000e005", status: "waiting", name: tr("Демо — документация", "Demo — docs"), cwd: "~/Projects/Demo/docs",
                        surfaceId: "00000000-0000-4000-8000-00000000f005", effort: "xhigh", ultracode: true),
        ]
        list[0].waitingFor = "permission"
        list[4].waitingFor = "question"
        list[4].interactive = true
        list[0].interactive = true
        list[1].interactive = true
        list[2].interactive = true
        return list
    }
}
