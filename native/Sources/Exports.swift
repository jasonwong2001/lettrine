import AppKit
import WebKit
import PDFKit

final class NativeExports {
    unowned let app: NativeApplicationDelegate
    var jobs: [PrintJob] = []
    var imageJobs: [ImageJob] = []
    init(app: NativeApplicationDelegate) { self.app = app }
    func handle(_ channel: String, _ p: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        var p = p
        if p["docPath"] == nil { p["docPath"] = document.path }
        if channel == "export.html", p["path"] == nil || p["path"] is NSNull { reply(["ok": true, "html": p["html"] ?? "", "warnings": []], nil); return }
        guard let path = p["path"] as? String else { reply(nil, "Choose an export destination"); return }
        let destination = fileURL(path)
        if let source = p["docPath"] as? String, fileURL(source) == destination {
            reply(nil, app.translate("Choose an export path different from the source document.")); return
        }
        do { try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true) }
        catch { reply(nil, error.localizedDescription); return }
        if channel == "export.pdf" {
            let job = PrintJob(exports: self, payload: p, destination: destination, reply: reply)
            jobs.append(job); job.start(); return
        }
        if channel == "export.image" {
            guard ["png", "jpg", "jpeg"].contains(p["format"] as? String ?? "png") else { reply(nil, "Unsupported export format"); return }
            let job = ImageJob(exports: self, payload: p, destination: destination, reply: reply)
            imageJobs.append(job); job.start(); return
        }
        if channel == "controller.screenshotHTML" {
            Task { @MainActor in
                do {
                    let config = WKSnapshotConfiguration()
                    if let region = try? await document.evaluate("(()=>{const r=document.querySelector('#md-content').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()") as? JSON {
                        config.rect = CGRect(x: region["x"] as? Double ?? 0, y: region["y"] as? Double ?? 0, width: region["width"] as? Double ?? document.webView.bounds.width, height: region["height"] as? Double ?? document.webView.bounds.height)
                    }
                    let image = try await document.webView.takeSnapshot(configuration: config)
                    guard let png = pngData(image) else { throw NativeError("The current view could not be captured") }
                    let html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Lettrine document view</title><style>html,body{margin:0}img{display:block;max-width:100%;height:auto;margin:auto}</style></head><body><img alt=\"Lettrine document view\" src=\"data:image/png;base64,\(png.base64EncodedString())\"></body></html>"
                    try Data(html.utf8).write(to: destination, options: .atomic); reply(["ok": true, "path": path, "canceled": false], nil)
                } catch { reply(nil, error.localizedDescription) }
            }; return
        }
        app.files.queue.async {
            do {
                if channel == "export.pandoc" { try self.pandoc(p, destination: destination) }
                else { try Data((p[channel == "export.html" ? "html" : "text"] as? String ?? "").utf8).write(to: destination, options: .atomic) }
                DispatchQueue.main.async { reply(["ok": true, "path": path, "warnings": []], nil) }
            } catch { DispatchQueue.main.async { reply(nil, error.localizedDescription) } }
        }
    }
    func pandoc(_ p: JSON, destination: URL) throws {
        let format = p["to"] as? String ?? "docx"
        guard ["docx", "epub", "rtf", "odt", "latex", "docbook", "rst", "mediawiki", "textile", "opml"].contains(format) else { throw NativeError("Unsupported export format") }
        let candidates = [p["pandocPath"] as? String, ProcessInfo.processInfo.environment["PANDOC"], "/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc", "/usr/bin/pandoc"].compactMap { $0 }.filter { !$0.isEmpty }
        guard let program = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw NativeError("Install Pandoc or choose its executable in Preferences to export this format.") }
        let process = Process(), input = Pipe(), errors = Pipe()
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".lettrine-\(UUID().uuidString).\(destination.pathExtension)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let scripts = (p["settings"] as? JSON)?["subscriptSuperscript"] as? Bool == true
        let reader = "markdown-smart" + (scripts ? "+subscript+superscript" : "-subscript-superscript") + "+tex_math_dollars+footnotes"
        process.executableURL = fileURL(program); process.arguments = ["--from=" + reader, "--to=" + format, "--standalone", "--output", temporary.path]
        if scripts { process.arguments?.append(contentsOf: ["--lua-filter", app.webRoot.appendingPathComponent("src/renderer/pandoc-inline.lua").path]) }
        process.arguments?.append(contentsOf: ["--lua-filter", app.webRoot.appendingPathComponent("src/renderer/pandoc-images.lua").path])
        process.currentDirectoryURL = (p["docPath"] as? String).map { fileURL($0).deletingLastPathComponent() }
        process.standardInput = input; process.standardOutput = FileHandle.nullDevice; process.standardError = errors
        try process.run(); input.fileHandleForWriting.write(Data((p["text"] as? String ?? "").utf8)); try? input.fileHandleForWriting.close()
        let diagnostic = errors.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        if process.terminationStatus != 0 { throw NativeError(String(data: diagnostic, encoding: .utf8) ?? "Pandoc export failed") }
        try Data(contentsOf: temporary).write(to: destination, options: .atomic)
    }
}

