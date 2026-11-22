import Foundation

// Hub-wide switches (pause, language, notifications, launch at login, connections) and the hub update.

extension HubStore {
    /// Hub pause (internal name — estop, ESTOP file). Anyone can turn it on, only the pinned build can lift it.
    public func setEstop(_ on: Bool) async {
        do {
            let v = try await client.setEstop(on)
            state?.estop = v
            if journalVisible { await loadJournal() }
        } catch let e as HubError {
            let notApp = e.code?.hasPrefix("peer:") == true
            await presenter?.report(title: on ? tr("Не удалось поставить хаб на паузу", "Couldn't pause the hub") : tr("Пауза не снята", "Couldn't resume the hub"),
                              detail: !on && notApp ? tr("Снять паузу можно только из закреплённой сборки приложения.", "Only the pinned app build can resume.") + Self.codeNote(e.code ?? "")
                                  : (e.code.map { Explain.text(code: $0, status: 403, label: tr("Пауза хаба", "Pause hub")) + Self.codeNote($0) } ?? (e.errorDescription ?? "")))
        } catch {
            await reportOffline(error)
        }
    }

    /// Hub language: written by the daemon (app class only), the reply is applied right away.
    public func setLang(_ setting: LangSetting) async {
        do {
            let info = try await client.setLang(setting.rawValue)
            L10n.shared.apply(setting: info.setting, effective: info.effective)
            state?.lang = info
            onLanguageChange?()
        } catch let e as HubError {
            await presenter?.report(title: tr("Язык не сменён", "Language not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Язык хаба меняет только закреплённая сборка приложения.", "Only the pinned app build can change the hub's language.") + Self.codeNote(e.code ?? "")
                                  : (e.errorDescription ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    /// "Check for plugin updates": written by the daemon (app class only), the reply is applied right away.
    public func setCheckPluginUpdates(_ on: Bool) async {
        do {
            if let u = try await client.setCheckPluginUpdates(on) { state?.pluginUpdates = u }
            else { state?.pluginUpdates?.setting = on }
        } catch let e as HubError {
            await presenter?.report(title: tr("Настройка не сменена", "Setting not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Эту настройку меняет только закреплённая сборка приложения.", "Only the pinned app build can change this setting.") + Self.codeNote(e.code ?? "")
                                  : (e.errorDescription ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    /// A built-in plugin's switch on the Plugins page: written by the daemon (app class only), the reply is applied right away;
    /// the plugin's section comes and goes with the next snapshot of plugins.
    public func setBuiltinEnabled(_ id: String, enabled: Bool) async {
        do {
            if let list = try await client.setBuiltinEnabled(id, enabled: enabled) { state?.builtinPlugins = list }
        } catch let e as HubError {
            await presenter?.report(title: tr("Плагин не переключён", "Plugin not switched"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Встроенные плагины включает и выключает только закреплённая сборка приложения.", "Only the pinned app build can turn built-in plugins on or off.") + Self.codeNote(e.code ?? "")
                                  : (e.errorDescription ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    /// "Notifications": written by the daemon (app class only) — master switch, style or quiet hours; the reply is applied right away.
    public func setNotifications(_ patch: JSONValue) async {
        do {
            if let n = try await client.setNotifications(patch) { state?.notifications = n }
        } catch let e as HubError {
            await presenter?.report(title: tr("Настройка не сменена", "Setting not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Эту настройку меняет только закреплённая сборка приложения.", "Only the pinned app build can change this setting.") + Self.codeNote(e.code ?? "")
                                  : NotificationsText.error(e.code) ?? (e.errorDescription ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    /// A connection from the daemon reply (`/connections/:id/*`, Connections.swift) — right away, without waiting for `connections.changed`.
    func applyConnection(_ c: ConnectionInfo) {
        guard var list = state?.connections, let i = list.firstIndex(where: { $0.id == c.id }) else { return }
        list[i] = c
        state?.connections = list
    }

    /// "Launch at login": written by the daemon (app class only) — a setting for the daemon + app pair (decision 2026-11-07).
    public func setLaunchAtLogin(_ on: Bool) async {
        do {
            let r = try await client.setLaunchAtLogin(on)
            state?.launchAtLogin = r ?? LaunchAtLoginInfo(setting: on)
        } catch let e as HubError {
            await presenter?.report(title: tr("Настройка не сменена", "Setting not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Эту настройку меняет только закреплённая сборка приложения.", "Only the pinned app build can change this setting.") + Self.codeNote(e.code ?? "")
                                  : (e.errorDescription ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    // MARK: - hub update (docs/hub-updates.md)

    public var hubUpdate: HubUpdateInfo? { state?.hubUpdate }

    /// "Check for hub updates": written by the daemon (app class only).
    public func setCheckHubUpdates(_ on: Bool) async {
        do {
            if let u = try await client.setCheckHubUpdates(on) { state?.hubUpdate = u } else { state?.hubUpdate?.setting = on }
        } catch let e as HubError {
            await presenter?.report(title: tr("Настройка не сменена", "Setting not changed"), detail: HubUpdateText.denied(e.code) + Self.codeNote(e.code ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    /// "Check now": git ls-remote against origin; the result is in the card (the check line).
    public func checkHubUpdate() async {
        await hubUpdateRequest("check", title: tr("Проверка не выполнена", "Check failed")) { try await self.client.checkHubUpdate() }
    }

    /// "Update": first a confirmation (tag, commit, tag move, major version jump), then a background build,
    /// progress via `hub-update.status` events; when ready the hub restarts.
    public func installHubUpdate() async {
        guard let info = hubUpdate, let a = info.available, let ask = HubUpdateText.installConfirm(info) else { return }
        var req = ConfirmRequest(token: "", level: .confirm, text: ask.text, title: ask.title, button: ask.button, details: ask.details)
        req.layout = HubUpdateText.installLayout(info)
        guard let presenter, await presenter.confirm(req, actionLabel: ask.button) else { return }
        let accept = a.moved?.new
        await hubUpdateRequest("install", title: tr("Обновление не началось", "Update didn't start")) { try await self.client.installHubUpdate(version: a.version, acceptCommit: accept) }
    }

    /// "Restart now": the built version was waiting for the cards to be answered.
    public func switchHubUpdate() async {
        await hubUpdateRequest("switch", title: tr("Перезапуск не начался", "Restart didn't start")) { try await self.client.switchHubUpdate() }
    }

    /// "Roll back to <previous>": first a confirmation (the hub will restart), like "Update".
    public func rollbackHub() async {
        guard let info = hubUpdate, let ask = HubUpdateText.rollbackConfirm(info) else { return }
        var req = ConfirmRequest(token: "", level: .confirm, text: ask.text, title: ask.title, button: ask.button, details: ask.details)
        req.layout = HubUpdateText.rollbackLayout(info)
        guard let presenter, await presenter.confirm(req, actionLabel: ask.button) else { return }
        await hubUpdateRequest("rollback", title: tr("Откат не начался", "Rollback didn't start")) { try await self.client.rollbackHub() }
    }

    private func hubUpdateRequest(_ kind: String, title: String, _ call: @escaping () async throws -> HubUpdateInfo?) async {
        guard hubUpdateBusy == nil else { return }
        hubUpdateBusy = kind
        defer { hubUpdateBusy = nil }
        do {
            if let u = try await call() { state?.hubUpdate = u }
        } catch let e as HubError {
            await presenter?.report(title: title, detail: HubUpdateText.denied(e.code) + Self.codeNote(e.code ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    /// "Check now" for plugin updates (`POST /registry/check-updates`).
    public func checkPluginUpdatesNow() async {
        guard hubUpdateBusy == nil else { return }
        hubUpdateBusy = "plugins-check"
        defer { hubUpdateBusy = nil }
        do {
            if let u = try await client.checkPluginUpdates() { state?.pluginUpdates = u }
        } catch let e as HubError {
            await presenter?.report(title: tr("Проверка не выполнена", "Check failed"),
                              detail: e.code?.hasPrefix("peer:") == true ? tr("Проверять обновления может только закреплённая сборка приложения.", "Only the pinned app build can check for updates.") + Self.codeNote(e.code ?? "") : (e.errorDescription ?? ""))
        } catch {
            await reportOffline(error)
        }
    }
}
