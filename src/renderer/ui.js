// Lettrine interface — library sidebar, document bar, outline, find bar,
// Quick Open, document popover, menus, dialogs and toasts.

import { maybeEmojiPopup } from "./editor-ops.js";
import { positionInBlock } from "./editor.js";
import { fuzzyScore } from "../core/fuzzy.js";
import { compileFind, findAll, replaceFind } from "../core/find.js";
import { countText, documentStats, selectionStats } from "../core/stats.js";
import { fileTreeRows } from "../core/file-tree.js";
import { readableMarkdown } from "../core/readable.js";
import { isMarkdownExtension } from "../core/documents.js";
import { translateUI } from "./localization.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const t = (key) => translateUI(key);
const format = (key, ...values) => values.reduce((text, value, index) => text.replace(`{${index}}`, value), t(key));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

export function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon" + (className ? " " + className : ""));
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.appendChild(use);
  return svg;
}

const baseName = (path) => String(path || "").split("/").filter(Boolean).pop() || String(path || "");
const parentOf = (path) => String(path || "").replace(/\/+$/, "").replace(/\/[^/]*$/, "");
const tildify = (path) => String(path || "").replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

function nameParts(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}
// File names render as a stem plus a quieter extension (hidden for Markdown);
// the element's text is still the complete name.
function nameNode(name, className = "file-name", marks = null) {
  const [stem, ext] = nameParts(name);
  const node = el("span", { class: className });
  if (marks?.size) [...stem].forEach((character, index) => node.append(marks.has(index) ? el("b", { text: character }) : character));
  else node.append(stem);
  if (ext) node.append(el("span", { class: "file-ext" + (isMarkdownExtension(ext) ? " file-ext-md" : ""), text: ext }));
  return node;
}

function relativeTime(ms) {
  if (!ms || ms < 1) return "";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return t("Just now");
  if (minutes < 60) return format("{0} min ago", minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format("{0} h ago", hours);
  const date = new Date(ms), now = new Date();
  return (date.getFullYear() === now.getFullYear() ? fileDates : fileDatesWithYear).format(date);
}

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------
let _notifTimer = null;
export function notify(message, buttons = [], options = {}) {
  const box = $("#md-notification");
  if (!box) return;
  const error = options.kind === "error";
  box.replaceChildren();
  box.classList.toggle("is-error", error);
  box.setAttribute("role", error ? "alert" : "status");
  if (error) box.appendChild(icon("warning", "toast-icon"));
  box.appendChild(el("span", { class: "toast-text", text: t(message) }));
  for (const b of buttons) box.appendChild(el("button", { type: "button", class: "ui-btn", text: b.label, onclick: () => { hideNotify(); b.onClick?.(); } }));
  if (error || buttons.length) box.appendChild(el("button", { type: "button", class: "icon-btn icon-btn-sm", title: t("Close"), "aria-label": t("Close"), onclick: hideNotify }, icon("close")));
  box.parentElement.classList.add("active");
  scheduleHide(options.timeout ?? (error ? 9000 : buttons.length ? 6000 : 3200));
}
function scheduleHide(ms) { clearTimeout(_notifTimer); _notifTimer = setTimeout(hideNotify, ms); }
function hideNotify() { $("#md-notification")?.parentElement.classList.remove("active"); }

// ---------------------------------------------------------------------------
// dialogs
// ---------------------------------------------------------------------------
export function activeModal() {
  return qo.open ? null : $$(".modal.open").at(-1);
}

function openModal(modal, { onEscape, initialFocus } = {}) {
  const previousFocus = document.activeElement;
  document.body.appendChild(modal);
  const onKey = (event) => { if (event.key === "Escape" && activeModal() === modal) { event.preventDefault(); event.stopPropagation(); onEscape?.(); } };
  document.addEventListener("keydown", onKey, true);
  (initialFocus?.() || modal.querySelector(".ui-btn-primary, button"))?.focus();
  return () => {
    modal.remove();
    document.removeEventListener("keydown", onKey, true);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
}

// A blocking choice. buttons[0] is the default action; macOS order puts it
// last, "Cancel" before it, and any other choice at the leading edge.
// Resolves with the clicked label, or null when dismissed.
export function confirmChoice(message, buttons = ["OK"], options = {}) {
  return new Promise((resolve) => {
    const primary = buttons[0];
    const cancel = buttons.find((label) => label !== primary && /^cancel$/i.test(label)) ?? null;
    const others = buttons.filter((label) => label !== primary && label !== cancel);
    const footer = el("div", { class: "modal-footer", id: "confirm-choice-btns" });
    const modal = el("div", { class: "modal open alert", role: "alertdialog", "aria-modal": "true" },
      el("div", { class: "modal-dialog modal-sm" }, el("div", { class: "modal-content" },
        el("div", { class: "modal-body" }, el("p", { class: "alert-message", text: message }), options.detail ? el("p", { class: "alert-detail", text: options.detail }) : null),
        footer)));
    let close;
    const done = (value) => { close(); resolve(value); };
    [...others, cancel, primary].filter(Boolean).forEach((label, index) => {
      const button = el("button", { type: "button", class: "ui-btn" + (label === primary ? " ui-btn-primary" : "") + (index === 0 && others.length ? " footer-start" : ""), "data-choice": label, text: label, onclick: () => done(label) });
      footer.appendChild(button);
    });
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing && event.target.tagName !== "BUTTON") { event.preventDefault(); done(primary); }
    });
    close = openModal(modal, { onEscape: () => done(cancel), initialFocus: () => [...footer.children].find((node) => node.textContent === primary) });
  });
}

// A single-field prompt (new file, rename, new folder). Resolves with the
// trimmed text, or null when canceled.
export function promptText({ title, value = "", confirm = "OK", selectStem = false } = {}) {
  return new Promise((resolve) => {
    const input = el("input", { type: "text", class: "ui-input", id: "prompt-name", spellcheck: "false", autocomplete: "off", "aria-label": title });
    input.value = value;
    const modal = el("div", { class: "modal open", role: "dialog", "aria-modal": "true", "aria-label": title },
      el("div", { class: "modal-dialog modal-sm" }, el("form", { class: "modal-content" },
        el("div", { class: "modal-header" }, el("h2", { class: "modal-title", text: title })),
        el("div", { class: "modal-body" }, input),
        el("div", { class: "modal-footer" },
          el("button", { type: "button", class: "ui-btn", "data-act": "cancel", text: t("Cancel"), onclick: () => done(null) }),
          el("button", { type: "submit", class: "ui-btn ui-btn-primary", "data-act": "ok", text: confirm })))));
    let close;
    const done = (result) => { close(); resolve(result); };
    modal.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); done(input.value.trim() || null); });
    close = openModal(modal, { onEscape: () => done(null), initialFocus: () => input });
    const stem = selectStem ? nameParts(value)[0].length : value.length;
    input.setSelectionRange(0, stem);
  });
}

// ---------------------------------------------------------------------------
// menus — native NSMenu through the bridge, with an in-page fallback
// ---------------------------------------------------------------------------
let _menuSeq = 0;
function menuModel(items, registry) {
  return items.filter(Boolean).map((item) => {
    if (item.separator) return { separator: true };
    const id = "m" + (++_menuSeq);
    registry.set(id, item);
    return { id, label: item.label, enabled: item.enabled !== false, checked: !!item.checked, destructive: !!item.destructive, shortcut: item.shortcut || undefined, submenu: item.submenu ? menuModel(item.submenu, registry) : undefined };
  });
}
export async function showMenu(items, point) {
  const registry = new Map(), model = menuModel(items, registry);
  let chosen = null;
  if (window.bridge.menu?.popup) {
    try { chosen = registry.get((await window.bridge.menu.popup({ items: model, x: point.x, y: point.y }))?.id) || null; }
    catch { chosen = await pageMenu(items, point); }
  } else chosen = await pageMenu(items, point);
  if (chosen?.run) {
    try { await chosen.run(); } catch (error) { notify(error.message || String(error), [], { kind: "error" }); }
  }
  return chosen;
}
function pageMenu(items, point) {
  return new Promise((resolve) => {
    document.querySelector(".dropdown-menu.ui-page-menu")?.dispatchEvent(new Event("dismiss"));
    const menu = el("div", { class: "dropdown-menu open ui-page-menu", role: "menu" });
    const add = (list, depth = 0) => {
      for (const item of list.filter(Boolean)) {
        if (item.separator) { menu.appendChild(el("div", { class: "divider", role: "separator" })); continue; }
        if (item.submenu) { menu.appendChild(el("div", { class: "menu-label", text: item.label })); add(item.submenu, depth + 1); continue; }
        menu.appendChild(el("button", { type: "button", role: "menuitem", class: item.destructive ? "is-danger" : null, "aria-disabled": item.enabled === false ? "true" : null, "aria-checked": item.checked ? "true" : null, text: (item.checked ? "✓ " : "") + item.label, onclick: () => finish(item) }));
      }
    };
    add(items);
    const finish = (item) => { menu.remove(); document.removeEventListener("mousedown", outside, true); resolve(item); };
    const outside = (event) => { if (!menu.contains(event.target)) finish(null); };
    menu.addEventListener("dismiss", () => finish(null));
    menu.addEventListener("keydown", (event) => {
      const buttons = [...menu.querySelectorAll("button:not([aria-disabled])")], index = buttons.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); finish(null); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    });
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(point.x, window.innerWidth - rect.width - 6)) + "px";
    menu.style.top = Math.max(6, Math.min(point.y, window.innerHeight - rect.height - 6)) + "px";
    document.addEventListener("mousedown", outside, true);
    menu.querySelector("button:not([aria-disabled])")?.focus({ preventScroll: true });
  });
}
function menuPointFor(button) {
  const rect = button.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

// Shortcut labels for menu items mirror the native menu's current bindings.
let _shortcuts = new Map();
export async function refreshShortcutLabels() {
  try { _shortcuts = new Map((await window.bridge.menu?.shortcuts?.() || []).map((item) => [item.command, item.accelerator])); } catch { /* keep the previous labels */ }
}
const shortcutFor = (command) => _shortcuts.get(command) || undefined;
const commandItem = (label, command, extra = {}) => ({ label: t(label), shortcut: shortcutFor(command), run: () => app.handleCommand(command, {}), ...extra });

// ---------------------------------------------------------------------------
// window integration: drag regions, appearance, view state
// ---------------------------------------------------------------------------
let _dragKey = "";
function visibleRect(node) {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && node.getClientRects().length ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)] : null;
}
export function publishDragRegions() {
  if (!window.bridge.window?.dragRegions) return;
  const drag = $$("[data-drag-region]").map(visibleRect).filter(Boolean);
  const interactive = $$("[data-drag-region] :is(button, input, select, a[href], [role=button])").map(visibleRect).filter(Boolean);
  const key = JSON.stringify([drag, interactive]);
  if (key === _dragKey) return;
  _dragKey = key;
  void window.bridge.window.dragRegions({ drag, interactive }).then((state) => {
    if (state && typeof state.fullscreen === "boolean") document.body.classList.toggle("fullscreen", state.fullscreen);
  }).catch(() => {});
}

