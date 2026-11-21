import AgentHubKit
import AppKit
import SwiftUI

// A plugin's page in the panel.

/// Plugin page: a hero header card in the status tone, the body as lists, offers as capsules,
/// "About the plugin" on the second level.
struct PluginDetailView: View {
    let store: HubStore
    let plugin: PluginState
    private let aboutStore = State(initialValue: false)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                hero
                // background jobs the plugin's actions started (G6): elapsed time and "Stop"
                if !plugin.jobs.isEmpty { PluginJobsCard(store: store, plugin: plugin) }
                // sign-in to a service the plugin declared (<agenthub.connection>): "Connect" right on its page
                PluginConnectionBanner(store: store, pluginId: plugin.id)
                ForEach(Array(ItemTree.blocks(plugin.body).enumerated()), id: \.offset) { _, block in
                    ForEach(Array(ItemTree.segments(block).enumerated()), id: \.offset) { _, seg in segment(seg) }
                }
                // the keys the plugin declares (G8): "Set key…" instead of `security add-generic-password`
                PluginSecretsCard(store: store, pluginId: plugin.id)
                about
            }
            .padding(.bottom, 20)
        }
        .environment(\.pluginAccent, pluginAccent(plugin))
        .environment(\.pluginPageId, plugin.id)
    }

    /// Layout per the prototype: a row of number cards, cards with a bar, a strip, a list.
    @ViewBuilder private func segment(_ seg: BlockSegment) -> some View {
        switch seg {
        case .stats(let nodes):
            HStack(alignment: .top, spacing: 12) { ForEach(nodes) { StatCard(item: $0.item) } }
        case .gauges(let nodes):
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)], spacing: 12) {
                ForEach(nodes) { GaugeCard(store: store, node: $0) }
            }
        case .strip(let node):
            StripCard(store: store, node: node)
        case .controls(let nodes):
            ControlsGrid(store: store, nodes: nodes)
                .padding(.horizontal, 16).padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
        case .table(let node):
            PluginTableView(store: store, node: node, card: true)
        case .chart(let node):
            PluginChartView(store: store, node: node, card: true)
        case .list(let nodes):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(nodes.enumerated()), id: \.offset) { i, node in
                    if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                    BlockNode(store: store, node: node, depth: 0).padding(.horizontal, 14).padding(.vertical, 9)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
        }
    }

    @ViewBuilder private var hero: some View {
        if let first = plugin.header.first(where: { !$0.separator }), !first.spark.isEmpty {
            sparkHero(first)
        } else {
            plainHero
        }
    }

    /// The header with `spark=` (Main.dc.html, design A): `stat=` as the caption, the tile value large in the plugin's
    /// color, `note=` (or the headline) and the other header lines under it; the sparkline on the right with
    /// `sparkLabel=`/`sparkNote=` above it and the dashed `sparkAvg=` line. The status line shows only when it is not ok.
    private func sparkHero(_ first: Item) -> some View {
        let c = plugin.status.color
        let accent = pluginAccent(plugin)
        let rest = plugin.header.dropFirst().filter { !$0.separator && $0.offer == nil }
        let offers = plugin.header.compactMap { it in it.offer.map { (it, $0) } }
        let value = plugin.tileValue
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 26) {
                VStack(alignment: .leading, spacing: 5) {
                    if let cap = first.stat {
                        Text(cap).font(.system(size: 13)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                            .reportsTruncation(cap, font: .system(size: 13))
                    }
                    Group {
                        // `until=`: the large value counts down to the moment (G18)
                        if let until = first.until {
                            CountdownText(until: until, font: .system(size: 44, weight: .bold))
                        } else {
                            Text(value).font(.system(size: 44, weight: .bold))
                        }
                    }
                    .tracking(-0.5)
                    .foregroundStyle(plugin.status == .ok ? accent : .white)
                    .lineLimit(1).minimumScaleFactor(0.5)
                    let sub = first.note ?? plugin.headline
                    Text(sub).font(.system(size: 13)).foregroundStyle(.white.opacity(0.78))
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        .reportsTruncation(sub, font: .system(size: 13))
                    ForEach(Array(rest.enumerated()), id: \.offset) { _, it in
                        Text(it.title).font(it.isMono ? .system(size: 12, design: .monospaced) : .system(size: 12)).foregroundStyle(.white.opacity(0.52)).lineLimit(2)
                            .reportsTruncation(it.title, font: .system(size: 12))
                            .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
                    }
                    if plugin.status != .ok {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            StatusGlyph(status: plugin.status, size: 13).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                            Text(plugin.statusLabel()).font(.system(size: 12, weight: .semibold)).fixedSize()
                            Text("· \(plugin.statusHint())").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).lineLimit(2)
                        }
                        .hoverHelp(PluginText.help(plugin.statusLabel(), plugin.statusHint()))
                    }
                    if plugin.status == .error, let err = plugin.error {
                        Text(tr("Сбой плагина: \(err)", "Plugin failure: \(err)")).font(.system(size: 12)).foregroundStyle(hexColor(0xFF8A80))
                    }
                }
                .frame(minWidth: 220, maxWidth: 300, alignment: .leading)
                .layoutPriority(1)
                .hoverHelp(PluginText.help(tooltip: first.tooltip, plugin.headline), always: first.tooltip != nil)
                VStack(alignment: .leading, spacing: 8) {
                    if first.sparkLabel != nil || first.sparkNote != nil {
                        HStack {
                            Text(first.sparkLabel ?? "").lineLimit(1)
                            Spacer(minLength: 8)
                            Text(first.sparkNote ?? "").lineLimit(1)
                        }
                        .font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                    }
                    SparkBars(values: first.spark, avg: first.sparkAvg, highlight: accent, spacing: 5, radius: 3, showAverage: true, fixedTop: first.sparkMax)
                        .frame(height: 86)
                }
                .frame(maxWidth: .infinity)
                Button { Task { await store.refresh(plugin: plugin.id) } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(CapsuleStyle(height: 28, expand: false))
                    .tip(tr("Обновить плагин", "Refresh plugin"))
                    .frame(maxHeight: .infinity, alignment: .top)
            }
            .fixedSize(horizontal: false, vertical: true)
            if !offers.isEmpty {
                HStack { ForEach(Array(offers.enumerated()), id: \.offset) { _, o in OfferButton(store: store, item: o.0, offer: o.1) } }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(plugin.status == .ok ? Color.white.opacity(0.06) : c.opacity(0.16)))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(plugin.status == .ok ? Color.white.opacity(0.1) : c.opacity(0.35), lineWidth: 0.5))
    }

    private var plainHero: some View {
        let c = plugin.status.color
        let first = plugin.header.first { !$0.separator }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 14) {
                if let g = first?.gauge {
                    GaugeRing(percent: g, value: plugin.tileValue, caption: first?.gaugeLabel, color: plugin.status == .ok ? hexColor(0x0A84FF) : c)
                } else {
                    PluginTile(id: plugin.id, sfimage: plugin.header.first?.sfImage, size: 44, radius: 12)
                }
                VStack(alignment: .leading, spacing: 4) {
                    // the title isn't truncated with an ellipsis: it wraps (up to three lines), the column takes the full width
                    // full text in a tooltip: the title is truncated after three lines, the explanation after two
                    Text(plugin.headline).font(.system(size: 17, weight: .bold, design: first?.isMono == true ? .monospaced : .default))
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        .reportsTruncation(plugin.headline, font: .system(size: 17, weight: .bold, design: first?.isMono == true ? .monospaced : .default))
                        .hoverHelp(PluginText.help(plugin.headline))
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        StatusGlyph(status: plugin.status, size: 14).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                        Text(plugin.statusLabel()).font(.system(size: 12, weight: .semibold)).fixedSize()
                        Text("· \(plugin.statusHint())").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                            .reportsTruncation("· \(plugin.statusHint())", font: .system(size: 12))
                    }
                    .hoverHelp(PluginText.help(plugin.statusLabel(), plugin.statusHint()))
                    // `until=`: a live countdown to the moment (G18)
                    if let until = first?.until {
                        HStack(spacing: 5) {
                            Image(systemName: "timer").font(.system(size: 12))
                            CountdownText(until: until, font: .system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(pluginAccent(plugin))
                    }
                    let rest = plugin.header.dropFirst().filter { !$0.separator && $0.offer == nil }
                    ForEach(Array(rest.enumerated()), id: \.offset) { _, it in
                        Text(it.title).font(it.isMono ? .system(size: 12, design: .monospaced) : .system(size: 12)).foregroundStyle(.white.opacity(0.7)).lineLimit(3)
                            .reportsTruncation(it.title, font: .system(size: 12))
                            .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
                    }
                    if plugin.status == .error, let err = plugin.error {
                        Text(tr("Сбой плагина: \(err)", "Plugin failure: \(err)")).font(.system(size: 12)).foregroundStyle(hexColor(0xFF8A80))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                Button { Task { await store.refresh(plugin: plugin.id) } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(CapsuleStyle(height: 28, expand: false))
                    .tip(tr("Обновить плагин", "Refresh plugin"))
            }
            let offers = plugin.header.compactMap { it in it.offer.map { (it, $0) } }
            if !offers.isEmpty {
                HStack { ForEach(Array(offers.enumerated()), id: \.offset) { _, o in OfferButton(store: store, item: o.0, offer: o.1) } }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(plugin.status == .ok ? Color.white.opacity(0.06) : c.opacity(0.16)))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(plugin.status == .ok ? Color.white.opacity(0.1) : c.opacity(0.35), lineWidth: 0.5))
    }

    private var about: some View {
        RowDisclosure(isExpanded: aboutStore.projectedValue) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                row(tr("Уровень", "Tier"), plugin.tier.label)
                if let v = plugin.version { row(tr("Версия", "Version"), v) }
                if let a = plugin.author {
                    GridRow {
                        Text(tr("Автор", "Author")).foregroundStyle(.secondary)
                        AuthorLine(author: a)
                    }
                }
                row(tr("Обновляется", "Refreshes"), refreshText)
                if !plugin.effects.isEmpty { row(tr("Может", "Can"), plugin.effects.map(effectText).joined(separator: ", ")) }
                if !plugin.actions.isEmpty { row(tr("Свои команды", "Own commands"), plugin.actions.map { "\($0.title ?? $0.id) (\(levelText($0.level)))" }.joined(separator: "; ")) }
                if let t = plugin.lastRunAt, let d = parseDate(t) { row(tr("Последний запуск", "Last run"), Fmt.dateTime(d)) }
                row("id", plugin.id)
                if let f = plugin.file { row(tr("Файл", "File"), f) }
                if !plugin.events.isEmpty { row(tr("События", "Events"), plugin.events.joined(separator: ", ")) }
            }
            .font(.system(size: 11.5))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
        } label: {
            Text(tr("О плагине", "About this plugin")).font(.system(size: 12, weight: .semibold))
        }
        .padding(.horizontal, 4)
    }

    private var refreshText: String {
        if plugin.type == "streamable" { return tr("постоянно", "live") }
        if let s = plugin.schedule { return tr("по расписанию \(s)", "on schedule \(s)") }
        if let i = plugin.interval { return RefreshInterval.text(i) }
        return tr("по запросу", "on demand")
    }

    private func effectText(_ e: String) -> String {
        switch e {
        case "terminal.focus", "cmux.focus", "session.focus": return tr("перейти во вкладку", "go to tab")
        case "session.interrupt": return tr("прервать ход", "interrupt the turn")
        case "session.stop": return tr("остановить сессию", "stop session")
        case "open.url": return tr("открыть ссылку", "open link")
        case "open.file": return tr("открыть файл", "open file")
        case "open.*": return tr("открыть ссылку или файл", "open link or file")
        default: return e
        }
    }

    private func levelText(_ l: ActionLevel) -> String {
        switch l {
        case .immediate: return tr("сразу", "immediately")
        case .confirm: return tr("спросит подтверждения", "asks first")
        case .confirmCost: return tr("спросит подтверждения: тратит квоту или сеть", "asks first: uses quota or network")
        case .unknown: return "?"
        }
    }

    private func parseDate(_ s: String) -> Date? { ISODate.parse(s) }

    private func row(_ k: String, _ v: String) -> some View {
        GridRow {
            Text(k).foregroundStyle(.secondary)
            Text(v).textSelection(.enabled)
        }
    }
}
