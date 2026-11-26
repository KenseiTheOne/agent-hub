import AgentHubKit
import SwiftUI

/// The "Stay awake with the lid closed" switch next to "Pause hub": one for the popover and the panel. The daemon owns
/// the flag; this row shows it and sends the switch (`AwakeRow` in the Kit decides the look). Nothing at all when the
/// daemon has no such section or the machine has no lid.
///
/// A capsule like its neighbours with a small switch at the right edge; the sign is the one the menu bar icon carries
/// while the flag is on (`StatusImages.AwakeMark`), so the mark up there is recognised. No rights — the whole row is
/// greyed and doesn't switch; a click copies the terminal command that grants them (the hint names it and says so),
/// and the title says "copied" for a moment. On without rights — the same grey row with the
/// switch on, and a warning sign in color (`Warning`) where the row's own sign was: a grey knob on the other side
/// alone is easy to miss, and this is the case where the hub can't bring sleep back when the battery runs low.
struct AwakeToggleRow: View {
    let store: HubStore
    var height: CGFloat = 32
    /// In the sidebar card the shape follows the card, like "Pause hub" there.
    var concentric = false

    /// The "on, but the hub has no rights" sign: everything that tunes it.
    enum Warning {
        static let symbol = "exclamationmark.triangle.fill"
        static let pointSize: CGFloat = 12
        static var color: Color { Color(nsColor: .systemYellow) }
    }

    /// The grant command was just copied by a click on the greyed row: the title says so for a moment.
    /// `@State` without the macro (built without Xcode, see MenuContent).
    private let copiedStore = State(initialValue: false)
    private var copied: Bool { get { copiedStore.wrappedValue } nonmutating set { copiedStore.wrappedValue = newValue } }

    var body: some View {
        if let row = AwakeRow.make(store.awake, live: store.connection.isLive, hub: store.state?.hub) {
            let warns = row.look == .unavailable(on: true)
            // no rights: the row can't switch, so a click hands over the command that grants them
            let copies = !row.look.isAvailable
            let live = store.connection.isLive
            Button { Task { await store.setAwake(!row.isOn) } } label: {
                HStack(spacing: 8) {
                    Label {
                        Text(copied ? AwakeText.copied : AwakeRow.title)
                    } icon: {
                        // The warning takes the place of the row's sign instead of a place of its own: in the
                        // sidebar the title fills the row to the switch, a sign next to it would cut the title.
                        // Only the place here — the sign itself is drawn over the row, outside the greying.
                        Image(systemName: StatusImages.AwakeMark.symbol).opacity(warns ? 0 : 1)
                            .anchorPreference(key: WarningPlace.self, value: .bounds) { warns ? $0 : nil }
                    }
                    Spacer(minLength: 0)
                    // only shows the state: the click belongs to the whole row
                    Toggle("", isOn: .constant(row.isOn)).labelsHidden().toggleStyle(.switch).controlSize(.mini)
                        .allowsHitTesting(false)
                }
            }
            .buttonStyle(CapsuleStyle(height: height, concentric: concentric))
            .disabled(!row.enabled)
            // a disabled capsule loses its color, the warning must not: drawn here, over the place of the row's sign
            .overlayPreferenceValue(WarningPlace.self) { place in
                GeometryReader { geo in
                    if let place {
                        Image(systemName: Warning.symbol)
                            .font(.system(size: Warning.pointSize, weight: .semibold))
                            .foregroundStyle(Warning.color)
                            .position(x: geo[place].midX, y: geo[place].midY)
                    }
                }
                .allowsHitTesting(false)
            }
            // a disabled button takes no clicks: the copying click is caught over it
            .overlay {
                if copies {
                    Color.clear.contentShape(Rectangle()).onTapGesture {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(AwakeText.grantCommand(hub: store.state?.hub), forType: .string)
                        copied = true
                        Task {
                            try? await Task.sleep(for: .seconds(1.6))
                            copied = false
                        }
                    }
                }
            }
            .tip(copies && live ? row.help + " " + AwakeText.clickCopies : row.help)
        }
    }
}

/// Where the row keeps the place for the warning sign.
private struct WarningPlace: PreferenceKey {
    static var defaultValue: Anchor<CGRect>? { nil }
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}