function parseColor(value) {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(value || "");
  return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : null;
}
// The chrome follows the document theme: dark themes switch the window to the
// dark appearance so window buttons, menus, sheets and scrollbars match.
let _appearanceKey = "";
export function syncAppearance() {
  const color = parseColor(window.getComputedStyle(document.body).backgroundColor) || parseColor(window.getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
  const dark = color.a > 0 && luminance < 0.45;
  const hex = "#" + [color.r, color.g, color.b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("");
  document.body.classList.toggle("ui-dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  // Diagrams follow the palette and the typeface, which themes can change alone.
  app.editor?.setDiagramTheme?.(dark);
  const key = dark + hex;
  if (key === _appearanceKey) return;
  _appearanceKey = key;
  void window.bridge.window?.appearance?.({ dark, background: hex }).catch(() => {});
}

let _viewKey = "", zoomPopoverOpen = false;
export function publishViewState() {
  const body = document.body.classList;
  const state = { sidebar: !body.contains("sidebar-hidden"), sidebarView: app.sidebarView || "tree", fileView: app.fileView || "tree", outline: outlineIsOpen(), toolbar: !$("#document-toolbar").hidden, zoomFactor: app.documentZoom || 1, zoomPopover: zoomPopoverOpen, source: body.contains("sourceview-on"), readonly: !!app.editor?.readOnly, focus: body.contains("on-focus-mode"), typewriter: body.contains("typewriter-mode"), theme: app.theme, lineEndings: app._lineEndingOverride === "preserve" ? "" : app._lineEndingOverride || app.settings.lineEndings || "" };
  const percentage = Math.round(state.zoomFactor * 100) + "%";
  $("#tb-zoom").textContent = percentage; $("#zoom-value").textContent = percentage;
  // Like a browser, show the zoom only when the document isn't at actual size.
  $("#tb-zoom").hidden = percentage === "100%" && !zoomPopoverOpen;
  $("#zoom-mouse-option").checked = !!app.settings.zoomByMouse;
  $("#zoom-popover [data-command='view.zoomIn']").disabled = state.zoomFactor >= 3;
  $("#zoom-popover [data-command='view.zoomOut']").disabled = state.zoomFactor <= 0.5;
  for (const button of $$("#document-toolbar .ui-toolbar-edit")) button.disabled = state.readonly || body.contains("oversize");
  $("#tb-source")?.setAttribute("aria-pressed", String(state.source));
  $("#tb-outline")?.setAttribute("aria-pressed", String(state.outline));
  const key = JSON.stringify(state);
  if (key === _viewKey) return;
  _viewKey = key;
  void window.bridge.menu?.state?.(state).catch(() => {});
}

// ---------------------------------------------------------------------------
// library sidebar
// ---------------------------------------------------------------------------
const expandedLibraries = new Map();
const fileNames = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const fileDates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fileDatesWithYear = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
let fileListState = null, fileListFrame = 0;

const libraryRoot = () => app._libraryRoot || null;

// The sidebar shows Files or Outline. Files is a tree ("tree") or a dated list
// ("articles"); searching ("search") temporarily replaces it.
const filesView = () => app.fileView === "list" ? "articles" : "tree";

export function applySidebarSettings() {
  if (!app.sidebarView) {
    // Each window keeps its own view; a new one starts with the last view chosen.
    let remembered;
    try { remembered = window.sessionStorage.getItem("lettrine.sidebarView"); } catch { /* storage may be unavailable */ }
    app.fileView = remembered === "tree" || remembered === "articles" ? (remembered === "articles" ? "list" : "tree") : app.settings.fileView === "list" ? "list" : "tree";
    app.sidebarView = remembered === "outline" || !remembered && app.settings.sidebarOutline ? "outline" : filesView();
    syncSidebarViews();
    if (app.sidebarView === "outline") renderOutline();
  }
}

function syncSidebarViews() {
  const mode = app.sidebarView || "tree", outline = mode === "outline", search = mode === "search";
  for (const tab of $$("[data-sidebar-view]")) {
    const selected = (tab.dataset.sidebarView === "outline") === outline;
    tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  $(".library-head").hidden = outline || search;
  $("#file-library-search-panel").hidden = !search;
  $("#file-library").hidden = outline || search;
  $("#file-library-search").hidden = !search;
  $("#sidebar-outline").hidden = !outline;
}

let outlineOpenedSidebar = false;
export function setSidebarMode(mode, { focus = true } = {}) {
  if (mode === "files" || mode === "list") mode = "articles";
  if (!["tree", "articles", "outline", "search"].includes(mode)) return;
  outlineOpenedSidebar = false;
  if (mode !== "search") {
    app._sidebarPreviousView = mode;
    clearLibrarySearch();
    if (!!app.settings.sidebarOutline !== (mode === "outline")) {
      app.settings.sidebarOutline = mode === "outline"; app.persistSettings?.({ sidebarOutline: mode === "outline" });
    }
  } else if (app.sidebarView && app.sidebarView !== "search") app._sidebarPreviousView = app.sidebarView;
  app.sidebarView = mode;
  if (mode === "tree" || mode === "articles") app.fileView = mode === "articles" ? "list" : "tree";
  try { window.sessionStorage.setItem("lettrine.sidebarView", mode); } catch { /* keep the view in memory */ }
  showSidebar();
  syncSidebarViews();
  if (mode === "outline") renderOutline();
  else if (mode === "search") { void renderFileSearch(); if (focus && libraryRoot()) $("#file-library-search-input").focus(); }
  else renderFileList();
  publishViewState();
}

export function showSidebar() {
  if (!document.body.classList.contains("sidebar-hidden")) return;
  document.body.classList.remove("sidebar-hidden");
  app.settings.sidebarVisible = true;
  app.persistSettings?.({ sidebarVisible: true });
  afterLayoutChange();
  if (app.sidebarView === "outline") renderOutline();
}

function hideSidebar() {
  if (document.body.classList.contains("sidebar-hidden")) return;
  document.body.classList.add("sidebar-hidden");
  app.settings.sidebarVisible = false;
  app.persistSettings?.({ sidebarVisible: false });
  afterLayoutChange();
  publishViewState();
}

export function focusLibrarySearch() {
  if (!libraryRoot()) { setSidebarMode(filesView()); notify(t("Open a folder to search its files.")); return; }
  setSidebarMode("search", { focus: false });
  const input = $("#file-library-search-input");
  input.focus(); input.select();
}

// Esc and the close button end a search and return to the previous view.
function closeLibrarySearch() {
  resetLibrarySearch();
  setSidebarMode(app._sidebarPreviousView || filesView());
  const row = app.sidebarView !== "outline" && $("#file-library-list .file-list-item[tabindex='0']");
  (row || app.editor?.root)?.focus();
}

function sortComparator() {
  const { key = "natural", asc = true } = app.sort || {};
  return (a, b) => {
    let result;
    if (key === "date") result = (a.mtimeMs || 0) - (b.mtimeMs || 0) || fileNames.compare(a.name, b.name);
    else result = fileNames.compare(a.name, b.name);
    return asc ? result : -result;
  };
}

export function renderFileList() {
  const list = $("#file-library-list");
  const root = libraryRoot(), files = app.files || [];
  const tree = app.fileView !== "list";
  syncSidebarViews();
  document.body.classList.toggle("has-library", !!root);
  const label = $("#library-name");
  label.textContent = root ? baseName(root) : t("No Folder Open");
  $("#library-menu-btn").title = root ? tildify(root) : t("Open a folder");
  list.removeAttribute("aria-activedescendant");
  if (!root) { fileListState = null; list.classList.remove("ui-windowed-files"); list.setAttribute("role", "presentation"); list.replaceChildren(libraryEmptyState()); return; }
  if (app.sidebarView === "outline" || app.sidebarView === "search") return;
  list.setAttribute("role", tree ? "tree" : "list");
  const previous = fileListState;
  const key = JSON.stringify([root, tree, app.sort, app.file, [...(expandedLibraries.get(root) || [])]]);
  if (previous?.files === files && previous.key === key) { paintFileRows(); return; }
  const documents = files.filter((file) => !file.isDirectory);
  if (!documents.length && !files.length) {
    fileListState = null;
    list.classList.remove("ui-windowed-files");
    list.replaceChildren(el("div", { class: "empty-state" }, icon("file", "icon-lg"), el("strong", { text: t("No Markdown files") }),
      el("p", { text: format("Create a file to start writing in “{0}”.", baseName(root)) }),
      el("div", { class: "button-row" }, el("button", { type: "button", class: "ui-btn", text: t("New File"), onclick: () => app.newFile() }))));
    return;
  }
  if (!expandedLibraries.has(root)) expandedLibraries.set(root, new Set());
  const expanded = expandedLibraries.get(root);
  if (tree && app._lastTreeFile !== app.file) {
    let parent = parentOf(app.file || "");
    while (parent && parent !== root && parent.startsWith(root + "/")) { expanded.add(parent); parent = parentOf(parent); }
    app._lastTreeFile = app.file;
  }
  const rows = tree ? fileTreeRows(files, root, expanded, sortComparator()) : documents.slice().sort(sortComparator());
  const activeExists = rows.some((row) => row.path === app.file);
  fileListState = { files, key, rows, tree, root, expanded, focusPath: activeExists ? app.file : rows[0]?.path, start: -1 };
  if (previous?.root !== root || previous.tree !== tree) $("#sidebar-content").scrollTop = 0;
  paintFileRows();
}

function paintFileRows() {
  const state = fileListState;
  if (!state || !["tree", "articles"].includes(app.sidebarView)) return;
  const list = $("#file-library-list"), scroller = $("#sidebar-content");
  const virtual = state.rows.length > 200, height = state.tree ? 28 : 48;
  const first = virtual ? Math.max(0, Math.floor(scroller.scrollTop / height) - 8) : 0;
  const end = virtual ? Math.min(state.rows.length, first + Math.ceil((scroller.clientHeight || 700) / height) + 17) : state.rows.length;
  const start = Math.min(first, Math.max(0, state.rows.length - 1));
  if (state.start === start && state.end === end) return;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  state.start = start; state.end = end;
  list.classList.toggle("ui-windowed-files", virtual);
  const fragment = document.createDocumentFragment();
  const spacer = (size) => el("div", { class: "ui-file-spacer", role: "presentation", style: `height:${size}px` });
  if (virtual) fragment.appendChild(spacer(start * height));
  const focusVisible = state.rows.slice(start, end).some(row => row.path === state.focusPath);
  for (let index = start; index < end; index++) {
    const row = fileRow(state.rows[index], { ...state, focusable: state.rows[index].path === state.focusPath || !focusVisible && index === start });
    row.dataset.index = index;
    if (!state.tree) {
      row.setAttribute("aria-setsize", String(state.rows.length));
      row.setAttribute("aria-posinset", String(index + 1));
    }
    fragment.appendChild(row);
  }
  if (virtual) fragment.appendChild(spacer((state.rows.length - end) * height));
  list.replaceChildren(fragment);
  if (focused) [...list.querySelectorAll("[data-path]")].find((row) => row.dataset.path === focused)?.focus({ preventScroll: true });
}

function focusFileRow(index) {
  const state = fileListState, file = state?.rows[index];
  if (!file) return;
  state.focusPath = file.path;
  if (state.rows.length > 200) {
    const scroller = $("#sidebar-content"), height = state.tree ? 28 : 48;
    if (index * height < scroller.scrollTop) scroller.scrollTop = index * height;
    else if ((index + 1) * height > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = (index + 1) * height - scroller.clientHeight;
  }
  state.start = -1;
  paintFileRows();
  const rows = [...$("#file-library-list").querySelectorAll("[data-path]")];
  for (const row of rows) row.tabIndex = row.dataset.path === file.path ? 0 : -1;
  rows.find((row) => row.dataset.path === file.path)?.focus({ preventScroll: true });
}

function fileRow(file, { tree, root, expanded, focusable }) {
  const row = el("div", {
    class: "file-list-item" + (file.path === app.file ? " active" : ""),
    role: tree ? "treeitem" : "listitem",
    tabindex: focusable ? "0" : "-1",
    title: tildify(file.path),
    "aria-current": file.path === app.file ? "page" : null,
    dataset: { path: file.path, kind: file.isDirectory ? "folder" : "file" },
  });
  if (tree) {
    row.style.paddingLeft = (8 + file.depth * 14) + "px";
    row.setAttribute("aria-level", String(file.depth + 1));
    if (file.isDirectory) row.setAttribute("aria-expanded", String(!!file.expanded));
    row.appendChild(el("span", { class: "tree-twisty" }, file.isDirectory ? icon("chevron-right") : null));
  }
  row.appendChild(el("span", { class: "file-icon" }, icon(file.isDirectory ? "folder" : "file")));
  if (tree) row.appendChild(nameNode(file.name));
  else {
    const folder = parentOf(file.path), relative = folder === root ? baseName(root) : folder.slice(root.length + 1);
    const text = el("span", { class: "file-name" }, nameNode(file.name, "file-title"));
    const sub = [relative, relativeTime(file.mtimeMs)].filter(Boolean).join(" · ");
    if (sub) text.appendChild(el("span", { class: "file-sub", text: sub }));
    row.appendChild(text);
  }
  const toggle = () => {
    if (expanded.has(file.path)) expanded.delete(file.path); else expanded.add(file.path);
    renderFileList();
    [...document.querySelectorAll("#file-library-list [data-path]")].find((item) => item.dataset.path === file.path)?.focus();
  };
  row.addEventListener("click", () => {
    if (file.isDirectory && tree) toggle();
    else if (file.isDirectory) app.openFolder(file.path);
    else app.openFile(file.path);
  });
  row.addEventListener("keydown", (event) => {
    const items = fileListState.rows, index = Number(row.dataset.index);
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); row.click(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); focusFileRow(index + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusFileRow(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); focusFileRow(0); }
    else if (event.key === "End") { event.preventDefault(); focusFileRow(items.length - 1); }
    else if (tree && event.key === "ArrowRight" && file.isDirectory) { event.preventDefault(); if (!file.expanded) toggle(); else focusFileRow(index + 1); }
    else if (tree && event.key === "ArrowLeft") {
      event.preventDefault();
      if (file.isDirectory && file.expanded) toggle();
      else focusFileRow(items.findIndex((item) => item.path === parentOf(file.path)));
    }
  });
  row.addEventListener("contextmenu", (event) => { event.preventDefault(); app.fileContextMenu(file, event.clientX, event.clientY); });
  return row;
}

function libraryEmptyState() {
  const recents = [...new Set((app.recentFolders || []).map((folder) => typeof folder === "string" ? folder : folder?.path).filter(Boolean))].slice(0, 5);
  const actions = el("div", { class: "button-row" }, el("button", { type: "button", class: "ui-btn ui-btn-primary", text: t("Open Folder…"), onclick: () => app.openFolder(null) }));
  // The folder switcher above already says that no folder is open.
  const container = el("div", { class: "empty-state library-empty" }, icon("folder", "icon-lg"),
    el("p", { text: t("Open a folder to browse, search and organize its Markdown files.") }), actions);
  if (app.file) {
    const parent = parentOf(app.file);
    actions.prepend(el("button", { type: "button", class: "ui-btn", text: format("Open “{0}”", baseName(parent)), title: tildify(parent), onclick: () => app.openFolder(parent) }));
  }
  if (recents.length) {
    const block = el("div", { class: "empty-recents" }, el("div", { class: "search-section-title", text: t("Recent Folders") }));
    for (const path of recents) {
      block.appendChild(el("div", { class: "file-list-item search-file-row", role: "button", tabindex: "0", title: tildify(path), onclick: () => app.openFolder(path), onkeydown: (event) => { if (event.key === "Enter") app.openFolder(path); } },
        el("span", { class: "file-icon" }, icon("folder")), el("span", { class: "file-name", text: baseName(path) })));
    }
    container.appendChild(block);
  }
  return container;
}

async function openLibraryMenu(button) {
  const root = libraryRoot();
  const pinned = Array.isArray(app.settings.pinnedFolders) ? app.settings.pinnedFolders : [];
  const recents = [...new Set((app.recentFolders || []).map((folder) => typeof folder === "string" ? folder : folder?.path).filter((folder) => folder && !pinned.includes(folder)))].slice(0, 8);
  const choices = [...pinned, ...recents];
  const folderItem = (path) => ({ label: baseName(path) + (choices.filter((other) => baseName(other) === baseName(path)).length > 1 ? " — " + tildify(parentOf(path)) : ""), checked: path === root, run: () => app.openFolder(path) });
  button.setAttribute("aria-expanded", "true");
  await showMenu([
    pinned.length ? { label: t("Pinned Folders"), enabled: false } : null,
    ...pinned.map(folderItem),
    pinned.length ? { separator: true } : null,
    ...recents.map(folderItem),
    recents.length ? { separator: true } : null,
    { label: t("Open Folder…"), run: () => app.openFolder(null) },
    root ? { separator: true } : null,
    root ? { label: t("Reveal in Finder"), run: () => window.bridge.path.showInFinder({ path: root }) } : null,
    root ? { label: t("Refresh"), run: () => app.refreshFolderQuiet() } : null,
    root ? { label: t(pinned.includes(root) ? "Unpin This Folder" : "Pin This Folder"), run: () => {
      app.settings.pinnedFolders = pinned.includes(root) ? pinned.filter((path) => path !== root) : [...pinned, root];
      app.persistSettings?.({ pinnedFolders: app.settings.pinnedFolders });
    } } : null,
    root ? { label: t("Close Folder"), run: () => app.closeFolder() } : null,
  ], menuPointFor(button));
  button.setAttribute("aria-expanded", "false");
}

async function openViewOptions(button) {
  const sort = app.sort || { key: "natural", asc: true };
  const byDate = sort.key === "date";
  const setSort = (key, asc) => { app.sort = { key, asc }; app.settings.librarySort = app.sort; app.persistSettings?.({ librarySort: app.sort }); renderFileList(); };
  button.setAttribute("aria-expanded", "true");
  await showMenu([
    { label: t("View as Tree"), checked: app.fileView !== "list", run: () => app.handleCommand("view.tree") },
    { label: t("View as List"), checked: app.fileView === "list", run: () => app.handleCommand("view.files") },
    { separator: true },
    { label: t("Sort by Name"), checked: !byDate, run: () => setSort("natural", true) },
    { label: t("Sort by Date Modified"), checked: byDate, run: () => setSort("date", false) },
    { label: byDate ? t("Newest First") : t("A to Z"), checked: byDate ? !sort.asc : sort.asc, run: () => setSort(sort.key, byDate ? false : true) },
    { label: byDate ? t("Oldest First") : t("Z to A"), checked: byDate ? sort.asc : !sort.asc, run: () => setSort(sort.key, byDate ? true : false) },
    { separator: true },
    { label: t("New Folder…"), run: () => app.handleCommand("library.newFolder") },
  ], menuPointFor(button));
  button.setAttribute("aria-expanded", "false");
}

// --- search in folder ------------------------------------------------------
let _fileSearchSeq = 0, _fileSearchTimer = null, _fileSearchContext = null;
function cancelFileSearch() {
  ++_fileSearchSeq;
  _fileSearchContext = null;
  clearTimeout(_fileSearchTimer);
  void window.bridge.search?.stop?.().catch(() => {});
}
// Search is transient: leaving it discards the query and its results.
function clearLibrarySearch() {
  cancelFileSearch();
  $("#file-library-search-input").value = "";
  $("#file-library-search-result").replaceChildren();
  $("#file-library-search-panel").classList.remove("has-query");
}
export function resetLibrarySearch() {
  clearLibrarySearch();
  if (app.sidebarView === "search") {
    app.sidebarView = app._sidebarPreviousView || filesView();
    try { window.sessionStorage.setItem("lettrine.sidebarView", app.sidebarView); } catch { /* keep the view in memory */ }
    publishViewState();
  }
  syncSidebarViews();
}

function searchOptions() {
  const pressed = (id) => document.getElementById(id).getAttribute("aria-pressed") === "true";
  return { caseSensitive: pressed("filesearch-case-option-btn"), regex: pressed("filesearch-regexp-option-btn"), wholeWord: pressed("filesearch-word-option-btn") };
}
function setSearchActive(active) {
  syncSidebarViews();
  $("#file-library-search-panel").classList.toggle("has-query", active);
}
function highlightedLine(text, expression) {
  const node = el("span", { class: "search-match-text" });
  const matches = expression ? findAll(text, expression, 20) : [];
  // Long lines start shortly before the first match so it stays visible.
  let last = 0;
  if (matches[0]?.start > 18) { last = text.lastIndexOf(" ", matches[0].start - 8) + 1 || matches[0].start - 8; node.append("…"); }
  for (const match of matches) {
    if (match.end <= match.start) continue;
    node.append(text.slice(last, match.start), el("mark", { text: text.slice(match.start, match.end) }));
    last = match.end;
  }
  node.append(text.slice(last));
  return node;
}
async function renderFileSearch() {
  const output = $("#file-library-search-result");
  const query = $("#file-library-search-input").value.trim();
  cancelFileSearch();
  const seq = _fileSearchSeq;
  if (!query) {
    setSearchActive(false);
    output.replaceChildren(libraryRoot() ? el("div", { class: "search-status", text: t("Search file names and contents in this folder.") }) : libraryEmptyState());
    return;
  }
  setSearchActive(true);
  const options = searchOptions();
  output.replaceChildren(el("div", { class: "search-status", text: t("Searching…") }));
  const scope = libraryRoot() || app.folder;
  _fileSearchContext = { seq, query, options, scope };
  let result = null;
  if (scope && window.bridge.search) {
    try { result = await window.bridge.search.query({ folder: scope, text: query, caseSensitive: options.caseSensitive, useRegexp: options.regex, wholeWord: options.wholeWord, requestId: seq }); }
    catch { /* fall back to file names */ }
  }
  if (seq !== _fileSearchSeq) return;
  if (result?.cancelled) return;
  paintFileSearch(result, { query, options, scope });
}
function paintFileSearch(result, { query, options, scope }, pending = false) {
  const output = $("#file-library-search-result");
  const focused = output.contains(document.activeElement) ? document.activeElement.dataset.searchKey : null;
  output.replaceChildren();
  let expression = null;
  try { expression = compileFind({ query, regex: options.regex, caseSensitive: options.caseSensitive, wholeWord: options.wholeWord }); } catch { /* invalid pattern */ }
  if (!result) {
    const hits = (app.files || []).filter((file) => !file.isDirectory && (options.caseSensitive ? file.name.includes(query) : file.name.toLowerCase().includes(query.toLowerCase())));
    result = { nameMatches: hits.map((file) => file.path), contentMatches: [] };
  }
  if (result.error) { output.appendChild(el("div", { class: "search-status is-error", text: result.error })); return; }
  const { nameMatches = [], contentMatches = [] } = result;
  if (!nameMatches.length && !contentMatches.length) {
    output.appendChild(el("div", { class: "search-status", text: pending ? t("Searching…") : format("No results for “{0}”", query) }));
    return;
  }
  const folder = (scope || "").replace(/\/+$/, "");
  const full = (path) => path.startsWith("/") ? path : folder + "/" + path;
  const subPath = (path) => { const parent = parentOf(full(path)); return parent === folder ? "" : parent.slice(folder.length + 1); };
  if (nameMatches.length) {
    output.appendChild(el("div", { class: "search-section-title", text: t("File Names") }));
    for (const path of nameMatches) {
      output.appendChild(el("div", { class: "file-list-item search-file-row search-name-row", role: "button", tabindex: "0", dataset: { searchKey: "name:" + full(path) }, title: tildify(full(path)), onclick: () => app.openFile(full(path)) },
        el("span", { class: "file-icon" }, icon("file")), nameNode(baseName(path)), subPath(path) ? el("span", { class: "search-hit-count", text: subPath(path) }) : null));
    }
  }
  if (contentMatches.length) {
    output.appendChild(el("div", { class: "search-section-title", text: t("Text Matches") }));
    for (const [path, matches] of contentMatches) {
      output.appendChild(el("div", { class: "file-list-item search-file-row", role: "button", tabindex: "0", dataset: { searchKey: "file:" + full(path) }, title: tildify(full(path)), onclick: () => app.openFile(full(path), matches[0]?.line) },
        el("span", { class: "file-icon" }, icon("file")), nameNode(baseName(path)), el("span", { class: "search-hit-count", text: String(matches.length) })));
      for (const match of matches) {
        output.appendChild(el("div", { class: "search-match-row", role: "button", tabindex: "0", dataset: { searchKey: "line:" + full(path) + ":" + match.line }, onclick: () => app.openFile(full(path), match.line) },
          el("span", { class: "search-match-line", text: String(match.line) }), highlightedLine(match.text, expression)));
      }
    }
  }
  if (pending) output.appendChild(el("div", { class: "search-status", text: t("Searching…") }));
  if (focused) [...output.querySelectorAll("[data-search-key]")].find(row => row.dataset.searchKey === focused)?.focus({ preventScroll: true });
}

// --- sidebar wiring ----------------------------------------------------------
export function initSidebar() {
  const scroller = $("#sidebar-content");
  const scheduleRows = () => {
    if (fileListFrame) return;
    fileListFrame = requestAnimationFrame(() => { fileListFrame = 0; paintFileRows(); });
  };
  scroller.addEventListener("scroll", scheduleRows, { passive: true });
  if (window.ResizeObserver) new window.ResizeObserver(scheduleRows).observe(scroller);
  window.bridge.on?.("search.results", (result) => {
    const context = _fileSearchContext;
    if (context && context.seq === result.requestId && context.seq === _fileSearchSeq) paintFileSearch(result, context, true);
  });
  const tabs = $$("[data-sidebar-view]");
  for (const tab of tabs) {
    // Choosing Files again while searching keeps the search.
    const select = () => {
      if (tab.dataset.sidebarView === "outline") setSidebarMode("outline");
      else if (app.sidebarView === "outline") setSidebarMode(filesView());
    };
    tab.addEventListener("click", select);
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : -1;
      if (next < 0) return;
      event.preventDefault(); tabs[next].click(); tabs[next].focus();
    });
  }
  $("#library-menu-btn").addEventListener("click", (event) => openLibraryMenu(event.currentTarget));
  $("#library-options-btn").addEventListener("click", (event) => openViewOptions(event.currentTarget));
  $("#library-new-btn").addEventListener("click", () => app.newFile());
  const input = $("#file-library-search-input");
  $("#file-library-search-close").addEventListener("click", () => closeLibrarySearch());
  input.addEventListener("input", () => {
    if (app.sidebarView !== "search") {
      app._sidebarPreviousView = app.sidebarView || "tree"; app.sidebarView = "search"; syncSidebarViews(); publishViewState();
      try { window.sessionStorage.setItem("lettrine.sidebarView", "search"); } catch { /* keep the view in memory */ }
    }
    cancelFileSearch(); setSearchActive(!!input.value);
    _fileSearchTimer = setTimeout(renderFileSearch, 160);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); input.blur(); closeLibrarySearch(); }
    if (event.key === "Enter") {
      event.preventDefault(); clearTimeout(_fileSearchTimer);
      const pending = renderFileSearch(), seq = _fileSearchSeq;
      void pending.then(() => { if (seq === _fileSearchSeq) $("#file-library-search-result [role=button]")?.click(); });
    }
    if (event.key === "ArrowDown") { event.preventDefault(); $("#file-library-search-result [role=button]")?.focus(); }
  });
  $("#file-library-search-result").addEventListener("keydown", (event) => {
    const rows = $$("#file-library-search-result [role=button]"), index = rows.indexOf(document.activeElement);
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); document.activeElement?.click(); }
    if (event.key === "ArrowDown") { event.preventDefault(); rows[index + 1]?.focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); (rows[index - 1] || input).focus(); }
  });
  for (const id of ["filesearch-case-option-btn", "filesearch-regexp-option-btn", "filesearch-word-option-btn"]) {
    const button = document.getElementById(id);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => { button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true")); void renderFileSearch(); });
  }

  // resizer
  const resizer = $("#sidebar-resizer");
  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    resizer.classList.add("dragging");
    const move = (ev) => {
      const width = Math.max(200, Math.min(480, ev.clientX));
      document.documentElement.style.setProperty("--sidebar-width", width + "px");
      app.settings.sidebarWidth = width;
    };
    const up = () => {
      resizer.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      app.persistSettings?.({ sidebarWidth: app.settings.sidebarWidth });
      afterLayoutChange();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  resizer.addEventListener("dblclick", () => { document.documentElement.style.setProperty("--sidebar-width", "260px"); app.settings.sidebarWidth = 260; app.persistSettings?.({ sidebarWidth: 260 }); afterLayoutChange(); });
}

// ---------------------------------------------------------------------------
// optional document toolbar
// ---------------------------------------------------------------------------
export function toggleDocumentToolbar(force, persist = true) {
  const toolbar = $("#document-toolbar"), visible = typeof force === "boolean" ? force : toolbar.hidden;
  const hadFocus = toolbar.contains(document.activeElement);
  toolbar.hidden = !visible;
  if (persist) { app.settings.showDocumentToolbar = visible; app.persistSettings?.({ showDocumentToolbar: visible }); }
  if (!visible && hadFocus) (app._sourceCM || app.editor)?.focus();
  publishViewState(); afterLayoutChange();
}

function initDocumentToolbar() {
  const toolbar = $("#document-toolbar");
  toolbar.addEventListener("mousedown", (event) => { if (event.target.closest("button")) event.preventDefault(); });
  toolbar.addEventListener("keydown", (event) => {
    const buttons = [...toolbar.querySelectorAll("button")].filter(button => !button.disabled), index = buttons.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowRight" ? (index + 1) % buttons.length : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length : -1;
    if (next < 0) return;
    event.preventDefault(); buttons.forEach((button, at) => button.tabIndex = at === next ? 0 : -1); buttons[next].focus();
  });
  $("#toolbar-headings").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (app.editor.guardReadOnly()) return;
    button.setAttribute("aria-expanded", "true");
    await showMenu([commandItem("Paragraph", "paragraph.p"), { separator: true }, ...[1,2,3,4,5,6].map(level => commandItem("Heading " + level, "paragraph.h" + level))], menuPointFor(button));
    button.setAttribute("aria-expanded", "false");
  });
}

