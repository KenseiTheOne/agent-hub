import AppKit
// Menu bar icon from the artwork (app/Resources/MenuBar/MenuBarIcon-source.png): a template of the bot and the emblem mask on a
// 22×22 pt canvas (@1x/@2x/@3x). Run: swift app/Tools/make-menubar-icon.swift <art.png> app/Resources/MenuBar
struct G { let mask: CGImage; let emblem: CGImage?; let w: Int; let h: Int }
func load(_ path: String) -> G {
  let src = NSBitmapImageRep(data: NSImage(contentsOfFile: path)!.tiffRepresentation!)!
  let W = src.pixelsWide, H = src.pixelsHigh
  var a = [UInt8](repeating: 0, count: W * H)
  for y in 0..<H { for x in 0..<W { let c = src.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
    let lum = 0.299 * c.redComponent + 0.587 * c.greenComponent + 0.114 * c.blueComponent
    a[y * W + x] = UInt8(max(0, min(1, (0.85 - lum) / 0.7)) * 255) } }
  // bbox
  var minX = W, minY = H, maxX = 0, maxY = 0
  for y in 0..<H { for x in 0..<W where a[y * W + x] > 40 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } }
  // white components that don't touch the image edge
  var lab = [Int32](repeating: -1, count: W * H); var comps: [(n: Int, sx: Int, sy: Int, minY: Int, maxY: Int, touch: Bool)] = []
  var stack: [Int] = []
  for i in 0..<(W * H) where a[i] < 128 && lab[i] < 0 {
    let id = Int32(comps.count); var n = 0, sx = 0, sy = 0, mny = H, mxy = 0, touch = false
    lab[i] = id; stack.append(i)
    while let p = stack.popLast() { let x = p % W, y = p / W; n += 1; sx += x; sy += y; mny = min(mny, y); mxy = max(mxy, y)
      if x == 0 || y == 0 || x == W - 1 || y == H - 1 { touch = true }
      for q in [p - 1, p + 1, p - W, p + W] where q >= 0 && q < W * H && lab[q] < 0 && a[q] < 128 && abs((q % W) - x) <= 1 { lab[q] = id; stack.append(q) } }
    comps.append((n, sx, sy, mny, mxy, touch)) }
  // emblem: an enclosed region centred in the top 50% of the figure, the largest one; but not a thin gap (compact)
  let topLimit = minY + (maxY - minY) / 2
  var best = -1; var bestN = 0
  for (k, c) in comps.enumerated() where !c.touch && c.n > 50 {
    let cy = c.sy / c.n; let hgt = c.maxY - c.minY + 1
    if cy < topLimit && Double(c.n) / Double(hgt * hgt) > 0.4 && c.n > bestN { best = k; bestN = c.n } }
  let cw = maxX - minX + 1, ch = maxY - minY + 1
  func img(_ f: (Int) -> UInt8) -> CGImage {
    var rgba = [UInt8](repeating: 0, count: cw * ch * 4)
    for y in 0..<ch { for x in 0..<cw { rgba[(y * cw + x) * 4 + 3] = f((y + minY) * W + (x + minX)) } }
    let ctx = CGContext(data: &rgba, width: cw, height: ch, bitsPerComponent: 8, bytesPerRow: cw * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return ctx.makeImage()! }
  let m = img { a[$0] }
  let e: CGImage? = best >= 0 ? img { lab[$0] == Int32(best) ? 255 : 0 } : nil
  return G(mask: m, emblem: e, w: cw, h: ch)
}
func export(_ g: G, scale: CGFloat, part: String) -> Data {
  let box = Int(22 * scale), maxH = 18 * scale
  let k = min(maxH / CGFloat(g.h), CGFloat(box) / CGFloat(g.w)); let gw = CGFloat(g.w) * k, gh = CGFloat(g.h) * k
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: box, pixelsHigh: box, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let ctx = NSGraphicsContext.current!.cgContext; ctx.interpolationQuality = .high
  let rect = CGRect(x: (CGFloat(box) - gw) / 2, y: (CGFloat(box) - gh) / 2, width: gw, height: gh)
  ctx.clip(to: rect, mask: part == "emblem" ? g.emblem! : g.mask); NSColor.black.setFill(); ctx.fill(rect)
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}
let g = load(CommandLine.arguments[1]); let out = CommandLine.arguments[2]
precondition(g.emblem != nil, "emblem not found")
for (s, suf) in [(CGFloat(1), ""), (2, "@2x"), (3, "@3x")] {
  try! export(g, scale: s, part: "glyph").write(to: URL(fileURLWithPath: "\(out)/MenuBarIcon\(suf).png"))
  try! export(g, scale: s, part: "emblem").write(to: URL(fileURLWithPath: "\(out)/MenuBarEmblem\(suf).png"))
}
