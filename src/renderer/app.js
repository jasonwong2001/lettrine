// Lettrine renderer bootstrap — wires the editor, UI, bridge, settings,
// autosave, and menu commands together.
// Command vocabulary mirrors the native menus.

import { Editor, ensureCodeMirror } from "./editor.js";
import { indentList } from "./editor-input.js";
import { headingSlug, linkMarkdown } from "../core/links.js";
import { importFormat, importDefaultPath } from "../core/imports.js";
import { isMarkdownExtension } from "../core/documents.js";
import { imageSnapshot, applyImageChanges, formatImages, manageImages, pasteSourceImage } from "./image-tools.js";
import { codeOptions } from "../core/code-tools.js";
import { codeKeyMap, formatCodeInApp } from "./code-tools.js";
import { bindSourceCodeCompletion, hideCodeCompletion } from "./code-completion.js";
import { bindSourceMarkdownPairs } from "./writing-options.js";
import { defaultExtension, saveLineEnding } from "../core/writing-options.js";
import { readableMarkdown } from "../core/readable.js";
import { imageCopyPayload } from "./copy-image.js";
import { copySpecial, specialCopyPayload } from "./clipboard-tools.js";
import { runSelectionCommand } from "./selection-tools.js";
import { exportOptions, exportDestination, EXPORT_EXTENSIONS } from "./export-options.js";
import { bindSpellSuggestions, initDictionaryPreferences, loadDictionaryPreferences, saveDictionaryPreferences } from "./spelling.js";
import { initExtraPreferences, loadExtraPreferences, extraPreferencesPatch } from "./preferences-extra.js";
import { initShortcutPreferences, loadShortcutPreferences, shortcutPreferencesPatch } from "./shortcut-preferences.js";
import { initLocalization, localizeUI, initLocalePreference, loadLocalePreference } from "./localization.js";
import { openRecovery } from "./recovery.js";
import { showHelp } from "./help.js";
import {
  formatBold, formatItalic, formatStrike, formatHighlight, formatCode, formatUnderline, formatSubscript, formatSuperscript,
  formatLink, formatMath,
  setHeading, headingUp, headingDown,
  insertHr, insertTOC, insertCodeBlock, insertQuote, insertTable, toggleTask, tableAddRow, moveTableRow,
  toggleList, toggleQuote, toggleCodeFence, toggleMathBlock, setAlert,
  deleteRow, jumpToSelection,
  clearFormat, insertImage,
} from "./editor-ops.js";
import {
  initUI, notify, updateWordCount,
  openSearchpanel, closeSearchpanel,
  openQO, closeQO,
  openTableDialog, closeTableDialog,
  initContextMenu, confirmChoice, promptText, showMenu, activeModal,
  setDocumentTitle, renderFileList, resetLibrarySearch, toggleOutline, focusLibrarySearch, showSidebar, setSidebarMode, applySidebarSettings,
  publishViewState, afterLayoutChange, syncAppearance, refreshSearchHighlights, refreshShortcutLabels,
  renderOutlinePublic, updateOutlineCurrent, toggleDocumentToolbar, toggleZoomPopover } from "./ui.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const DEFAULT_THEME = "lettrine", DEFAULT_DARK_THEME = "lettrine-dark";
const THEME_TITLES = { lettrine: "Lettrine", "lettrine-dark": "Lettrine Dark" };

const WELCOME_DOCUMENT = `# Welcome to Lettrine

Write Markdown and it renders as you type. Syntax such as **bold**, *italic* and \`code\` stays visible while you are editing it.

- [x] Open this document
- [ ] Press **⌘/** to see its Markdown source, and again to come back
- [ ] Press **⇧⌘O** to jump to any file, or **⇧⌘F** to search a folder

> Open a folder from the sidebar to keep your notes together. You can find this guide again under **Help → Welcome Guide**.
`;

const app = {
  file: null,
  folder: null,
  theme: DEFAULT_THEME,
  settings: {},
  editor: null,
  recentFiles: [],
  recentFolders: [],
  files: [],
  sort: null,
  fileView: "tree",
  _autosaveTimer: null,
  _dirty: false,
  _lastSave: 0,
  _savedText: "",
  _documentId: 0,
  _writeQueue: Promise.resolve(),
  _booted: false,
};
let finishBoot;
app.ready = new Promise((resolve) => { finishBoot = resolve; });
window.__lettrine = app;

