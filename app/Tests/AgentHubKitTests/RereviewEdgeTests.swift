import Foundation
import Testing
@testable import AgentHubKit

// Re-review 2026-11-12 (tasks 62, 70, 74): the app side.
@Suite(.hubLang(.ru)) struct RereviewEdgeTests {
    // 62: a test's language is its own — the macOS language and other suites can't change it.
    @Test func languageIsScopedPerTestCase() async {
        #expect(L10n.shared.lang == .ru && tr("да", "yes") == "да", "the trait's language, not the macOS one")
        L10n.shared.lang = .en
        #expect(tr("да", "yes") == "yes")
        // parallel test-like tasks each with a scope of their own never see each other's language
        await withTaskGroup(of: Bool.self) { g in
            for i in 0..<16 {
                let want: Lang = i.isMultiple(of: 2) ? .ru : .en
                g.addTask {
                    await L10n.$scope.withValue(LangScope(want)) {
                        for _ in 0..<50 {
                            L10n.shared.lang = want
                            await Task.yield()
                            if L10n.shared.lang != want || tr("ru", "en") != want.rawValue { return false }
                        }
                        return true
                    }
                }
            }
            for await ok in g { #expect(ok) }
        }
        #expect(L10n.shared.lang == .en, "the children's writes stayed in their scopes")
        // an instance of its own is never redirected to the scope
        let own = L10n()
        own.lang = .ru
        #expect(own.lang == .ru && L10n.shared.lang == .en)
    }

    @Test(.hubLang(.en)) func aTestCanAskForEnglish() {
        #expect(tr("да", "yes") == "yes" && L10n.shared.locale.identifier == "en_US")
    }

    // 70: channels in /state.notifications — names and kinds only; the external ones listed in Settings → Notifications.
    @Test func notificationChannelsDecodeAndRead() throws {
        let n = try JSONDecoder().decode(NotificationsInfo.self, from: Data(#"""
        {"enabled":true,"kinds":{},"plugins":[],"quiet":{"enabled":true,"start":"23:00","end":"08:00"},"security":[],"service":true,
         "channels":[{"id":"mac","type":"mac","label":"macOS","security":true,"events":null},
                     {"id":"ntfy-1","type":"ntfy","label":"Phone","security":false,"events":null},
                     {"id":"ops","type":"webhook","label":"webhook","security":true,"events":["mail:*","problems"]},
                     {"type":"webhook"}, 42]}
        """#.utf8))
        #expect(n.channels.map(\.id) == ["mac", "ntfy-1", "ops"], "a broken row is dropped, the rest stay")
        #expect(n.externalChannels.map(\.id) == ["ntfy-1", "ops"])
        #expect(NotificationsText.channels(n) == "Баннеры macOS и ещё 2 канала — список ниже.")
        #expect(NotificationsText.channelRow(n.externalChannels[0]) == "Phone (ntfy) — всё")
        #expect(NotificationsText.channelRow(n.externalChannels[1]) == "ops (webhook) — только: mail:*, problems · и исключения безопасности")
        #expect(NotificationsText.externalExplain.contains("macOnly"))
        L10n.shared.lang = .en
        #expect(NotificationsText.channels(n) == "macOS banners and 2 more channels — listed below.")
        #expect(NotificationsText.channelRow(n.externalChannels[1]) == "ops (webhook) — only: mail:*, problems · security exceptions too")
        #expect(NotificationsText.externalHeader == "Also sent off this Mac")
        // an older daemon: no channels, the old line
        let old = try JSONDecoder().decode(NotificationsInfo.self, from: Data(#"{"enabled":true}"#.utf8))
        #expect(old.channels.isEmpty && NotificationsText.channels(old) == "macOS banners.")
    }

    // 74: font=mono on a table row (its cells follow the row) and on a button child is read from the item.
    @Test func monoReachesTableRowsAndButtons() throws {
        let list = try JSONDecoder().decode([Item].self, from: Data(#"""
        [{"title":"Sessions","level":0,"params":{"table":"true","columns":"Tab¦Hash"}},
         {"title":"alpha","level":1,"params":{"cells":"3f9a2c1","font":"mono"}},
         {"title":"Copy 3f9a2c1","level":2,"params":{"font":"mono"},"offer":{"id":"c","kind":"action","action":"copy","level":"immediate"}},
         {"title":"beta","level":1,"params":{"cells":"77aa01e"}}]
        """#.utf8))
        let t = PluginTable(ItemTree.build(list)[0])
        guard case .row(let alpha) = t.entries[0], case .row(let beta) = t.entries[1] else { Issue.record("entries"); return }
        #expect(alpha.item.isMono && alpha.cells == ["3f9a2c1"])
        #expect(alpha.slot.map(\.item.isMono) == [true])
        #expect(!beta.item.isMono)
    }
}
