import Foundation

/// The quiet row "the hub hasn't heard from the Claude Code hook" (`/state.hook`, `installed: false`). The hook is
/// installed by the user (claude-plugin/README.md): the hub does not touch `~/.claude` and the shell has no button that
/// installs it — the row gives the command to copy. An older daemon has no field and the row is not shown.
public enum HookText {
    /// Whether to show the row. `hidden` — the human pressed "Dismiss" in the panel (Settings keeps saying it).
    public static func shows(_ hook: HookInfo?, hidden: Bool = false) -> Bool {
        guard let hook else { return false }
        return !hook.installed && !hidden
    }

    public static var title: String {
        tr("Хаб ещё не получал событий от хука Claude Code", "The hub hasn't heard from the Claude Code hook yet")
    }

    /// What it means and what to do. A reason the shell doesn't know (anything but `no-events`) is added as it came.
    public static func detail(_ hook: HookInfo?) -> String {
        let text = tr("Пока хук не подключён, сессии не сообщают хабу о запросах разрешений: хаб показывает сессии и их статусы, а отвечать приходится в терминале. Подключите хук командой ниже и запустите новую сессию Claude Code.",
                      "Until the hook is connected, sessions don't report permission requests to the hub: the hub shows sessions and their statuses, and you answer in the terminal. Connect the hook with the command below and start a new Claude Code session.")
        guard let why = hook?.reason, !why.isEmpty, why != "no-events" else { return text }
        return text + " " + tr("Причина по данным хаба: \(why).", "The reason the hub gives: \(why).")
    }

    /// The install command: the one the daemon gives (`/state.hook.installCommand`); a daemon without the field — the
    /// permanent install from claude-plugin/README.md (the hub's repository is a Claude Code marketplace).
    public static func command(_ hook: HookInfo?) -> String {
        if let c = hook?.installCommand?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty, !c.contains("\n") { return c }
        return fallbackCommand
    }

    static let fallbackCommand = "claude plugin marketplace add KenseiTheOne/agent-hub && claude plugin install agent-hub@agent-hub"

    /// The line for Settings when the hook is heard from: when the last event came.
    public static func lastEvent(_ hook: HookInfo) -> String? {
        guard hook.installed, let d = PluginUpdatesStatus.parseDate(hook.lastEventAt) else { return nil }
        return tr("Хук Claude Code: последнее событие \(Fmt.dateTime(d))", "Claude Code hook: last event \(Fmt.dateTime(d))")
    }
}
