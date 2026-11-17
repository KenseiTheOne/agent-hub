import Foundation
import Testing
@testable import AgentHubKit

// Review wave 2: remembered "Details" per plugin, card loads that answer out of order, damaged state files, the cut
// "Needs you" list, one name per action, the action time limit, the event permission in plain words.

// MARK: - "Details" memory is per plugin

@Suite(.serialized, .hubLang(.en)) struct DetailsMemoryTests {
    @MainActor @Test func sameRowInTwoPluginsKeepsItsOwnState() {
        let title = "Details \(UUID().uuidString)"
        #expect(!DetailsMemory.isOpen(plugin: "alpha", depth: 1, title: title))
        DetailsMemory.set(true, plugin: "alpha", depth: 1, title: title)
        #expect(DetailsMemory.isOpen(plugin: "alpha", depth: 1, title: title))
        #expect(!DetailsMemory.isOpen(plugin: "beta", depth: 1, title: title), "another plugin's row with the same title and depth stays closed")
        #expect(!DetailsMemory.isOpen(plugin: "alpha", depth: 2, title: title), "another depth is another row")
        DetailsMemory.set(true, plugin: "beta", depth: 1, title: title)
        DetailsMemory.set(false, plugin: "alpha", depth: 1, title: title)
        #expect(!DetailsMemory.isOpen(plugin: "alpha", depth: 1, title: title) && DetailsMemory.isOpen(plugin: "beta", depth: 1, title: title))
        DetailsMemory.set(false, plugin: "beta", depth: 1, title: title)
        // the parts cannot run into each other: "a" + "1…" is not "a1" + "…"
        #expect(DetailsMemory.key(plugin: "a", depth: 1, title: "1x") != DetailsMemory.key(plugin: "a1", depth: 1, title: "x"))
    }
}

// MARK: - card loads that answer out of order

