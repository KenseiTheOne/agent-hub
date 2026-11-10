import AgentHubKit
import AppKit
import SwiftUI

// Updating the hub itself (docs/hub-updates.md §7): a line in the popover and a card in Settings. Texts:
// AgentHubKit/HubUpdatePresentation.swift.

/// "New hub version: 0.3.0" with the release notes and "Update", install progress, "built: restart",
/// "failed", or the "Hub updated" result, shown above plugin updates.
struct HubUpdatePopoverLine: View {
    let store: HubStore
    let openSettings: () -> Void
    // "OK" on the update result: hide the line for this install (@State/@AppStorage without macros, see MenuContent),
    // per hub (socket): "OK" in a test copy does not hide the result in the live hub
    private let doneAck = AppStorage(wrappedValue: "", HubDefaults.key("hubUpdateDoneAck", socketPath: HubPaths.socketPath()))

    var body: some View {
        // "OK" hides the result but not what is under it (for example, "0.3.0 can be installed again" after a rollback)
        if let info = store.hubUpdate, let line = HubUpdateText.line(info, ackedDone: doneAck.wrappedValue == HubUpdateText.doneKey(info)) {
            let can = HubUpdateText.canAct(info, isApp: store.peer?.isApp ?? false, live: store.connection.isLive) && store.hubUpdateBusy == nil
            HStack(alignment: .center, spacing: 10) {
                Group {
                    switch line.kind {
                    case .available: Image(systemName: "arrow.up.circle.fill").foregroundStyle(hexColor(0x4DA3FF))
                    case .progress: ProgressView().controlSize(.small)
                    case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(hexColor(0xFFC56B))
                    case .ready: Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(hexColor(0x4DA3FF))
                    case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(hexColor(0x7EE29B))
                    case .info: Image(systemName: "arrow.uturn.backward.circle").foregroundStyle(.white.opacity(0.6))
                    }
                }
                .font(.system(size: 18)).frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.title).font(.system(size: 12.5, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    // release notes are data from the tag: at most two lines, the rest truncated with an ellipsis
                    if let n = line.note {
                        Text(verbatim: n).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.8)).lineLimit(2).truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let d = line.detail {
                        Text(d).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let b = line.button {
                    Button(b) { Task { if line.kind == .ready { await store.switchHubUpdate() } else { await store.installHubUpdate() } } }
                        .buttonStyle(PillStyle(fill: hexColor(0x0A84FF)))
                        .fixedSize()
                        .disabled(!can)
                        .help(info.blocked == "estop" ? tr("Хаб на паузе", "Hub is paused")
                              : !(store.peer?.isApp ?? false) ? tr("Только закреплённая сборка приложения", "Pinned app build only")
                              : line.kind == .ready ? tr("Перезапустить хаб в собранную версию сейчас: карточки ответа, если есть, уйдут в терминал", "Restart the hub into the built version now: answer cards, if any, fall back to the terminal")
                              : tr("Собрать новую версию отдельно и перезапустить хаб в неё; при ошибке хаб останется на текущей", "Build the new version separately and restart the hub into it; on error the hub stays on the current one"))
                } else if line.kind == .failed {
                    Button(tr("Подробнее", "Details"), action: openSettings).buttonStyle(PillStyle(fill: Color.white.opacity(0.14))).fixedSize()
                } else if line.kind == .done {
                    Button(tr("Понятно", "OK")) { doneAck.wrappedValue = HubUpdateText.doneKey(info) }
                        .buttonStyle(PillStyle(fill: Color.white.opacity(0.14))).fixedSize()
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.05)))
        }
    }
}

/// "Hub updates" in Settings: version and release notes, the check toggle, the check line, install progress and
/// error with the log path, buttons; tags, commits and fingerprints go under "Details".
struct HubUpdateSettings: View {
    let store: HubStore
    let info: HubUpdateInfo
    private let detailsOpen = State(initialValue: false)

