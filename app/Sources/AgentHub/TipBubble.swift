import AppKit
import SwiftUI

/// The hub's own hover hint (task 127): a small glass card in its own borderless window, shown the moment the pointer
/// enters an element — no AppKit tooltip delay, which `NSInitialToolTipDelay` did not reliably remove (the panel is looked
/// at while another app is active, and AppKit still waited). One window for the whole app; whoever the pointer is over
/// owns it.
///
/// The look was chosen on a test page among five (2026-11-21): glass — the panel shows through, blurred, under a light
/// tint; it fades in quickly and glides from bar to bar. A multi-line hint reads as a heading and details — the first
/// line semibold, a hairline, then the rest secondary with tabular digits (chart tips are "date · total" then one line
/// per part); a one-line hint is plain text. A card standing over a chart bar has a small pointer toward it; any other
/// card follows the pointer, just below-right of it.
struct TipBubbleView: View {
    let text: String
    /// The card's small pointer; nil — none.
    var arrow: TipArrow?
    /// On screen the blur comes from the window's `NSVisualEffectView` and this view only tints it; a snapshot cannot
    /// capture the blur, so there the card is filled almost solid and draws its own shadow inside a margin.
    var forSnapshot = false
    /// The text column's width once measured (`TipWindow.measure`); nil — up to `TipWindow.maxWidth`. A long one-line
    /// hint measured without it reported one line's height and was cut off when it wrapped on screen (2026-11-21).
    var width: CGFloat?

    static let radius: CGFloat = 11
    static let arrowSize = CGSize(width: 12, height: 6)
    /// Room around the card for the shadow, in a snapshot only (on screen the window draws the shadow).
    static let snapshotMargin: CGFloat = 10

    var body: some View {
        let lines = text.components(separatedBy: "\n")
        VStack(alignment: .leading, spacing: 5) {
            if lines.count > 1 {
                Text(lines[0]).font(.system(size: 12, weight: .semibold))
                Rectangle().fill(Color(nsColor: TipWindow.rule)).frame(height: 0.5)
                Text(lines.dropFirst().joined(separator: "\n"))
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).monospacedDigit()
            } else {
                Text(text).font(.system(size: 12))
            }
        }
        .lineSpacing(2)
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: width, alignment: .leading)
        .frame(maxWidth: TipWindow.maxWidth, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .padding(.top, arrow?.edge == .top ? Self.arrowSize.height : 0)
        .padding(.bottom, arrow?.edge == .bottom ? Self.arrowSize.height : 0)
        .fixedSize()
        .background(shape.fill(Color(nsColor: forSnapshot ? TipWindow.snapshotTint : TipWindow.tint)))
        .overlay(shape.stroke(Color(nsColor: TipWindow.edge), lineWidth: 0.5))
        // the glass's lit top edge
        .overlay(shape.stroke(LinearGradient(colors: [Color(nsColor: TipWindow.shine), .clear], startPoint: .top,
                                             endPoint: .init(x: 0.5, y: 0.25)), lineWidth: 0.5))
        .compositingGroup()
        .shadow(color: .black.opacity(forSnapshot ? 0.3 : 0), radius: 9, y: 4)
        .padding(forSnapshot ? Self.snapshotMargin : 0)
    }

    var shape: TipShape { TipShape(radius: Self.radius, arrow: arrow, arrowSize: Self.arrowSize) }
}

/// Where the card's pointer sits: on which edge, and how far from the card's left (clamped clear of the corners).
struct TipArrow {
    enum Edge { case bottom, top }
    var edge: Edge
    var at: CGFloat
}

/// A rounded card, with an optional small pointer on its bottom or top edge — one outline, so the border runs
/// around the pointer too. Also the mask of the window's blur.
struct TipShape: Shape {
    let radius: CGFloat
    let arrow: TipArrow?
    let arrowSize: CGSize

    func path(in rect: CGRect) -> Path {
        var card = rect
        guard let a = arrow else {
            return Path(roundedRect: card, cornerRadius: radius, style: .continuous)
        }
        let h = arrowSize.height, half = arrowSize.width / 2
        switch a.edge {
        case .bottom: card.size.height -= h
        case .top: card.origin.y += h; card.size.height -= h
        }
        let p = Path(roundedRect: card, cornerRadius: radius, style: .continuous)
        var tip = Path()
        do {
            let x = min(max(a.at, card.minX + radius + half), card.maxX - radius - half)
            let (base, apex, bulge) = a.edge == .bottom ? (card.maxY - 0.5, rect.maxY, card.maxY + 2) : (card.minY + 0.5, rect.minY, card.minY - 2)
            tip.move(to: CGPoint(x: x - half, y: base))
            tip.addQuadCurve(to: CGPoint(x: x, y: apex), control: CGPoint(x: x - 1.5, y: bulge))
            tip.addQuadCurve(to: CGPoint(x: x + half, y: base), control: CGPoint(x: x + 1.5, y: bulge))
        }
        tip.closeSubpath()
        return p.union(tip)
    }
}

@MainActor
final class TipWindow {
    static let shared = TipWindow()
    static let maxWidth: CGFloat = 300