function createEditor() {
  const editor = new Editor({
    root: $("#write"),
    onChange: () => {
      markDirty();
      renderOutlineSoon();
    },
    onCaret: () => updateWritingModes(),
  });
  app.editor = editor;
  const source = $("#app-source");
  for (const type of ["beforeinput", "paste", "cut", "drop"]) source.addEventListener(type, (event) => {
    if (!editor.guardReadOnly()) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  source.addEventListener("keydown", (event) => {
    if (!editor.readOnly || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length !== 1 && !["Enter", "Backspace", "Delete"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation(); editor.guardReadOnly();
  }, true);
  const filesFrom = (event) => Array.from(event.dataTransfer?.files || []).map((file) => window.bridge.path.forFile(file)).filter(Boolean);
  const sidebar = $("#app-sidebar");
  sidebar.addEventListener("dragover", (event) => event.preventDefault());
  sidebar.addEventListener("drop", (event) => { event.preventDefault(); void handleSidebarDrop(filesFrom(event), event.target); });
  source.addEventListener("drop", (event) => {
    const paths = filesFrom(event);
    if (!paths.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void handleSourceDrop(paths);
  }, true);
  return editor;
}

export async function importDocument(sourcePath = null, options = {}) {
  if (!app.editor || app.editor.guardReadOnly() || activeModal() || app._importing) return false;
  app._importing = true;
  try {
    const result = await window.bridge.document.import({ ...options, ...(sourcePath ? { sourcePath, defaultPath: importDefaultPath(sourcePath, options.directory) } : {}), pandocPath: options.pandocPath ?? app.settings.pandocPath });
    if (result?.canceled) return false;
    if (!result?.ok || !result.path) throw new Error(result?.error || i18nT("The file could not be imported."));
    if (options.open !== false) await window.bridge.window.newTab({ path: result.path });
    if (result.warnings) notify(i18nT("Imported with warnings:") + " " + result.warnings);
    return result;
  } catch (error) {
    if (/Pandoc/.test(error.message)) {
      const choice = await confirmChoice("Pandoc is required to import this format.", ["Cancel", "Settings…"], { detail: error.message });
      if (choice === "Settings…") { openPreferences(); setPrefPane("export"); }
    } else notify(i18nT("Import failed:") + " " + error.message, [], { kind: "error" });
    return false;
  } finally { app._importing = false; }
}

export async function handleSidebarDrop(paths, target) {
  if (app.editor.guardReadOnly() || activeModal()) return;
  let folder = app._libraryRoot;
  const row = target?.closest?.("[data-path]");
  if (row?.dataset.path) {
    try { const info = await window.bridge.path.stat({ path: row.dataset.path }); folder = info.isDirectory ? row.dataset.path : row.dataset.path.replace(/\/[^/]+$/, ""); }
    catch { /* use the library's folder */ }
  }
  for (const path of paths) {
    if (app.editor.readOnly) return;
    if (importFormat(path)) {
      if (app.settings.sidebarFileDrop !== "ignore") await app.importDocument(path, { directory: folder });
    } else {
      try {
        const info = await window.bridge.path.stat({ path });
        if (info.isDirectory) await app.openFolder(path);
        else if (isMarkdownExtension(path)) await window.bridge.window.newTab({ path });
      } catch (error) { notify(i18nT("Import failed:") + " " + error.message, [], { kind: "error" }); }
    }
  }
}

export async function handleSourceDrop(paths) {
  if (app.editor.guardReadOnly() || activeModal()) return;
  const original = documentText(), id = app._documentId, cm = app._sourceCM, textarea = $("#source-editor");
  const start = cm ? cm.indexFromPos(cm.getCursor("from")) : textarea.selectionStart;
  const end = cm ? cm.indexFromPos(cm.getCursor("to")) : textarea.selectionEnd;
  const references = [], imports = [];
  try {
    for (const path of paths) {
      if (importFormat(path) && app.settings.editorFileDrop === "import") { imports.push(path); continue; }
      const image = /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(path);
      const result = image ? await window.bridge.images.import({ sourcePath: path, docPath: app.file }) : await window.bridge.path.reference({ path, docPath: app.file });
      if (!result.canceled) references.push((image ? "!" : "") + linkMarkdown(image ? "" : path.split("/").at(-1), result.reference).source);
    }
    if (app.editor.readOnly || id !== app._documentId || original !== documentText()) return;
    if (references.length) {
      const text = references.join("\n\n");
      if (cm) { cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(end)); cm.replaceSelection(text, "end", "+input"); cm.focus(); }
      else { textarea.setRangeText(text, start, end, "end"); textarea.dispatchEvent(new Event("input", { bubbles: true })); }
    }
    for (const path of imports) if (!app.editor.readOnly) await app.importDocument(path);
  } catch (error) { notify(i18nT("Import failed:") + " " + error.message, [], { kind: "error" }); }
}

function markDirty() {
  app._dirty = documentText() !== app._savedText;
  void window.bridge.session?.changed().catch(() => {});
  setTitle();
  updateWordCount(app.editor);
  refreshSearchHighlights();
  const sec = app.settings.autosaveSec ?? 2;
  clearTimeout(app._autosaveTimer);
  if (!app._dirty || !app.file || app._removedPath || app.editor.readOnly || app._diskPrompt || !app.settings.autosave || document.body.classList.contains("oversize")) return;
  const id = app._documentId;
  app._autosaveTimer = setTimeout(() => {
    if (id === app._documentId) void app.save(true);
  }, sec * 1000);
}

// push this document's name/dirty state to main (drives the tab bar and
// window title, the same role our native titlebar text serves)
function pushTabState() {
  const name = app.file ? app.file.split("/").pop() : untitledName();
  const state = { name, path: app._removedPath ? null : app.file, dirty: app._dirty, askToCloseUnsaved: app.settings.askToCloseUnsaved !== false };
  const key = JSON.stringify(state);
  if (key === app._tabStateKey) return;
  app._tabStateKey = key;
  window.bridge.tab?.state(state);
}

let _outlineTimer = null;
function renderOutlineSoon() {
  clearTimeout(_outlineTimer);
  _outlineTimer = setTimeout(() => {
    renderOutlinePublic();
  }, 200);
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

// The active language's text for an English interface string.
export function i18nT(key, fallback) {
  return app.i18n?.strings?.[key] ?? fallback ?? key;
}

export function untitledName() {
  return i18nT("Untitled", "Untitled");
}

export function setTitle() {
  const name = app.file ? app.file.split("/").pop() : untitledName();
  const readonly = app.editor?.readOnly, dirty = app._dirty && !readonly;
  const title = (dirty ? "● " : "") + name + " — Lettrine";
  if (document.title !== title) document.title = title;
  setDocumentTitle({ name, dirty, status: readonly ? i18nT("Readonly Mode") : dirty ? i18nT("Edited") : "" });
  pushTabState();
}

// Documents larger than this are not rendered.
const MAX_FILE_SIZE = 2e6;

function documentText() {
  if (document.body.classList.contains("sourceview-on")) {
    return app._sourceCM ? app._sourceCM.getValue() : $("#source-editor").value;
  }
  return app.editor.getMarkdown();
}

export function captureSession() {
  const source = document.body.classList.contains("sourceview-on"), cm = app._sourceCM;
  const textarea = $("#source-editor"), scroller = $("#md-content");
  const selection = source ? cm ? {
    start: cm.indexFromPos(cm.getCursor("from")), end: cm.indexFromPos(cm.getCursor("to")),
    backward: cm.indexFromPos(cm.getCursor("anchor")) > cm.indexFromPos(cm.getCursor("head")),
  } : { start: textarea.selectionStart, end: textarea.selectionEnd, backward: textarea.selectionDirection === "backward" } : app.editor.selectionOffsets();
  const text = documentText(), dirty = text !== app._savedText;
  return {
    path: app.file, ...(dirty || !app.file ? { text, savedText: app._savedText } : {}),
    dirty, library: app._libraryRoot || null, source, readonly: !!app.editor.readOnly, sidebarView: app.sidebarView,
    selection, scroll: source ? cm ? cm.getScrollInfo().top : textarea.scrollTop : scroller.scrollTop,
    lineEnding: app._lineEnding, lineEndingOverride: app._lineEndingOverride,
  };
}

export async function restoreSession(state) {
  let disk = null;
  if (typeof state.path === "string") {
    try { disk = await window.bridge.document.read({ path: state.path }); } catch { /* Recover a cached draft when its file is missing. */ }
  }
  if (typeof state.text !== "string" && disk?.size > MAX_FILE_SIZE) {
    await loadFile(disk.path);
    if (state.recoveredDraft) notify("A saved draft exceeds the editor limit and was recovered to a Markdown file.", [], { kind: "error" });
    return;
  }
  const text = typeof state.text === "string" ? state.text : disk?.text;
  if (typeof text !== "string") {
    resetDocument("");
    notify("A file from the previous session is no longer available.", [], { kind: "error" });
    return;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_SIZE) {
    throw new Error(i18nT("The session document is too large to restore."));
  }
  const path = disk?.path || null;
  resetDocument(text, path);
  const detectedEnding = /\r\n/.test(text) ? "CRLF" : "LF";
  app._lineEnding = typeof state.text !== "string" || !["CRLF", "LF"].includes(state.lineEnding) ? detectedEnding : state.lineEnding;
  app._lineEndingOverride = ["preserve", "LF", "CRLF", ""].includes(state.lineEndingOverride) ? state.lineEndingOverride : "";
  app._savedText = typeof state.savedText === "string" ? state.savedText : disk ? app.editor.getMarkdown() : "";
  if (!path && typeof state.path === "string") app._savedText = "";
  app._dirty = app.editor.getMarkdown() !== app._savedText;
  if (typeof state.library === "string") await openFolder(state.library, { quiet: true }).catch(() => {});
  else if (app._libraryRoot) closeFolder();
  app.folder = app._libraryRoot || (path ? path.replace(/\/[^/]+$/, "") : null);
  if (["tree", "articles", "outline"].includes(state.sidebarView)) setSidebarMode(state.sidebarView);
  else if (state.sidebarView === "search") setSidebarMode(app.fileView === "list" ? "articles" : "tree");
  if (state.source && !document.body.classList.contains("sourceview-on")) toggleSource();
  const length = app.editor.getMarkdown().length, selection = state.selection || {};
  const start = Math.max(0, Math.min(length, Number(selection.start) || 0)), end = Math.max(start, Math.min(length, Number(selection.end) || start));
  if (app._sourceCM) {
    app._sourceCM.setSelection(app._sourceCM.posFromIndex(selection.backward ? end : start), app._sourceCM.posFromIndex(selection.backward ? start : end)); app._sourceCM.focus();
  } else if (document.body.classList.contains("sourceview-on")) {
    const textarea = $("#source-editor"); textarea.setSelectionRange(start, end, selection.backward ? "backward" : "forward"); textarea.focus();
  } else { app.editor.root.focus(); app.editor.selectOffsets(start, end, !!selection.backward); }
  if (!!state.readonly !== app.editor.readOnly) toggleReadonly();
  const scroll = Math.max(0, Number(state.scroll) || 0);
  const id = app._documentId;
  const restoreScroll = () => {
    if (app._documentId !== id) return;
    if (app._sourceCM) app._sourceCM.scrollTo(null, scroll);
    else if (document.body.classList.contains("sourceview-on")) $("#source-editor").scrollTop = scroll;
    else $("#md-content").scrollTop = scroll;
  };
  // Background windows may suspend animation frames indefinitely.
  restoreScroll(); requestAnimationFrame(restoreScroll);
  if (app._dirty && typeof disk?.text === "string" && typeof state.savedText === "string" && disk.text.replace(/\r\n?/g, "\n") !== state.savedText) {
    // Keep externally changed files independent from the recovered draft.
    app.file = null; app.editor.setDocumentPath(null);
    await window.bridge.document.markOpen({ path: null });
    notify("The file changed while Lettrine was closed. Your draft was restored as an untitled document.", [], { kind: "error" });
  }
  setTitle(); publishViewState(); renderOutlineSoon();
}

async function presentUpdate(result) {
  const choice = await confirmChoice(i18nT("A new version of Lettrine is available:") + " " + result.version, ["Later", "Open Download Page"]);
  if (choice === "Open Download Page") await window.bridge.shell.openExternal({ url: result.url });
}

async function checkForUpdates() {
  // A release without an update feed points to its releases page instead.
  if (!app.maintenance?.updates && app.maintenance?.releasesURL) {
    try { await window.bridge.shell.openExternal({ url: app.maintenance.releasesURL }); }
    catch (error) { notify(error.message, [], { kind: "error" }); }
    return;
  }
  try {
    const result = await window.bridge.app.checkUpdates();
    if (result.status === "update") await presentUpdate(result);
    else notify("Lettrine is up to date.");
  } catch (error) { notify(i18nT("Update check failed:") + " " + error.message, [], { kind: "error" }); }
}

function leaveSource() {
  if (document.body.classList.contains("sourceview-on")) toggleSource();
}

async function confirmUnsavedChanges() {
  if (app._dirty && app.file && app.settings.saveOnSwitch && !app.editor.readOnly) return !!(await app.save(false)) && !app._dirty;
  if (app.settings.askToCloseUnsaved === false) return true;
  if (!app._dirty) return true;
  const name = app.file ? app.file.split("/").pop() : untitledName();
  const choice = await confirmChoice(`Save changes to “${name}” before continuing?`, ["Save", "Don't Save", "Cancel"]);
  if (choice === "Don't Save") return true;
  if (choice === "Save") {
    if (app.editor.readOnly) toggleReadonly();
    return !!(await save(false)) && !app._dirty;
  }
  return false;
}

function resetDocument(text, path = null) {
  const closedPath = app.file;
  clearTimeout(app._autosaveTimer);
  clearTimeout(app._srcTimer);
  leaveSource();
  exitOversize();
  app._documentId++;
  app._lineEnding = /\r\n/.test(text) ? "CRLF" : "LF";
  app._lineEndingOverride = "";
  app.file = path;
  app._removedPath = null;
  app.editor.setText(text, { docBase: path });
  app._savedText = app.editor.getMarkdown();
  app._dirty = false;
  updateWordCount(app.editor);
  renderOutlineSoon();
  window.bridge.document.markOpen({ path, closedPath }).catch(() => {});
  setTitle();
  publishViewState();
}

export function enterOversize(size) {
  document.body.classList.add("oversize");
  const el = $("#ic-oversize-body");
  if (el) el.style.display = "";
  const detail = $("#ic-oversize-detail");
  if (detail) detail.textContent = (size ? `This file is ${(size / 1e6).toFixed(1)} MB. ` : "") + "Lettrine edits Markdown files up to 2 MB. Open it in another app, or close it.";
  publishViewState();
}
export function exitOversize() {
  document.body.classList.remove("oversize");
  const el = $("#ic-oversize-body");
  if (el) el.style.display = "none";
  publishViewState();
}

export async function openFile(path, line) {
  if (!path || app._opening) return false;
  if (app.file === path) {
    if (line) app.editor.gotoLine(line);
    return true;
  }
  app._opening = true;
  try { return await loadFile(path, line); }
  catch (err) { notify("Open failed: " + (err?.message || err), [], { kind: "error" }); return false; }
  finally { app._opening = false; }
}

async function loadFile(path, line) {
  const res = await window.bridge.document.read({ path });
  if (!res || res.error) {
    notify(res?.error || "The file could not be opened.", [], { kind: "error" });
    return false;
  }
  if (!await confirmUnsavedChanges()) return false;
  resetDocument("", res.path);
  app.folder = app._libraryRoot || res.path.replace(/\/[^/]+$/, "");
  if ((res.size ?? new TextEncoder().encode(res.text || "").byteLength) > MAX_FILE_SIZE) {
    app.editor.setText(""); // don't render an oversized document
    app._dirty = false;
    enterOversize(res.size);
    setTitle();
    pushTabState();
    renderFileListSoon();
    return true;
  }
  exitOversize();
  app.editor.setText(res.text, { docBase: res.path });
  app._lineEnding = /\r\n/.test(res.text) ? "CRLF" : "LF";
  app._savedText = app.editor.getMarkdown();
  app._dirty = false;
  setTitle();
  pushTabState();
  app.editor.focus();
  if (line && app.editor.gotoLine) app.editor.gotoLine(line);
  if (app.settings.sourceByDefault && !document.body.classList.contains("sourceview-on")) toggleSource();
  await window.bridge.quickOpen.cacheRecentFiles({ paths: [res.path] }).catch(() => {});
  app.recentFiles = (app.recentFiles || []).filter((f) => f.path !== res.path);
  app.recentFiles.unshift({ name: res.path.split("/").pop(), path: res.path });
  app.recentFiles = app.recentFiles.slice(0, 16);
  renderFileListSoon();
  updateWordCount(app.editor);
  renderOutlineSoon();
  return true;
}

export async function newDocument() {
  if (!await confirmUnsavedChanges()) return false;
  resetDocument("");
  renderFileListSoon();
  app.editor.focus();
  if (app.settings.sourceByDefault && !document.body.classList.contains("sourceview-on")) toggleSource();
  return true;
}

export async function save(quiet) {
  if (app.editor.readOnly) { if (!quiet) app.editor.guardReadOnly(); return false; }
  if (document.body.classList.contains("oversize")) return false;
  if (quiet && app._diskPrompt) return false;
  if (!app.file || app._removedPath) return quiet ? false : app.saveAs();
  prepareSave();
  return writeDocument(app.file, documentText(), app._documentId, quiet);
}

function prepareSave() {
  const text = documentText();
  if (!app.settings.finalNewLine || text.endsWith("\n")) return;
  if (document.body.classList.contains("sourceview-on")) {
    if (app._sourceCM) {
      const cm = app._sourceCM, selection = cm.listSelections();
      cm.replaceRange("\n", cm.posFromIndex(text.length), null, "save-format");
      cm.setSelections(selection);
    } else {
      const textarea = $("#source-editor"), start = textarea.selectionStart, end = textarea.selectionEnd;
      textarea.value += "\n"; textarea.setSelectionRange(start, end); syncSource(null, { origin: "save-format" });
    }
  } else {
    const selection = app.editor.selectionOffsets();
    app.editor.replaceRange(text.length, text.length, "\n", { inputType: "save-format" });
    if (selection) app.editor.selectOffsets(selection.start, selection.end, selection.backward);
  }
}

function writeDocument(path, text, id, quiet, saveAsPath = false) {
  clearTimeout(app._autosaveTimer);
  const work = async () => {
    if (id !== app._documentId || app.editor.readOnly) return false;
    try {
      const ending = saveLineEnding(app.settings, app._lineEnding, app._lineEndingOverride);
      const final = ending === "CRLF" ? text.replace(/\r?\n/g, "\r\n") : text.replace(/\r\n/g, "\n");
      const res = await window.bridge.document.write({ path, text: final, followRenames: !saveAsPath });
      if (!res || res.error || res.ok === false) throw new Error(res?.error || "Could not write the document");
      if (id !== app._documentId) return true;
      if (saveAsPath) {
        app._removedPath = null;
        app.file = path;
        app.folder = app._libraryRoot || path.replace(/\/[^/]+$/, "");
        app.editor.docBase = path;
        for (const block of app.editor.blocks) block.__docBase = path;
        await window.bridge.document.markOpen({ path }).catch(() => {});
      }
      if (app.file === (res.path || path)) {
        app._savedText = text;
        app._dirty = documentText() !== text;
        app._lastSave = Date.now();
        app._lineEnding = ending;
        setTitle();
      }
      return true;
    } catch (err) {
      notify("Save failed: " + (err?.message || err), [], { kind: "error" });
      return false;
    }
  };
  const pending = app._writeQueue.then(work, work);
  app._writeQueue = pending;
  return pending;
}

export async function saveAs() {
  if (app.editor.guardReadOnly()) return false;
  if (document.body.classList.contains("oversize")) return false;
  if (app._saveAsPromise) return app._saveAsPromise;
  app._saveAsPromise = performSaveAs();
  try { return await app._saveAsPromise; }
  finally { app._saveAsPromise = null; }
}

async function performSaveAs() {
  const id = app._documentId;
  const name = app.file ? app.file.split("/").pop() : untitledName() + "." + defaultExtension(app.settings);
  let res;
  try { res = await window.bridge.window.save({ defaultName: name, lineEndings: app._lineEndingOverride === "preserve" ? "" : app._lineEndingOverride || app.settings.lineEndings || "" }); }
  catch (err) { notify("Save failed: " + (err?.message || err), [], { kind: "error" }); return false; }
  if (!res || res.canceled || !res.path || id !== app._documentId || app.editor.readOnly) return false;
  if (["", "LF", "CRLF"].includes(res.lineEndings)) app._lineEndingOverride = res.lineEndings || "preserve";
  prepareSave();
  if (!await writeDocument(res.path, documentText(), id, false, true)) return false;
  pushTabState();
  app.recentFiles = (app.recentFiles || []).filter((f) => f.path !== res.path);
  app.recentFiles.unshift({ name: res.path.split("/").pop(), path: res.path });
  app.recentFiles = app.recentFiles.slice(0, 16);
  renderFileListSoon();
  await window.bridge.quickOpen.cacheRecentFiles({ paths: [res.path] }).catch(() => {});
  return true;
}

let folderRequest = 0, folderRefresh = null;
export async function openFolder(path, { quiet = false } = {}) {
  const request = ++folderRequest;
  const res = path ? { canceled: false, path } : await window.bridge.window.openFolder();
  if (request !== folderRequest || !res || res.canceled || !res.path) return;
  // Finder can return /private/tmp while the file service uses /tmp. Keep the
  // root in the same form as its entries so the tree can match their paths.
  try { res.path = (await window.bridge.path.stat({ path: res.path })).path || res.path; }
  catch (error) { if (!quiet) notify("Could not open folder: " + error.message, [], { kind: "error" }); return; }
  if (request !== folderRequest) return;
  let files;
  try { files = await window.bridge.library.listDocsUnder({ path: res.path, setRoot: true }); }
  catch (error) { if (!quiet) notify("Could not open folder: " + error.message, [], { kind: "error" }); return; }
  if (request !== folderRequest) return;
  if (app._libraryRoot !== res.path) resetLibrarySearch();
  app.folder = res.path;
  app._libraryRoot = res.path;
  app.files = files || [];
  // The library is remembered for the next window and launch.
  if (app.settings.lastLibrary !== res.path) { app.settings.lastLibrary = res.path; persistSettings({ lastLibrary: res.path }); }
  void window.bridge.native?.invoke("native.recentFolder", { path: res.path }).then(() => window.bridge.library.recentFolders()).then((folders) => { if (Array.isArray(folders)) app.recentFolders = folders; }).catch(() => {});
  if (!quiet) showSidebar();
  renderFileListSoon();
}

export function closeFolder() {
  ++folderRequest;
  resetLibrarySearch();
  app._libraryRoot = null;
  app.files = [];
  app.folder = app.file ? app.file.replace(/\/[^/]+$/, "") : null;
  app.settings.lastLibrary = null;
  void window.bridge.library.closeFolder?.().catch(() => {});
  persistSettings({ lastLibrary: null });
  renderFileListSoon();
}

function renderFileListSoon() {
  renderFileList();
}

export async function refreshFolder() {
  return refreshFolderQuiet();
}

// quiet refresh from the folder monitor and file operations
export async function refreshFolderQuiet() {
  const root = app._libraryRoot;
  if (!root) return;
  const request = folderRequest;
  if (folderRefresh?.root === root && folderRefresh.request === request) {
    folderRefresh.again = true;
    return folderRefresh.promise;
  }
  const refresh = { root, request, again: false };
  folderRefresh = refresh;
  refresh.promise = (async () => {
    do {
      refresh.again = false;
      const files = await window.bridge.library.listDocsUnder({ path: root });
      if (request !== folderRequest || root !== app._libraryRoot) return;
      app.files = files || [];
      renderFileListSoon();
    } while (refresh.again);
  })().finally(() => { if (folderRefresh === refresh) folderRefresh = null; });
  return refresh.promise;
}

// A file changed on disk under an external editor: prompt to reload,
// keeping the current content on the undo timeline so it can be recovered.
export async function handleDiskChanged(payload) {
  const p = payload?.path;
  if (!p || p !== app.file || app._diskPrompt || document.body.classList.contains("oversize")) return;
  const id = app._documentId;
  let res;
  try { res = await window.bridge.document.read({ path: p }); } catch { return; }
  const cur = documentText();
  if (res.text === cur) return; // nothing actually changed
  clearTimeout(app._autosaveTimer);
  app._diskPrompt = true;
  try {
    const choice = await confirmChoice(
      `“${p.split("/").pop()}” changed in another application.`,
      ["Reload", "Keep My Version"],
      { detail: "Reload it to see the latest version. You can undo the reload with Edit → Undo." });
    if (id !== app._documentId || p !== app.file) return;
    if (choice === "Reload") {
      leaveSource();
      app.editor.pushHistory(); // current content becomes undoable
      app.editor.setText(res.text, { docBase: res.path, resetHistory: false });
      app.editor.pushHistory();
      app._savedText = app.editor.getMarkdown();
      app._dirty = false;
      updateWordCount(app.editor);
      setTitle();
      pushTabState();
    } else {
      app._savedText = res.text;
      app._dirty = documentText() !== res.text;
      setTitle();
    }
  } finally { app._diskPrompt = false; }
}

// New files go next to the current document when it belongs to the library,
// otherwise into the library's top folder.
export async function newFile(folder = null) {
  if (app.editor.guardReadOnly()) return;
  if (!app._libraryRoot) { await app.openFolder(null); if (!app._libraryRoot) return; }
  const root = app._libraryRoot.replace(/\/+$/, "");
  const current = app.file && app.file.startsWith(root + "/") ? app.file.replace(/\/[^/]+$/, "") : root;
  const target = (folder || current).replace(/\/+$/, "");
  const extension = defaultExtension(app.settings);
  const name = await promptText({ title: target === root ? "New File" : `New File in “${target.split("/").pop()}”`, value: "Untitled." + extension, confirm: "Create", selectStem: true });
  if (!name || app.editor.guardReadOnly()) return;
  const path = target + "/" + (/\.[^/.]+$/.test(name) ? name : name + "." + extension);
  const res = await window.bridge.library.newFile({ path });
  if (res && res.error) { notify(res.error, [], { kind: "error" }); return; }
  await refreshFolderQuiet();
  await app.openFile(path);
}

export function fileContextMenu(file, x, y) {
  const isDir = !!file.isDirectory;
  const mutate = (run) => async () => { if (!app.editor.guardReadOnly()) return run(); };
  const rename = async () => {
    if (app.editor.guardReadOnly()) return;
    const name = await promptText({ title: "Rename", value: file.name, confirm: "Rename", selectStem: !isDir });
    if (!name || name === file.name || app.editor.guardReadOnly()) return;
    const result = await window.bridge.library.renameFile({ from: file.path, name });
    if (result?.error) { notify(result.error, [], { kind: "error" }); return; }
    await refreshFolderQuiet();
  };
  const trash = async () => {
    if (app.editor.guardReadOnly()) return;
    await window.bridge.library.trashItem({ path: file.path });
    await refreshFolderQuiet();
    notify(`Moved “${file.name}” to the Trash`, [{ label: "Undo", onClick: () => fileUndo() }]);
  };
  return showMenu([
    { label: i18nT("Open"), run: () => isDir ? app.openFolder(file.path) : app.openFile(file.path) },
    isDir ? null : { label: i18nT("Open in New Window"), run: () => window.bridge.window.openInNewWindow({ path: file.path }) },
    { separator: true },
    isDir ? { label: i18nT("New File in Folder…"), run: () => newFile(file.path) } : { label: i18nT("Duplicate"), run: mutate(async () => { await window.bridge.library.duplicate({ path: file.path }); await refreshFolderQuiet(); }) },
    { label: i18nT("Rename…"), run: rename },
    { label: i18nT("Move To…"), run: mutate(async () => { await window.bridge.path.moveTo({ from: file.path }); await refreshFolderQuiet(); }) },
    { label: i18nT("Copy To…"), run: mutate(() => window.bridge.path.copyTo({ from: file.path })) },
    { separator: true },
    { label: i18nT("Reveal in Finder"), run: () => window.bridge.path.showInFinder({ path: file.path }) },
    { label: i18nT(isDir ? "Copy Path" : "Copy File Path"), run: () => window.bridge.clipboard.write({ text: file.path }) },
    { separator: true },
    { label: i18nT("Move to Trash"), destructive: true, run: trash },
  ], { x: x || 60, y: y || 120 });
}

// ---------------------------------------------------------------------------
// view modes
// ---------------------------------------------------------------------------

export function toggleReadonly() {
  const enabled = !app.editor.readOnly, source = document.body.classList.contains("sourceview-on");
  if (enabled) {
    app._readonlySourceSelection = source ? app._sourceCM?.listSelections() || { start: $("#source-editor").selectionStart, end: $("#source-editor").selectionEnd } : null;
    app._readonlyDocumentId = app._documentId;
    clearTimeout(app._autosaveTimer);
  }
  app.editor.setReadOnly(enabled);
  document.body.classList.toggle("readonly-on", enabled);
  $("#source-editor").readOnly = enabled;
  app._sourceCM?.setOption("readOnly", enabled);
  if (!enabled && source) {
    const selection = app._readonlyDocumentId === app._documentId ? app._readonlySourceSelection : null;
    if (app._sourceCM) {
      if (Array.isArray(selection)) app._sourceCM.setSelections(selection);
      else if (selection) app._sourceCM.setSelection(app._sourceCM.posFromIndex(selection.start), app._sourceCM.posFromIndex(selection.end));
      app._sourceCM.focus();
    } else {
      if (selection && !Array.isArray(selection)) $("#source-editor").setSelectionRange(selection.start, selection.end);
      $("#source-editor").focus();
    }
  }
  publishViewState();
  if (enabled) setTitle(); else markDirty();
  notify(enabled ? "Readonly mode is on. Turn it off to edit." : "Readonly mode is off.");
}

export function toggleSidebar() {
  document.body.classList.toggle("sidebar-hidden");
  app.settings.sidebarVisible = !document.body.classList.contains("sidebar-hidden");
  persistSettings({ sidebarVisible: app.settings.sidebarVisible });
  afterLayoutChange();
}

export function toggleSource() {
  hideCodeCompletion();
  const previewScrollTop = app.editor.root.parentElement.scrollTop;
  // body.sourceview-on carries the source view's CSS; #app-source's inline
  // z-index:-1 is lifted to 2 while the view is shown
  const on = document.body.classList.toggle("sourceview-on");
  publishViewState();
  const src = $("#app-source");
  src.style.zIndex = on ? "2" : "-1";
  if (on) {
    app._previewScrollTop = previewScrollTop;
    app.editor.root.parentElement.scrollTop = 0;
    const ta = $("#source-editor");
    ta.readOnly = app.editor.readOnly;
    clearTimeout(app._srcTimer);
    app._srcTimer = null;
    ta.value = app.editor.getMarkdown();
    const sourceCaret = app.editor.globalIndexOfCaret();
    ta.setSelectionRange(sourceCaret, sourceCaret);
    ta.focus();
    ta.oninput = () => {
      if (document.body.classList.contains("sourceview-on") && !app._sourceCM) syncSource();
    };
    // the source editor is a CodeMirror (theme app-default); it mounts once
    // CodeMirror has loaded, and the plain textarea is the fallback
    ensureCodeMirror().then((CM) => {
      if (!CM || app._sourceCM || !document.body.classList.contains("sourceview-on")) return;
      const fallbackSelection = { start: ta.selectionStart, end: ta.selectionEnd, backward: ta.selectionDirection === "backward" }, fallbackScroll = ta.scrollTop;
      const cm = CM.fromTextArea(ta, {
        readOnly: app.editor.readOnly,
        lineWrapping: true,
        // CodeMirror's "markdown" mode; its "gfm" mode needs extra addons
        mode: "markdown",
        theme: "app-default",
        styleSelectedText: true,
        styleActiveLine: true,
        lineNumbers: false,
        autoCloseBrackets: app.settings.autoPair !== false,
        tabSize: app.settings.tabSize || 4,
        indentUnit: app.settings.tabSize || 4,
        indentWithTabs: !!app.settings.indentWithTabs,
        dragDrop: false,
        extraKeys: codeKeyMap(app.editor, () => app.settings, true),
      });
      app._sourceCM = cm;
      cm.on("beforeChange", (_, change) => { if (app.editor.readOnly) change.cancel(); });
      cm.on("change", syncSource);
      cm.on("cursorActivity", () => { updateWordCount(app.editor); updateOutlineCurrent(); });
      bindSourceCodeCompletion(app, cm);
      bindSourceMarkdownPairs(app, cm);
      // carry the editor caret into the source view: block → start line,
      // intra-block newlines add lines, block start offset adds 0
      try {
        cm.setSelection(cm.posFromIndex(fallbackSelection.backward ? fallbackSelection.end : fallbackSelection.start), cm.posFromIndex(fallbackSelection.backward ? fallbackSelection.start : fallbackSelection.end));
      } catch { /* keep cursor at start */ }
      cm.focus();
      cm.scrollTo(null, fallbackScroll);
    }).catch((e) => { console.error("[source-cm]", e); /* textarea fallback */ });
  } else {
    // restore the caret to the source cursor's position before switching:
    // line → block, column → offset (fallback: end of document)
    const cm = app._sourceCM;
    const ta = $("#source-editor");
    let value = ta.value;
    let lineNo = 0;
    let col = 0;
    if (cm) {
      value = cm.getValue();
      const cur = cm.getCursor();
      lineNo = cur.line;
      col = cur.ch;
      try { cm.toTextArea(); } catch { /* torn down */ }
      app._sourceCM = null;
      ta.value = value;
    } else {
      const upto = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
      const lines = upto.split("\n");
      lineNo = lines.length - 1;
      col = lines[lines.length - 1].length;
    }
    const sourceOffset = value.split("\n").slice(0, lineNo).reduce((sum, line) => sum + line.length + 1, 0) + col;
    if (value !== app.editor.getMarkdown()) {
      app.editor.setText(value, { docBase: app.editor.docBase, resetHistory: false });
      app.editor.pushHistory();
      app.editor.emit();
    } else if (app.editor._renderPending) app.editor.renderAll();
    // map the source line to the block that starts at/above it (blocks
    // join with a blank line, so each block's start line is cumulative)
    app.editor.root.focus({ preventScroll: true });
    app.editor.selectOffsets(sourceOffset);
    app.editor.root.parentElement.scrollTop = app._previewScrollTop || 0;
  }
}

function syncSource(_, change) {
  if (app._imageRepairing) return;
  if (!document.body.classList.contains("sourceview-on")) return;
  const text = documentText();
  app.editor.setText(text, { docBase: app.file, resetHistory: false, render: false });
  app.editor.pushHistory({ inputType: /^(?:code-format|range-delete|save-format|markdown-pair|format-command)$/.test(change?.origin) ? "" : "insertText" });
  app.editor.emit();
}

export function toggleFocusMode() {
  document.body.classList.toggle("on-focus-mode");
  app.settings.focusMode = document.body.classList.contains("on-focus-mode");
  persistSettings({ focusMode: app.settings.focusMode });
  applyFocusMode();
  publishViewState();
}

let focusedBlock = null;
function applyFocusMode() {
  if (!document.body.classList.contains("on-focus-mode")) {
    focusedBlock?.classList.remove("md-current-block");
    focusedBlock = null;
    return;
  }
  const sel = window.getSelection();
  let el = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode) : null;
  while (el && el !== $("#write")) {
    if (el.parentElement === $("#write")) break;
    el = el.parentElement;
  }
  if (el && el !== $("#write") && el !== focusedBlock) {
    focusedBlock?.classList.remove("md-current-block");
    el.classList.add("md-current-block");
    focusedBlock = el;
  }
}

export function toggleTypewriter() {
  document.body.classList.toggle("typewriter-mode");
  app.settings.typewriter = document.body.classList.contains("typewriter-mode");
  persistSettings({ typewriter: app.settings.typewriter }); updateWritingModes();
  requestAnimationFrame(() => updateWritingModes());
  publishViewState();
}

function updateWritingModes() {
  applyFocusMode();
  const editor = app.editor;
  if (!editor || !document.body.classList.contains("typewriter-mode") || !document.hasFocus() || editor._composing || editor._mousePressed || !editor.root.contains(document.activeElement)) return;
  let rect;
  const cm = editor._activeCmBlock()?.cm;
  if (cm) rect = cm.charCoords(cm.getCursor(), "window");
  else { const selection = window.getSelection(); if (!selection?.isCollapsed || !selection.rangeCount) return; const range = selection.getRangeAt(0); if (!editor.root.contains(range.startContainer)) return; rect = range.getBoundingClientRect?.(); }
  if (!rect || rect.bottom <= rect.top) return;
  const scroller = editor.root.parentElement, bounds = scroller.getBoundingClientRect();
  const delta = (rect.top + rect.bottom) / 2 - bounds.top - scroller.clientHeight / 2;
  if (Math.abs(delta) > 2) scroller.scrollBy?.({ top: delta, behavior: "auto" });
}

function applyDocumentZoom() {
  const s = app.settings, html = document.documentElement, savedZoom = Number(s.zoomFactor);
  app.documentZoom = Number.isFinite(savedZoom) && savedZoom > 0 ? Math.max(0.5, Math.min(3, savedZoom)) : 1;
  html.style.fontSize = s.fontSize ? s.fontSize + "px" : "";
  // Keep WebKit and CodeMirror caret coordinates in unscaled CSS pixels.
  const baseFontSize = parseFloat(window.getComputedStyle(html).fontSize) || 16;
  if (app.documentZoom !== 1) html.style.fontSize = (baseFontSize * app.documentZoom) + "px";
  html.style.setProperty("--document-zoom", String(app.documentZoom));
}

function themeDidLoad() {
  applyDocumentZoom();
  app._sourceCM?.refresh();
  for (const block of app.editor?.root.children || []) block.__cm?.refresh();
  updateWritingModes(); syncAppearance();
}

export function applySettings() {
  const s = app.settings;
  if (app.editor) app.editor.__settings = s;
  // Appearance follows macOS unless the user picks Light or Dark.
  const background = s.background || "system";
  const systemDark = app.systemDark ?? !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const dark = background === "dark" || background === "system" && systemDark;
  app._darkAppearance = dark;
  setTheme(dark ? s.darkTheme || DEFAULT_DARK_THEME : s.theme || DEFAULT_THEME);
  applyDocumentZoom();
  if (typeof s.spellcheck === "boolean") $("#write").setAttribute("spellcheck", String(s.spellcheck));
  const write = $("#write");
  write.style.fontFamily = s.fontFamily || "";
  write.style.lineHeight = String(s.lineHeight || 1.6);
  write.style.maxWidth = ({ narrow: "640px", medium: "860px", wide: "1100px" })[s.pageWidth || "medium"];
  document.body.classList.toggle("collapse-soft-breaks", s.preserveBreaks === false);
  for (const [className, enabled] of Object.entries({ "hide-break-markers": s.hideBreakMarkers, "ignore-heading-breaks": s.ignoreHeadingBreaks, "indent-first-line": s.indentFirstLine, "no-code-wrap": s.wrapCode === false })) document.body.classList.toggle(className, !!enabled);
  app.editor._syncSimpleBlockFocus();
  document.body.classList.toggle("sidebar-hidden", s.sidebarVisible === false);
  document.documentElement.style.setProperty("--sidebar-width", Math.max(200, Math.min(480, s.sidebarWidth || 260)) + "px");
  const sortKey = JSON.stringify(s.librarySort || null);
  applySidebarSettings();
  if (app._sortKey !== sortKey) { app.sort = s.librarySort || null; app._sortKey = sortKey; renderFileListSoon(); }
  toggleDocumentToolbar(!!s.showDocumentToolbar, false);
  document.body.classList.toggle("on-focus-mode", !!s.focusMode);
  applyFocusMode();
  document.body.classList.toggle("typewriter-mode", !!s.typewriter);
  document.body.classList.toggle("word-count-hidden", s.wordCount === false);
  write.style.setProperty("--md-placeholder", JSON.stringify(i18nT("Start writing", "Start writing")));
  app.editor.setDocumentPath(app.file);
  app.editor._textReplacements = s.textReplacements || {};
  const renderKey = JSON.stringify([s.renderMath, s.numberEquations, s.subscriptSuperscript, s.renderDiagrams, s.fenceEditor, s.smartQuotes, s.smartDashes, s.smartEllipses, s.smartPunctuationMode, s.ignoreHeadingBreaks]);
  if (app._renderSettingsKey && app._renderSettingsKey !== renderKey) app.editor.renderAll({ full: true });
  app._renderSettingsKey = renderKey;
  if (app._sourceCM) for (const [option, value] of Object.entries({ autoCloseBrackets: s.autoPair !== false, tabSize: s.tabSize || 4, indentUnit: s.tabSize || 4, indentWithTabs: !!s.indentWithTabs })) app._sourceCM.setOption(option, value);
  for (const block of app.editor.root.children) if (block.__cm) {
    const indentation = block.getAttribute("mdtype") === "fences" ? codeOptions(s) : { tabSize: s.tabSize || 4, indentUnit: s.tabSize || 4, indentWithTabs: !!s.indentWithTabs };
    for (const [option, value] of Object.entries({ autoCloseBrackets: s.autoPair !== false, lineNumbers: !!s.showLineNumbersForFence, ...indentation })) block.__cm.setOption(option, value);
    if (block.getAttribute("mdtype") === "fences") block.__cm.setOption("lineWrapping", s.wrapCode !== false);
    block.__cm.refresh();
  }
  app._sourceCM?.refresh();
  if (app._booted && app._dirty && !app._removedPath) markDirty();
  updateWordCount(app.editor);
  publishViewState();
  requestAnimationFrame(() => { updateWritingModes(); syncAppearance(); });
}

export function setTheme(name) {
  const changed = app.theme !== name;
  app.theme = name;
  for (const cls of [...document.body.classList]) if (cls.startsWith("theme-")) document.body.classList.remove(cls);
  document.body.classList.add("theme-" + name.replace(/[^\w-]/g, "-"));
  if (changed && [DEFAULT_THEME, DEFAULT_DARK_THEME].includes(name)) {
    const link = document.getElementById("theme_css");
    link.onload = themeDidLoad; link.href = `./styles/themes/${name}.css`;
  }
  void window.bridge.theme.resolve?.({ name }).then((resolved) => {
    if (app.theme !== name) return;
    // A saved theme that is no longer available (a removed custom theme, or
    // one of the earlier bundled themes) gives way to the default pair.
    if (!resolved.theme && ![DEFAULT_THEME, DEFAULT_DARK_THEME].includes(name)) { setTheme(app._darkAppearance ? DEFAULT_DARK_THEME : DEFAULT_THEME); return; }
    for (const [id, url] of [["theme_css", resolved.theme], ["base_user_css", resolved.baseOverride], ["theme_user_css", resolved.override]]) {
      const link = document.getElementById(id);
      if (url && link.href !== url) { link.onload = themeDidLoad; link.href = url; }
      else if (!url && id !== "theme_css") link.removeAttribute("href");
    }
  }).catch((error) => notify("Theme could not be loaded: " + error.message));
}

export function exportDefault(ext) {
  return exportDestination(app.file, ext, app.settings);
}

export async function doExport(fmt, dest, options = {}) {
  const text = documentText();
  try {
    options = exportOptions(fmt, app.settings, app.theme, app._darkAppearance, options);
    if (fmt === "image") fmt = options.format;
    if (!dest) {
      const extension = EXPORT_EXTENSIONS[fmt] || fmt;
      const picked = await window.bridge.window.save({ title: i18nT("Export", "Export") + " " + fmt.toUpperCase(), defaultPath: app.exportDefault(extension), filters: [{ name: fmt.toUpperCase(), extensions: [extension] }] });
      if (picked.canceled || !picked.path) return false;
      dest = picked.path;
    }
    const payload = { ...options, path: dest, text, docPath: app.file };
    let r;
    if (fmt === "md") {
      r = await window.bridge.export.md(payload);
    } else if (fmt === "html") {
      r = await window.bridge.export.html(payload);
    } else if (fmt === "pdf") {
      r = await window.bridge.export.pdf(payload);
    } else if (["png", "jpg", "jpeg"].includes(fmt)) {
      r = await window.bridge.export.image({ ...payload, format: fmt });
    } else {
      r = await window.bridge.export.pandoc({ ...payload, to: fmt });
    }
    if (!r?.ok || r.error) throw new Error(r?.error || "Export failed");
    const patch = { lastExportFolder: dest.replace(/\/[^/]+$/, ""), lastExport: { format: fmt, path: dest, options } };
    await window.bridge.setting.put({ key: "__patch", value: patch });
    Object.assign(app.settings, patch);
    notify("Exported to " + r.path + (r.warnings?.length ? ". " + r.warnings.join("; ") : ""));
    if (app.settings.openAfterExport !== false) void window.bridge.path.openFile({ path: r.path, useSystem: true }).catch((error) => notify(error.message));
    if (app.settings.revealAfterExport) void window.bridge.path.showInFinder({ path: r.path }).catch((error) => notify(error.message));
    return true;
  } catch (err) {
    notify(String(err?.message || err));
    return false;
  }
}

export async function exportPrevious() {
  const previous = app.settings.lastExport;
  if (!previous?.path || !previous?.format) { notify(i18nT("Export a document first.", "Export a document first.")); return false; }
  try {
    const existing = await window.bridge.path.stat({ path: previous.path }).catch(() => null);
    if (existing && await confirmChoice(i18nT("Replace the existing export?", "Replace the existing export?"), ["Replace", "Cancel"], { detail: previous.path }) !== "Replace") return false;
    return app.doExport(previous.format, previous.path, previous.options || {});
  } catch (error) { notify(error.message); return false; }
}

// ---------------------------------------------------------------------------
// clipboard (HTML by default, Markdown on ⌘⇧C)
// ---------------------------------------------------------------------------

export async function copySelection(mode) {
  // mode: html | htmlSource | markdown | plain
  const editor = app.editor;
  if (!editor) return;
  if (mode === "htmlSource") {
    try {
      const payload = await specialCopyPayload(app, "clean");
      if (!payload) return false;
      await window.bridge.clipboard.write({ text: payload.html });
      notify("Copied as HTML");
      return true;
    } catch (error) {
      notify(i18nT(error.message), [], { kind: "error" });
      return false;
    }
  }
  const sel = window.getSelection();
  const offsets = editor.selectionOffsets();
  const source = documentText();
  const sourceMode = document.body.classList.contains("sourceview-on");
  const textarea = $("#source-editor");
  const sourceSelection = sourceMode ? (app._sourceCM ? app._sourceCM.getSelection() : textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)) : "";
  const text = sourceMode ? sourceSelection || source : offsets && offsets.end > offsets.start ? source.slice(offsets.start, offsets.end) : source;
  if (mode === "markdown") {
    await window.bridge.clipboard.write({ text });
    notify("Copied as Markdown");
  } else if (mode === "html") {
    const r = await window.bridge.export.html({ path: null, text, theme: app.theme });
    const html = r?.html || text;
    await window.bridge.clipboard.write({ text: !sourceMode && sel && !sel.isCollapsed ? sel.toString() : text, html });
    notify("Copied as HTML");
  } else {
    const t = !sourceMode && sel && !sel.isCollapsed ? sel.toString() : text;
    await window.bridge.clipboard.write({ text: t });
    notify("Copied");
  }
}

export async function copyAsImage(target) {
  if (!app.editor || activeModal() || document.body.classList.contains("oversize")) return false;
  const active = document.activeElement;
  if (active?.matches("input,textarea,select") && !active.closest("#write, #app-source")) return false;
  try {
    const payload = imageCopyPayload(app, target);
    if (payload.region) document.body.classList.add("copying-image");
    const result = await window.bridge.clipboard.writeImage(payload);
    if (!result?.ok) throw new Error(result?.error || i18nT("The image could not be copied."));
    notify("Copied as Image");
    return result;
  } catch (error) {
    notify(i18nT("The image could not be copied.") + " " + error.message, [], { kind: "error" });
    return false;
  } finally { document.body.classList.remove("copying-image"); }
}

// ---------------------------------------------------------------------------
// menu command dispatch (labels/keys from the locale strings and the
// keyboard-shortcut reference)
// ---------------------------------------------------------------------------

function withEditor(fn, allowReadOnly = false) {
  return async () => {
    if (!app.editor) return;
    if (document.body.classList.contains("oversize")) return;
    if (!allowReadOnly && app.editor.guardReadOnly()) return;
    if (document.querySelector(".modal.open")) return;
    if (document.activeElement?.matches?.("input,textarea,select") && !document.activeElement.closest(".CodeMirror, #app-source")) return;
    const sourceMode = document.body.classList.contains("sourceview-on");
    if (!sourceMode) return fn(app.editor);
    const id = app._documentId;
    const cm = app._sourceCM;
    const ta = $("#source-editor");
    const start = cm ? cm.indexFromPos(cm.getCursor("from")) : ta.selectionStart;
    const end = cm ? cm.indexFromPos(cm.getCursor("to")) : ta.selectionEnd;
    if (app.editor._renderPending) app.editor.renderAll();
    app.editor.selectOffsets(start, end);
    const result = await fn(app.editor);
    if (id !== app._documentId || !document.body.classList.contains("sourceview-on")) return result;
    const selection = app.editor.selectionOffsets() || { start, end };
    const text = app.editor.getMarkdown();
    if (cm) {
      const before = cm.getValue();
      if (before !== text) {
        let from = 0, oldEnd = before.length, newEnd = text.length;
        while (from < oldEnd && from < newEnd && before[from] === text[from]) from++;
        while (oldEnd > from && newEnd > from && before[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
        cm.replaceRange(text.slice(from, newEnd), cm.posFromIndex(from), cm.posFromIndex(oldEnd), "format-command");
      }
      cm.setSelection(cm.posFromIndex(selection.start), cm.posFromIndex(selection.end));
      cm.focus();
    } else {
      ta.value = text;
      ta.setSelectionRange(selection.start, selection.end);
      ta.focus();
      markDirty();
    }
    return result;
  };
}

function withScriptFormatting(fn) {
  return withEditor((editor) => {
    if (!app.settings.subscriptSuperscript) {
      const selection = editor.selectionOffsets();
      app.settings.subscriptSuperscript = true;
      applySettings();
      if (selection) editor.selectOffsets(selection.start, selection.end, selection.backward);
      persistSettings({ subscriptSuperscript: true });
    }
    fn(editor);
  });
}

async function runCodeTool(action, scope) {
  const id = app._documentId;
  if (app.editor.guardReadOnly() || activeModal()) return false;
  await ensureCodeMirror();
  if (id !== app._documentId || !window.CodeMirror) return false;
  return formatCodeInApp(app, action, scope);
}

function textHasFocus() {
  const active = document.activeElement;
  return app.editor.root.contains(active) || active?.closest?.("#app-source") ||
    /^(INPUT|TEXTAREA)$/.test(active?.tagName) || active?.isContentEditable;
}

async function fileUndo(redo = false) {
  try {
    const state = await window.bridge.fileOperation?.[redo ? "redo" : "undo"]();
    if (!state?.changes?.length) notify(redo ? "No file operation to redo" : "No file operation to undo");
  } catch (error) { notify("File operation failed: " + (error.message || error)); }
}

function jumpToHeading(fragment) {
  const seen = new Map();
  for (const heading of app.editor.getOutline()) {
    const base = headingSlug(heading.text);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    const slug = base + (count ? "-" + count : "");
    if (slug === fragment) {
      app.editor.root.focus({ preventScroll: true });
      app.editor.placeCaret(heading.blockIndex, 0, { scroll: true });
      return true;
    }
  }
  notify("Heading not found: " + fragment);
  return false;
}

export async function openLink(url) {
  if (url.startsWith("#")) {
    try { return jumpToHeading(decodeURIComponent(url.slice(1))); }
    catch { return false; }
  }
  const result = await window.bridge.path.openURL({ url, docPath: app.file });
  if (result?.error) { notify(result.error); return false; }
  if (result?.path && await app.openFile(result.path) && result.fragment) return jumpToHeading(result.fragment);
  return true;
}

const commands = {
  "app.checkUpdates": () => checkForUpdates(),
  "app.privacy": () => app.maintenance?.privacyURL && window.bridge.shell.openExternal({ url: app.maintenance.privacyURL }),
  "app.notify": (payload) => notify(payload.message),
  // file
  "file.new": () => app.newDocument(),
  "file.newWindow": () => window.bridge.window.newWindow(),
  "file.open": async () => {
    const r = await window.bridge.window.openFile();
    if (r && !r.canceled && r.path) await app.openFile(r.path);
  },
  "file.openQuickly": () => openQO(),
  "file.import": () => app.importDocument(),
  "images.copyDocument": () => app.manageImages(null, "copy"),
  "images.moveDocument": () => app.manageImages(null, "move"),
  "images.copyFolder": () => app.manageImages(null, "copy", { scope: "folder" }),
  "images.moveFolder": () => app.manageImages(null, "move", { scope: "folder" }),
  "images.markdown": withEditor((editor) => formatImages(editor, "markdown")),
  "images.html": withEditor((editor) => formatImages(editor, "html")),
  "code.prettify": () => runCodeTool("prettify", "selection"),
  "code.indentWhole": () => runCodeTool("indent", "whole"),
  "code.indentSelected": () => runCodeTool("indent", "selection"),
  "library.openFolder": () => app.openFolder(null),
  "library.closeFolder": () => app.closeFolder(),
  "file.reopenClosed": () => window.bridge.window.reopenClosed(),
  "file.save": () => app.save(false),
  "file.saveAll": () => window.bridge.app.saveAll(),
  "file.saveAs": () => app.saveAs(),
  "file.undo": () => fileUndo(),
  "file.redo": () => fileUndo(true),
  "file.close": () => window.bridge.window.closeTab(),
  "file.preferences": () => openPreferences(),
  "file.snapshots": () => openRecovery(app),
  "file.export.html": (options) => app.doExport("html", null, options),
  "file.export.pandoc": (options) => app.doExport(options.to || "docx"),
  "file.export.pdf": () => app.doExport("pdf"),
  "file.export.docx": () => app.doExport("docx"),
  "file.export.epub": () => app.doExport("epub"),
  "file.export.rtf": () => app.doExport("rtf"),
  "file.export.latex": () => app.doExport("latex"),
  "file.export.md": () => app.doExport("md"),
  "file.export.odt": () => app.doExport("odt"),
  "file.export.mediawiki": () => app.doExport("mediawiki"),
  "file.export.rst": () => app.doExport("rst"),
  "file.export.textile": () => app.doExport("textile"),
  "file.export.opml": () => app.doExport("opml"),
  "file.export.image": () => app.doExport("image"),
  "file.export.previous": () => app.exportPrevious(),
  "file.export.screenshotHTML": async () => {
    const rect = document.getElementById("md-content").getBoundingClientRect();
    try { const result = await window.bridge.export.screenshotHTML({ title: document.title, region: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top) } }); if (!result.canceled) notify("Exported to " + result.path); }
    catch (error) { notify("Export failed: " + error.message, [], { kind: "error" }); }
  },
  "file.print": () => window.print(),
  // file (extra)
  "file.revert": async () => {
    if (!app.file) return;
    const file = app.file, id = app._documentId;
    const res = await window.bridge.document.read({ path: file });
    if (file !== app.file || id !== app._documentId) return;
    if (res.size > MAX_FILE_SIZE) { notify("This file is too large to reload into the editor."); return; }
    if (res && res.text != null) {
      const text = res.text.replace(/\r\n/g, "\n");
      if (app._sourceCM) app._sourceCM.replaceRange(text, { line: 0, ch: 0 }, app._sourceCM.posFromIndex(app._sourceCM.getValue().length), "revert");
      else {
        app.editor.replaceRange(0, app.editor.getMarkdown().length, text);
        if (document.body.classList.contains("sourceview-on")) $("#source-editor").value = text;
      }
      clearTimeout(app._autosaveTimer);
      app._savedText = text; app._dirty = false; app._lineEnding = /\r\n/.test(res.text) ? "CRLF" : "LF";
      setTitle(); updateWordCount(app.editor);
      notify("Reverted to saved. Use Undo to recover your changes.");
    }
  },
  "file.clearRecents": async () => {
    app.recentFiles = [];
    app.recentFolders = [];
    await window.bridge.quickOpen.cacheRecentFiles({ paths: [] }).catch(() => {});
    notify("Recent items cleared");
  },
  "file.pageSetup": () => { app.doExport("pdf"); },
  "library.newFile": () => app.newFile(),
  "library.duplicate": async () => {
    if (!app.file) { notify("Save this document before duplicating it."); return; }
    const result = await window.bridge.library.duplicate({ path: app.file });
    await app.refreshFolderQuiet(); notify("Created “" + result.path.split("/").pop() + "”", [{ label: "Open", onClick: () => app.openFile(result.path) }]);
  },
  "library.newFolder": async () => {
    if (!app._libraryRoot) { await app.openFolder(null); if (!app._libraryRoot) return; }
    const name = await promptText({ title: "New Folder", value: "New Folder", confirm: "Create" });
    if (!name) return;
    const result = await window.bridge.library.newFolder({ path: app._libraryRoot.replace(/\/+$/, "") + "/" + name });
    if (result?.error) { notify(result.error, [], { kind: "error" }); return; }
    await app.refreshFolderQuiet();
  },
  // edit
  "edit.undo": () => {
    if (!textHasFocus()) return fileUndo();
    if (app._sourceCM && document.activeElement?.closest?.("#app-source")) app._sourceCM.undo();
    else if (app.editor._activeCmBlock()) app.editor.undo();
    else if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) document.execCommand("undo");
    else app.editor.undo();
  },
  "edit.redo": () => {
    if (!textHasFocus()) return fileUndo(true);
    if (app._sourceCM && document.activeElement?.closest?.("#app-source")) app._sourceCM.redo();
    else if (app.editor._activeCmBlock()) app.editor.redo();
    else if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) document.execCommand("redo");
    else app.editor.redo();
  },
  "edit.cut": () => window.bridge.clipboard.action?.({ action: "cut" }) ?? document.execCommand("cut"),
  "edit.copy": () => {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return window.bridge.clipboard.action?.({ action: "copy" }) ?? document.execCommand("copy");
    if (window.getSelection()?.isCollapsed) return;
    return app.copySelection(app.settings.copyMarkdownByDefault ? "markdown" : "html");
  },
  "edit.copyMarkdown": () => app.copySelection("markdown"),
  "edit.copyHTML": () => app.copySelection("htmlSource"),
  "edit.copyHTMLSource": () => app.copySelection("htmlSource"),
  "edit.copyPlain": () => app.copySelection("plain"),
  "edit.copyImage": () => app.copyAsImage(),
  "edit.copyMathML": () => copySpecial(app, "mathml"),
  "edit.copyTeX": () => copySpecial(app, "tex"),
  "edit.copyCode": () => copySpecial(app, "code"),
  "edit.copyTable": () => copySpecial(app, "table"),
  "edit.copyCleanHTML": () => copySpecial(app, "clean"),
  "edit.paste": (payload) => window.bridge.clipboard.paste?.(payload) ?? document.execCommand("paste"),
  "edit.pastePlain": (payload) => {
    if (window.bridge.clipboard.paste) return window.bridge.clipboard.paste({ ...payload, plain: true });
    app.editor._pastePlainOnce = true;
    try { document.execCommand("paste"); } finally { app.editor._pastePlainOnce = false; }
  },
  "edit.selectAll": () => {
    const active = document.activeElement;
    const cm = active?.closest?.("#app-source") ? app._sourceCM : app.editor._activeCmBlock()?.cm;
    if (cm) cm.execCommand("selectAll");
    else if (/^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName)) document.execCommand("selectAll");
    else if (app.editor.root.contains(active) || active === document.body) app.editor.selectAll();
    else document.execCommand("selectAll");
  },
  "edit.selectWord": () => runSelectionCommand(app, "selectWord"),
  "edit.selectLine": () => runSelectionCommand(app, "selectLine"),
  "edit.selectSentence": () => runSelectionCommand(app, "selectSentence"),
  "edit.selectBlock": () => runSelectionCommand(app, "selectBlock"),
  "edit.selectScope": () => runSelectionCommand(app, "selectScope"),
  "edit.deleteWord": () => runSelectionCommand(app, "deleteWord"),
  "edit.deleteBlock": () => runSelectionCommand(app, "deleteBlock"),
  "edit.deleteLine": () => runSelectionCommand(app, "deleteLine"),
  "edit.deleteSentence": () => runSelectionCommand(app, "deleteSentence"),
  "edit.deleteRow": withEditor(deleteRow),
  "edit.lineStart": () => runSelectionCommand(app, "lineStart"),
  "edit.lineEnd": () => runSelectionCommand(app, "lineEnd"),
  "edit.jumpTop": () => app.editor.placeCaret(0, 0, { scroll: true }),
  "edit.jumpBottom": () => {
    const last = app.editor.blocks.length - 1;
    if (last >= 0) app.editor.placeCaret(last, 999999, { scroll: true });
  },
  "edit.jumpSelection": withEditor(jumpToSelection, true),
  "edit.find": () => openSearchpanel(false),
  "edit.findNext": () => { openSearchpanel(false); doFindNext(1); },
  "edit.findPrev": () => { openSearchpanel(false); doFindNext(-1); },
  "edit.replace": () => openSearchpanel(true),
  "edit.findInFiles": () => focusLibrarySearch(),
  "edit.spellcheck": () => {
    app.settings.spellcheck = !app.settings.spellcheck;
    window.bridge.setting.put({ key: "__patch", value: { spellcheck: app.settings.spellcheck } }).then((r) => {
      if (r?.settings) Object.assign(app.settings, r.settings);
    });
    document.getElementById("write").setAttribute("spellcheck", String(app.settings.spellcheck));
    notify("Spell check " + (app.settings.spellcheck ? "on" : "off"));
  },
  "paragraph.moveRowUp": withEditor((e) => moveTableRow(e, -1)),
  "paragraph.moveRowDown": withEditor((e) => moveTableRow(e, 1)),
  "format.lf": () => { app._lineEndingOverride = "LF"; publishViewState(); notify("Line endings: LF"); },
  "format.crlf": () => { app._lineEndingOverride = "CRLF"; publishViewState(); notify("Line endings: CRLF"); },
  "format.preserveLineEndings": () => { app._lineEndingOverride = "preserve"; publishViewState(); },
  "format.preserveBreaks": () => {
    app.settings.preserveBreaks = !app.settings.preserveBreaks;
    persistSettings();
    notify("Preserve single line break: " + (app.settings.preserveBreaks ? "on" : "off"));
  },
  "view.switchDocs": () => window.bridge.window.switchDocuments({ direction: 1 }),
  "help.license": () => showHelp(app, "license"),
  "help.checkUpdates": () => window.bridge.app.version().then((version) => notify(`Lettrine ${version.version} is installed. This build does not check for updates automatically.`)),
  "help.welcome": () => showHelp(app, "welcome"),
  "help.customThemes": async () => { await window.bridge.theme.openFolder(); },
  "help.pandoc": () => showHelp(app, "pandoc"),
  "help.feedback": () => showHelp(app, "feedback"),

  // paragraph (Format › Paragraph)
  "paragraph.h1": withEditor((e) => setHeading(e, 1)),
  "paragraph.h2": withEditor((e) => setHeading(e, 2)),
  "paragraph.h3": withEditor((e) => setHeading(e, 3)),
  "paragraph.h4": withEditor((e) => setHeading(e, 4)),
  "paragraph.h5": withEditor((e) => setHeading(e, 5)),
  "paragraph.h6": withEditor((e) => setHeading(e, 6)),
  "paragraph.p": withEditor((e) => {
    const cur = e.caretInfo();
    if (cur.blockIndex === -1) return;
    const block = e.blocks[cur.blockIndex];
    const text = block.type === "heading" ? block.text : (block.type === "paragraph" ? block.src : "");
    e.blocks[cur.blockIndex] = { type: "paragraph", src: text, text };
    e.renderAll();
    e.placeCaret(cur.blockIndex, 0, { scroll: true });
    e.pushHistory();
    e.emit();
  }),
  "paragraph.up": withEditor(headingUp),
  "paragraph.down": withEditor(headingDown),
  "paragraph.table": () => { if (!app.editor.guardReadOnly()) openTableDialog(); },
  "paragraph.tableInsert": (payload) => withEditor((editor) => insertTable(editor, payload.cols, payload.rows))(),
  "paragraph.toc": withEditor(insertTOC),
  "paragraph.codeFences": withEditor(toggleCodeFence),
  "paragraph.mathBlock": withEditor(toggleMathBlock),
  "paragraph.quote": withEditor(toggleQuote),
  ...Object.fromEntries(["note", "tip", "important", "warning", "caution"].map((type) => ["paragraph.alert." + type, withEditor((editor) => setAlert(editor, type))])),
  "paragraph.orderedList": withEditor((e) => toggleList(e, true)),
  "paragraph.unorderedList": withEditor((e) => toggleList(e, false)),
  "paragraph.indent": () => withEditor((e) => indentOp(e, true))(),
  "paragraph.outdent": () => withEditor((e) => indentOp(e, false))(),
  "paragraph.task": withEditor(toggleTask),
  "paragraph.insertTable": () => app.handleCommand("paragraph.table"),
  "paragraph.addRow": withEditor((editor) => editor._activeCmBlock() ? editor.exitRawBlock() : tableAddRow(editor)),
  "paragraph.addRowAbove": withEditor((e) => tableAddRow(e, true)),
  "paragraph.hr": withEditor(insertHr),
  // inline (Format > Inline Styles)
  "inline.strong": withEditor(formatBold),
  "inline.emphasis": withEditor(formatItalic),
  "inline.underline": withEditor(formatUnderline),
  "inline.subscript": withScriptFormatting(formatSubscript),
  "inline.superscript": withScriptFormatting(formatSuperscript),
  "inline.strike": withEditor(formatStrike),
  "inline.highlight": withEditor(formatHighlight),
  "inline.code": withEditor(formatCode),
  "inline.link": withEditor(formatLink),
  "inline.math": withEditor(formatMath),
  "inline.image": withEditor(insertImage),
  "inline.clear": withEditor(clearFormat),
  // view
  "view.toggleSidebar": () => app.toggleSidebar(),
  "view.outline": () => toggleOutline(),
  "view.toolbar": () => toggleDocumentToolbar(),
  "view.zoomPopover": () => toggleZoomPopover(),
  "view.files": () => {
    app.fileView = "list"; app.settings.fileView = "list";
    persistSettings({ fileView: "list" });
    setSidebarMode("articles");
  },
  "view.tree": () => {
    app.fileView = "tree"; app.settings.fileView = "tree";
    persistSettings({ fileView: "tree" });
    setSidebarMode("tree");
  },
  "view.source": () => app.toggleSource(),
  "view.readonly": () => app.toggleReadonly(),
  "view.focus": () => app.toggleFocusMode(),
  "view.typewriter": () => app.toggleTypewriter(),
  "view.fullscreen": () => window.bridge.window.toggleFullscreen(),
  "view.zoomIn": () => window.bridge.window.zoom({ delta: 1 }),
  "view.zoomOut": () => window.bridge.window.zoom({ delta: -1 }),
  "view.actualSize": () => window.bridge.window.zoom({ delta: 0 }),
  "view.toggleDevTools": () => window.bridge.window.toggleDevTools(),
  "view.pin": () => window.bridge.window.pin(),
  "view.speak": async () => {
    try {
      const source = document.body.classList.contains("sourceview-on");
      const textarea = $("#source-editor");
      const selected = source ? app._sourceCM?.getSelection() || textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) : "";
      await window.bridge.speech.speak({ text: source ? readableMarkdown(selected || documentText(), app.settings) : app.editor.getSpeechText() });
    }
    catch (error) { notify(error.message); }
  },
  "view.stopSpeaking": () => window.bridge.speech.stop(),
  // help
  "help.about": () => window.bridge.app.version().then(async (v) => {
    const choice = await confirmChoice(`${v.name} ${v.version}`, ["OK", "Keyboard Shortcuts"], { detail: "A free, open-source live-preview Markdown editor, released under the MIT License." });
    if (choice === "Keyboard Shortcuts") { openPreferences(); setPrefPane("shortcuts"); }
  }),
  "help.shortcuts": () => { openPreferences(); setPrefPane("shortcuts"); },
  "help.markdownReference": () => showHelp(app, "markdown"),
  "help.website": () => showHelp(app, "welcome"),
  "help.toggleSidebarMenu": () => app.toggleSidebar(),
};