// ---------------------------------------------------------------------------
// outline (the sidebar's Outline view)
// ---------------------------------------------------------------------------
let _outlineItems = [];
export const outlineIsOpen = () => app.sidebarView === "outline" && !document.body.classList.contains("sidebar-hidden");
// The title-bar button and ⌃⌘O show the outline, and then put the sidebar
// back the way it was: hidden again, or showing the files.
export function toggleOutline(force) {
  const open = typeof force === "boolean" ? force : !outlineIsOpen();
  if (open === outlineIsOpen()) return;
  if (open) {
    const hidden = document.body.classList.contains("sidebar-hidden");
    setSidebarMode("outline");
    outlineOpenedSidebar = hidden;
  } else if (outlineOpenedSidebar) { outlineOpenedSidebar = false; hideSidebar(); }
  else setSidebarMode(filesView());
}

function placePopover(popover, anchor) {
  const rect = anchor.getBoundingClientRect();
  popover.style.top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 8)) + "px";
  popover.style.left = Math.max(8, Math.min(window.innerWidth - popover.offsetWidth - 8, rect.left)) + "px";
}

const outlineViews = new Map();
function visibleOutlineLists() {
  return outlineIsOpen() ? [$("#sidebar-outline-content")] : [];
}
function renderOutline() {
  const lists = visibleOutlineLists();
  if (!lists.length) return;
  const items = app.editor ? app.editor.getOutline() : [];
  _outlineItems = items;
  // Typing rarely changes the headings. Keep the rows, and only follow
  // their block positions, unless a heading's level or text changed.
  const key = (app.i18n?.locale || "en") + "\n" + items.map((item) => item.level + " " + item.text).join("\n");
  for (const list of lists) {
    const previous = outlineViews.get(list);
    if (previous?.key === key && previous.rows.length === items.length && previous.rows.every((row) => row.isConnected)) {
      items.forEach((item, index) => { const block = String(item.blockIndex); if (previous.rows[index].dataset.block !== block) previous.rows[index].dataset.block = block; });
      continue;
    }
    const rows = [];
    outlineViews.set(list, { key, rows });
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(el("div", { class: "empty-state" }, el("strong", { text: t("No headings") }), el("p", { text: t("Headings you add to the document appear here.") })));
      continue;
    }
    const top = Math.min(...items.map((item) => item.level));
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      let label = item.text;
      try { label = readableMarkdown(item.text, app.settings) || item.text; } catch { /* raw text */ }
      const target = (event) => Number(event.currentTarget.dataset.block);
      const jump = (event) => jumpToBlock(target(event));
      const row = el("a", {
        class: "outline-row", role: "link", tabindex: index ? "-1" : "0", title: label,
        style: `--level:${item.level - top}`, dataset: { level: String(item.level), block: String(item.blockIndex) },
        text: label,
        onclick: (event) => { event.preventDefault(); jump(event); },
        onkeydown: (event) => {
          const at = rows.indexOf(event.currentTarget);
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jump(event); }
          const next = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : event.key === "ArrowDown" ? rows[at + 1] : event.key === "ArrowUp" ? rows[at - 1] : null;
          if (next) { event.preventDefault(); rows.forEach((item) => item.tabIndex = item === next ? 0 : -1); next.focus(); }
        },
      });
      rows.push(row); fragment.appendChild(row);
    });
    list.appendChild(fragment);
  }
  updateOutlineCurrent();
}

