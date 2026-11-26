import Foundation
import Testing
@testable import AgentHubKit

// "Stay awake with the lid closed" (/state.awake, the `awake` event): parsing the section, the three looks of the switch
// row, the mark on the menu bar icon next to the other marks, the journal lines and the refusal texts.

private func state(_ json: String) throws -> HubState {
    try JSONDecoder().decode(HubState.self, from: Data(json.utf8))
}

private func info(_ json: String) throws -> AwakeInfo {
    try JSONDecoder().decode(AwakeInfo.self, from: Data(json.utf8))
}

private let fullJSON = #"{"supported":true,"granted":true,"on":true,"onBattery":true,"charge":64,"threshold":30}"#

@Suite(.hubLang(.ru)) struct AwakeTests {
    // MARK: - the section in /state

    @Test func decodesTheSection() throws {
        let st = try state(#"{"seq":1,"plugins":[],"awake":\#(fullJSON)}"#)
        #expect(st.awake == AwakeInfo(supported: true, granted: true, on: true, onBattery: true, charge: 64, threshold: 30))
        // a desktop: no lid, no battery
        let desk = try info(#"{"supported":false,"granted":false,"on":false,"onBattery":null,"charge":null,"threshold":10}"#)
        #expect(!desk.supported && desk.onBattery == nil && desk.charge == nil && desk.threshold == 10)
    }

    @Test func absentSectionMeansNoSwitch() throws {
        // an older daemon: the rest of the snapshot is read as before
        let st = try state(#"{"seq":7,"plugins":[],"estop":true}"#)
        #expect(st.awake == nil && st.estop && st.seq == 7)
        #expect(AwakeLook.make(st.awake) == nil && AwakeRow.make(st.awake, live: true) == nil)
        #expect(HubState().awake == nil)
        // a section of the wrong shape is no section, and doesn't break the snapshot
        let odd = try state(#"{"seq":2,"plugins":[],"awake":"yes"}"#)
        #expect(odd.awake == nil && odd.seq == 2)
    }

    @Test func partialSectionFallsToTheQuietSide() throws {
        // nothing but the flag: no row (not supported), no rights, the daemon's usual charge
        let bare = try info(#"{"on":true}"#)
        #expect(bare == AwakeInfo(supported: false, granted: false, on: true, onBattery: nil, charge: nil, threshold: 10))
        #expect(AwakeLook.make(bare) == nil && !bare.marksIcon)
        // broken fields are read as missing ones
        let broken = try info(#"{"supported":true,"granted":"yes","on":1,"onBattery":"no","charge":"64","threshold":"30"}"#)
        #expect(broken == AwakeInfo(supported: true, granted: false, on: false, onBattery: nil, charge: nil, threshold: 10))
        // the number is the daemon's: shown as it came, not fitted to anything here
        #expect(try info(#"{"supported":true,"threshold":2}"#).threshold == 2)
        #expect(try info(#"{"supported":true,"threshold":73}"#).threshold == 73)
        // the section goes back to the daemon's shape
        let again = try JSONDecoder().decode(AwakeInfo.self, from: JSONEncoder().encode(try info(fullJSON)))
        #expect(again == (try info(fullJSON)))
    }

    // MARK: - the event

    @Test func awakeEventReplacesTheSection() throws {
        guard case .awake(let e)? = HubEvent.decode(SSEEvent(id: "9", event: "awake", data: #"{"type":"awake","awake":\#(fullJSON)}"#)) else {
            Issue.record("the awake event was not parsed")
            return
        }
        #expect(e.on && e.threshold == 30 && e.charge == 64)
        var st = HubState()
        let first = st.apply(.awake(e))
        #expect(first && st.awake == e)
        // the same section again changes nothing
        let same = st.apply(.awake(e))
        #expect(!same)
        // another number from the daemon comes by the same event
        var next = e
        next.threshold = 45
        let moved = st.apply(.awake(next))
        #expect(moved && st.awake?.threshold == 45 && st.awake?.on == true)
        // an event without the section is not an event
        #expect(HubEvent.decode(SSEEvent(id: "10", event: "awake", data: #"{"type":"awake"}"#)) == nil)
    }

    // MARK: - the three looks of the row

    @Test func lookByTheSection() {
        #expect(AwakeLook.make(AwakeInfo(on: false)) == .off)
        #expect(AwakeLook.make(AwakeInfo(on: true)) == .on)
        #expect(AwakeLook.make(AwakeInfo(granted: false, on: false)) == .unavailable(on: false))
        // turned on outside the hub while it has no rights: shown as on, still not clickable
        #expect(AwakeLook.make(AwakeInfo(granted: false, on: true)) == .unavailable(on: true))
        // no lid — no row, whatever the rest says
        #expect(AwakeLook.make(AwakeInfo(supported: false, granted: true, on: true)) == nil)
        #expect(AwakeLook.make(nil) == nil)
        #expect(AwakeLook.on.isOn && !AwakeLook.off.isOn && AwakeLook.unavailable(on: true).isOn && !AwakeLook.unavailable(on: false).isOn)
        #expect(AwakeLook.on.isAvailable && AwakeLook.off.isAvailable && !AwakeLook.unavailable(on: true).isAvailable)
    }

    @Test func rowOffAndOn() throws {
        let off = try #require(AwakeRow.make(AwakeInfo(on: false, threshold: 25), live: true))
        #expect(off.look == .off && !off.isOn && off.enabled)
        // the guard trips strictly below the threshold
        #expect(off.help.contains("упадёт ниже 25%") && off.help.contains("вернёт сон"))
        let on = try #require(AwakeRow.make(AwakeInfo(on: true), live: true))
        // no number of its own: a section without one reads as the daemon's usual 10
        #expect(on.look == .on && on.isOn && on.enabled && on.help.contains("ниже 10%"))
        #expect(AwakeRow.title == "Не спать с закрытой крышкой")
    }

    @Test func rowUnavailableNamesTheCommand() throws {
        let row = try #require(AwakeRow.make(AwakeInfo(granted: false, on: false), live: true))
        #expect(row.look == .unavailable(on: false) && !row.isOn && !row.enabled)
        #expect(row.help.contains("agenthub awake grant") && row.help.contains("не выданы права"))
        // on without rights: shown as on, and the hint says what the hub can't do
        let on = try #require(AwakeRow.make(AwakeInfo(granted: false, on: true, threshold: 15), live: true))
        #expect(on.look == .unavailable(on: true) && on.isOn && !on.enabled)
        #expect(on.help.contains("не сможет вернуть сон") && on.help.contains("ниже 15%") && on.help.contains("agenthub awake grant"))
    }

    @Test func rowWithoutConnectionDoesNotClick() throws {
        let row = try #require(AwakeRow.make(AwakeInfo(on: true), live: false))
        // the last known flag is still shown
        #expect(row.look == .on && row.isOn && !row.enabled && row.help == ActionBlock.offline.help)
        let noRights = try #require(AwakeRow.make(AwakeInfo(granted: false, on: false), live: false))
        #expect(!noRights.enabled && noRights.help == ActionBlock.offline.help)
        #expect(AwakeRow.make(AwakeInfo(supported: false), live: true) == nil)
    }

    @Test func grantCommandByWhatTheHubTold() {
        #expect(AwakeText.grantCommand(hub: nil) == "agenthub awake grant")
        #expect(AwakeText.grantCommand(hub: HubInfo(home: "/h")) == "agenthub awake grant")
        // the hub told where its CLI is: the same form as the other terminal hints
        #expect(AwakeText.grantCommand(hub: HubInfo(home: "/h", cli: "/opt/hub/bin/agenthub.mjs")) == "env -u NODE_OPTIONS node /opt/hub/bin/agenthub.mjs awake grant")
        // a test copy has to be named, or the command would go to the live hub; a path with a space is quoted
        #expect(AwakeText.grantCommand(hub: HubInfo(home: "/tmp/my stand", testMode: true, cli: "/x/agenthub.mjs"))
            == "AGENTHUB_HOME='/tmp/my stand' env -u NODE_OPTIONS node /x/agenthub.mjs awake grant")
        #expect(AwakeText.notGranted(hub: HubInfo(home: "/h", cli: "/x/agenthub.mjs")).contains("node /x/agenthub.mjs awake grant"))
        // the greyed row copies that command on a click and says so
        #expect(AwakeText.clickCopies == "Щелчок по строке копирует эту команду." && AwakeText.copied == "Команда скопирована")
        #expect(AwakeText.menuCopies == "Не спать с закрытой крышкой — скопировать команду")
    }

    @Test func powerLineInSettings() {
        #expect(AwakeText.power(AwakeInfo(onBattery: nil, charge: 80)) == nil)
        #expect(AwakeText.power(AwakeInfo(onBattery: false, charge: 80)) == "Сейчас: питание от сети")
        #expect(AwakeText.power(AwakeInfo(onBattery: true, charge: 64)) == "Сейчас: от батареи, заряд 64%")
        #expect(AwakeText.power(AwakeInfo(onBattery: true, charge: nil)) == "Сейчас: от батареи")
    }

    @Test func settingsCardRepeatsTheDaemonsNumber() {
        // the card only tells: the charge is the one from the section, and nothing says it can be changed
        for text in [AwakeText.about(threshold: 10), AwakeText.help(threshold: 10), AwakeText.onWithoutRights(threshold: 10, hub: nil)] {
            #expect(text.contains("ниже 10%"))
            #expect(!text.contains("порог") && !text.contains("Менять") && !text.contains("настро"))
        }
        #expect(AwakeText.about(threshold: 37).contains("ниже 37%") && !AwakeText.about(threshold: 37).contains("10%"))
        #expect(AwakeText.about(threshold: 10).contains("в строке меню и в панели"))
    }

    // MARK: - the mark on the menu bar icon

    @Test func iconMarkCombinesWithEveryLook() {
        // nothing but the mark: the calm icon stays a template
        #expect(MenuBarLook.calm.sideMarks(awake: true) == [.awake] && MenuBarLook.calm.isTemplate)
        #expect(MenuBarLook.calm.sideMarks(awake: false).isEmpty)
        // paused: "‖" stays, the mark follows it
        let paused = MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: true)
        #expect(paused == .paused(0, blocker: false) && paused.pauseMark)
        #expect(paused.sideMarks(awake: true) == [.pause, .awake] && paused.sideMarks(awake: false) == [.pause])
        #expect(MenuBarLook.paused(1, blocker: true).sideMarks(awake: true) == [.pause, .awake])
        // attention looks keep their emblem and number
        #expect(MenuBarLook.waiting(2).sideMarks(awake: true) == [.awake] && MenuBarLook.waiting(2).count == 2 && MenuBarLook.waiting(2).emblem == .orange)
        #expect(MenuBarLook.blocked(1).sideMarks(awake: true) == [.awake] && MenuBarLook.blocked(1).emblem == .red)
        #expect(MenuBarLook.quiet.sideMarks(awake: true) == [.awake] && MenuBarLook.working.sideMarks(awake: true) == [.awake])
        // no connection: "?" stays, the flag is shown as last known
        #expect(MenuBarLook.offline.sideMarks(awake: true) == [.unknown, .awake] && MenuBarLook.offline.sideMarks(awake: false) == [.unknown])
    }

    @Test func iconIsMarkedWhileTheFlagIsOn() {
        #expect(AwakeInfo(on: true).marksIcon && !AwakeInfo(on: false).marksIcon)
        // on without rights is the case the mark matters most for
        #expect(AwakeInfo(granted: false, on: true).marksIcon)
        #expect(!AwakeInfo(supported: false, on: true).marksIcon)
    }

    @Test func iconTooltipSaysWhatTheMarkMeans() {
        let plain = MenuBarLook.calm.tooltip(status: .ok, waiting: 0, testMark: nil)
        let marked = MenuBarLook.calm.tooltip(status: .ok, waiting: 0, testMark: nil, awake: true)
        #expect(!plain.contains("крышк") && marked == plain + "\nКомпьютер не уснёт с закрытой крышкой")
        // with the pause and the test copy label: each on its place
        let all = MenuBarLook.paused(0, blocker: false).tooltip(status: .ok, waiting: 0, testMark: "ТЕСТ", awake: true)
        #expect(all == "Agent Hub: хаб на паузе\nКомпьютер не уснёт с закрытой крышкой\nТЕСТ")
    }

    // MARK: - journal and refusals

    @Test func journalLines() {
        func entry(_ raw: [String: JSONValue]) -> JournalEntry { JournalEntry(index: 0, raw: raw) }
        #expect(entry(["type": .string("awake-set"), "on": .bool(true), "peer": .string("app"), "pid": .number(42)]).typeLabel
            == "«Не спать с закрытой крышкой» включено (кем: приложение)")
        #expect(entry(["type": .string("awake-set"), "on": .bool(false), "peer": .string("cli")]).typeLabel
            == "«Не спать с закрытой крышкой» выключено (кем: терминал)")
        #expect(entry(["type": .string("awake-set"), "on": .bool(true)]).typeLabel == "«Не спать с закрытой крышкой» включено")
        #expect(entry(["type": .string("awake-low-battery"), "charge": .number(19), "threshold": .number(20)]).typeLabel == "Заряд 19% — сон возвращён")
        #expect(entry(["type": .string("awake-low-battery")]).typeLabel == "Мало заряда — сон возвращён")
        // someone switched it — an action; the battery guard is the hub's own doing
        #expect(entry(["type": .string("awake-set"), "on": .bool(true)]).isAction)
        #expect(!entry(["type": .string("awake-low-battery"), "charge": .number(19)]).isAction)
    }

    @Test func journalSaysTheHubDidItOnQuit() {
        func entry(_ raw: [String: JSONValue]) -> JournalEntry { JournalEntry(index: 0, raw: raw) }
        // no `pid`, and nobody to name: the hub put sleep back itself
        let quit = entry(["type": .string("awake-set"), "on": .bool(false), "peer": .string("hub"), "reason": .string("quit")])
        #expect(quit.typeLabel == "Хаб вернул сон при выходе" && !quit.typeLabel.contains("кем"))
        #expect(entry(["type": .string("awake-set"), "on": .bool(false), "peer": .string("hub")]).typeLabel == "Хаб вернул сон")
    }

    @Test func journalFailuresByReason() {
        func failed(_ reason: String?, on: Bool, granted: Bool? = nil) -> JournalEntry {
            var raw: [String: JSONValue] = ["type": .string("awake-failed"), "on": .bool(on), "code": .string("awake:failed")]
            if let reason { raw["reason"] = .string(reason) }
            if let granted { raw["granted"] = .bool(granted) }
            return JournalEntry(index: 0, raw: raw)
        }
        #expect(failed("set", on: true, granted: true).typeLabel == "Не удалось включить «Не спать с закрытой крышкой»")
        #expect(failed("set", on: false, granted: true).typeLabel == "Не удалось выключить «Не спать с закрытой крышкой»")
        #expect(failed("low-battery", on: false, granted: true).typeLabel == "Мало заряда, но вернуть сон не удалось")
        #expect(failed("quit", on: false, granted: true).typeLabel == "При выходе вернуть сон не удалось")
        // the cause a human can fix is named
        #expect(failed("low-battery", on: false, granted: false).typeLabel == "Мало заряда, но вернуть сон не удалось: у хаба нет прав")
        #expect(failed("set", on: true, granted: false).typeLabel == "Не удалось включить «Не спать с закрытой крышкой»: у хаба нет прав")
        // a reason of a newer daemon still reads as a sentence, not as the raw type
        #expect(failed("later", on: false).typeLabel == "Не удалось сменить режим сна" && failed(nil, on: false).typeLabel == "Не удалось сменить режим сна")
        #expect(failed("set", on: true).isAction)
    }

    @Test(.hubLang(.en)) func journalLinesInEnglish() {
        func entry(_ raw: [String: JSONValue]) -> JournalEntry { JournalEntry(index: 0, raw: raw) }
        #expect(entry(["type": .string("awake-set"), "on": .bool(false), "peer": .string("hub"), "reason": .string("quit")]).typeLabel == "The hub brought sleep back on quit")
        #expect(entry(["type": .string("awake-failed"), "on": .bool(false), "reason": .string("quit"), "granted": .bool(false)]).typeLabel
            == "Couldn't bring sleep back on quit: the hub has no rights")
        #expect(entry(["type": .string("awake-failed"), "on": .bool(false), "reason": .string("low-battery")]).typeLabel == "Low battery, but sleep couldn't be brought back")
        #expect(AwakeText.help(threshold: 10).contains("drops below 10%") && AwakeText.about(threshold: 10).contains("drops below 10%"))
        #expect(!AwakeText.about(threshold: 10).lowercased().contains("threshold") && !AwakeText.about(threshold: 10).contains("change"))
    }

    @Test func refusalsHaveText() {
        let codes = ["awake:unsupported", "awake:not-granted", "awake:failed", "awake:disabled", "args:on:type"]
        for code in codes {
            #expect(Explain.knownCodes.contains(code), "\(code) is not in knownCodes")
            #expect(Explain.covers(code), "no text for \(code)")
            #expect(AwakeText.error(code) != nil)
        }
        #expect(Set(codes) == Explain.awakeCodes)
        #expect(AwakeText.error("awake:not-granted")?.contains("agenthub awake grant") == true)
        // the charge is no setting any more: its refusals are gone with the route
        #expect(AwakeText.error("args:percent:range") == nil && !Explain.knownCodes.contains("args:percent:type"))
        #expect(AwakeText.error("estop") == nil && AwakeText.error(nil) == nil)
    }

    // MARK: - the made-up section for snapshots

    @Test func demoSectionOnlyForATestCopy() throws {
        #expect(AwakeLook.make(AwakeDemo.info(named: "off")) == .off)
        #expect(AwakeLook.make(AwakeDemo.info(named: "on")) == .on)
        #expect(AwakeLook.make(AwakeDemo.info(named: "unavailable")) == .unavailable(on: false))
        #expect(AwakeLook.make(AwakeDemo.info(named: "on-unavailable")) == .unavailable(on: true))
        #expect(AwakeDemo.info(named: "maybe") == nil)
        let stand = ["AgentHub", "--home", "/tmp/stand", "--demo-awake", "on"]
        #expect(AwakeDemo.info(arguments: stand, environment: [:])?.on == true)
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--demo-awake", "on"], environment: ["AGENTHUB_HOME": "/tmp/stand"])?.on == true)
        // the live hub never shows a made-up switch
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--demo-awake", "on"], environment: [:]) == nil)
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--home", HubPaths.defaultHome + "/", "--demo-awake", "on"], environment: [:]) == nil)
        // the live directory by another spelling is still the live one: a symbolic link, `..`, letter case
        let dir = "/tmp/ah-awake-" + UUID().uuidString.prefix(8)
        let link = dir + "-link"
        try FileManager.default.createDirectory(atPath: dir + "/Hub", withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: dir + "/Hub")
        defer { try? FileManager.default.removeItem(atPath: dir); try? FileManager.default.removeItem(atPath: link) }
        let live = dir + "/Hub"
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--home", link, "--demo-awake", "on"], environment: [:], liveHome: live) == nil)
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--home", dir + "/x/../Hub/", "--demo-awake", "on"], environment: [:], liveHome: live) == nil)
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--home", dir + "/hub", "--demo-awake", "on"], environment: [:], liveHome: live) == nil)
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--demo-awake", "on"], environment: ["AGENTHUB_HOME": link], liveHome: live) == nil)
        // a directory that isn't there yet is compared too
        #expect(AwakeDemo.samePlace(dir + "/Gone/", dir + "/gone") && !AwakeDemo.samePlace(dir + "/Gone", live))
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--home", dir + "/Other", "--demo-awake", "on"], environment: [:], liveHome: live)?.on == true)
        // no value, no key
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--home", "/tmp/stand", "--demo-awake"], environment: [:]) == nil)
        #expect(AwakeDemo.info(arguments: ["AgentHub", "--home", "/tmp/stand"], environment: [:]) == nil)
        // not a diagnostic key: it changes what a launch shows, not what kind of launch it is
        #expect(!QuitPolicy.diagnosticArguments.contains(AwakeDemo.argument))
    }

    // MARK: - the store

    @Test func replyCarriesTheSectionOnARefusalToo() {
        let done = AwakeReply(status: 200, body: Data(#"{"awake":\#(fullJSON)}"#.utf8))
        #expect(done.ok && done.code == nil && done.awake?.on == true && done.awake?.threshold == 30)
        // 409: the daemon checked the rights again and says how it is now
        let refused = AwakeReply(status: 409, body: Data(#"{"error":"awake:not-granted","awake":{"supported":true,"granted":false,"on":false,"threshold":10}}"#.utf8))
        #expect(!refused.ok && refused.code == "awake:not-granted" && refused.awake == AwakeInfo(granted: false, on: false))
        let failed = AwakeReply(status: 500, body: Data(#"{"error":"awake:failed","awake":\#(fullJSON)}"#.utf8))
        #expect(!failed.ok && failed.code == "awake:failed" && failed.awake?.on == true)
        // an older daemon, a refusal before the service (400, 503): no section, the state stays
        let bare = AwakeReply(status: 400, body: Data(#"{"error":"args:on:type"}"#.utf8))
        #expect(bare.code == "args:on:type" && bare.awake == nil)
        #expect(AwakeReply(status: 200, body: Data("{}".utf8)) == AwakeReply(status: 200))
        #expect(AwakeReply(status: 502, body: Data("oops".utf8)) == AwakeReply(status: 502))
    }

    @MainActor @Test func refusalWithTheSectionGreysTheRowAtOnce() throws {
        var st = HubState()
        st.awake = AwakeInfo(granted: true, on: false)
        let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: st)
        #expect(AwakeRow.make(store.awake, live: true)?.enabled == true)
        let refusal = store.take(AwakeReply(status: 409, code: "awake:not-granted", awake: AwakeInfo(granted: false, on: false)))
        #expect(refusal?.code == "awake:not-granted")
        let row = try #require(AwakeRow.make(store.awake, live: true))
        #expect(row.look == .unavailable(on: false) && !row.enabled)
        // a refusal without the section leaves the state alone
        let bare = store.take(AwakeReply(status: 503, code: "awake:disabled"))
        #expect(bare?.code == "awake:disabled" && store.awake == AwakeInfo(granted: false, on: false))
        // done: the section is applied, nothing to report
        let done = store.take(AwakeReply(status: 200, awake: AwakeInfo(on: true)))
        #expect(done == nil && store.awake?.on == true)
    }

    // MARK: - the made-up state reaches nothing

    @Test func detachedClientNeverConnects() async throws {
        // a daemon that happens to listen in the stand's directory: a real socket, so nothing but `detached` stops a request
        let dir = "/tmp/ah-awake-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let path = dir + "/hub.sock"
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        try #require(fd >= 0)
        defer { close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in buf.copyBytes(from: Array(path.utf8).prefix(buf.count - 1)) }
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        try #require(bound == 0 && listen(fd, 4) == 0)
        #expect(HubPaths.checkSocket(path) == nil)
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)

        let client = HubClient(socketPath: path, detached: true)
        // the click on the made-up switch, quitting, and the stream
        await #expect(throws: HubError.self) { _ = try await client.setAwake(true) }
        await #expect(throws: HubError.self) { _ = try await client.shutdown() }
        await #expect(throws: HubError.self) { for try await _ in client.events(lastEventId: nil) {} }
        do { _ = try await client.setAwake(true) } catch let e as HubError {
            guard case .socket(let why) = e else { Issue.record("not refused before the connection: \(e)"); return }
            #expect(why.contains("выдуманное состояние"))
        }
        // nobody knocked
        #expect(accept(fd, nil, nil) == -1 && errno == EAGAIN)
        #expect(!HubClient(socketPath: path).detached)
    }

    @MainActor @Test func storeAppliesTheEventSection() throws {
        var st = HubState()
        st.awake = AwakeInfo(on: false)
        let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: st)
        #expect(store.awake?.on == false)
        store.state?.awake = AwakeInfo(on: true, threshold: 40)
        #expect(store.awake?.marksIcon == true && store.awake?.threshold == 40)
    }
}
