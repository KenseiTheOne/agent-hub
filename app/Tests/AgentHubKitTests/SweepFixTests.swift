import Foundation
import Testing
@testable import AgentHubKit

// Tests for the findings of the 2026-11-07 pass (sweep-1): texts and counts in the shell. The language is a process-wide setting, so
// the tests run serially with an explicit L10n.shared.lang at the start of each one.

@Suite(.serialized, .hubLang(.ru)) struct SweepFixTests {
    // without a daemon connection — this hub's last effective language, not the macOS language
    @Test func languageRememberedPerHub() {
        let suite = "agenthub-test-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        defer { d.removePersistentDomain(forName: suite) }
        let other: Lang = Lang.system == .ru ? .en : .ru
        let a = L10n()
        a.remember(in: d, socketPath: "/tmp/hub-a/hub.sock")
        #expect(a.lang == Lang.system, "nothing remembered — macOS language")
        a.apply(setting: other.rawValue, effective: other.rawValue)
        #expect(a.lang == other)
        // a new launch (no connection yet) — this hub's remembered language right away
        let b = L10n()
        b.remember(in: d, socketPath: "/tmp/hub-a/hub.sock")
        #expect(b.lang == other)
        // another hub (a test directory) has its own
        let c = L10n()
        c.remember(in: d, socketPath: "/tmp/hub-b/hub.sock")
        #expect(c.lang == Lang.system)
        // without memory (previews, tests) — nothing is written
        let e = L10n()
        e.apply(setting: nil, effective: other.rawValue)
        #expect(d.string(forKey: L10n.memoryKey(socketPath: "/tmp/hub-c/hub.sock")) == nil)
    }

    @Test func pinAdviceNoPlainBundleSh() {
        L10n.shared.lang = .ru
        let a = PinAdvice()
        a.update(pinPath: NSHomeDirectory() + "/Library/Application Support/AgentHub/Versions/0.2.0/AgentHub.app", installed: true)
        #expect(a.openPinned.hasPrefix("Откройте закреплённую сборку: ~/Library/Application Support/AgentHub/Versions/0.2.0/AgentHub.app."))
        #expect(a.openPinned.contains("bash install.sh"))
        #expect(!a.openPinned.contains("bundle.sh"))
        a.update(pinPath: nil, installed: false)
        #expect(a.openPinned.hasPrefix("Откройте закреплённую сборку приложения."))
        #expect(a.openPinned.contains("scripts/bundle.sh --pin-live"), "hub from a working copy: pinning is deliberate, with --pin-live")
        #expect(a.repairOnly.contains("--pin-live"))
    }

    // "Waiting for you": for a blocker without ":" the title is the header itself (the gist), not the generic status label
    @Test func attentionLinesKeepTheGist() {
        L10n.shared.lang = .ru
        var p = PluginState(id: "hermes", title: "Hermes", status: .error, header: [Item(title: "Задача «demo: утренний итог» упала", status: .error)])
        p.statusLabels = ["error": .init(label: "Задача упала или Hermes не отвечает", hint: "")]
        let (t, sub) = p.attentionLines
        #expect(t == "Задача «demo: утренний итог» упала")
        #expect(sub == "Hermes · Задача упала или Hermes не отвечает")
        let runs = PluginState(id: "batch", title: "Прогоны", status: .block, header: [Item(title: "Прогоны не запустятся: Unity открыт", status: .block)])
        #expect(runs.attentionLines.title == "Прогоны не запустятся" && runs.attentionLines.sub == "Unity открыт")
    }

    @Test func tileLabelFromHeader() {
        let p = PluginState(id: "agents", title: "Фоновые агенты", status: .ok, header: [Item(title: "Фоновых прогонов нет", status: .ok, params: ["tile": "0 прогонов", "tileLabel": "Агенты"])])
        #expect(p.tileLabel == "Агенты")
        #expect(p.tileValue == "0 прогонов")
        #expect(PluginState(id: "x", title: "Икс", status: .ok, header: [Item(title: "ok")]).tileLabel == "Икс")
    }

    // journal: a confirmation request shows the plugin and the action, not the proposal id; a hub update shows the version
    @Test func journalTargets() {
        let confirm = JournalEntry(index: 0, raw: ["type": .string("action-confirm-requested"), "action": .string("b13fd09157e55b7f"), "plugin": .string("hermes"), "title": .string("Поставить на паузу"), "peer": .string("app")])
        #expect(confirm.target == "Поставить на паузу · hermes")
        let old = JournalEntry(index: 0, raw: ["type": .string("action-confirm-requested"), "action": .string("b13fd09157e55b7f")])
        #expect(old.target == "b13fd09157e55b7f", "an old journal without the plugin — at least something")
        let hub = JournalEntry(index: 0, raw: ["type": .string("hub-update-start"), "op": .string("install"), "label": .string("0.3.0")])
        #expect(hub.target == "0.3.0")
        let prim = JournalEntry(index: 0, raw: ["type": .string("action"), "action": .string("session.respond"), "primitive": .string("session.respond")])
        #expect(prim.target == "session.respond")
    }

    // the "Sessions" subtitle — the same count as the sidebar, with plural forms
    @Test func sessionsSubtitleMatchesSidebar() {
        L10n.shared.lang = .ru
        let list = [SessionInfo(sessionId: "a", status: "waiting"), SessionInfo(sessionId: "b", status: "busy"), SessionInfo(sessionId: "c", status: "idle")]
        // b has a PermissionRequest card, a has two cards from subagents: two are waiting, not max(…)
        let w = SidebarStatus.waitingCount(list, waiting: 1, cardSessions: ["a", "a", "b"])
        #expect(w == 2)
        #expect(SidebarStatus.sessions(list, waiting: 1, cardSessions: ["a", "a", "b"]).text.hasPrefix("2 ждут ответа"))
        #expect(SidebarStatus.sessionsSubtitle(open: 3, waiting: w) == "3 открыто · 2 ждут вас")
        #expect(SidebarStatus.sessionsSubtitle(open: 5, waiting: 1) == "5 открыто · 1 ждёт вас")
        #expect(SidebarStatus.sessionsSubtitle(open: 5, waiting: 0) == "5 открыто")
    }

    // "claude not found…": the subtitle is the content of the "Where the data comes from" section, not its bare title
    @Test func brokenDetailTakesSectionChildren() {
        var p = PluginState(id: "claude-sessions", title: "Сессии", status: .unknown,
                            header: [Item(title: "Не найден claude — хаб ищет его в ~/.local/bin", status: .unknown, event: "source-broken")])
        p.body = [Item(title: "Откуда данные", params: ["color": "gray"]), Item(title: "claude agents --json недоступен — только файлы сессий · файлов сессий 0", level: 1)]
        #expect(SessionsPluginExtras(p).brokenDetail == "claude agents --json недоступен — только файлы сессий · файлов сессий 0")
        p.body = [Item(title: "Откуда данные", params: ["color": "gray"])]
        #expect(SessionsPluginExtras(p).brokenDetail == "Откуда данные", "a line without children — as is")
    }

    // badge tooltip: red comes from the plugin, not a "hub failure"
    @Test func tooltipNamesTheCulprit() {
        L10n.shared.lang = .ru
        let hermes = PluginState(id: "hermes", title: "Hermes", status: .error, header: [Item(title: "Задача «дайджест» упала", status: .error)])
        let ok = PluginState(id: "q", title: "Квота", status: .ok, header: [Item(title: "41%")])
        let who = MenuBarLook.culprit([ok, hermes])
        #expect(who == "Hermes — Задача «дайджест» упала")
        #expect(MenuBarLook.blocked(1).tooltip(status: .error, waiting: 1, testMark: nil, culprit: who) == "Agent Hub: Hermes — Задача «дайджест» упала, ждут вас: 1")
        #expect(MenuBarLook.culprit([ok]) == nil)
        let silent = PluginState(id: "hermes", title: "Hermes", status: .error, header: [Item(title: "Hermes не отвечает: служба молчит 5 мин", status: .error)])
        #expect(MenuBarLook.culprit([silent]) == "Hermes не отвечает: служба молчит 5 мин", "no \"Hermes — Hermes …\"")
        #expect(MenuBarLook.blocked(0).tooltip(status: .error, waiting: 0, testMark: nil) == "Agent Hub: Сбой", "no culprit — as before")
    }

    @Test func hubUpdateTexts() {
        L10n.shared.lang = .ru
        // hub from a working copy: the installer command with a full path, with this clone's --origin
        let hub = HubInfo(home: "/tmp/h", cli: NSHomeDirectory() + "/src/agent-hub/daemon/bin/agenthub")
        #expect(HubUpdateText.installCommand(hub) == "bash ~/src/agent-hub/scripts/install.sh --origin ~/src/agent-hub")
        #expect(HubUpdateText.installCommand(HubInfo(cli: "/U/Library/Application Support/AgentHub/Versions/current/src/daemon/bin/agenthub")) == nil)
        #expect(HubUpdateText.installCommand(HubInfo(cli: "/Volumes/My Disk/agent-hub/daemon/bin/agenthub")) == #"bash '/Volumes/My Disk/agent-hub'/scripts/install.sh --origin '/Volumes/My Disk/agent-hub'"#)
        #expect(!HubUpdateText.notInstalledText.contains("bash scripts/install.sh\n"))
        #expect(HubUpdateText.checkExplain.hasPrefix("Несколько раз в день"))
    }
}