function jumpToBlock(blockIndex) {
  const editor = app.editor;
  if (app._sourceCM) {
    const cm = app._sourceCM, position = cm.posFromIndex(editor.blockStart(blockIndex));
    cm.setCursor(position); cm.scrollIntoView(position, 80); cm.focus();
    return;
  }
  editor.root.focus({ preventScroll: true });
  editor.placeCaret(blockIndex, 0, { scroll: true });
  editor.root.children[blockIndex]?.scrollIntoView({ block: "start" });
  updateOutlineCurrent(blockIndex);
}

// The current section follows the caret while typing and the viewport while
// scrolling.
export function updateOutlineCurrent(blockIndex) {
  if (!visibleOutlineLists().length || !_outlineItems.length || !app.editor) return;
  let index = blockIndex;
  if (index === undefined && app._sourceCM) index = app.editor.globalOffsetToBlock(app._sourceCM.indexFromPos(app._sourceCM.getCursor())).index;
  if (index === undefined) {
    const scroller = $("#md-content"), bounds = scroller.getBoundingClientRect(), top = bounds.top + 72;
    // Follow the caret while it is on screen; otherwise follow the viewport.
    const caret = (app.editor.root.contains(document.activeElement) || app.editor.root.contains(window.getSelection()?.anchorNode)) && !updateOutlineCurrent._scrolling ? app.editor.caretInfo().blockIndex : -1;
    const caretRect = caret >= 0 ? app.editor.root.children[caret]?.getBoundingClientRect() : null;
    index = caretRect && caretRect.bottom > bounds.top && caretRect.top < bounds.bottom ? caret : -1;
    if (index < 0) {
      // Headings are in document order: find the last one above the line.
      const children = app.editor.root.children;
      let low = 0, high = _outlineItems.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1, node = children[_outlineItems[middle].blockIndex];
        if (node && node.getBoundingClientRect().top <= top) { index = _outlineItems[middle].blockIndex; low = middle + 1; }
        else high = middle - 1;
      }
    }
  }
  let current = -1;
  for (let i = 0; i < _outlineItems.length && _outlineItems[i].blockIndex <= index; i++) current = i;
  for (const list of visibleOutlineLists()) (outlineViews.get(list)?.rows || []).forEach((row, i) => {
    const on = i === current;
    if (row.classList.contains("current") === on) return;
    row.classList.toggle("current", on);
    if (on) row.setAttribute("aria-current", "location"); else row.removeAttribute("aria-current");
  });
}

