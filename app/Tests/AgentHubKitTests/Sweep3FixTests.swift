import Foundation
import Testing
@testable import AgentHubKit

// Sweep 3 findings (2026-11-07): a failed rollback while an update is available, the installer command under the home
// directory and for a test directory, per-hub app memory, language without a connection, "What's new" with a version,
// the bridge without a connection.

private func info(_ json: String) throws -> HubUpdateInfo {
    try JSONDecoder().decode(HubUpdateInfo.self, from: Data(json.utf8))
}

private let base = #""installed":true,"running":"0.2.0","label":"0.2.0","current":{"label":"0.2.0","version":"0.2.0","tag":"v0.2.0"},"previous":{"label":"0.1.0"},"enabled":true,"setting":true,"config":true,"configured":true"#
private func either(_ s: String?, _ ru: String, _ en: String) -> Bool { s == ru || s == en }

@Suite(.hubLang(.ru)) struct Sweep3FixTests {
    @Test func failedRollbackStaysVisibleWhenNewerIsAvailable() throws {
        let now = ISO8601DateFormatter().string(from: Date())
        // hub on 0.2.0, 0.3.0 available, rollback to 0.1.0 failed: the rollback label is the old version
        let rb = try info("{\(base),\"available\":{\"version\":\"0.3.0\"},\"install\":{\"phase\":\"failed\",\"op\":\"rollback\",\"label\":\"0.1.0\",\"error\":\"hub-update:untrusted-build\",\"log\":\"/l.log\",\"finishedAt\":\"\(now)\"}}")
        #expect(HubUpdateText.failureVisible(rb))
        let l = try #require(HubUpdateText.line(rb))
        #expect(l.kind == .failed && either(l.title, "Откат хаба на 0.1.0 не удался", "Hub rollback to 0.1.0 failed"))
        let st = try #require(HubUpdateText.installLine(rb))
        #expect(st.failed && st.log == "/l.log")
        // install keeps the old rule: if a newer version is out, show it right away, not "0.3.0 failed"
        let inst = try info("{\(base),\"available\":{\"version\":\"0.3.1\"},\"install\":{\"phase\":\"failed\",\"op\":\"install\",\"label\":\"0.3.0\",\"error\":\"hub-update:build-failed\",\"finishedAt\":\"\(now)\"}}")
        #expect(!HubUpdateText.failureVisible(inst))
        #expect(HubUpdateText.line(inst)?.kind == .available)
        // a rollback failure stays for one day, no longer
        let old = try info("{\(base),\"available\":{\"version\":\"0.3.0\"},\"install\":{\"phase\":\"failed\",\"op\":\"rollback\",\"label\":\"0.1.0\",\"finishedAt\":\"2020-01-01T00:00:00.000Z\"}}")
        #expect(!HubUpdateText.failureVisible(old))
    }

    @Test func installCommandUnderHomeWithSpaceAndForTestHome() {
        let home = "/Users/u"
        // a space under the home directory: a quoted tilde does not expand, so "$HOME/…"
        let spaced = HubInfo(cli: "/Users/u/My Projects/agent-hub/daemon/bin/agenthub")
        #expect(HubUpdateText.installCommand(spaced, userHome: home) == #"bash "$HOME/My Projects/agent-hub"/scripts/install.sh --origin "$HOME/My Projects/agent-hub""#)
        // without a space, as before: "~/…"
        #expect(HubUpdateText.installCommand(HubInfo(cli: "/Users/u/src/agent-hub/daemon/bin/agenthub"), userHome: home) == "bash ~/src/agent-hub/scripts/install.sh --origin ~/src/agent-hub")
        // test directory: with --home and --no-launchd, otherwise the copied command would install the live hub
        let test = HubInfo(home: "/tmp/ahs3-x/home", testMode: true, cli: "/Users/u/src/agent-hub/daemon/bin/agenthub")
        #expect(HubUpdateText.installCommand(test, userHome: home) == "bash ~/src/agent-hub/scripts/install.sh --origin ~/src/agent-hub --home /tmp/ahs3-x/home --no-launchd")
        let testSpaced = HubInfo(home: "/tmp/my hub", testMode: true, cli: "/Users/u/src/agent-hub/daemon/bin/agenthub")
        #expect(HubUpdateText.installCommand(testSpaced, userHome: home)?.hasSuffix(" --home '/tmp/my hub' --no-launchd") == true)
    }

    @Test func defaultsArePerHubAndStaleOnesArePruned() throws {
        let name = "agenthub-test-\(UUID().uuidString)"
        let d = try #require(UserDefaults(suiteName: name))
        defer { UserDefaults().removePersistentDomain(forName: name) }
        let live = HubPaths.defaultHome + "/hub.sock"
        let gone = "/tmp/ahs-gone-\(UUID().uuidString)/hub.sock"
        let kept = NSTemporaryDirectory() + "hub.sock"
        #expect(HubDefaults.key("pinNoteAck", socketPath: live) == "pinNoteAck:" + live)
        d.set("cdhash:aa|t", forKey: HubDefaults.key("pinNoteAck", socketPath: live))
        d.set("en", forKey: L10n.memoryKey(socketPath: gone))
        d.set("install|0.2.0|t", forKey: HubDefaults.key("hubUpdateDoneAck", socketPath: gone))
        d.set("ru", forKey: L10n.memoryKey(socketPath: kept))
        d.set("cdhash:bb|t", forKey: "pinNoteAck")          // the old bundle-wide key
        d.set("install|0.2.0|t", forKey: "hubUpdateDoneAck")
        let removed = HubDefaults.prune(d, keep: live)
        #expect(Set(removed) == ["hubLang:" + gone, "hubUpdateDoneAck:" + gone, "pinNoteAck", "hubUpdateDoneAck"])
        #expect(d.string(forKey: "pinNoteAck:" + live) == "cdhash:aa|t", "our own hub is left alone, even without a directory")
        #expect(d.string(forKey: "hubLang:" + kept) == "ru", "directory exists, so the memory stays")
        #expect(d.string(forKey: "pinNoteAck") == nil)
        // panel frame: live directory only, and not when sizes are set for screenshots
        #expect(HubDefaults.autosavesPanelFrame(arguments: ["AgentHub"], environment: [:]))
        #expect(!HubDefaults.autosavesPanelFrame(arguments: ["AgentHub", "--home", "/tmp/x"], environment: [:]))
        #expect(!HubDefaults.autosavesPanelFrame(arguments: ["AgentHub"], environment: ["AGENTHUB_HOME": "/tmp/x"]))
        #expect(!HubDefaults.autosavesPanelFrame(arguments: ["AgentHub", "--panel-height", "1400"], environment: [:]))
    }

    @Test func languageSettingUnknownUntilDaemonOrMemory() throws {
        let name = "agenthub-test-\(UUID().uuidString)"
        let d = try #require(UserDefaults(suiteName: name))
        defer { UserDefaults().removePersistentDomain(forName: name) }
        let sock = "/tmp/ah-lang/hub.sock"
        let l = L10n()
        l.remember(in: d, socketPath: sock)
        #expect(!l.settingKnown, "the daemon has not answered and there is no memory, so do not invent \"System\"")
        l.apply(setting: "en", effective: "en")
        #expect(l.settingKnown && l.setting == .en)
        #expect(d.string(forKey: L10n.settingMemoryKey(socketPath: sock)) == "en")
        // next launch without a connection: the setting is the one remembered for this hub
        let next = L10n()
        next.remember(in: d, socketPath: sock)
        #expect(next.settingKnown && next.setting == .en && next.lang == .en)
        // another hub has its own memory
        let other = L10n()
        other.remember(in: d, socketPath: "/tmp/ah-other/hub.sock")
        #expect(!other.settingKnown)
    }

    @Test func whatsNewCarriesVersionAndBridgeTextKnowsOffline() {
        #expect(either(HubUpdateText.whatsNewPrefix("0.3.0"), "Что нового в 0.3.0: ", "What's new in 0.3.0: "))
        #expect(either(HubUpdateText.whatsNewPrefix(nil), "Что нового: ", "What's new: "))
        #expect(either(BridgeSettingsText.missing(stateKnown: false), "Нет связи с хабом — состояние моста неизвестно", "No connection to the hub — the bridge state is unknown"))
        #expect(either(BridgeSettingsText.missing(stateKnown: true), "Служба действий хаба не запущена — моста нет", "The hub's actions service isn't running — no bridge"))
    }
}
