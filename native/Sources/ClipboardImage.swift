import AppKit
import WebKit

private func imageRect(_ value: JSON) -> CGRect {
    CGRect(x: value["x"] as? Double ?? 0, y: value["y"] as? Double ?? 0,
           width: value["width"] as? Double ?? 0, height: value["height"] as? Double ?? 0)
}

private func validateImageSize(_ rect: CGRect, scale: Double = 2, exporting: Bool = false) throws {
    let values = [rect.origin.x, rect.origin.y, rect.width, rect.height]
    guard values.allSatisfy({ $0.isFinite }), rect.width > 0, rect.height > 0, scale.isFinite, (0.5...4).contains(scale) else {
        throw NativeError("The image could not be copied.")
    }
    // Bound the uncompressed bitmap before asking WebKit or AppKit to allocate it.
    let side: Double = exporting ? 32768 : 16384, pixels: Double = exporting ? 80000000 : 40000000
    guard ceil(rect.width * scale) <= side, ceil(rect.height * scale) <= side, ceil(rect.width * scale) * ceil(rect.height * scale) <= pixels else {
        throw NativeError(exporting ? "The document is too large for this image scale. Choose a smaller scale in Export settings." : "The selection is too large to copy as an image. Select a smaller range.")
    }
}

@MainActor private func imageSnapshot(_ webView: WKWebView, rect: CGRect, scale: Double = 2, exporting: Bool = false, opaque: Bool = false) async throws -> NSBitmapImageRep {
    try validateImageSize(rect, scale: scale, exporting: exporting)
    let config = WKSnapshotConfiguration()
    config.rect = rect
    // snapshotWidth is in points; compensate for the screen's backing scale
    // so both Retina and external displays produce exactly two pixels per CSS px.
    config.snapshotWidth = NSNumber(value: Double(rect.width * scale / (webView.window?.backingScaleFactor ?? 1)))
    let image = try await webView.takeSnapshot(configuration: config)
    let width = Int(ceil(rect.width * scale)), height = Int(ceil(rect.height * scale))
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw NativeError("The image could not be copied.") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context; context.imageInterpolation = .high
    let bounds = NSRect(x: 0, y: 0, width: width, height: height)
    if opaque { NSColor.white.setFill(); bounds.fill() }
    image.draw(in: bounds, from: .zero, operation: opaque ? .sourceOver : .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    bitmap.size = NSSize(width: Double(width) / scale, height: Double(height) / scale)
    return bitmap
}

@MainActor private func writeClipboardImage(_ bitmap: NSBitmapImageRep) throws -> JSON {
    guard let png = bitmap.representation(using: .png, properties: [:]) else { throw NativeError("The image could not be copied.") }
    let pasteboard = NSPasteboard.general
    let image = NSPasteboardItem(); image.setData(png, forType: .png)
    // The primary item is image-only, so image consumers select the new PNG.
    // Text-only consumers can still request the previous textual representations.
    let textItems = (pasteboard.pasteboardItems ?? []).compactMap { original -> NSPasteboardItem? in
        let saved = NSPasteboardItem()
        for type in [NSPasteboard.PasteboardType.string, .html, .rtf] {
            if let data = original.data(forType: type) { saved.setData(data, forType: type) }
        }
        return saved.types.isEmpty ? nil : saved
    }
    pasteboard.clearContents()
    guard pasteboard.writeObjects([image] + textItems) else { throw NativeError("The image could not be copied.") }
    return ["ok": true, "width": bitmap.size.width, "height": bitmap.size.height, "pixelWidth": bitmap.pixelsWide, "pixelHeight": bitmap.pixelsHigh]
}

extension NativeExports {
    func copyImage(_ payload: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        if let region = payload["region"] as? JSON {
            Task { @MainActor in
                do {
                    let cssRect = imageRect(region), zoom = document.webView.pageZoom
                    let rect = CGRect(x: cssRect.minX * zoom, y: cssRect.minY * zoom, width: cssRect.width * zoom, height: cssRect.height * zoom).intersection(document.webView.bounds)
                    let bitmap = try await imageSnapshot(document.webView, rect: rect)
                    reply(try writeClipboardImage(bitmap), nil)
                } catch { reply(nil, app.translate(error.localizedDescription)) }
            }
        } else {
            let job = ImageJob(exports: self, payload: payload, reply: reply)
            imageJobs.append(job); job.start()
        }
    }
}

final class ImageJob: NSObject, WKNavigationDelegate {
    unowned let exports: NativeExports
    let payload: JSON, webView: WKWebView, window: NSWindow
    let destination: URL?
    let reply: (Any?, String?) -> Void
    private var complete = false
    init(exports: NativeExports, payload: JSON, destination: URL? = nil, reply: @escaping (Any?, String?) -> Void) {
        self.exports = exports; self.payload = payload; self.destination = destination; self.reply = reply
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent(); config.setURLSchemeHandler(exports.app.resources, forURLScheme: "lettrine")
        let proposedWidth = payload["width"] as? Double ?? 828
        let width = proposedWidth.isFinite ? max(192, min(4128, proposedWidth)) : 828
        let frame = NSRect(x: 0, y: 0, width: width, height: 1000)
        webView = WKWebView(frame: frame, configuration: config)
        window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: width, height: 1000), styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        webView.navigationDelegate = self
        window.isReleasedWhenClosed = false; window.alphaValue = 0; window.ignoresMouseEvents = true
        window.contentView = webView; window.orderFront(nil)
    }
    func start() {
        webView.loadHTMLString(payload["html"] as? String ?? "", baseURL: URL(string: "lettrine://app/"))
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in self?.finish(nil, "Image rendering timed out.") }
    }
    func finish(_ result: Any?, _ error: String?) {
        if complete { return }
        complete = true; window.orderOut(nil); window.close()
        reply(result, error.map(exports.app.translate)); exports.imageJobs.removeAll { $0 === self }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil, error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(nil, error.localizedDescription) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                _ = try await webView.callAsyncJavaScript("await Promise.all([document.fonts.ready,window.__lettrineExportReady||Promise.resolve(),...Array.from(document.images).map(image=>image.complete?Promise.resolve():new Promise(resolve=>{image.onload=resolve;image.onerror=resolve}))]);return true", arguments: [:], in: nil, contentWorld: .page)
                guard !complete else { return }
                let measure = "(()=>{const el=document.getElementById('write'),r=el.getBoundingClientRect();return {x:Math.max(0,r.left-16),y:Math.max(0,r.top-16),width:Math.ceil(Math.max(r.width,el.scrollWidth))+32,height:Math.max(1,Math.ceil(r.height))+32}})()"
                let region = try await webView.evaluateJavaScript(measure) as? JSON ?? [:]
                let rect = imageRect(region)
                let scale = destination == nil ? 2 : payload["scale"] as? Double ?? 2
                let jpeg = ["jpg", "jpeg"].contains(payload["format"] as? String ?? "")
                try validateImageSize(rect, scale: scale, exporting: destination != nil)
                window.setContentSize(NSSize(width: max(webView.bounds.width, rect.maxX), height: max(webView.bounds.height, rect.maxY)))
                webView.layoutSubtreeIfNeeded()
                // Let the resized WebKit layer commit before capturing content
                // that was originally below the offscreen view's first screen.
                try await Task.sleep(nanoseconds: 50000000)
                guard !complete else { return }
                let bitmap = try await imageSnapshot(webView, rect: rect, scale: scale, exporting: destination != nil, opaque: jpeg)
                guard !complete else { return }
                if let destination = destination {
                    guard let data = bitmap.representation(using: jpeg ? .jpeg : .png, properties: jpeg ? [.compressionFactor: 0.92] : [:]) else { throw NativeError("The image could not be exported.") }
                    try data.write(to: destination, options: .atomic)
                    finish(["ok": true, "path": destination.path, "pixelWidth": bitmap.pixelsWide, "pixelHeight": bitmap.pixelsHigh], nil)
                } else { finish(try writeClipboardImage(bitmap), nil) }
            } catch { finish(nil, error.localizedDescription) }
        }
    }
}