function persistSettings(patch = { ...app.settings }) {
  window.bridge.setting.put({ key: "__patch", value: patch }).then((r) => {
    if (r?.settings) Object.assign(app.settings, r.settings);
  });
}


function indentOp(editor, indent) {
  const current = editor.caretInfo();
  if (current.blockIndex >= 0 && editor.blocks[current.blockIndex].type === "list") indentList(editor, current.blockIndex, indent);
}

function doFindNext(dir) {
  import("./ui.js").then(({ doFindNextPublic }) => doFindNextPublic?.(dir));
}

export function handleCommand(name, payload) {
  if (!app._booted) return app.ready.then(() => handleCommand(name, payload));
  const documentField = document.activeElement?.closest?.("#write, #app-source");
  const otherField = !documentField && document.activeElement?.matches?.("input, textarea, select, [contenteditable=true]");
  const mutation = /^(inline\.|paragraph\.|format\.)/.test(name) ||
    ["file.save", "file.saveAs", "file.revert", "file.undo", "file.redo", "library.newFile", "library.newFolder", "library.duplicate", "edit.deleteRow"].includes(name) ||
    !otherField && /^edit\.delete(?:Word|Block|Line|Sentence)$/.test(name) ||
    !otherField && ["edit.cut", "edit.paste", "edit.pastePlain", "edit.undo", "edit.redo"].includes(name);
  if (mutation && app.editor.guardReadOnly()) return false;
  const fn = commands[name];
  if (fn) {
    try {
      const result = fn(payload);
      return result?.catch ? result.catch((error) => { notify(error.message || String(error)); return false; }) : result;
    } catch (error) { notify(error.message || String(error)); return false; }
  } else if (name === "doc.openRequest") {
    return app.openFile(payload?.path, payload?.line);
  } else if (name === "doc.saved") {
    app.file = payload?.path || app.file;
    app._dirty = false;
    setTitle();
    notify("Saved (external)");
  } else {
    console.warn("unknown menu command:", name);
  }
}

