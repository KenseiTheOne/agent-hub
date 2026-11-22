import AgentHubKit
import AppKit
import SwiftUI

// The "Sessions" section of the panel: the session list, rows of sessions and of external sessions, the effort capsule.

/// The last turn's effort capsule (Panel.dc.html): the level and ⚡ultracode. Based on the last turn — for an idle
/// session the value may be stale (tooltip).
struct EffortBadge: View {
    let effort: String?
    var ultracode = false
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            if let effort {
                Text(effort).font(.system(size: compact ? 10.5 : 11, weight: .medium)).foregroundStyle(.white.opacity(0.78))
                    .padding(.horizontal, compact ? 6 : 8).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.08)))
            }
            if ultracode {
                Text("⚡ultracode").font(.system(size: compact ? 10.5 : 11, weight: .semibold)).foregroundStyle(hexColor(0xFFD60A))
                    .padding(.horizontal, compact ? 6 : 8).padding(.vertical, 2)
                    .background(Capsule().fill(hexColor(0xFFD60A, 0.14)))
            }
        }
        .fixedSize()
        .tip(tr("Effort по последнему ходу сессии — у простаивающей сессии может быть устаревшим", "Effort as of the session's last turn — may be out of date for an idle session"))
    }
}

struct SessionsView: View {
    let store: HubStore
    let search: String

    var body: some View {
        let sessions = filtered
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                let cards = store.visibleCards
                if let e = store.sessionsNotice {
                    Notice(color: .yellow, icon: "lock.trianglebadge.exclamationmark", title: e)
                }
                // the result of a launch from the form (it closes right away): "waiting for the session" → "appeared" / "didn't appear within a minute"
                if let l = store.lastLaunch {
                    Notice(color: l.state == .timeout ? .orange : l.state == .registered ? .green : .blue, icon: l.symbol, title: l.text,
                           actionTitle: tr("Скрыть", "Dismiss"), onAction: { store.clearLastLaunch() })
                }
                // sessions in cmux while its bridge is offline: their "Go to tab" is disabled — here you can see how to start it
                if store.sessionsWaitingForBridge || (store.focusPrimitive && !store.bridgeOnline && store.state?.terminals == nil && cards.contains(where: { $0.surfaceId != nil })) {
                    BridgeNotice(store: store)
                }
                if !cards.isEmpty {
                    Text(tr("Ждут вас", "Needs you")).font(.system(size: 13, weight: .semibold))
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)], spacing: 12) {
                        ForEach(cards) { card in ResponseCard(store: store, card: card, demo: store.demoCards.contains(card)) }
                    }
                    if cards.contains(where: { $0.agent == nil || $0.agent == "claude" }) {
                        Text(tr("Можно ответить и в терминале, и с телефона через Remote Control — засчитается первый ответ.", "You can also answer in the terminal or from your phone via Remote Control — the first answer counts."))
                            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                    }
                    // agents whose terminal prompt waits for the hook (Codex): it appears only after the card
                    ForEach(Array(Set(cards.filter { $0.agent != nil && $0.agent != "claude" }.map(\.verifiedAgent))).sorted(), id: \.self) { label in
                        Text(tr("\(label) спросит в своём терминале только после карточки: «Решить в терминале» или когда она истечёт.", "\(label) asks in its own terminal only after the card: \"Decide in terminal\" or when it expires."))
                            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                    }
                }
                // the sessions plugin's page leads here (PanelSection.resolved): what isn't in the hub registry —
                // died sessions with "Continue: claude --resume …" and the "no sessions visible" reason — comes from its frame
                let extras = SessionsPluginExtras(store.plugin(NotifyTarget.sessionsPlugin))
                if let t = extras.brokenTitle {
                    Notice(color: .yellow, icon: "exclamationmark.triangle", title: t, detail: extras.brokenDetail)
                }
                if let f = extras.failure {
                    Notice(color: .red, icon: "xmark.octagon", title: tr("Плагин сессий не ответил: \(f)", "The sessions plugin failed: \(f)"),
                           actionTitle: RetryText.button, onAction: { Task { await store.refresh(plugin: NotifyTarget.sessionsPlugin) } })
                }
                if !extras.nodes.isEmpty {
                    Text(tr("Нужно внимание", "Needs attention")).font(.system(size: 13, weight: .semibold)).padding(.top, cards.isEmpty ? 0 : 6)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(extras.nodes.enumerated()), id: \.offset) { i, node in
                            if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                            BlockNode(store: store, node: node, depth: 0).padding(.horizontal, 14).padding(.vertical, 9)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
                    .environment(\.pluginPageId, NotifyTarget.sessionsPlugin)
                }
                Text(tr("Все сессии", "All sessions")).font(.system(size: 13, weight: .semibold)).padding(.top, cards.isEmpty && extras.nodes.isEmpty ? 0 : 6)
                if sessions.isEmpty {
                    Text(search.isEmpty ? tr("Сессий нет. Здесь — только сессии, чья подпись Claude Code проверена хабом.", "No sessions. Only sessions whose Claude Code signature the hub verified appear here.")
                                        : tr("Ничего не нашлось", "Nothing found"))
                        .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 10)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(sessions.enumerated()), id: \.element.id) { i, s in
                            if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                            SessionRow(store: store, session: s, question: cards.contains { $0.sessionId == s.sessionId && $0.kind == .question })
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
                }
                // non-Claude agent sessions that trusted plugins report (hub 0.1.3+): only "Go to tab", not counted above
                let others = filteredExternal
                if !others.isEmpty {
                    Text(tr("Другие агенты", "Other agents")).font(.system(size: 13, weight: .semibold)).padding(.top, 6)
                    VStack(spacing: 0) {
                        ForEach(Array(others.enumerated()), id: \.element.id) { i, s in
                            if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                            ExternalSessionRow(store: store, session: s)
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
                }
                Text(tr("Workflow внутри сессии снаружи не останавливается — «\(FocusText.short)», затем /workflows во вкладке.", "A Workflow inside a session can't be stopped from outside — use \(FocusText.short), then /workflows in the tab."))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
            }
            .padding(.bottom, 20)
        }
        .task { await store.loadCards() }
    }

    private var filteredExternal: [ExternalSession] {
        let all = (store.state?.externalSessions ?? []).sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
        return SearchFilter.apply(all, query: search) { [$0.displayName, $0.agent] }
    }

    private var filtered: [SessionInfo] {
        let order = ["waiting": 0, "busy": 1, "idle": 2]
        let all = store.sessions.sorted { (order[$0.status ?? ""] ?? 3, $0.displayName) < (order[$1.status ?? ""] ?? 3, $1.displayName) }
        return SearchFilter.apply(all, query: search) { [$0.displayName, $0.cwd] }
    }
}