@Suite(.serialized, .hubLang(.en)) struct CardLoadOrderTests {
    static func card(_ id: String) -> String {
        #"{"cards":[{"requestId":"\#(id)","sessionId":"s-1","kind":"permission","tool":"Bash","decisions":["once","deny"]}],"paused":false}"#
    }
    static let older = String(repeating: "a", count: 32)
    static let newer = String(repeating: "b", count: 32)

    static func cardRequests(_ d: FakeDaemon) -> Int { d.requests.filter { $0.uri == "/hook/cards" }.count }

    @MainActor @Test func slowOlderAnswerDoesNotOverwriteNewer() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        // the first request is answered with the old list, late; the second — with the new one, at once
        d.cards = { [unowned d] in Self.cardRequests(d) <= 1 ? Self.card(Self.older) : Self.card(Self.newer) }
        d.delay = { uri, n in uri == "/hook/cards" && n == 0 ? 0.6 : 0 }
        let store = HubStore(client: HubClient(socketPath: d.path))
        async let first: Void = store.loadCards()
        #expect(await waitFor { Self.cardRequests(d) == 1 })
        await store.loadCards()
        #expect(store.cards.map(\.requestId) == [Self.newer])
        await first
        #expect(store.cards.map(\.requestId) == [Self.newer], "the older answer arrived last and was dropped")
        #expect(Self.cardRequests(d) == 2)
        // loads in order still apply, each one
        d.cards = { Self.card(Self.older) }
        d.delay = { _, _ in 0 }
        await store.loadCards()
        #expect(store.cards.map(\.requestId) == [Self.older])
    }

    @MainActor @Test func cardRemovedByEventIsNotBroughtBackByAnAnswerInFlight() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        // the answer in flight still has the card; by the time it lands the daemon has removed it
        d.cards = { [unowned d] in Self.cardRequests(d) <= 1 ? Self.card(Self.older) : #"{"cards":[],"paused":false}"# }
        d.delay = { uri, n in uri == "/hook/cards" && n == 0 ? 0.6 : 0 }
        let store = HubStore(client: HubClient(socketPath: d.path))
        async let first: Void = store.loadCards()
        #expect(await waitFor { Self.cardRequests(d) == 1 })
        store.handle(SSEEvent(id: "5", event: "hook.card.removed", data: #"{"type":"hook.card.removed","requestId":"\#(Self.older)","reason":"answered"}"#))
        await first
        #expect(store.cards.isEmpty, "the stale answer did not resurrect the removed card")
        #expect(await waitFor { Self.cardRequests(d) == 2 }, "the list is read again after the change")
        #expect(await waitFor { store.cards.isEmpty && store.cardsError == nil })
    }

    @MainActor @Test func removalWithNoLoadInFlightAsksNothing() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.cards = { Self.card(Self.older) }
        let store = HubStore(client: HubClient(socketPath: d.path))
        await store.loadCards()
        #expect(store.cards.count == 1)
        store.handle(SSEEvent(id: "6", event: "hook.card.removed", data: #"{"type":"hook.card.removed","requestId":"\#(Self.older)"}"#))
        #expect(store.cards.isEmpty)
        try await Task.sleep(for: .milliseconds(150))
        #expect(Self.cardRequests(d) == 1, "nothing was in flight — the event alone is enough")
    }
}

// MARK: - damaged state files

@Suite(.serialized, .hubLang(.en)) struct DamagedFilesTests {
    static let state = #"{"seq":1,"damagedFiles":[{"file":"config.json","backup":"config.json.bad","detail":"Unexpected token } in JSON at position 41","at":"2026-11-17T08:00:00.000Z"},{"backup":"x.bad"},{"file":"jobs.json","backup":null,"detail":""}]}"#

    @Test func decodesLeniently() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(Self.state.utf8))
        #expect(st.damagedFiles.map(\.file) == ["config.json", "jobs.json"], "an entry without a file name is skipped")
        #expect(st.damagedFiles[0].backup == "config.json.bad" && st.damagedFiles[1].backup == nil)
        #expect(st.damagedFiles[1].detail == nil)
        // an older daemon: no field; a wrong type: nothing rather than a failed snapshot
        #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8)).damagedFiles.isEmpty)
        #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":7,"damagedFiles":"no"}"#.utf8)).seq == 7)
        #expect(HubState().damagedFiles.isEmpty)
    }

    @Test func rowSaysWhichFileWhereTheCopyIsAndWhatToDo() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(Self.state.utf8))
        let home = NSHomeDirectory() + "/.agenthub"
        let cfg = st.damagedFiles[0]
        #expect(DamagedFileText.title(cfg) == "The hub couldn't read config.json and is running without it")
        let text = DamagedFileText.detail(cfg, home: home, restartCommand: "launchctl kickstart -k gui/501/x")
        #expect(text == "A copy was kept as config.json.bad in ~/.agenthub. Fix config.json — take what you need from the copy — and restart the hub with launchctl kickstart -k gui/501/x. Until then the defaults apply instead of the file.")
        #expect(DamagedFileText.reason(cfg) == "Reason: Unexpected token } in JSON at position 41")
        #expect(DamagedFileText.revealPath(cfg, home: home) == home + "/config.json.bad")
        // no copy, no known directory, no command: still the file and what to do
        let jobs = st.damagedFiles[1]
        #expect(DamagedFileText.detail(jobs, home: nil) == "No copy could be kept. Fix jobs.json and restart the hub. Until then the defaults apply instead of the file.")
        #expect(DamagedFileText.reason(jobs) == nil)
        #expect(DamagedFileText.revealPath(jobs, home: home) == home + "/jobs.json")
        // a name is a name inside the hub directory, whatever was sent
        #expect(DamagedFileText.revealPath(DamagedFile(file: "../../etc/passwd"), home: home) == home + "/passwd")
        L10n.shared.lang = .ru
        #expect(DamagedFileText.title(cfg) == "Хаб не смог прочитать config.json и работает без него")
        #expect(DamagedFileText.detail(cfg, home: nil).hasPrefix("Копия сохранена как config.json.bad. Исправьте config.json"))
        L10n.shared.lang = .en
    }

    @Test func restartCommandOnlyForTheLiveHub() {
        #expect(DaemonStarter(home: "/Users/x/.agenthub", defaultHome: "/Users/x/.agenthub", uid: 501).restartCommand == "agenthub restart")
        #expect(DaemonStarter(home: "/tmp/stand", defaultHome: "/Users/x/.agenthub", uid: 501).restartCommand == nil, "launchd does not keep a test copy")
    }
}

// MARK: - "Needs you" is cut with a hint

@Suite(.serialized, .hubLang(.en)) struct NeedsOverflowTests {
    @Test func theRestIsCountedNotDropped() {
        let all = Array(1...8)
        let (shown, hidden) = NeedsOverflow.split(all)
        #expect(shown == [1, 2, 3, 4, 5] && hidden == 3)
        #expect(all[shown.count] == 6, "the first hidden row is the one the \"more\" row opens")
        #expect(NeedsOverflow.label(hidden: hidden) == "3 more")
        // nothing hidden — no row
        let fits = NeedsOverflow.split(Array(1...5))
        #expect(fits.shown.count == 5 && fits.hidden == 0 && NeedsOverflow.label(hidden: 0) == nil)
        #expect(NeedsOverflow.split([Int]()).shown.isEmpty)
        #expect(NeedsOverflow.split([1, 2, 3], limit: 2).hidden == 1)
        #expect(NeedsOverflow.split([1, 2, 3], limit: -1).hidden == 3)
        L10n.shared.lang = .ru
        #expect(NeedsOverflow.label(hidden: 1) == "Ещё 1")
        L10n.shared.lang = .en
    }
}

// MARK: - wording: one name per action, no hard-coded limit, plain permission text