// ---------------------------------------------------------------------------
// preferences
// ---------------------------------------------------------------------------

function openPreferences() {
  app._preferencesFocus = document.activeElement;
  app._preferencesSelection = app.editor.selectionOffsets();
  const dlg = $("#preferences-dialog");
  dlg.classList.add("open");
  dlg.setAttribute("aria-hidden", "false");
  const s = app.settings;
  loadExtraPreferences(s);
  void loadLocalePreference().catch((error) => notify(error.message));
  void window.bridge.theme.list().then((themes) => {
    for (const selector of ["#pref-theme", "#pref-theme-dark"]) {
      const select = $(selector);
      for (const theme of themes) if (![...select.options].some((option) => option.value === theme.name)) { const option = document.createElement("option"); option.value = theme.name; option.textContent = THEME_TITLES[theme.name] || theme.name.replace(/(^|[-_ ])(\w)/g, (_, gap, letter) => (gap ? " " : "") + letter.toUpperCase()); select.appendChild(option); }
      select.value = selector === "#pref-theme" ? s.theme || DEFAULT_THEME : s.darkTheme || DEFAULT_DARK_THEME;
      if (!select.value) select.value = selector === "#pref-theme" ? DEFAULT_THEME : DEFAULT_DARK_THEME;
    }
  });
  void loadShortcutPreferences().catch((error) => notify(error.message));
  void window.bridge.window.pin?.({ query: true }).then((state) => { const input = $("#pref-extra-pinWindows"); if (input && dlg.classList.contains("open")) input.checked = state.pinned; });
  void loadDictionaryPreferences();
  // General
  $("#pref-autosave").checked = !!s.autosave;
  $("#pref-word-count").checked = s.wordCount !== false;
  $("#pref-reading-speed").value = s.wordsPerMinute || 200;
  $("#pref-font-size").value = s.fontSize || 16;
  $("#pref-spellcheck").checked = s.spellcheck !== false;
  $("#pref-copy-md").checked = !!s.copyMarkdownByDefault;
  $("#pref-final-newline").checked = !!s.finalNewLine;
  $("#pref-line-endings").value = s.lineEndings || "";
  $("#pref-focus-mode").checked = !!s.focusMode;
  $("#pref-typewriter").checked = !!s.typewriter;
  $("#pref-fence-lineno").checked = !!s.showLineNumbersForFence;
  // Appearance
  $("#pref-theme").value = s.theme || DEFAULT_THEME;
  $("#pref-theme-dark").value = s.darkTheme || DEFAULT_DARK_THEME;
  if (!$("#pref-theme").value) $("#pref-theme").value = DEFAULT_THEME;
  if (!$("#pref-theme-dark").value) $("#pref-theme-dark").value = DEFAULT_DARK_THEME;
  // Image
  $("#pref-image-dir").value = s.imageInsertDir || "./assets";
  $("#pref-img-rel-path").checked = s.imageRelativePath !== false;
  $("#pref-img-copy").checked = s.imageCopyToFolder !== false;
  $("#pref-img-custom-dir").value = ["./assets", "./", "inline"].includes(s.imageInsertDir || "./assets") ? "" : s.imageInsertDir;
  $("#pref-img-root-path").value = s.imageRootPath || "";
  $("#pref-img-root-url").value = s.imageRootURL || "";
  // Export
  $("#pref-pdf-header").value = s.pdfHeader || "";
  $("#pref-pdf-footer").value = s.pdfFooter ?? "";
  $("#pref-pdf-author").value = s.pdfAuthor || "";
  $("#pref-export-open").checked = s.openAfterExport !== false;
  setPrefPane("general");
  document.addEventListener("keydown", onPreferencesKey, true);
  $("#preferences-dialog .modal-content")?.focus({ preventScroll: true });
}

