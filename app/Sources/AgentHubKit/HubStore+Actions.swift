import Foundation

// Plugin actions: offers with the core's confirmation and typed input, jobs, external extensions, plugin keys,
// refreshing plugins; the shared "refused" and "no connection" reports.

extension HubStore {
    // MARK: - notifications

    public func ackNotify(_ notifyId: String) async {
        try? await client.pushAck(notifyId)
    }

    // MARK: - actions

    /// Run a plugin offer. Whether confirmation is needed is decided by the core (428 reply),
    /// the shell only shows its text and passes consent via a token.
    /// `input` — text the human already typed into the offer's inline field (G1); an input offer without it asks for the
    /// text in a sheet (immediate) or in the confirmation sheet (the 428 carries the field). true — the action ran and
    /// succeeded.
    @discardableResult
    public func perform(offer: Offer, label: String, input: String? = nil) async -> Bool {
        if let spec = offer.input { return await performInput(offer, spec: spec, label: offer.label ?? label, typed: input) }
        return await perform(id: offer.id, args: nil, label: offer.label ?? label)
    }

    /// An input action (G1): the text goes in the request body, never into the offer. A confirm-level action may be sent
    /// without text — the 428 then carries `input` and the sheet shows the field; the token accepts any valid text, and a
    /// `400 input:*` refusal (checked before the token is spent) reopens the sheet with the reason.
    private func performInput(_ offer: Offer, spec: OfferInput, label: String, typed: String?) async -> Bool {
        guard busyAction == nil else { return false }
        busyAction = offer.id
        defer { busyAction = nil }
        var text = typed
        var token: String?
        var asked: ConfirmRequest?
        do {
            if text == nil, offer.level == .immediate {
                guard let presenter, let t = await presenter.prompt(InputPrompt(actionLabel: label, input: spec)) else { return false }
                text = t
            }
            var outcome = try await client.invoke(offer.id, input: text)
            for _ in 0..<6 {
                switch outcome {
                case .needsConfirm(let req):
                    guard token == nil, let presenter else {
                        await presenter?.report(title: tr("Хаб снова просит подтверждение", "The hub asks to confirm again"), detail: tr("\(label): повторите.", "\(label): try again."))
                        return false
                    }
                    if req.input != nil || text == nil {
                        // the field is in the confirmation sheet; the token accepts any valid text typed there
                        guard let t = await presenter.prompt(InputPrompt(actionLabel: label, input: req.input ?? spec, confirm: req, text: text ?? "")) else { return false }
                        text = t
                    } else {
                        guard await presenter.confirm(req, actionLabel: label) else { return false }
                    }
                    token = req.token
                    asked = req
                    outcome = try await client.invoke(offer.id, input: text, confirmToken: token)
                case .denied(400, let code) where code.hasPrefix("input:"):
                    // the core refused the text (its own pattern, for example): ask again with the reason; the token is
                    // still valid — input is checked before the confirmation
                    guard let presenter, let t = await presenter.prompt(InputPrompt(actionLabel: label, input: asked?.input ?? spec, confirm: asked,
                                                                                    text: text ?? "", error: InputCheck.message(code, maxLength: spec.maxLength))) else { return false }
                    text = t
                    outcome = try await client.invoke(offer.id, input: text, confirmToken: token)
                default:
                    return await finish(outcome, label: label) ?? false
                }
            }
            // out of retries (a refusal after every attempt, or the core asking again and again): say why instead of
            // stopping silently — the last refusal reads like any other
            return await finish(outcome, label: label) ?? false
        } catch {
            await reportOffline(error)
            return false
        }
    }

