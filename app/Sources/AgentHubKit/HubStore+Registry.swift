import Foundation

// The plugin manager: the catalog and the installed list, own plugins from folders, install and remove with the
// permissions window, accepting a changed registry key.

extension HubStore {
    // MARK: - plugin manager

    public func loadRegistry() async {
        do {
            async let c = client.registryCatalog()
            async let i = client.registryInstalled()
            catalog = try await c
            installed = try await i
            registryError = nil
        } catch let e as HubError {
            registryError = e.code.map { Explain.text(code: $0, status: 0, label: "") } ?? e.errorDescription
        } catch {
            registryError = String(describing: error)
        }
    }

    /// Download and verify the signed catalog (`POST /registry/fetch`, app only).
    public func fetchCatalog() async {
        guard registryBusy == nil else { return }
        registryBusy = "fetch"
        defer { registryBusy = nil }
        // The manager shows the error itself (a banner with "Try again"), without a window.
        do {
            try await client.registryFetch()
            fetchError = nil
        } catch let e as HubError {
            fetchError = e.code ?? "registry:fetch"
        } catch {
            fetchError = "registry:fetch"
        }
        await loadRegistry()
    }

    /// Own plugin requests from folders: from the manager (`/registry/installed`), otherwise from the snapshot (`/state.ownPlugins`).
    public var ownRequests: [OwnRequest] { installed?.requests ?? state?.ownPlugins?.requests ?? [] }

    /// "Add from folder…": a request (as from the CLI) and immediately the consent window — path, version, fingerprint, permissions.
    public func addFromFolder(_ path: String) async {
        guard registryBusy == nil else { return }
        do {
            switch try await client.registryOwnRequest(path: path) {
            case .pending(let q):
                await approveOwn(q.requestId, title: q.displayTitle)
                return
            case .already(let id):
                await presenter?.report(title: tr("Уже установлен", "Already installed"),
                                  detail: tr("«\(id)» из этой папки уже стоит, и содержимое то же — ставить нечего.", "\"\(id)\" from this folder is already installed with the same contents — nothing to install."))
            case .denied(let status, let code, let errors):
                await presenter?.report(title: tr("Плагин из папки не добавлен", "Plugin from the folder not added"),
                                  detail: Explain.text(code: code, status: status, label: path) + (errors.isEmpty ? "" : "\n\n" + errors.prefix(8).joined(separator: "\n")) + Self.codeNote(code))
            }
        } catch {
            await reportOffline(error)
        }
        await loadRegistry()
    }

    /// "Check and install" on a request: consent window from the daemon (428), consent via a token.
    public func approveOwn(_ requestId: String, title: String) async {
        guard registryBusy == nil else { return }
        registryBusy = requestId
        defer { registryBusy = nil }
        do {
            var outcome = try await client.registryOwnApprove(requestId)
            if case .needsConsent(let req) = outcome {
                guard let presenter, await presenter.consent(req) else { return }
                outcome = try await client.registryOwnApprove(requestId, consentToken: req.token)
            }
            switch outcome {
            case .installed, .needsConsent: break
            case .denied(let status, let code):
                await presenter?.report(title: tr("«\(title)» не установлен", "\"\(title)\" not installed"), detail: Explain.text(code: code, status: status, label: title) + Self.codeNote(code))
            }
        } catch {
            await reportOffline(error)
        }
        await loadRegistry()
    }

    public func declineOwn(_ requestId: String) async {
        guard registryBusy == nil else { return }
        registryBusy = requestId
        defer { registryBusy = nil }
        do { try await client.registryOwnDecline(requestId) } catch {
            await reportOffline(error)
        }
        await loadRegistry()
    }

    /// Install or update: the daemon sends the permissions window (428), consent is passed via a token. fromRegistry — from the catalog
    /// over an own plugin with the same id (reverse switch: window marked "Will replace your own … from the folder").
    public func install(_ id: String, fromRegistry: Bool = false) async {
        guard registryBusy == nil else { return }
        registryBusy = id
        defer { registryBusy = nil }
        do {
            var outcome = try await client.registryInstall(id, fromRegistry: fromRegistry)
            if case .needsConsent(let req) = outcome {
                guard let presenter, await presenter.consent(req) else { return }
                outcome = try await client.registryInstall(id, consentToken: req.token)
            }
            switch outcome {
            case .installed: break
            case .needsConsent:
                await presenter?.report(title: tr("Права изменились", "Permissions changed"), detail: tr("Права изменились, пока было открыто окно, — повторите установку.", "Permissions changed while the window was open — install again."))
            case .denied(let status, let code):
                await presenter?.report(title: tr("Плагин «\(id)» не установлен", "Plugin \"\(id)\" not installed"), detail: Explain.text(code: code, status: status, label: id) + Self.codeNote(code))
            }
        } catch {
            await reportOffline(error)
        }
        await loadRegistry()
    }

    /// Registries whose key waits for a human (`/state.registryKeys`), in the daemon's order.
    public var registryKeyChanges: [RegistryKeyChange] { state?.registryKeys ?? [] }

    /// "Compare the keys…" on the key banner: the daemon sends both fingerprints (428), the human's "accept" goes back
    /// with the single-use token. Declining (the default answer) changes nothing: the hub keeps the accepted key.
    public func acceptRegistryKey(_ registry: String) async {
        guard registryBusy == nil else { return }
        registryBusy = "key:" + registry
        defer { registryBusy = nil }
        do {
            var outcome = try await client.registryKeyAccept(registry)
            if case .needsConsent(let req) = outcome {
                guard let presenter, await presenter.registryKey(req) else { return }
                outcome = try await client.registryKeyAccept(registry, consentToken: req.token)
            }
            switch outcome {
            case .accepted(let fetched, let fetchError):
                // the event `plugins.registry-keys` says the same; the banner must not outlive the answer if it is late
                state?.registryKeys?.removeAll { $0.registry == registry }
                if !fetched {
                    let why = Explain.text(code: fetchError ?? "registry:fetch", status: 0, label: registry)
                    await presenter?.report(title: RegistryKeyText.acceptedNoCatalogTitle, detail: RegistryKeyText.acceptedNoCatalog(why) + Self.codeNote(fetchError ?? ""))
                }
            case .needsConsent:
                await presenter?.report(title: RegistryKeyText.notAcceptedTitle, detail: RegistryKeyText.changedAgain)
            case .denied(let status, let code):
                // the key was put back meanwhile: nothing waits any more
                if code == "registry:key-unchanged" { state?.registryKeys?.removeAll { $0.registry == registry } }
                await presenter?.report(title: RegistryKeyText.notAcceptedTitle, detail: Explain.text(code: code, status: status, label: registry) + Self.codeNote(code))
            }
        } catch {
            await reportOffline(error)
        }
        if managerVisible { await loadRegistry() }
    }

    public func remove(_ id: String, purge: Bool) async {
        guard registryBusy == nil else { return }
        registryBusy = id
        defer { registryBusy = nil }
        do { try await client.registryRemove(id, purge: purge) } catch let e as HubError {
            await presenter?.report(title: tr("Плагин «\(id)» не удалён", "Plugin \"\(id)\" not removed"), detail: Explain.text(code: e.code ?? "", status: 0, label: id) + Self.codeNote(e.code ?? ""))
        } catch {
            await reportOffline(error)
        }
        await loadRegistry()
    }
}
