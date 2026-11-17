import AgentHubKit
import AppKit
import SwiftUI

// The "Journal" section of the panel.

struct JournalView: View {
    let store: HubStore
    let search: String
    private let onlyActionsStore = State(initialValue: true)
    private let expandedStore = State<String?>(initialValue: nil)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(tr("Только метаданные: кто, что, для какой сессии, результат. Без текста команд и переписки.", "Metadata only: who, what, which session, result. No command text or conversation."))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                Spacer()
                Toggle(tr("только действия", "actions only"), isOn: onlyActionsStore.projectedValue).toggleStyle(.switch).controlSize(.mini).font(.system(size: 12))
                Button { Task { await store.loadJournal() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(CapsuleStyle(height: 26, expand: false))
            }
            if let e = store.journalError { Text(e).font(.caption).foregroundStyle(.red) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(entries) { e in
                        Button { expandedStore.wrappedValue = expandedStore.wrappedValue == e.id ? nil : e.id } label: { row(e) }.buttonStyle(.plain)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.black.opacity(0.22)))
                .clipShape(RoundedRectangle(cornerRadius: 16))
            }
        }
        .task { await store.loadJournal() }
    }

    private var entries: [JournalEntry] {
        let q = search.lowercased()
        return store.journal.filter { e in
            (!onlyActionsStore.wrappedValue || e.isAction) && (q.isEmpty || e.typeLabel.lowercased().contains(q) || e.type.contains(q) || e.summary.lowercased().contains(q))
        }
    }

    private func row(_ e: JournalEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                // the time column — by the language's longest string ("10:58:58 PM" in English, "22:58:58" in Russian):
                // an entry on one line, not "9:57:24 / PM"
                ZStack(alignment: .leading) {
                    Text(verbatim: Self.timeTemplate()).hidden()
                    Text(shortTime(e.ts)).foregroundStyle(.white.opacity(0.5))
                }
                .lineLimit(1).fixedSize().frame(minWidth: 64, alignment: .leading)
                // the name column — 230 pt if there's a target; no target — the name takes its place too (not truncated needlessly)
                let target = e.target
                if target.isEmpty {
                    Text(e.typeLabel).foregroundStyle(hexColor(0x8EC5FF)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(e.typeLabel).foregroundStyle(hexColor(0x8EC5FF)).frame(width: 230, alignment: .leading).lineLimit(1)
                    Text(target).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                    Spacer(minLength: 6)
                }
                if let r = e.result { Text(r.text).foregroundStyle(r.ok ? hexColor(0x7EE29B) : hexColor(0xFF8A80)).lineLimit(1) }
            }
            if expandedStore.wrappedValue == e.id {
                Text("\(e.type) · \(e.summary)").foregroundStyle(.white.opacity(0.55)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.horizontal, 14).padding(.vertical, 9)
        .contentShape(Rectangle())
    }

    /// The widest time string in the current language — the sample for the column width.
    static func timeTemplate() -> String {
        var c = DateComponents()
        c.year = 2026; c.month = 1; c.day = 1; c.hour = 22; c.minute = 58; c.second = 58
        let d = Calendar(identifier: .gregorian).date(from: c) ?? Date()
        return d.formatted(.dateTime.hour().minute().second().locale(L10n.shared.locale))
    }

    private func shortTime(_ ts: String?) -> String {
        guard let ts else { return "" }
        // one shared formatter for every row (`ISODate`), not a new one per row
        guard let d = ISODate.parse(ts) else { return ts }
        return d.formatted(.dateTime.hour().minute().second().locale(L10n.shared.locale))
    }
}