    /// Show the end of an action: a refusal or a failure; true — it ran and succeeded; nil — the human pressed "Try again"
    /// in the refusal window (offered only with `canRetry`).
    private func finish(_ outcome: ActionOutcome, label: String, canRetry: Bool = false) async -> Bool? {
        switch outcome {
        case .done(let ok, let result):
            guard !ok else { return true }
            // a plugin action checks its own facts and names the refusal with `reason=` / `message=` lines; `session=` says
            // which session it is about — the window names its tab and offers to switch to it
            let sid = result?["session"]?.stringValue?.lowercased()
            let session = sid.flatMap { id in sessions.first { $0.sessionId.lowercased() == id } }
            let focus = session.flatMap { focusRequest(sessionId: $0.sessionId) }
            let report = Explain.report(result: result, label: label, session: session, canFocus: focus != nil, canRetry: canRetry, limitMs: actionLimitMs)
            switch await presenter?.report(report) ?? .ok {
            case .retry:
                return nil
            case .focus:
                // after this action is over (busyAction is reset when the caller returns)
                if let focus { Task { [weak self] in _ = await self?.perform(id: focus.primitive, args: focus.args, label: FocusText.action) } }
            case .ok:
                break
            }
            return false
        case .needsConfirm:
            await presenter?.report(title: tr("Хаб снова просит подтверждение", "The hub asks to confirm again"), detail: tr("\(label): повторите.", "\(label): try again."))
        case .denied(let status, let code):
            await deny(label, status: status, code: code)
        }
        return false
    }

    /// "Stop" on a background job (G6): the `job.cancel` primitive (immediate, app only).
    public func cancelJob(_ job: PluginJob) async {
        await perform(id: "job.cancel", args: ["job": .string(job.id)], label: tr("Остановить: \(job.title ?? job.actionId ?? job.id)", "Stop: \(job.title ?? job.actionId ?? job.id)"))
    }

    /// Call a primitive directly (panel forms: session launch, etc.).
    @discardableResult
    public func perform(id: String, args: [String: JSONValue]?, label: String) async -> Bool {
        guard busyAction == nil else { return false }
        busyAction = id
        defer { busyAction = nil }
        do {
            // "Try again" in the refusal window runs the whole thing once more, the confirmation included
            while true {
                var outcome = try await client.invoke(id, args: args)
                if case .needsConfirm(let req) = outcome {
                    // an input action reached without its field (a banner button): the confirmation sheet asks for the text
                    if let field = req.input, let presenter {
                        guard let t = await presenter.prompt(InputPrompt(actionLabel: label, input: field, confirm: req)) else { return false }
                        outcome = try await client.invoke(id, args: args, input: t, confirmToken: req.token)
                    } else {
                        guard let presenter, await presenter.confirm(req, actionLabel: label) else { return false }
                        outcome = try await client.invoke(id, args: args, confirmToken: req.token)
                    }
                }
                if let ok = await finish(outcome, label: label, canRetry: true) { return ok }
            }
        } catch {
            await reportOffline(error)
            return false
        }
    }

    // MARK: - external extensions (G4)

    /// The extension being approved or revoked right now (its path).
    public var extensionBusy: String? { busyAction.flatMap { $0.hasPrefix("extension:") ? String($0.dropFirst(10)) : nil } }

    /// Approve the exact bytes the human saw (`sha256` from the sheet). true — approved; the file changed meanwhile →
    /// re-read the list and say so (the sheet must be shown again with the new fingerprint).
    @discardableResult
    public func approveExtension(_ item: ExtensionItem) async -> Bool {
        guard busyAction == nil, let sha = item.sha256 else { return false }
        busyAction = "extension:" + item.path
        defer { busyAction = nil }
        do {
            try await client.approveExtension(path: item.path, sha256: sha)
            await reloadExtensions()
            return true
        } catch let e as HubError {
            let code = e.code ?? ""
            await reloadExtensions()
            await presenter?.report(title: tr("Расширение не одобрено: \(item.path)", "Extension not approved: \(item.path)"),
                              detail: (code == "extensions:changed"
                                       ? tr("Файл изменился после того, как вы его посмотрели, — откройте одобрение снова и проверьте новый отпечаток.",
                                            "The file changed after you looked at it — open the approval again and check the new fingerprint.")
                                       : Explain.text(code: code, status: 0, label: item.path)) + Self.codeNote(code))
        } catch {
            await reportOffline(error)
        }
        return false
    }

    public func revokeExtension(_ item: ExtensionItem) async {
        guard busyAction == nil else { return }
        busyAction = "extension:" + item.path
        defer { busyAction = nil }
        do {
            try await client.revokeExtension(path: item.path)
            await reloadExtensions()
        } catch let e as HubError {
            await presenter?.report(title: tr("Одобрение не снято: \(item.path)", "Approval not revoked: \(item.path)"),
                              detail: Explain.text(code: e.code ?? "", status: 0, label: item.path) + Self.codeNote(e.code ?? ""))
        } catch {
            await reportOffline(error)
        }
    }

