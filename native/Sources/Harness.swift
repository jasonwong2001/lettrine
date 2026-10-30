import AppKit
import WebKit

// Development-only, explicitly opted in with --lettrine-harness. Scenarios use
// isolated profiles and the real WKWebView, native text responder and events.
@MainActor final class NativeHarness {
    unowned let app: NativeApplicationDelegate
    let scenario: URL, output: URL
    var results: [JSON] = []
    var selectedDocument: NativeDocument? {
        get { app.harnessDocument }
        set { app.harnessDocument = newValue }
    }
    private let originalPointer = CGEvent(source: nil)?.location
    private let originalClipboard: [NSPasteboardItem] = (NSPasteboard.general.pasteboardItems ?? []).map { item in
        let saved = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { saved.setData(data, forType: type) } }
        return saved
    }
    private let originalClipboardVersion = NSPasteboard.general.changeCount
    init(app: NativeApplicationDelegate, scenario: URL, output: URL) {
        self.app = app; self.scenario = scenario; self.output = output
        app.externalActions = NativeExternalActions(output: output, allowExternalApps: CommandLine.arguments.contains("--lettrine-allow-external-apps"))
        selectedDocument = app.sessions.restoredActiveDocument ?? app.active
    }
    func sleep(_ ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1000000) }
    func restoreDesktop() {
        if let point = originalPointer { CGWarpMouseCursorPosition(point) }
        if NSPasteboard.general.changeCount != originalClipboardVersion {
            NSPasteboard.general.clearContents()
            if !originalClipboard.isEmpty { NSPasteboard.general.writeObjects(originalClipboard) }
        }
    }
    func document() throws -> NativeDocument { guard let document = app.active else { throw NativeError("No active document") }; return document }
    func waitReady(_ document: NativeDocument) async throws {
        for _ in 0..<400 {
            if document.ready { return }
            await sleep(50)
        }
        throw NativeError("The native document did not finish opening: " + document.name)
    }
    func wait(_ expression: String, timeout: Int = 10000) async throws {
        let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
        while true {
            let value = try await document().evaluate(expression)
            if value as? Bool == true { return }
            if Date() >= deadline { throw NativeError("Timed out waiting for " + expression) }
            await sleep(30)
        }
    }
    func focus(_ document: NativeDocument) {
        selectedDocument = document
        NSApp.activate(ignoringOtherApps: true); document.window.makeKeyAndOrderFront(nil)
        // Keep the renderer's chosen text field as first responder.
        if document.window.firstResponder === document.window { document.window.makeFirstResponder(document.webView) }
    }
    func type(_ text: String, document: NativeDocument) async {
        focus(document)
        // DOM focus and NSTextInputClient selection travel across WebKit's
        // process boundary. Let that focus transaction settle before input.
        await sleep(50)
        // A multiline insert in the compatibility scenarios represents one
        // paste/input-method commit, including a formula closer and its tail.
        // Sending separate Enter keys has different, intentional semantics.
        if text.contains("\n"), let input = document.window.firstResponder as? NSTextInputClient {
            input.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0)); await sleep(20); return
        }
        for character in text {
            let value = String(character)
            if value == "\n" { key("Enter", document: document) }
            else if let input = document.window.firstResponder as? NSTextInputClient { input.insertText(value, replacementRange: NSRange(location: NSNotFound, length: 0)) }
            else if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: document.window.windowNumber, context: nil, characters: value, charactersIgnoringModifiers: value, isARepeat: false, keyCode: 0) { document.webView.keyDown(with: event) }
            await sleep(12)
        }
    }
    func key(_ chord: String, document: NativeDocument) {
        focus(document)
        var parts = chord.components(separatedBy: "+"), flags: NSEvent.ModifierFlags = []
        let key = parts.removeLast()
        for part in parts { switch part.lowercased() { case "meta", "cmd", "super": flags.insert(.command); case "shift": flags.insert(.shift); case "alt", "option": flags.insert(.option); case "control", "ctrl": flags.insert(.control); default: break } }
        let known: [String: (UInt16, String)] = ["Enter": (36, "\r"), "Backspace": (51, "\u{7f}"), "Delete": (117, "\u{f728}"), "Tab": (48, "\t"), "Escape": (53, "\u{1b}"), "ArrowLeft": (123, "\u{f702}"), "ArrowRight": (124, "\u{f703}"), "ArrowDown": (125, "\u{f701}"), "ArrowUp": (126, "\u{f700}"), "Home": (115, "\u{f729}"), "End": (119, "\u{f72b}"), "F8": (100, "\u{f70b}")]
        let asciiCodes: [String: UInt16] = ["a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46]
        let pair = known[key] ?? (asciiCodes[key.lowercased()] ?? 0, key)
        let characters = key.count == 1 ? (flags.contains(.shift) ? pair.1.uppercased() : pair.1.lowercased()) : pair.1
        if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: document.window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: pair.0) {
            var handled = false
            // Programmatically constructed NSEvents do not carry AppKit's
            // hardware keyboard-layout state. Dispatch a matching visible
            // menu item before WebKit can consume its synthetic event, using
            // target/action. Unbound keys still reach the real text responder.
            if flags.contains(.command) && !document.recordingShortcut, let menu = NSApp.mainMenu {
                func equivalent(_ menu: NSMenu) -> Bool {
                    for (index, item) in menu.items.enumerated() {
                        if let child = item.submenu, equivalent(child) { return true }
                        if !item.keyEquivalent.isEmpty && item.isEnabled && !item.isHidden && item.keyEquivalent.lowercased() == characters.lowercased() && item.keyEquivalentModifierMask == flags {
                            menu.performActionForItem(at: index); return true
                        }
                    }
                    return false
                }
                handled = equivalent(menu)
            }
            if !handled && flags.contains(.command) { handled = document.window.performKeyEquivalent(with: event) }
            if !handled { NSApp.sendEvent(event) }
        }
        if let event = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: document.window.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: pair.0) { NSApp.sendEvent(event) }
    }
    func compose(_ specification: JSON, document: NativeDocument) async throws {
        focus(document)
        await sleep(50)
        guard let input = document.window.firstResponder as? NSTextInputClient else { throw NativeError("The focused view does not accept marked text") }
        for text in specification["marked"] as? [String] ?? [] {
            input.setMarkedText(text, selectedRange: NSRange(location: (text as NSString).length, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
            await sleep(80)
        }
        input.insertText(specification["text"] as? String ?? "", replacementRange: NSRange(location: NSNotFound, length: 0))
        await sleep(300)
    }
    func pointer(_ selector: String, click: Bool, document: NativeDocument) async throws {
        focus(document)
        let quoted = String(jsonString([selector]).dropFirst().dropLast())
        let value = try await document.evaluate("(()=>{const el=document.querySelector(\(quoted));if(!el)throw Error('Missing pointer target');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden pointer target');return {x:r.left+r.width/2,y:r.top+r.height/2}})()") as? JSON ?? [:]
        let x = value["x"] as? Double ?? 0, y = value["y"] as? Double ?? 0
        let local = NSPoint(x: x, y: document.webView.isFlipped ? y : document.webView.bounds.height - y), location = document.webView.convert(local, to: nil)
        let screen = document.window.convertPoint(toScreen: location)
        CGWarpMouseCursorPosition(CGPoint(x: screen.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - screen.y))
        await sleep(30)
        let types: [NSEvent.EventType] = click ? [.mouseMoved, .leftMouseDown, .leftMouseUp] : [.mouseMoved]
        for type in types {
            if let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: document.window.windowNumber, context: nil, eventNumber: 0, clickCount: click ? 1 : 0, pressure: 1) {
                NSApp.sendEvent(event)
            }
        }
    }
    func capture(_ name: String, document: NativeDocument) async throws -> JSON {
        focus(document); await sleep(180)
        let image = try await document.webView.takeSnapshot(configuration: nil)
        guard let data = pngData(image) else { throw NativeError("Could not capture WebKit") }
        let file = output.appendingPathComponent(name + ".png"); try data.write(to: file)
        return ["op": "capture", "file": file.path, "bytes": data.count]
    }
    func run() async {
        do {
            let trace = CommandLine.arguments.contains("--lettrine-trace")
            if trace { app.log("Harness: waiting for renderer") }
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            try app.externalActions.writeReport()
            try await wait("window.__lettrine?._booted===true", timeout: 20000)
            for _ in 0..<400 {
                if app.documents.allSatisfy(\.ready) { break }
                await sleep(50)
            }
            guard app.documents.allSatisfy(\.ready) else { throw NativeError("The native documents did not finish opening") }
            let specification = try JSONSerialization.jsonObject(with: Data(contentsOf: scenario))
            let steps = specification as? [JSON] ?? (specification as? JSON)?["steps"] as? [JSON] ?? []
            for (i, step) in steps.enumerated() {
                do {
                    if trace { app.log("Harness step \(i) [active=\(NSApp.isActive), keyWindow=\(NSApp.keyWindow?.windowNumber ?? 0)]: " + step.keys.sorted().joined(separator: ", ")) }
                    let document = try document()
                    try await waitReady(document)
                    var result: JSON = ["step": i, "ok": true]
                    if let ms = step["sleep"] as? Int { await sleep(ms) }
                    else if let expression = step["waitFor"] as? String {
                        do { try await wait(expression, timeout: step["timeout"] as? Int ?? 10000) }
                        catch { let diagnostic = (step["diagnostic"] as? String).flatMap { $0 }; let detail = diagnostic == nil ? NSNull() : (try? await document.evaluate(diagnostic!)) ?? NSNull(); throw NativeError(error.localizedDescription + ": " + jsonString([detail])) }
                    }
                    else if step["focusWindow"] != nil { focus(document); await sleep(80) }
                    else if let expression = step["eval"] as? String { result["op"] = "eval"; result["expr"] = expression; result["value"] = try await document.evaluate(expression) }
                    else if let command = step["cmd"] as? String { document.command(command, step["payload"] as? JSON ?? [:]); await sleep(step["wait"] as? Int ?? 200) }
                    else if let file = step["open"] as? String {
                        let quoted = String(jsonString([file]).dropFirst().dropLast())
                        _ = try await document.evaluate("window.__lettrine.openFile(\(quoted),\(step["line"] as? Int ?? 0))"); await sleep(step["wait"] as? Int ?? 100)
                    }
                    else if let text = step["type"] as? String { await type(text, document: document); await sleep(step["wait"] as? Int ?? 120) }
                    else if let specification = step["compose"] as? JSON { try await compose(specification, document: document) }
                    else if let chord = step["key"] as? String { key(chord, document: document); await sleep(step["wait"] as? Int ?? 120) }
                    else if let selector = step["click"] as? String ?? step["hover"] as? String { try await pointer(selector, click: step["click"] != nil, document: document); await sleep(step["wait"] as? Int ?? 120) }
                    else if let name = step["capture"] as? String ?? step["captureWindow"] as? String { result.merge(try await capture(name, document: document)) { _, new in new } }
                    else if let choice = step["saveDialog"] as? JSON {
                        // Native panels can run a nested modal event loop.
                        // Respond in both the ordinary and modal run-loop modes.
                        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                            let deadline = Date().addingTimeInterval(10)
                            var prepared = false
                            let timer = Timer(timeInterval: 0.2, repeats: true) { timer in
                                guard Date() < deadline else { timer.invalidate(); continuation.resume(throwing: NativeError("No native save panel is open")); return }
                                guard let panel = document.window.attachedSheet as? NSSavePanel else { return }
                                if !prepared {
                                    if let ending = choice["lineEndings"] as? String {
                                        guard let popup = panel.accessoryView?.subviews.compactMap({ $0 as? NSPopUpButton }).first, let index = ["", "LF", "CRLF"].firstIndex(of: ending) else { timer.invalidate(); continuation.resume(throwing: NativeError("No line-ending choice in the save panel")); return }
                                        popup.selectItem(at: index)
                                    }
                                    if let path = choice["path"] as? String, panel.url?.standardizedFileURL != fileURL(path) {
                                        timer.invalidate(); continuation.resume(throwing: NativeError("The native save panel has an unexpected destination")); return
                                    }
                                    prepared = true; return
                                }
                                timer.invalidate()
                                // NSSavePanel.ok(_:) is unimplemented on recent
                                // macOS. End the real sheet through AppKit.
                                document.window.endSheet(panel, returnCode: choice["cancel"] as? Bool == true ? .cancel : .OK)
                                panel.orderOut(nil)
                                continuation.resume()
                            }
                            RunLoop.main.add(timer, forMode: .common)
                            RunLoop.main.add(timer, forMode: .modalPanel)
                            RunLoop.main.add(timer, forMode: .eventTracking)
                            document.command(step["command"] as? String ?? "file.saveAs")
                        }
                    }
                    else if step["save"] != nil { let saved = await document.requestSave(); if !saved { throw NativeError("Renderer did not acknowledge a successful save") }; result["op"] = "save" }
                    else if let assertion = step["assert"] as? JSON, let expression = assertion["expr"] as? String {
                        let value = try await document.evaluate(expression), expected = assertion["eq"] ?? true
                        let ok = jsonString([value]) == jsonString([expected]); result["op"] = "assert"; result["name"] = assertion["name"] ?? expression; result["value"] = value; result["ok"] = ok
                        results.append(result); if !ok { throw NativeError("Assertion failed: \(assertion["name"] ?? expression) — \(jsonString([value]))") }; continue
                    }
                    else if let assertion = step["assertMenu"] as? JSON {
                        let id = assertion["id"] as? String ?? "", property = assertion["property"] as? String ?? ""
                        let command = id.replacingOccurrences(of: "command.", with: ""), item = app.shortcutItems.first { $0["command"] as? String == command }
                        let value: Any = property == "checked" ? document.window.level == .floating : item?[property] ?? NSNull()
                        let ok = jsonString([value]) == jsonString([assertion["eq"] ?? true]); result["op"] = "assert"; result["name"] = assertion["name"] ?? id; result["value"] = value; result["ok"] = ok
                        results.append(result); if !ok { throw NativeError("Native menu assertion failed: " + id) }; continue
                    }
                    else if let assertion = step["assertDocuments"] as? JSON {
                        let expected = assertion["paths"] as? [Any] ?? []
                        let deadline = Date().addingTimeInterval(3)
                        var paths: [Any] = []
                        repeat {
                            paths = app.documents.map { $0.path as Any? ?? NSNull() }
                            if jsonString(paths) == jsonString(expected) { break }
                            await sleep(30)
                        } while Date() < deadline
                        result["op"] = "assert"; result["name"] = assertion["name"] ?? "Open documents"; result["value"] = paths
                        result["ok"] = jsonString(paths) == jsonString(expected)
                        results.append(result)
                        if result["ok"] as? Bool != true { throw NativeError("Unexpected open documents: " + jsonString(paths)) }
                        continue
                    }
                    else if step["tab"] as? String == "new" { let next = app.newDocument(tab: document); selectedDocument = next; try await waitReady(next); await sleep(100) }
                    else if step["tab"] as? String == "close" {
                        let index = app.documents.firstIndex { $0 === document } ?? 0
                        document.forceClose = true; document.window.close()
                        selectedDocument = app.documents.isEmpty ? nil : app.documents[max(0, min(index - 1, app.documents.count - 1))]
                        await sleep(200)
                    }
                    else if step["window"] as? String == "new" { let next = app.newDocument(); selectedDocument = next; try await waitReady(next); await sleep(100) }
                    else if let direction = step["switch"] as? Int { app.switchDocument(direction); await sleep(150) }
                    else if step["closeLastWindow"] as? Bool == true {
                        guard app.documents.count == 1 else { throw NativeError("Expected exactly one window before quitting") }
                        results.append(result); try writeJSON(results, to: output.appendingPathComponent("report.json")); restoreDesktop()
                        document.forceClose = true; document.window.close()
                        await sleep(2000)
                        throw NativeError("The application did not quit after its last window closed")
                    }
                    else if step["quit"] as? Bool == true {
                        if trace { app.log("Quit readiness: " + jsonString(app.documents.map { ["name": $0.name, "ready": $0.ready] })) }
                        results.append(result); try writeJSON(results, to: output.appendingPathComponent("report.json")); restoreDesktop()
                        // AppKit waits synchronously for terminateLater. Start
                        // it from a run-loop callback so this Swift task yields.
                        Timer.scheduledTimer(withTimeInterval: 0.01, repeats: false) { _ in NSApp.terminate(nil) }
                        await sleep(3000)
                        throw NativeError("The application did not finish quitting")
                    }
                    else if let drop = step["dropFiles"] as? JSON, let paths = drop["paths"] as? [String] {
                        for path in paths { app.resources.authorize(fileURL(path).deletingLastPathComponent()) }
                        let x = drop["x"] as? Double ?? 400, y = drop["y"] as? Double ?? 400
                        _ = try await document.evaluate("window.__lettrineNativeDrop(\(jsonString(paths)),\(x),\(y))"); await sleep(200)
                    }
                    else { throw NativeError("Unknown harness step") }
                    results.append(result)
                } catch {
                    results.append(["step": i, "ok": false, "error": error.localizedDescription]); app.log(error.localizedDescription)
                    if step["stopOnFail"] as? Bool != false { break }
                }
            }
            try writeJSON(results, to: output.appendingPathComponent("report.json"))
            let failed = results.contains { $0["ok"] as? Bool == false }
            app.log("WKWebView harness: \(results.count) results → \(output.path)")
            restoreDesktop(); exit(failed ? 1 : 0)
        } catch {
            app.log("WKWebView harness failed: " + error.localizedDescription)
            results.append(["ok": false, "error": error.localizedDescription]); try? writeJSON(results, to: output.appendingPathComponent("report.json")); restoreDesktop(); exit(1)
        }
    }
}
