import AgentHubKit
import AppKit
import SwiftUI

/// The "Safe to shut down?" card above the popover tiles (mockup F): the daemon's verdict from `/state.idle` (`IdleCard` in
/// AgentHubKit decides the texts and which rows are visible). Green — yes, orange — yes with a caveat, blue — too early.
/// Collapsed — at most four blocker rows (one from a plugin) and "N more"; tapping expands it in place rather than
/// taking you to the panel.
/// An expanded list taller than the screen space scrolls inside the card: the popover doesn't grow past the screen.
/// No connection, or a daemon without the idle service — no card.
struct IdleVerdictCard: View {
    let store: HubStore
    let router: PanelRouter
    // @State in the macOS 27 SDK is a macro (SwiftUIMacros only ship with Xcode): storage is declared explicitly.
    private let expandedStore = State(initialValue: LaunchOptions.current.idleExpanded)
    private var expanded: Bool { get { expandedStore.wrappedValue } nonmutating set { expandedStore.wrappedValue = newValue } }
    private let rowsHeightStore = State<CGFloat>(initialValue: 0)
    private var rowsHeight: CGFloat { get { rowsHeightStore.wrappedValue } nonmutating set { rowsHeightStore.wrappedValue = newValue } }

    var body: some View {
        if store.connection.isLive, let v = store.state?.idle {
            let card = IdleCard.make(v, expanded: expanded)
            let accent = Self.accent(card.tone)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: "power")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(card.tone == .blue ? Color.white : Color.black)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(accent.opacity(0.9)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.title).font(.system(size: 14, weight: .bold)).lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(card.subtitle).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !card.rows.isEmpty || card.checkedLine != nil {
                    VStack(alignment: .leading, spacing: 6) {
                        if card.collapsible {
                            // expanded: rows scroll inside the card if they don't fit on screen
                            ScrollView(.vertical) {
                                rows(card).background(GeometryReader { g in
                                    Color.clear.preference(key: IdleRowsHeight.self, value: g.size.height)
                                })
                            }
                            .scrollIndicators(.automatic)
                            .frame(height: min(max(rowsHeight, 1), Self.rowsLimit))
                            .onPreferenceChange(IdleRowsHeight.self) { h in
                                MainActor.assumeIsolated { rowsHeight = h }
                            }
                        } else {
                            rows(card)
                        }
                        if card.hidden > 0 {
                            Button { expanded = true } label: {
                                rowLabel(glyph: "…", color: .white.opacity(0.6), text: IdleCard.moreLabel(card.hidden), textColor: accent.opacity(0.95))
                            }
                            .buttonStyle(.plain)
                            .help(tr("Показать все строки здесь", "Show all rows here"))
                        }
                        if card.collapsible {
                            Button { expanded = false } label: {
                                rowLabel(glyph: "⌃", color: .white.opacity(0.6), text: IdleCard.collapseLabel, textColor: accent.opacity(0.95))
                            }
                            .buttonStyle(.plain)
                        }
                        if let line = card.checkedLine {
                            rowLabel(glyph: "✓", color: hexColor(0x30D158, 0.75), text: line, textColor: .white.opacity(0.5))
                        }
                    }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(accent.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(accent.opacity(0.35), lineWidth: 0.5))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(card.title). \(card.subtitle)")
        }
    }

    @ViewBuilder private func rows(_ card: IdleCard) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(card.rows) { r in
                // an info row (awaiting a reply) is calmer than a blocker: grey dot and dimmed text
                let label = rowLabel(glyph: Self.glyph(r.mark), color: Self.glyphColor(r.mark),
                                     text: r.text, textColor: .white.opacity(r.mark == .info ? 0.62 : 0.86))
                if let t = r.target, let section = PanelSection(argument: t) {
                    Button { router.open(section) } label: { label }
                        .buttonStyle(.plain)
                        .help(r.hint.map { "\($0). " + tr("Открыть в панели", "Open in panel") }
                              ?? r.plugin.map { tr("От плагина «\($0)» — открыть в панели", "From the \($0) plugin — open in panel") } ?? tr("Открыть в панели", "Open in panel"))
                } else {
                    label.help(r.hint ?? r.plugin.map { tr("От плагина «\($0)»", "From the \($0) plugin") } ?? "")
                }
            }
        }
    }

    private func rowLabel(glyph: String, color: Color, text: String, textColor: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(glyph).font(.system(size: 12, weight: .bold)).foregroundStyle(color).frame(width: 16)
            Text(text).font(.system(size: 12)).foregroundStyle(textColor).lineSpacing(1.5)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
    }

    /// ● work, ! computer needed, ? hub doesn't know (sessions plugin didn't answer, participant failed), ○ info (awaiting
    /// a reply — it can be answered after power-on too).
    static func glyph(_ mark: IdleCard.Mark) -> String {
        switch mark {
        case .busy: return "●"
        case .attention: return "!"
        case .unknown: return "?"
        case .info: return "○"
        }
    }

    static func glyphColor(_ mark: IdleCard.Mark) -> Color {
        switch mark {
        case .busy: return hexColor(0x0A84FF)
        case .info: return .white.opacity(0.5)
        case .attention, .unknown: return hexColor(0xFF9F0A)
        }
    }

    static func accent(_ tone: IdleCard.Tone) -> Color {
        switch tone {
        case .green: return hexColor(0x30D158)
        case .orange: return hexColor(0xFF9F0A)
        case .blue: return hexColor(0x0A84FF)
        }
    }

    /// How much space the expanded card's rows get: the screen minus the rest of the popover (header, tiles, "Waiting for you", capsules).
    static var rowsLimit: CGFloat {
        let screen = NSScreen.main?.visibleFrame.height ?? 800
        return max(140, screen - 560)
    }
}

private struct IdleRowsHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