    /// `GET /extensions` into the snapshot (the event follows too; this makes the sheet's next look current at once).
    public func reloadExtensions() async {
        if let info = try? await client.extensions() { state?.extensions = info }
    }

    // MARK: - plugin keys (G8)

    /// Re-read the plugin's declared keys (`GET /secrets/:plugin`). A refusal (cli copy, no service, unknown plugin) drops
    /// the entry: no "Keys" section.
    public func loadSecrets(_ plugin: String) async {
        do {
            let list = try await client.secrets(plugin: plugin)
            secrets[plugin] = list
        } catch {
            secrets[plugin] = nil
        }
    }

    /// "Set key…" → `PUT`; "Remove" → `DELETE` (value nil). true — done; refusals are reported in words.
    @discardableResult
    public func writeSecret(plugin: String, key: String, value: String?) async -> Bool {
        guard secretBusy == nil else { return false }
        secretBusy = "\(plugin)/\(key)"
        defer { secretBusy = nil }
        do {
            let updated = value == nil ? try await client.deleteSecret(plugin: plugin, key: key) : try await client.setSecret(plugin: plugin, key: key, value: value ?? "")
            if let u = updated, var list = secrets[plugin], let i = list.secrets.firstIndex(where: { $0.key == u.key }) {
                list.secrets[i] = u
                secrets[plugin] = list
            } else {
                await loadSecrets(plugin)
            }
            return true
        } catch let e as HubError {
            let code = e.code ?? ""
            await presenter?.report(title: value == nil ? tr("Ключ не удалён: \(key)", "Key not removed: \(key)") : tr("Ключ не сохранён: \(key)", "Key not saved: \(key)"),
                              detail: Explain.text(code: code, status: 0, label: key) + Self.codeNote(code))
            await loadSecrets(plugin)
        } catch {
            await reportOffline(error)
        }
        return false
    }

    /// Core refusal: the title says what failed, the text is human-readable, the code is the last line.
    func deny(_ label: String, status: Int, code: String) async {
        await presenter?.report(title: tr("Не получилось: \(label)", "Couldn't: \(label)"), detail: Explain.text(code: code, status: status, label: label) + Self.codeNote(code))
    }

    nonisolated static func codeNote(_ code: String) -> String {
        code.isEmpty ? "" : "\n\n" + tr("Код для журнала: \(code)", "Log code: \(code)")
    }

    func reportOffline(_ error: Error) async {
        let why = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        await presenter?.report(title: tr("Нет связи со службой хаба", "No connection to the hub service"), detail: why)
    }

    /// "Update all plugins": one by one; no connection — a single report and stop, refusals — one report with a list.
    public func refreshAll() async {
        var failed: [String] = []
        for p in state?.plugins ?? [] {
            do { try await client.refresh(plugin: p.id) } catch let e as HubError {
                guard case .http = e else { await reportOffline(e); return }
                failed.append("\(p.title): " + (e.code.map { Explain.text(code: $0, status: 0, label: p.title) } ?? (e.errorDescription ?? "")))
            } catch {
                await reportOffline(error)
                return
            }
        }
        if !failed.isEmpty {
            await presenter?.report(title: tr("Не все плагины перезапущены", "Not all plugins were restarted"), detail: failed.joined(separator: "\n"))
        }
    }

    public func refresh(plugin id: String) async {
        do { try await client.refresh(plugin: id) } catch {
            await presenter?.report(title: tr("Плагин не перезапущен", "Plugin not restarted"), detail: (error as? LocalizedError)?.errorDescription ?? "")
        }
    }

    /// Explanation for a failed completed action (200, `ok: false`) — L10n.swift, Explain.failure.
    nonisolated public static func explainFailure(result: JSONValue?, label: String) -> String {
        Explain.failure(result: result, label: label)
    }

    /// Human-readable explanation of a core refusal code — L10n.swift, Explain.text.
    nonisolated public static func explain(code: String, status: Int, label: String) -> String {
        Explain.text(code: code, status: status, label: label)
    }
}