function onPreferencesKey(event) {
  if (event.key !== "Escape" || activeModal() !== $("#preferences-dialog")) return;
  if (event.target.closest?.("#pref-shortcuts-list")) return;
  event.preventDefault(); event.stopPropagation();
  closePreferences();
}

function setPrefPane(name) {
  $$("#preferences-dialog .pref-pane").forEach((pane) => { pane.hidden = pane.id !== "pref-pane-" + name; pane.style.display = ""; });
  $$("#preferences-dialog .nav-group-item").forEach((item) => {
    const active = item.dataset.pane === name;
    item.classList.toggle("active", active);
    item.setAttribute("aria-current", active ? "page" : "false");
  });
  const panes = $("#preferences-dialog .settings-panes");
  if (panes) panes.scrollTop = 0;
}

function closePreferences() {
  let extra;
  try { extra = { ...extraPreferencesPatch(), shortcuts: shortcutPreferencesPatch() ?? app.settings.shortcuts ?? {} }; } catch (error) { notify(error.message); return; }
  void window.bridge.menu?.recording({ enabled: false });
  void saveDictionaryPreferences().catch((error) => notify("Dictionary could not be saved: " + error.message));
  $("#preferences-dialog").classList.remove("open");
  $("#preferences-dialog").setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onPreferencesKey, true);
  const patch = {
    ...extra,
    autosave: $("#pref-autosave").checked,
    wordCount: $("#pref-word-count").checked,
    wordsPerMinute: parseInt($("#pref-reading-speed").value, 10) || 200,
    fontSize: parseInt($("#pref-font-size").value, 10) || 16,
    spellcheck: $("#pref-spellcheck").checked,
    copyMarkdownByDefault: $("#pref-copy-md").checked,
    finalNewLine: $("#pref-final-newline").checked,
    lineEndings: $("#pref-line-endings").value,
    focusMode: $("#pref-focus-mode").checked,
    typewriter: $("#pref-typewriter").checked,
    showLineNumbersForFence: $("#pref-fence-lineno").checked,
    theme: $("#pref-theme").value,
    darkTheme: $("#pref-theme-dark").value,
    imageInsertDir: $("#pref-img-custom-dir").value.trim() || $("#pref-image-dir").value || "./assets",
    imageCopyToFolder: $("#pref-img-copy").checked,
    imageRootPath: $("#pref-img-root-path").value.trim(),
    imageRootURL: $("#pref-img-root-url").value.trim(),
    imageRelativePath: $("#pref-img-rel-path").checked,
    pdfHeader: $("#pref-pdf-header").value,
    pdfFooter: $("#pref-pdf-footer").value,
    pdfAuthor: $("#pref-pdf-author").value,
    openAfterExport: $("#pref-export-open").checked,
  };
  window.bridge.setting.put({ key: "__patch", value: patch }).then((r) => {
    Object.assign(app.settings, r?.settings || patch);
    applySettings();
    void window.bridge.window.pin?.({ enabled: patch.pinWindows });
    if (app._preferencesFocus?.isConnected && !app._preferencesFocus.closest?.("#preferences-dialog")) app._preferencesFocus.focus({ preventScroll: true });
    else app.editor.root.focus({ preventScroll: true });
    if (app._preferencesSelection && app.editor.root.contains(document.activeElement)) {
      app.editor.selectOffsets(app._preferencesSelection.start, app._preferencesSelection.end, app._preferencesSelection.backward);
      app.editor._syncMathFocus(app.editor.globalOffsetToBlock(app._preferencesSelection.start).index);
    }
    pushTabState();
  }).catch((error) => notify("Preferences could not be saved: " + error.message));
}

