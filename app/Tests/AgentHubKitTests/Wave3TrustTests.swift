import Foundation
import Testing
@testable import AgentHubKit

// Wave 3: the registry key that changed (the banner's data, the key window's flow), the new refusal codes in plain
// words, the action time limit from `/state.limits`, the hook row from `/state.hook`, `agenthub restart`.

@MainActor
final class KeyPresenter: ConfirmPresenter {
    var keys: [RegistryKeyConsent] = []
    var reports: [(title: String, detail: String)] = []
    var accept = false
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool { false }
    func report(title: String, detail: String) { reports.append((title, detail)) }
    func consent(_ request: ConsentRequest) async -> Bool { false }
    func registryKey(_ request: RegistryKeyConsent) async -> Bool { keys.append(request); return accept }
}

/// A presenter from before the key window: the protocol's default answers for it.
@MainActor
final class OldPresenter: ConfirmPresenter {
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool { true }
    func report(title: String, detail: String) {}
    func consent(_ request: ConsentRequest) async -> Bool { true }
}

@Suite(.serialized, .hubLang(.en)) struct RegistryKeyTests {
    static let was = #"{"keyId":"9F3A61C2D05B7E44","fingerprint":"5d1c0a7f3b9e42618ac4f0d27be19a63"}"#
    static let now = #"{"keyId":"C41E08B7A2F6D935","fingerprint":"e8a27b40c96f1d53b07a4e92d1c85f3e"}"#
    static let entry = #"{"registry":"default","trust":"official","since":"2026-11-17T10:00:00.000Z","was":\#(was),"now":\#(now)}"#
    static func snapshot(_ state: String) -> SSEEvent {
        SSEEvent(id: "1", event: "snapshot", data: #"{"id":1,"type":"snapshot","state":\#(state)}"#)
    }
    static let consent = #"{"error":"consent-required","needsConsent":true,"token":"tok-1","expiresInMs":120000,"kind":"registry-key","registry":"default","registryLabel":null,"trust":"official","since":"2026-11-17T10:00:00.000Z","was":\#(was),"now":\#(now)}"#

    static func keyPosts(_ d: FakeDaemon) -> [FakeDaemon.Request] { d.requests.filter { $0.uri == "/registry/key/accept" } }

    @Test func stateDecodesTheListLeniently() throws {
        let json = #"{"seq":1,"registryKeys":[\#(Self.entry),{"registry":"team","trust":"community","was":\#(Self.was),"now":null},{"registry":"broken"}],"limits":{"actionTimeoutMs":30000},"hook":{"installed":false,"lastEventAt":null,"reason":"no-events"}}"#
        let s = try JSONDecoder().decode(HubState.self, from: Data(json.utf8))
        let keys = try #require(s.registryKeys)
        #expect(keys.map(\.registry) == ["default", "team"], "an entry without its keys is skipped, the rest stay")
        #expect(keys[0].was.fingerprint == "5d1c0a7f3b9e42618ac4f0d27be19a63" && keys[0].now?.fingerprint == "e8a27b40c96f1d53b07a4e92d1c85f3e")
        #expect(keys[0].was.keyId == "9F3A61C2D05B7E44" && keys[0].trust == "official" && keys[0].since == "2026-11-17T10:00:00.000Z")
        #expect(keys[1].now == nil && keys[1].shownName == "team" && keys[0].shownName == nil)
        #expect(s.limits?.actionTimeoutMs == 30000)
        #expect(s.hook == HookInfo(installed: false, lastEventAt: nil, reason: "no-events"))
        // an older daemon: no fields — nothing to show
        let old = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8))
        #expect(old.registryKeys == nil && old.limits == nil && old.hook == nil)
        // values of another shape change nothing either
        let odd = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"registryKeys":null,"limits":{"actionTimeoutMs":"soon"},"hook":{"lastEventAt":"x"}}"#.utf8))
        #expect(odd.registryKeys == nil && odd.limits?.actionTimeoutMs == nil && odd.hook == nil)
        #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"limits":{"actionTimeoutMs":0}}"#.utf8)).limits?.actionTimeoutMs == nil)
    }

    @MainActor @Test func busEventReplacesTheList() {
        let store = HubStore(client: HubClient(socketPath: "/nonexistent/hub.sock"))
        store.handle(Self.snapshot(#"{"seq":1,"registryKeys":[]}"#))
        #expect(store.registryKeyChanges.isEmpty)
        store.handle(SSEEvent(id: "2", event: "plugins.registry-keys", data: #"{"changed":[\#(Self.entry)]}"#))
        #expect(store.registryKeyChanges.map(\.registry) == ["default"])
        // accepted or put back: nothing waits
        store.handle(SSEEvent(id: "3", event: "plugins.registry-keys", data: #"{"changed":[]}"#))
        #expect(store.registryKeyChanges.isEmpty)
        // an event of another shape leaves the list alone
        store.handle(SSEEvent(id: "4", event: "plugins.registry-keys", data: #"{"changed":[\#(Self.entry)]}"#))
        store.handle(SSEEvent(id: "5", event: "plugins.registry-keys", data: #"{"changed":"x"}"#))
        #expect(store.registryKeyChanges.count == 1)
    }

    @Test func consentDecodesBothKeys() throws {
        let c = try JSONDecoder().decode(RegistryKeyConsent.self, from: Data(Self.consent.utf8))
        #expect(c.token == "tok-1" && c.expiresInMs == 120_000)
        #expect(c.change.registry == "default" && c.change.registryLabel == nil && c.change.trust == "official")
        #expect(c.change.was.fingerprint == "5d1c0a7f3b9e42618ac4f0d27be19a63" && c.change.now?.fingerprint == "e8a27b40c96f1d53b07a4e92d1c85f3e")
        // a window without the new key has nothing to compare: not a consent
        let noNew = Self.consent.replacingOccurrences(of: #""now":\#(Self.now)"#, with: #""now":null"#)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(RegistryKeyConsent.self, from: Data(noNew.utf8)) }
    }

    @MainActor @Test func acceptingSendsTheTokenAndClearsTheBanner() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.replyBody = { method, uri, body in
            guard method == "POST", uri == "/registry/key/accept" else { return nil }
            return body.contains("consentToken")
                ? (200, #"{"ok":true,"registry":"default","key":\#(Self.now),"fetched":true}"#)
                : (428, Self.consent)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = KeyPresenter()
        p.accept = true
        store.presenter = p
        store.handle(Self.snapshot(#"{"seq":1,"registryKeys":[\#(Self.entry)]}"#))
        await store.acceptRegistryKey("default")
        #expect(p.keys.count == 1 && p.keys.first?.change.now?.keyId == "C41E08B7A2F6D935")
        let posts = Self.keyPosts(d)
        #expect(posts.count == 2)
        #expect(posts.first?.body.contains("consentToken") == false && posts.first?.body.contains(#""registry":"default""#) == true)
        #expect(posts.last?.body.contains(#""consentToken":"tok-1""#) == true)
        #expect(store.registryKeyChanges.isEmpty && p.reports.isEmpty)
        #expect(store.registryBusy == nil)
    }

    @MainActor @Test func decliningSendsNothingAndKeepsTheBanner() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.reply = { method, uri in method == "POST" && uri == "/registry/key/accept" ? (428, Self.consent) : nil }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = KeyPresenter()
        store.presenter = p
        store.handle(Self.snapshot(#"{"seq":1,"registryKeys":[\#(Self.entry)]}"#))
        await store.acceptRegistryKey("default")
        #expect(p.keys.count == 1 && Self.keyPosts(d).count == 1, "no second request without the human's yes")
        #expect(store.registryKeyChanges.count == 1 && p.reports.isEmpty)
        // a presenter without the key window accepts nothing
        store.presenter = OldPresenter()
        await store.acceptRegistryKey("default")
        #expect(Self.keyPosts(d).count == 2 && store.registryKeyChanges.count == 1)
    }

    @MainActor @Test func acceptedWithoutCatalogAndRefusalsAreReported() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.replyBody = { method, uri, body in
            guard method == "POST", uri == "/registry/key/accept" else { return nil }
            return body.contains("consentToken") ? (200, #"{"ok":true,"registry":"default","fetched":false,"fetchError":"registry:expired"}"#) : (428, Self.consent)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = KeyPresenter()
        p.accept = true
        store.presenter = p
        store.handle(Self.snapshot(#"{"seq":1,"registryKeys":[\#(Self.entry)]}"#))
        await store.acceptRegistryKey("default")
        #expect(store.registryKeyChanges.isEmpty)
        #expect(p.reports.count == 1 && p.reports[0].title == "The key is accepted, the catalog is not loaded")
        #expect(p.reports[0].detail.contains("has expired") && p.reports[0].detail.contains("Log code: registry:expired"))
        // the key was put back before the answer: the daemon has nothing to confirm, the banner goes
        d.replyBody = { _, _, _ in nil }
        d.reply = { method, uri in method == "POST" && uri == "/registry/key/accept" ? (409, #"{"error":"registry:key-unchanged"}"#) : nil }
        store.handle(Self.snapshot(#"{"seq":2,"registryKeys":[\#(Self.entry)]}"#))
        await store.acceptRegistryKey("default")
        #expect(store.registryKeyChanges.isEmpty)
        #expect(p.reports.count == 2 && p.reports[1].title == "The registry key was not accepted")
        #expect(p.reports[1].detail.hasPrefix("The registry key in config.json is the accepted one"))
        // a copy that is not the pinned build: the refusal is said, the banner stays
        d.reply = { method, uri in method == "POST" && uri == "/registry/key/accept" ? (403, #"{"error":"peer:cli"}"#) : nil }
        store.handle(Self.snapshot(#"{"seq":3,"registryKeys":[\#(Self.entry)]}"#))
        await store.acceptRegistryKey("default")
        #expect(store.registryKeyChanges.count == 1 && p.reports.count == 3 && p.keys.count == 1)
    }

    @Test func bannerAndWindowTexts() throws {
        let k = try JSONDecoder().decode(RegistryKeyChange.self, from: Data(Self.entry.utf8))
        let team = RegistryKeyChange(registry: "team", trust: "community", was: k.was, now: nil)
        #expect(RegistryKeyText.bannerTitle(k) == "The plugin registry key has changed")
        #expect(RegistryKeyText.bannerTitle(team) == "The key of the \"team\" registry has changed")
        #expect(RegistryKeyText.windowTitle(k) == "Accept the new plugin registry key?")
        #expect(RegistryKeyText.windowSubtitle(k).hasPrefix("official registry · new key first seen "))
        #expect(RegistryKeyText.windowSubtitle(team) == "community registry")
        #expect(RegistryKeyText.bannerDetail(k, canAccept: true).hasSuffix("installs nothing signed with the new one."))
        // a copy that cannot accept is told where it can be done
        #expect(RegistryKeyText.bannerDetail(k, canAccept: false).hasSuffix("or with agenthub plugins trust-key in your own terminal."))
        #expect(RegistryKeyText.terminalCommand(team) == "agenthub plugins trust-key team")
        // not a key in the file: nothing to accept, the text says what to fix
        #expect(RegistryKeyText.bannerDetail(team, canAccept: true).hasPrefix("config.json now holds something that is not a registry key."))
        #expect(RegistryKeyText.accept == "Accept the new key" && RegistryKeyText.decline == "Don't accept")
        L10n.shared.lang = .ru
        #expect(RegistryKeyText.bannerTitle(k) == "Ключ реестра плагинов сменился")
        #expect(RegistryKeyText.bannerTitle(team) == "Ключ реестра «team» сменился")
        #expect(RegistryKeyText.windowTitle(k) == "Принять новый ключ реестра плагинов?")
        #expect(RegistryKeyText.accept == "Принять новый ключ" && RegistryKeyText.decline == "Не принимать" && RegistryKeyText.review == "Сравнить ключи…")
        L10n.shared.lang = .en
    }
}

@Suite(.serialized, .hubLang(.en)) struct Wave3TextTests {
    @Test func newRefusalCodesHaveTexts() {
        let codes = ["registry:key-changed", "registry:expired", "registry:rollback", "registry:key-unchanged", "registry:key-format",
                     "terminal:binding-unknown", "terminal:binding-unknown:process", "terminal:binding-unknown:tab", "peer:bridge-launch", "peer:bridge-file"]
        for code in codes {
            #expect(Explain.covers(code), "\(code)")
            #expect(Explain.knownCodes.contains(code), "\(code) is in the list the coverage test walks")
        }
        #expect(Explain.text(code: "registry:key-changed", status: 409, label: "X").contains("agenthub plugins trust-key"))
        #expect(Explain.text(code: "registry:expired", status: 409, label: "X").hasPrefix("The registry catalog has expired"))
        #expect(Explain.text(code: "registry:rollback", status: 409, label: "X").contains("Nothing changed."))
        // `part` of the answer refines the text; without it the general one is used
        let any = Explain.text(code: "terminal:binding-unknown", status: 409, label: "X")
        let process = Explain.text(code: "terminal:binding-unknown:process", status: 409, label: "X")
        let tab = Explain.text(code: "terminal:binding-unknown:tab", status: 409, label: "X")
        #expect(process.hasPrefix("The hub could not make sure the session's process is the one it started with."))
        #expect(tab.hasPrefix("The hub could not make sure the terminal tab belongs to this very session."))
        #expect(any != process && any != tab)
        for t in [any, process, tab] { #expect(t.contains("Nothing was typed into it.") && t.contains("Try again a little later")) }
        // a refinement the shell does not know falls back to the general text
        #expect(Explain.text(code: "terminal:binding-unknown:else", status: 409, label: "X") == any)
        #expect(Explain.text(code: "peer:bridge-launch", status: 403, label: "X").contains("interpreter options"))
        #expect(Explain.text(code: "peer:bridge-file", status: 403, label: "X").contains("not a file the hub trusts"))
        L10n.shared.lang = .ru
        #expect(Explain.text(code: "registry:key-unchanged", status: 409, label: "X") == "Ключ реестра в config.json совпадает с принятым — подтверждать нечего.")
        #expect(Explain.text(code: "terminal:binding-unknown:tab", status: 409, label: "X").contains("В неё ничего не напечатано."))
        #expect(Explain.text(code: "peer:bridge-file", status: 403, label: "X").hasPrefix("Скрипт моста терминала — не тот файл, которому доверяет хаб"))
        L10n.shared.lang = .en
    }

    @Test func timeLimitTextNamesTheHubLimitWhenTheRunHasNoDuration() {
        let bare = JSONValue.object(["timedOut": .bool(true)])
        #expect(Explain.report(result: bare, label: "X", limitMs: 30_000).title == "The command took over 30 s and was stopped")
        #expect(Explain.failure(result: bare, label: "X", limitMs: 30_000) == "\"X\": The command took over 30 s and was stopped.")
        // the run's own duration is the more exact figure
        let ran = JSONValue.object(["timedOut": .bool(true), "durationMs": .number(45_020)])
        #expect(Explain.report(result: ran, label: "X", limitMs: 30_000).title == "The command took over 45 s and was stopped")
        // no limit known (an older daemon) or one with no honest figure: no number, as before
        #expect(Explain.report(result: bare, label: "X").title == "The command ran out of time and was stopped")
        #expect(Explain.report(result: bare, label: "X", limitMs: 500).title == "The command ran out of time and was stopped")
        L10n.shared.lang = .ru
        #expect(Explain.report(result: bare, label: "X", limitMs: 90_000).title == "Команда не уложилась в 90 с и остановлена")
        L10n.shared.lang = .en
    }

    @MainActor @Test func storeTakesTheLimitFromState() {
        let store = HubStore(client: HubClient(socketPath: "/nonexistent/hub.sock"))
        #expect(store.actionLimitMs == nil)
        store.handle(RegistryKeyTests.snapshot(#"{"seq":1,"limits":{"actionTimeoutMs":30000}}"#))
        #expect(store.actionLimitMs == 30_000)
        store.handle(RegistryKeyTests.snapshot(#"{"seq":2}"#))
        #expect(store.actionLimitMs == nil)
    }

    @Test func hookRowOnlyWhenTheHubSaysNotInstalled() {
        #expect(!HookText.shows(nil), "an older daemon has no field: nothing is shown")
        #expect(!HookText.shows(HookInfo(installed: true, lastEventAt: "2026-11-17T10:00:00.000Z")))
        let missing = HookInfo(installed: false, lastEventAt: nil, reason: "no-events")
        #expect(HookText.shows(missing) && !HookText.shows(missing, hidden: true))
        #expect(HookText.title == "The hub hasn't heard from the Claude Code hook yet")
        #expect(HookText.detail(missing).contains("sessions don't report permission requests to the hub"))
        #expect(!HookText.detail(missing).contains("no-events"), "the known reason is the text itself")
        #expect(HookText.detail(HookInfo(installed: false, reason: "paths")).hasSuffix("The reason the hub gives: paths."))
        #expect(HookText.command(missing).contains("claude plugin install agent-hub@agent-hub"), "a daemon without the field: the README command")
        #expect(HookText.command(HookInfo(installed: false, installCommand: "claude plugin install x@y")) == "claude plugin install x@y", "the daemon's command wins")
        #expect(HookText.command(HookInfo(installed: false, installCommand: "  ")) == HookText.command(nil))
        #expect(HookText.lastEvent(missing) == nil)
        #expect(HookText.lastEvent(HookInfo(installed: true, lastEventAt: "2026-11-17T10:00:00.000Z"))?.hasPrefix("Claude Code hook: last event ") == true)
        L10n.shared.lang = .ru
        #expect(HookText.title == "Хаб ещё не получал событий от хука Claude Code")
        #expect(HookText.detail(missing).contains("сессии не сообщают хабу о запросах разрешений"))
        L10n.shared.lang = .en
    }

    @Test func damagedFileRowNamesTheHubCommand() {
        let live = DaemonStarter(home: "/Users/x/.agenthub", defaultHome: "/Users/x/.agenthub", uid: 501).restartCommand
        let cfg = DamagedFile(file: "config.json", backup: "config.json.bad")
        #expect(DamagedFileText.detail(cfg, home: nil, restartCommand: live).contains("restart the hub with agenthub restart"))
        #expect(!DamagedFileText.detail(cfg, home: nil, restartCommand: live).contains("launchctl"))
        // a test home: the command would restart the live hub, so the text only says to restart
        let test = DaemonStarter(home: "/tmp/stand", defaultHome: "/Users/x/.agenthub", uid: 501).restartCommand
        #expect(test == nil)
        #expect(DamagedFileText.detail(cfg, home: nil, restartCommand: test).contains("and restart the hub."))
        #expect(!DamagedFileText.detail(cfg, home: nil, restartCommand: test).contains("agenthub restart"))
    }
}
