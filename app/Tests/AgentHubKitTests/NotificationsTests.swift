import Foundation
import Testing
@testable import AgentHubKit

// "Settings → Notifications" (2026-11-09): model from /state, editing via the daemon, the settings.changed event, ru/en texts.
@Suite(.serialized) struct NotificationsTests {
    @Test func stateDecodesNotifications() throws {
        // an older daemon still sends the removed channel flag ("telegram") — ignored
        let json = #"""
        {"seq":1,"notifications":{"enabled":false,"kinds":{"sessions":true,"updates":false},
         "plugins":[{"id":"nightly","title":"Ночной","on":false,"labels":["Готово"],"legacy":true},{"id":"x"},{"title":"без id"}],
         "quiet":{"enabled":true,"start":"22:30","end":"08:00","from":"config"},
         "security":[{"key":"app-pin-changed","plugin":"@hub","label":"Agent Hub закреплён заново"},
                     {"key":"tamper","plugin":"my-runner","pluginTitle":"Прогоны","label":"Маркер подмены"},
                     {"plugin":"broken"}],
         "service":true,"telegram":false}}
        """#
        let st = try JSONDecoder().decode(HubState.self, from: Data(json.utf8))
        let n = try #require(st.notifications)
        #expect(n.enabled == false)
        #expect(n.kindOn("updates") == false)
        #expect(n.kindOn("sessions") == true)
        #expect(n.kindOn("problems") == true, "absent from the reply — on")
        // own plugin toggles are rows from the daemon; a broken record doesn't break the rest
        #expect(n.plugins.map(\.id) == ["nightly", "x"])
        #expect(n.plugins[0] == NotificationsInfo.PluginToggle(id: "nightly", title: "Ночной", on: false, labels: ["Готово"], legacy: true))
        #expect(n.plugins[1].title == "x" && n.plugins[1].on, "no title — the id, no on — enabled")
        #expect(n.pluginOn("nightly") == false && n.pluginOn("нет-такого"))
        #expect(n.quiet == NotificationsInfo.Quiet(enabled: true, start: "22:30", end: "08:00", from: "config"))
        #expect(n.security.map(\.key) == ["app-pin-changed", "tamper"], "a record without a key is dropped")
        // an older daemon — no setting, the section doesn't invent values
        let old = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8))
        #expect(old.notifications == nil)
        // a malformed field doesn't break the whole snapshot
        let bad = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"notifications":"on"}"#.utf8))
        #expect(bad.notifications == nil)
    }

    @MainActor @Test func setNotificationsWritesToDaemonAndFollowsEvents() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in
            snapshotFrame(1, peer: "app")
                + sseFrame(2, "settings.changed", #"{"id":2,"type":"settings.changed","notifications":{"enabled":false,"kinds":{},"quiet":{"enabled":false,"start":"23:00","end":"08:00","from":"settings"},"security":[],"service":true}}"#)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.state?.notifications?.enabled == false })
        #expect(store.state?.notifications?.quiet.enabled == false)
        await store.setNotifications(.object(["plugins": .object(["nightly": .bool(false)])]))
        #expect(d.requests.contains { $0.method == "PUT" && $0.uri == "/settings/notifications" })
        #expect(store.state?.notifications?.pluginOn("nightly") == false)
        #expect(store.state?.notifications?.quiet.start == "22:00")
    }

    @Test func textsRuEn() {
        L10n.shared.lang = .ru
        // contract 2: the core has only generic kinds; everything plugin-specific is plugin toggles from the daemon
        #expect(NotificationsInfo.kinds.map(NotificationsText.kindTitle) == ["Сессии ждут ответа", "Обновления хаба и плагинов", "Сбои и предупреждения плагинов", "Прочее от плагинов"])
        #expect(NotificationsText.pluginsHeader == "По плагинам")
        #expect(NotificationsText.pluginDetail(.init(id: "a", title: "A", labels: ["Один", "Два", "Три", "Четыре", "Пять"])) == "Один; Два; Три; Четыре и ещё 1")
        #expect(NotificationsText.pluginDetail(.init(id: "a", title: "A")) == "Свои уведомления плагина")
        #expect(NotificationsText.securityTitle(.init(key: "app-restart-stopped")) == "Agent Hub падает — перезапуск остановлен")
        #expect(NotificationsText.securityTitle(.init(key: "tamper", plugin: "my-runner", pluginTitle: "Прогоны", label: "Маркер подмены")) == "Прогоны: Маркер подмены")
        #expect(NotificationsText.mutedExplain.contains("поповере"))
        #expect(NotificationsText.quietSource(.init(from: "config"))?.contains("config.json") == true)
        #expect(NotificationsText.quietSource(.init(from: "settings")) == nil)
        #expect(NotificationsText.error("args:quiet:empty")?.contains("совпадают") == true)
        L10n.shared.lang = .en
        #expect(NotificationsInfo.kinds.map(NotificationsText.kindTitle) == ["Sessions waiting for you", "Hub and plugin updates", "Plugin failures and warnings", "Everything else from plugins"])
        #expect(NotificationsText.pluginsHeader == "By plugin")
        #expect(NotificationsText.pluginLegacyNote.contains("earlier notification setting"))
        #expect(NotificationsText.securityTitle(.init(key: "hub-update-tag-moved")) == "Agent Hub release tag moved — possible substitution")
        #expect(NotificationsText.channels(NotificationsInfo()) == "macOS banners.", "an older daemon — no away threshold, no invented number")
        #expect(NotificationsText.kindDetail("updates").contains("own plugin updated from its folder"))
        // every row is distinct in each language
        for k in NotificationsInfo.kinds {
            L10n.shared.lang = .ru
            let ru = (NotificationsText.kindTitle(k), NotificationsText.kindDetail(k))
            L10n.shared.lang = .en
            #expect(ru.0 != NotificationsText.kindTitle(k))
            #expect(ru.1 != NotificationsText.kindDetail(k))
        }
        L10n.shared.lang = .ru
    }

    @Test func timeOptionsKeepCurrentValue() {
        let base = NotificationsText.timeOptions(including: "23:00")
        #expect(base.count == 48)
        #expect(base.first == "00:00" && base.last == "23:30")
        let odd = NotificationsText.timeOptions(including: "22:45")
        #expect(odd.count == 49)
        #expect(odd.firstIndex(of: "22:45") == odd.firstIndex(of: "22:30")! + 1)
        #expect(NotificationsText.timeOptions(including: "nope").count == 48)
    }

    // review 2026-11-09: quiet hours from the route fact, the "away" threshold and the time zone come from the daemon; contract 2 — core texts without
    // plugin names
    @Test func reviewTexts() throws {
        L10n.shared.lang = .ru
        for k in NotificationsInfo.kinds + ["runs", "night"] {
            #expect(NotificationsText.kindDetail(k).range(of: #"(?i)hermes|ночь|ночн|раннер|clickup"#, options: .regularExpression) == nil, "\(k)")
        }
        #expect(NotificationsText.kindTitle("night") == "Прочее от плагинов", "the core doesn't know the old kinds")
        for t in [NotificationsText.securityExplain, NotificationsText.quietExplain] {
            #expect(t.range(of: #"(?i)hermes|ночь|ночн|раннер|clickup"#, options: .regularExpression) == nil)
        }
        #expect(NotificationsText.quietExplain.contains("«Agent Hub падает» — тоже в сводку"))
        #expect(NotificationsText.quietExplain.contains("приходят одной сводкой"))
        #expect(!NotificationsText.quietExplain.contains("исключения безопасности)"))
        #expect(NotificationsText.channels(NotificationsInfo(awayAfterMs: 20 * 60_000)).hasPrefix("Баннеры macOS. Без клавиатуры и мыши дольше 20 мин — вы отошли от Mac"))
        #expect(!NotificationsText.channels(NotificationsInfo()).contains("10"), "an older daemon — no invented number")
        for t in [NotificationsText.channels(NotificationsInfo(awayAfterMs: 60_000)), NotificationsText.quietExplain, NotificationsText.mutedExplain] {
            #expect(t.range(of: #"(?i)telegram"#, options: .regularExpression) == nil, "macOS banners are the only channel")
        }
        #expect(NotificationsText.securityTitle(.init(key: "hub-update-suspect")) == "Обновление Agent Hub остановлено — возможна подмена")
        #expect(NotificationsText.securityTitle(.init(key: "plugin-own-unexpected")) == "Свой плагин записан мимо Agent Hub")
        #expect(NotificationsText.securityExplain.contains("config.json их не переопределяет"))
        #expect(NotificationsText.quietZone(.init(timezone: "Asia/Tokyo"), current: "Europe/Belgrade")?.contains("Asia/Tokyo") == true)
        #expect(NotificationsText.quietZone(.init(timezone: "Europe/Belgrade"), current: "Europe/Belgrade") == nil)
        #expect(NotificationsText.quietZone(.init(), current: "Europe/Belgrade") == nil)
        let n = try JSONDecoder().decode(NotificationsInfo.self, from: Data(#"{"enabled":true,"kinds":{},"quiet":{"enabled":true,"start":"23:00","end":"08:00","from":"default","timezone":"Asia/Tokyo"},"security":[],"service":true,"awayAfterMs":600000}"#.utf8))
        #expect(n.quiet.timezone == "Asia/Tokyo" && n.awayAfterMs == 600_000)
        L10n.shared.lang = .en
        for t in [NotificationsText.securityExplain, NotificationsText.quietExplain] {
            #expect(t.range(of: #"(?i)hermes|night|runner|clickup"#, options: .regularExpression) == nil)
        }
        #expect(NotificationsText.channels(NotificationsInfo(awayAfterMs: 20 * 60_000)).contains("more than 20 min"))
        #expect(NotificationsText.quietExplain.hasPrefix("While you're away from the Mac, during quiet hours banners are held"))
        L10n.shared.lang = .ru
    }
}