    private static func dynamic(dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light }
    }
    /// The tint over the blur: enough to keep the text readable over a bright bar, light enough to see the panel.
    static let tint = dynamic(dark: NSColor(srgbRed: 0.19, green: 0.19, blue: 0.22, alpha: 0.55),
                              light: NSColor(white: 1, alpha: 0.6))
    /// What the glass roughly looks like over the panel, for snapshots (they cannot capture the blur).
    static let snapshotTint = dynamic(dark: NSColor(srgbRed: 0.2, green: 0.2, blue: 0.23, alpha: 0.94),
                                      light: NSColor(white: 0.98, alpha: 0.95))
    static let edge = dynamic(dark: NSColor(white: 1, alpha: 0.12), light: NSColor(white: 0, alpha: 0.1))
    static let shine = dynamic(dark: NSColor(white: 1, alpha: 0.28), light: NSColor(white: 1, alpha: 0.9))
    static let rule = dynamic(dark: NSColor(white: 1, alpha: 0.12), light: NSColor(white: 0, alpha: 0.08))

    /// "Appears at once, softly": a quick fade in, and a short glide when the card moves to the next bar.
    static let fadeIn: TimeInterval = 0.09
    static let glide: TimeInterval = 0.07

    /// Where the card goes: below-right of the pointer, following it (like a tooltip), or centered above a rectangle
    /// (a chart's bar).
    enum Anchor {
        case pointer(NSPoint)
        case above(NSRect)
    }

    private let panel: NSPanel
    private let glass: NSVisualEffectView
    private let host: NSHostingView<TipBubbleView>
    private weak var owner: NSView?
    /// The owner's region on screen and which part of it (a bar index; 0 for a whole element): the card moves only when
    /// they change, not with every pointer move.
    private var region: NSRect = .zero
    private var key = 0
    private var text = ""
    private var monitor: Any?
    /// Checks the pointer while the card is up (task 128): the owner's `mouseExited` is lost when the panel redraws
    /// under a still pointer (its tracking area is rebuilt), and the card then stayed until another hint took it.
    private var watchdog: Timer?
    /// Where the owner stood on screen when the card was placed; if it moves (the window slides in, the list scrolls),
    /// the card no longer points at it.
    private var ownerFrame: NSRect = .zero

    private init() {
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true  // follows the card's shape: the window is transparent outside the blur's mask
        panel.level = .popUpMenu
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        let root = NSView()
        glass = NSVisualEffectView()
        glass.material = .popover
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.autoresizingMask = [.width, .height]
        host = NSHostingView(rootView: TipBubbleView(text: ""))
        host.autoresizingMask = [.width, .height]
        root.addSubview(glass)
        root.addSubview(host)
        panel.contentView = root
    }

    var isShown: Bool { panel.isVisible }
    func isOwned(by v: NSView) -> Bool { owner === v }

    /// `owner` wants its hint shown. Nested elements both hear the pointer: the smaller region under the pointer wins,
    /// so a bar's hint is not replaced by its card's, and leaving the bar hands the card back to the outer element.
    func offer(_ text: String, owner new: NSView, region r: NSRect, key k: Int = 0, anchor: Anchor) {
        let mouse = NSEvent.mouseLocation
        if let cur = owner, cur !== new, cur.window != nil, panel.isVisible, NSMouseInRect(mouse, region, false),
           region.width * region.height <= r.width * r.height {
            return
        }
        let moved = owner !== new || k != key || text != self.text || !panel.isVisible
        owner = new
        region = r
        key = k
        guard moved else {
            if case .pointer(let pt) = anchor { follow(pt) }
            return
        }
        self.text = text
        ownerFrame = Self.screenFrame(of: new) ?? .zero
        place(anchor)
        watchClicks()
        watchPointer()
    }

    func hide(for v: NSView) {
        guard owner === v else { return }
        hide()
    }

    func hide() {
        owner = nil
        panel.orderOut(nil)
        if let m = monitor { NSEvent.removeMonitor(m) }
        monitor = nil
        watchdog?.invalidate()
        watchdog = nil
    }

    /// Hides the card once the pointer is out of the owner's region or the owner has left its window.
    private func watchPointer() {
        guard watchdog == nil else { return }
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.stale(pointer: NSEvent.mouseLocation) { self.hide() }
        }
        RunLoop.main.add(t, forMode: .common)
        watchdog = t
    }

    /// Whether the shown card no longer belongs under `pointer`.
    private func stale(pointer: NSPoint) -> Bool {
        guard let o = owner, let now = Self.screenFrame(of: o) else { return true }
        if abs(now.minX - ownerFrame.minX) > 1 || abs(now.minY - ownerFrame.minY) > 1 { return true }
        return !NSMouseInRect(pointer, region.insetBy(dx: -1, dy: -1), false)
    }

    /// The view's visible part on screen, or nil when it has no window.
    private static func screenFrame(of v: NSView) -> NSRect? {
        guard let w = v.window else { return nil }
        return w.convertToScreen(HoverTipView.visibleFrameInWindow(v))
    }

    /// A click or scroll hides the card, as with a system tooltip (the element under the pointer may change or move).
    private func watchClicks() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .scrollWheel, .keyDown]) { [weak self] e in
            self?.hide()
            return e
        }
    }

    /// Where the card stands below-right of the pointer `pt`, kept on the screen.
    private static func origin(below pt: NSPoint, size: NSSize, in vis: NSRect) -> NSPoint {
        var o = NSPoint(x: pt.x + 10, y: pt.y - 22 - size.height)
        if o.y < vis.minY + 4 { o.y = pt.y + 12 }
        o.x = min(max(o.x, vis.minX + 4), vis.maxX - size.width - 4)
        o.y = min(max(o.y, vis.minY + 4), vis.maxY - size.height - 4)
        return o
    }

    /// The pointer moved within the same element: the card goes along with it, no glide (it would lag behind).
    private func follow(_ pt: NSPoint) {
        guard panel.isVisible else { return }
        let vis = (NSScreen.screens.first { NSMouseInRect(pt, $0.frame, false) } ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: -1e5, y: -1e5, width: 2e5, height: 2e5)
        panel.setFrameOrigin(Self.origin(below: pt, size: panel.frame.size, in: vis))
    }

    private func place(_ anchor: Anchor) {
        var view = TipBubbleView(text: text)
        switch anchor {
        case .pointer: break
        case .above: view.arrow = TipArrow(edge: .bottom, at: 0)
        }
        let size = Self.measure(&view)
        let p: NSPoint
        switch anchor {
        case .pointer(let pt): p = pt
        case .above(let r): p = NSPoint(x: r.midX, y: r.maxY)
        }
        let vis = (NSScreen.screens.first { NSMouseInRect(p, $0.frame, false) } ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: -1e5, y: -1e5, width: 2e5, height: 2e5)
        var o: NSPoint
        var down = true
        switch anchor {
        case .pointer(let pt):
            o = Self.origin(below: pt, size: size, in: vis)
        case .above(let r):
            o = NSPoint(x: r.midX - size.width / 2, y: r.maxY + 2)
            if o.y + size.height > vis.maxY - 4 { o.y = r.minY - 2 - size.height; down = false }
        }
        o.x = min(max(o.x, vis.minX + 4), vis.maxX - size.width - 4)
        o.y = min(max(o.y, vis.minY + 4), vis.maxY - size.height - 4)
        switch anchor {
        case .pointer: break
        case .above(let r):
            // the pointer aims at the bar even when the card is pushed off-center by the screen edge
            view.arrow = TipArrow(edge: down ? .bottom : .top, at: r.midX - o.x)
        }
        host.rootView = view
        glass.maskImage = Self.mask(view.shape, size: size)
        let frame = NSRect(origin: o, size: size)
        if panel.isVisible {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = Self.glide
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(frame, display: true)
            }
        } else {
            panel.setFrame(frame, display: true)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = Self.fadeIn
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
            }
        }
        panel.invalidateShadow()
    }

    /// Sizes `view` in two passes: the first finds the text column's width (its one-line width up to `maxWidth`), the
    /// second wraps the text at that width and gives the real height. One pass measured a long sentence as one line.
    private static func measure(_ view: inout TipBubbleView) -> NSSize {
        view.width = nil
        let wide = NSHostingView(rootView: view).fittingSize
        let pad: CGFloat = 24 + (view.forSnapshot ? 2 * TipBubbleView.snapshotMargin : 0)
        view.width = min(max(wide.width - pad, 1), maxWidth)
        return NSHostingView(rootView: view).fittingSize
    }

    /// The blur's mask: the card's outline (the window shows nothing outside it, so its shadow follows it too).
    private static func mask(_ shape: TipShape, size: NSSize) -> NSImage {
        NSImage(size: size, flipped: true) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.addPath(shape.path(in: rect).cgPath)
            ctx.setFillColor(NSColor.black.cgColor)
            ctx.fillPath()
            return true
        }
    }

    /// The card for `text` as an image (the snapshot stand, `--tooltip`): what `offer` shows, with the glass replaced
    /// by a near-solid tint and the shadow drawn in a margin, at the screen's scale.
    func image(for text: String, arrow edge: TipArrow.Edge? = nil, scale: CGFloat = NSScreen.main?.backingScaleFactor ?? 2) -> NSImage? {
        var view = TipBubbleView(text: text, forSnapshot: true)
        _ = Self.measure(&view)
        if let e = edge {
            view.arrow = TipArrow(edge: e, at: 0)
            let s = NSHostingView(rootView: view).fittingSize
            let m = 2 * TipBubbleView.snapshotMargin
            view.arrow = TipArrow(edge: e, at: (s.width - m) / 2)
        }
        // `ImageRenderer` with an explicit scale: `cacheDisplay` rasterizes a SwiftUI view at 1x even into a 2x buffer
        let appearance = NSApp.effectiveAppearance
        var img: NSImage?
        appearance.performAsCurrentDrawingAppearance {
            let r = ImageRenderer(content: view.environment(\.colorScheme,
                                                            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .dark : .light))
            r.scale = scale
            img = r.nsImage
        }
        return img
    }
}