// ---------------------------------------------------------------------------
// document bar and document popover
// ---------------------------------------------------------------------------
export function setDocumentTitle({ name, status, dirty }) {
  const label = $("#titlebar-document-name");
  if (label && label.textContent !== name) label.replaceChildren(nameNode(name, "doc-stem"));
  const node = $("#titlebar-document-status");
  if (node) {
    if (node.textContent !== status) node.textContent = status;
    node.classList.toggle("is-dirty", !!dirty);
  }
  if ($("#doc-popover") && !$("#doc-popover").hidden) fillDocPopover();
}

let _popoverAnchor = null;
function closeDocPopover() {
  const popover = $("#doc-popover");
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  _popoverAnchor?.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", onPopoverOutside, true);
  _popoverAnchor = null;
}
function onPopoverOutside(event) {
  if (!$("#doc-popover").contains(event.target) && !_popoverAnchor?.contains(event.target)) closeDocPopover();
}
function toggleDocPopover(anchor) {
  const popover = $("#doc-popover");
  if (!popover.hidden && _popoverAnchor === anchor) { closeDocPopover(); return; }
  closeDocPopover();
  closeZoomPopover();
  _popoverAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  popover.hidden = false;
  fillDocPopover();
  const rect = anchor.getBoundingClientRect(), width = popover.offsetWidth;
  popover.style.top = (rect.bottom + 6) + "px";
  popover.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)) + "px";
  document.addEventListener("mousedown", onPopoverOutside, true);
  updateWordCount(app.editor);
}
async function fillDocPopover() {
  const name = app.file ? baseName(app.file) : app.untitledName() + ".md";
  $("#doc-info-name").textContent = name;
  const folder = app.file ? tildify(parentOf(app.file)) : t("Not saved yet"), path = $("#doc-info-path");
  path.replaceChildren(el("bdi", { text: folder }));
  path.title = app.file ? folder : "";
  const actions = $("#doc-info-actions");
  actions.querySelector('[data-doc-action="save"]').hidden = !!app.file;
  for (const action of ["reveal", "copy-path", "history"]) actions.querySelector(`[data-doc-action="${action}"]`).hidden = !app.file;
  const meta = $("#doc-info-meta");
  meta.textContent = "";
  if (!app.file) return;
  const file = app.file;
  try {
    const stat = await window.bridge.library.statFile({ path: file });
    if (file !== app.file) return;
    meta.textContent = format("Modified {0}", new Date(stat.mtimeMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })) + " · " + formatBytes(stat.size);
  } catch { /* the path may have moved */ }
}
function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function closeZoomPopover(restoreFocus = false) {
  if (!zoomPopoverOpen) return;
  zoomPopoverOpen = false; $("#zoom-popover").hidden = true;
  $("#tb-zoom").setAttribute("aria-expanded", "false");
  publishViewState();
  // At actual size the button hides again, so focus returns to the document.
  if (restoreFocus) ($("#tb-zoom").hidden ? app.editor?.root : $("#tb-zoom"))?.focus({ preventScroll: true });
}
export function toggleZoomPopover(force) {
  if (typeof force === "boolean" ? !force : zoomPopoverOpen) { closeZoomPopover(true); return; }
  closeDocPopover();
  zoomPopoverOpen = true; $("#zoom-popover").hidden = false;
  $("#tb-zoom").setAttribute("aria-expanded", "true");
  publishViewState(); placePopover($("#zoom-popover"), $("#tb-zoom"));
  $("#zoom-popover [data-command='view.actualSize']").focus({ preventScroll: true });
}

function initDocBar() {
  $("#zoom-mouse-option").addEventListener("change", (event) => {
    app.settings.zoomByMouse = event.target.checked; app.persistSettings?.({ zoomByMouse: event.target.checked });
  });
  $("#zoom-popover").addEventListener("mousedown", (event) => { if (event.target.closest("button")) event.preventDefault(); });
  document.addEventListener("mousedown", (event) => {
    if (zoomPopoverOpen && !$("#zoom-popover").contains(event.target) && !$("#tb-zoom").contains(event.target)) closeZoomPopover();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (zoomPopoverOpen && event.key === "Escape" && !activeModal()) { event.preventDefault(); closeZoomPopover(true); }
  });
  let wheelTotal = 0, wheelTimer = null;
  $("#md-content").addEventListener("wheel", (event) => {
    if (!app.settings.zoomByMouse || !event.metaKey && !event.ctrlKey || event.altKey || !event.deltaY || activeModal()) return;
    event.preventDefault();
    const delta = -event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    if (wheelTotal && Math.sign(wheelTotal) !== Math.sign(delta)) wheelTotal = 0;
    wheelTotal += delta;
    if (wheelTimer) return;
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      const steps = Math.trunc(wheelTotal / 40);
      if (!app.settings.zoomByMouse) { wheelTotal = 0; return; }
      if (!steps) return;
      wheelTotal -= steps * 40;
      void window.bridge.window.zoom({ delta: Math.max(-3, Math.min(3, steps)) }).catch(error => notify(error.message, [], { kind: "error" }));
    }, 75);
  }, { passive: false });
  $("#doc-title").addEventListener("click", (event) => toggleDocPopover(event.currentTarget));
  $("#titlebar-wordcount").addEventListener("click", (event) => toggleDocPopover(event.currentTarget));
  $("#doc-popover").addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); const anchor = _popoverAnchor; closeDocPopover(); anchor?.focus(); } });
  $("#doc-info-actions").addEventListener("click", async (event) => {
    const action = event.target.closest("[data-doc-action]")?.dataset.docAction;
    if (!action) return;
    closeDocPopover();
    try {
      if (action === "save") await app.saveAs();
      if (action === "reveal") await window.bridge.path.showInFinder({ path: app.file });
      if (action === "copy-path") { await window.bridge.clipboard.write({ text: app.file }); notify(t("Path copied")); }
      if (action === "history") await app.handleCommand("file.snapshots");
    } catch (error) { notify(error.message || String(error), [], { kind: "error" }); }
  });
  $("#tb-source").addEventListener("click", () => app.toggleSource());
  document.addEventListener("click", (event) => {
    const command = event.target.closest?.("[data-command]")?.dataset.command;
    if (command) { event.preventDefault(); app.handleCommand(command, {}); }
  });
  $("#md-content").addEventListener("scroll", onDocumentScroll, { capture: true, passive: true });
}
let _scrollFrame = 0;
function onDocumentScroll(event) {
  if (_scrollFrame) return;
  _scrollFrame = requestAnimationFrame(() => {
    _scrollFrame = 0;
    const scroller = event.target === document ? $("#md-content") : event.target;
    document.body.classList.toggle("doc-scrolled", (scroller.scrollTop || 0) > 2);
    updateOutlineCurrent._scrolling = true;
    updateOutlineCurrent();
    updateOutlineCurrent._scrolling = false;
  });
}