/// A non-Claude agent session (`externalSessions`): name, agent, the plugin that reports it and its terminal; the only
/// button is "Go to tab" (`session.focus`) when the core found the tab. A reply card for the session (a hook of the agent
/// the hub verified) turns the glyph into "waiting".
struct ExternalSessionRow: View {
    let store: HubStore
    let session: ExternalSession

    private var waitingCard: HookCard? {
        store.visibleCards.first { $0.sessionId.caseInsensitiveCompare(session.sessionId) == .orderedSame }
    }

    var body: some View {
        let owner = session.owner.map { store.plugin($0)?.title ?? $0 }
        let sub = [session.agent, owner.map { tr("от плагина «\($0)»", "via \"\($0)\"") }, session.terminalInfo?.label ?? session.terminal]
            .compactMap { $0 }.joined(separator: " · ")
        HStack(spacing: 10) {
            if let card = waitingCard {
                StatusGlyph(status: .wait, size: 18, question: card.kind == .question)
                    .tip(tr("Ждёт ответа — карточка выше", "Waiting for an answer — see the card above"))
            } else {
                Image(systemName: "terminal").font(.system(size: 13)).foregroundStyle(.white.opacity(0.6)).frame(width: 18)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(session.displayName).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    .reportsTruncation(session.displayName, font: .system(size: 13, weight: .medium))
                if !sub.isEmpty { Text(sub).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(1) }
            }
            Spacer(minLength: 8)
            if let req = store.focusRequest(external: session) {
                let block = store.gate(external: session)
                Button {
                    Task { await store.perform(id: req.primitive, args: req.args, label: FocusText.action) }
                } label: { Label(FocusText.short, systemImage: "arrow.up.forward.app") }
                    .buttonStyle(CapsuleStyle(height: 26, expand: false))
                    .disabled(store.busyAction != nil || block != nil)
                    .tip(block.map { BridgeText.help($0, primitive: req.primitive, store) } ?? tr("Перейти во вкладку агента", "Go to the agent's tab"))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}

struct SessionRow: View {
    let store: HubStore
    let session: SessionInfo
    let question: Bool

    private func has(_ name: String) -> Bool { store.state?.primitives.contains { $0.name == name } ?? false }
    /// Why the button won't work: connection, unpinned build (interrupt/stop — app only), pause.
    private func block(_ primitive: String) -> ActionBlock? { store.gate(primitive: primitive) }
    /// The same plus the session's terminal: it lacks the capability, or it is cmux and the bridge is offline.
    private func block(_ primitive: String, _ capability: String) -> ActionBlock? { store.gate(primitive: primitive, session: session, capability: capability) }
    private var terminal: SessionTerminal? { store.terminal(of: session) }

    var body: some View {
        HStack(spacing: 10) {
            glyph
            VStack(alignment: .leading, spacing: 1) {
                Text(session.displayName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text([session.stateLabel, terminal?.label, session.cwd].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
            }
            Spacer(minLength: 8)
            if session.kind != nil && session.kind != "interactive" {
                Text(tr("фоновая", "background")).font(.system(size: 10.5, weight: .semibold)).padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.1)))
            }
            if session.effortLabel != nil || session.ultracode == true {
                EffortBadge(effort: session.effortLabel, ultracode: session.ultracode == true)
            }
            Text(age).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).lineLimit(1).frame(width: 70, alignment: .trailing)
            // buttons in a fixed-width column: effort capsules line up in a column, as in the prototype
            HStack(spacing: 10) {
            if let req = focusRequest {
                let b = block(req.primitive, "focus")
                Button(FocusText.short) { focus(req) }
                    .buttonStyle(CapsuleStyle(height: 26, expand: false)).disabled(store.busyAction != nil || b != nil)
                    .tip(b.map { BridgeText.help($0, primitive: req.primitive, store) } ?? tr("Перейти во вкладку этой сессии", "Go to this session's tab"))
            }
            if session.status == "busy", has("session.interrupt"), terminal != nil {
                let b = block("session.interrupt", "send-esc")
                // a labelled capsule (13.11: the bare hand icon was too small to notice or understand)
                Button { run("session.interrupt", tr("Прервать ход", "Interrupt the turn")) } label: {
                    Label(tr("Прервать", "Interrupt"), systemImage: "hand.raised.fill")
                }
                .buttonStyle(CapsuleStyle(fill: hexColor(0xFF9F0A, 0.2), stroke: hexColor(0xFF9F0A, 0.45), text: hexColor(0xFFC56B), height: 26, expand: false))
                .disabled(store.busyAction != nil || b != nil)
                    .tip(b.map { BridgeText.help($0, primitive: "session.interrupt", store) }
                          ?? tr("Прервать ход (как Esc во вкладке)", "Interrupt the turn (like Esc in the tab)"))
            }
            if has("session.stop") {
                Button { run("session.stop", tr("Завершить сессию", "End session")) } label: {
                    Label(tr("Завершить", "End"), systemImage: "stop.fill")
                }
                .buttonStyle(CapsuleStyle(fill: hexColor(0xFF453A, 0.18), stroke: hexColor(0xFF453A, 0.4), text: hexColor(0xFF8A80), height: 26, expand: false))
                .disabled(store.busyAction != nil || block("session.stop") != nil)
                .tip(block("session.stop")?.help ?? tr("Завершить сессию — продолжить позже можно через claude --resume", "End the session — resume later with claude --resume"))
            }
            }
            // one fixed width for every row, wide enough for Go to tab + Interrupt + End: effort capsules stay in a column
            .frame(width: 340, alignment: .trailing)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .tip(details)
    }

    private var details: String {
        var parts: [String] = []
        if let p = session.pid { parts.append(tr("процесс \(p)", "process \(p)")) }
        if let t = terminal { parts.append(tr("терминал \(t.label)", "terminal \(t.label)")) }
        if let sf = session.surfaceId { parts.append(tr("вкладка \(sf.prefix(8))", "tab \(sf.prefix(8))")) }
        parts.append(session.interactive ? tr("интерактивная", "interactive") : tr("не интерактивная", "not interactive"))
        return parts.joined(separator: " · ")
    }

    /// A session action by its primitive; a demo session only says it is a demo.
    private func run(_ primitive: String, _ label: String) {
        if store.isDemo(session) { return demo() }
        Task { await store.perform(id: primitive, args: ["sessionId": .string(session.sessionId)], label: label) }
    }

    /// A demo session (`--demo-sessions`, screenshots): there's no process behind it — the action isn't sent.
    private func demo() {
        let presenter = store.presenter
        Task { await presenter?.report(title: tr("Это демо-сессия", "This is a demo session"), detail: tr("Её показал аргумент --demo-sessions для скриншота; процесса за ней нет.", "It was added by --demo-sessions for a screenshot; there's no process behind it.")) }
    }

    /// How long it's been waiting — from the reply card; for others we don't show the age (the hub only knows the time of the last frame).
    private var age: String {
        guard session.isWaiting, let a = store.visibleCards.first(where: { $0.sessionId == session.sessionId })?.age else { return "" }
        return Fmt.duration(a)
    }

    @ViewBuilder private var glyph: some View {
        switch session.status {
        case "waiting": StatusGlyph(status: .wait, size: 20, question: question)
        case "busy": StatusGlyph(status: .ok, size: 20)
        default:
            ZStack { Circle().fill(Color.gray); Image(systemName: "minus").font(.system(size: 10, weight: .heavy)).foregroundStyle(.white) }.frame(width: 20, height: 20)
        }
    }

    /// Go to tab: `session.focus` by the core's "tab found" flag. A demo session (screenshots) — a button for
    /// its tab, without sending.
    private var focusRequest: (primitive: String, args: [String: JSONValue])? {
        if store.isDemo(session) { return terminal?.focusable == true && store.focusPrimitive ? ("session.focus", [:]) : nil }
        return store.focusRequest(sessionId: session.sessionId)
    }

    private func focus(_ req: (primitive: String, args: [String: JSONValue])) {
        if store.isDemo(session) { return demo() }
        Task { await store.perform(id: req.primitive, args: req.args, label: FocusText.action) }
    }
}
