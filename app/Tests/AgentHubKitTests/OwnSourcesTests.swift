import Foundation
import Testing
@testable import AgentHubKit

// Own plugins from local folders (2026-11-09): the "own · <path>" label, folder state, requests and "Add from folder…"
// (request → consent window from the daemon → consent by token), the consent window for an own source and a migration, "Requires …" in
// the catalog. The daemon is the FakeDaemon double (ReviewFixTests.swift).

/// Request counter for the double (the response closure is @Sendable).
final class Hits: @unchecked Sendable {
    private let lock = NSLock()
    private var n: [String: Int] = [:]
    func next(_ k: String) -> Int { lock.withLock { n[k, default: 0] += 1; return n[k]! } }
}

@MainActor
final class ConsentRecorder: ConfirmPresenter {
    var consents: [ConsentRequest] = []
    var reports: [(title: String, detail: String)] = []
    var agree = true
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool { false }
    func report(title: String, detail: String) { reports.append((title, detail)) }
    func consent(_ request: ConsentRequest) async -> Bool { consents.append(request); return agree }
}

@Suite(.serialized, .hubLang(.ru)) struct OwnSourcesTests {
    static let installed = #"""
    {"installed":[{"id":"my-runner","title":"Прогоны","version":"0.6.0","tier":"own","official":false,"source":"installed","updateAvailable":true,
      "permissions":[],"own":{"path":"/Users/k/src/my-runner/agenthub/my-runner","pathShort":"~/src/my-runner/agenthub/my-runner",
      "status":"update","error":null,"errors":[],"checkedAt":"2026-11-09T10:00:00Z","fingerprint":"ab","next":{"version":"0.6.1","fingerprint":"cd"},
      "growth":[{"kind":"fsRead","what":"~/x","why":"зачем","added":false}]}},
     {"id":"hermes","title":"Hermes","version":"1.2.2","tier":"official","official":true,"source":"installed","permissions":[]}],
     "local":[],
     "requests":[{"requestId":"r1","id":"tool","title":"Инструмент","version":"1.0.0","path":"/Users/k/tool/agenthub/tool","pathShort":"~/tool/agenthub/tool",
      "fingerprint":"ff","permissions":3,"update":false,"migrate":null,"createdAt":"2026-11-09T10:00:00Z"}]}
    """#

    @Test func installedDecodesOwnSourceAndRequests() throws {
        L10n.shared.lang = .ru
        let r = try JSONDecoder().decode(RegistryInstalled.self, from: Data(Self.installed.utf8))
        let own = try #require(r.installed.first?.own)
        #expect(r.installed[0].tier == .own && r.installed[0].tier.removable)
        #expect(own.status == "update" && own.nextVersion == "0.6.1" && own.growth.count == 1)
        #expect(own.shownPath == "~/src/my-runner/agenthub/my-runner")
        #expect(own.statusText?.contains("0.6.1") == true)
        #expect(r.installed[1].own == nil && r.installed[1].tier == .official)
        #expect(r.requests.map(\.requestId) == ["r1"] && r.requests[0].shownPath == "~/tool/agenthub/tool")
        // older daemon — no requests, no own plugins
        #expect(try JSONDecoder().decode(RegistryInstalled.self, from: Data(#"{"installed":[],"local":[]}"#.utf8)).requests.isEmpty)
        // tier label
        #expect(PluginTier.own.label == "свой")
        #expect(PluginTier(tier: "own", source: "installed", official: false) == .own)
        L10n.shared.lang = .en
        #expect(PluginTier.own.label == "own")
        L10n.shared.lang = .ru
    }

    @Test func ownStatusTexts() {
        L10n.shared.lang = .ru
        #expect(OwnSourceInfo(status: "ok").statusText == nil)
        #expect(OwnSourceInfo(status: "missing").statusText == "Папки нет — работает последняя установленная копия")
        #expect(OwnSourceInfo(status: "missing").isProblem)
        let broken = OwnSourceInfo(status: "broken", error: "own:lint", errors: ["нет README.md"])
        #expect(broken.statusText == "Папка не проходит проверку — работает последняя установленная копия: нет README.md")
        #expect(OwnSourceInfo(status: "broken", error: "own:moved").reason?.contains("ссылка") == true)
        #expect(OwnSourceInfo(status: "paused").statusText?.contains("паузу") == true)
        L10n.shared.lang = .en
        #expect(OwnSourceInfo(status: "missing").statusText == "The folder is gone — the last installed copy keeps running")
        L10n.shared.lang = .ru
    }

    @Test func consentForOwnSourceAndMigration() throws {
        L10n.shared.lang = .ru
        let json = #"""
        {"error":"consent-required","needsConsent":true,"token":"t1","expiresInMs":120000,"id":"my-runner","title":"Прогоны","tier":"own","version":"0.6.0",
         "fromVersion":"0.5.2","update":true,"sha256":"0123456789abcdef0123","permissions":[],"added":[],
         "source":{"kind":"own","path":"/Users/k/nr/agenthub/my-runner","pathShort":"~/nr/agenthub/my-runner","fingerprint":"0123456789abcdef0123",
           "writable":{"mine":true,"others":[],"parentOpen":false},"warnings":[]},
         "migrate":{"from":"official","version":"0.5.2"},"changedSinceRequest":true,"requestId":"r1"}
        """#
        let c = try JSONDecoder().decode(ConsentRequest.self, from: Data(json.utf8))
        #expect(c.tier == .own && c.isOwn && c.changedSinceRequest && c.requestId == "r1")
        let src = try #require(c.source)
        #expect(src.line == "своя папка · ~/nr/agenthub/my-runner · отпечаток 0123456789ab")
        // not "only you": any process under your user can write to the folder, including an agent in the repository
        #expect(src.writableMine && src.writableNote.hasPrefix("Менять папку могут только процессы под вашим пользователем — в том числе агенты"))
        let m = try #require(c.migrate)
        #expect(m.text(title: "Прогоны").hasPrefix("Заменит официальный «Прогоны» 0.5.2 из каталога на свой из этой папки"))
        #expect(PluginMigration(from: "own", version: "0.6.0", pathShort: "~/old").text(title: "Прогоны").contains("~/old"))
        // registry window (older daemon: no source) — the previous signature line
        let reg = try JSONDecoder().decode(ConsentRequest.self, from: Data(#"{"token":"t","id":"x","tier":"official","permissions":[]}"#.utf8))
        #expect(reg.source == nil && !reg.isOwn && reg.migrate == nil && !reg.changedSinceRequest)
        #expect(ConsentSource(kind: "registry").line == "подпись реестра ✓ · sha256 совпадает ✓")
        L10n.shared.lang = .en
        #expect(src.line == "own folder · ~/nr/agenthub/my-runner · fingerprint 0123456789ab")
        #expect(m.text(title: "Runs").hasPrefix("Replaces the official \"Runs\" 0.5.2 from the catalog"))
        L10n.shared.lang = .ru
    }

    // decision 2026-11-11: a folder writable by the group (umask 002) installs, but the window shows a loud line
    @Test func groupWritableSourceRisk() throws {
        L10n.shared.lang = .ru
        let json = #"""
        {"kind":"own","path":"/Users/k/tool/agenthub/tool","pathShort":"~/tool/agenthub/tool","fingerprint":"ff",
         "writable":{"mine":true,"others":[],"group":[".","README.md","tool.5m.sh","lib.mjs"],"parentOpen":false,"acl":[]},"risk":"group-writable","warnings":[]}
        """#
        let src = try JSONDecoder().decode(ConsentSource.self, from: Data(json.utf8))
        #expect(src.risk == "group-writable" && src.groupWritable.count == 4)
        let w = try #require(src.riskWarning)
        #expect(w.title == "Папку плагина может менять ваша группа, а не только вы")
        #expect(w.text.contains("(запись для группы: ., README.md, tool.5m.sh…)"))
        #expect(w.text.contains("chmod -R g-w ~/tool/agenthub/tool"))
        #expect(src.writableNote.hasPrefix("Менять папку могут процессы под вашим пользователем — и ваша группа"))
        L10n.shared.lang = .en
        #expect(src.riskWarning?.title == "Your group can change the plugin folder, not only you")
        #expect(src.riskWarning?.text.contains("umask 002") == true)
        L10n.shared.lang = .ru
        // no risk (or an older daemon without the field) — no line; a registry source never has one
        let plain = try JSONDecoder().decode(ConsentSource.self, from: Data(#"{"kind":"own","path":"/p","writable":{"mine":true}}"#.utf8))
        #expect(plain.riskWarning == nil && plain.groupWritable.isEmpty)
        #expect(ConsentSource(kind: "registry", risk: "group-writable").riskWarning == nil)
    }

    @Test func reviewFixesTextsAndStatuses() throws {
        L10n.shared.lang = .ru
        // id matches a catalog plugin (not installed): a note on what the own plugin will get
        let cat = try JSONDecoder().decode(PluginMigration.self, from: Data(#"{"from":"catalog","tier":"official","version":"0.5.2","title":"ClickUp"}"#.utf8))
        #expect(cat.text(title: "Подделка").hasPrefix("id совпадает с официальным плагином «ClickUp» из каталога (он не установлен)"))
        #expect(cat.text(title: "Подделка").contains("секреты в связке ключей"))
        // reverse migration (registry window over an own one): not "from now on the hub will watch this one"
        let back = PluginMigration(from: "own", version: "0.6.0", pathShort: "~/nr/agenthub/my-runner")
        #expect(back.text(title: "Прогоны", toRegistry: true) == "Заменит свой «Прогоны» 0.6.0 из папки ~/nr/agenthub/my-runner на плагин из каталога реестра. Слежение за папкой прекратится; данные плагина сохранятся.")
        #expect(back.text(title: "Прогоны").contains("дальше хаб будет следить за этой"))
        // own folder states: a write bypassing the hub, a version rollback, a different permission set without growth
        #expect(OwnSourceInfo(status: "unverified").isProblem)
        #expect(OwnSourceInfo(status: "unverified").statusText?.hasPrefix("Запись о плагине сделана мимо хаба") == true)
        let down = try JSONDecoder().decode(OwnSourceInfo.self, from: Data(#"{"status":"update","downgrade":true,"next":{"version":"0.5.0"},"growth":[]}"#.utf8))
        #expect(down.downgrade && down.statusText == "В папке версия 0.5.0 старше установленной — поставлю по кнопке «Обновить»")
        #expect(OwnSourceInfo(status: "update", growth: [], nextVersion: "1.1").statusText?.contains("другим набором прав") == true)
        // a loud push rule is a permission of an own plugin
        let push = PluginPermission(kind: "push", what: "alarm [security, quiet]", why: "Тревога", added: true)
        #expect(push.kindLabel == "Громкое уведомление")
        #expect(push.plainText == "Тревога — при любых выключателях уведомлений и в тихие часы")
        #expect(PluginPermission.counted("push", 2) == "2 громких уведомления")
        // linter warnings reach the window (source.warnings)
        let src = try JSONDecoder().decode(ConsentSource.self, from: Data(#"{"kind":"own","warnings":["<agenthub.action id=x>: immediate — запуск одним щелчком"]}"#.utf8))
        #expect(src.warnings.count == 1)
        for code in ["own:path-changed", "own:request-conflict", "own:too-many-requests", "consent:nothing", "peer:diagnostic"] { #expect(Explain.covers(code), "\(code)") }
        L10n.shared.lang = .en
        #expect(cat.text(title: "Fake").hasPrefix("The id matches the official plugin \"ClickUp\" from the catalog (not installed)"))
        #expect(push.kindLabel == "Loud notification")
        L10n.shared.lang = .ru
    }

    @Test func catalogRequirementsAndOwnInstalled() throws {
        L10n.shared.lang = .ru
        let json = #"""
        {"id":"hermes","version":"1.2.2","tier":"official","official":true,"permissions":[],
         "requires":[{"name":"Hermes","url":"https://github.com/NousResearch/hermes-agent","note":"агент","check":"~/.hermes","present":false},{"bad":1}],
         "installedOwn":null}
        """#
        let p = try JSONDecoder().decode(CatalogPlugin.self, from: Data(json.utf8))
        #expect(p.requires.count == 1, "a broken entry does not break the card")
        let r = try #require(p.missingRequirements.first)
        #expect(r.label == "Нужен Hermes" && r.link?.host == "github.com")
        #expect(r.missingHint.hasPrefix("Сначала установите Hermes"))
        #expect(PluginRequirement(name: "X", url: "http://x", present: false).link == nil, "https only")
        #expect(PluginRequirement(name: "X", url: "https://x", present: true).present)
        let own = try JSONDecoder().decode(CatalogPlugin.self, from: Data(#"{"id":"n","version":"1","installed":"0.6.0","installedOwn":{"path":"/a/b","pathShort":"~/b"},"updateAvailable":false}"#.utf8))
        #expect(own.installedOwn?.shown == "~/b" && own.updateKind == nil)
        L10n.shared.lang = .en
        #expect(r.label == "Needs Hermes")
        L10n.shared.lang = .ru
        // older daemon — no dependencies
        #expect(try JSONDecoder().decode(CatalogPlugin.self, from: Data(#"{"id":"x","version":"1"}"#.utf8)).requires.isEmpty)
    }

    @Test func stateOwnPluginsAndExplainCodes() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"ownPlugins":{"requests":[{"requestId":"r","id":"t","title":"T"},{"x":1}],"problems":[{"id":"t","status":"missing"}]}}"#.utf8))
        #expect(st.ownPlugins?.requests.map(\.id) == ["t"])
        #expect(st.ownPlugins?.problems.first?.status == "missing")
        #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8)).ownPlugins == nil)
        for code in ["own:no-app", "own:lint", "own:not-found", "own:ambiguous", "own:no-request", "own:id-changed"] { #expect(Explain.covers(code), "\(code)") }
        L10n.shared.lang = .ru
        #expect(Explain.text(code: "own:no-app", status: 409, label: "x").contains("не закреплено"))
    }

    @MainActor @Test func addFromFolderRequestsThenShowsConsentAndInstallsWithToken() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        let hits = Hits()
        d.events = { _, _ in snapshotFrame(1, peer: "app") }
        d.reply = { method, uri in
            switch (method, uri) {
            case ("POST", "/registry/own/request"):
                return (200, #"{"ok":true,"pending":true,"requestId":"r9","id":"tool","title":"Инструмент","version":"1.0.0","path":"/p/tool","pathShort":"~/tool","fingerprint":"ff","permissions":2,"update":false,"migrate":null}"#)
            case ("POST", "/registry/own/approve"):
                if hits.next("approve") == 1 {
                    return (428, #"{"error":"consent-required","needsConsent":true,"token":"tok","id":"tool","title":"Инструмент","tier":"own","version":"1.0.0","update":false,"permissions":[{"kind":"fsRead","what":"~/x","why":"y","added":true}],"source":{"kind":"own","path":"/p/tool","pathShort":"~/tool","fingerprint":"ff","writable":{"mine":true}},"migrate":null,"requestId":"r9"}"#)
                }
                return (200, #"{"ok":true,"id":"tool","version":"1.0.0","update":false,"source":"own"}"#)
            case ("GET", "/registry/installed"): return (200, #"{"installed":[],"local":[],"requests":[]}"#)
            case ("GET", "/registry/catalog"): return (200, #"{"configured":false,"plugins":[]}"#)
            default: return nil
            }
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = ConsentRecorder()
        store.presenter = p
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.state != nil })
        await store.addFromFolder("/p")
        #expect(p.consents.count == 1)
        #expect(p.consents.first?.source?.shownPath == "~/tool")
        let approves = d.requests.filter { $0.uri == "/registry/own/approve" }
        #expect(approves.count == 2, "consent window, then install by token")
        #expect(d.requests.contains { $0.uri == "/registry/own/request" })
        #expect(p.reports.isEmpty)
        // "Cancel" in the window — no second request
        p.agree = false
        await store.approveOwn("r9", title: "Инструмент")
        #expect(d.requests.filter { $0.uri == "/registry/own/approve" }.count == 3)
    }

    @MainActor @Test func addFromFolderReportsLintErrors() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in snapshotFrame(1, peer: "app") }
        d.reply = { method, uri in
            if method == "POST", uri == "/registry/own/request" { return (422, #"{"error":"own:lint","id":"tool","errors":["нет README.md","<agenthub.fsRead>~/.claude/projects: запрещено"]}"#) }
            if uri.hasPrefix("/registry/") { return (200, #"{"installed":[],"local":[],"plugins":[]}"#) }
            return nil
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = ConsentRecorder()
        store.presenter = p
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.state != nil })
        L10n.shared.lang = .ru
        await store.addFromFolder("/p")
        #expect(p.consents.isEmpty)
        let r = try #require(p.reports.first)
        #expect(r.title == "Плагин из папки не добавлен")
        #expect(r.detail.contains("нет README.md") && r.detail.contains("не прошёл проверку"))
        #expect(!d.requests.contains { $0.uri == "/registry/own/approve" })
    }
}