    var body: some View {
        let isApp = store.peer?.isApp ?? false
        let live = store.connection.isLive
        let can = HubUpdateText.canAct(info, isApp: isApp, live: live) && store.hubUpdateBusy == nil
        VStack(alignment: .leading, spacing: 6) {
            Text(tr("Обновления хаба", "Hub updates")).font(.system(size: 13, weight: .semibold))
            Text(HubUpdateText.currentText(info)).font(.system(size: 12)).textSelection(.enabled)
            if let n = HubUpdateText.notesParts(info.current?.notes, version: info.current?.version) { notes(n, prefix: nil) }
            if !info.installed {
                // hub running from a working folder: nothing to check or install, just an install hint, no toggle
                Text(HubUpdateText.notInstalledText).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B))
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let cmd = HubUpdateText.installCommand(store.state?.hub) {
                    HStack(spacing: 8) {
                        Text(verbatim: cmd).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.75))
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Button(tr("Скопировать", "Copy")) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(cmd, forType: .string)
                        }
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF)).fixedSize()
                    }
                }
            } else {
                Toggle(tr("Проверять обновления хаба", "Check for hub updates"),
                       isOn: Binding(get: { info.setting }, set: { v in Task { await store.setCheckHubUpdates(v) } }))
                    .toggleStyle(.switch).font(.system(size: 12.5))
                    .disabled(!live || !info.config || !isApp)
                    .help(!isApp ? ActionBlock.notPinned.help : "")
                Text(HubUpdateText.checkExplain(for: info))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
                let check = HubUpdateText.checkLine(info)
                Text(check.text).font(.system(size: 11.5)).foregroundStyle(check.warn ? hexColor(0xFFC56B) : .white.opacity(0.55))
                    .fixedSize(horizontal: false, vertical: true)
                    .help(info.config && !info.configured ? HubUpdateText.remoteKeyHelp : "")
            }
            // "What's new" only for a hub from Versions: a hub from a working folder has neither a version nor a button,
            // and the notes of a previously found release from check.json would hang there without context
            if info.installed, let n = HubUpdateText.notesParts(info.available?.notes, version: info.available?.version) { notes(n, prefix: HubUpdateText.whatsNewPrefix(info.available?.version)) }
            // the available version's tag moved: the same line as in the popover, before the "Update to …" button
            if let w = HubUpdateText.movedWarning(info) {
                Label { Text(w).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B))
            }
            if let st = HubUpdateText.installLine(info) {
                HStack(spacing: 6) {
                    if !st.failed, HubUpdateText.progressPhases.contains(info.install.phase) { ProgressView().controlSize(.small) }
                    Text(st.text).font(.system(size: 12)).foregroundStyle(st.failed ? hexColor(0xFF6B6B) : .white.opacity(0.8))
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let log = st.log {
                    HStack(spacing: 8) {
                        Text(tr("Лог: \(log)", "Log: \(log)")).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.55))
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Button(tr("Показать лог", "Show log")) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: log)]) }
                            .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF))
                    }
                }
            }
            if info.installed { buttons(can: can, isApp: isApp, live: live) }
            if info.blocked == "estop" {
                Text(tr("Хаб на паузе — установка и откат недоступны.", "The hub is paused — install and rollback are unavailable."))
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B))
            }
            let lines = HubUpdateText.detailLines(info)
            if !lines.isEmpty {
                DisclosureGroup(isExpanded: detailsOpen.projectedValue) {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(lines, id: \.self) { l in
                            Text(verbatim: l).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.6))
                                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        }
                    }
                    .padding(.top, 4)
                } label: {
                    Text(tr("Подробности", "Details")).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.7))
                }
            }
        }
    }

    /// Release notes: subject up to two lines, body up to two; Text truncates (ellipsis at the end of the visible line).
    @ViewBuilder private func notes(_ n: (subject: String, body: String?), prefix: String?) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: (prefix ?? "") + n.subject).lineLimit(2).truncationMode(.tail)
            if let b = n.body { Text(verbatim: b).lineLimit(2).truncationMode(.tail) }
        }
        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.7))
        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }

    /// The main action (restart into the built version or "Update to …") and "Check now" in a row; rollback goes
    /// separately below if it does not fit in the row, so labels are never truncated.
    @ViewBuilder private func buttons(can: Bool, isApp: Bool, live: Bool) -> some View {
        let check = Button(store.hubUpdateBusy == "check" || info.checking ? tr("Проверяю…", "Checking…") : tr("Проверить сейчас", "Check now")) { Task { await store.checkHubUpdate() } }
            .disabled(!isApp || !live || !info.configured || !info.config || store.hubUpdateBusy != nil || info.checking)
            .fixedSize()
        let primary = Group {
            if info.install.phase == "ready" {
                Button(HubUpdateText.restartButton(info.install)) { Task { await store.switchHubUpdate() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!can)
                    .help(HubUpdateText.readyDetail(info.install))
                    .fixedSize()
            } else if HubUpdateText.showInstallButton(info), let title = HubUpdateText.installButton(info) {
                Button(title) { Task { await store.installHubUpdate() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!can)
                    .fixedSize()
            }
        }
        let rollback = Group {
            if let title = HubUpdateText.previousButton(info) {
                Button(title) { Task { await store.rollbackHub() } }
                    .disabled(!can || !HubUpdateText.canRollback(info))
                    .help(HubUpdateText.canRollback(info)
                          ? tr("Переключиться на прежнюю собранную версию без сборки; хаб перезапустится", "Switch to the previous built version without building; the hub will restart")
                          : tr("Собранная версия ждёт перезапуска — сначала перезапустите хаб в неё", "A built version is waiting to restart — restart the hub into it first"))
                    .fixedSize()
            }
        }
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { primary; check; rollback }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) { primary; check }
                rollback
            }
        }
        .font(.system(size: 12))
    }
}
