import Foundation

// Texts for updating the hub itself (docs/hub-updates.md §7): the line in the popover and the "Hub updates" card in
// Settings. Kept apart from Presentation.swift: the line logic is covered by tests (HubUpdateTests.swift).

public enum HubUpdateText {
    /// What to show in the popover: a version is available, install in progress, built and waiting for a restart, failed, updated.
    /// nil — nothing.
    public struct Line: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case available, progress, failed, ready, done, info }
        public var kind: Kind
        public var title: String
        public var detail: String?
        /// Button label ("Update"); nil — no button.
        public var button: String?
        /// Release description (the tag message subject) — on a separate line, truncated; nil — none.
        public var note: String? = nil
    }

    /// Phases in which an install or a rollback is in progress (progress indicator).
    public static let progressPhases: Set<String> = ["building", "switching", "trial", "rolling-back"]
    /// How long to show the install result: a failure (while there is no newer version) and a successful update.
    public static let resultShownFor: TimeInterval = 24 * 3600

    /// A human-friendly version label: "0.1.0-dev.6ceb3d8" (migration without a tag) → "0.1.0 (build from a commit)",
    /// "…dirty" → "0.1.0 (build from the working folder)". The commit — only in "Details".
    public static func displayLabel(_ label: String) -> String {
        guard let r = label.range(of: "-dev.") else { return label }
        let base = String(label[..<r.lowerBound])
        return label.hasSuffix(".dirty")
            ? tr("\(base) (сборка из рабочей папки)", "\(base) (build from the working folder)")
            : tr("\(base) (сборка из коммита)", "\(base) (build from a commit)")
    }

    /// An install failure stays visible: no longer than a day and only while there is no newer version (0.3.1 is out — right away
    /// "0.3.1 available" rather than "0.3.0 failed"). A failed rollback — a day with any available version: the rollback label is the old
    /// version, and the available one is by definition newer than the current one, so "a newer one is out" means nothing here.
    public static func failureVisible(_ info: HubUpdateInfo, now: Date = Date()) -> Bool {
        let i = info.install
        guard i.phase == "failed" || i.phase == "rolled-back" else { return false }
        if i.op != "rollback", let a = info.available?.version, a != i.label { return false }
        return recent(i.finishedAt, now: now)
    }

    static func recent(_ iso: String?, now: Date) -> Bool {
        guard let d = PluginUpdatesStatus.parseDate(iso) else { return true }
        return now.timeIntervalSince(d) < resultShownFor
    }

    /// The "Got it" key for the result in the popover: the line is hidden for this install, the next one shows again.
    public static func doneKey(_ info: HubUpdateInfo) -> String {
        "\(info.install.op ?? "")|\(info.install.label ?? "")|\(info.install.finishedAt ?? "")"
    }

    /// `ackedDone` — the human already dismissed this install's result ("Got it"): from then on — as if there were no result.
    public static func line(_ info: HubUpdateInfo?, now: Date = Date(), ackedDone: Bool = false) -> Line? {
        guard let info, info.installed else { return nil }
        let i = info.install
        let target = displayLabel(i.label ?? "?")
        switch i.phase {
        case let p where progressPhases.contains(p):
            let what = i.op == "rollback" ? tr("Возвращаю хаб на \(target)", "Rolling the hub back to \(target)") : tr("Обновляю хаб до \(target)", "Updating the hub to \(target)")
            return Line(kind: .progress, title: "\(what): \(stepText(i, brew: info.isBrew))", detail: nil, button: nil)
        case "ready":
            return Line(kind: .ready, title: readyTitle(i), detail: readyDetail(i), button: restartButton(i))
        case _ where failureVisible(info, now: now):
            let what = i.op == "rollback" ? tr("Откат хаба на \(target) не удался", "Hub rollback to \(target) failed") : tr("Обновление хаба до \(target) не удалось", "Hub update to \(target) failed")
            return Line(kind: .failed, title: what, detail: tr("Хаб остался на \(currentDisplay(info)) · подробности в Настройках", "Still on \(currentDisplay(info)) · details in Settings"), button: nil)
        // a temporary result: the human pressed "Update" in the popover and sees the outcome right here. Update — until
        // a newer version is out (then that one right away); rollback — even with an available version: it is usually the one we left
        case "done" where !ackedDone && (i.op == "rollback" || (i.op == "install" && info.available == nil)) && i.label == info.label && recent(i.finishedAt, now: now):
            let title = i.op == "rollback" ? tr("Хаб возвращён на \(target)", "The hub is back on \(target)") : tr("Хаб обновлён до \(target)", "The hub is updated to \(target)")
            let was = i.from.map { tr("Было \(displayLabel($0))", "Was \(displayLabel($0))") }
            return Line(kind: .done, title: title, detail: was, button: nil, note: i.op == "install" ? releaseNotes(info.current?.notes, version: info.current?.version ?? i.label)?.subject : nil)
        default:
            break
        }
        guard let a = info.available else { return nil }
        if a.moved != nil {
            return Line(kind: .failed, title: tr("Тег релиза \(a.version) перенесён на другой коммит", "Release tag \(a.version) was moved to another commit"),
                        detail: tr("Сейчас \(currentDisplay(info)) · проверьте коммит перед установкой", "Now \(currentDisplay(info)) · check the commit before installing"), button: tr("Обновить", "Update"))
        }
        // we have just rolled back from this version — it is not "new": no blue button, reinstalling is in Settings
        if isRolledBackFrom(info) {
            return Line(kind: .info, title: tr("\(a.version) можно поставить снова", "\(a.version) can be installed again"),
                        detail: tr("Сейчас \(currentDisplay(info)) после отката · в Настройках", "Now \(currentDisplay(info)) after a rollback · in Settings"), button: nil)
        }
        return Line(kind: .available, title: tr("Новая версия хаба: \(a.version)", "New hub version: \(a.version)"),
                    detail: tr("Сейчас \(currentDisplay(info))", "Now \(currentDisplay(info))"), button: tr("Обновить", "Update"), note: releaseNotes(a.notes, version: a.version)?.subject)
    }

    /// The available version is the one the hub has just rolled back from (the last operation is a completed rollback).
    public static func isRolledBackFrom(_ info: HubUpdateInfo) -> Bool {
        guard let a = info.available, info.install.phase == "done", info.install.op == "rollback", let from = info.install.from else { return false }
        return a.version == from
    }

    /// Release description without repeating the version. Subject "Agent Hub 0.3.0: card…" → "card…"; a subject that is only a version
    /// ("Agent Hub 0.3.0", "v0.3.0") counts as no subject: the first body line becomes the subject; no body — no description.
    public static func releaseNotes(_ n: HubUpdateInfo.Notes?, version: String?) -> HubUpdateInfo.Notes? {
        guard let n else { return nil }
        var subject = n.subject.trimmingCharacters(in: .whitespaces)
        if let v = version?.trimmingCharacters(in: .whitespaces), !v.isEmpty {
            let esc = NSRegularExpression.escapedPattern(for: v)
            let pattern = "^(?:agent\\s*hub\\s+)?v?" + esc + "(?:\\s*[:—–-]\\s*|\\s+|$)"
            if let r = subject.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
                subject = String(subject[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                // "Agent Hub 0.2.0: card …" → "Card …": the subject now stands on its own
                if let f = subject.first, f.isLowercase { subject = f.uppercased() + subject.dropFirst() }
            }
        }
        var body = (n.body ?? "").split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        if subject.isEmpty {
            guard !body.isEmpty else { return nil }
            subject = body.removeFirst().trimmingCharacters(in: .whitespaces)
        }
        return HubUpdateInfo.Notes(subject: subject, body: body.isEmpty ? nil : body.joined(separator: "\n"))
    }

    /// Description for Settings: subject and body separately (subject — up to two lines, body — up to `bodyLines` lines; Text itself
    /// truncates, with an ellipsis at the end of the visible line rather than a separate "…" line). nil — no description.
    /// Body — the first `bodyLines` lines; if there is more, the last of them has no trailing period and gets "…" ("…shorter…", not
    /// "shorter.…"). Text (lineLimit) truncates a wrapped long line — also with an ellipsis at the end of the visible line.
    public static func notesParts(_ n: HubUpdateInfo.Notes?, version: String?, bodyLines: Int = 2) -> (subject: String, body: String?)? {
        guard let r = releaseNotes(n, version: version) else { return nil }
        let lines = (r.body ?? "").split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        guard !lines.isEmpty else { return (r.subject, nil) }
        var shown = Array(lines.prefix(max(1, bodyLines)))
        if lines.count > shown.count, var last = shown.popLast() {
            while let c = last.last, ".,;:!…".contains(c) || c == " " { last.removeLast() }
            shown.append(last + "…")
        }
        return (r.subject, shown.joined(separator: "\n"))
    }

    /// The moved tag warning — for Settings (same as the popover line). nil — the tag was not moved.
    public static func movedWarning(_ info: HubUpdateInfo) -> String? {
        guard let a = info.available, a.moved != nil else { return nil }
        return tr("Тег релиза \(a.version) перенесён на другой коммит · проверьте коммит перед установкой (окно покажет оба)",
                  "Release tag \(a.version) was moved to another commit · check the commit before installing (the window shows both)")
    }

    /// phase = ready: a short title, so it does not wrap next to the button ("built" = built and verified: only a verified
    /// build reaches ready).
    public static func readyTitle(_ i: HubUpdateInfo.Install) -> String {
        let t = displayLabel(i.label ?? "?")
        return i.op == "rollback" ? tr("Хаб готов вернуться на \(t)", "Ready to go back to \(t)") : tr("Хаб \(t) собран", "Hub \(t) is built")
    }

    /// Waiting items in the ready phase → (hub cards, sessions without cards). An older daemon (no breakdown) — all are cards.
    public static func waitingParts(_ i: HubUpdateInfo.Install) -> (cards: Int, sessions: Int) {
        let cards = max(0, i.waitingCards ?? i.waiting ?? 0)
        let sessions = cards > 0 ? 0 : max(0, i.waitingSessions ?? 0)
        return (cards, sessions)
    }

    /// phase = ready: what a restart will do. A restart drops hub cards (the questions go to the terminal); a session
    /// waiting for an answer without a hub card is left alone — better not to interrupt it, but there is no need to scare with cards.
    public static func readyDetail(_ i: HubUpdateInfo.Install) -> String {
        let w = waitingParts(i)
        if w.cards > 0 { return tr("Ждут ответа: \(w.cards) — перезапуск снимет их карточки", "Waiting for an answer: \(w.cards) — a restart drops their cards") }
        if w.sessions > 0 { return tr("Ждут ответа сессии: \(w.sessions) — лучше сначала ответить", "Sessions waiting for an answer: \(w.sessions) — better answer first") }
        return tr("Ждёт перезапуска", "Waiting to restart")
    }

    /// The second-press button is short: the number waiting is in the explanation next to it.
    public static func restartButton(_ i: HubUpdateInfo.Install) -> String {
        tr("Перезапустить", "Restart")
    }

    /// Previous version button: "Roll back to X", "Return to X" (X newer than the current one, e.g. after a rollback); nil — no
    /// button (no previous version, or it is the same version as "Update to …").
    public static func previousButton(_ info: HubUpdateInfo) -> String? {
        guard let p = info.previous?.label else { return nil }
        if let a = info.available?.version, a == p { return nil }
        let cur = currentLabel(info)
        let shown = displayLabel(p)
        return PluginVersion.compare(p, cur) == .orderedDescending
            ? tr("Вернуться на \(shown)", "Return to \(shown)")
            : tr("Откатить на \(shown)", "Roll back to \(shown)")
    }

    /// Whether a rollback is possible now: a built version waiting for a restart — a rollback would silently discard it (the daemon also
    /// refuses, 409 hub-update:ready).
    public static func canRollback(_ info: HubUpdateInfo) -> Bool { info.install.phase != "ready" }

    /// Whether to show "Update to X" in Settings: not during an install and not in ready for the same version (there it is
    /// "Restart").
    public static func showInstallButton(_ info: HubUpdateInfo) -> Bool {
        guard let a = info.available else { return false }
        if progressPhases.contains(info.install.phase) { return false }
        if info.install.phase == "ready" && info.install.label == a.version { return false }
        return true
    }

    /// The "Update to X" label; the same version just failed to install — "Update to X again".
    public static func installButton(_ info: HubUpdateInfo) -> String? {
        guard let a = info.available else { return nil }
        if failureVisible(info), info.install.op == "install", info.install.label == a.version {
            return tr("Обновить до \(a.version) ещё раз", "Retry update to \(a.version)")
        }
        if isRolledBackFrom(info) { return tr("Поставить \(a.version) снова", "Install \(a.version) again") }
        return tr("Обновить до \(a.version)", "Update to \(a.version)")
    }

    /// Release description for the window and Settings: the subject and up to `bodyLines` body lines; long ones — with an ellipsis.
    public static func notesText(_ n: HubUpdateInfo.Notes?, bodyLines: Int = 3, lineLength: Int = 140) -> String? {
        guard let n else { return nil }
        func cut(_ s: String) -> String { s.count > lineLength ? String(s.prefix(lineLength - 1)) + "…" : s }
        var lines = [cut(n.subject)]
        let body = (n.body ?? "").split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        lines += body.prefix(bodyLines).map(cut)
        if body.count > bodyLines { lines.append("…") }
        return lines.joined(separator: "\n")
    }

    /// Confirmation before "Update": the version and the description; tag and commit — in the window's "Details". nil — nothing to install.
    public static func installConfirm(_ info: HubUpdateInfo) -> (title: String, text: String, details: String, button: String)? {
        guard let a = info.available else { return nil }
        let cur = currentDisplay(info)
        var parts: [String] = []
        if let n = notesText(releaseNotes(a.notes, version: a.version)) { parts.append(n) }
        parts.append(tr("Сейчас: \(cur)", "Now: \(cur)"))
        if let m = a.moved {
            parts.append(tr("Внимание: тег перенесли с коммита \(m.old.prefix(7)) на \(m.new.prefix(7)) после того, как хаб его видел. Ставьте, только если перенос сделали вы.",
                            "Warning: the tag was moved from commit \(m.old.prefix(7)) to \(m.new.prefix(7)) after the hub saw it. Install only if you moved it."))
        }
        if majorJump(from: currentLabel(info), to: a.version) {
            parts.append(tr("Это смена старшей версии (\(currentLabel(info)) → \(a.version)).", "This is a major version change (\(currentLabel(info)) → \(a.version))."))
        }
        if a.brew == true || info.isBrew {
            parts.append(tr("Хаб соберёт эту версию из пакета Homebrew отдельно (несколько минут), проверит её и перезапустится в неё; при ошибке останется на \(cur).",
                            "The hub builds this version from the Homebrew package separately (a few minutes), checks it and restarts into it; on error it stays on \(cur)."))
        } else {
            parts.append(tr("Хаб соберёт версию из тега отдельно (несколько минут), проверит её и перезапустится в неё; при ошибке останется на \(cur).",
                            "The hub builds this tag separately (a few minutes), checks it and restarts into it; on error it stays on \(cur)."))
        }
        let commit = a.commit.map { String($0.prefix(7)) } ?? "?"
        let details = a.brew == true || info.isBrew
            ? tr("Homebrew · коммит \(commit)", "Homebrew · commit \(commit)")
            : tr("тег \(a.tag ?? "v" + a.version) · коммит \(commit)", "tag \(a.tag ?? "v" + a.version) · commit \(commit)")
        return (tr("Обновить хаб до \(a.version)?", "Update the hub to \(a.version)?"), parts.joined(separator: "\n\n"), details, tr("Обновить", "Update"))
    }

    /// Confirmation of a rollback to the previous version. nil — nowhere to go.
    public static func rollbackConfirm(_ info: HubUpdateInfo) -> (title: String, text: String, details: String?, button: String)? {
        guard let p = info.previous?.label, let title = previousButton(info) else { return nil }
        let cur = currentDisplay(info)
        let shown = displayLabel(p)
        let text = tr("Хаб вернётся на \(shown): она уже собрана, перезапуск займёт несколько секунд. Сейчас: \(cur).",
                      "The hub goes back to \(shown): it's already built, the restart takes a few seconds. Now: \(cur).")
        let back = PluginVersion.compare(p, currentLabel(info)) == .orderedDescending
        return (title + "?", text, versionDetails(info.previous), back ? tr("Вернуться", "Go back") : tr("Откатить", "Roll back"))
    }

    /// The major version part increased.
    public static func majorJump(from: String, to: String) -> Bool {
        func major(_ v: String) -> Int? { Int(v.split(separator: ".").first ?? "") }
        guard let a = major(from), let b = major(to) else { return false }
        return b > a
    }

    /// Install progress by step — short, lowercase. brew — the sources are copied from the Homebrew tree, not downloaded.
    public static func stepText(_ i: HubUpdateInfo.Install, brew: Bool = false) -> String {
        switch i.phase {
        case "switching": return tr("перезапуск…", "restarting…")
        case "trial": return tr("запуск новой версии…", "starting the new version…")
        case "rolling-back": return tr("откат…", "rolling back…")
        default:
            // builder steps: clone → build → verify → selftest → promote; then the daemon re-verifies itself (verify)
            switch i.step {
            case "clone": return brew ? tr("копирование исходников из Homebrew…", "copying sources from Homebrew…") : tr("загрузка исходников…", "downloading sources…")
            case "verify", "selftest", "promote": return tr("проверка…", "checking…")
            case "switch", "restart": return tr("перезапуск…", "restarting…")
            default: return tr("сборка…", "building…")
            }
        }
    }

    public static func currentLabel(_ info: HubUpdateInfo) -> String {
        info.label ?? info.current?.label ?? info.running ?? "?"
    }

    /// The current version for humans: "0.2.0", "0.1.0 (build from a commit)".
    public static func currentDisplay(_ info: HubUpdateInfo) -> String { displayLabel(currentLabel(info)) }

    /// "Current version: 0.2.0". Tag and commit — in "Details" (`detailLines`), the description — `notesText`.
    public static func currentText(_ info: HubUpdateInfo) -> String {
        tr("Текущая версия: ", "Current version: ") + currentDisplay(info)
    }

    /// One version in "Details": label, tag, commit, build time, build fingerprint (cdhash).
    public static func versionDetails(_ v: HubUpdateInfo.Version?, date: (Date) -> String = Fmt.dateTime) -> String? {
        guard let v else { return nil }
        var parts = [v.label]
        if let t = v.tag { parts.append(tr("тег \(t)", "tag \(t)")) }
        if let c = v.commit { parts.append(tr("коммит \(c.prefix(7))", "commit \(c.prefix(7))")) }
        if v.dirty == true { parts.append(tr("с незакоммиченными правками", "with uncommitted changes")) }
        if let d = PluginUpdatesStatus.parseDate(v.builtAt) { parts.append(tr("собрана \(date(d))", "built \(date(d))")) }
        // fingerprint (cdhash) — same as in the pin card
        if let h = v.cdhash { parts.append(tr("отпечаток \(h.prefix(12))", "fingerprint \(h.prefix(12))")) }
        return parts.joined(separator: " · ")
    }

    /// "Details" of the "Hub updates" card: the current, available and previous versions with tags and commits.
    public static func detailLines(_ info: HubUpdateInfo, date: (Date) -> String = Fmt.dateTime) -> [String] {
        var out: [String] = []
        if let c = versionDetails(info.current, date: date) { out.append(tr("Текущая: ", "Current: ") + c) }
        if let a = info.available {
            out.append(tr("Доступна: ", "Available: ") + [a.version, a.brew == true ? "Homebrew" : nil, a.tag.map { tr("тег \($0)", "tag \($0)") }, a.commit.map { tr("коммит \($0.prefix(7))", "commit \($0.prefix(7))") }].compactMap { $0 }.joined(separator: " · "))
        }
        if let p = versionDetails(info.previous, date: date) { out.append(tr("Прежняя: ", "Previous: ") + p) }
        if info.isBrew { out.append(tr("Источник: Homebrew", "Source: Homebrew") + (info.brew.map { " · \($0)" } ?? "")) }
        return out
    }

    /// The check line under the toggle → (text, whether it is a warning).
    public static func checkLine(_ info: HubUpdateInfo, date: (Date) -> String = Fmt.dateTime) -> (text: String, warn: Bool) {
        if !info.config { return (tr("Выключено в config.json демона (services.hubUpdate.checkUpdates = false)", "Turned off in the daemon's config.json (services.hubUpdate.checkUpdates = false)"), false) }
        if info.isBrew { return brewCheckLine(info, date: date) }
        if !info.configured { return (tr("Адрес origin не известен — проверять негде", "The origin address is unknown — nowhere to check"), false) }
        if info.checking { return (tr("Проверяю…", "Checking…"), false) }
        var parts: [String] = []
        let checked = PluginUpdatesStatus.parseDate(info.checkedAt)
        if let e = info.error {
            let why = reason(e)
            parts.append(checked.map { tr("Последняя проверка: \(date($0))", "Last check: \(date($0))") } ?? tr("Проверить не удалось", "Couldn't check"))
            parts.append(tr("проверка не удалась: \(why)", "the check failed: \(why)"))
        } else if let d = checked {
            parts.append(tr("Проверено: \(date(d))", "Checked: \(date(d))"))
            parts.append(info.available.map { tr("доступна \($0.version)", "\($0.version) available") } ?? tr("новых версий нет", "no new versions"))
        } else {
            parts.append(tr("Ещё не проверялось", "Not checked yet"))
        }
        if !info.setting { parts.append(tr("фоновая проверка выключена", "background check is off")) }
        else if info.enabled, let d = PluginUpdatesStatus.parseDate(info.nextCheckAt) {
            parts.append(info.error == nil ? tr("следующая: \(date(d))", "next: \(date(d))") : tr("повтор: \(date(d))", "retry: \(date(d))"))
        }
        return (parts.joined(separator: " · "), info.error != nil)
    }

    /// The command that brings a new version (README, the check line, CLI texts).
    public static let brewUpgradeCommand = "brew upgrade agent-hub"

    /// The check line of a Homebrew-managed hub: no git tags — the version comes from the brew package. The available version is
    /// read from the package right away; the background check (a file read every few minutes) only notifies.
    static func brewCheckLine(_ info: HubUpdateInfo, date: (Date) -> String) -> (text: String, warn: Bool) {
        if info.checking { return (tr("Проверяю…", "Checking…"), false) }
        var parts: [String] = []
        let checked = PluginUpdatesStatus.parseDate(info.checkedAt)
        if let e = info.error {
            parts.append(checked.map { tr("Последняя проверка: \(date($0))", "Last check: \(date($0))") } ?? tr("Проверить не удалось", "Couldn't check"))
            parts.append(tr("проверка не удалась: \(reason(e))", "the check failed: \(reason(e))"))
            return (parts.joined(separator: " · "), true)
        }
        if let d = checked { parts.append(tr("Проверено: \(date(d))", "Checked: \(date(d))")) }
        if let a = info.available {
            parts.append(tr("в Homebrew есть \(a.version)", "Homebrew has \(a.version)"))
        } else {
            parts.append(tr("новых версий нет · обновления приходят из Homebrew: \(brewUpgradeCommand)", "no new versions · updates come from Homebrew: \(brewUpgradeCommand)"))
        }
        if !info.setting { parts.append(tr("фоновая проверка выключена", "background check is off")) }
        return (parts.joined(separator: " · "), false)
    }

    /// Install status in the card → (text, whether it is an error, log path). nil — nothing to show.
    public static func installLine(_ info: HubUpdateInfo, now: Date = Date()) -> (text: String, failed: Bool, log: String?)? {
        let i = info.install
        // the hub is no longer from Versions (moved back to a working folder): the last install's result from install.json is not about it
        if !info.installed && !progressPhases.contains(i.phase) && i.phase != "ready" { return nil }
        let target = displayLabel(i.label ?? "?")
        switch i.phase {
        case let p where progressPhases.contains(p):
            return ((i.op == "rollback" ? tr("Откат на \(target): ", "Rolling back to \(target): ") : tr("Обновление до \(target): ", "Updating to \(target): ")) + stepText(i, brew: info.isBrew), false, i.log)
        case "ready":
            return (tr("Собрано \(target) — ждёт перезапуска. ", "\(target) is built — waiting to restart. ") + readyDetail(i), false, i.log)
        case "failed", "rolled-back":
            // as in the popover: a day and only while there is no newer version
            guard failureVisible(info, now: now) else { return nil }
            let why = reason(i.error ?? "")
            return (i.op == "rollback" ? tr("Не удалось откатить на \(target): \(why)", "Couldn't roll back to \(target): \(why)") : tr("Не удалось обновить до \(target): \(why)", "Couldn't update to \(target): \(why)"), true, i.log)
        case "done" where (i.op == "install" || i.op == "rollback") && i.label == info.label:
            let when = PluginUpdatesStatus.parseDate(i.finishedAt).map(Fmt.dateTime) ?? ""
            return ((i.op == "rollback" ? tr("Возвращён на \(target)", "Rolled back to \(target)") : tr("Обновлён до \(target)", "Updated to \(target)")) + (when.isEmpty ? "" : " · \(when)"), false, nil)
        default:
            return nil
        }
    }

    /// Failure reason (daemon code `hub-update:*`) — short, lowercase.
    public static func reason(_ code: String) -> String {
        switch code.replacingOccurrences(of: "hub-update:", with: "") {
        case "remote": return tr("origin не ответил (сеть или учётные данные git)", "origin didn't answer (network or git credentials)")
        case "remote-timeout": return tr("origin не ответил за 30 с", "origin didn't answer within 30 s")
        case "not-configured": return tr("адрес origin не задан", "no origin address")
        case "clone-failed": return tr("не удалось скачать исходники тега", "couldn't download the tag's sources")
        case "commit-mismatch": return tr("тег переписан после проверки", "the tag was rewritten after the check")
        case "version-mismatch": return tr("версия в теге не совпала с VERSION", "the tag's version doesn't match VERSION")
        case "build-failed": return tr("ошибка сборки", "build error")
        case "build-timeout": return tr("сборка не уложилась во время", "the build took too long")
        case "node-missing": return tr("не найден node для сборки — перезапустите хаб", "node for the build is missing — restart the hub")
        case "verify-failed": return tr("сборка не прошла проверку подписи", "the build failed the signature check")
        case "selftest-failed": return tr("новый демон не прошёл самопроверку", "the new daemon failed its self-test")
        case "switch-failed": return tr("не удалось переключиться — файлы возвращены", "couldn't switch over — files restored")
        case "trial-timeout": return tr("новая версия не запустилась — откат", "the new version didn't start — rolled back")
        case "interrupted": return tr("хаб перезапустился во время установки — нажмите «Обновить», чтобы собрать заново", "the hub restarted during the install — press Update to build again")
        case "estop": return tr("хаб на паузе", "the hub is paused")
        case "not-on-main": return tr("коммит тега не входит в ветку релизов origin", "the tag's commit isn't on origin's release branch")
        case "no-space": return tr("мало места на диске", "not enough disk space")
        case "untrusted-build": return tr("эту сборку хаб не закреплял", "the hub never pinned this build")
        case "tag-moved": return tr("тег перенесён на другой коммит", "the tag was moved to another commit")
        case "state-write": return tr("не записалось состояние установки", "couldn't write the install state")
        case "brew-missing": return tr("пакет Homebrew agent-hub не найден — переустановите его: brew install KenseiTheOne/tap/agent-hub", "the Homebrew package agent-hub is missing — reinstall it: brew install KenseiTheOne/tap/agent-hub")
        default: return code.isEmpty ? tr("ошибка установки", "install error") : code
        }
    }

    /// Route refusal (403, 409, 423 …) — in plain words.
    public static func denied(_ code: String?) -> String {
        guard let code else { return tr("Служба хаба отказала.", "The hub service refused.") }
        if code.hasPrefix("peer:") { return tr("Обновлять хаб может только закреплённая сборка приложения.", "Only the pinned app build can update the hub.") }
        switch code {
        case "hub-update:estop": return tr("Хаб на паузе — снимите паузу и повторите.", "The hub is paused — resume it and try again.")
        case "hub-update:busy": return tr("Уже идёт установка.", "An install is already running.")
        case "hub-update:not-installed": return notInstalledText
        case "hub-update:not-newer": return tr("Эта версия не новее текущей.", "This version isn't newer than the current one.")
        case "hub-update:unknown-version": return tr("Такой версии нет — проверьте обновления ещё раз.", "No such version — check for updates again.")
        case "hub-update:no-previous": return tr("Прежней версии нет — откатываться некуда.", "There's no previous version to roll back to.")
        case "hub-update:disabled": return tr("Служба обновления хаба не запущена.", "The hub update service isn't running.")
        case "hub-update:tag-moved": return tr("Тег перенесли на другой коммит — подтвердите установку ещё раз.", "The tag was moved to another commit — confirm the install again.")
        case "hub-update:untrusted-build": return tr("Эту сборку хаб не закреплял сам — откат на неё не выполняется.", "The hub never pinned this build itself — it won't roll back to it.")
        case "hub-update:not-ready": return tr("Нечего перезапускать — собранной версии нет.", "Nothing to restart into — no built version is waiting.")
        case "hub-update:ready": return tr("Собранная версия ждёт перезапуска — сначала перезапустите хаб в неё.", "A built version is waiting to restart — restart the hub into it first.")
        default: return reason(code)
        }
    }

    public static var notInstalledText: String {
        tr("Хаб работает из рабочей папки — обновления по кнопке недоступны. Сначала переведите его в отдельную установку: установщиком из папки репозитория agent-hub — bash scripts/install.sh --origin . Новые версии хаб будет искать в тегах этой папки, а не на GitHub.",
           "The hub runs from the working folder — one-click updates are unavailable. First move it to a separate install: run the installer from the agent-hub repository folder — bash scripts/install.sh --origin . The hub will then look for new versions in this folder's tags, not on GitHub.")
    }

    /// The installer command with a full path for a hub from a working folder (from `/state.hub.cli` = <repo>/daemon/bin/agenthub):
    /// the installer takes main from this clone (`--origin`), not from GitHub. nil — the path is unknown or the hub is already in Versions.
    /// Test directory — with `--home <dir> --no-launchd`: without them the copied command would install the live hub.
    public static func installCommand(_ hub: HubInfo?, userHome: String = NSHomeDirectory()) -> String? {
        let tail = "/daemon/bin/agenthub"
        guard let cli = hub?.cli, cli.hasSuffix(tail), !cli.contains("/Versions/") else { return nil }
        let repo = String(cli.dropLast(tail.count))
        guard !repo.isEmpty else { return nil }
        let q = shellArg(repo, userHome: userHome)
        var cmd = "bash \(q)/scripts/install.sh --origin \(q)"
        if hub?.testMode == true, let home = hub?.home, !home.isEmpty { cmd += " --home \(shellArg(home, userHome: userHome)) --no-launchd" }
        return cmd
    }

    /// Path for a Terminal command: under the home directory without spaces or quotes — "~/…" (bash will expand it); otherwise —
    /// as in the reinstall hint: "$HOME/…" in double quotes or the whole path in single quotes (a tilde inside quotes does not
    /// expand).
    static func shellArg(_ p: String, userHome: String) -> String {
        if !userHome.isEmpty, p.hasPrefix(userHome + "/") {
            let rest = String(p.dropFirst(userHome.count))
            if rest.range(of: #"^[A-Za-z0-9_./:@%+=-]+$"#, options: .regularExpression) != nil { return "~" + rest }
        }
        return ReinstallHint.shellPath(p, userHome: userHome)
    }

    /// Label for the available release description in Settings: with a version — "What's new in 0.3.0: …".
    public static func whatsNewPrefix(_ version: String?) -> String {
        guard let v = version, !v.isEmpty else { return tr("Что нового: ", "What's new: ") }
        return tr("Что нового в \(displayLabel(v)): ", "What's new in \(displayLabel(v)): ")
    }

    /// The explanation under "Check for hub updates".
    public static var checkExplain: String {
        tr("Несколько раз в день хаб спрашивает origin репозитория (git ls-remote с вашими учётными данными), нет ли нового релиза — тега vX.Y.Z. Ставит только по кнопке «Обновить»: собирает новую версию отдельно, проверяет и перезапускается в неё; если что-то не так — остаётся на прежней.",
           "A few times a day the hub asks the repository's origin (git ls-remote with your credentials) for a new release — a vX.Y.Z tag. It installs only when you press Update: it builds the new version separately, checks it and restarts into it; if anything goes wrong it stays on the current one.")
    }

    /// The explanation under "Check for hub updates" for a hub installed with Homebrew.
    public static var brewCheckExplain: String {
        tr("Хаб установлен через Homebrew: новые версии приходят командой \(brewUpgradeCommand), git-теги он не смотрит. После неё хаб в течение нескольких минут (или по «Проверить сейчас») предложит «Обновить»: соберёт новую версию отдельно, проверит и перезапустится в неё; если что-то не так — останется на прежней.",
           "The hub is installed with Homebrew: new versions come with \(brewUpgradeCommand), it doesn't look at git tags. After that, within a few minutes (or on Check now) the hub offers Update: it builds the new version separately, checks it and restarts into it; if anything goes wrong it stays on the current one.")
    }

    /// The explanation for this hub: Homebrew or git tags.
    public static func checkExplain(for info: HubUpdateInfo) -> String { info.isBrew ? brewCheckExplain : checkExplain }

    /// The config.json key for the tooltip on "The origin address is unknown".
    public static let remoteKeyHelp = "services.hubUpdate.remote"

    /// Whether "Update" / "Roll back" can be pressed: a pinned build, a connection, not paused, nothing in progress.
    public static func canAct(_ info: HubUpdateInfo, isApp: Bool, live: Bool) -> Bool {
        isApp && live && info.installed && info.blocked == nil
    }
}

extension HubUpdateText {
    /// A pin change is the hub update's own business (`by` from hub-update), and the install confirms it: the pin
    /// fingerprint matches the current version's build, and the install of this version is finished (`done`). Then the note
    /// "rebuilt and pinned" is not needed. Faking `by` is not enough: a matching build from `/state.hubUpdate` is required too.
    public static func pinChangeIsOwnUpdate(_ pin: AppPinInfo, _ info: HubUpdateInfo?) -> Bool {
        guard let info, let by = pin.by, by.hasPrefix("agenthub hub-update") else { return false }
        guard info.install.phase == "done", info.install.label == info.label, let cd = info.current?.cdhash, !cd.isEmpty else { return false }
        return pin.fingerprint.lowercased() == "cdhash:\(cd.lowercased())"
    }
}
