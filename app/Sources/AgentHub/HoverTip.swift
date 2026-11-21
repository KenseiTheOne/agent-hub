import AgentHubKit
import AppKit
import SwiftUI

/// Hover hint — the hub's own card (`TipWindow`, task 127) shown by a transparent view over the content.
///
/// Why not SwiftUI `.help` (2026-11-10): the hint did not appear over a truncated plugin status in the sidebar or over
/// plugin page rows — the panel redraws on every daemon event, selectable texts (`textSelection`) have their own AppKit
/// field on top, and system tooltips are not shown while the app is inactive (the panel is usually looked at while
/// working in a terminal). Until task 127 this view carried an AppKit tooltip (`NSView.toolTip`); AppKit still showed
/// it after a delay and in the system's plain style, so now it listens to the pointer itself (a tracking area that works
/// in an inactive app) and shows the card at once. The view is transparent to the mouse (`hitTest` → nil): clicks,
/// button hover and text selection work as before.
final class HoverTipView: NSView {
    var tip: String? {
        didSet {
            guard tip != oldValue, TipWindow.shared.isOwned(by: self) else { return }
            present(force: true)
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isOpaque: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { present() }
    override func mouseMoved(with event: NSEvent) { present() }
    override func mouseExited(with event: NSEvent) { TipWindow.shared.hide(for: self) }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { TipWindow.shared.hide(for: self) }
    }

    /// The view's visible part in window coordinates. `visibleRect` alone is not enough: inside the window's sidebar
    /// scroll view it came back stretched from the row down to the bottom of the column (2026-11-21), so the card stood
    /// mid-column. The view's own bounds bound it.
    static func visibleFrameInWindow(_ v: NSView) -> NSRect {
        let whole = v.convert(v.bounds, to: nil)
        let seen = v.convert(v.visibleRect, to: nil).intersection(whole)
        return seen.isEmpty ? whole : seen
    }

    /// The region this hint covers, on screen.
    var screenRegion: NSRect? {
        guard let w = window else { return nil }
        return w.convertToScreen(Self.visibleFrameInWindow(self))
    }

    private func present(force: Bool = false) {
        guard let t = tip, !t.isEmpty, let r = screenRegion, !(window?.isVisible == false) else {
            TipWindow.shared.hide(for: self)
            return
        }
        if force { TipWindow.shared.hide(for: self) }
        TipWindow.shared.offer(t, owner: self, region: r, anchor: .pointer(NSEvent.mouseLocation))
    }
}

struct HoverTip: NSViewRepresentable {
    let text: String?

    /// AppKit tooltips that remain (the menu bar icon, AppKit controls) without delay (2026-11-10, user request): AppKit
    /// waits `NSInitialToolTipDelay` ms before showing (about a second by default). Registered in the app domain as a
    /// default; nothing is written to the user's preferences.
    private static let instantTips: Void = {
        UserDefaults.standard.register(defaults: ["NSInitialToolTipDelay": 1])
    }()

    static func enableInstantTips() { _ = instantTips }

    func makeNSView(context: Context) -> HoverTipView {
        _ = Self.instantTips
        let v = HoverTipView()
        v.tip = text
        v.setAccessibilityElement(false)
        return v
    }

    func updateNSView(_ v: HoverTipView, context: Context) {
        v.tip = text
    }
}

/// Whether some text inside is truncated: texts with `reportsTruncation` report it upward, `hoverHelp` reads and consumes it.
struct TruncatedTextKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

/// Compares the height of the text wrapped without a line limit at its frame width with the height of the frame itself:
/// taller means the text is cut off by an ellipsis or a line limit (or shrunk by `minimumScaleFactor`).
struct TruncationProbe: ViewModifier {
    let text: String
    let font: Font
    /// `@State` without the macro (built without Xcode, like `DetailsDisclosure`).
    private let cutState = State(initialValue: false)

    func body(content: Content) -> some View {
        content
            .background(GeometryReader { box in
                Text(text).font(font)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: max(box.size.width, 1), alignment: .topLeading)
                    .hidden()
                    .background(GeometryReader { full in
                        Color.clear
                            .onAppear { cutState.wrappedValue = full.size.height > box.size.height + 1 }
                            .onChange(of: full.size.height) { _, h in cutState.wrappedValue = h > box.size.height + 1 }
                            .onChange(of: box.size.height) { _, h in cutState.wrappedValue = full.size.height > h + 1 }
                    })
            })
            .preference(key: TruncatedTextKey.self, value: cutState.wrappedValue)
    }
}

extension View {
    /// Text `text` in font `font` (the same as the text itself): reports upward whether it is currently truncated.
    func reportsTruncation(_ text: String, font: Font) -> some View {
        modifier(TruncationProbe(text: text, font: font))
    }

    /// Full text on hover (nil or empty — no tooltip). Shown only if some text inside is
    /// truncated (`reportsTruncation`, 2026-11-10: a line that fits entirely needs no tooltip), or always —
    /// `always` (the plugin declared the tooltip, `tooltip=`; a button explains what blocks it). For plugin texts —
    /// `PluginText.*`.
    /// The hub's hint, always shown (in place of SwiftUI `.help`, which waits and draws a system tooltip).
    func tip(_ text: String?) -> some View { hoverHelp(text, always: true) }

    func hoverHelp(_ text: String?, always: Bool = false) -> some View {
        let t = text.flatMap { $0.isEmpty ? nil : $0 }
        return overlayPreferenceValue(TruncatedTextKey.self) { cut in
            HoverTip(text: always || cut ? t : nil).allowsHitTesting(false)
        }
        .transformPreference(TruncatedTextKey.self) { $0 = false }
    }
}

/// Hint check on the test stand (`--tooltip <text fragment>` together with `--snapshot-panel`): which hints the window
/// carries, and the card (`TipWindow.image`) of the one whose text contains the fragment, placed under its element (the
/// stand does not move the pointer). For snapshots and manual checks only.
enum TooltipProbe {
    /// All window hints: (frame in window coordinates, text, where the card's pointer is: `.bottom` — the card stands
    /// above it (a chart's bar column), nil — at the pointer).
    static func tips(in window: NSWindow) -> [(rect: NSRect, text: String, arrow: TipArrow.Edge?)] {
        guard let root = window.contentView?.superview ?? window.contentView else { return [] }
        var out: [(NSRect, String, TipArrow.Edge?)] = []
        func walk(_ v: NSView) {
            if let h = v as? HoverTipView, let t = h.tip, !t.isEmpty {
                out.append((h.convert(h.bounds, to: nil), t, nil))
            } else if let c = v as? ChartTipsView {
                for col in c.columns() { out.append((c.convert(c.barTop(col.bar, in: col.rect), to: nil), col.text, .bottom)) }
            }
            v.subviews.forEach(walk)
        }
        walk(root)
        return out
    }

    @MainActor static func render(_ text: String, arrow: TipArrow.Edge?) -> NSImage? {
        TipWindow.shared.image(for: text, arrow: arrow)
    }
}
