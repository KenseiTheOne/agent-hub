import AgentHubKit
import SwiftUI

/// "Accept the new registry key?" (`428 consent-required`, `kind: "registry-key"`; docs/plugins-registry.md, "The
/// registry key is remembered"). The window shows both keys whole — the fingerprint is what the human compares with
/// what the registry's owner published — and says what accepting means. The red "Accept" is never the default:
/// Return, Esc, closing the window and the token's lifetime running out all mean "don't accept".
struct RegistryKeySheet: View {
    let request: RegistryKeyConsent
    /// When the consent token stops being valid: the note counts down to it (the window is closed by the queue).
    var until: Date? = nil
    let done: (Bool) -> Void

    private var change: RegistryKeyChange { request.change }
    private let orange = hexColor(0xFF9F0A)

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "key.horizontal.fill")
                    .font(.system(size: 16, weight: .bold)).foregroundStyle(orange)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 10).fill(orange.opacity(0.16)))
                VStack(alignment: .leading, spacing: 3) {
                    Text(RegistryKeyText.windowTitle(change)).font(.system(size: 16, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                    Text(RegistryKeyText.windowSubtitle(change)).font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(RegistryKeyText.what).font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                keyRow(RegistryKeyText.acceptedLabel, change.was)
                Rectangle().fill(.white.opacity(0.09)).frame(height: 0.5)
                if let now = change.now { keyRow(RegistryKeyText.newLabel, now, new: true) }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)))
            OwnNoticeBox(icon: "exclamationmark.triangle.fill", color: orange, text: RegistryKeyText.meaning)
            if let until {
                // how long the daemon still accepts this answer; at zero the window closes by itself
                TimelineView(CountdownSchedule(end: until)) { ctx in
                    Text(RegistryKeyText.keep + " " + WindowExpiry.consentText(until: until, now: ctx.date))
                        .font(.system(size: 11.5)).monospacedDigit().foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(RegistryKeyText.keep).font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Spacer()
                Button(RegistryKeyText.accept) { done(true) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0xFF453A, 0.2), stroke: hexColor(0xFF453A, 0.4), text: hexColor(0xFF8A80), height: 32, expand: false))
                Button(RegistryKeyText.decline) { done(false) }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 32, expand: false))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
    }

    /// One key: the fingerprint whole, in a fixed-width face, selectable (it is compared character by character and
    /// pasted into a search), and the key id under it.
    private func keyRow(_ label: String, _ key: RegistryKeyRef, new: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label).foregroundStyle(.white.opacity(0.45)).frame(width: 112, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(key.fingerprint)
                    .font(.system(size: 12.5, weight: new ? .semibold : .regular, design: .monospaced))
                    .foregroundStyle(new ? hexColor(0xFFC56B) : .white.opacity(0.9))
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                if let id = key.keyId {
                    Text(RegistryKeyText.keyId(id)).font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 12.5))
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}
