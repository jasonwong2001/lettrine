import AppKit
import WebKit
import PDFKit
import UniformTypeIdentifiers

final class EditorWindow: NSWindow {
    weak var document: NativeDocument?
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if attachedSheet != nil { return super.performKeyEquivalent(with: event) }
        if document?.recordingShortcut == true { firstResponder?.keyDown(with: event); return true }
        // Keep document history shortcuts authoritative when WebKit's native
        // text responder or a CodeMirror textarea has focus.
        if NSApp.mainMenu?.performKeyEquivalent(with: event) == true { return true }
        return super.performKeyEquivalent(with: event)
    }
}

final class EditorWebView: WKWebView {
    weak var document: NativeDocument?
    // The renderer draws the title bar. It reports the empty parts of its bars
    // (in CSS pixels, top-left origin) so they move the window like a native
    // title bar, while the buttons inside them stay clickable.
    var dragRegions: [NSRect] = [], interactiveRegions: [NSRect] = []
    private func cssPoint(_ event: NSEvent) -> NSPoint {
        let local = convert(event.locationInWindow, from: nil), zoom = max(pageZoom, 0.01)
        return NSPoint(x: local.x / zoom, y: (isFlipped ? local.y : bounds.height - local.y) / zoom)
    }
    override func mouseDown(with event: NSEvent) {
        let point = cssPoint(event)
        guard dragRegions.contains(where: { $0.contains(point) }), !interactiveRegions.contains(where: { $0.contains(point) }), let window = window else { super.mouseDown(with: event); return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.miniaturize(nil)
            case "None": break
            default: window.zoom(nil)
            }
        } else { window.performDrag(with: event) }
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) { return .copy }
        return super.draggingEntered(sender)
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let files = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !files.isEmpty else { return super.performDragOperation(sender) }
        for file in files { document?.app.resources.authorize(file.deletingLastPathComponent()) }
        let point = convert(sender.draggingLocation, from: nil)
        let y = isFlipped ? point.y : bounds.height - point.y
        evaluateJavaScript("window.__lettrineNativeDrop?.(\(jsonString(files.map(\.path))),\(point.x),\(y))", completionHandler: nil)
        return true
    }
}

