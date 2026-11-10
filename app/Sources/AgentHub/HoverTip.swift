import AgentHubKit
import AppKit
import SwiftUI

/// Hover hint — a real AppKit tooltip (`NSView.toolTip`) on a transparent view over the content.
///
/// Why not SwiftUI `.help` (2026-11-10): the hint did not appear over a truncated plugin status in the sidebar or over
/// plugin page rows. `.help` does not install an AppKit tooltip up front (`NSToolTipManager`
/// has none for a view with `.help` — verified by experiment on 2026-11-10) but shows it from its own SwiftUI hover tracking;
/// the panel, however, redraws on every daemon event (sessions — every couple of seconds), selectable texts
/// (`textSelection`) have their own AppKit field on top, and AppKit tooltips are not shown by default while the app
/// is inactive (the panel is usually looked at while working in a terminal). Here the hint is an AppKit tooltip rectangle on a
/// persistent view: a redraw changes it only when the text changes, AppKit shows it by itself, and the panel and
/// popover windows allow this even in an inactive app (`allowsToolTipsWhenApplicationIsInactive`). The view is transparent to
/// the mouse (`hitTest` → nil): clicks, button hover and text selection work as before.
final class HoverTipView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isOpaque: Bool { false }

    /// The window allows tooltips in an inactive app as soon as the view lands in it, not later (`PanelChrome`,
    /// `TransparentWindow` set the flag via `DispatchQueue.main.async`): AppKit decides whether to install the tooltip
    /// rectangle when `toolTip` is assigned and when entering the window (`_shouldInstallToolTip:` looks at `isActive` and
    /// `allowsToolTipsWhenApplicationIsInactive`). A view that landed in the window before the flag, while the app is inactive, would otherwise
    /// stay without a tooltip until the text changes — so the flag is set here and the tooltip is reassigned.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let w = window else { return }
        if !w.allowsToolTipsWhenApplicationIsInactive { w.allowsToolTipsWhenApplicationIsInactive = true }
        if let t = toolTip {
            toolTip = nil
            toolTip = t
        }
    }
}

struct HoverTip: NSViewRepresentable {
    let text: String?

    /// Tooltips without delay (2026-11-10, user request): AppKit waits `NSInitialToolTipDelay` ms before showing
    /// (about a second by default). The value is registered in the app domain as a default —
    /// before the first tooltip; nothing is written to the user's preferences.
    private static let instantTips: Void = {
        UserDefaults.standard.register(defaults: ["NSInitialToolTipDelay": 1])
    }()

    func makeNSView(context: Context) -> HoverTipView {
        _ = Self.instantTips
        let v = HoverTipView()
        v.toolTip = text
        v.setAccessibilityElement(false)
        return v
    }

    func updateNSView(_ v: HoverTipView, context: Context) {
        if v.toolTip != text { v.toolTip = text }
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
    func hoverHelp(_ text: String?, always: Bool = false) -> some View {
        let t = text.flatMap { $0.isEmpty ? nil : $0 }
        return overlayPreferenceValue(TruncatedTextKey.self) { cut in
            HoverTip(text: always || cut ? t : nil).allowsHitTesting(false)
        }
        .transformPreference(TruncatedTextKey.self) { $0 = false }
    }
}

/// Tooltip check on the test stand (`--tooltip <text fragment>` together with `--snapshot-panel`): which AppKit tooltips
/// are installed in the window, and a window snapshot with the real tooltip of the one whose text contains the fragment. The tooltip is drawn by
/// AppKit itself (`NSToolTipManager`, the same object that would show it on hover); in the snapshot it is placed under its
/// element, not at the cursor (the stand does not move the cursor). For snapshots and manual checks only.
enum TooltipProbe {
    private static var manager: NSObject? {
        guard let cls = NSClassFromString("NSToolTipManager") as? NSObject.Type,
              let m = cls.perform(NSSelectorFromString("sharedToolTipManager"))?.takeUnretainedValue() as? NSObject else { return nil }
        return m
    }

    /// All window tooltips: (view, frame in window coordinates, text, AppKit tooltip object).
    static func tips(in window: NSWindow) -> [(view: NSView, rect: NSRect, text: String, tip: NSObject)] {
        guard let m = manager, let root = window.contentView?.superview ?? window.contentView else { return [] }
        var out: [(NSView, NSRect, String, NSObject)] = []
        func walk(_ v: NSView) {
            if v.toolTip != nil, let raw = m.perform(NSSelectorFromString("_toolTipsForView:"), with: v)?.takeUnretainedValue() as? NSObject {
                for t in (raw as? [NSObject]) ?? [raw] {
                    if let s = t.value(forKey: "string") as? String { out.append((v, v.convert(v.bounds, to: nil), s, t)) }
                }
            }
            v.subviews.forEach(walk)
        }
        walk(root)
        return out
    }

    /// Show the real tooltip for `tip` and return an image of its window (nil — AppKit did not show it).
    @MainActor static func render(_ tip: NSObject) async -> NSImage? {
        guard let m = manager else { return nil }
        m.perform(NSSelectorFromString("displayToolTip:"), with: tip)
        for _ in 0..<30 {
            try? await Task.sleep(for: .milliseconds(100))
            if let w = NSApp.windows.first(where: { String(describing: type(of: $0)).contains("ToolTip") && $0.isVisible }),
               let cv = w.contentView, let rep = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) {
                cv.cacheDisplay(in: cv.bounds, to: rep)
                let img = NSImage(size: cv.bounds.size)
                img.addRepresentation(rep)
                m.perform(NSSelectorFromString("orderOutToolTipsImmediately:"), with: true)
                return img
            }
        }
        return nil
    }
}