function initPreferences() {
  initExtraPreferences();
  initShortcutPreferences();
  initLocalePreference();
  initDictionaryPreferences();
  $("#preferences-done").addEventListener("click", closePreferences);
  $$("#preferences-dialog .nav-group-item").forEach((item) => {
    item.addEventListener("click", () => setPrefPane(item.dataset.pane));
    item.addEventListener("keydown", (event) => {
      const items = $$("#preferences-dialog .nav-group-item"), index = items.indexOf(item);
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPrefPane(item.dataset.pane); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]; next.focus(); setPrefPane(next.dataset.pane); }
    });
  });
  $("#pref-open-themes").addEventListener("click", async () => {
    await window.bridge.theme.openFolder();
  });
  $("#pref-get-themes").addEventListener("click", () => {
    showHelp(app, "themes");
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

// expose the command-facing API on the app object (ui.js / tests / menu commands)
Object.assign(app, {
  openFile, openFolder, save, saveAs, newDocument, newFile, refreshFolder, refreshFolderQuiet, handleDiskChanged, importDocument, handleSidebarDrop, handleSourceDrop, captureSession, restoreSession,
  enterOversize, exitOversize,
  toggleSidebar, toggleSource, toggleReadonly, toggleFocusMode, toggleTypewriter, setTheme,
  imageSnapshot: () => imageSnapshot(app),
  formatCode: runCodeTool,
  copySpecial: (mode, target) => copySpecial(app, mode, target),
  selectRange: (action) => runSelectionCommand(app, action),
  pasteSourceImage: (image) => pasteSourceImage(app, image),
  manageImages: async (...args) => {
    try {
      const result = await manageImages(app, ...args);
      if (result) notify("Image file operation completed.", [{ label: "Undo", onClick: () => fileUndo() }]);
      return result;
    } catch (error) { notify(i18nT("Image operation failed:") + " " + i18nT(error.message), [], { kind: "error" }); return false; }
  },
  confirmChoice,
  notify,
  doExport, exportPrevious, copySelection, copyAsImage, exportDefault, fileContextMenu, openQO, closeQO, i18nT, untitledName, handleCommand, openLink, closeFolder,
  applySettings, persistSettings,
  updateWritingModes,
});

window.addEventListener("DOMContentLoaded", async () => {
  createEditor();
  bindSpellSuggestions(app.editor);
  window.__lettrineNotify = (m) => notify(m);
  initUI(app);
  initLocalization();
  initContextMenu(app);
  initPreferences();

  // bridge events
  window.bridge.on("menu.command", (name, payload) => handleCommand(name, payload));
  window.bridge.on("app.updateAvailable", result => notify(i18nT("A new version of Lettrine is available:") + " " + result.version, [{ label: "View Update", onClick: () => presentUpdate(result) }]));
  window.bridge.on("doc.openRequest", (p) => { app._openRequested = true; return app.ready.then(() => app.openFile(p?.path, p?.line)); });
  window.bridge.on("doc.saveRequest", async (p) => {
    await app.ready;
    let ok = false;
    try {
      if (app.editor.readOnly) toggleReadonly();
      ok = !!(await app.save(false)) && !app._dirty;
    }
    finally { window.bridge.document.completeSave?.({ id: p.id, ok }); }
  });
  window.bridge.on("doc.diskChanged", (p) => app.handleDiskChanged(p));
  window.bridge.on("doc.removed", ({ path }) => {
    if (path !== app.file) return;
    app._removedPath = path;
    clearTimeout(app._autosaveTimer);
  });
  window.bridge.on("images.changed", (change) => applyImageChanges(app, change));
  window.bridge.on("doc.pathChanged", async (change) => {
    const under = (value, root) => !!root && (value === root || value?.startsWith(root + "/"));
    if (change.from && change.to) {
      const moved = (value) => under(value, change.from) ? change.to + value.slice(change.from.length) : value;
      app.file = moved(app.file);
      app._removedPath = moved(app._removedPath);
      app.folder = moved(app.folder);
      app._libraryRoot = moved(app._libraryRoot);
      app.recentFiles = app.recentFiles.map((file) => ({ ...file, path: moved(file.path), name: moved(file.path).split("/").pop() }));
    } else if (under(app._removedPath, change.restored)) {
      app.file = app._removedPath;
      app._removedPath = null;
      const id = app._documentId, file = app.file;
      try {
        const restored = await window.bridge.document.read({ path: file });
        if (app._documentId === id && app.file === file) { app._savedText = restored.text; app._dirty = documentText() !== app._savedText; }
      } catch { /* Keep the in-memory document if an external writer removed it again. */ }
    }
    app.editor.setDocumentPath(app.file);
    setTitle();
    void app.refreshFolderQuiet();
  });
  window.bridge.on("folder.changed", () => app.refreshFolderQuiet());
  window.bridge.on("setting.changed", (settings) => { Object.assign(app.settings, settings); applySettings(); void refreshShortcutLabels(); });
  document.getElementById("theme_css").addEventListener("load", () => { syncAppearance(); updateWritingModes(); });

  // oversize banner controls
  const ovClose = document.getElementById("ic-oversize-close");
  if (ovClose) ovClose.addEventListener("click", () => app.newDocument());
  const ovOpen = document.getElementById("ic-oversize-file-open-in");
  if (ovOpen) {
    ovOpen.style.display = "inline-block";
    ovOpen.addEventListener("click", () => { if (app.file) window.bridge.path.openFile({ path: app.file, useSystem: true }); });
  }

  // load settings (a bridge failure must not leave the editor unbooted —
  // defaults still apply)
  try {
    const s = await window.bridge.setting.get({ key: "__patch" });
    app.settings = s || {};
  } catch {
    app.settings = {};
  }
  try { app.systemDark = (await window.bridge.window.appearance?.({ query: true }))?.systemDark; } catch { /* use the media query */ }
  try { app.maintenance = await window.bridge.app.maintenance?.() || {}; } catch { app.maintenance = {}; }
  window.bridge.on("window.state", (state) => {
    if (typeof state?.systemDark === "boolean" && state.systemDark !== app.systemDark) { app.systemDark = state.systemDark; if ((app.settings.background || "system") === "system") applySettings(); }
  });
  applySettings();

  // load the text-replacement dictionary
  try {
    app.editor._textReplacements = await window.bridge.word.getTextReplacement({});
  } catch {
    app.editor._textReplacements = {};
  }

  // interface translations for the active language
  try {
    app.i18n = await window.bridge.i18n.strings();
  } catch {
    app.i18n = { locale: "en", strings: {} };
  }
  window.bridge.on("i18n.changed", async () => {
    try { app.i18n = await window.bridge.i18n.strings(); } catch {}
    localizeUI(app.i18n);
    if (document.querySelector("#preferences-dialog.open")) { void loadLocalePreference(); void loadShortcutPreferences(true); }
    // re-apply the localized untitled name if we're on a new document
    setTitle();
    renderFileListSoon();
    updateWordCount(app.editor);
    renderOutlineSoon();
    void refreshShortcutLabels();
  });
  localizeUI(app.i18n);
  window.addEventListener("focus", () => { setTheme(app.theme); updateWritingModes(); });
  if (window.ResizeObserver) new window.ResizeObserver(() => updateWritingModes()).observe(app.editor.root);
  document.fonts?.addEventListener("loadingdone", () => updateWritingModes());
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if ((app.settings.background || "system") === "system") applySettings(); });

  // load recent lists
  app.recentFiles = await window.bridge.quickOpen.recentFiles().catch(() => []);
  app.recentFolders = await window.bridge.library.recentFolders().catch(() => []);

  // The first launch opens a short tour; later windows start empty.
  if (!app.settings.welcomeShown && !window.__lettrineLaunch?.managed && window.__lettrineLaunch?.initial !== false) {
    app.editor.setText(WELCOME_DOCUMENT);
    app.settings.welcomeShown = true;
    persistSettings({ welcomeShown: true });
  } else app.editor.setText("");
  app.editor.focus();
  app._savedText = app.editor.getMarkdown();
  updateWordCount(app.editor);
  renderOutlineSoon();

  if (app.settings.lastLibrary && !app._libraryRoot) await openFolder(app.settings.lastLibrary, { quiet: true }).catch(() => {});
  if (app.settings.pinWindows) void window.bridge.window.pin?.({ enabled: true, initial: true });
  if (app.settings.openRecentOnStart && !window.__lettrineLaunch?.managed && window.__lettrineLaunch?.initial !== false && !app._openRequested && app.recentFiles[0]?.path) await app.openFile(app.recentFiles[0].path);
  if (app.settings.sourceByDefault && !document.body.classList.contains("sourceview-on") && !document.body.classList.contains("oversize")) toggleSource();

  // beforeunload guard (main shows the native save dialog and suppresses
  // this when it closes a tab itself)
  window.addEventListener("beforeunload", (e) => {
    if (app._dirty && app.settings.askToCloseUnsaved !== false && !window.__lettrineSuppressUnload) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  pushTabState();
  app._booted = true;
  finishBoot();
  void window.bridge.document.ready?.().catch(() => {});
});
