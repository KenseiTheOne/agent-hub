import Foundation
import Testing
@testable import AgentHubKit

// Agent Hub verification round 2: release notes without repeating the version, lines after a rollback, a moved tag in "Settings",
// reinstall hints for a hub from the installer, the rollback and app launch journal, "Needs you" without waitingFor,
// paths in the "Is it safe to shut down" card, quitting on a hub update.

private func info(_ json: String) throws -> HubUpdateInfo {
    try JSONDecoder().decode(HubUpdateInfo.self, from: Data(json.utf8))
}
private let base = #""installed":true,"running":"0.2.0","label":"0.2.0","current":{"label":"0.2.0","version":"0.2.0","tag":"v0.2.0","commit":"abcdef1234567890","cdhash":"d9a3763651fc0000000000000000000000000000"},"previous":{"label":"0.1.0"},"enabled":true,"setting":true,"config":true,"configured":true,"checking":false"#
private func either(_ s: String?, _ ru: String, _ en: String) -> Bool { s == ru || s == en }
private func has(_ s: String?, _ ru: String, _ en: String) -> Bool { (s ?? "").contains(ru) || (s ?? "").contains(en) }
private let now = ISO8601DateFormatter().string(from: Date())

@Suite struct Round2FixTests {
    @Test func releaseNotesDropTheVersion() throws {
        typealias N = HubUpdateInfo.Notes
        // subject per §9 ("Agent Hub 0.3.0") — no notes
        #expect(HubUpdateText.releaseNotes(N(subject: "Agent Hub 0.3.0"), version: "0.3.0") == nil)
        #expect(HubUpdateText.releaseNotes(N(subject: "v0.3.0"), version: "0.3.0") == nil)
        // the subject is the version, there is a body: the first body line becomes the subject
        #expect(HubUpdateText.releaseNotes(N(subject: "Agent Hub v0.3.0", body: "Карточка «Можно ли выключать»\nвторая"), version: "0.3.0") == N(subject: "Карточка «Можно ли выключать»", body: "вторая"))
        // "Agent Hub 0.2.0: text …" → "Text …"
        #expect(HubUpdateText.releaseNotes(N(subject: "Agent Hub 0.2.0: карточка …", body: "b"), version: "0.2.0") == N(subject: "Карточка …", body: "b"))
        #expect(HubUpdateText.releaseNotes(N(subject: "Agent Hub 0.2.0 — быстрее"), version: "0.2.0")?.subject == "Быстрее")
        // a foreign version and an ordinary subject are left alone
        #expect(HubUpdateText.releaseNotes(N(subject: "Agent Hub 0.2.0: x"), version: "0.3.0")?.subject == "Agent Hub 0.2.0: x")
        #expect(HubUpdateText.releaseNotes(N(subject: "Быстрее поповер"), version: "0.3.0")?.subject == "Быстрее поповер")
        // the popover and the confirmation window do not repeat the version
        let a = try info("{\(base),\"available\":{\"version\":\"0.3.0\",\"tag\":\"v0.3.0\",\"commit\":\"1234567890abcdef1234567890abcdef12345678\",\"notes\":{\"subject\":\"Agent Hub 0.3.0\"}},\"install\":{\"phase\":\"idle\"}}")
        #expect(HubUpdateText.line(a)?.note == nil)
        let confirmText = HubUpdateText.installConfirm(a)?.text ?? ""
        #expect(!confirmText.contains("Agent Hub 0.3.0"), "\(confirmText)")
        let parts = HubUpdateText.notesParts(HubUpdateInfo.Notes(subject: "Agent Hub 0.3.0: тема", body: "1\n2\n3\n4"), version: "0.3.0")
        // the body is two lines; if there is more — an ellipsis on the second one, without a separate "…" line and without ".…"
        #expect(parts?.subject == "Тема" && parts?.body == "1\n2…")
        let dotted = HubUpdateText.notesParts(HubUpdateInfo.Notes(subject: "т", body: "Первая.\nВторая строка тела.\nТретья."), version: "0.3.0")
        #expect(dotted?.body == "Первая.\nВторая строка тела…")
        #expect(HubUpdateText.notesParts(HubUpdateInfo.Notes(subject: "т", body: "Одна."), version: "0.3.0")?.body == "Одна.")
    }

