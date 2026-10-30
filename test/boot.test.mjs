// Full renderer bootstrap smoke test against the real index.html structure
// (lettrine-aligned DOM: #write, #app-sidebar, #md-searchpanel,
// #quick-open, ...) with a stubbed native bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
html = html.replace(/<script[^>]*src=[^>]*>/g, "");

const dom = new (await import("jsdom").then((m) => m.JSDOM))(html, {
  url: "http://localhost/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
dom.window.HTMLElement.prototype.scrollIntoView = function () { store.scrolledIntoView = this; };
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.getSelection = () => dom.window.getSelection();

const store = { file: null, writes: [], settings: { theme: "lettrine" } };
const listeners = {};
globalThis.window.bridge = {
  document: {
    read: async (p) => ({
      path: p.path,
      text: /huge/.test(p.path) ? "x".repeat(2100000)
        : /disk/.test(p.path) ? "# Changed on disk\n" : "# Boot test\n\ncontent",
      mtimeMs: 1, size: /huge/.test(p.path) ? 2100000 : 1,
    }),
    write: async (p) => {
      if (store.write) return store.write(p);
      store.file = p.path;
      store.writes.push(p);
      return { ok: true };
    },
    markOpen: async (p) => ({ ok: true }),
  },
  window: {
    openFile: async () => ({ canceled: false, path: "/tmp/a.md" }),
    openFolder: async () => ({ canceled: false, path: "/tmp" }),
    save: async (p) => store.saveDialog ? store.saveDialog(p) : ({ canceled: false, path: "/tmp/saved.md" }),
    newWindow: async () => ({ ok: true }),
    newTab: async () => ({ ok: true }),
    openInNewWindow: async () => ({ ok: true }),
    closeTab: async () => ({ ok: true }),
    toggleFullscreen: async () => ({ ok: true }),
    zoom: async () => ({ ok: true }),
    toggleDevTools: async () => ({ ok: true }),
  },
  tab: {
    state: () => {},
    getState: async () => ({ name: "Utitled", dirty: false, path: null }),
  },
  search: {
    query: async (p) => ({ nameMatches: ["a.md"], contentMatches: [["a.md", [{ line: 1, text: "hit" }]]] }),
    stop: async () => ({ ok: true }),
  },
  path: {
    stat: async () => ({ isDirectory: false }),
    showInFinder: async () => ({ ok: true }),
    openFile: async () => ({ ok: true }),
    openURL: async () => ({ ok: true }),
  },
  library: {
    listDocsUnder: async () => [{ name: "a.md", path: "/tmp/a.md", isDirectory: false }],
    newFile: async () => ({ ok: true }),
    newFolder: async () => ({ ok: true }),
    renameFile: async () => ({ ok: true }),
    trashItem: async () => ({ ok: true }),
    recentFolders: async () => [],
    statFile: async (p) => ({ path: p.path, name: "a.md", isDirectory: false, size: 10, mtimeMs: Date.now(), birthtimeMs: Date.now() }),
    duplicate: async (p) => ({ path: p.path.replace(/\.md$/, " copy.md") }),
  },
  quickOpen: {
    query: async () => [{ path: "/tmp/a.md", name: "a.md" }],
    cacheRecentFiles: async () => ({ ok: true }),
    recentFiles: async () => [{ name: "a.md", path: "/tmp/a.md" }],
  },
  clipboard: {
    readImage: async () => ({ ok: false }),
    write: async (p) => { store.clipboard = p; return { ok: true }; },
    writeImage: async (p) => { store.clipboardImage = p; return { ok: true }; },
  },
  images: {
    save: async (p) => ({ path: "/tmp/img/x.png" }),
    saveAs: async (p) => ({ canceled: false, path: "/tmp/img/out.png" }),
    copyAll: async (p) => ({ canceled: false, dir: "/tmp/imgs", count: (p.images || []).length }),
  },
  word: { getTextReplacement: async () => ({}) },
  i18n: {
    strings: async () => ({ locale: "en", strings: { Untitled: "Untitled" } }),
    setLocale: async (p) => ({ ok: true, locale: p.locale }),
    locales: async () => ({ locale: "en", list: [{ key: "en", name: "English" }] }),
  },
  setting: {
    get: async () => store.settings,
    put: async (p) => { Object.assign(store.settings, p.value); return { ok: true, settings: store.settings }; },
  },
  theme: { list: async () => [], openFolder: async () => ({ ok: true }) },
  export: {
    md: async (p) => ({ ok: true, path: p.path }),
    html: async (p) => ({ ok: true, path: p.path, html: "<p>hi</p>" }),
    pdf: async () => ({ ok: true }),
    pandoc: async () => ({ ok: false, error: "no pandoc" }),
  },
  snapshots: { list: async () => [], restore: async () => ({ text: "" }) },
  session: { changed: async () => ({ ok: true }) },
  app: { version: async () => ({ name: "Lettrine", version: "0.1.0" }) },
  shell: { openExternal: async () => ({ ok: true }) },
  on: (event, listener) => { listeners[event] = listener; return () => {}; },
};

await import("../src/renderer/app.js");
dom.window.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
await new Promise((r) => setTimeout(r, 60));

test("boot: #write editor initialized with content", () => {
  const write = document.getElementById("write");
  assert.ok(write);
  assert.ok(write.children.length >= 1);
});

test("boot: importing opens a new tab and preserves an existing dirty draft, selection and history", async () => {
  const app = window.__lettrine, bridge = window.bridge, originalImport = bridge.document.import, originalTab = bridge.window.newTab;
  const imports = [], tabs = [];
  bridge.document.import = async (payload) => { imports.push(payload); return { ok: true, path: "/tmp/imported.md" }; };
  bridge.window.newTab = async (payload) => { tabs.push(payload); return { ok: true }; };
  try {
    app.editor.setText("Unsaved draft"); app.editor.root.focus(); app.editor.selectOffsets(2, 5);
    app._dirty = true;
    const history = app.editor._history.length, selection = app.editor.selectionOffsets();
    const result = await app.importDocument("/tmp/source.docx", { destination: "/tmp/imported.md" });
    assert.equal(result.path, "/tmp/imported.md"); assert.equal(imports[0].sourcePath, "/tmp/source.docx");
    assert.deepEqual(tabs, [{ path: "/tmp/imported.md" }]);
    assert.equal(app.editor.getMarkdown(), "Unsaved draft"); assert.equal(app._dirty, true);
    assert.deepEqual(app.editor.selectionOffsets(), selection); assert.equal(app.editor._history.length, history);
    app.editor.setReadOnly(true);
    assert.equal(await app.importDocument("/tmp/blocked.docx"), false); assert.equal(imports.length, 1);
  } finally {
    bridge.document.import = originalImport; bridge.window.newTab = originalTab; app.editor.setReadOnly(false); app._dirty = false;
  }
});

test("boot: unavailable Pandoc offers the settings guidance without replacing the document", async () => {
  const app = window.__lettrine, bridge = window.bridge, original = bridge.document.import;
  bridge.document.import = async () => { throw Error("Install Pandoc or choose its executable in Settings to import this format."); };
  try {
    const source = app.editor.getMarkdown(), pending = app.importDocument("/tmp/source.docx");
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(document.querySelector(".alert-message").textContent.includes("Pandoc"));
    document.querySelector('#confirm-choice-btns [data-choice="Cancel"]').click();
    assert.equal(await pending, false); assert.equal(app.editor.getMarkdown(), source); assert.equal(app._importing, false);
  } finally { bridge.document.import = original; }
});

test("boot: exporting remembers successful settings, confirms replacement and respects cancellation", async () => {
  const app = window.__lettrine, bridge = window.bridge, original = bridge.export.html;
  const options = [], opened = [], revealed = [];
  const originalOpen = bridge.path.openFile, originalReveal = bridge.path.showInFinder;
  const previousSettings = { ...app.settings };
  bridge.export.html = async (payload) => { options.push(payload); return { ok: true, path: payload.path }; };
  bridge.path.openFile = async (payload) => { opened.push(payload); };
  bridge.path.showInFinder = async (payload) => { revealed.push(payload); };
  try {
    Object.assign(app.settings, { fontSize: 18, openAfterExport: false, revealAfterExport: true });
    assert.equal(await app.doExport("html", "/exports/review.html", { style: false }), true);
    assert.equal(app.settings.lastExportFolder, "/exports");
    assert.equal(store.settings.lastExport.options.style, false);
    assert.equal(opened.length, 0); assert.equal(revealed.length, 1);
    app.settings.fontSize = 24;
    const canceled = app.exportPrevious();
    await tick();
    document.querySelector('#confirm-choice-btns [data-choice="Cancel"]').click();
    assert.equal(await canceled, false); assert.equal(options.length, 1);
    const repeated = app.exportPrevious();
    await tick();
    document.querySelector('#confirm-choice-btns [data-choice="Replace"]').click();
    assert.equal(await repeated, true); assert.equal(options.length, 2);
    assert.equal(options[1].settings.fontSize, 18); assert.equal(options[1].style, false);
    bridge.export.html = async () => ({ ok: false, error: "Export failed" });
    assert.equal(await app.doExport("html", "/bad/failed.html"), false);
    assert.equal(app.settings.lastExport.path, "/exports/review.html");
  } finally {
    bridge.export.html = original; bridge.path.openFile = originalOpen; bridge.path.showInFinder = originalReveal;
    app.settings = previousSettings;
    store.settings = { ...previousSettings };
  }
});

test("boot: menu command file.open loads a document", async () => {
  listeners["menu.command"]("file.open");
  await new Promise((r) => setTimeout(r, 40));
  const write = document.getElementById("write");
  assert.match(write.innerHTML, /Boot test/);
});

test("boot: menu command paragraph table opens the table dialog", async () => {
  listeners["menu.command"]("paragraph.table");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(document.getElementById("table-insert-dialog").classList.contains("open"));
  // close it again
  document.getElementById("table-insert-cancel").click();
});

test("boot: theme switching updates the stylesheet link", async () => {
  const app = dom.window.__lettrine;
  app.setTheme("lettrine-dark");
  assert.match(document.getElementById("theme_css").href, /lettrine-dark\.css/);
  app.setTheme("lettrine");
  assert.match(document.getElementById("theme_css").href, /themes\/lettrine\.css/);
});

test("boot: switching language translates the interface and keeps it translated", async () => {
  const bridge = dom.window.bridge, strings = bridge.i18n.strings;
  bridge.i18n.strings = async () => ({ locale: "zh-Hans", strings: { Settings: "设置", Close: "关闭" } });
  try {
    await listeners["i18n.changed"]({ locale: "zh-Hans" });
    assert.equal(document.documentElement.lang, "zh-Hans");
    assert.equal(document.getElementById("preferences-title").textContent, "设置");
    // interface added later is translated by the observer, in the same language
    const button = document.createElement("button"); button.textContent = "Close";
    document.querySelector("#doc-bar").appendChild(button);
    await tick(); await tick();
    assert.equal(button.textContent, "关闭");
    assert.equal(document.documentElement.lang, "zh-Hans");
    assert.equal(document.getElementById("preferences-title").textContent, "设置");
    button.remove();
  } finally {
    bridge.i18n.strings = strings;
    await listeners["i18n.changed"]({ locale: "en" });
  }
  assert.equal(document.documentElement.lang, "en");
  assert.equal(document.getElementById("preferences-title").textContent, "Settings");
});

test("boot: a saved theme that no longer exists falls back to the default pair", async () => {
  const app = dom.window.__lettrine, bridge = dom.window.bridge;
  bridge.theme.resolve = async ({ name }) => ({ theme: ["lettrine", "lettrine-dark"].includes(name) ? `lettrine://file/themes/${name}.css` : null });
  try {
    app._darkAppearance = true;
    app.setTheme("night");
    await tick(); await tick();
    assert.equal(app.theme, "lettrine-dark");
    app._darkAppearance = false;
    app.setTheme("github");
    await tick(); await tick();
    assert.equal(app.theme, "lettrine");
  } finally { delete bridge.theme.resolve; }
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const pageMenuItem = (label) => [...document.querySelectorAll(".ui-page-menu button")].find((button) => button.textContent.replace(/^✓ /, "") === label);

test("boot: an empty library offers Open Folder and keeps the picker cancelable", async () => {
  const app = dom.window.__lettrine, original = window.bridge.window.openFolder;
  app._libraryRoot = null; app.files = [];
  const { renderFileList } = await import("../src/renderer/ui.js");
  renderFileList();
  let calls = 0;
  window.bridge.window.openFolder = async () => { calls++; return { canceled: true }; };
  try {
    assert.equal(document.body.classList.contains("has-library"), false);
    assert.equal(document.querySelector("#library-name").textContent, "No Folder Open");
    const button = [...document.querySelectorAll(".library-empty button")].find((node) => node.textContent === "Open Folder…");
    assert.ok(button, "the empty state offers Open Folder…");
    button.click(); await tick(20);
    assert.equal(calls, 1); assert.equal(app._libraryRoot, null);
  } finally { window.bridge.window.openFolder = original; }
});

test("boot: the folder menu opens a library, lists its files and remembers it", async () => {
  const app = dom.window.__lettrine;
  document.querySelector("#library-menu-btn").click();
  await tick();
  const open = pageMenuItem("Open Folder…");
  assert.ok(open, "the folder menu offers Open Folder…");
  open.click();
  await tick(30);
  assert.equal(app.folder, "/tmp");
  assert.equal(app._libraryRoot, "/tmp");
  assert.equal(store.settings.lastLibrary, "/tmp");
  assert.equal(document.querySelector("#library-name").textContent, "tmp");
  assert.equal(document.body.classList.contains("has-library"), true);
  assert.equal(document.querySelector(".ui-page-menu"), null, "choosing an item closes the menu");
  assert.match(document.querySelector("#file-library-list").textContent, /a\.md/);
});

test("boot: view options switch between a tree and a dated list and persist the choice", async () => {
  const app = dom.window.__lettrine;
  await app.openFolder("/tmp");
  document.querySelector("#library-options-btn").click(); await tick();
  pageMenuItem("View as List").click(); await tick(10);
  assert.equal(document.querySelector("#file-library-list").getAttribute("role"), "list");
  assert.equal(store.settings.fileView, "list");
  document.querySelector("#library-options-btn").click(); await tick();
  assert.equal(pageMenuItem("View as List").getAttribute("aria-checked"), "true");
  pageMenuItem("Sort by Date Modified").click(); await tick(10);
  assert.deepEqual(app.sort, { key: "date", asc: false });
  assert.deepEqual(store.settings.librarySort, { key: "date", asc: false });
  await app.handleCommand("view.tree");
  assert.equal(document.querySelector("#file-library-list").getAttribute("role"), "tree");
  assert.equal(store.settings.fileView, "tree");
  assert.ok(document.querySelector('#file-library-list [role="treeitem"][data-path="/tmp/a.md"]'));
});

test("boot: Close Folder returns the sidebar to its empty state", async () => {
  const app = dom.window.__lettrine;
  await app.openFolder("/tmp");
  document.querySelector("#library-menu-btn").click(); await tick();
  pageMenuItem("Close Folder").click(); await tick(10);
  assert.equal(app._libraryRoot, null);
  assert.equal(store.settings.lastLibrary, null);
  assert.ok(document.querySelector(".library-empty"));
  await app.openFolder("/tmp");
});

test("boot: the sidebar switches between Files and Outline, preserves source and keeps the window's choice across settings broadcasts", async () => {
  const app = window.__lettrine, original = app.editor.getMarkdown();
  await app.openFolder("/tmp"); await app.handleCommand("view.tree");
  app.editor.setText("# Search\n\nBody\n\n## Second"); app.editor.root.focus(); app.editor.selectOffsets(10);
  const source = app.editor.getMarkdown(), block = app.editor.root.children[1], history = app.editor._history.length;
  const tabs = [...document.querySelectorAll("[data-sidebar-view]")], head = document.querySelector(".library-head");
  assert.deepEqual(tabs.map((tab) => tab.id), ["sidebar-view-files", "sidebar-view-outline"]);
  tabs[1].click();
  await tick(20);
  assert.equal(app.sidebarView, "outline"); assert.equal(document.getElementById("sidebar-outline").hidden, false);
  assert.equal(head.hidden, true); assert.equal(document.getElementById("file-library").hidden, true);
  assert.equal(tabs[1].getAttribute("aria-selected"), "true"); assert.equal(document.getElementById("tb-outline").getAttribute("aria-pressed"), "true");
  assert.equal(store.settings.sidebarOutline, true);
  assert.equal(document.querySelectorAll("#sidebar-outline-content .outline-row").length, 2);
  assert.equal(app.editor.getMarkdown(), source); assert.equal(app.editor._history.length, history); assert.equal(app.editor.root.children[1], block);
  const first = document.querySelector("#sidebar-outline-content .outline-row");
  app.editor.replaceRange(source.indexOf("Body") + 4, source.indexOf("Body") + 4, "\n\nExtra");
  await tick(250);
  assert.equal(document.querySelector("#sidebar-outline-content .outline-row"), first);
  assert.equal(Number(document.querySelectorAll("#sidebar-outline-content .outline-row")[1].dataset.block), 3);
  const edited = app.editor.getMarkdown(), editedHistory = app.editor._history.length, retained = app.editor.root.children[1];
  listeners["setting.changed"]({ ...app.settings, fileView: "list", fontSize: 17 });
  assert.equal(app.sidebarView, "outline");
  assert.equal(window.sessionStorage.getItem("lettrine.sidebarView"), "outline");
  assert.equal(app.editor.getMarkdown(), edited); assert.equal(app.editor._history.length, editedHistory);
  assert.equal(app.editor.root.children[1], retained);
  tabs[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  assert.equal(app.sidebarView, "tree"); assert.equal(document.activeElement, tabs[0]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true"); assert.equal(head.hidden, false);
  assert.equal(document.getElementById("file-library").hidden, false); assert.equal(store.settings.sidebarOutline, false);
  assert.equal(app.editor.getMarkdown(), edited); assert.equal(app.editor._history.length, editedHistory);
  assert.ok(history < editedHistory);
  app.editor.setText(original); app._dirty = false;
});

test("boot: folder search replaces the folder row while active, and Escape or Close Search return to the previous view", async () => {
  const app = window.__lettrine, input = document.getElementById("file-library-search-input");
  const head = document.querySelector(".library-head"), panel = document.getElementById("file-library-search-panel");
  await app.openFolder("/tmp"); await app.handleCommand("view.files");
  assert.equal(panel.hidden, true); assert.equal(head.hidden, false);
  document.getElementById("library-search-btn").click(); await tick(20);
  assert.equal(app.sidebarView, "search"); assert.equal(head.hidden, true); assert.equal(panel.hidden, false);
  assert.equal(document.activeElement, input);
  assert.equal(document.getElementById("sidebar-view-files").getAttribute("aria-selected"), "true");
  input.value = "hit"; input.dispatchEvent(new window.Event("input"));
  await tick(210);
  assert.equal(document.getElementById("file-library-search").hidden, false);
  assert.ok(document.querySelector("#file-library-search-result .search-match-row"));
  document.getElementById("sidebar-view-files").click();
  assert.equal(app.sidebarView, "search"); assert.equal(input.value, "hit");
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(app.sidebarView, "articles"); assert.equal(input.value, "");
  assert.equal(panel.hidden, true); assert.equal(head.hidden, false); assert.equal(document.getElementById("file-library").hidden, false);
  document.getElementById("sidebar-view-outline").click();
  await app.handleCommand("edit.findInFiles");
  assert.equal(app.sidebarView, "search"); assert.equal(document.getElementById("sidebar-outline").hidden, true);
  input.value = "hit"; input.dispatchEvent(new window.Event("input")); await tick(210);
  document.getElementById("file-library-search-close").click();
  assert.equal(app.sidebarView, "outline"); assert.equal(input.value, "");
  assert.equal(document.getElementById("sidebar-outline").hidden, false); assert.equal(panel.hidden, true);
  await app.handleCommand("view.tree");
});

test("boot: the outline command shows the sidebar's outline, navigates without editing, and restores the sidebar", async () => {
  const app = window.__lettrine, original = app.editor.getMarkdown(), button = document.getElementById("tb-outline");
  await app.handleCommand("view.tree");
  app.editor.setText("# First\n\nBody\n\n## Second"); app.editor.root.focus(); app.editor.selectOffsets(20);
  const source = app.editor.getMarkdown(), history = app.editor._history.length;
  button.click();
  assert.equal(app.sidebarView, "outline"); assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelectorAll("#sidebar-outline-content .outline-row").length, 2);
  document.querySelectorAll("#sidebar-outline-content .outline-row")[1].click();
  assert.equal(app.editor.caretInfo().blockIndex, 2);
  assert.equal(store.scrolledIntoView, app.editor.root.children[2]);
  assert.equal(app.editor.getMarkdown(), source); assert.equal(app.editor._history.length, history);
  await app.handleCommand("view.outline");
  assert.equal(app.sidebarView, "tree"); assert.equal(document.body.classList.contains("sidebar-hidden"), false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  await app.handleCommand("view.toggleSidebar");
  await app.handleCommand("view.outline");
  assert.equal(document.body.classList.contains("sidebar-hidden"), false); assert.equal(app.sidebarView, "outline");
  await app.handleCommand("view.outline");
  assert.equal(document.body.classList.contains("sidebar-hidden"), true); assert.equal(button.getAttribute("aria-pressed"), "false");
  await app.handleCommand("view.toggleSidebar"); await app.handleCommand("view.tree");
  assert.equal(document.getElementById("outline-panel"), null); assert.equal(document.getElementById("tb-outline-popover"), null);
  app.editor.setText(original); app._dirty = false;
});

test("boot: document toolbar preserves formatting selections, supports keyboard controls and disables editing in readonly", async () => {
  const app = window.__lettrine, original = app.editor.getMarkdown();
  app.editor.setText("Before word after"); app.editor.root.focus(); app.editor.selectOffsets(7, 11);
  await app.handleCommand("view.toolbar");
  const toolbar = document.getElementById("document-toolbar"), bold = toolbar.querySelector('[data-command="inline.strong"]');
  assert.equal(toolbar.hidden, false); assert.equal(store.settings.showDocumentToolbar, true);
  const press = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }); bold.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  bold.click(); await tick();
  assert.equal(app.editor.getMarkdown(), "Before **word** after");
  app.editor.undo(); assert.equal(app.editor.getMarkdown(), "Before word after");
  document.getElementById("toolbar-headings").focus();
  toolbar.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, bold);
  await app.handleCommand("view.readonly");
  assert.ok([...toolbar.querySelectorAll(".ui-toolbar-edit")].every(button => button.disabled));
  bold.click(); await tick(); assert.equal(app.editor.getMarkdown(), "Before word after");
  assert.equal(toolbar.querySelector(".ui-toolbar-dismiss").disabled, false);
  await app.handleCommand("view.readonly");
  app.editor.root.focus(); app.editor.selectOffsets(0);
  toolbar.querySelector('[data-command="paragraph.toc"]').click(); await tick();
  assert.equal(app.editor.getMarkdown(), "Before word after\n\n[TOC]");
  app.editor.undo(); assert.equal(app.editor.getMarkdown(), "Before word after");
  await app.handleCommand("view.toolbar");
  assert.equal(toolbar.hidden, true); assert.equal(store.settings.showDocumentToolbar, false);
  app.editor.setText(original); app._dirty = false;
});

test("boot: document zoom changes only presentation and modifier-wheel zoom is opt-in and confined to the editor", async () => {
  const app = window.__lettrine, settings = { ...app.settings }, zoom = window.bridge.window.zoom, calls = [];
  const source = app.editor.getMarkdown(), block = app.editor.root.firstElementChild, history = app.editor._history.length;
  window.bridge.window.zoom = async payload => { calls.push(payload); return { zoomFactor: 1.5 }; };
  try {
    assert.equal(document.getElementById("tb-zoom").hidden, true);
    listeners["setting.changed"]({ ...app.settings, fontSize: 16, zoomFactor: 1.5, zoomByMouse: false });
    assert.equal(document.getElementById("tb-zoom").hidden, false);
    assert.equal(document.documentElement.style.getPropertyValue("--document-zoom"), "1.5");
    assert.equal(document.documentElement.style.fontSize, "24px");
    assert.equal(document.getElementById("tb-zoom").textContent, "150%");
    assert.equal(app.editor.root.firstElementChild, block); assert.equal(app.editor._history.length, history);
    await app.handleCommand("view.zoomPopover");
    assert.equal(document.getElementById("zoom-value").textContent, "150%");
    const wheel = (target, extra = {}) => {
      const event = new window.WheelEvent("wheel", { deltaY: -80, bubbles: true, cancelable: true, ...extra });
      target.dispatchEvent(event); return event;
    };
    assert.equal(wheel(app.editor.root, { metaKey: true }).defaultPrevented, false);
    listeners["setting.changed"]({ ...app.settings, zoomByMouse: true });
    assert.equal(wheel(app.editor.root).defaultPrevented, false);
    assert.equal(wheel(document.getElementById("app-sidebar"), { ctrlKey: true }).defaultPrevented, false);
    assert.equal(wheel(app.editor.root, { metaKey: true }).defaultPrevented, true);
    await tick(100);
    assert.deepEqual(calls, [{ delta: 2 }]);
    assert.equal(app.editor.getMarkdown(), source); assert.equal(app.editor._history.length, history);
    document.getElementById("zoom-popover").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(document.getElementById("zoom-popover").hidden, true); assert.equal(document.activeElement.id, "tb-zoom");
  } finally { window.bridge.window.zoom = zoom; app.settings = settings; app.applySettings(); }
  assert.equal(document.getElementById("tb-zoom").hidden, true);
});

test("boot: switching libraries clears the previous folder's search results", async () => {
  const app = window.__lettrine;
  const input = document.getElementById("file-library-search-input");
  try {
    await app.openFolder("/tmp");
    input.value = "hit";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick(180);
    assert.equal(document.getElementById("file-library-search").hidden, false);
    assert.ok(document.querySelector(".search-match-row"));

    await app.openFolder("/tmp/another-library");
    assert.equal(input.value, "");
    assert.equal(document.getElementById("file-library").hidden, false);
    assert.equal(document.getElementById("file-library-search").hidden, true);
    assert.equal(document.getElementById("file-library-search-result").textContent, "");
    assert.equal(document.getElementById("library-name").textContent, "another-library");
  } finally { await app.openFolder("/tmp"); }
});

test("boot: closing a library discards pending searches and cancels debounced requests", async () => {
  const app = window.__lettrine, original = window.bridge.search.query;
  const input = document.getElementById("file-library-search-input");
  let finishSearch, calls = 0;
  window.bridge.search.query = () => { calls++; return new Promise((resolve) => { finishSearch = resolve; }); };
  try {
    await app.openFolder("/tmp");
    input.value = "pending";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick(180);
    assert.equal(calls, 1);
    app.closeFolder();
    finishSearch({ nameMatches: ["stale.md"], contentMatches: [] });
    await tick();
    assert.equal(input.value, "");
    assert.equal(document.getElementById("file-library").hidden, false);
    assert.equal(document.getElementById("file-library-search").hidden, true);
    assert.equal(document.getElementById("file-library-search-result").textContent, "");
    assert.ok(document.querySelector(".library-empty"));

    await app.openFolder("/tmp");
    input.value = "not sent yet";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    app.closeFolder();
    await tick(180);
    assert.equal(calls, 1);
  } finally {
    window.bridge.search.query = original;
    await app.openFolder("/tmp");
  }
});

test("boot: closed folders and newer selections cannot be overwritten by pending loads", async () => {
  const app = window.__lettrine, library = window.bridge.library, original = library.listDocsUnder;
  const pending = [];
  library.listDocsUnder = ({ path }) => new Promise((resolve) => pending.push({ path, resolve }));
  try {
    const opening = app.openFolder("/tmp/pending");
    await tick();
    app.closeFolder();
    pending.shift().resolve([{ name: "stale.md", path: "/tmp/pending/stale.md" }]);
    await opening;
    assert.equal(app._libraryRoot, null);
    assert.deepEqual(app.files, []);
    assert.ok(document.querySelector(".library-empty"));

    const first = app.openFolder("/tmp/first"), second = app.openFolder("/tmp/second");
    await tick();
    assert.deepEqual(pending.map(({ path }) => path), ["/tmp/second"]);
    pending.shift().resolve([{ name: "current.md", path: "/tmp/second/current.md" }]);
    await Promise.all([first, second]);
    assert.equal(app._libraryRoot, "/tmp/second");
    const refreshing = app.refreshFolderQuiet();
    app.closeFolder();
    const reopened = app.openFolder("/tmp/second");
    await tick();
    pending[1].resolve([{ name: "new.md", path: "/tmp/second/new.md" }]);
    await reopened;
    pending[0].resolve([{ name: "old.md", path: "/tmp/second/old.md" }]);
    await refreshing;
    assert.deepEqual(app.files.map(({ name }) => name), ["new.md"]);
  } finally {
    library.listDocsUnder = original;
    await app.openFolder("/tmp");
  }
});

test("boot: large Articles lists keep a small DOM and navigate through unmounted rows", async () => {
  const app = window.__lettrine, sort = app.sort, file = app.file;
  await app.openFolder("/tmp");
  try {
    app.sort = { key: "natural", asc: true };
    app.file = "/tmp/Paper 12910.md";
    app.files = Array.from({ length: 12910 }, (_, index) => {
      const name = `Paper ${12910 - index}.md`;
      return { name, path: "/tmp/" + name, isDirectory: false, mtimeMs: 1 };
    });
    await app.handleCommand("view.files");
    const list = document.getElementById("file-library-list");
    assert.ok(list.querySelectorAll("[data-path]").length < 80);
    assert.equal(list.querySelector("[data-path]").dataset.path, "/tmp/Paper 1.md");
    assert.equal(list.querySelector("[data-path]").getAttribute("aria-setsize"), "12910");
    assert.equal(list.querySelector("[data-path][tabindex='0']").dataset.path, "/tmp/Paper 1.md");
    list.querySelector("[data-path]").focus();
    document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    assert.equal(document.activeElement.dataset.path, "/tmp/Paper 12910.md");
    assert.ok(list.querySelectorAll("[data-path]").length < 80);
    document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    assert.equal(document.activeElement.dataset.path, "/tmp/Paper 1.md");
    for (let index = 0; index < 70; index++) document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.equal(document.activeElement.dataset.path, "/tmp/Paper 71.md");
  } finally { app.sort = sort; app.file = file; await app.openFolder("/tmp"); await app.handleCommand("view.tree"); }
});

test("boot: folder search streams current results and its trailing close button cancels stale work", async () => {
  const app = window.__lettrine, original = window.bridge.search.query, requests = [];
  const input = document.getElementById("file-library-search-input"), close = document.getElementById("file-library-search-close");
  window.bridge.search.query = (payload) => new Promise((resolve) => requests.push({ payload, resolve }));
  try {
    await app.openFolder("/tmp");
    await app.handleCommand("edit.findInFiles");
    input.value = "first";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick(180);
    listeners["search.results"]({ requestId: requests[0].payload.requestId, nameMatches: ["first.md"], contentMatches: [] });
    assert.match(document.getElementById("file-library-search-result").textContent, /first.*Searching/s);
    document.querySelector(".search-name-row").focus();
    listeners["search.results"]({ requestId: requests[0].payload.requestId, nameMatches: ["first.md"], contentMatches: [["first.md", [{ line: 1, text: "first hit" }]]] });
    assert.equal(document.activeElement.dataset.searchKey, "name:/tmp/first.md");
    assert.equal(close.previousElementSibling.className, "search-options");
    close.click();
    assert.equal(input.value, "");
    assert.equal(document.getElementById("file-library-search-panel").hidden, true);
    assert.equal(document.querySelector(".library-head").hidden, false);
    assert.notEqual(document.activeElement, input);
    requests[0].resolve({ nameMatches: ["stale.md"], contentMatches: [] });
    listeners["search.results"]({ requestId: requests[0].payload.requestId, nameMatches: ["stale.md"] });
    await tick();
    assert.doesNotMatch(document.getElementById("file-library-search-result").textContent, /stale/);
  } finally { window.bridge.search.query = original; app.closeFolder(); await app.openFolder("/tmp"); }
});

test("boot: removal keeps the document name during close and routes unsaved text through Save As", async () => {
  const app = await freshDocument();
  await app.openFile("/tmp/removed.md");
  const source = app.editor.getMarkdown();
  listeners["doc.removed"]({ path: app.file });
  assert.equal(app.file, "/tmp/removed.md");
  assert.equal(app.editor.getMarkdown(), source);
  assert.equal(await app.save(true), false);
  assert.equal(await app.save(false), true);
  assert.equal(app.file, "/tmp/saved.md");
  assert.equal(app._removedPath, null);
});

test("boot: quick open shows recent files", async () => {
  listeners["menu.command"]("file.openQuickly");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(document.getElementById("quick-open").classList.contains("active"));
  assert.match(document.getElementById("quick-open-list").innerHTML, /a\.md/);
  document.getElementById("quick-open-mask").click();
});

test("boot: find panel opens and reports matches", async () => {
  listeners["menu.command"]("edit.find");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(document.getElementById("md-searchpanel").classList.contains("active"));
  const input = document.getElementById("search-panel-input");
  input.value = "Boot";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(document.getElementById("search-panel-status").textContent, /^1 (of 1|match)$/);
  document.getElementById("search-panel-next").click();
  assert.equal(document.getElementById("search-panel-status").textContent, "1 of 1");
  document.getElementById("search-panel-close").click();
});

test("boot: incremental find selects the first match before advancing to the next", async () => {
  const app = await freshDocument("needle one\n\nneedle two");
  const { openSearchpanel, closeSearchpanel } = await import("../src/renderer/ui.js");
  app.editor.root.focus(); app.editor.selectOffsets(0);
  openSearchpanel(false);
  const input = document.getElementById("search-panel-input");
  try {
    input.value = "needle";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick(280);
    assert.equal(document.getElementById("search-panel-status").textContent, "1 of 2");
    assert.equal(window.getSelection().toString(), "needle");
    assert.equal(document.activeElement, input);
    document.getElementById("search-panel-next").click();
    assert.equal(document.getElementById("search-panel-status").textContent, "2 of 2");
    assert.equal(app.editor.selectionOffsets().start, 12);
  } finally { closeSearchpanel(); }
});

test("boot: closing find cancels a pending incremental selection", async () => {
  const app = await freshDocument("needle one\n\nother text");
  const { openSearchpanel, closeSearchpanel } = await import("../src/renderer/ui.js");
  openSearchpanel(false);
  const input = document.getElementById("search-panel-input");
  input.value = "needle";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  closeSearchpanel();
  app.editor.selectOffsets(12);
  await tick(280);
  assert.equal(document.getElementById("md-searchpanel").hidden, true);
  assert.equal(document.activeElement, app.editor.root);
  assert.equal(app.editor.selectionOffsets().start, 12);
  assert.equal(app.editor.selectionOffsets().end, 12);
});

test("boot: oversized file enters oversize mode and can be dismissed", async () => {
  const app = dom.window.__lettrine;
  await app.openFile("/tmp/huge.md");
  assert.ok(document.body.classList.contains("oversize"));
  assert.notEqual(document.getElementById("ic-oversize-body").style.display, "none");
  app.exitOversize();
  assert.ok(!document.body.classList.contains("oversize"));
});

test("boot: the document title opens its info popover with location and counts", async () => {
  const app = dom.window.__lettrine;
  await app.openFile("/tmp/a.md");
  const title = document.getElementById("doc-title");
  title.click(); await tick(10);
  const popover = document.getElementById("doc-popover");
  assert.equal(popover.hidden, false);
  assert.equal(title.getAttribute("aria-expanded"), "true");
  assert.equal(document.getElementById("doc-info-name").textContent, "a.md");
  assert.equal(document.getElementById("doc-info-path").textContent, "/tmp");
  assert.equal(document.getElementById("wc-words").textContent, "3");
  assert.equal(popover.querySelector('[data-doc-action="save"]').hidden, true, "a saved file offers Reveal and History instead of Save");
  assert.equal(popover.querySelector('[data-doc-action="history"]').hidden, false);
  popover.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(popover.hidden, true);
  assert.equal(document.getElementById("titlebar-document-name").textContent, "a.md");
});

test("boot: disk change prompts to reload and restores content", async () => {
  const app = dom.window.__lettrine;
  await app.openFile("/tmp/disk.md");
  // user edits locally so the on-disk content differs
  app.editor.setText("# Edited locally");
  const pending = app.handleDiskChanged({ path: "/tmp/disk.md" });
  // the blocking choice dialog renders, then we pick Reload
  await new Promise((r) => setTimeout(r, 20));
  const btns = Array.from(document.querySelectorAll("#confirm-choice-btns button"));
  assert.ok(btns.length >= 2, "reload prompt should offer choices");
  const reload = btns.find((b) => b.textContent === "Reload");
  assert.ok(reload, "Reload button present");
  reload.click();
  await pending;
  assert.match(app.editor.getMarkdown(), /Changed on disk/);
});

test("boot: autosave wrote the document", async () => {
  const app = dom.window.__lettrine;
  app.editor.setText("# Changed\n\nnew content");
  app.editor.emit();
  await app.saveAs();
  assert.equal(store.file, "/tmp/saved.md");
  assert.equal(document.querySelector("#titlebar-document-name").textContent, "saved.md");
  assert.equal(document.querySelector("#titlebar-document-status").textContent, "");
});

async function freshDocument(text = "") {
  const app = window.__lettrine;
  store.write = null;
  store.saveDialog = null;
  app.settings.autosave = false;
  app._dirty = false;
  await app.newDocument();
  app.editor.setText(text);
  app._savedText = app.editor.getMarkdown();
  return app;
}

async function choose(label) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const button = [...document.querySelectorAll("#confirm-choice-btns button")].find((b) => b.textContent === label);
  assert.ok(button, `Expected ${label} choice`);
  button.click();
}

test("boot: document and save-panel line endings stay independent, and final newline insertion is undoable", async () => {
  const app = await freshDocument("original"), settings = { ...app.settings };
  try {
    app.settings.finalNewLine = true; app.settings.defaultExtension = "qmd"; app.settings.lineEndings = "";
    app._lineEnding = "CRLF";
    let options;
    store.saveDialog = (p) => { options = p; return { path: "/tmp/formatted.qmd", lineEndings: "LF" }; };
    assert.equal(await app.saveAs(), true);
    assert.equal(options.defaultName, "Untitled.qmd");
    assert.equal(store.writes.at(-1).text, "original\n");
    assert.equal(app.editor.getMarkdown(), "original\n");
    app.editor.undo(); app.editor.emit();
    assert.equal(app.editor.getMarkdown(), "original");
    await app.handleCommand("format.crlf");
    assert.equal(app.settings.lineEndings, "");
    assert.equal(await app.save(false), true);
    assert.equal(store.writes.at(-1).text, "original\r\n");
    app._dirty = false;
    await app.newDocument();
    assert.equal(app._lineEndingOverride, "");
    assert.equal(app.settings.lineEndings, "");
  } finally { app.settings = settings; store.saveDialog = null; }
});

test("boot: save on switch writes the departing document and a failed write cancels the switch", async () => {
  const app = await freshDocument("saved"), settings = { ...app.settings };
  try {
    app.settings.saveOnSwitch = true; app.settings.finalNewLine = false;
    app.file = "/tmp/departing.md"; app.editor.replaceRange(5, 5, " revised"); app.editor.emit();
    assert.equal(await app.openFile("/tmp/arrival.md"), true);
    assert.equal(store.writes.at(-1).path, "/tmp/departing.md");
    assert.equal(store.writes.at(-1).text, "saved revised");
    app.editor.replaceRange(app.editor.getMarkdown().length, app.editor.getMarkdown().length, " unsaved"); app.editor.emit();
    const draft = app.editor.getMarkdown();
    store.write = async () => ({ ok: false, error: "Disk unavailable" });
    assert.equal(await app.openFile("/tmp/other.md"), false);
    assert.equal(app.file, "/tmp/arrival.md"); assert.equal(app.editor.getMarkdown(), draft);
  } finally { app.settings = settings; store.write = null; app._dirty = false; }
});

test("boot: source edits are dirty immediately and saving writes the latest source", async () => {
  const app = await freshDocument("# Initial");
  app.toggleSource();
  const textarea = document.getElementById("source-editor");
  textarea.value = "# Updated heading\n\nLatest content\n";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(app._dirty, true);
  assert.equal(await app.saveAs(), true);
  assert.equal(store.writes.at(-1).text, textarea.value);
  assert.equal(app._dirty, false);
  app.toggleSource();
  assert.equal(app.editor.getMarkdown(), textarea.value);
  for (let i = 0; i < 2; i++) {
    app.toggleSource();
    textarea.value += "more\n";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(app.editor.getMarkdown(), textarea.value);
    app.toggleSource();
  }
});

test("boot: canceling a document switch keeps the text, discarding resets history", async () => {
  const app = await freshDocument("first");
  app.editor.replaceSelection(" edited");
  const before = app.editor.getMarkdown();
  let pending = app.openFile("/tmp/next.md");
  await choose("Cancel");
  assert.equal(await pending, false);
  assert.equal(app.file, null);
  assert.equal(app.editor.getMarkdown(), before);
  pending = app.openFile("/tmp/next.md");
  await choose("Don't Save");
  assert.equal(await pending, true);
  app.editor.undo();
  assert.equal(app.editor.getMarkdown(), "# Boot test\n\ncontent");
});

test("boot: failed or canceled Save As leaves the original document dirty", async () => {
  const app = await freshDocument("draft");
  app.editor.replaceSelection(" changed");
  store.saveDialog = async () => ({ canceled: true });
  assert.equal(await app.saveAs(), false);
  assert.equal(app.file, null);
  assert.equal(app._dirty, true);
  store.saveDialog = null;
  store.write = async () => { throw new Error("disk full"); };
  assert.equal(await app.saveAs(), false);
  assert.equal(app.file, null);
  assert.equal(app._dirty, true);
  const pending = app.openFile("/tmp/next.md");
  await choose("Save");
  assert.equal(await pending, false);
  assert.equal(app.file, null);
  assert.match(app.editor.getMarkdown(), /draft/);
});

test("boot: edits made during a slow save stay dirty and the next save writes them", async () => {
  const app = await freshDocument();
  await app.openFile("/tmp/slow.md");
  app.editor.replaceSelection(" first edit");
  const snapshot = app.editor.getMarkdown();
  let finish;
  store.write = () => new Promise((resolve) => { finish = resolve; });
  const pending = app.save(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.editor.replaceSelection(" later edit");
  finish({ ok: true });
  assert.equal(await pending, true);
  assert.equal(app._savedText, snapshot);
  assert.equal(app._dirty, true);
  store.write = null;
  assert.equal(await app.save(false), true);
  assert.match(store.writes.at(-1).text, /later edit/);
  assert.equal(app._dirty, false);
  app.editor.undo();
  assert.equal(app._dirty, true);
  app.editor.redo();
  assert.equal(app._dirty, false);
});

test("boot: untitled autosave never opens a save dialog", async () => {
  const app = await freshDocument();
  let dialogs = 0;
  store.saveDialog = async () => { dialogs++; return { canceled: true }; };
  app.settings.autosave = true;
  app.settings.autosaveSec = 0.01;
  app.editor.replaceSelection("draft");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(dialogs, 0);
  assert.equal(app._dirty, true);
  assert.equal(await app.save(true), false);
  assert.equal(dialogs, 0);
});

test("boot: oversized documents cannot overwrite the file with an empty editor", async () => {
  const app = await freshDocument();
  await app.openFile("/tmp/huge.md");
  const before = store.writes.length;
  assert.equal(await app.save(false), false);
  assert.equal(await app.saveAs(), false);
  assert.equal(store.writes.length, before);
  document.getElementById("ic-oversize-close").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.file, null);
  assert.equal(document.body.classList.contains("oversize"), false);
});

test("boot: disk reload is undoable and undo marks the recovered version unsaved", async () => {
  const app = await freshDocument();
  await app.openFile("/tmp/disk.md");
  app.editor.replaceSelection(" local work");
  const edited = app.editor.getMarkdown();
  const pending = app.handleDiskChanged({ path: app.file });
  await choose("Reload");
  await pending;
  assert.equal(app._dirty, false);
  app.editor.undo();
  assert.equal(app.editor.getMarkdown(), edited);
  assert.equal(app._dirty, true);
});

test("boot: copying Markdown copies only the selected source across paragraphs", async () => {
  const app = await freshDocument("before alpha\n\nbeta after");
  app.editor.selectOffsets(7, 18);
  await app.copySelection("markdown");
  assert.equal(store.clipboard.text, "alpha\n\nbeta");
});

test("boot: copy commands distinguish literal HTML code from clean rich HTML", async () => {
  const app = await freshDocument("Before **selected** after");
  app.editor.root.focus(); app.editor.selectOffsets(9, 17);
  await app.handleCommand("edit.copyCleanHTML");
  assert.equal(store.clipboard.text, "selected");
  assert.match(store.clipboard.html, /<strong>selected<\/strong>/);
  assert.doesNotMatch(store.clipboard.html, /style=|class=|md-attr/);
  await app.handleCommand("edit.copyHTML");
  assert.match(store.clipboard.text, /<strong>selected<\/strong>/);
  assert.equal(Object.hasOwn(store.clipboard, "html"), false);
});

test("boot: structural commands select and delete a block with one undo step", async () => {
  const source = "Before\n\n## Chosen heading\n\nAfter";
  const app = await freshDocument(source);
  app.editor.root.focus(); app.editor.selectOffsets(source.indexOf("Chosen") + 2);
  await app.handleCommand("edit.selectScope");
  assert.equal(window.getSelection().toString(), "Chosen heading");
  await app.handleCommand("edit.selectBlock");
  await app.handleCommand("edit.deleteBlock");
  assert.equal(app.editor.getMarkdown(), "Before\n\nAfter");
  await app.handleCommand("edit.undo");
  assert.equal(app.editor.getMarkdown(), source);
});

test("boot: Copy as Image works readonly and preserves the existing text clipboard", async () => {
  const app = await freshDocument("before **selected** after");
  app.editor.root.focus(); app.editor.selectOffsets(9, 17);
  await window.bridge.clipboard.write({ text: "Previous text" });
  app.toggleReadonly();
  try {
    assert.ok((await app.handleCommand("edit.copyImage")).ok);
    assert.match(store.clipboardImage.fragment, /<strong>selected<\/strong>/);
    assert.equal(store.clipboard.text, "Previous text");
    assert.equal(app.editor.getMarkdown(), "before **selected** after");
    assert.equal(app._dirty, false);
  } finally { app.toggleReadonly(); }
});

test("boot: an image-copy failure is visible and clears temporary capture styling", async () => {
  const app = await freshDocument("selected");
  app.editor.root.focus(); app.editor.selectOffsets(0, 8);
  const original = window.bridge.clipboard.writeImage;
  window.bridge.clipboard.writeImage = async () => { throw new Error("Image rendering timed out."); };
  try {
    assert.equal(await app.handleCommand("edit.copyImage"), false);
    assert.match(document.querySelector("#md-notification").textContent, /Image rendering timed out/);
    assert.equal(document.body.classList.contains("copying-image"), false);
    assert.equal(app.editor.getMarkdown(), "selected");
  } finally { window.bridge.clipboard.writeImage = original; }
});

test("boot: Select All deletes an idle formula and Undo restores its clean baseline", async () => {
  const source = "$$\nx^2+y^2=z^2\n$$";
  const app = await freshDocument(source);
  app.editor.root.focus();
  await app.handleCommand("edit.selectAll", {});
  assert.deepEqual(app.editor.selectionOffsets(), { start: 0, end: source.length, backward: false });
  app.editor.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
  assert.equal(app.editor.getMarkdown(), ""); assert.equal(app._dirty, true);
  await app.handleCommand("edit.undo", {});
  assert.equal(app.editor.getMarkdown(), source); assert.equal(app._dirty, false);
});

test("boot: source-mode copy respects the source editor's selection", async () => {
  const app = await freshDocument("# Title\n\nchosen word");
  app.toggleSource();
  const textarea = document.getElementById("source-editor");
  textarea.setSelectionRange(textarea.value.indexOf("chosen"), textarea.value.indexOf("chosen") + 6);
  await app.copySelection("markdown");
  assert.equal(store.clipboard.text, "chosen");
  await app.copySelection("plain");
  assert.equal(store.clipboard.text, "chosen");
  app.toggleSource();
});

test("boot: renaming an open document preserves content/history and redirects future saves", async () => {
  const app = await freshDocument();
  await app.openFile("/tmp/before.md");
  app.editor.replaceSelection(" unsaved edit");
  const content = app.editor.getMarkdown();
  listeners["doc.pathChanged"]({ from: "/tmp/before.md", to: "/tmp/after.md", path: "/tmp/after.md" });
  assert.equal(app.file, "/tmp/after.md");
  assert.equal(app.editor.docBase, "/tmp/after.md");
  assert.equal(app._dirty, true);
  assert.equal(app.editor.getMarkdown(), content);
  await app.save(false);
  assert.equal(store.writes.at(-1).path, "/tmp/after.md");
  app.editor.undo();
  assert.doesNotMatch(app.editor.getMarkdown(), /unsaved edit/);
});

test("boot: source edits synchronize the model and defer hidden preview rendering", async () => {
  const app = await freshDocument("# Before\n\nfirst paragraph");
  const originalHeading = app.editor.root.firstElementChild;
  app.toggleSource();
  const textarea = document.getElementById("source-editor");
  for (const text of ["# After\n\nsecond paragraph", "# Final\n\n**saved immediately** 😀\n"]) {
    textarea.value = text;
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(app.editor.getMarkdown(), text);
    assert.equal(app.editor.root.firstElementChild, originalHeading, "hidden preview DOM stays intact");
    assert.equal(app._dirty, true);
  }
  assert.equal(document.getElementById("tb-source").getAttribute("aria-pressed"), "true");
  assert.equal(await app.saveAs(), true);
  assert.equal(store.writes.at(-1).text, textarea.value);
  app.toggleSource();
  assert.notEqual(app.editor.root.firstElementChild, originalHeading);
  assert.equal(app.editor.root.querySelector("h1").textContent, "# Final");
  assert.equal(app.editor.root.querySelector("strong").textContent, "**saved immediately**");
  assert.equal(document.getElementById("tb-source").getAttribute("aria-pressed"), "false");
});

test("boot: source formatting uses the latest model after hidden rendering was deferred", async () => {
  const app = await freshDocument("# Old");
  app.toggleSource();
  const textarea = document.getElementById("source-editor");
  textarea.value = "# New heading\n\nA completely new paragraph with chosen text.";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const start = textarea.value.indexOf("chosen");
  textarea.setSelectionRange(start, start + 6);
  await app.handleCommand("inline.strong");
  assert.equal(textarea.value, "# New heading\n\nA completely new paragraph with **chosen** text.");
  app.toggleSource();
  assert.equal(app.editor.getMarkdown(), textarea.value);
});

test("boot: quick-open navigation retains rows, category headings, and the caller's focus", async () => {
  const app = await freshDocument("# Quick Open");
  const { openQO, closeQO } = await import("../src/renderer/ui.js");
  const originalQuery = window.bridge.quickOpen.query;
  window.bridge.quickOpen.query = async () => [
    { path: "/tmp/b.md", name: "b.md" }, { path: "/tmp/c.md", name: "c.md" },
  ];
  try {
    app.editor.root.focus();
    openQO();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = document.querySelector("#quick-open-input input");
    const rows = [...document.querySelectorAll(".quick-open-item")];
    assert.equal(document.getElementById("quick-open").hidden, false);
    assert.deepEqual([...document.querySelectorAll("#quick-open .qo-group:not([hidden]) .qo-group-title")].map((node) => node.textContent), ["Recent Files", "In “tmp”"]);
    assert.ok(rows.length >= 3);
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    assert.deepEqual([...document.querySelectorAll(".quick-open-item")], rows, "navigation does not rebuild rows");
    assert.equal(document.querySelector(".quick-open-item.active"), rows[1]);
    assert.equal(input.getAttribute("aria-activedescendant"), rows[1].id);
    assert.equal(rows[1].getAttribute("aria-selected"), "true");
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.getElementById("quick-open").hidden, true);
    assert.equal(document.activeElement, app.editor.root);
  } finally { closeQO(); window.bridge.quickOpen.query = originalQuery; }
});

test("boot: Quick Open over Settings owns focus and Escape returns to Settings", async () => {
  const app = await freshDocument("# Modal focus");
  const { openQO, closeQO } = await import("../src/renderer/ui.js");
  const settings = document.getElementById("preferences-dialog");
  const general = settings.querySelector('[data-pane="general"]');
  const originalRects = general.getClientRects;
  general.getClientRects = () => [{ width: 100, height: 20 }];
  const errors = [];
  const onError = (event) => { errors.push(event.message); event.preventDefault(); };
  window.addEventListener("error", onError);
  try {
    app.handleCommand("file.preferences");
    openQO(); await tick();
    const input = document.querySelector("#quick-open-input input");
    assert.deepEqual(errors, []);
    assert.equal(document.activeElement, input);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(document.getElementById("quick-open").hidden, true);
    assert.equal(settings.classList.contains("open"), true);
    assert.equal(settings.contains(document.activeElement), true);
  } finally {
    closeQO();
    general.getClientRects = originalRects;
    window.removeEventListener("error", onError);
    if (settings.classList.contains("open")) document.getElementById("preferences-done").click();
    await tick();
  }
});

test("boot: quick open rejects stale responses while a new query is debouncing", async () => {
  const app = await freshDocument();
  const { openQO, closeQO } = await import("../src/renderer/ui.js");
  const originalQuery = window.bridge.quickOpen.query;
  let resolveOld;
  window.bridge.quickOpen.query = () => new Promise((resolve) => { resolveOld = resolve; });
  try {
    openQO();
    const input = document.querySelector("#quick-open-input input");
    input.value = "unmatched-query";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    resolveOld([{ name: "unmatched-query-stale.md", path: "/tmp/stale.md" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelectorAll(".quick-open-item").length, 0);
    window.bridge.quickOpen.query = async () => [];
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(document.getElementById("quick-open-empty").textContent, "No matching files");
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
  } finally { closeQO(); window.bridge.quickOpen.query = originalQuery; }
});

test("boot: quick open matches paths relative to the library without matching its ancestors", async () => {
  const app = await freshDocument();
  const { openQO, closeQO } = await import("../src/renderer/ui.js");
  const originalQuery = window.bridge.quickOpen.query;
  const folder = app.folder, files = app.files, root = app._libraryRoot;
  app.folder = app._libraryRoot = "/tmp/idea-library";
  app.files = [{ name: "unrelated.md", path: app.folder + "/unrelated.md" }, { name: "Idea.md", path: app.folder + "/Notes/Idea.md" }];
  window.bridge.quickOpen.query = async () => app.files;
  try {
    openQO();
    const input = document.querySelector("#quick-open-input input");
    input.value = "idea"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.deepEqual([...document.querySelectorAll(".qo-name")].map((node) => node.textContent), ["Idea.md"]);
    assert.equal(document.querySelector(".qo-path").textContent, "Notes");
    assert.deepEqual([...document.querySelectorAll(".qo-name b")].map((node) => node.textContent), ["I", "d", "e", "a"], "matched characters are emphasized");
  } finally { closeQO(); window.bridge.quickOpen.query = originalQuery; app.folder = folder; app.files = files; app._libraryRoot = root; }
});

test("boot: focus mode only moves the current block and clears it when disabled", async () => {
  const app = await freshDocument("first\n\nsecond");
  app.editor.root.focus(); app.editor.placeCaret(0, 1);
  app.toggleFocusMode();
  assert.equal(app.editor.root.querySelectorAll(".md-current-block").length, 1);
  app.editor.placeCaret(1, 1); app.updateWritingModes();
  assert.equal(app.editor.root.children[0].classList.contains("md-current-block"), false);
  assert.equal(app.editor.root.children[1].classList.contains("md-current-block"), true);
  app.toggleFocusMode();
  assert.equal(app.editor.root.querySelectorAll(".md-current-block").length, 0);
});

test("boot: readonly blocks document commands and saving while retaining unsaved history", async () => {
  const app = await freshDocument("original");
  app.file = "/tmp/readonly.md";
  app.editor.root.focus();
  app.editor.selectOffsets(8);
  app.editor.replaceSelection(" draft");
  app.editor.selectOffsets(2, 5);
  const writes = store.writes.length, history = app.editor._history.length;
  app.toggleReadonly();
  try {
    assert.ok(app._dirty);
    assert.doesNotMatch(document.title, /●/);
    assert.equal(document.querySelector("#titlebar-document-status").textContent, "Readonly Mode");
    for (const command of ["inline.underline", "paragraph.alert.warning", "edit.undo", "edit.redo", "edit.cut", "edit.paste", "file.save", "file.saveAs", "library.newFile", "library.duplicate"]) await app.handleCommand(command);
    assert.equal(await app.save(false), false);
    assert.equal(await app.saveAs(), false);
    assert.equal(app.editor.getMarkdown(), "original draft");
    assert.equal(store.writes.length, writes);
    assert.equal(app.editor._history.length, history);
  } finally { app.toggleReadonly(); }
  assert.deepEqual(app.editor.selectionOffsets(), { start: 2, end: 5, backward: false });
  assert.match(document.title, /●/);
  app.editor.undo();
  assert.equal(app.editor.getMarkdown(), "original");
});

test("boot: readonly source mode and Find replacement leave the document unchanged", async () => {
  const app = await freshDocument("needle one\n\nneedle two");
  app.editor.root.focus();
  app.editor.selectOffsets(7);
  app.toggleReadonly();
  try {
    app.toggleSource();
    const textarea = document.querySelector("#source-editor");
    assert.equal(textarea.readOnly, true);
    textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
    await app.handleCommand("edit.replace");
    const input = document.querySelector("#search-panel-input");
    input.value = "needle";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const replacement = document.querySelector("#search-panel-replace-input");
    replacement.value = "changed";
    replacement.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("#search-panel-replaceall-btn").click();
    assert.equal(app.editor.getMarkdown(), "needle one\n\nneedle two");
    assert.equal(textarea.value, "needle one\n\nneedle two");
    document.querySelector("#search-panel-close").click();
    app.toggleSource();
  } finally { app.toggleReadonly(); }
  assert.equal(app.editor.selectionOffsets().start, 7);
});

test("boot: session snapshots retain dirty source and caret while clean files retain only their path", async () => {
  const app = await freshDocument("# Kept\n\nSource **text**");
  app.file = "/tmp/session.md"; app._savedText = app.editor.getMarkdown(); app._dirty = false;
  app.editor.root.focus(); app.editor.selectOffsets(8, 14);
  const clean = app.captureSession();
  assert.equal(clean.path, "/tmp/session.md"); assert.equal(clean.text, undefined); assert.equal(clean.savedText, undefined);
  assert.deepEqual(clean.selection, { start: 8, end: 14, backward: false });
  app.editor.replaceSelection("draft");
  const dirty = app.captureSession();
  assert.equal(dirty.text, app.editor.getMarkdown()); assert.equal(dirty.savedText, "# Kept\n\nSource **text**");
  assert.equal(dirty.dirty, true);
});

test("boot: session restore recovers missing/changed files and retains source view and readonly", async () => {
  const app = window.__lettrine, read = window.bridge.document.read;
  try {
    window.bridge.document.read = async p => ({ path: p.path, text: "external version" });
    await app.restoreSession({ path: "/tmp/session.md", text: "recovered **draft**", savedText: "original", dirty: true, source: true, readonly: true, selection: { start: 10, end: 17 }, lineEndingOverride: "CRLF" });
    assert.equal(app.file, null); assert.equal(app._dirty, true); assert.equal(app.editor.readOnly, true);
    assert.equal(document.getElementById("source-editor").value, "recovered **draft**");
    assert.equal(document.getElementById("source-editor").selectionStart, 10);
    assert.equal(app._lineEndingOverride, "CRLF");
    app.toggleReadonly();
    window.bridge.document.read = async () => { throw Error("missing"); };
    await app.restoreSession({ path: "/tmp/deleted.md", text: "missing file draft", savedText: "old", dirty: true, selection: { start: 4, end: 4 } });
    assert.equal(app.file, null); assert.equal(app.editor.getMarkdown(), "missing file draft"); assert.equal(app._dirty, true);
    assert.equal(app.editor.selectionOffsets().start, 4);
  } finally { window.bridge.document.read = read; app._dirty = false; }
});

test("boot: clean session documents use current disk text and line endings", async () => {
  const app = window.__lettrine, read = window.bridge.document.read;
  try {
    window.bridge.document.read = async p => ({ path: p.path, text: "# Current\r\n\r\nDisk text.\r\n" });
    await app.restoreSession({ path: "/tmp/session-clean.md", lineEnding: "LF", source: false });
    assert.equal(app.editor.getMarkdown(), "# Current\n\nDisk text.\n");
    assert.equal(app._savedText, app.editor.getMarkdown()); assert.equal(app._dirty, false);
    assert.equal(app._lineEnding, "CRLF"); assert.equal(app.captureSession().text, undefined);
    app.toggleSource();
    const textarea = document.getElementById("source-editor");
    textarea.scrollTop = 145; textarea.setSelectionRange(2, 9, "backward");
    const state = app.captureSession();
    assert.equal(state.scroll, 145);
    assert.deepEqual(state.selection, { start: 2, end: 9, backward: true });
    app.toggleSource();
  } finally { window.bridge.document.read = read; app._dirty = false; }
});

test("boot: oversized session data never replaces an existing draft with empty text", async () => {
  const app = await freshDocument("keep this draft"), read = window.bridge.document.read;
  try {
    window.bridge.document.read = async p => ({ path: p.path, text: "disk version" });
    await assert.rejects(app.restoreSession({ path: "/tmp/session-large.md", text: "文".repeat(700000) }), /too large/);
    assert.equal(app.editor.getMarkdown(), "keep this draft");
    window.bridge.document.read = async p => ({ path: p.path, text: "", size: 2100000 });
    await app.restoreSession({ path: "/tmp/session-large.md" });
    assert.equal(document.body.classList.contains("oversize"), true);
    assert.equal(app.file, "/tmp/session-large.md");
    assert.equal(await app.save(false), false);
  } finally { window.bridge.document.read = read; app.exitOversize(); app._dirty = false; }
});

test("boot: maintenance preferences default off and unavailable services stay disabled", async () => {
  const app = window.__lettrine;
  await app.handleCommand("file.preferences");
  assert.equal(document.getElementById("pref-extra-anonymousUsageReports").checked, false);
  assert.equal(document.getElementById("pref-extra-anonymousUsageReports").disabled, true);
  assert.equal(document.getElementById("pref-check-updates").disabled, true);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  const save = window.bridge.app.saveAll; let saves = 0;
  window.bridge.app.saveAll = async () => { saves++; return { ok: true }; };
  try { await app.handleCommand("file.saveAll"); assert.equal(saves, 1); }
  finally { window.bridge.app.saveAll = save; }
});

test("boot: a release without update services points Check for Updates to its releases page", async () => {
  const app = window.__lettrine, maintenance = app.maintenance, open = window.bridge.shell.openExternal, opened = [];
  app.maintenance = { updates: false, reporting: false, releasesURL: "https://github.com/example/lettrine/releases" };
  window.bridge.shell.openExternal = async (payload) => { opened.push(payload.url); return { ok: true }; };
  try {
    await app.handleCommand("file.preferences");
    assert.equal(document.querySelector('#preferences-dialog [data-pref-group="general-maintenance"]').hidden, true);
    assert.equal(document.getElementById("pref-maintenance-reports").hidden, true);
    assert.equal(document.getElementById("pref-maintenance-unavailable").hidden, true);
    assert.equal(document.getElementById("pref-maintenance-releases").hidden, false);
    assert.equal(document.getElementById("pref-privacy").hidden, true);
    assert.equal(document.getElementById("pref-check-updates").disabled, false);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await app.handleCommand("app.checkUpdates");
    assert.deepEqual(opened, ["https://github.com/example/lettrine/releases"]);
  } finally { app.maintenance = maintenance; window.bridge.shell.openExternal = open; }
});
