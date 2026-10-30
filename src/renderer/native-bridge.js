// Injected at document start by the AppKit host: window.bridge, the page's
// asynchronous interface to the native host.
(() => {
  window.__lettrineStartupErrors = [];
  const listeners = new Map();
  const invoke = (channel, payload = {}) => window.webkit.messageHandlers.native.postMessage({ channel, payload: payload || {} });
  const method = (channel) => (payload) => invoke(channel, payload);
  const api = (entries) => Object.fromEntries(Object.entries(entries).map(([key, channel]) => [key, method(channel)]));
  const bridge = {
    runtime: "wkwebview",
    document: api({ read: "doc.read", write: "doc.write", import: "doc.import", markOpen: "doc.markOpen", completeSave: "doc.saveResult", ready: "doc.ready" }),
    window: api({ openFile: "dialog.openFile", openFolder: "dialog.openFolder", save: "dialog.save", newWindow: "window.newWindow", newTab: "window.newTab", openInNewWindow: "window.openInNewWindow", closeTab: "window.closeTab", toggleFullscreen: "window.toggleFullscreen", zoom: "window.zoom", toggleDevTools: "window.toggleDevTools", pin: "window.pin", unpin: "window.unpin", switchDocuments: "window.switchDocuments", reopenClosed: "window.reopenClosed", dragRegions: "window.dragRegions", appearance: "window.appearance" }),
    tab: api({ state: "tab.state", getState: "tab.getState" }),
    search: api({ query: "search.query", stop: "search.stop" }),
    path: {
      ...api({ stat: "path.stat", isDirectory: "path.isDirectory", removeFiles: "path.removeFiles", moveTo: "path.moveTo", copyTo: "path.copyTo", showInFinder: "path.showInFinder", openFile: "path.openFile", openURL: "path.openURL", reference: "path.reference" }),
      forFile: (file) => file.__nativePath || "",
      fileURL: (file) => "lettrine://file" + (file.startsWith("/") ? "" : "/") + file.split("/").map(encodeURIComponent).join("/"),
    },
    library: api({ listDocsUnder: "library.listDocsUnder", closeFolder: "library.closeFolder", newFile: "library.newFile", newFolder: "library.newFolder", renameFile: "library.renameFile", trashItem: "library.trashItem", recentFolders: "library.recentFolders", statFile: "library.statFile", duplicate: "library.duplicate" }),
    fileOperation: { undo: () => invoke("fileOperation.history", { redo: false }), redo: () => invoke("fileOperation.history", { redo: true }), state: method("fileOperation.state") },
    quickOpen: api({ query: "quickOpen.query", cacheRecentFiles: "quickOpen.cacheRecentFiles", recentFiles: "quickOpen.recentFiles" }),
    clipboard: api({ readImage: "clipboard.readImage", readContent: "clipboard.readContent", write: "clipboard.write", paste: "clipboard.paste", action: "clipboard.action" }),
    images: api({ save: "images.save", import: "images.import", manage: "images.manage", open: "images.open", saveSVG: "image.saveSVG", saveAs: "images.saveAs", copyAll: "images.copyAll" }),
    word: api({ getTextReplacement: "word.getTextReplacement", getUserDict: "setting.getUserDict", getUserDictionaryPath: "setting.getUserDictionaryPath", downloadDict: "setting.downloadDict", updateDictionary: "word.updateDictionary", setDictionaryLanguages: "word.setDictionaryLanguages", openDictionarySettings: "word.openDictionarySettings", getSpellSuggestionInContext: "word.getSpellSuggestionInContext" }),
    i18n: api({ strings: "i18n.strings", setLocale: "i18n.setLocale", locales: "i18n.locales" }),
    setting: api({ get: "setting.get", put: "setting.put", getUserDict: "setting.getUserDict", downloadDict: "setting.downloadDict", getUserDictionaryPath: "setting.getUserDictionaryPath" }),
    theme: api({ list: "theme.list", openFolder: "theme.openFolder", resolve: "theme.resolve" }),
    export: {
      md: method("export.md"), screenshotHTML: method("controller.screenshotHTML"),
      html: async (payload) => invoke("export.html", { ...payload, html: await (await import(new URL("native-export.js", document.baseURI).href)).buildNativeExport(payload) }),
      pdf: async (payload) => invoke("export.pdf", { ...payload, html: await (await import(new URL("native-export.js", document.baseURI).href)).buildNativeExport(payload) }),
      image: async (payload) => invoke("export.image", { ...payload, width: (({ narrow: 640, medium: 860, wide: 1100 })[(payload.settings || window.__lettrine?.settings)?.pageWidth] || 860) + 32, html: await (await import(new URL("native-export.js", document.baseURI).href)).buildNativeExport({ ...payload, image: true }) }),
      pandoc: async (payload) => {
        const { typographicMarkdown } = await import(new URL("../core/typography-markdown.js", document.baseURI).href);
        const { equationMarkdown } = await import(new URL("../core/math-markdown.js", document.baseURI).href);
        const settings = payload.settings || window.__lettrine?.settings;
        return invoke("export.pandoc", { ...payload, text: equationMarkdown(typographicMarkdown(payload.text || "", settings), settings) });
      },
    },
    snapshots: api({ list: "snapshots.list", restore: "snapshots.restore" }),
    session: api({ changed: "session.changed", checkpoint: "session.checkpoint" }),
    speech: api({ speak: "speech.speak", stop: "speech.stop" }),
    app: api({ version: "app.version", openExternal: "shell.openExternal", saveAll: "app.saveAll", maintenance: "app.maintenance", checkUpdates: "app.checkUpdates", reportUsage: "app.reportUsage" }),
    menu: api({ shortcuts: "menu.shortcuts", recording: "menu.recording", popup: "menu.popup", state: "menu.state" }),
    shell: api({ openExternal: "shell.openExternal" }),
    native: { invoke },
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
  };
  bridge.clipboard.writeImage = async (payload) => {
    if (payload.region) return invoke("clipboard.writeImage", payload);
    const html = await (await import(new URL("native-export.js", document.baseURI).href)).buildNativeExport({ ...payload, image: true });
    return invoke("clipboard.writeImage", { html, width: payload.width + 32 });
  };
  let pendingClipboardImage;
  const readClipboardImage = bridge.clipboard.readImage;
  bridge.clipboard.readImage = () => {
    const image = pendingClipboardImage; pendingClipboardImage = null;
    return image ? Promise.resolve(image) : readClipboardImage();
  };
  bridge.clipboard.paste = async (options = {}) => {
    const editor = window.__lettrine?.editor, active = document.activeElement;
    if (active?.closest("#write, #app-source") && editor?.guardReadOnly()) return { ok: false };
    const cm = window.__lettrine?._sourceCM || editor?._activeCmBlock()?.cm;
    if (!options.plain && active?.closest("#app-source")) {
      const contents = options.clipboard || await invoke("clipboard.readContent");
      if (contents.hasImage) return window.__lettrine.pasteSourceImage(contents.image);
    }
    if (options.clipboard && cm && active.closest(".CodeMirror")) {
      cm.replaceSelection(options.clipboard.text, "end", "paste"); return { ok: true };
    }
    if (!editor?.root.contains(active) || active.closest(".CodeMirror")) return invoke("clipboard.paste", options);
    const generation = editor._generation, source = editor.getMarkdown(), selection = editor.selectionOffsets();
    // Read original pasteboard HTML before WebKit normalizes spaces and link
    // URLs. CodeMirror and ordinary form fields use their native responder.
    const contents = options.clipboard || await invoke("clipboard.readContent");
    if (editor.readOnly || generation !== editor._generation || source !== editor.getMarkdown() || JSON.stringify(selection) !== JSON.stringify(editor.selectionOffsets())) return { ok: false };
    const data = new DataTransfer(); data.setData("text/plain", contents.text);
    if (!options.plain && contents.html) data.setData("text/html", contents.html);
    if (!options.plain && contents.hasImage) {
      pendingClipboardImage = contents.image;
      data.items.add(new File([], "clipboard.png", { type: "image/png" }));
    }
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    editor.root.dispatchEvent(event);
    return { ok: event.defaultPrevented };
  };
  bridge.filesOp = bridge.fileOperation;
  Object.defineProperty(window, "bridge", { value: bridge });
  window.__lettrineNativeEvent = (event, payload) => {
    for (const listener of listeners.get(event) || []) {
      try { if (event === "menu.command") listener(payload.name, payload.payload || {}); else listener(payload); }
      catch (error) { console.error(error); }
    }
  };
  window.__lettrineNativeDrop = (paths, x, y) => {
    const root = document.getElementById("write"), target = document.elementFromPoint(x, y) || root;
    if (target.closest("#app-sidebar")) return window.__lettrine?.handleSidebarDrop(paths, target);
    if (document.body.classList.contains("sourceview-on")) return window.__lettrine?.handleSourceDrop(paths);
    const data = { files: paths.map((path) => ({ name: path.split("/").pop(), type: "", __nativePath: path })) };
    return window.__lettrine?.editor._handleDrop({ preventDefault() {}, target: root, clientX: x, clientY: y, dataTransfer: data });
  };
  window.addEventListener("error", (event) => { const message = event.message + " " + event.filename + ":" + event.lineno; window.__lettrineStartupErrors.push(message); void invoke("native.log", { message }).catch(() => {}); });
  window.addEventListener("unhandledrejection", (event) => { void invoke("native.log", { message: String(event.reason?.stack || event.reason) }).catch(() => {}); });
})();