    @Test func afterRollbackTheLeftVersionIsNotNew() throws {
        let rb = try info("{\(base),\"available\":{\"version\":\"0.3.0\"},\"install\":{\"phase\":\"done\",\"op\":\"rollback\",\"label\":\"0.2.0\",\"from\":\"0.3.0\",\"finishedAt\":\"\(now)\"}}")
        // the rollback result is visible even though 0.3.0 is "available"
        let l = try #require(HubUpdateText.line(rb))
        #expect(l.kind == .done && either(l.title, "Хаб возвращён на 0.2.0", "The hub is back on 0.2.0") && either(l.detail, "Было 0.3.0", "Was 0.3.0"))
        // after "Got it" — not "New hub version: 0.3.0 · Update", but without the blue button
        let after = try #require(HubUpdateText.line(rb, ackedDone: true))
        #expect(after.kind == .info && after.button == nil && has(after.title, "0.3.0 можно поставить снова", "0.3.0 can be installed again"))
        #expect(!has(after.title, "Новая версия", "New hub version"))
        #expect(either(HubUpdateText.installButton(rb), "Поставить 0.3.0 снова", "Install 0.3.0 again"))
        // a newer one came out — the usual "New version"
        let newer = try info("{\(base),\"available\":{\"version\":\"0.3.1\"},\"install\":{\"phase\":\"done\",\"op\":\"rollback\",\"label\":\"0.2.0\",\"from\":\"0.3.0\",\"finishedAt\":\"\(now)\"}}")
        #expect(HubUpdateText.line(newer, ackedDone: true)?.kind == .available)
        // the update result after "Got it" — from then on as without a result (nothing newer — nothing)
        let up = try info("{\(base),\"install\":{\"phase\":\"done\",\"op\":\"install\",\"label\":\"0.2.0\",\"from\":\"0.1.0\",\"finishedAt\":\"\(now)\"}}")
        #expect(HubUpdateText.line(up)?.kind == .done && HubUpdateText.line(up, ackedDone: true) == nil)
    }

    @Test func movedTagWarnsInSettingsToo() throws {
        let m = try info("{\(base),\"available\":{\"version\":\"0.4.0\",\"moved\":{\"old\":\"a90f25f9ee12\",\"new\":\"8af83b04153e\"}},\"install\":{\"phase\":\"idle\"}}")
        #expect(has(HubUpdateText.movedWarning(m), "Тег релиза 0.4.0 перенесён на другой коммит", "Release tag 0.4.0 was moved to another commit"))
        let plain = try info("{\(base),\"available\":{\"version\":\"0.4.0\"},\"install\":{\"phase\":\"idle\"}}")
        #expect(HubUpdateText.movedWarning(plain) == nil)
    }