final class NativeDocument: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    unowned let app: NativeApplicationDelegate
    let id = UUID().uuidString
    let window: EditorWindow
    let webView: EditorWebView
    var path: String?, name = "Untitled", dirty = false, askToClose = true, ready = false, recordingShortcut = false
    var pendingFile: String?, pendingSession: JSON?, closing = false, forceClose = false, finishingStartup = false
    var viewState: JSON = [:]
    private var layoutObservation: NSKeyValueObservation?
    private var saves: [String: CheckedContinuation<Bool, Never>] = [:]
    init(app: NativeApplicationDelegate, file: String? = nil, restoredState: JSON? = nil, initial: Bool = false) {
        self.app = app; pendingFile = file; pendingSession = restoredState
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(app.resources, forURLScheme: "lettrine")
        configuration.websiteDataStore = .nonPersistent()
        let controller = WKUserContentController()
        let launch: JSON = ["managed": file != nil || restoredState != nil, "initial": initial]
        controller.addUserScript(WKUserScript(source: "window.__lettrineLaunch=\(jsonString(launch))", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let bridge = (try? String(contentsOf: app.webRoot.appendingPathComponent("src/renderer/native-bridge.js"), encoding: .utf8)) ?? ""
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        configuration.userContentController = controller
        webView = EditorWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 800), configuration: configuration)
        window = EditorWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        controller.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        webView.document = self; window.document = self
        // The web content extends under a transparent title bar and draws the
        // bar itself. An empty unified toolbar gives the bar its standard height,
        // so AppKit keeps the window buttons centered in it in every state
        // (title and edited changes, tabs, full screen); clicks still reach the
        // web view, which reports its own drag regions.
        window.minSize = NSSize(width: 640, height: 440); window.titlebarAppearsTransparent = true; window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        let toolbar = NSToolbar(identifier: "io.github.jasonwong2001.lettrine.document"); toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = false
        window.toolbar = toolbar; window.toolbarStyle = .unified
        // Until the renderer has painted its theme, show the last theme's
        // window color instead of WebKit's default white page.
        app.applyCachedAppearance(to: window); webView.alphaValue = 0
        window.acceptsMouseMovedEvents = true
        window.isReleasedWhenClosed = false; window.tabbingIdentifier = "io.github.jasonwong2001.lettrine.documents"; window.delegate = self
        window.contentView = webView; window.center()
        if !CommandLine.arguments.contains(where: { $0.hasPrefix("--user-data-dir=") }) { window.setFrameAutosaveName("lettrine-editor") }
        // A native tab bar or full screen changes the unobscured area.
        layoutObservation = window.observe(\.contentLayoutRect, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.reportWindowChrome() } }
        webView.navigationDelegate = self; webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.load(URLRequest(url: URL(string: "lettrine://app/src/renderer/index.html")!))
        updateTitle()
    }
    func updateTitle() {
        let showDirty = dirty && viewState["readonly"] as? Bool != true
        window.title = (showDirty ? "● " : "") + name + " — Lettrine"
        window.isDocumentEdited = showDirty; window.representedURL = path.map(fileURL)
        window.subtitle = ""; window.tab.title = name
    }
    func send(_ channel: String, _ payload: Any) {
        let script = "window.__lettrineNativeEvent?.(\(jsonString([channel]).dropFirst().dropLast()),\(jsonString(payload)))"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
    func command(_ name: String, _ payload: JSON = [:]) {
        window.makeKeyAndOrderFront(nil)
        send("menu.command", ["name": name, "payload": payload])
    }
    func evaluate(_ expression: String) async throws -> Any {
        let code = "const value = await (0,eval)(source); return JSON.stringify(value === undefined ? null : value);"
        let result = try await webView.callAsyncJavaScript(code, arguments: ["source": expression], in: nil, contentWorld: .page)
        guard let text = result as? String, let data = text.data(using: .utf8) else { return NSNull() }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
    func open(_ file: String, line: Int? = nil) {
        app.resources.authorize(fileURL(file).deletingLastPathComponent())
        if ready { send("doc.openRequest", ["path": file, "line": line as Any? ?? NSNull()]) }
        else { pendingFile = file }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in await finishStartup() }
    }
    @MainActor func finishStartup() async {
        guard !ready, !finishingStartup else { return }
        finishingStartup = true
        defer { finishingStartup = false }
        do {
            // Module scripts on a custom scheme can finish after WebKit's
            // navigation callback. Wait for the bootstrap promise itself.
            for _ in 0..<400 {
                if (try await evaluate("!!window.__lettrine?.ready")) as? Bool == true { break }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            _ = try await evaluate("(async()=>{await window.__lettrine.ready;return true})()")
            if let state = pendingSession {
                let restored = try await app.sessions.prepareRestore(state)
                _ = try await evaluate("window.__lettrine.restoreSession(\(jsonString(restored)))"); pendingSession = nil
            }
            while let file = pendingFile {
                pendingFile = nil
                _ = try await evaluate("window.__lettrine.openFile(\(jsonString([file]).dropFirst().dropLast()))")
            }
            ready = true
            reportWindowChrome()
            NSAnimationContext.runAnimationGroup({ context in context.duration = 0.12; webView.animator().alphaValue = 1 }, completionHandler: nil)
            window.makeFirstResponder(webView)
            app.sessions.changed()
        } catch {
            if pendingSession != nil { app.sessions.recoveryFailed = true }
            webView.alphaValue = 1
            app.log("Renderer startup: " + String(describing: (error as NSError).userInfo))
            let diagnostic = try? await evaluate("({bridge:typeof window.bridge,app:typeof window.__lettrine,url:location.href,scripts:[...document.scripts].map(s=>s.src),errors:window.__lettrineStartupErrors})")
            app.log(jsonString([diagnostic ?? NSNull()]))
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { app.log("Navigation: " + error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        app.log("WebKit content process terminated for " + name)
        // Never silently reload an unsaved document and discard its model.
        let alert = NSAlert(); alert.messageText = "The document view stopped responding"; alert.informativeText = "Reopen the document to load its saved version. Unsaved text could not be recovered from the stopped view."; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "lettrine", url.host == "app", url.path == "/src/renderer/index.html" { decisionHandler(.allow); return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated, ["https", "http", "mailto"].contains(url.scheme ?? "") { app.externalActions.open(url) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel"); alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.host == "app", let body = message.body as? JSON, let channel = body["channel"] as? String else { replyHandler(nil, "Untrusted bridge origin"); return }
        let payload = body["payload"] as? JSON ?? [:]
        app.handle(channel, payload, document: self, reply: replyHandler)
    }
    func requestSave() async -> Bool {
        let request = UUID().uuidString
        return await withCheckedContinuation { continuation in
            saves[request] = continuation; send("doc.saveRequest", ["id": request])
            DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in self?.saves.removeValue(forKey: request)?.resume(returning: false) }
        }
    }
    func completeSave(_ p: JSON) { if let request = p["id"] as? String { saves.removeValue(forKey: request)?.resume(returning: p["ok"] as? Bool == true) } }
    func confirmClose() async -> Bool {
        if !dirty || !askToClose { return true }
        let alert = NSAlert(); alert.messageText = "“\(name)” has unsaved changes."; alert.informativeText = "Save before closing?"
        alert.addButton(withTitle: "Save"); alert.addButton(withTitle: "Don't Save"); alert.addButton(withTitle: "Cancel")
        let response: NSApplication.ModalResponse = await withCheckedContinuation { continuation in alert.beginSheetModal(for: window) { continuation.resume(returning: $0) } }
        if response == .alertSecondButtonReturn { return true }
        return response == .alertFirstButtonReturn ? await requestSave() : false
    }
    func closeDocument() {
        if closing { return }; closing = true
        Task { @MainActor in
            if await confirmClose() { forceClose = true; _ = try? await evaluate("window.__lettrineSuppressUnload=true"); window.close() }
            closing = false
        }
    }
    // Tell the renderer where AppKit placed the window buttons and how much of
    // the top is covered by the bar and a native tab bar, so the web bars line
    // up with the buttons on every macOS version.
    func reportWindowChrome() {
        guard ready else { return }
        let fullscreen = window.styleMask.contains(.fullScreen)
        var state: JSON = ["fullscreen": fullscreen]
        if !fullscreen, let close = window.standardWindowButton(.closeButton), let minimize = window.standardWindowButton(.miniaturizeButton), let zoom = window.standardWindowButton(.zoomButton) {
            let height = window.frame.height, top = height - window.contentLayoutRect.maxY
            let closeFrame = close.convert(close.bounds, to: nil), minimizeFrame = minimize.convert(minimize.bounds, to: nil), zoomFrame = zoom.convert(zoom.bounds, to: nil)
            let bar = ((height - closeFrame.midY) * 2).rounded()
            state["bar"] = bar
            state["tabBar"] = max(0, (top - bar).rounded())
            state["buttonsEnd"] = (zoomFrame.maxX + max(0, minimizeFrame.minX - closeFrame.maxX)).rounded()
        }
        send("window.state", state)
    }
    func windowDidEnterFullScreen(_ notification: Notification) { reportWindowChrome() }
    func windowDidExitFullScreen(_ notification: Notification) { reportWindowChrome() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { if forceClose { return true }; closeDocument(); return false }
    func windowWillClose(_ notification: Notification) {
        layoutObservation?.invalidate()
        if let path = path { app.rememberClosed(path) }
        for continuation in saves.values { continuation.resume(returning: false) }; saves.removeAll()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "native", contentWorld: .page)
        let index = app.documents.firstIndex { $0 === self } ?? 0
        app.documents.removeAll { $0 === self }
        if app.harnessDocument === self {
            app.harnessDocument = app.documents.isEmpty ? nil : app.documents[max(0, min(index - 1, app.documents.count - 1))]
        }
        app.sessions.changed()
        app.files.queue.async { _ = try? self.app.files.handle("native.closed", [:], tab: self.id) }
        // The remaining tabs may lose their tab bar.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [app] in for document in app.documents { document.reportWindowChrome() } }
    }
    func windowDidBecomeKey(_ notification: Notification) { app.buildMenu(); reportWindowChrome(); window.makeFirstResponder(webView); app.sessions.changed() }
    func windowDidMove(_ notification: Notification) { app.sessions.changed() }
    func windowDidResize(_ notification: Notification) { app.sessions.changed() }
    func windowDidResignKey(_ notification: Notification) {
        guard ready, dirty, path != nil, !closing, saves.isEmpty, window.attachedSheet == nil, app.settings["saveOnSwitch"] as? Bool == true, viewState["readonly"] as? Bool != true else { return }
        Task { @MainActor in _ = await requestSave() }
    }
}

final class NativeApplicationDelegate: NSObject, NSApplicationDelegate {
    let webRoot: URL
    let resources: Resources
    let files: FileService
    var documents: [NativeDocument] = [], closedFiles: [String] = []
    var settings: JSON
    var locale = "en", strings: JSON = [:]
    var shortcutItems: [JSON] = []
    var speech: NSSpeechSynthesizer?
    var harness: NativeHarness?
    var harnessDocument: NativeDocument?
    var externalActions = NativeExternalActions()
    var savingAll = false
    lazy var exports = NativeExports(app: self)
    lazy var imports = NativeImports(app: self)
    lazy var sessions = NativeSessions(app: self)
    lazy var maintenance = NativeMaintenance(app: self)
    var active: NativeDocument? {
        if harness != nil, let selected = harnessDocument, documents.contains(where: { $0 === selected }) { return selected }
        return documents.first { $0.window === NSApp.keyWindow } ?? documents.first { $0.window.isVisible } ?? documents.first
    }
    init(webRoot: URL, userData: URL) {
        self.webRoot = webRoot; resources = Resources(root: webRoot); files = FileService(directory: userData, resources: webRoot); settings = files.settings
        super.init()
        resources.authorize(userData.appendingPathComponent("themes"))
        files.authorize = { [weak self] url in self?.resources.authorize(url) }
        files.emit = { [weak self] tab, channel, payload in DispatchQueue.main.async { self?.receive(tab, channel, payload) } }
        // A saved language that no longer ships gives way to the system's.
        let saved = settings["locale"] as? String
        locale = saved.flatMap { localeNames()[$0] == nil ? nil : $0 } ?? detectLocale(Locale.preferredLanguages.first ?? "en")
        loadLocale()
    }
    func log(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
        buildMenu(); files.startMonitoring()
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("AppleInterfaceThemeChangedNotification"), object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { guard let self = self else { return }; for document in self.documents { document.send("window.state", ["systemDark": self.systemIsDark()]) } }
        }
        let args = CommandLine.arguments
        let requested = args.dropFirst().first { !$0.hasPrefix("-") && documentExtensions.contains(fileURL($0).pathExtension.lowercased()) }
        if !sessions.restore() { _ = newDocument(file: requested, initial: true) }
        else if let requested = requested { sessions.restoredActiveDocument = newDocument(file: requested) }
        NSApp.activate(ignoringOtherApps: true)
        if let i = args.firstIndex(of: "--lettrine-harness"), i + 1 < args.count {
            let output = args.firstIndex(of: "--lettrine-out").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "/tmp/lettrine-native-harness"
            harness = NativeHarness(app: self, scenario: fileURL(args[i + 1]), output: fileURL(output))
            Task { @MainActor in await harness?.run() }
        }
        maintenance.start()
    }
    func newDocument(file: String? = nil, tab: NativeDocument? = nil, restoredState: JSON? = nil, initial: Bool = false) -> NativeDocument {
        let document = NativeDocument(app: self, file: file, restoredState: restoredState, initial: initial); documents.append(document)
        if harness != nil { harnessDocument = document }
        document.window.tabbingMode = .disallowed
        if let tab = tab { tab.window.addTabbedWindow(document.window, ordered: .above); DispatchQueue.main.async { tab.reportWindowChrome() } }
        document.window.makeKeyAndOrderFront(nil); sessions.changed(); return document
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { if !flag { _ = newDocument() }; return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { settings["quitAfterLastWindow"] as? Bool == true }
    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        // AppKit can deliver positional harness paths as open-file events.
        // Harness scenarios open their documents explicitly through the bridge.
        if CommandLine.arguments.contains("--lettrine-harness") { return true }
        if let active = active { active.open(filename) } else { _ = newDocument(file: filename) }; return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { @MainActor in
            if sessions.enabled {
                do { try await sessions.prepareToQuit() }
                catch {
                    sessions.terminating = false; sessions.changed()
                    let alert = NSAlert(); alert.messageText = translate("The session could not be saved."); alert.informativeText = translate(error.localizedDescription); alert.addButton(withTitle: translate("OK")); alert.runModal()
                    sender.reply(toApplicationShouldTerminate: false); return
                }
                sender.reply(toApplicationShouldTerminate: true); return
            }
            for document in documents where document.dirty { if !(await document.confirmClose()) { sender.reply(toApplicationShouldTerminate: false); return } }
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    func rememberClosed(_ path: String) { closedFiles.removeAll { $0 == path }; closedFiles.insert(path, at: 0); closedFiles = Array(closedFiles.prefix(20)) }
    func receive(_ tab: String?, _ channel: String, _ payload: Any) {
        if channel == "setting.changed", let value = payload as? JSON {
            let wasEnabled = sessions.enabled
            settings = value; sessions.settingsChanged(wasEnabled: wasEnabled); maintenance.settingsChanged(); buildMenu()
        }
        for document in documents where tab == nil || document.id == tab {
            if channel == "doc.pathChanged", let value = payload as? JSON {
                if let removed = value["removed"] as? String, let path = document.path, under(path, removed) {
                    document.path = nil
                    document.send("doc.removed", ["path": path])
                    document.closeDocument()
                    continue
                }
                document.path = value["path"] as? String
                if let path = document.path { document.name = fileURL(path).lastPathComponent } else { document.dirty = true }
                document.updateTitle()
            }
            document.send(channel, payload)
        }
    }
    func performFile(_ channel: String, _ p: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        files.queue.async {
            do { let result = try self.files.handle(channel, p, tab: document.id); DispatchQueue.main.async { reply(result, nil) } }
            catch { DispatchQueue.main.async { reply(nil, self.translate(error.localizedDescription)) } }
        }
    }
    func choose(_ p: JSON, document: NativeDocument, directory: Bool = false, image: Bool = false, save: Bool = false, reply: @escaping (Any?, String?) -> Void) {
        let panel: NSSavePanel = save ? NSSavePanel() : NSOpenPanel()
        panel.title = p["title"] as? String ?? (save ? "Save document as" : directory ? "Open folder" : "Open document")
        if let path = p["defaultPath"] as? String { let file = fileURL(path); panel.directoryURL = file.deletingLastPathComponent(); panel.nameFieldStringValue = file.lastPathComponent }
        else if let name = p["defaultName"] as? String { panel.nameFieldStringValue = name }
        if let open = panel as? NSOpenPanel { open.canChooseDirectories = directory; open.canChooseFiles = !directory; open.allowsMultipleSelection = false }
        panel.canCreateDirectories = true
        let lineEndings = save && p["lineEndings"] != nil ? NSPopUpButton(frame: NSRect(x: 110, y: 0, width: 245, height: 28), pullsDown: false) : nil
        if let lineEndings = lineEndings {
            let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 355, height: 32))
            let label = NSTextField(labelWithString: translate("Line Endings")); label.frame = NSRect(x: 0, y: 6, width: 105, height: 20)
            lineEndings.addItems(withTitles: ["Preserve Existing Line Endings", "Unix Line Endings (LF)", "Windows Line Endings (CRLF)"].map(translate))
            lineEndings.selectItem(at: ["", "LF", "CRLF"].firstIndex(of: p["lineEndings"] as? String ?? "") ?? 0)
            lineEndings.setAccessibilityLabel(translate("Line Endings"))
            accessory.addSubview(label); accessory.addSubview(lineEndings); panel.accessoryView = accessory
        }
        if image { panel.allowedContentTypes = ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"].compactMap { UTType(filenameExtension: $0) } }
        else if let filters = p["filters"] as? [JSON], let extensions = filters.first?["extensions"] as? [String] { panel.allowedContentTypes = extensions.compactMap { UTType(filenameExtension: $0) } }
        panel.beginSheetModal(for: document.window) { response in
            guard response == .OK, let selected = panel.url else { reply(["canceled": true], nil); return }
            let url = fileURL(selected.path)
            self.resources.authorize(directory ? url : url.deletingLastPathComponent())
            if directory { self.files.queue.async { _ = try? self.files.handle("native.recentFolder", ["path": url.path], tab: document.id) } }
            var result: JSON = ["canceled": false, "path": url.path]
            if let lineEndings = lineEndings { result["lineEndings"] = ["", "LF", "CRLF"][lineEndings.indexOfSelectedItem] }
            reply(result, nil)
        }
    }
    func handle(_ channel: String, _ p: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        if document.viewState["readonly"] as? Bool == true,
           ["doc.write", "doc.import", "library.newFile", "library.newFolder", "library.renameFile", "library.trashItem", "library.duplicate", "path.moveTo", "path.copyTo", "path.removeFiles", "fileOperation.history", "images.save", "images.import", "images.manage"].contains(channel) {
            reply(nil, translate("Readonly mode is on. Turn it off to edit.")); return
        }
        switch channel {
        case "native.log": log(p["message"] as? String ?? "WebKit error"); reply(["ok": true], nil)
        case "tab.state":
            document.name = p["name"] as? String ?? document.name; document.path = p["path"] as? String
            document.dirty = p["dirty"] as? Bool == true; document.askToClose = p["askToCloseUnsaved"] as? Bool != false; document.updateTitle(); applyViewState(); sessions.changed(); reply(["ok": true], nil)
        case "tab.getState": reply(["name": document.name, "path": document.path as Any? ?? NSNull(), "dirty": document.dirty], nil)
        case "doc.saveResult": document.completeSave(p); reply(["ok": true], nil)
        case "doc.ready":
            reply(["ok": true], nil)
            Task { @MainActor in await document.finishStartup() }
        case "session.changed": sessions.changed(); reply(["ok": true], nil)
        case "session.checkpoint":
            Task { @MainActor in
                do { try await sessions.store(); reply(["ok": true], nil) }
                catch { reply(nil, translate(error.localizedDescription)) }
            }
        case "app.saveAll": Task { @MainActor in reply(["ok": await saveAll()], nil) }
        case "search.query":
            files.startSearch(p, tab: document.id) { result in DispatchQueue.main.async { reply(result, nil) } }
        case "search.stop":
            files.searches.cancel(document.id); reply(["ok": true], nil)
        case "library.closeFolder":
            files.searches.cancel(document.id)
            performFile(channel, p, document: document, reply: reply)
        case "app.maintenance": reply(maintenance.capabilities(), nil)
        case "app.checkUpdates":
            Task { @MainActor in
                do { reply(try await maintenance.checkUpdates(), nil) }
                catch { reply(nil, translate(error.localizedDescription)) }
            }
        case "app.reportUsage":
            Task { @MainActor in
                do { reply(try await maintenance.reportUsage(), nil) }
                catch { reply(nil, translate(error.localizedDescription)) }
            }
        case "doc.markOpen":
            if let previous = p["closedPath"] as? String, previous != p["path"] as? String { rememberClosed(previous) }
            performFile(channel, p, document: document, reply: reply)
        case "dialog.openFile": choose(p, document: document, reply: reply)
        case "doc.import": imports.handle(p, document: document, reply: reply)
        case "images.manage": manageImages(p, document: document, reply: reply)
        case "images.open":
            files.queue.async {
                do {
                    let reference = try self.files.required(p, "url"), local = self.files.imagePath(reference, doc: document.path)
                    let file: URL
                    if let local = local { file = local }
                    else {
                        let suggested = URL(string: reference)?.pathExtension.lowercased() ?? ""
                        let ext = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].contains(suggested) ? suggested : reference.hasPrefix("data:image/svg") ? "svg" : reference.hasPrefix("data:image/jpeg") ? "jpg" : "png"
                        file = self.files.directory.appendingPathComponent("image-previews/" + UUID().uuidString + "." + ext)
                        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                        try self.files.imageData(reference, doc: document.path).write(to: file, options: .atomic)
                    }
                    DispatchQueue.main.async { let ok = self.externalActions.open(file); reply(ok ? ["ok": true] : nil, ok ? nil : self.translate("The image could not be opened.")) }
                } catch { DispatchQueue.main.async { reply(nil, self.translate(error.localizedDescription)) } }
            }
        case "dialog.openFolder": choose(p, document: document, directory: true, reply: reply)
        case "dialog.save": choose(p, document: document, save: true, reply: reply)
        case "window.newWindow": _ = newDocument(); reply(["ok": true], nil)
        case "window.newTab": _ = newDocument(file: p["path"] as? String, tab: document); reply(["ok": true], nil)
        case "window.openInNewWindow": _ = newDocument(file: p["path"] as? String ?? document.path); reply(["ok": true], nil)
        case "window.closeTab": document.closeDocument(); reply(["ok": true], nil)
        case "window.toggleFullscreen": document.window.toggleFullScreen(nil); reply(["ok": true], nil)
        case "window.zoom":
            files.queue.async {
                do {
                    let saved = self.files.settings["zoomFactor"] as? Double ?? 1
                    let current = saved.isFinite ? max(0.5, min(3, saved)) : 1
                    let delta = p["delta"] as? Double ?? 0
                    let requested = p["factor"] as? Double ?? (delta == 0 ? 1 : current + delta * 0.1)
                    guard requested.isFinite else { throw NativeError("Invalid zoom level") }
                    let factor = p["query"] as? Bool == true ? current : (max(0.5, min(3, requested)) * 100).rounded() / 100
                    if p["query"] as? Bool != true { _ = try self.files.patchSettings(["zoomFactor": factor]) }
                    DispatchQueue.main.async { reply(["zoomFactor": factor], nil) }
                } catch { DispatchQueue.main.async { reply(nil, self.translate(error.localizedDescription)) } }
            }
        case "window.pin", "window.unpin":
            if p["query"] as? Bool == true { reply(["pinned": document.window.level == .floating], nil); return }
            let enabled = channel == "window.pin" && (p["enabled"] as? Bool ?? (document.window.level != .floating))
            document.window.level = enabled ? .floating : .normal; buildMenu(); reply(["ok": true, "pinned": enabled], nil)
        case "window.switchDocuments":
            switchDocument(p["direction"] as? Int ?? 1); reply(["ok": true], nil)
        case "window.dragRegions":
            let rects = { (key: String) in (p[key] as? [[Double]] ?? []).compactMap { $0.count == 4 ? NSRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil } }
            document.webView.dragRegions = rects("drag"); document.webView.interactiveRegions = rects("interactive")
            reply(["ok": true, "fullscreen": document.window.styleMask.contains(.fullScreen)], nil)
        case "window.appearance":
            // The system appearance is read from the application, which window
            // appearances do not affect, so the renderer cannot feed back on itself.
            if p["query"] as? Bool == true { reply(["systemDark": systemIsDark()], nil); return }
            let dark = p["dark"] as? Bool == true, background = p["background"] as? String ?? ""
            applyAppearance(dark: dark, background: background, to: document.window)
            files.queue.async { try? writeJSON(["dark": dark, "background": background], to: self.files.directory.appendingPathComponent("window-appearance.json")) }
            reply(["ok": true], nil)
        case "menu.popup": popUpMenu(p, document: document, reply: reply)
        case "menu.state":
            document.viewState = p; document.updateTitle(); if document === active { applyViewState() }; reply(["ok": true], nil)
        case "window.reopenClosed":
            while let file = closedFiles.first { closedFiles.removeFirst(); if FileManager.default.fileExists(atPath: file) { _ = newDocument(file: file, tab: document); reply(["path": file], nil); return } }
            reply(["path": NSNull()], nil)
        case "window.toggleDevTools":
            if #available(macOS 13.3, *) { document.webView.isInspectable = true }
            document.send("menu.command", ["name": "app.notify", "payload": ["message": "Use Safari → Develop → Lettrine to open Web Inspector."]]); reply(["ok": true], nil)
        case "menu.shortcuts": reply(shortcutItems, nil)
        case "menu.recording": document.recordingShortcut = p["enabled"] as? Bool == true; reply(["ok": true], nil)
        case "i18n.strings": reply(["locale": locale, "strings": strings], nil)
        case "i18n.locales":
            let names = localeNames(); reply(["locale": locale, "list": names.keys.sorted().map { ["key": $0, "name": names[$0]!] }], nil)
        case "i18n.setLocale":
            guard let value = p["locale"] as? String, localeNames()[value] != nil else { reply(["ok": false], nil); return }
            locale = value; loadLocale(); buildMenu()
            performFile("setting.put", ["key": "locale", "value": value], document: document) { _, error in
                for tab in self.documents { tab.send("i18n.changed", ["locale": value]) }; reply(["ok": error == nil, "locale": value], error)
            }
        case "path.showInFinder": if let path = p["path"] as? String { externalActions.reveal(fileURL(path)) }; reply(["ok": true], nil)
        case "path.openFile", "shell.openExternal":
            let value = p["url"] as? String ?? p["path"] as? String ?? ""
            guard let url = value.contains(":") ? URL(string: value) : fileURL(value) as URL? else { reply(nil, "Invalid URL"); return }
            guard ["http", "https", "mailto", "file", "x-apple.systempreferences"].contains(url.scheme ?? "") else { reply(nil, "Unsupported URL scheme"); return }
            if channel == "path.openFile", p["useSystem"] as? Bool != true, let editor = settings["otherEditor"] as? String, !editor.isEmpty {
                let candidate = editor.hasPrefix("/") ? fileURL(editor) : fileURL("/Applications/" + editor + (editor.hasSuffix(".app") ? "" : ".app"))
                let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: editor) ?? (FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil)
                guard let application = application else { reply(nil, "The configured external editor could not be found"); return }
                externalActions.open(url, with: application, reply: reply)
            } else { externalActions.open(url); reply(["ok": true], nil) }
        case "path.openURL": openLink(p, document: document, reply: reply)
        case let operation where ["path.moveTo", "path.copyTo"].contains(operation) && p["to"] == nil:
            choose(["title": channel == "path.moveTo" ? "Move To" : "Copy To"], document: document, directory: true) { result, error in
                guard let folder = (result as? JSON)?["path"] as? String else { reply(result, error); return }
                var payload = p; payload["from"] = p["from"] ?? p["path"]; payload["to"] = fileURL(folder).appendingPathComponent(fileURL(payload["from"] as? String ?? "").lastPathComponent).path
                self.performFile(channel, payload, document: document, reply: reply)
            }
        case "clipboard.write":
            let pasteboard = NSPasteboard.general; pasteboard.clearContents(); pasteboard.setString(p["text"] as? String ?? "", forType: .string)
            if let html = p["html"] as? String { pasteboard.setString(html, forType: .html) }; reply(["ok": true], nil)
        case "clipboard.readImage":
            guard let image = NSImage(pasteboard: .general), let data = pngData(image) else { reply(["ok": false], nil); return }
            reply(["ok": true, "png": data.base64EncodedString(), "width": image.size.width, "height": image.size.height], nil)
        case "clipboard.readContent":
            reply(clipboardContents(), nil)
        case "clipboard.writeImage":
            exports.copyImage(p, document: document, reply: reply)
        case "clipboard.paste", "clipboard.action":
            if channel == "clipboard.paste", let contents = p["clipboard"] as? JSON, let text = contents["text"] as? String, let input = document.window.firstResponder as? NSTextInputClient {
                input.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0)); reply(["ok": true], nil); return
            }
            let action = channel == "clipboard.action" ? p["action"] as? String ?? "copy" : p["plain"] as? Bool == true ? "pasteAsPlainText" : "paste"
            let allowed = ["paste", "pasteAsPlainText", "copy", "cut", "selectAll"]
            guard allowed.contains(action) else { reply(nil, "Unknown clipboard action"); return }
            let succeeded = NSApp.sendAction(Selector(action + ":"), to: document.window.firstResponder, from: nil); reply(["ok": succeeded], nil)
        case "images.import": importImage(p, document: document, reply: reply)
        case let operation where ["images.saveAs", "image.saveSVG"].contains(operation) && p["destination"] == nil:
            choose(["title": "Save Image As", "defaultPath": p["suggestedName"] ?? "image.svg"], document: document, save: true) { result, error in
                guard let path = (result as? JSON)?["path"] as? String else { reply(result, error); return }; var payload = p; payload["destination"] = path; self.performFile(channel, payload, document: document, reply: reply)
            }
        case "images.copyAll" where p["dir"] == nil:
            choose(["title": "Copy All Images To"], document: document, directory: true) { result, error in
                guard let path = (result as? JSON)?["path"] as? String else { reply(result, error); return }; var payload = p; payload["dir"] = path; self.performFile(channel, payload, document: document, reply: reply)
            }
        case "theme.openFolder": externalActions.open(files.directory.appendingPathComponent("themes")); reply(["ok": true], nil)
        case "setting.getUserDict", "setting.getUserDictionaryPath", "word.updateDictionary", "word.setDictionaryLanguages", "setting.downloadDict", "word.getSpellSuggestionInContext", "word.openDictionarySettings": dictionary(channel, p, reply: reply)
        case "speech.speak":
            speech?.stopSpeaking(); speech = NSSpeechSynthesizer(); let text = p["text"] as? String ?? ""
            let ok = speech?.startSpeaking(text) ?? false; reply(["ok": ok], nil)
        case "speech.stop": speech?.stopSpeaking(); reply(["ok": true], nil)
        case "controller.screenshotHTML" where p["path"] == nil:
            choose(["title": "Export Current View as HTML", "defaultPath": "lettrine-view.html"], document: document, save: true) { result, error in
                guard let path = (result as? JSON)?["path"] as? String else { reply(result, error); return }
                var payload = p; payload["path"] = path; self.exports.handle(channel, payload, document: document, reply: reply)
            }
        case "export.md", "export.html", "export.pdf", "export.image", "export.pandoc", "controller.screenshotHTML": exports.handle(channel, p, document: document, reply: reply)
        case "app.version": reply(["name": "Lettrine", "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development", "platform": "darwin", "runtime": "WKWebView"], nil)
        default: performFile(channel, p, document: document, reply: reply)
        }
    }
    func systemIsDark() -> Bool { NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
    func applyAppearance(dark: Bool, background: String, to window: NSWindow) {
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        if let color = NSColor(cssHex: background) { window.backgroundColor = color }
    }
    func applyCachedAppearance(to window: NSWindow) {
        guard let cached = readJSON(files.directory.appendingPathComponent("window-appearance.json")) as? JSON else { return }
        applyAppearance(dark: cached["dark"] as? Bool == true, background: cached["background"] as? String ?? "", to: window)
    }
    // Context menus are native menus built from the renderer's item list.
    func popUpMenu(_ p: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        let picker = MenuPicker()
        func build(_ items: [JSON], into menu: NSMenu) {
            menu.autoenablesItems = false
            for item in items {
                if item["separator"] as? Bool == true { menu.addItem(.separator()); continue }
                let entry = NSMenuItem(title: item["label"] as? String ?? "", action: #selector(MenuPicker.pick(_:)), keyEquivalent: "")
                entry.target = picker; entry.representedObject = item["id"] as? String
                entry.isEnabled = item["enabled"] as? Bool != false
                entry.state = item["checked"] as? Bool == true ? .on : .off
                if let accelerator = item["shortcut"] as? String { let binding = parseAccelerator(accelerator); entry.keyEquivalent = binding.0; entry.keyEquivalentModifierMask = binding.1 }
                if let children = item["submenu"] as? [JSON] { let submenu = NSMenu(title: entry.title); build(children, into: submenu); entry.submenu = submenu; entry.action = nil }
                if item["destructive"] as? Bool == true { entry.attributedTitle = NSAttributedString(string: entry.title, attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuFont(ofSize: 0)]) }
                menu.addItem(entry)
            }
        }
        let menu = NSMenu(); build(p["items"] as? [JSON] ?? [], into: menu)
        let webView = document.webView, zoom = webView.pageZoom
        let x = (p["x"] as? Double ?? 0) * zoom, y = (p["y"] as? Double ?? 0) * zoom
        let point = NSPoint(x: x, y: webView.isFlipped ? y : webView.bounds.height - y)
        DispatchQueue.main.async {
            menu.popUp(positioning: nil, at: point, in: webView)
            reply(["id": picker.picked as Any? ?? NSNull()], nil)
        }
    }
    func switchDocument(_ direction: Int) {
        guard let current = active, let index = documents.firstIndex(where: { $0 === current }), !documents.isEmpty else { return }
        let next = documents[(index + direction + documents.count) % documents.count]
        if harness != nil { harnessDocument = next }
        next.window.makeKeyAndOrderFront(nil)
    }
    func clipboardContents() -> JSON {
        let pasteboard = NSPasteboard.general
        var contents: JSON = ["text": pasteboard.string(forType: .string) ?? "", "html": pasteboard.string(forType: .html) ?? "", "hasImage": pasteboard.types?.contains(where: { $0 == .png || $0 == .tiff }) == true]
        if contents["hasImage"] as? Bool == true, let image = NSImage(pasteboard: pasteboard), let data = pngData(image) {
            contents["image"] = ["ok": true, "png": data.base64EncodedString(), "width": image.size.width, "height": image.size.height]
        }
        return contents
    }
    func openLink(_ p: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        let value = p["url"] as? String ?? ""
        if let url = URL(string: value), let scheme = url.scheme, ["https", "http", "mailto"].contains(scheme) { externalActions.open(url); reply(["ok": true], nil); return }
        if let scheme = URLComponents(string: value)?.scheme, scheme != "file" { reply(["error": "Unsupported URL scheme"], nil); return }
        let base = (p["docPath"] as? String ?? document.path).map { fileURL($0).deletingLastPathComponent() }
        guard let url = URL(string: value, relativeTo: base)?.absoluteURL else { reply(["error": "Invalid local link"], nil); return }
        if documentExtensions.contains(url.pathExtension.lowercased()) { reply(["path": url.path, "fragment": url.fragment ?? ""], nil) }
        else { externalActions.open(fileURL(url.path)); reply(["ok": true], nil) }
    }
    func dictionary(_ channel: String, _ p: JSON, reply: @escaping (Any?, String?) -> Void) {
        let path = files.directory.appendingPathComponent("user-dictionary.json")
        var saved = readJSON(path) as? JSON ?? [:]
        var words = saved["words"] as? [String] ?? [], ignored = saved["ignored"] as? [String] ?? []
        if channel == "setting.getUserDictionaryPath" { reply(path.path, nil); return }
        if channel == "word.openDictionarySettings" { externalActions.open(URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")!); reply(["ok": true], nil); return }
        let checker = NSSpellChecker.shared
        if channel == "word.getSpellSuggestionInContext" {
            let word = p["word"] as? String ?? "", known = (words + ignored).contains { $0.caseInsensitiveCompare(word) == .orderedSame }
            let range = checker.checkSpelling(of: word, startingAt: 0)
            reply(["word": word, "misspelled": !known && range.location != NSNotFound, "suggestions": known ? [] : checker.guesses(forWordRange: NSRange(location: 0, length: (word as NSString).length), in: word, language: checker.language(), inSpellDocumentWithTag: 0) ?? []], nil); return
        }
        if channel == "word.updateDictionary" {
            if let list = p["words"] as? [String] { for word in words where !list.contains(word) { checker.unlearnWord(word) }; words = list }
            if let list = p["ignored"] as? [String] { ignored = list }
            if let word = p["add"] as? String { words.append(word) }
            if let word = p["ignore"] as? String { ignored.append(word) }
            words = Array(Set(words.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })).sorted()
            ignored = Array(Set(ignored.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })).sorted()
            for word in words + ignored { checker.learnWord(word) }
            saved["words"] = words; saved["ignored"] = ignored
            do { try writeJSON(saved, to: path) } catch { reply(nil, error.localizedDescription); return }
        }
        let state: JSON = ["words": words, "ignored": ignored, "languages": checker.userPreferredLanguages, "available": checker.availableLanguages, "nativeManaged": true, "downloads": [:], "path": path.path]
        if channel == "word.updateDictionary" { for document in documents { document.send("word.dictionaryChanged", state) } }
        reply(state, nil)
    }
}

final class MenuPicker: NSObject {
    var picked: String?
    @objc func pick(_ sender: NSMenuItem) { picked = sender.representedObject as? String }
}

extension NSColor {
    convenience init?(cssHex value: String) {
        var hex = value.trimmingCharacters(in: .whitespaces).lowercased()
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6, let number = UInt32(hex, radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((number >> 16) & 0xff) / 255, green: CGFloat((number >> 8) & 0xff) / 255, blue: CGFloat(number & 0xff) / 255, alpha: 1)
    }
}

func pngData(_ image: NSImage) -> Data? {
    guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
    return bitmap.representation(using: .png, properties: [:])
}