// ---------------------------------------------------------------------------
// find & replace
// ---------------------------------------------------------------------------
const search = { query: "", replacement: "", caseSensitive: false, wholeWord: false, regex: false, index: -1, count: 0, matches: [] };
let _findTypingTimer = null;

function compileSearch() {
  const input = $("#search-panel-input");
  try { const result = compileFind(search); input.removeAttribute("aria-invalid"); input.removeAttribute("title"); return result; }
  catch (error) { input.setAttribute("aria-invalid", "true"); input.title = error.message; return null; }
}
function searchText() { return app._sourceCM ? app._sourceCM.getValue() : document.body.classList.contains("sourceview-on") ? $("#source-editor").value : app.editor.getMarkdown(); }
function selectSearchResult(start, end) {
  if (app._sourceCM) { app._sourceCM.setSelection(app._sourceCM.posFromIndex(start), app._sourceCM.posFromIndex(end)); app._sourceCM.scrollIntoView({ from: app._sourceCM.posFromIndex(start), to: app._sourceCM.posFromIndex(end) }, 80); }
  else if (document.body.classList.contains("sourceview-on")) $("#source-editor").setSelectionRange(start, end);
  else {
    app.editor.selectOffsets(start, end);
    const range = rangeForOffsets(start, end);
    const rect = range?.getBoundingClientRect?.(), scroller = $("#md-content"), bounds = scroller.getBoundingClientRect();
    if (rect && (rect.top < bounds.top + 24 || rect.bottom > bounds.bottom - 24)) scroller.scrollTop += rect.top - bounds.top - scroller.clientHeight / 3;
  }
}
function applySearchText(text, caret) {
  if (app.editor.guardReadOnly()) return;
  if (app._sourceCM) {
    const cm = app._sourceCM;
    cm.operation(() => { cm.replaceRange(text, { line: 0, ch: 0 }, cm.posFromIndex(cm.getValue().length), "lettrine-find"); if (caret !== null) cm.setCursor(cm.posFromIndex(caret)); });
  } else if (document.body.classList.contains("sourceview-on")) {
    const textarea = $("#source-editor"); textarea.value = text; if (caret !== null) textarea.setSelectionRange(caret, caret); textarea.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    app.editor.checkpointSelection(); app.editor.setText(text, { docBase: app.editor.docBase, resetHistory: false });
    if (caret !== null) app.editor.selectOffsets(caret);
    app.editor.pushHistory(); app.editor.emit();
  }
}

function findMatches() {
  const text = app.editor ? searchText() : "";
  const re = compileSearch();
  const out = re ? findAll(text, re) : [];
  search.matches = out;
  search.count = out.length;
  if (search.index >= out.length) search.index = out.length ? 0 : -1;
  return out;
}

// --- match highlighting (CSS Custom Highlight API / CodeMirror marks) --------
let _cmMarks = [];
function rangeForOffsets(start, end) {
  const editor = app.editor;
  try {
    const a = editor.globalOffsetToBlock(start), b = editor.globalOffsetToBlock(end);
    const from = positionInBlock(editor.root.children[a.index], a.offset), to = positionInBlock(editor.root.children[b.index], b.offset);
    if (!from?.node || !to?.node) return null;
    const range = document.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    return range;
  } catch { return null; }
}
function clearHighlights() {
  if (window.CSS?.highlights) { CSS.highlights.delete("lettrine-find"); CSS.highlights.delete("lettrine-find-current"); }
  for (const mark of _cmMarks) mark.clear();
  _cmMarks = [];
}
function paintHighlights() {
  clearHighlights();
  if (!$("#md-searchpanel") || $("#md-searchpanel").hidden || !search.matches.length) return;
  const visible = search.matches.slice(0, 1000);
  if (app._sourceCM) {
    const cm = app._sourceCM;
    cm.operation(() => visible.forEach((match, index) => _cmMarks.push(cm.markText(cm.posFromIndex(match.start), cm.posFromIndex(match.end), { className: index === search.index ? "cm-find-current" : "cm-find-hit" }))));
    return;
  }
  if (!window.CSS?.highlights || typeof window.Highlight !== "function" || document.body.classList.contains("sourceview-on")) return;
  const all = [], current = [];
  visible.forEach((match, index) => { const range = rangeForOffsets(match.start, match.end); if (range) (index === search.index ? current : all).push(range); });
  CSS.highlights.set("lettrine-find", new window.Highlight(...all));
  CSS.highlights.set("lettrine-find-current", new window.Highlight(...current));
}

function updateSearchStatus() {
  const status = $("#search-panel-status");
  const invalid = $("#search-panel-input").getAttribute("aria-invalid") === "true";
  status.classList.toggle("no-match", !!search.query && (invalid || search.count === 0));
  status.textContent = !search.query ? "" : invalid ? t("Invalid pattern") : search.count === 0 ? t("No results")
    : search.index >= 0 ? format("{0} of {1}", search.index + 1, search.count) : search.count === 1 ? t("1 match") : format("{0} matches", search.count);
  paintHighlights();
}

export function openSearchpanel(replaceMode) {
  const panel = $("#md-searchpanel");
  const input = $("#search-panel-input");
  const wasHidden = panel.hidden;
  panel.hidden = false;
  panel.classList.add("active");
  document.body.classList.add("search-open");
  setReplaceMode(!!replaceMode || (!wasHidden && panel.classList.contains("searchpanel-replace-mode")));
  // Like other Mac editors, a short single-line selection seeds the query.
  const selected = app.editor && !app._sourceCM && !document.body.classList.contains("sourceview-on") ? app.editor.selectionOffsets() : null;
  if (wasHidden && selected && selected.end > selected.start) {
    const text = searchText().slice(selected.start, selected.end);
    if (text.length < 80 && !text.includes("\n")) { input.value = text; search.query = text; search.index = -1; }
  }
  findMatches(); updateSearchStatus();
  const target = replaceMode ? $("#search-panel-replace-input") : input;
  target.focus({ preventScroll: true });
  if (!replaceMode) input.select();
}
function setReplaceMode(on) {
  $("#md-searchpanel").classList.toggle("searchpanel-replace-mode", on);
  $("#search-panel-replace-toggle").setAttribute("aria-pressed", String(on));
}
export function closeSearchpanel() {
  clearTimeout(_findTypingTimer);
  const panel = $("#md-searchpanel");
  if (panel.hidden) return;
  panel.hidden = true;
  panel.classList.remove("active");
  document.body.classList.remove("search-open");
  clearHighlights();
  if (app._sourceCM) app._sourceCM.focus(); else if (document.body.classList.contains("sourceview-on")) $("#source-editor").focus(); else if (app.editor) app.editor.root.focus();
}

function doSearchTo(dir = 1) {
  clearTimeout(_findTypingTimer);
  const matches = findMatches();
  if (!matches.length) { updateSearchStatus(); return; }
  if (search.index < 0 || search.index >= matches.length) search.index = dir > 0 ? 0 : matches.length - 1;
  else search.index = (search.index + dir + matches.length) % matches.length;
  const match = matches[search.index];
  selectSearchResult(match.start, match.end);
  updateSearchStatus();
}
function doReplaceNext() {
  if (app.editor.guardReadOnly()) return;
  const result = replaceFind(searchText(), compileSearch(), search.replacement, Math.max(0, search.index));
  if (!result.count) return;
  applySearchText(result.text, result.caret);
  findMatches(); updateSearchStatus();
}
function doReplaceAll() {
  if (app.editor.guardReadOnly()) return;
  const re = compileSearch();
  if (!re) return;
  const result = replaceFind(searchText(), re, search.replacement);
  const n = result.count;
  if (n === 0) return;
  applySearchText(result.text, result.caret);
  notify(n === 1 ? t("Replaced 1 occurrence") : format("Replaced {0} occurrences", n), [
    { label: t("Undo"), onClick: () => app._sourceCM ? app._sourceCM.undo() : app.editor.undo() },
  ]);
  findMatches(); updateSearchStatus();
}

export function initSearchpanel() {
  const input = $("#search-panel-input");
  const rinput = $("#search-panel-replace-input");
  input.addEventListener("input", () => {
    search.query = input.value; search.index = -1;
    clearTimeout(_findTypingTimer);
    findMatches(); updateSearchStatus();
    // Reveal the first match after a short pause, without taking focus.
    _findTypingTimer = setTimeout(() => {
      if (!search.count || search.index >= 0 || $("#md-searchpanel").hidden || document.activeElement !== input) return;
      const match = search.matches.find((item) => item.start >= (app.editor?.selectionOffsets()?.start ?? 0)) || search.matches[0];
      search.index = search.matches.indexOf(match);
      selectSearchResult(match.start, match.end);
      input.focus({ preventScroll: true });
      updateSearchStatus();
    }, 250);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); doSearchTo(event.shiftKey ? -1 : 1); }
    if (event.key === "Escape") { event.preventDefault(); closeSearchpanel(); }
  });
  rinput.addEventListener("input", () => { search.replacement = rinput.value; });
  rinput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); if (event.altKey || event.metaKey) doReplaceAll(); else doReplaceNext(); }
    if (event.key === "Escape") { event.preventDefault(); closeSearchpanel(); }
  });
  $("#search-panel-prev").addEventListener("click", () => doSearchTo(-1));
  $("#search-panel-next").addEventListener("click", () => doSearchTo(1));
  $("#search-panel-replace-btn").addEventListener("click", doReplaceNext);
  $("#search-panel-replaceall-btn").addEventListener("click", doReplaceAll);
  $("#search-panel-close").addEventListener("click", closeSearchpanel);
  $("#search-panel-replace-toggle").addEventListener("click", () => {
    const on = !$("#md-searchpanel").classList.contains("searchpanel-replace-mode");
    setReplaceMode(on);
    (on ? rinput : input).focus();
  });
  const toggle = (id, key) => {
    const button = document.getElementById(id);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      search[key] = !search[key];
      button.setAttribute("aria-pressed", String(search[key]));
      button.classList.toggle("active", search[key]);
      search.index = -1;
      findMatches(); updateSearchStatus();
    });
  };
  toggle("searchpanel-case-option-btn", "caseSensitive");
  toggle("searchpanel-word-option-btn", "wholeWord");
  toggle("searchpanel-regexp-option-btn", "regex");
}

// Keep highlights aligned with edits while the find bar is open.
export function refreshSearchHighlights() {
  if ($("#md-searchpanel")?.hidden !== false || !search.query) return;
  clearTimeout(refreshSearchHighlights._timer);
  refreshSearchHighlights._timer = setTimeout(() => { findMatches(); updateSearchStatus(); }, 250);
}

// ---------------------------------------------------------------------------
// quick open
// ---------------------------------------------------------------------------
const qo = { input: "", open: false, activeIdx: 0, results: [], rows: [], remote: null, request: 0, loading: false };