@Suite(.serialized, .hubLang(.en)) struct Wave2WordingTests {
    @Test func oneNameForGoingToTheTabAndForRetry() {
        #expect(FocusText.action == "Go to tab" && FocusText.short == "Go to tab")
        #expect(RetryText.button == "Try again")
        #expect(TerminalText.capability("focus") == "go to tab")
        #expect(Explain.text(code: "registry:fetch", status: 502, label: "X").contains("press \"Try again\""))
        L10n.shared.lang = .ru
        #expect(FocusText.action == "Перейти во вкладку" && FocusText.short == "Перейти")
        #expect(RetryText.button == "Повторить")
        #expect(Explain.text(code: "registry:fetch", status: 502, label: "X").contains("нажмите «Повторить»"))
        L10n.shared.lang = .en
    }

    @Test func timeLimitTextNamesTheRealDurationOrNoNumber() {
        let ran = JSONValue.object(["timedOut": .bool(true), "durationMs": .number(60_000)])
        #expect(Explain.report(result: ran, label: "X").title == "The command took over 60 s and was stopped")
        let bare = JSONValue.object(["timedOut": .bool(true)])
        #expect(Explain.report(result: bare, label: "X").title == "The command ran out of time and was stopped")
        // under a second there is no honest figure
        let quick = JSONValue.object(["timedOut": .bool(true), "durationMs": .number(400)])
        #expect(!Explain.report(result: quick, label: "X").title.contains(" s "))
    }

    @Test func eventPermissionInPlainWords() {
        let p = PluginPermission(kind: "subscribe", what: "agents:run-", why: "Shows finished runs", added: false)
        #expect(p.kindLabel == "Other plugins' events" && p.shortKindLabel == "other plugins' events")
        #expect(p.plainText == "Shows finished runs — learn when the agents plugin raises or clears an event whose key starts with \"run-\", and read the event's title")
        #expect(PluginPermission(kind: "subscribe", what: "*:", why: nil, added: false).plainText == "learn when any other plugin raises or clears any event, and read the event's title")
        #expect(PluginPermission(kind: "subscribe", what: "agents", why: nil, added: false).plainText?.contains("the agents plugin raises or clears any event") == true)
        #expect(PluginPermission.counted("subscribe", 2) == "2 event sources")
        let fsRead = PluginPermission(kind: "fsRead", what: "~/x", why: nil, added: false)
        #expect(PluginPermission.byWeight([fsRead, p], addedFirst: false).first?.kind == "subscribe")
        L10n.shared.lang = .ru
        #expect(p.kindLabel == "События других плагинов")
        #expect(PluginPermission.counted("subscribe", 5) == "5 источников событий")
        L10n.shared.lang = .en
    }

    @Test func notificationPermissionRow() {
        #expect(NotifyPermissionText.shows(.denied, hubEnabled: true))
        #expect(NotifyPermissionText.shows(.denied, hubEnabled: nil), "an older daemon says nothing about the switch — still worth telling")
        #expect(!NotifyPermissionText.shows(.denied, hubEnabled: false), "the hub's notifications are off — nothing is missed")
        #expect(!NotifyPermissionText.shows(.denied, hubEnabled: true, hidden: true))
        for p in [NotifyPermission.unknown, .allowed, .notAsked] { #expect(!NotifyPermissionText.shows(p, hubEnabled: true)) }
        #expect(NotifyPermissionText.settingsURL(bundleId: "com.example.app").absoluteString == "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.example.app")
        #expect(NotifyPermissionText.settingsURL(bundleId: nil).absoluteString == "x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        #expect(HubDefaults.scopedBases.contains("notifyDeniedHidden"), "\"Dismiss\" is remembered per hub and pruned with it")
    }
}

// MARK: - small shared helpers

@Suite struct Wave2HelperTests {
    @Test func searchFilterMatchesAnyTextIgnoringCaseAndSpaces() {
        let rows: [(name: String, dir: String?)] = [("Alpha", "/work/site"), ("beta", nil), ("Gamma", "/tmp/ALPHA-2")]
        let names = { (q: String) in SearchFilter.apply(rows, query: q) { [$0.name, $0.dir] }.map(\.name) }
        #expect(names("") == ["Alpha", "beta", "Gamma"] && names("   ") == ["Alpha", "beta", "Gamma"])
        #expect(names(" alpha ") == ["Alpha", "Gamma"])
        #expect(names("SITE") == ["Alpha"])
        #expect(names("zzz").isEmpty)
    }

    @Test func isoDateParsesBothFormsAndPrintsThePlainOne() throws {
        let a = try #require(ISODate.parse("2026-11-12T10:00:00.000Z"))
        let b = try #require(ISODate.parse(" 2026-11-12T13:00:00+03:00 "))
        #expect(a == b)
        #expect(ISODate.string(a) == "2026-11-12T10:00:00Z")
        #expect(ISODate.parse("yesterday") == nil)
    }
}
