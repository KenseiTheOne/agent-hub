import AgentHubKit
import AppKit
import SwiftUI

/// The "New Claude session" window (stage 5, `session.launch`) over "Sessions", following the prototype. The folder, name and prompt
/// are entered only by a human. The core writes the confirmation text with the cost (NSAlert) and checks the folder; the launch terminal
/// (`/state.terminals.launch`) opens a new tab, the prompt goes through a 0600 file and never reaches the log or the command line.
struct LaunchSessionView: View {
    let store: HubStore
    let close: () -> Void
    // @State in the macOS 27 SDK is a macro whose plugin (SwiftUIMacros) ships only with Xcode, not with the CLT.
    // So the State storage is declared explicitly: the same property wrapper, without the macro.
    private let draftStore = State(initialValue: LaunchDraft())
    private var draft: LaunchDraft { get { draftStore.wrappedValue } nonmutating set { draftStore.wrappedValue = newValue } }
    private var draftBinding: Binding<LaunchDraft> { draftStore.projectedValue }

    private var available: Bool { store.state?.primitives.contains { $0.name == "session.launch" } ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(tr("Новая сессия Claude", "New Claude session")).font(.system(size: 16, weight: .bold))
            field(tr("Папка", "Folder")) {
                HStack(spacing: 6) {
                    TextField("", text: draftBinding.folder, prompt: Text("~/Projects/…")).textFieldStyle(.plain)
                    Button(tr("Выбрать…", "Choose…")) { chooseFolder() }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF))
                }
            }
            if !draft.folder.isEmpty, let p = draft.folderProblem { Text(p).font(.system(size: 11.5)).foregroundStyle(.red) }
            field(tr("Имя вкладки", "Tab name")) {
                TextField("", text: draftBinding.name, prompt: Text(tr("Проект — задача", "Project — task"))).textFieldStyle(.plain)
            }
            if !draft.name.isEmpty, let p = LaunchDraft.nameProblem(draft.name) { Text(p).font(.system(size: 11.5)).foregroundStyle(.red) }
            VStack(alignment: .leading, spacing: 4) {
                Text(tr("Промпт", "Prompt")).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                ZStack(alignment: .topLeading) {
                    if draft.prompt.isEmpty {
                        Text(tr("Что сделать", "What to do")).font(.system(size: 13)).foregroundStyle(.white.opacity(0.35)).padding(.horizontal, 9).padding(.vertical, 7)
                    }
                    TextEditor(text: draftBinding.prompt).font(.system(size: 13)).scrollContentBackground(.hidden).padding(.horizontal, 4).padding(.vertical, 3)
                }
                .frame(height: 84)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.white.opacity(0.08)))
                if draft.prompt.count > 16_000 { Text(tr("Слишком длинный промпт: \(draft.prompt.count) из 16000", "Prompt too long: \(draft.prompt.count) of 16000")).font(.system(size: 11.5)).foregroundStyle(.red) }
            }
            HStack {
                Text(tr("Remote Control — ответить можно с телефона", "Remote Control — reply from your phone")).font(.system(size: 12.5))
                Spacer()
                Toggle("", isOn: .constant(true)).toggleStyle(.switch).tint(.green).labelsHidden().disabled(true)
                    .help(tr("Хаб всегда запускает сессии с Remote Control", "The hub always launches sessions with Remote Control"))
            }
            Text(TerminalText.launchNote(store.state?.terminals == nil ? "cmux" : store.launchTerminal?.label))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
            if !available {
                Text(tr("Запуск недоступен: хаб не умеет запускать сессии", "Launching is unavailable: the hub can't launch sessions")).font(.system(size: 11.5)).foregroundStyle(.orange)
            } else if block == .noLaunchTerminal {
                Text(ActionBlock.noLaunchTerminal.help).font(.system(size: 11.5)).foregroundStyle(.orange)
            } else if block == .noBridge {
                // the launch terminal is cmux: its bridge opens the tab
                BridgeNotice(store: store, place: .launch)
            }
            status
            HStack(spacing: 8) {
                Spacer()
                Button(tr("Отмена", "Cancel"), action: close).buttonStyle(CapsuleStyle(height: 32, expand: false)).keyboardShortcut(.cancelAction)
                Button(tr("Запустить", "Launch")) {
                    Task {
                        if await store.launch(draft) {
                            draft.prompt = ""
                            close()
                        }
                    }
                }
                .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false))
                .disabled(!available || block != nil || !draft.isValid || store.busyAction != nil)
                .help(block == .noBridge ? BridgeText.launchHelp(store) : block?.help ?? "")
            }
        }
        .padding(20)
        .frame(width: 500)
        .environment(\.colorScheme, .dark)
        .background(GlassBackground(tint: hexColor(0x282830, 0.82), radius: 24))
        // the result of the previous launch is out of place here: it is visible in "Sessions"
        .onAppear { store.clearLastLaunch() }
    }

    /// Why "Launch" will not work: connection, unpinned build, pause, no launch terminal, the cmux bridge (launch terminal cmux).
    private var block: ActionBlock? { store.launchGate() }

    private func field<V: View>(_ label: String, @ViewBuilder _ v: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
            v().font(.system(size: 13)).padding(.horizontal, 10).frame(height: 32)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.white.opacity(0.08)))
        }
    }

    @ViewBuilder private var status: some View {
        if store.busyAction == "session.launch" {
            ProgressView().controlSize(.small)
        } else if let l = store.lastLaunch {
            Label(l.text, systemImage: l.symbol).font(.system(size: 12)).foregroundStyle(l.tint)
        }
    }

    private func chooseFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        p.prompt = tr("Выбрать", "Choose")
        if !draft.folder.isEmpty { p.directoryURL = URL(fileURLWithPath: draft.expandedFolder) }
        NSApp.activate(ignoringOtherApps: true)
        if p.runModal() == .OK, let url = p.url {
            draft.folder = (url.path as NSString).abbreviatingWithTildeInPath
            if draft.name.isEmpty { draft.name = url.lastPathComponent }
        }
    }
}

extension LaunchStatus {
    var symbol: String {
        switch state {
        case .started: return "hourglass"
        case .registered: return "checkmark.circle.fill"
        case .timeout: return "exclamationmark.triangle"
        }
    }

    var tint: Color {
        switch state {
        case .started: return .secondary
        case .registered: return .green
        case .timeout: return .orange
        }
    }
}
