import Foundation
import Testing
@testable import AgentHubKit

// OAuth connections (2026-11-09, the daemon's oauth service): the model from /state, the connections.changed event,
// "Connect" and "Disconnect" via the daemon, ru/en texts. The daemon is the FakeDaemon double (ReviewFixTests.swift).
@Suite(.serialized) struct ConnectionsTests {
    static let connected = #"{"id":"tix","title":"Tix","plugin":"tix","host":"mcp.example.com","state":"connected","since":"2026-11-09T09:00:00.000Z","error":null,"scope":"read","expiresAt":null,"refresh":false,"login":null,"intervalMs":900000,"dailyBudget":100,"calls24h":12,"lastOkAt":"2026-11-09T09:30:00.000Z","nextAt":"2026-11-09T09:45:00.000Z","why":null,"keychain":true,"future":1}"#

    @Test func stateDecodesConnections() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"connections":[\#(Self.connected)]}"#.utf8))
        let c = try #require(st.connections?.first)
        #expect(c.id == "tix" && c.plugin == "tix" && c.isConnected && c.scope == "read")
        #expect(c.canDisconnect && c.canConnect)
        #expect(c.intervalMs == 900000 && c.calls24h == 12)
        // an older daemon has no connections; a malformed field does not break the snapshot
        #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8)).connections == nil)
        #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"connections":"x"}"#.utf8)).connections == nil)
        let un = ConnectionInfo(id: "tix", title: "Tix", state: "unavailable")
        #expect(!un.canConnect && !un.canDisconnect)
        #expect(ConnectionInfo(id: "tix", title: "Tix", state: "expired").canDisconnect)
    }

    @MainActor @Test func connectAndDisconnectGoThroughDaemonAndFollowEvents() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in
            snapshotFrame(1, peer: "app")
                + sseFrame(2, "connections.changed", #"{"id":2,"type":"connections.changed","connections":[{"id":"tix","title":"Tix","plugin":"tix","state":"disconnected"}]}"#)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.connectionInfo(forPlugin: "tix")?.state == "disconnected" })
        let url = await store.startConnect("tix")
        #expect(url?.host == "mcp.example.com")
        #expect(d.requests.contains { $0.method == "POST" && $0.uri == "/connections/tix/connect" })
        #expect(store.connectionInfo("tix")?.isConnecting == true, "the daemon reply is applied right away")
        await store.connectionOp("tix", "disconnect")
        #expect(d.requests.contains { $0.method == "POST" && $0.uri == "/connections/tix/disconnect" })
        #expect(store.connectionInfo("tix")?.state == "disconnected")
    }

