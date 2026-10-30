import AppKit

extension NativeApplicationDelegate {
    func detectLocale(_ language: String) -> String {
        let available = localeNames(), normalized = language.replacingOccurrences(of: "_", with: "-")
        if available[normalized] != nil { return normalized }
        if normalized.hasPrefix("zh") { return normalized.contains("Hant") || normalized.contains("TW") || normalized.contains("HK") ? "zh-Hant" : "zh-Hans" }
        if normalized.hasPrefix("en") { return "en" }
        return available.keys.sorted().first { $0.hasPrefix(normalized.components(separatedBy: "-")[0] + "-") } ?? "en"
    }
    func localeNames() -> [String: String] { (readJSON(webRoot.appendingPathComponent("native-config.json")) as? JSON)?["locales"] as? [String: String] ?? ["en": "English"] }
    // A locale is a flat map from English interface text to its translation
    // (src/locales); text without a translation shows as written.
    func loadLocale() { strings = readJSON(webRoot.appendingPathComponent("src/locales/\(locale).json")) as? JSON ?? [:] }
    func translate(_ key: String) -> String { strings[key] as? String ?? key }
    func buildMenu() {
        shortcutItems = []
        let main = NSMenu()
        let configuration = readJSON(webRoot.appendingPathComponent("native-config.json")) as? JSON ?? [:]
        let defaults = configuration["shortcuts"] as? [String: String] ?? [:]
        let overrides = settings["shortcuts"] as? [String: String] ?? [:]
        func separator() -> NSMenuItem { .separator() }
        var currentMenu = ""
        // `assignable` items appear in the shortcut editor.
        func entry(_ title: String, _ command: String, _ standardKey: String = "", payload: JSON = [:], assignable: Bool = true) -> NSMenuItem {
            let standard = defaults[command] ?? standardKey, accelerator = assignable ? overrides[command] ?? standard : standard
            let binding = parseAccelerator(accelerator)
            let item = NSMenuItem(title: translate(title), action: #selector(executeMenu(_:)), keyEquivalent: binding.0)
            item.keyEquivalentModifierMask = binding.1; item.target = self
            item.representedObject = ["command": command, "payload": payload]
            item.identifier = NSUserInterfaceItemIdentifier("command." + command)
            if assignable && !shortcutItems.contains(where: { $0["command"] as? String == command }) {
                shortcutItems.append(["command": command, "label": item.title, "default": standard, "accelerator": accelerator, "id": "command." + command, "menu": currentMenu])
            }
            return item
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let root = NSMenuItem(title: translate(title), action: nil, keyEquivalent: "")
            let menu = NSMenu(title: root.title); menu.autoenablesItems = false
            items.forEach { menu.addItem($0) }; root.submenu = menu; return root
        }
        func system(_ title: String, _ action: Selector, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = NSApp) -> NSMenuItem {
            let item = NSMenuItem(title: translate(title), action: action, keyEquivalent: key); item.keyEquivalentModifierMask = modifiers; item.target = target; return item
        }
        currentMenu = "Lettrine"
        let updates = entry("Check for Updates…", "app.checkUpdates")
        let capabilities = maintenance.capabilities()
        updates.isEnabled = capabilities["updates"] as? Bool == true || !(capabilities["releasesURL"] as? String ?? "").isEmpty
        let services = NSMenuItem(title: translate("Services"), action: nil, keyEquivalent: ""); services.submenu = NSMenu(); NSApp.servicesMenu = services.submenu
        main.addItem(submenu("Lettrine", [entry("About Lettrine", "help.about"), updates, separator(), entry("Settings…", "file.preferences"), separator(), services, separator(),
            system("Hide Lettrine", #selector(NSApplication.hide(_:)), "h"), system("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]), system("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            separator(), system("Quit Lettrine", #selector(NSApplication.terminate(_:)), "q")]))
        currentMenu = "File"
        let recentItems = files.recent("recent-files").prefix(12).map { path in entry(fileURL(path).lastPathComponent, "native.openRecent", payload: ["path": path], assignable: false) }
        let exportItems = [
            entry("HTML", "file.export.html"), entry("HTML (without Styles)", "file.export.html", payload: ["style": false], assignable: false),
            entry("Current View as HTML…", "file.export.screenshotHTML"), entry("PDF", "file.export.pdf"), entry("Image…", "file.export.image"), separator(),
            entry("Markdown", "file.export.md"), entry("Word (.docx)", "file.export.docx"), entry("OpenDocument (.odt)", "file.export.odt"),
            entry("Rich Text (.rtf)", "file.export.rtf"), entry("EPUB (.epub)", "file.export.epub"), entry("LaTeX", "file.export.latex"),
            entry("MediaWiki", "file.export.mediawiki"), entry("reStructuredText", "file.export.rst"), entry("Textile", "file.export.textile"), entry("OPML", "file.export.opml"),
            separator(), entry("Export with Previous Settings", "file.export.previous"),
        ]
        main.addItem(submenu("File", [entry("New", "file.new"), entry("New Tab", "window.newTab"), entry("New Window", "file.newWindow", "CmdOrCtrl+Shift+N"), separator(),
            entry("Open…", "file.open", "CmdOrCtrl+O"), entry("Import…", "file.import"), entry("Open Folder…", "library.openFolder"), entry("Open Quickly…", "file.openQuickly"), submenu("Open Recent", recentItems + [separator(), entry("Clear Menu", "file.clearRecents")]), entry("Reopen Closed File", "file.reopenClosed"), entry("Open in New Window", "native.openInNewWindow"), separator(),
            entry("Close", "native.close", "CmdOrCtrl+W"), entry("Save", "file.save"), entry("Save As…", "file.saveAs"), entry("Save All", "file.saveAll"), entry("Revert to Saved", "file.revert"), entry("Document History…", "file.snapshots"), separator(),
            entry("New File in Folder", "library.newFile"), entry("New Folder…", "library.newFolder"), entry("Duplicate", "library.duplicate"), separator(),
            submenu("Export", exportItems), entry("Print…", "native.print", "CmdOrCtrl+P"), entry("Page Setup…", "native.pageSetup", "CmdOrCtrl+Shift+P")]))
        currentMenu = "Edit"
        let find = [entry("Find…", "edit.find"), entry("Find and Replace…", "edit.replace"), entry("Find Next", "edit.findNext", "CmdOrCtrl+G"), entry("Find Previous", "edit.findPrev", "CmdOrCtrl+Shift+G"), separator(), entry("Find in Folder…", "edit.findInFiles", "CmdOrCtrl+Shift+F")]
        let copySpecial = [entry("Copy as MathML", "edit.copyMathML"), entry("Copy as TeX", "edit.copyTeX"), entry("Copy Code Content", "edit.copyCode"), entry("Copy Table", "edit.copyTable"), separator(), entry("Copy without Theme Styling", "edit.copyCleanHTML")]
        let deleteRange = [entry("Delete Paragraph / Block", "edit.deleteBlock"), entry("Delete Word", "edit.deleteWord", "CmdOrCtrl+Shift+D"), entry("Delete Line", "edit.deleteLine"), entry("Delete Sentence", "edit.deleteSentence")]
        main.addItem(submenu("Edit", [entry("Undo", "edit.undo", "CmdOrCtrl+Z"), entry("Redo", "edit.redo", "CmdOrCtrl+Shift+Z"), entry("Undo File Operation", "file.undo"), entry("Redo File Operation", "file.redo"), separator(),
            entry("Cut", "edit.cut", "CmdOrCtrl+X"), entry("Copy", "edit.copy", "CmdOrCtrl+C"), entry("Copy as Markdown", "edit.copyMarkdown"), entry("Copy as HTML Code", "edit.copyHTML"), entry("Copy as Image…", "edit.copyImage"), submenu("Copy Special", copySpecial), entry("Paste", "edit.paste", "CmdOrCtrl+V"), entry("Paste as Plain Text", "edit.pastePlain", "CmdOrCtrl+Shift+V"), separator(),
            entry("Select All", "edit.selectAll", "CmdOrCtrl+A"), entry("Select Paragraph / Block", "edit.selectBlock"), entry("Select Word", "edit.selectWord"), entry("Select Line", "edit.selectLine", "CmdOrCtrl+L"), entry("Select Sentence", "edit.selectSentence"), entry("Select Styled Scope", "edit.selectScope"), submenu("Delete Range", deleteRange), separator(),
            entry("Jump to Line Start", "edit.lineStart"), entry("Jump to Line End", "edit.lineEnd"), entry("Jump to Top", "edit.jumpTop", "CmdOrCtrl+Up"), entry("Jump to Selection", "edit.jumpSelection", "CmdOrCtrl+J"), entry("Jump to Bottom", "edit.jumpBottom", "CmdOrCtrl+Down"), separator(),
            submenu("Find", find), submenu("Spelling", [entry("Check Spelling While Typing", "edit.spellcheck")])]))
        currentMenu = "Format"
        var paragraphs = [entry("Paragraph", "paragraph.p", "CmdOrCtrl+0")]
        for i in 1...6 { paragraphs.append(entry("Heading \(i)", "paragraph.h\(i)")) }
        let alerts = ["Note", "Tip", "Important", "Warning", "Caution"].map { entry($0, "paragraph.alert." + $0.lowercased()) }
        paragraphs.append(submenu("Alert", alerts))
        paragraphs.append(entry("Table of Contents", "paragraph.toc"))
        paragraphs += [separator(), entry("Increase Heading Level", "paragraph.up", "CmdOrCtrl+="), entry("Decrease Heading Level", "paragraph.down", "CmdOrCtrl+-"), separator(), entry("Quote", "paragraph.quote", "CmdOrCtrl+Alt+Q"), entry("Code Fences", "paragraph.codeFences", "CmdOrCtrl+Alt+C"), entry("Math Block", "paragraph.mathBlock", "CmdOrCtrl+Alt+B"), entry("Unordered List", "paragraph.unorderedList", "CmdOrCtrl+Alt+U"), entry("Ordered List", "paragraph.orderedList", "CmdOrCtrl+Alt+O"), entry("Task List", "paragraph.task"), entry("Table…", "paragraph.table", "CmdOrCtrl+Alt+T"), entry("Horizontal Line", "paragraph.hr"), separator(), entry("Indent", "paragraph.indent", "CmdOrCtrl+]"), entry("Outdent", "paragraph.outdent", "CmdOrCtrl+[")]
        let inline = [entry("Strong", "inline.strong"), entry("Emphasis", "inline.emphasis"), entry("Underline", "inline.underline"), entry("Strike", "inline.strike", "CmdOrCtrl+Shift+X"), entry("Subscript", "inline.subscript"), entry("Superscript", "inline.superscript"), entry("Code", "inline.code"), entry("Highlight", "inline.highlight"), entry("Link…", "inline.link"), entry("Image…", "inline.image"), entry("Math", "inline.math"), separator(), entry("Clear Formatting", "inline.clear")]
        let tables = [entry("Add Row Above", "paragraph.addRowAbove"), entry("Add Row Below", "paragraph.addRow"), entry("Move Row Up", "paragraph.moveRowUp"), entry("Move Row Down", "paragraph.moveRowDown"), entry("Delete Row", "edit.deleteRow")]
        let images = [entry("Use Markdown Image Syntax", "images.markdown"), entry("Use HTML Image Syntax", "images.html"), separator(),
            entry("Copy All Document Images To…", "images.copyDocument"), entry("Move All Document Images To…", "images.moveDocument"),
            entry("Copy All Folder Images To…", "images.copyFolder"), entry("Move All Folder Images To…", "images.moveFolder")]
        let code = [entry("Prettify Source Code", "code.prettify"), entry("Auto Indent Whole Code", "code.indentWhole"), entry("Auto Indent Selected Code", "code.indentSelected")]
        let endings = [entry("Preserve Existing Line Endings", "format.preserveLineEndings"), entry("Unix Line Endings (LF)", "format.lf"), entry("Windows Line Endings (CRLF)", "format.crlf")]
        main.addItem(submenu("Format", [submenu("Paragraph", paragraphs), submenu("Inline Styles", inline), submenu("Table", tables), submenu("Images", images), submenu("Code Tools", code), submenu("Line Endings", endings)]))
        currentMenu = "View"
        func theme(_ name: String, _ title: String) -> NSMenuItem {
            let item = entry(title, "native.theme", payload: ["name": name], assignable: false); item.identifier = NSUserInterfaceItemIdentifier("theme." + name); return item
        }
        let themes = [theme("lettrine", "Lettrine"), theme("lettrine-dark", "Lettrine Dark")]
        let appearance = [("Match System", "system"), ("Light", "light"), ("Dark", "dark")].map { title, value -> NSMenuItem in
            let item = entry(title, "native.background", payload: ["background": value], assignable: false); item.identifier = NSUserInterfaceItemIdentifier("background." + value); return item
        }
        let pin = entry("Always on Top", "view.pin"); pin.identifier = NSUserInterfaceItemIdentifier("window-pin"); pin.state = active?.window.level == .floating ? .on : .off
        // The sidebar shows the files, as a tree or a list, or the outline.
        main.addItem(submenu("View", [entry("Hide Sidebar", "view.toggleSidebar", "CmdOrCtrl+Ctrl+S"), separator(),
            entry("View as Tree", "view.tree"), entry("View as List", "view.files"), entry("Outline", "view.outline", "CmdOrCtrl+Ctrl+O"), separator(),
            entry("Show Document Toolbar", "view.toolbar"), separator(),
            entry("Source Code Mode", "view.source"), entry("Readonly Mode", "view.readonly"), entry("Focus Mode", "view.focus"), entry("Typewriter Mode", "view.typewriter"), separator(),
            entry("Document Zoom", "view.zoomPopover"), entry("Zoom In", "view.zoomIn", "CmdOrCtrl+Shift+="), entry("Zoom Out", "view.zoomOut", "CmdOrCtrl+Shift+-"), entry("Actual Size", "view.actualSize"), separator(),
            submenu("Theme", themes + [separator()] + appearance), pin, separator(), entry("Read Aloud", "view.speak"), entry("Stop Speaking", "view.stopSpeaking"), separator(),
            entry("Enter Full Screen", "native.fullScreen", "CmdOrCtrl+Ctrl+F"), entry("Web Inspector", "native.inspector", "CmdOrCtrl+Alt+I")]))
        currentMenu = "Window"
        let window = submenu("Window", [entry("Minimize", "native.minimize", "CmdOrCtrl+M"), system("Zoom", #selector(NSWindow.performZoom(_:)), target: nil), separator(), entry("Switch Between Opened Documents", "view.switchDocs"), separator(), system("Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "", [])])
        main.addItem(window); NSApp.windowsMenu = window.submenu
        currentMenu = "Help"
        main.addItem(submenu("Help", [entry("Welcome Guide", "help.welcome"), entry("Markdown Reference", "help.markdownReference"), entry("Keyboard Shortcuts", "help.shortcuts"), separator(), entry("License", "help.license")]))
        NSApp.mainMenu = main
        applyViewState()
    }
    // Checkmarks and show/hide titles follow the key document's view state.
    func applyViewState() {
        guard let menu = NSApp.mainMenu else { return }
        let state = active?.viewState ?? [:]
        let theme = state["theme"] as? String ?? settings["theme"] as? String ?? "lettrine", background = settings["background"] as? String ?? "system"
        func visit(_ menu: NSMenu) {
            for item in menu.items {
                if let child = item.submenu { visit(child) }
                switch item.identifier?.rawValue ?? "" {
                case "command.file.saveAll": item.isEnabled = !savingAll && documents.contains { $0.dirty && $0.viewState["readonly"] as? Bool != true }
                case "command.view.toggleSidebar": item.title = translate(state["sidebar"] as? Bool == false ? "Show Sidebar" : "Hide Sidebar")
                case "command.view.outline": item.state = state["outline"] as? Bool == true ? .on : .off
                case "command.view.toolbar": item.title = translate(state["toolbar"] as? Bool == true ? "Hide Document Toolbar" : "Show Document Toolbar"); item.state = state["toolbar"] as? Bool == true ? .on : .off
                case "command.view.zoomPopover": item.state = state["zoomPopover"] as? Bool == true ? .on : .off
                case "command.view.zoomIn": item.isEnabled = (state["zoomFactor"] as? Double ?? 1) < 3
                case "command.view.zoomOut": item.isEnabled = (state["zoomFactor"] as? Double ?? 1) > 0.5
                case "command.view.tree", "command.view.files":
                    let files = state["sidebar"] as? Bool != false && state["sidebarView"] as? String != "outline"
                    let list = item.identifier?.rawValue == "command.view.files"
                    item.state = files && (state["fileView"] as? String == "list") == list ? .on : .off
                case "command.view.source": item.state = state["source"] as? Bool == true ? .on : .off
                case "command.view.readonly": item.state = state["readonly"] as? Bool == true ? .on : .off
                case "command.view.focus": item.state = state["focus"] as? Bool == true ? .on : .off
                case "command.view.typewriter": item.state = state["typewriter"] as? Bool == true ? .on : .off
                case "command.format.preserveLineEndings": item.state = (state["lineEndings"] as? String ?? "").isEmpty ? .on : .off
                case "command.format.lf": item.state = state["lineEndings"] as? String == "LF" ? .on : .off
                case "command.format.crlf": item.state = state["lineEndings"] as? String == "CRLF" ? .on : .off
                case "command.native.fullScreen": item.title = translate(active?.window.styleMask.contains(.fullScreen) == true ? "Exit Full Screen" : "Enter Full Screen")
                case let id where id.hasPrefix("theme."): item.state = id == "theme." + theme ? .on : .off
                case let id where id.hasPrefix("background."): item.state = id == "background." + background ? .on : .off
                default: break
                }
            }
        }
        visit(menu)
    }
    @objc func executeMenu(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? JSON, let command = value["command"] as? String else { return }
        let p = value["payload"] as? JSON ?? [:]
        if let window = NSApp.keyWindow, !(window is EditorWindow) || window.attachedSheet != nil {
            if let action = ["edit.cut": "cut:", "edit.copy": "copy:", "edit.paste": "paste:", "edit.pastePlain": "pasteAsPlainText:", "edit.selectAll": "selectAll:", "edit.undo": "undo:", "edit.redo": "redo:"][command] {
                NSApp.sendAction(Selector(action), to: (window.attachedSheet ?? window).firstResponder, from: sender)
            }
            return
        }
        switch command {
        case "window.newTab": _ = newDocument(tab: active)
        case "file.newWindow": _ = newDocument()
        case "file.saveAll": Task { @MainActor in _ = await saveAll() }
        case "native.close": active?.closeDocument()
        case "edit.paste", "edit.pastePlain": active?.command(command, ["clipboard": clipboardContents()])
        case "native.openRecent": if let path = p["path"] as? String { active?.open(path) }
        case "native.openInNewWindow": if let path = active?.path { _ = newDocument(file: path) }
        case "native.fullScreen": active?.window.toggleFullScreen(nil)
        case "native.minimize": active?.window.miniaturize(nil)
        case "native.theme":
            // The dark theme becomes the dark theme and switches to Dark; the light one to Light.
            if let document = active, let name = p["name"] as? String { handle("setting.put", ["key": "__patch", "value": name == "lettrine-dark" ? ["darkTheme": name, "background": "dark"] : ["theme": name, "background": "light"]], document: document) { _, _ in } }
        case "native.background":
            if let document = active, let value = p["background"] as? String { handle("setting.put", ["key": "__patch", "value": ["background": value]], document: document) { _, _ in } }
        case "native.inspector": if let document = active { handle("window.toggleDevTools", [:], document: document) { _, _ in } }
        case "native.print": if let document = active { let operation = document.webView.printOperation(with: .shared); operation.canSpawnSeparateThread = true; operation.showsPrintPanel = true; operation.runModal(for: document.window, delegate: nil, didRun: nil, contextInfo: nil) }
        case "native.pageSetup": NSPageLayout().runModal()
        default: active?.command(command, p)
        }
    }
}

func parseAccelerator(_ value: String) -> (String, NSEvent.ModifierFlags) {
    if value.isEmpty { return ("", []) }
    var parts = value.components(separatedBy: "+"), flags: NSEvent.ModifierFlags = []
    let raw = parts.removeLast()
    for part in parts {
        switch part.lowercased() {
        case "cmd", "command", "cmdorctrl", "super": flags.insert(.command)
        case "ctrl", "control": flags.insert(.control)
        case "alt", "option": flags.insert(.option)
        case "shift": flags.insert(.shift)
        default: break
        }
    }
    var special: [String: UInt32] = ["up": 0xf700, "down": 0xf701, "left": 0xf702, "right": 0xf703]
    for n in 1...20 { special["f\(n)"] = 0xf703 + UInt32(n) }
    let key = special[raw.lowercased()].flatMap(UnicodeScalar.init).map(String.init) ?? (raw.lowercased() == "plus" ? "+" : raw.lowercased())
    return (key, flags)
}