final class PrintJob: NSObject, WKNavigationDelegate {
    unowned let exports: NativeExports
    let payload: JSON, destination: URL
    let webView: WKWebView
    let window: NSWindow
    let reply: (Any?, String?) -> Void
    private var complete = false
    private var printOperation: NSPrintOperation?
    init(exports: NativeExports, payload: JSON, destination: URL, reply: @escaping (Any?, String?) -> Void) {
        self.exports = exports; self.payload = payload; self.destination = destination; self.reply = reply
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.setURLSchemeHandler(exports.app.resources, forURLScheme: "lettrine")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 980, height: 1000), configuration: config)
        // WebKit's AppKit print view needs a window-backed layout context.
        window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 980, height: 1000), styleMask: .borderless, backing: .buffered, defer: false)
        super.init(); webView.navigationDelegate = self
        window.isReleasedWhenClosed = false; window.alphaValue = 0; window.ignoresMouseEvents = true
        window.contentView = webView; window.orderFront(nil)
    }
    func start() {
        webView.loadHTMLString(payload["html"] as? String ?? "", baseURL: URL(string: "lettrine://app/"))
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
            guard let self = self, self.printOperation == nil else { return }; self.finish(nil, "PDF rendering timed out")
        }
    }
    func finish(_ result: Any?, _ error: String?) {
        if complete { return }; complete = true; window.orderOut(nil); window.close(); reply(result, error); exports.jobs.removeAll { $0 === self }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(nil, error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(nil, error.localizedDescription) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                _ = try await webView.callAsyncJavaScript("await Promise.all([document.fonts.ready,window.__lettrineExportReady||Promise.resolve(),...Array.from(document.images).map(image=>image.complete?Promise.resolve():new Promise(resolve=>{image.onload=resolve;image.onerror=resolve}))]);return true", arguments: [:], in: nil, contentWorld: .page)
                let info = NSPrintInfo.shared.copy() as! NSPrintInfo
                let sizes = ["A4": NSSize(width: 595.276, height: 841.89), "A3": NSSize(width: 841.89, height: 1190.55), "A5": NSSize(width: 419.528, height: 595.276), "Letter": NSSize(width: 612, height: 792), "Legal": NSSize(width: 612, height: 1008), "Tabloid": NSSize(width: 792, height: 1224)]
                info.paperSize = sizes[payload["pageSize"] as? String ?? "A4"] ?? sizes["A4"]!
                info.topMargin = (payload["marginTop"] as? Double ?? 0.75) * 72; info.bottomMargin = (payload["marginBottom"] as? Double ?? 0.75) * 72
                info.leftMargin = (payload["marginLeft"] as? Double ?? 0.75) * 72; info.rightMargin = (payload["marginRight"] as? Double ?? 0.75) * 72
                info.horizontalPagination = .fit; info.verticalPagination = .automatic; info.isHorizontallyCentered = false; info.isVerticallyCentered = false
                info.jobDisposition = .save; info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = destination
                let operation = webView.printOperation(with: info); operation.showsPrintPanel = false; operation.showsProgressPanel = false
                // WebKit computes pagination asynchronously on the main run
                // loop; AppKit's printing thread waits for those page rects.
                operation.canSpawnSeparateThread = true
                printOperation = operation
                operation.runModal(for: window, delegate: self, didRun: #selector(printDidRun(_:success:contextInfo:)), contextInfo: nil)
            } catch { finish(nil, error.localizedDescription) }
        }
    }
    @objc func printDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        // AppKit may call this delegate on its printing thread.
        DispatchQueue.main.async { self.completePrint(success) }
    }
    private func completePrint(_ success: Bool) {
        printOperation = nil
        do {
            guard success, let pdf = PDFDocument(url: destination) else { throw NativeError("The PDF could not be printed") }
                pdf.documentAttributes = [PDFDocumentAttribute.titleAttribute: payload["title"] as? String ?? destination.deletingPathExtension().lastPathComponent, PDFDocumentAttribute.authorAttribute: payload["author"] as? String ?? "", PDFDocumentAttribute.creatorAttribute: "Lettrine", PDFDocumentAttribute.subjectAttribute: "Markdown document"]
                if payload["displayHeaderFooter"] as? Bool != false {
                    for i in 0..<pdf.pageCount {
                        guard let page = pdf.page(at: i) else { continue }
                        let bounds = page.bounds(for: .mediaBox)
                        for (text, top) in [(payload["pdfHeader"] as? String ?? "", true), (payload["pdfFooter"] as? String ?? "Page ${pageNo} of ${totalPages}", false)] {
                            if text.isEmpty { continue }
                            let label = text.replacingOccurrences(of: "${pageNo}", with: String(i + 1)).replacingOccurrences(of: "${totalPages}", with: String(pdf.pageCount))
                            let annotation = PDFAnnotation(bounds: CGRect(x: 24, y: top ? bounds.height - 25 : 12, width: bounds.width - 48, height: 13), forType: .freeText, withProperties: nil)
                            annotation.contents = label; annotation.font = .systemFont(ofSize: 8); annotation.fontColor = .gray; annotation.alignment = .center
                            let border = PDFBorder(); border.lineWidth = 0; annotation.border = border; annotation.color = .clear; annotation.shouldPrint = true; page.addAnnotation(annotation)
                        }
                    }
                }
                guard pdf.write(to: destination) else { throw NativeError("The PDF could not be saved") }
                finish(["ok": true, "path": destination.path], nil)
        } catch { finish(nil, error.localizedDescription) }
    }
}