    @MainActor @Test func unpinnedBuildCannotConnect() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.peerClass = "cli"
        d.events = { _, _ in snapshotFrame(1, peer: "cli") }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = RecordingPresenter()
        store.presenter = p
        L10n.shared.lang = .ru
        #expect(await store.startConnect("tix") == nil)
        #expect(p.reports.last?.detail.contains("закреплённая сборка") == true)
        L10n.shared.lang = .en
    }

    @Test func textsRuEn() throws {
        let c = try JSONDecoder().decode(ConnectionInfo.self, from: Data(Self.connected.utf8))
        var limited = c
        limited.why = "rate-limit"
        let expired = ConnectionInfo(id: "tix", title: "Tix", state: "expired", error: "invalid-token")
        let off = ConnectionInfo(id: "tix", title: "Tix", state: "disconnected", error: "denied")

        L10n.shared.lang = .ru
        #expect(ConnectionsText.stateLine(c).hasPrefix("Подключён · с "))
        #expect(!ConnectionsText.stateLine(c).contains("только чтение"), "\"read-only\" is not inferred from scope")
        #expect(ConnectionsText.stateLine(expired) == "Вход истёк или доступ отозван — подключите снова")
        #expect(ConnectionsText.connectTitle(off) == "Подключить Tix")
        #expect(ConnectionsText.connectTitle(expired) == "Подключить Tix снова")
        #expect(ConnectionsText.refreshLine(c)?.contains("следующее в") == true)
        #expect(ConnectionsText.refreshLine(c)?.contains("запросов за сутки: 12 из 100") == true)
        #expect(ConnectionsText.refreshLine(limited)?.contains("лимит Tix исчерпан") == true)
        #expect(ConnectionsText.explain(c).contains("не чаще раза в 15 мин"))
        #expect(ConnectionsText.error("denied") == "Вход отменён в браузере — доступ не выдан")
        #expect(ConnectionsText.error("invalid-token") == nil, "an expired one has its own line")
        #expect(ConnectionsText.warns(expired) && !ConnectionsText.warns(c) && ConnectionsText.warns(limited))

        L10n.shared.lang = .en
        #expect(ConnectionsText.stateLine(expired) == "The sign-in expired or access was revoked — reconnect")
        #expect(ConnectionsText.connectTitle(off) == "Connect Tix")
        #expect(ConnectionsText.connectTitle(expired) == "Reconnect Tix")
        #expect(ConnectionsText.refreshLine(limited)?.contains("Tix limit reached") == true)
        #expect(ConnectionsText.explain(c).contains("at most every 15 min"))
        #expect(ConnectionsText.error("oauth:timeout")?.contains("5 minutes") == true)
    }

    // review 2026-11-09: budget from the declaration (the hub does not name the service's plans), discovery reason,
    // "Disconnect" failed, 403, tool error
    @Test func reviewTextsRuEn() throws {
        var c = try JSONDecoder().decode(ConnectionInfo.self, from: Data(Self.connected.utf8))
        L10n.shared.lang = .ru
        #expect(ConnectionsText.explain(c).contains("не больше 100 запросов в сутки"))
        c.dailyBudget = 300
        #expect(ConnectionsText.explain(c).contains("не больше 300 запросов в сутки"))
        #expect(!ConnectionsText.explain(c).contains("тариф"), "the hub does not know the service's plans")
        // review 2026-11-10: what the hub will call is the tool allowlist, not scope (the server may not enforce it)
        #expect(!ConnectionsText.explain(c).contains("Только чтение"), "scope=read is not a read-only promise")
        c.tools = ["get_user", "filter_tasks"]
        #expect(ConnectionsText.explain(c).contains("Только инструменты get_user, filter_tasks"))
        c.tools = ["filter_tasks"]
        #expect(ConnectionsText.toolsLine(c) == "Только инструмент filter_tasks")
        c.tools = nil
        #expect(ConnectionsText.toolsLine(c) == "Только инструменты, объявленные плагином")
        // orphaned: the plugin is gone but the login remains, so only "Disconnect"
        var o = try JSONDecoder().decode(ConnectionInfo.self, from: Data(#"{"id":"tix","title":"Tix","plugin":"tix","orphan":true,"state":"connected"}"#.utf8))
        #expect(o.isOrphan && !o.isConnected && !o.canConnect && o.canDisconnect)
        #expect(ConnectionsText.stateLine(o) == "Плагина больше нет — вход остался в связке ключей")
        o.orphan = nil
        #expect(o.isConnected && !o.isOrphan)
        #expect(ConnectionsText.disconnectExplain(c).contains("на стороне Tix"))
        // discovery: a login settings change is not "check your network"
        #expect(ConnectionsText.error("discovery", title: "Tix", reason: "issuer-url") == "Tix изменил настройки входа — обновите хаб")
        #expect(ConnectionsText.error("discovery", reason: "issuer-url") == "сервис изменил настройки входа — обновите хаб", "without a title, a generic word, not the service name")
        #expect(ConnectionsText.error("oauth:discovery", reason: "no-s256")?.contains("обновите хаб") == true)
        #expect(ConnectionsText.error("discovery", reason: "no-as-metadata")?.contains("проверьте сеть") == true)
        #expect(ConnectionsText.error("discovery")?.contains("проверьте сеть") == true)
        // "Disconnect" failed: its own text, not the write one; the button stays
        #expect(ConnectionsText.error("oauth:keychain-delete") == "Не получилось удалить вход из связки ключей — нажмите «Отключить» ещё раз")
        #expect(ConnectionsText.error("keychain")?.contains("записать") == true)
        #expect(ConnectionInfo(id: "tix", title: "Tix", state: "disconnected", error: "keychain-delete").canDisconnect)
        #expect(ConnectionsText.error("forbidden")?.contains("не даёт этому входу доступ") == true)
        #expect(ConnectionsText.error("keychain-read")?.contains("попробует снова") == true)
        var f = c
        f.why = "forbidden"
        #expect(ConnectionsText.refreshLine(f)?.contains("не дал доступ") == true)
        f.why = "tool-error"
        #expect(ConnectionsText.refreshLine(f)?.contains("вернул ошибку") == true)
        var r = ConnectionInfo(id: "tix", title: "Tix", state: "disconnected", error: "discovery")
        r.errorReason = "resource-mismatch"
        #expect(ConnectionsText.errorDetail(r) == "причина: resource-mismatch")
        L10n.shared.lang = .en
        c.dailyBudget = 300
        #expect(ConnectionsText.explain(c).contains("at most 300 requests a day"))
        #expect(!ConnectionsText.explain(c).contains("plan"))
        #expect(ConnectionsText.error("discovery", title: "Tix", reason: "issuer-url") == "Tix changed its sign-in settings — update the hub")
        #expect(ConnectionsText.error("keychain-delete")?.contains("Disconnect again") == true)
        // errorReason comes from /state
        let st = try JSONDecoder().decode(ConnectionInfo.self, from: Data(#"{"id":"tix","title":"Tix","state":"connected","error":"forbidden","errorReason":"insufficient_scope"}"#.utf8))
        #expect(st.errorReason == "insufficient_scope")
        L10n.shared.lang = .ru
    }

    @MainActor @Test func connectFailureShowsReasonAndAppliesConnection() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in
            snapshotFrame(1, peer: "app")
                + sseFrame(2, "connections.changed", #"{"id":2,"type":"connections.changed","connections":[{"id":"tix","title":"Tix","plugin":"tix","state":"disconnected"}]}"#)
        }
        d.reply = { method, uri in
            method == "POST" && uri == "/connections/tix/connect"
                ? (502, #"{"error":"oauth:discovery","reason":"issuer-url","connection":{"id":"tix","title":"Tix","plugin":"tix","state":"disconnected","error":"discovery","errorReason":"issuer-url"}}"#)
                : nil
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = RecordingPresenter()
        store.presenter = p
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.connectionInfo("tix")?.state == "disconnected" })
        L10n.shared.lang = .ru
        #expect(await store.startConnect("tix") == nil)
        #expect(p.reports.last?.detail == "Tix изменил настройки входа — обновите хаб (issuer-url)")
        #expect(store.connectionInfo("tix")?.errorReason == "issuer-url", "the state from the reply is applied")
        // "Disconnect" failed: the text is about deletion
        d.reply = { method, uri in
            method == "POST" && uri == "/connections/tix/disconnect"
                ? (500, #"{"ok":false,"error":"oauth:keychain-delete","connection":{"id":"tix","title":"Tix","state":"connected","error":"keychain-delete"}}"#)
                : nil
        }
        await store.connectionOp("tix", "disconnect")
        #expect(p.reports.last?.detail.contains("удалить вход") == true)
        L10n.shared.lang = .en
    }
}

// Contract 2: the plugin declares the connection; the title, note and allowlist come from the daemon.
@Suite(.serialized) struct DeclaredConnectionTests {
    @Test func decodesDeclarationFields() throws {
        let c = try JSONDecoder().decode(ConnectionInfo.self, from: Data(#"{"id":"tix","title":"Tix","note":"тикеты, назначенные вам","plugin":"tix","host":"mcp.example.com","tools":["get_user","filter_tasks"],"state":"disconnected"}"#.utf8))
        #expect(c.note == "тикеты, назначенные вам" && c.tools == ["get_user", "filter_tasks"])
        L10n.shared.lang = .ru
        #expect(ConnectionsText.ownerLine(c, pluginTitle: "Тикеты") == "Нужно плагину «Тикеты»: тикеты, назначенные вам")
        #expect(ConnectionsText.ownerLine(c, pluginTitle: nil) == "тикеты, назначенные вам")
        var bare = c
        bare.note = nil
        #expect(ConnectionsText.ownerLine(bare, pluginTitle: "Тикеты") == "Нужно плагину «Тикеты»")
        #expect(ConnectionsText.ownerLine(bare, pluginTitle: " ") == nil)
        L10n.shared.lang = .en
        #expect(ConnectionsText.ownerLine(c, pluginTitle: "Tickets") == "Needed by \"Tickets\": тикеты, назначенные вам")
        L10n.shared.lang = .ru
    }
}