function libraryPath(file) {
  const root = (libraryRoot() || app.folder || "").replace(/\/+$/, "");
  return root && file.startsWith(root + "/") ? file.slice(root.length + 1) : tildify(file);
}
// Greedy subsequence positions, matching core/fuzzy.js, for bold highlights.
function matchPositions(query, name) {
  const q = query.toLowerCase(), s = name.toLowerCase(), positions = new Set();
  let qi = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) if (s[si] === q[qi]) { positions.add(si); qi++; }
  return qi === q.length ? positions : new Set();
}

function refreshQO(delay = 0) {
  clearTimeout(qo.timer);
  const request = ++qo.request;
  const scope = libraryRoot() || app.folder, text = qo.input;
  qo.remote = null;
  qo.loading = true;
  renderQO();
  const query = async () => {
    try {
      const files = await window.bridge.quickOpen.query({ scope, text });
      if (!qo.open || request !== qo.request) return;
      qo.remote = files || [];
    } catch { /* the local list remains available */ }
    if (!qo.open || request !== qo.request) return;
    qo.loading = false;
    renderQO();
  };
  if (delay) qo.timer = setTimeout(query, delay);
  else void query();
}

function qoItems() {
  const out = [];
  const q = qo.input;
  const recents = (app.recentFiles || []).filter((file) => file?.path);
  const folders = (app.recentFolders || []).map((folder) => typeof folder === "string" ? { name: baseName(folder), path: folder } : folder).filter((folder) => folder?.path);
  const push = (item) => {
    const score = fuzzyScore(q, item.name) ?? fuzzyScore(q, libraryPath(item.path));
    if (score !== null) out.push({ ...item, _score: score });
  };
  for (const file of recents.slice(0, q ? recents.length : 8)) push({ kind: "file", ...file, cat: "recent" });
  for (const file of (qo.remote || app.files || []).filter((x) => !x.isDirectory)) push({ kind: "file", ...file, cat: "file" });
  for (const folder of folders) push({ kind: "folder", ...folder, cat: "folder" });
  const seen = new Set();
  const unique = out.filter((item) => { if (seen.has(item.path)) return false; seen.add(item.path); return true; });
  if (q) unique.sort((a, b) => b._score - a._score || (a.kind === "folder") - (b.kind === "folder"));
  return unique.slice(0, 60);
}

function renderQO() {
  const items = qoItems();
  const previousPath = qo.navigated ? qo.results[qo.activeIdx]?.path : null;
  qo.results = items;
  const previousIndex = previousPath ? items.findIndex((item) => item.path === previousPath) : -1;
  qo.activeIdx = previousIndex >= 0 ? previousIndex : Math.min(qo.activeIdx, Math.max(0, items.length - 1));
  qo.rows = new Array(items.length);
  const groups = { recent: [], file: [], folder: [] };
  for (const item of items) (qo.input ? (item.kind === "folder" ? groups.folder : groups.file) : groups[item.cat] || groups.file).push(item);
  const fill = (inner, list) => {
    const fragment = document.createDocumentFragment();
    for (const item of list) {
      const index = items.indexOf(item);
      const relative = libraryPath(item.path), folder = item.kind === "folder" ? tildify(parentOf(item.path)) : relative.includes("/") ? parentOf(relative) : relative.startsWith("~") ? parentOf(relative) : "";
      const row = el("div", { class: "quick-open-item", id: `quick-open-result-${index}`, role: "option", "aria-selected": "false", title: tildify(item.path), dataset: { path: item.path } },
        el("span", { class: "file-icon" }, icon(item.kind === "folder" ? "folder" : "file")),
        el("span", { class: "qo-item-text" }, nameNode(item.name, "qo-name", qo.input ? matchPositions(qo.input, item.name) : null), folder ? el("span", { class: "qo-path" }, el("bdi", { text: folder })) : null));
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => qoPick(item));
      row.addEventListener("mousemove", () => { if (qo.activeIdx !== index) setQOActive(index, false); });
      fragment.appendChild(row);
      qo.rows[index] = row;
    }
    $(inner).replaceChildren(fragment);
  };
  const show = (id, titleId, inner, list, title) => { document.getElementById(id).hidden = !list.length; $(titleId).textContent = title; fill(inner, list); };
  show("ic-quick-open-recent-category", "#qo-title-recent", "#ic-quick-open-recent-list-inner", groups.recent, t("Recent Files"));
  const root = libraryRoot();
  show("ic-quick-open-infolder-category", "#qo-title-files", "#ic-quick-open-file-list-inner", groups.file, qo.input ? t("Files") : root ? format("In “{0}”", baseName(root)) : t("Files"));
  show("ic-quick-open-folder-category", "#qo-title-folders", "#ic-quick-open-folder-list-inner", groups.folder, t("Recent Folders"));
  const empty = $("#quick-open-empty");
  empty.hidden = !!items.length;
  empty.textContent = qo.loading ? t("Searching…") : qo.input ? t("No matching files") : t("Open a folder or a file to get started.");
  $("#quick-open-list").setAttribute("aria-busy", String(qo.loading));
  $("#quick-open-result-count").textContent = items.length === 1 ? t("1 result") : items.length ? format("{0} results", items.length) : "";
  setQOActive(qo.activeIdx, false);
}

function setQOActive(index, scroll = true) {
  const old = qo.rows[qo.activeIdx];
  old?.classList.remove("active");
  old?.setAttribute("aria-selected", "false");
  qo.activeIdx = Math.max(0, Math.min(index, qo.results.length - 1));
  const active = qo.rows[qo.activeIdx];
  const input = $("#quick-open-input input");
  if (active) {
    active.classList.add("active");
    active.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", active.id);
    if (scroll) active.scrollIntoView?.({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
}

function qoPick(item) {
  closeQO();
  if (item.kind === "folder") app.openFolder(item.path);
  else app.openFile(item.path);
}

export function openQO() {
  if (qo.open) return;
  const box = $("#quick-open");
  qo.previousFocus = document.activeElement;
  box.hidden = false;
  box.classList.add("active");
  qo.open = true;
  qo.input = "";
  qo.activeIdx = 0;
  qo.navigated = false;
  const input = $("#quick-open-input input");
  input.value = "";
  input.setAttribute("aria-expanded", "true");
  refreshQO();
  input.focus();
}
export function closeQO() {
  if (!qo.open) return;
  $("#quick-open").classList.remove("active");
  $("#quick-open").hidden = true;
  $("#quick-open-input input").setAttribute("aria-expanded", "false");
  qo.open = false;
  clearTimeout(qo.timer);
  ++qo.request;
  if (qo.previousFocus?.isConnected) qo.previousFocus.focus({ preventScroll: true });
  else if (app._sourceCM) app._sourceCM.focus();
  else app.editor?.root.focus();
}
export function qoActive() { return qo.open; }

export function initQO() {
  const input = $("#quick-open-input input");
  input.addEventListener("input", () => { qo.input = input.value; qo.activeIdx = 0; qo.navigated = false; refreshQO(80); });
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); qo.navigated = true; setQOActive(qo.activeIdx + (event.key === "ArrowDown" ? 1 : -1)); }
    if (event.key === "Enter") { event.preventDefault(); if (qo.results[qo.activeIdx]) qoPick(qo.results[qo.activeIdx]); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeQO(); }
    if (event.key === "Tab") event.preventDefault();
  });
  document.addEventListener("focusin", (event) => {
    if (qo.open && !$("#quick-open").contains(event.target)) input.focus({ preventScroll: true });
  });
  $("#quick-open-mask").addEventListener("click", closeQO);
}

// ---------------------------------------------------------------------------
// insert table dialog
// ---------------------------------------------------------------------------
let _tableClose = null, _tableTarget = null;
export function openTableDialog() {
  if (app.editor.guardReadOnly() || document.body.classList.contains("oversize")) return;
  const cm = app._sourceCM, textarea = $("#source-editor"), source = document.body.classList.contains("sourceview-on");
  const selection = source ? cm ? { start: cm.indexFromPos(cm.getCursor("from")), end: cm.indexFromPos(cm.getCursor("to")) } : { start: textarea.selectionStart, end: textarea.selectionEnd } : app.editor.selectionOffsets();
  _tableTarget = { id: app._documentId, source, selection };
  const dialog = $("#table-insert-dialog");
  dialog.classList.add("open");
  const previous = document.activeElement;
  const onKey = (event) => { if (event.key === "Escape" && activeModal() === dialog) { event.preventDefault(); closeTableDialog(); } };
  document.addEventListener("keydown", onKey, true);
  _tableClose = () => { document.removeEventListener("keydown", onKey, true); if (previous?.isConnected && !dialog.contains(previous)) previous.focus({ preventScroll: true }); else app.editor?.root.focus(); };
  const columns = $("#table-insert-col");
  columns.focus();
  columns.select();
}
export function closeTableDialog() {
  $("#table-insert-dialog").classList.remove("open");
  const close = _tableClose; _tableClose = null;
  close?.();
}
export function initTableDialog() {
  $("#table-insert-cancel").addEventListener("click", closeTableDialog);
  $("#table-insert-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const cols = Math.max(1, Math.min(20, parseInt($("#table-insert-col").value, 10) || 3));
    const rows = Math.max(1, Math.min(30, parseInt($("#table-insert-row").value, 10) || 4));
    const target = _tableTarget;
    closeTableDialog(); _tableTarget = null;
    if (!target || target.id !== app._documentId || target.source !== document.body.classList.contains("sourceview-on")) return;
    const selection = target.selection;
    if (selection) {
      if (target.source && app._sourceCM) app._sourceCM.setSelection(app._sourceCM.posFromIndex(selection.start), app._sourceCM.posFromIndex(selection.end));
      else if (target.source) $("#source-editor").setSelectionRange(selection.start, selection.end);
      else app.editor.selectOffsets(selection.start, selection.end);
    }
    void app.handleCommand("paragraph.tableInsert", { cols, rows });
  });
}

// ---------------------------------------------------------------------------
// word count
// ---------------------------------------------------------------------------
export function countWords(text) {
  return countText(text || "");
}

