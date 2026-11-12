import AgentHubKit
import AppKit
import SwiftUI

/// "Connections" in "Settings": services declared by installed plugins (`<agenthub.connection>`, contract
/// 2) — login and approval happen on the service's site, the hub keeps the login in the keychain and makes requests itself. Here —
/// the state, "Connect", "Cancel", "Disconnect". No plugin — no row. Only the pinned build can change it
/// (daemon routes — app class only).
struct ConnectionsSettings: View {
    let store: HubStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(tr("Подключения", "Connections")).font(.system(size: 13, weight: .semibold))
            if let list = store.state?.connections, !list.isEmpty {
                ForEach(list) { c in ConnectionCard(store: store, conn: c, place: .settings) }
            } else if store.state?.connections != nil {
                Text(tr("Ни один установленный плагин не объявил подключение к сервису. Подключение появится здесь вместе с плагином, которому оно нужно.",
                        "No installed plugin declares a service connection. A connection shows up here together with the plugin that needs it."))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(store.state == nil ? tr("Нет данных от хаба", "No data from the hub")
                     : tr("Служба подключений хаба выключена или хаб старше этой настройки — обновите хаб", "The hub's connections service is off, or the hub predates it — update the hub"))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A connection as a single row with buttons: in "Settings" and on the page of the plugin it provides data to.
struct ConnectionCard: View {
    enum Place { case settings, plugin }

    let store: HubStore
    let conn: ConnectionInfo
    let place: Place
    // @State without a macro: Command Line Tools lack the SwiftUIMacros plugin (like aboutStore in PanelView)
    private let busyState = State(initialValue: false)
    private let urlState = State<URL?>(initialValue: nil)
    private let askState = State(initialValue: false)
    private var busy: Bool { busyState.wrappedValue }
    private var lastURL: URL? { urlState.wrappedValue }

    private var tone: Color {
        if conn.isOrphan { return .gray }
        switch conn.state {
        case "connected": return conn.why == nil ? .green : .orange
        case "connecting": return hexColor(0x4DA3FF)
        case "expired": return hexColor(0xFF6B6B)
        default: return .gray
        }
    }

    /// Why the button is disabled (tooltip); nil — it's enabled.
    private var block: String? {
        if !store.connection.isLive { return ActionBlock.offline.help }
        if !store.canAct { return ActionBlock.notPinned.help }
        if !conn.canConnect { return ConnectionsText.stateLine(conn) }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Circle().fill(tone).frame(width: 8, height: 8)
                Text(place == .settings ? conn.title : tr("Вход в \(conn.title)", "\(conn.title) sign-in")).font(.system(size: 12.5, weight: .semibold))
                Text(ConnectionsText.stateLine(conn)).font(.system(size: 12))
                    .foregroundStyle(conn.isExpired ? hexColor(0xFF6B6B) : .white.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let e = ConnectionsText.error(conn.error, title: conn.title, reason: conn.errorReason) {
                Text(e).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                if let d = ConnectionsText.errorDetail(conn) {
                    Text(d).font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let r = ConnectionsText.refreshLine(conn) {
                Text(r).font(.system(size: 11.5)).foregroundStyle(conn.why == nil ? .white.opacity(0.55) : hexColor(0xFFC56B))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if place == .settings, !conn.isOrphan, let who = ownerLine {
                Text(who).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) { buttons }
            Text(conn.isOrphan ? ConnectionsText.orphanExplain(conn) : conn.isConnected ? ConnectionsText.disconnectExplain(conn) : ConnectionsText.explain(conn))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        }
        .confirmationDialog(tr("Отключить \(conn.title)?", "Disconnect \(conn.title)?"), isPresented: askState.projectedValue) {
            Button(ConnectionsText.disconnectTitle, role: .destructive) { run { await store.connectionOp(conn.id, "disconnect") } }
            Button(ConnectionsText.cancelTitle, role: .cancel) {}
        } message: {
            Text(ConnectionsText.disconnectExplain(conn))
        }
    }

    /// Who declared the connection and why — in "Settings" (on the plugin page it's visible anyway).
    private var ownerLine: String? {
        let title = conn.plugin.flatMap { id in store.state?.plugins.first { $0.id == id }?.title } ?? conn.plugin
        return ConnectionsText.ownerLine(conn, pluginTitle: title)
    }

    @ViewBuilder private var buttons: some View {
        if conn.isConnecting {
            Button(ConnectionsText.cancelTitle) { run { await store.connectionOp(conn.id, "cancel") } }
                .buttonStyle(CapsuleStyle(height: 26, expand: false)).disabled(busy || block != nil)
            if let url = lastURL {
                Button(ConnectionsText.openAgainTitle) { NSWorkspace.shared.open(url) }
                    .buttonStyle(CapsuleStyle(height: 26, expand: false))
            }
            ProgressView().controlSize(.small)
        } else {
            if !conn.isConnected && !conn.isOrphan {
                Button {
                    run {
                        if let url = await store.startConnect(conn.id) {
                            urlState.wrappedValue = url
                            NSWorkspace.shared.open(url)
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "link.badge.plus")
                        Text(ConnectionsText.connectTitle(conn))
                    }
                }
                .buttonStyle(CapsuleStyle(height: 26, expand: false))
                .disabled(busy || block != nil)
                .help(block ?? "")
            }
            if conn.canDisconnect {
                Button(ConnectionsText.disconnectTitle) { askState.wrappedValue = true }
                    .buttonStyle(CapsuleStyle(height: 26, expand: false))
                    .disabled(busy || !store.connection.isLive || !store.canAct)
                    .help(!store.canAct ? ActionBlock.notPinned.help : "")
            }
            if busy { ProgressView().controlSize(.small) }
        }
    }

    private func run(_ op: @escaping () async -> Void) {
        busyState.wrappedValue = true
        Task {
            await op()
            busyState.wrappedValue = false
        }
    }
}

/// On a plugin page: if the plugin declared a connection — a card with it above the content.
struct PluginConnectionBanner: View {
    let store: HubStore
    let pluginId: String

    var body: some View {
        // every connection the plugin declares, in declaration order (not just the first)
        ForEach(store.connectionInfos(forPlugin: pluginId), id: \.id) { c in
            ConnectionCard(store: store, conn: c, place: .plugin)
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(c.isExpired ? hexColor(0xFF6B6B, 0.5) : Color.white.opacity(0.09), lineWidth: c.isExpired ? 1 : 0.5))
        }
    }
}