    @Test func notInstalledHidesOldInstallResult() throws {
        let wf = try info(#"{"installed":false,"running":"0.1.0","label":null,"install":{"phase":"done","op":"install","label":"0.3.0","finishedAt":"2026-11-07T20:28:00.000Z"}}"#)
        #expect(HubUpdateText.installLine(wf) == nil)
        let failed = try info(#"{"installed":false,"running":"0.1.0","install":{"phase":"failed","op":"install","label":"0.3.0","error":"hub-update:build-failed","finishedAt":"2099-01-01T00:00:00.000Z"}}"#)
        #expect(HubUpdateText.installLine(failed) == nil)
        // installed, the result is about another label (not the current one) — not "Updated to …"
        let other = try info("{\(base),\"install\":{\"phase\":\"done\",\"op\":\"install\",\"label\":\"0.3.0\",\"finishedAt\":\"\(now)\"}}")
        #expect(HubUpdateText.installLine(other) == nil)
    }

    @Test func rollbackTextAndFingerprintWording() throws {
        let i = try info("{\(base),\"install\":{\"phase\":\"idle\"}}")
        let r = try #require(HubUpdateText.rollbackConfirm(i))
        #expect(either(r.text, "Хаб вернётся на 0.1.0: она уже собрана, перезапуск займёт несколько секунд. Сейчас: 0.2.0.", "The hub goes back to 0.1.0: it's already built, the restart takes a few seconds. Now: 0.2.0."))
        let d = HubUpdateText.detailLines(i).joined(separator: "\n")
        #expect(has(d, "отпечаток d9a3763651fc", "fingerprint d9a3763651fc") && !has(d, "сборка d9a", "build d9a"))
        #expect(HubUpdateText.reason("hub-update:node-missing") != "hub-update:node-missing")
    }

    @Test func reinstallHintForInstallerUsers() {
        let home = "/Users/u/Library/Application Support/AgentHub"
        let cli = home + "/Versions/current/src/daemon/bin/agenthub"
        // no daemon: the install CLI is found via Versions/current — a full path and the installer, not "from the agent-hub folder"
        let t = ReinstallHint.text(hub: nil, home: home, fileExists: { $0 == cli }, userHome: "/Users/u")
        #expect(t.contains("bash install.sh") && t.contains("node \"$HOME/Library/Application Support/AgentHub/Versions/current/src/daemon/bin/agenthub\" install --apply"))
        #expect(!t.contains("Из папки") && !t.contains("From the agent-hub"))
        // no install — the hub from the repository
        let repo = ReinstallHint.text(hub: nil, home: home, fileExists: { _ in false }, userHome: "/Users/u")
        #expect(has(repo, "env -u NODE_OPTIONS node daemon/bin/agenthub install --apply", "env -u NODE_OPTIONS node daemon/bin/agenthub install --apply"))
        // the daemon is reachable (/state.hub.cli) — the full path of its CLI
        let live = ReinstallHint.text(hub: HubInfo(cli: "/Users/u/src/agent-hub/daemon/bin/agenthub"), home: home, fileExists: { _ in false }, userHome: "/Users/u")
        #expect(live.contains("node \"$HOME/src/agent-hub/daemon/bin/agenthub\" install --apply"))
        #expect(DaemonLaunchState.notInstalled.offlineHint(home: home, fileExists: { $0 == cli })?.contains("install.sh") == true)
        #expect(LaunchAgentHint.text(hub: nil, home: home, fileExists: { $0 == cli }).contains("Versions/current"))
    }

    @Test func journalRollbackAndLaunchResult() {
        func title(_ raw: [String: JSONValue]) -> String { JournalEntry(index: 0, raw: raw).typeLabel }
        let sw = title(["type": .string("hub-update-switch"), "op": .string("rollback"), "label": .string("0.2.0")])
        #expect(either(sw, "Откат хаба — перезапуск", "Hub rollback — restarting"))
        #expect(sw.count <= 32, "the title column does not truncate it")
        let inst = title(["type": .string("hub-update-switch"), "op": .string("install")])
        #expect(inst.count <= 32 && !has(inst, "Откат", "rollback"))
        #expect(either(title(["type": .string("hub-update-failed"), "op": .string("rollback")]), "Откат хаба не удался", "Hub rollback failed"))
        // a failed and a skipped launch — not "restarted"
        let bad = title(["type": .string("app-launch"), "reason": .string("hub-update"), "ok": .bool(false), "code": .number(1)])
        #expect(either(bad, "Не удалось запустить приложение (код 1)", "Couldn't launch the app (code 1)"))
        let skipped = title(["type": .string("app-launch"), "reason": .string("hub-update"), "ok": .bool(false), "skipped": .string("test-mode")])
        #expect(either(skipped, "Приложение не запущено: тестовый каталог", "App not launched: test folder"))
        let ok = title(["type": .string("app-launch"), "reason": .string("hub-update"), "ok": .bool(true)])
        #expect(either(ok, "Хаб запустил новую версию приложения", "Hub launched the new app version"))
    }

    @Test func waitingSessionWithoutWaitingForReadsWhole() throws {
        let s = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"sessionId":"aaaaaaaa-0000-4000-8000-000000000001","pid":1,"status":"waiting","name":"Game — Level editor"}"#.utf8))
        let l = s.attentionLines
        #expect(l.title == "Game — Level editor" && either(l.sub, "ждёт ответа в терминале", "waiting for you in the terminal"))
        let q = try JSONDecoder().decode(SessionInfo.self, from: Data(#"{"sessionId":"aaaaaaaa-0000-4000-8000-000000000001","pid":1,"status":"waiting","name":"ES","waitingFor":"permission"}"#.utf8))
        #expect(has(q.attentionLines.title, "ждёт вас", "needs you") && either(q.attentionLines.sub, "разрешение", "permission"))
    }

    @Test func idleRowPathsDoNotBreak() {
        let t = IdleCard.unbreakablePaths("не найден claude в ~/.local/bin, /usr/local/bin")
        #expect(t.replacingOccurrences(of: "\u{2060}", with: "") == "не найден claude в ~/.local/bin, /usr/local/bin")
        #expect(t.contains("/\u{2060}usr/\u{2060}local/\u{2060}bin") && !t.contains("/\u{2060} "))
        #expect(IdleCard.unbreakablePaths("без путей") == "без путей")
        // 2026-11-09: a session name with a hyphen does not break ("demo-" / "d9"); a dash and a hyphen next to a space — as they were
        #expect(IdleCard.unbreakablePaths("ждут: alpha-1d, demo-d9 — ответить") == "ждут: alpha-\u{2060}1d, demo-\u{2060}d9 — ответить")
        #expect(IdleCard.unbreakablePaths("a - b, -x, y-") == "a - b, -x, y-")
    }

    @Test func quitByHubRestartIsImmediate() {
        // quitting on hub-update.restarting — .terminateNow, without the asynchronous /shutdown (otherwise quitting hung until SIGTERM)
        #expect(QuitPolicy.terminateNow(hubRestarting: true, arguments: ["AgentHub"]))
        #expect(!QuitPolicy.terminateNow(hubRestarting: false, arguments: ["AgentHub"]))
        #expect(QuitPolicy.terminateNow(hubRestarting: false, arguments: ["AgentHub", "--snapshot-panel", "x"]))
    }
}