// Document totals change only with the source; caret moves reuse them.
let _statsCache = { editor: null, version: -1, stats: null };
export function updateWordCount(editor) {
  if (!editor) return;
  const version = editor.sourceVersion?.() ?? NaN, scripts = !!editor.__settings?.subscriptSuperscript;
  if (_statsCache.editor !== editor || _statsCache.version !== version || _statsCache.scripts !== scripts) _statsCache = { editor, version, scripts, stats: documentStats(editor.blocks, undefined, editor.__settings) };
  const c = _statsCache.stats;
  const sel = window.getSelection();
  let selWords = 0;
  const rawEditor = editor._activeCmBlock()?.cm;
  if (app._sourceCM) selWords = selectionStats(app._sourceCM.getSelection(), editor.__settings).words;
  else if (rawEditor) selWords = selectionStats(rawEditor.getSelection(), editor.__settings).words;
  else if (document.body.classList.contains("sourceview-on")) { const ta = $("#source-editor"); selWords = selectionStats(ta.value.slice(ta.selectionStart, ta.selectionEnd), editor.__settings).words; }
  else if (sel && sel.rangeCount && !sel.isCollapsed && editor.root.contains(sel.anchorNode) && editor.root.contains(sel.focusNode)) {
    const selected = editor.selectionOffsets(); if (selected) selWords = selectionStats(editor.getMarkdown().slice(selected.start, selected.end), editor.__settings).words;
  }
  const write = (id, value) => { const node = document.getElementById(id); if (node && node.textContent !== String(value)) node.textContent = value; };
  const minutes = c.words ? Math.max(1, Math.ceil(c.words / (app.settings.wordsPerMinute || 200))) : 0;
  write("wc-words", c.words.toLocaleString());
  write("wc-chars", c.chars.toLocaleString());
  write("wc-minutes", format("{0} min", minutes));
  write("wc-sel-words", selWords);
  const selection = document.getElementById("doc-info-selection");
  if (selection) selection.hidden = !selWords;
  write("titlebar-wordcount", (c.words === 1 ? t("1 word") : format("{0} words", c.words.toLocaleString())) + (selWords ? " · " + format("{0} selected", selWords) : ""));
  document.body.classList.toggle("doc-empty", !editor.blocks.length || editor.blocks.length === 1 && !editor.blocks[0].src);
}

// ---------------------------------------------------------------------------
// emoji popup
// ---------------------------------------------------------------------------
export function initEmoji() {
  const popup = document.getElementById("emoji-completion");
  window.__hideEmoji = () => {
    popup.classList.remove("active");
    window.__emojiPopupOpen = false;
  };
  const original = maybeEmojiPopup;
  window.__emojiPatch = (editor) => {
    document.getElementById("emoji-completion")?.classList.add("active");
    return original(editor);
  };
}

export function updateEmojiPopupClass() {
  const popup = document.getElementById("emoji-completion");
  if (popup && window.__emojiPopupOpen) popup.classList.add("active");
}

// ---------------------------------------------------------------------------
// layout changes and init
// ---------------------------------------------------------------------------
// The native host reports where AppKit placed the window buttons: the bar
// height (centered on the buttons), a native tab bar below it, and the end of
// the buttons, after which the sidebar toggle sits.
export function applyWindowChrome(state = {}) {
  const root = document.documentElement.style;
  if (typeof state.fullscreen === "boolean") document.body.classList.toggle("fullscreen", state.fullscreen);
  if (state.bar > 0) root.setProperty("--ui-bar", state.bar + "px");
  if (typeof state.tabBar === "number") root.setProperty("--ui-tabbar", state.tabBar + "px");
  if (state.buttonsEnd > 0) root.setProperty("--ui-window-buttons", Math.max(60, state.buttonsEnd - 6) + "px");
  afterLayoutChange();
}

let _layoutFrame = 0;
export function afterLayoutChange() {
  if (_layoutFrame) return;
  _layoutFrame = requestAnimationFrame(() => { _layoutFrame = 0; renderOutline(); if (zoomPopoverOpen) placePopover($("#zoom-popover"), $("#tb-zoom")); publishDragRegions(); publishViewState(); });
}

export function renderFileListPublic() {
  renderFileList();
}

export function renderOutlinePublic() {
  renderOutline();
}

export function doFindNextPublic(dir) {
  doSearchTo(dir);
}

export function initUI(appRef) {
  globalThis.app = appRef;
  // The editor's image menu: its labels are fixed interface text.
  window.__lettrineShowMenu = (items, point) => showMenu(items.map((item) => item?.label ? { ...item, label: t(item.label) } : item), point);
  const modalInputs = (modal) => [...modal.querySelectorAll("input,textarea,select,button,a[href],[tabindex]")].filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
  document.addEventListener("keydown", (event) => {
    const modal = activeModal(); if (!modal || event.key !== "Tab") return;
    const inputs = modalInputs(modal); if (!inputs.length) return;
    if (event.shiftKey && document.activeElement === inputs[0]) { event.preventDefault(); inputs.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === inputs.at(-1)) { event.preventDefault(); inputs[0].focus(); }
  });
  document.addEventListener("focusin", (event) => {
    const modal = activeModal();
    if (modal && !modal.contains(event.target)) modalInputs(modal)[0]?.focus();
  });
  const box = $("#md-notification");
  box?.parentElement.addEventListener("mouseenter", () => clearTimeout(_notifTimer));
  box?.parentElement.addEventListener("mouseleave", () => scheduleHide(2000));
  initSidebar();
  initDocBar();
  initDocumentToolbar();
  initSearchpanel();
  initQO();
  initTableDialog();
  initEmoji();
  renderFileList();
  let selectionFrame = false;
  document.addEventListener("selectionchange", () => {
    if (selectionFrame) return;
    selectionFrame = true;
    requestAnimationFrame(() => { selectionFrame = false; updateWordCount(appRef.editor); appRef.updateWritingModes?.(); updateOutlineCurrent(); });
  });
  if (window.ResizeObserver) {
    const observer = new window.ResizeObserver(() => afterLayoutChange());
    for (const node of [$("#doc-bar"), $(".sidebar-top"), $("#doc-title"), $(".doc-bar-actions")]) if (node) observer.observe(node);
  }
  window.addEventListener("resize", afterLayoutChange);
  // The bars stand in for a title bar: no page context menu there.
  for (const bar of $$("[data-drag-region]")) bar.addEventListener("contextmenu", (event) => { if (!event.target.closest("input, textarea")) event.preventDefault(); });
  window.bridge.on?.("window.state", (state) => applyWindowChrome(state));
  void refreshShortcutLabels();
  afterLayoutChange();
}

// ---------------------------------------------------------------------------
// editor context menu (native)
// ---------------------------------------------------------------------------
export function initContextMenu(appRef) {
  const root = document.getElementById("write");
  if (!root) return;
  root.addEventListener("contextmenu", (event) => {
    if (event.target.closest?.(".md-image, .md-diagram")) return;
    event.preventDefault();
    const editor = appRef.editor;
    const link = event.target.closest?.("a[href], [md-inline=url], .md-link");
    const href = link?.getAttribute?.("href") || link?.dataset?.href || "";
    const fence = event.target.closest?.("pre[mdtype='fences']");
    const formula = event.target.closest?.(".md-inline-math, .md-math-block, .md-diagram[data-diagram=math]");
    const table = event.target.closest?.("[mdtype=table]");
    const emoji = event.target.closest?.(".md-emoji");
    const blockEl = event.target.closest?.("#write > *");
    const hasSelection = !window.getSelection()?.isCollapsed;
    const codeTool = (name) => () => {
      const index = editor.blockIndexOfNode(fence);
      if (index < 0) return;
      if (editor._activeCmBlock()?.index !== index && editor.caretInfo().blockIndex !== index) {
        editor.root.focus(); editor.selectOffsets(editor.blockStart(index) + editor.blocks[index].src.indexOf("\n") + 1);
      }
      return appRef.handleCommand(name);
    };
    void showMenu([
      commandItem("Cut", "edit.cut", { enabled: hasSelection }),
      commandItem("Copy", "edit.copy", { enabled: hasSelection }),
      commandItem("Paste", "edit.paste"),
      { separator: true },
      commandItem("Copy as Markdown", "edit.copyMarkdown", { enabled: hasSelection }),
      { label: t("Copy as Image…"), run: () => appRef.copyAsImage(formula) },
      commandItem("Copy without Theme Styling", "edit.copyCleanHTML"),
      commandItem("Paste as Plain Text", "edit.pastePlain"),
      formula ? { separator: true } : null,
      formula ? { label: t("Copy as MathML"), run: () => appRef.copySpecial("mathml", formula) } : null,
      formula ? { label: t("Copy as TeX"), run: () => appRef.copySpecial("tex", formula) } : null,
      table ? { label: t("Copy Table"), run: () => appRef.copySpecial("table", table) } : null,
      href ? { separator: true } : null,
      href ? { label: t("Open Link"), run: () => appRef.openLink(href) } : null,
      href ? { label: t("Copy Link Address"), run: () => window.bridge.clipboard.write({ text: href }) } : null,
      href ? commandItem("Edit Link…", "inline.link") : null,
      fence ? { separator: true } : null,
      fence ? { label: t("Copy Code Content"), run: () => appRef.copySpecial("code", fence) } : null,
      fence ? { label: t("Code Tools"), submenu: [
        { label: t("Prettify Source Code"), enabled: !editor.readOnly, run: codeTool("code.prettify") },
        { label: t("Auto Indent Whole Code"), enabled: !editor.readOnly, run: codeTool("code.indentWhole") },
        { label: t("Auto Indent Selected Code"), enabled: !editor.readOnly, run: codeTool("code.indentSelected") },
      ] } : null,
      emoji ? { label: t("Copy Emoji"), run: () => window.bridge.clipboard.write({ text: emoji.getAttribute("data-emoji") || emoji.textContent || "" }) } : null,
      { separator: true },
      { label: t("Format"), submenu: [
        commandItem("Strong", "inline.strong"), commandItem("Emphasis", "inline.emphasis"), commandItem("Strike", "inline.strike"),
        commandItem("Highlight", "inline.highlight"), commandItem("Code", "inline.code"), commandItem("Math", "inline.math"),
        { separator: true }, commandItem("Link…", "inline.link"), { separator: true }, commandItem("Clear Formatting", "inline.clear"),
      ] },
      { label: t("Paragraph"), submenu: [
        commandItem("Paragraph", "paragraph.p"), ...[1, 2, 3, 4, 5, 6].map((level) => commandItem("Heading " + level, "paragraph.h" + level)),
        { separator: true }, commandItem("Quote", "paragraph.quote"), commandItem("Ordered List", "paragraph.orderedList"), commandItem("Unordered List", "paragraph.unorderedList"), commandItem("Task List", "paragraph.task"),
      ] },
      { label: t("Insert"), submenu: [
        commandItem("Table…", "paragraph.table"), commandItem("Code Fences", "paragraph.codeFences"), commandItem("Math Block", "paragraph.mathBlock"),
        commandItem("Horizontal Line", "paragraph.hr"), commandItem("Image…", "inline.image"),
      ] },
      blockEl && editor ? { separator: true } : null,
      blockEl && editor ? { label: t("Delete Block"), enabled: !editor.readOnly, destructive: true, run: () => {
        const index = editor.blockIndexOfNode(blockEl);
        if (index < 0) return;
        editor.root.focus(); editor.selectOffsets(editor.blockStart(index) + Math.min(1, editor.blocks[index].src.length));
        return appRef.selectRange("deleteBlock");
      } } : null,
    ], { x: event.clientX, y: event.clientY });
  });
}
