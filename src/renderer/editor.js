// Lettrine editor core — WYSIWYG live-preview engine.
//
// DOM contract (our rendering model):
//   - blocks carry the `mdtype` attribute: paragraph | heading | list |
//     fences | quote | table | math_block | hr | image | html_block | frontmatter
//   - inline content lives in <span class="md-plain">
//   - complete syntax markers: <span class="md-attr"> (hidden, .md-attr{display:none})
//   - incomplete (still typing) markers: <span class="md-tag"> (visible, gray)
//   - non-source decorations (rendered math, <img>, emoji glyph): .md-decor,
//     excluded from source reconstruction via textOf()
//   - every markdown source character is therefore in the DOM and the
//     source is reconstructed as a total walk — no lossy de-render.

import { parseBlocks, blocksToMarkdown, listSrcFromItems, listItemSrc, listKind, inheritBlockLayout, tableCellRanges, blockSeparator, reparseBlocks, quoteLineContent } from "../core/blocks.js";
import { parseInline, segmentsToHtml, escapeHtml } from "../core/inline.js";
import { punctuationInputEdit, rendersSmartPunctuation } from "../core/typography.js";
import { importFormat } from "../core/imports.js";
import { formatImages } from "./image-tools.js";
import { CODE_LANGUAGES, codeModeOf as cmModeOf, codeOptions, newCodeLanguage } from "../core/code-tools.js";
import { codeKeyMap } from "./code-tools.js";
import { renderFenceDiagram, diagramOptions, diagramError } from "./diagrams.js";
import { markdownPairEdit } from "../core/writing-options.js";
import { bindFenceCompletion, bindCodeComposition, hideCodeCompletion } from "./code-completion.js";
import { mathInput, equationIndex, equationTex, equationTrust } from "../core/math.js";
import { fenceInput } from "../core/fences.js";
import { editTableColumn, editTableRow } from "../core/table.js";
import { readableMarkdown } from "../core/readable.js";
import { linkMarkdown } from "../core/links.js";
import { tocOptions } from "../core/toc.js";
import { ALERT_LABELS, alertIcon, alertMarker } from "../core/alerts.js";
import { textChange, applyTextChange, invertTextChange } from "../core/history.js";
import { handleKeydown, doEnter, hardBreak } from "./editor-input.js";
import { handlePaste, maybeEmojiPopup } from "./editor-ops.js";
import { localizeUI } from "./localization.js";

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("data-")) n.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  if (text !== undefined) n.textContent = text;
  return n;
}

// marker span: hidden when syntax complete (md-attr), visible when not (md-tag)
function marker(text, complete = true) {
  return el("span", { class: complete ? "md-attr" : "md-tag" }, text);
}

function inlineEl(src, docBase) {
  const c = el("span", { class: "md-plain" });
  const html = segmentsToHtml(parseInline(src, currentEditor?.__settings), escapeHtml, currentEditor?.__settings);
  // U+200B placeholder in empty blocks (our mechanism): keeps a real
  // text node under the caret so native insertions never escape the block
  if (html) c.innerHTML = html;
  else appendPlaceholder(c);
  c.__docBase = docBase;
  // images and inline math need decorateInline(); most text has neither
  c.__decor = !!html && (html.includes('class="md-image"') || html.includes('class="md-inline-math"'));
  return c;
}

function appendPlaceholder(host, value = "\u200B") {
  const text = document.createTextNode(value);
  text.__mdPlaceholderCount = (value.match(/\u200B/g) || []).length;
  host.appendChild(text);
}

function sourceText(node, end = node.data.length) {
  let remaining = node.__mdPlaceholderCount || 0;
  if (!remaining) return node.data.slice(0, end);
  if (!node.data.includes("\u200B")) node.__mdPlaceholderCount = 0;
  return node.data.slice(0, end).replace(/\u200B/g, (character) => remaining-- > 0 ? "" : character);
}

// ---------------------------------------------------------------------------
// textOf: source text of an element, excluding .md-decor nodes
// ---------------------------------------------------------------------------
export function textOf(node) {
  let out = "";
  const walk = (n) => {
    if (n.nodeType === 3) { out += sourceText(n); return; }
    if (n.nodeType !== 1) return;
    if (n.classList && n.classList.contains("md-decor")) return;
    for (const c of n.childNodes) walk(c);
  };
  walk(node);
  return out;
}

// Offset of (node, offset) within the textOf() text of root — used to map a
// live DOM caret into reconstructed source text.
function domOffsetToText(root, node, offset) {
  if (node === root) {
    let a = 0;
    const kids = root.childNodes;
    for (let i = 0; i < Math.min(offset, kids.length); i++) a += textOf(kids[i]).length;
    return a;
  }
  let acc = 0;
  const walk = (n) => {
    if (n === node) {
      acc += n.nodeType === 3 ? sourceText(n, offset).length : offset;
      return true;
    }
    if (n.nodeType === 3) { acc += sourceText(n).length; return false; }
    if (n.nodeType !== 1) return false;
    if (n.classList && n.classList.contains("md-decor")) return false;
    for (const c of n.childNodes) if (walk(c)) return true;
    return false;
  };
  for (const c of root.childNodes) if (walk(c)) return acc;
  return acc;
}

function resolveUrl(url, docBase) {
  if (!url) return "";
  if (window.bridge?.path?.fileURL && /^file:/i.test(url)) {
    try { return window.bridge.path.fileURL(decodeURIComponent(new URL(url).pathname)); } catch { return url; }
  }
  const settings = window.__lettrine?.settings || {};
  const rootURL = settings.imageRootURL?.replace(/\/$/, "");
  if (settings.imageRootPath && rootURL !== undefined && url.startsWith(rootURL + "/")) {
    let root = settings.imageRootPath;
    if (!root.startsWith("/") && docBase) root = docBase.replace(/[/\\][^/\\]+$/, "") + "/" + root;
    try { return localFileURL(root.replace(/\/$/, "") + "/" + decodeURIComponent(url.slice(rootURL.length + 1))); }
    catch { return url; }
  }
  if (/^(https?:|data:|blob:|file:)/i.test(url)) return url;
  if (url.startsWith("/")) return localFileURL(url);
  if (!docBase) return url;
  const dir = docBase.replace(/[/\\][^/\\]+$/, "");
  try { return new URL(url, localFileURL((dir ? dir + "/" : ""))).href; } catch { return url; }
}

function localFileURL(file) {
  if (window.bridge?.path?.fileURL) return window.bridge.path.fileURL(file);
  const url = new URL("file:///"); url.pathname = file; return url.href;
}

function imageURL(reference, docBase) {
  const resolved = resolveUrl(reference, docBase), version = window.__lettrine?._imageAssetVersion;
  return version && /^(?:lettrine:\/\/file|file:)/i.test(resolved) ? resolved + (resolved.includes("?") ? "&" : "?") + "imageVersion=" + version : resolved;
}

// ---------------------------------------------------------------------------
// decorate: render math + wire image src (decorations are .md-decor)
// ---------------------------------------------------------------------------
function decorateImages(container, docBase) {
  const base = docBase || container.__docBase || null;
  const images = [...(container.matches?.(".md-image") ? [container] : []), ...container.querySelectorAll(".md-image")];
  for (const img of images) {
    const url = img.getAttribute("data-url") || "";
    const i = img.querySelector("img");
    if (i) {
      const resolved = imageURL(url, base);
      i.alt = img.getAttribute("data-alt") || "";
      if (img.dataset.width) i.width = Number(img.dataset.width);
      if (img.dataset.height) i.height = Number(img.dataset.height);
      if (img.dataset.zoom) i.style.zoom = Number(img.dataset.zoom) / 100;
      i.onload = () => { img.classList.add("md-img-loaded"); img.classList.remove("md-img-error"); i.style.display = ""; };
      i.onerror = () => { img.classList.add("md-img-error"); img.classList.remove("md-img-loaded"); i.style.display = "none"; imageErrorHint(img); };
      if (i.getAttribute("src") !== resolved) {
        img.classList.remove("md-img-loaded", "md-img-error"); i.style.display = ""; i.src = resolved;
      }
    }
  }
}

function decorateInline(container, docBase) {
  decorateImages(container, docBase);
  for (const m of container.querySelectorAll(".md-inline-math")) {
    const body = m.querySelector(".md-math-body");
    if (body && body.dataset.rendered) continue;
    if (window.katex && window.__lettrine?.settings?.renderMath !== false) {
      try {
        renderMathPreview(body, m.getAttribute("data-tex") || "", false);
        body.dataset.rendered = "1";
        m.classList.add("md-rendered");
      } catch { /* keep raw tex */ }
    }
  }
}

function imageErrorHint(wrap) {
  if (wrap.querySelector(".md-img-hint")) return;
  const hint = el("span", { class: "md-decor md-img-hint", contenteditable: "false" });
  hint.textContent = window.__lettrine?.i18nT?.("Image unavailable") || "Image unavailable";
  wrap.appendChild(hint);
}

// ---------------------------------------------------------------------------
// block renderers
// ---------------------------------------------------------------------------

function renderParagraph(block) {
  const p = el("p", { mdtype: "paragraph" });
  const inline = inlineEl(block.src, block.__docBase);
  p.appendChild(inline);
  if (inline.__decor) decorateInline(p, block.__docBase);
  return p;
}

function renderHeading(block) {
  const h = el("h" + block.level, { mdtype: "heading" });
  h.dataset.level = String(block.level);
  const complete = block.text.trim().length > 0;
  // the marker owns "# " (separator included): a bare text node between the
  // marker and the span is a fragile caret trap outside the md-plain walk
  const src = block.src || "";
  const prefix = block.setext ? "" : /^(\s{0,3}#{1,6}[ \t]*)/.exec(src)?.[0] || "";
  h.dataset.prefixLength = String(prefix.length);
  if (prefix) h.appendChild(marker(prefix, complete));
  const text = block.setext ? src.slice(0, src.lastIndexOf("\n")) : src.slice(prefix.length);
  const c = inlineEl(text, block.__docBase);
  h.appendChild(c);
  if (c.__decor) decorateInline(h, block.__docBase);
  if (block.setext) h.appendChild(marker(src.slice(src.lastIndexOf("\n")), true));
  if (!complete) h.classList.add("md-simple-empty");
  if (currentEditor?.__settings?.ignoreHeadingBreaks) for (const br of h.querySelectorAll("br")) br.replaceWith(el("span", { class: "md-decor" }, " "));
  return h;
}

// An ordered list counts from its first item's number.
function listElement(first, attrs) {
  const list = el(first?.ordered ? "ol" : "ul", attrs);
  const start = first?.ordered ? parseInt(first.marker, 10) : 1;
  if (Number.isFinite(start) && start !== 1) list.setAttribute("start", String(start));
  return list;
}

function renderList(block) {
  const list = listElement(block.items[0] || block, { mdtype: "list" });
  list.dataset.ordered = block.ordered ? "1" : "0";
  const renderItems = (listEl, items) => {
    for (const it of items) {
      const li = el("li", { mdtype: "list_item" });
      li.dataset.marker = it.marker;
      li.dataset.ordered = it.ordered ? "1" : "0";
      li.dataset.separator = it._before ?? "\n";
      if (it.task) {
        li.classList.add("task-list-item", "md-task-list-item");
      }
      const complete = (it.text && it.text.trim()) || it.task;
      // marker span carries the item's exact source prefix (indent + marker
      // + spacing + task syntax), so the DOM text matches the source line
      li.appendChild(marker(listItemSrc(it).slice(0, listItemSrc(it).length - (it.text || "").length), complete));
      if (it.task) {
        const cb = el("input", { type: "checkbox" });
        cb.className = "md-decor";
        cb.checked = !!it.task.checked;
        li.appendChild(cb);
      }
      // inline span always present (empty → ZWSP) so the caret stays in a
      // text node inside the item
      const c = inlineEl(it.text || "", block.__docBase);
      li.appendChild(c);
      if (c.__decor) decorateInline(li, block.__docBase);
      // nested items of another marker type form a list of their own
      for (let start = 0, end = 1; start < it.children.length; start = end++) {
        while (end < it.children.length && listKind(it.children[end].marker) === listKind(it.children[start].marker)) end++;
        const sub = listElement(it.children[start]);
        renderItems(sub, it.children.slice(start, end));
        li.appendChild(sub);
      }
      listEl.appendChild(li);
    }
  };
  renderItems(list, block.items);
  return list;
}

let _diagramDark = false, _diagramFont = "";
const documentFont = () => { const root = document.getElementById("write"); return root ? window.getComputedStyle(root).fontFamily : ""; };
function renderDiagramInto(panel, body) {
  const request = panel.__diagramRequest = (panel.__diagramRequest || 0) + 1;
  const current = () => panel.isConnected && panel.dataset.tex === body && panel.__diagramRequest === request;
  renderFenceDiagram(panel.dataset.diagram, body, { ...diagramOptions(), dark: _diagramDark, fontFamily: _diagramFont || documentFont() }).then(({ html, bindFunctions }) => {
    if (!current()) return;
    panel.innerHTML = html;
    panel.classList.remove("md-diagram-error");
    panel.parentElement?.classList.add("md-diagram-ready");
    bindFunctions?.(panel);
  }).catch((error) => {
    if (!current()) return;
    panel.textContent = diagramError(error, window.__lettrine?.i18nT);
    panel.classList.add("md-diagram-error");
    panel.parentElement?.classList.remove("md-diagram-ready");
  });
}

function syncFencePreview(pre, block) {
  const settings = window.__lettrine?.settings || {}, language = String(block.info || "").toLowerCase();
  let panel = pre.querySelector(".md-diagram");
  const enabled = block.diagram && (language === "math" ? settings.renderMath !== false : settings.renderDiagrams !== false);
  if (!enabled) { panel?.remove(); pre.classList.remove("md-diagram-ready"); return; }
  if (!panel) { panel = el("div", { class: "md-diagram md-decor" }); pre.appendChild(panel); }
  panel.dataset.diagram = language; panel.dataset.tex = block.body;
  renderDiagramInto(panel, block.body);
}

function fencedSource(block, value) {
  const opening = (block.src || "").split("\n")[0] || (block.type === "math" ? "$$" : (block.fence || "```") + (block.info || ""));
  const closing = block.closed ? "\n" + block.src.split("\n").at(-1) : "";
  return opening + "\n" + value + closing;
}

function renderCode(block) {
  const bareFence = (block.fence || "```").replace(/[^`~]+$/, "");
  // our fences ship read-only (pre.md-fences.mock-cm,
  // contenteditable=false) and become editable only while the block is
  // focused; the block is upgraded in place on mousedown
  const pre = el("pre", { mdtype: "fences", class: "md-fences mock-cm md-end-block" });
  pre.setAttribute("spellcheck", "false");
  pre.setAttribute("contenteditable", block.src.includes("\n") ? "false" : "true");
  pre.addEventListener("mousedown", (e) => {
    if (e.__viaFence) return;
    if (e.target.closest?.(".md-lang-input")) return;
    if (!block.src.includes("\n")) return; // the opener still accepts its language
    fenceUpgrade(pre, currentEditor);
  }, true);
  pre.addEventListener("focusout", (event) => {
    if (!pre.__cm && !pre.contains(event.relatedTarget)) { fenceDowngrade(pre, currentEditor); return; }
    setTimeout(() => { if (pre.isConnected && !pre.contains(document.activeElement) && !pre.__cmSticky) fenceDowngrade(pre, currentEditor); }, 120);
  });
  if (block.info) pre.setAttribute("lang", block.info);
  pre.dataset.fence = bareFence;
  pre.dataset.closed = block.closed ? "1" : "0";
  pre.dataset.info = block.info ?? "";
  const complete = block.closed;
  const source = block.src || "";
  const firstBreak = source.indexOf("\n");
  const lastBreak = block.closed ? source.lastIndexOf("\n") : source.length;
  const prefix = firstBreak < 0 ? source : source.slice(0, firstBreak + 1);
  const suffix = block.closed ? source.slice(Math.max(firstBreak + 1, lastBreak)) : "";
  pre.dataset.prefixLength = String(prefix.length);
  pre.appendChild(marker(prefix, complete));
  // cm-s-inner: idle code takes the token colors of the mounted editor
  const code = el("code", { class: "md-code-body cm-s-inner" });
  if (block.body) {
    const highlighted = block.diagram ? null : highlightNow(block.body, block.info);
    if (highlighted) code.innerHTML = highlighted;
    else {
      code.textContent = block.body;
      if (!block.diagram) queueHighlight(code, block.body, block.info);
    }
  } else appendPlaceholder(code);
  pre.appendChild(code);
  if (block.closed) {
    pre.appendChild(marker(suffix, true));
  }
  {
    const field = el("input", { class: "md-lang md-lang-input md-cm-lang-input md-decor", type: "text", "aria-label": "Code language", placeholder: "Language", spellcheck: "false", list: "code-language-options" });
    localizeUI(undefined, field);
    field.value = block.info || "";
    for (const event of ["beforeinput", "input", "paste", "compositionstart", "compositionend"]) field.addEventListener(event, (e) => e.stopPropagation());
    const returnToCode = () => {
      field.blur();
      const editor = currentEditor, index = editor.blocks.findIndex((item) => item._cid === pre.dataset.cid);
      if (index < 0 || !pre.isConnected) return;
      if (pre.__cm) { pre.__cm.focus(); return; }
      editor.root.focus({ preventScroll: true });
      const current = editor.blocks[index];
      editor.placeCaret(index, current.src.includes("\n") ? current.src.indexOf("\n") + 1 + current.body.length : current.src.length);
      if (!current.src.includes("\n")) doEnter(editor); else fenceUpgrade(pre, editor);
    };
    field.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); returnToCode(); }
      if (event.key === "Escape") { event.preventDefault(); field.value = pre.dataset.info; returnToCode(); }
    });
    field.addEventListener("change", () => {
      const editor = currentEditor;
      if (editor.guardReadOnly()) { field.value = pre.dataset.info; return; }
      const index = Array.prototype.indexOf.call(editor.root.children, pre);
      const original = editor.blocks[index];
      if (!original || original.type !== "code") return;
      const language = field.value.replace(/[\r\n`~]/g, "").trim();
      const source = original.src.replace(/^(\s{0,3}(?:`{3,}|~{3,}))[^\n]*/, (_, fence) => fence + language);
      if (source === original.src) return;
      const anchor = pre.__cm ? pre.__cm.indexFromPos(pre.__cm.getCursor("anchor")) : original.body.length;
      const head = pre.__cm ? pre.__cm.indexFromPos(pre.__cm.getCursor("head")) : original.body.length;
      const prefix = original.src.includes("\n") ? original.src.indexOf("\n") + 1 : original.src.length;
      editor.selectOffsets(editor.blockStart(index) + prefix + Math.min(anchor, head), editor.blockStart(index) + prefix + Math.max(anchor, head), anchor > head);
      editor.checkpointSelection();
      const updated = parseBlocks(source)[0];
      inheritBlockLayout(original, [updated]);
      updated.__docBase = editor.docBase;
      editor.blocks[index] = updated;
      pre.__block = updated; // edited in place below
      pre.dataset.info = language;
      pre.setAttribute("lang", language);
      pre.__cm?.setOption("mode", cmModeOf(language));
      const marker = pre.querySelector(":scope > .md-attr, :scope > .md-tag");
      const newPrefix = source.includes("\n") ? source.indexOf("\n") + 1 : source.length;
      if (marker) marker.textContent = source.slice(0, newPrefix);
      pre.dataset.prefixLength = String(newPrefix);
      field.value = language;
      editor._lastCodeLanguage = language;
      syncFencePreview(pre, updated);
      editor.selectOffsets(editor.blockStart(index) + newPrefix + Math.min(anchor, head), editor.blockStart(index) + newPrefix + Math.max(anchor, head), anchor > head);
      editor.pushHistory(); editor.emit();
    });
    pre.appendChild(field);
    if (!document.getElementById("code-language-options")) {
      const list = el("datalist", { id: "code-language-options", class: "md-decor" });
      for (const language of CODE_LANGUAGES) list.appendChild(el("option", { value: language }));
      document.body.appendChild(list);
    }
    if (block.info && currentEditor) currentEditor._lastCodeLanguage = String(block.info);
  }
  syncFencePreview(pre, block);
  return pre;
}

// ---------------------------------------------------------------------------
// idle code highlighting
// ---------------------------------------------------------------------------
// Idle fences show the token colors of the mounted editor. CodeMirror's run
// mode tokenizes the code once the modes have loaded. Token spans hold the
// exact code text, so source walks and caret mapping read it unchanged; code
// that tokenizes to different text stays plain.
let codeMirrorReady = false, highlightTimer = 0, highlightCharacters = 0, bulkRender = false;
const highlightQueue = new Set(), highlightCache = new Map();
const highlightKey = (mode, body) => (typeof mode === "string" ? mode : JSON.stringify(mode)) + "\0" + body;

function tokenizedCode(body, lang) {
  const mode = cmModeOf(lang);
  if (!mode || !codeMirrorReady || !window.CodeMirror?.runMode) return null;
  const key = highlightKey(mode, body);
  let html = highlightCache.get(key);
  if (html !== undefined) { highlightCache.delete(key); highlightCache.set(key, html); return html; }
  let text = "";
  html = "";
  try {
    window.CodeMirror.runMode(body, mode, (token, style) => {
      text += token;
      html += style ? `<span class="cm-${style.replace(/ +/g, " cm-")}">${escapeHtml(token)}</span>` : escapeHtml(token);
    });
  } catch { html = ""; }
  if (text !== body) html = "";
  highlightCache.set(key, html);
  highlightCharacters += key.length;
  while (highlightCache.size > 400 || highlightCharacters > 2e6) {
    const oldest = highlightCache.keys().next().value;
    highlightCharacters -= oldest.length;
    highlightCache.delete(oldest);
  }
  return html;
}

// Tokens for a fence being rendered now: cached ones, or a small block when
// only a few blocks render. Whole documents highlight in the background.
function highlightNow(body, lang) {
  const mode = cmModeOf(lang);
  if (!codeMirrorReady || !mode) return null;
  if (!highlightCache.has(highlightKey(mode, body)) && (bulkRender || body.length > 4000)) return null;
  return tokenizedCode(body, lang) || null;
}

function queueHighlight(code, body, lang) {
  if (!cmModeOf(lang) || body.length > 200000) return;
  code.__highlight = { body, lang };
  highlightQueue.add(code);
  scheduleHighlights();
}

function scheduleHighlights() {
  if (highlightTimer || !highlightQueue.size) return;
  if (!codeMirrorReady) {
    // Loading the modes waits for a quiet moment after the document renders.
    highlightTimer = setTimeout(() => {
      void ensureCodeMirror().then(() => { highlightTimer = 0; scheduleHighlights(); }, () => { highlightTimer = 0; highlightQueue.clear(); });
    }, 120);
    return;
  }
  highlightTimer = setTimeout(() => {
    highlightTimer = 0;
    const deadline = performance.now() + 6;
    for (const code of highlightQueue) {
      highlightQueue.delete(code);
      applyHighlight(code);
      if (performance.now() > deadline) break;
    }
    scheduleHighlights();
  }, 16);
}

function applyHighlight(code) {
  const job = code.__highlight;
  code.__highlight = null;
  const pre = code.parentElement;
  // Only idle fences: an edited fence renders again when it settles.
  if (!job || !code.isConnected || !pre?.classList.contains("mock-cm") || pre.__cm) return;
  // Replacing text nodes would drop a selection that runs through the code.
  const selection = window.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed && selection.containsNode?.(code, true)) return;
  if (code.textContent !== job.body) return;
  const html = tokenizedCode(job.body, job.lang);
  if (html) code.innerHTML = html;
}

// Load CodeMirror and its official modes from installed local dependencies.
// Addons and dependent modes finish loading before any editor is mounted.
let _cmPromise = null;
export function ensureCodeMirror() {
  if (_cmPromise) return _cmPromise;
  if (window.CodeMirror) { codeMirrorReady = true; ensureCmFocusHook(); return Promise.resolve(window.CodeMirror); }
  if (!_cmPromise) {
    const load = (src) => new Promise((resolve, reject) => {
      const t = document.createElement("script");
      t.src = src;
      t.onload = () => resolve();
      t.onerror = () => reject(new Error("load failed: " + src));
      document.head.appendChild(t);
    });
    // CodeMirror's npm package ships these addons separately from its core
    const addons = [
      "mode/overlay",        // gfm/markdown modes call CodeMirror.overlayMode
      "mode/simple",         // Rust and other declarative language modes
      "edit/closebrackets",  // filenames must also work in case-sensitive ASAR archives
      "edit/matchbrackets",
      "selection/active-line",   // styleActiveLine
      "selection/mark-selection", // styleSelectedText
      "runmode/runmode",         // token colors for idle fences
    ];
    const mode = (name) => load(`../../node_modules/codemirror/mode/${name}/${name}.js`);
    _cmPromise = load("../../node_modules/codemirror/lib/codemirror.js")
      .then(() => Promise.all(addons.map((a) => load(`../../node_modules/codemirror/addon/${a}.js`))))
      .then(() => Promise.all(["xml", "javascript", "css", "stex", "python", "clike", "sql", "shell", "yaml", "go", "rust", "swift", "ruby", "diff", "properties", "toml"].map(mode)))
      .then(() => Promise.all(["markdown", "htmlmixed", "jsx"].map(mode)))
      .then(() => Promise.all(["gfm", "php"].map(mode)))
      .then(() => { ensureCmFocusHook(); codeMirrorReady = !!window.CodeMirror; scheduleHighlights(); return window.CodeMirror || null; });
  }
  return _cmPromise;
}

// most recent Editor instance (fence render callbacks are module-level)
let currentEditor = null;

// true when a DOM event originates inside a CodeMirror that owns a block
// (fences / math). Such events must NOT reach the editor-level input
// pipeline — the CM's own handlers update the model; letting the pipeline
// see them double-applies the edit (insertText is taken over at the
// "$$" marker offset, Enter split the block while the CM also inserted \n).
function eventInCmBlock(root, e) {
  const t = e && e.target;
  if (!t || !t.closest) return false;
  if (t.closest(".md-decor") && /^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(t.tagName)) return true;
  const blk = t.closest("[mdtype='fences'], [mdtype='math_block']");
  return !!(blk && blk.__cm);
}

function fenceUpgrade(pre, editor, cursor) {
  if (editor.readOnly) return;
  if (!pre.classList.contains("mock-cm") || pre.__cm) return;
  // synchronous fallback first: flip editable during mousedown capture so
  // the click's caret placement lands in the code body even before CM loads
  pre.classList.remove("mock-cm");
  pre.classList.add("ic-contain-cm");
  pre.setAttribute("contenteditable", "true");
  if (editor.__settings?.fenceEditor === false) return;
  ensureCodeMirror().then((CM) => {
    if (!CM || pre.__cm || !pre.isConnected) return;
    if (editor.readOnly) { fenceDowngrade(pre, editor); return; }
    if (!pre.classList.contains("ic-contain-cm")) return; // downgraded meanwhile
    ensureCmFocusHook();
    const bi = Array.prototype.indexOf.call(editor.root.children, pre);
    const block = editor.blocks[bi];
    if (!block || block.type !== "code") return;
    const body = pre.querySelector(".md-code-body");
    if (body) body.style.display = "none";
    const ta = document.createElement("textarea");
    ta.value = block.body || "";
    pre.appendChild(ta);
    const cm = CM.fromTextArea(ta, {
      lineWrapping: editor.__settings?.wrapCode !== false,
      mode: cmModeOf(block.info),
      styleSelectedText: true,
      styleActiveLine: true,
      autoCloseBrackets: editor.__settings?.autoPair !== false,
      ...codeOptions(editor.__settings),
      theme: "inner",
      lineNumbers: !!(editor.__settings && editor.__settings.showLineNumbersForFence),
      viewportMargin: Infinity,
      scrollbarStyle: "null",
      extraKeys: {
        ...codeKeyMap(editor, () => editor.__settings || {}),
        "Cmd-Enter": (inner) => fenceExit(inner, pre, editor),
        "Ctrl-Enter": (inner) => fenceExit(inner, pre, editor),
        Enter: (inner) => {
          const cur = inner.getCursor();
          if (editor.blocks[bi]?.closed && cur.line > 0 && cur.line === inner.lastLine() && !inner.getLine(cur.line) && !inner.somethingSelected()) {
            const input = fenceInput(editor.blocks[bi], inner.getValue().replace(/\n$/, ""), true);
            finishMathBlock(pre, editor, input.source);
          } else return CM.Pass;
        },
        Backspace: (inner) => {
          if (!inner.getValue()) mathDeleteBlock(pre, editor);
          else return CM.Pass;
        },
      },
    });
    pre.__getModelSource = () => editor.blocks.find((item) => item._cid === pre.dataset.cid)?.src;
    pre.__cm = cm;
    bindCodeComposition(cm);
    pre.__cmTa = ta;
    cm.on("beforeChange", () => editor.checkpointSelection());
    // keep the model in sync from CM's own editing (the DOM walk must not
    // run against CM's internals)
    cm.on("change", (_, change) => {
      if (pre.__finishingFence) return;
      const i = Array.prototype.indexOf.call(editor.root.children, pre);
      if (i === -1) return;
      const b = editor.blocks[i];
      if (!b || b.type !== "code") return;
      const text = cm.getValue();
      if (text === b.body) return;
      const input = fenceInput(b, text);
      if (input.closedByInput) {
        pre.__finishingFence = true;
        queueMicrotask(() => { if (pre.isConnected && pre.__cm === cm) finishMathBlock(pre, editor, input.source, input.tail); });
        return;
      }
      const src = input.source;
      const nb = parseBlocks(src)[0] || b;
      inheritBlockLayout(b, [nb]);
      nb.__docBase = editor.docBase;
      editor.blocks[i] = nb;
      const diagram = pre.querySelector(".md-diagram");
      if (diagram) {
        diagram.dataset.tex = text;
        clearTimeout(pre.__diagramTimer); pre.__diagramTimer = setTimeout(() => renderDiagramInto(diagram, text), 200);
      }
      editor.pushHistory({ inputType: /^(?:code-(?:format|indent)|range-delete)$/.test(change.origin) ? "" : "insertText" }); // CM edits join the document undo timeline
      editor.emit();
    });
    cm.on("blur", () => {
      // let a click elsewhere settle first; downgrade shortly after
      setTimeout(() => {
        if (!cm.hasFocus() && !pre.contains(document.activeElement) && !pre.__cmSticky) fenceDowngrade(pre, editor);
      }, 120);
    });
    if (cursor?.anchor) cm.setSelection(cursor.anchor, cursor.head);
    else if (cursor) cm.setCursor(cursor);
    else cm.setCursor(cm.lineCount() - 1, cm.getLine(cm.lineCount() - 1).length);
    if (cursor?.focused !== false && !document.querySelector(".modal.open") && (editor.root.contains(document.activeElement) || document.activeElement === document.body)) cm.focus();
    else fenceDowngrade(pre, editor);
  }).catch(() => { /* keep the contenteditable fallback */ });
}

function fenceExit(cm, pre, editor) {
  const cur = cm.getCursor();
  if (cur.line !== cm.lastLine() || cur.ch !== cm.getLine(cur.line).length || cm.somethingSelected()) return window.CodeMirror.Pass;
  const index = Array.prototype.indexOf.call(editor.root.children, pre);
  const input = fenceInput(editor.blocks[index], cm.getValue(), true);
  pre.__finishingFence = true;
  finishMathBlock(pre, editor, input.source, input.tail);
}

function fenceDowngrade(pre, editor) {
  const cm = pre.__cm;
  if (cm) {
    const val = cm.getValue();
    try { cm.toTextArea(); } catch { /* already torn down */ }
    pre.__cm = null;
    pre.__cmTa = null;
    // push the final value into the model, then re-render this block
    const bi = Array.prototype.indexOf.call((editor && editor.root) ? editor.root.children : [], pre);
    if (editor && bi !== -1) {
      const b = editor.blocks[bi];
      if (b && b.type === "code") {
        const fence = b.fence || "\u0060\u0060\u0060";
        const nb = val === b.body ? b : parseBlocks(fencedSource(b, val))[0] || b;
        if (nb !== b) inheritBlockLayout(b, [nb]);
        nb.__docBase = editor.docBase;
        editor.blocks[bi] = nb;
        editor._replaceBlock(bi, nb, null);
        return;
      }
    }
  }
  if (pre.classList.contains("mock-cm")) return;
  pre.classList.add("mock-cm");
  pre.classList.remove("ic-contain-cm");
  pre.setAttribute("contenteditable", "false");
  const body = pre.querySelector(".md-code-body");
  if (body) body.style.display = "";
}

// ---------------------------------------------------------------------------
// math block editing — a CodeMirror in "stex" mode with the line-number
// setting of code blocks and a live KaTeX preview re-rendered 100 ms after
// typing stops
// ---------------------------------------------------------------------------

function renderMathPreview(preview, tex, display = true, equation, index = currentEditor?._equations) {
  if (!preview) return;
  equation ??= display ? index?.byId.get(preview.closest(".md-math-block")?.id) : null;
  const prepared = equationTex(tex || "", index, equation);
  const enabled = window.katex && window.__lettrine?.settings?.renderMath !== false;
  const signature = JSON.stringify([enabled, display, prepared]);
  if (preview.__mathSignature === signature) return;
  preview.__mathSignature = signature;
  preview.innerHTML = "";
  if (!tex || !tex.trim()) return;
  if (enabled) {
    try {
      window.katex.render(prepared, preview, { throwOnError: false, displayMode: display, output: "html", trust: equationTrust });
      return;
    } catch { /* fall through */ }
  }
  preview.textContent = tex;
}

// The CM value is the TeX body; once the user types the closing "$$" line
// that line is a delimiter, not TeX — strip it so the live preview renders
// the formula instead of erroring on the marker.
function texForPreview(value) {
  const lines = String(value == null ? "" : value).split("\n");
  while (lines.length && /^\s*\$\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

// CM cursor (line, ch) -> character offset within the value
function cmValueOffset(cm) {
  const value = cm.getValue();
  const cur = cm.getCursor();
  const lines = value.split("\n");
  let off = 0;
  for (let l = 0; l < cur.line && l < lines.length; l++) off += lines[l].length + 1;
  const lastLine = lines[Math.min(cur.line, lines.length - 1)] || "";
  off += Math.min(cur.ch, lastLine.length);
  return Math.min(off, value.length);
}

// CodeMirror's state.focused does not recover when the window regains OS
// focus while its textarea already holds DOM focus (no native focus event
// fires, so poll() keeps bailing). Force a blur/focus round-trip to restore
// it. One global hook for all CM blocks (fences and math).
let cmWindowFocusHook = false;
function ensureCmFocusHook() {
  if (cmWindowFocusHook) return;
  cmWindowFocusHook = true;
  window.addEventListener("focus", () => {
    const ta = document.activeElement;
    if (!ta || !ta.closest) return;
    const blk = ta.closest("[mdtype='fences'], [mdtype='math_block']");
    const cm = blk?.__cm || (ta.closest("#app-source") ? window.__lettrine?._sourceCM : null);
    if (cm && cm.hasFocus && cm.hasFocus() && cm.state && !cm.state.focused) {
      ta.blur();
      ta.focus();
    }
  });
}

function mathUpgrade(div, editor, where, cursor) {
  if (editor.readOnly) return;
  if (!editor || !div.isConnected) return;
  if (div.__cm) { div.__cm.focus(); return; }
  const bi = Array.prototype.indexOf.call(editor.root.children, div);
  const block = editor.blocks[bi];
  if (!block || block.type !== "math") return;
  // A bare delimiter is still being typed on its opening line. Enter must
  // create the real source newline before a multiline editor is mounted.
  if (!block.src.includes("\n")) { div.setAttribute("contenteditable", "true"); return; }

  // the contenteditable tex span is the fallback editing state: it stays
  // live until CodeMirror is ready (and permanently when it cannot load)
  div.classList.add("md-focus");
  div.setAttribute("contenteditable", "true");

  ensureCodeMirror().then((CM) => {
    if (!CM || editor.readOnly || div.__cm || !div.isConnected || !div.classList.contains("md-focus")) return;
    ensureCmFocusHook();
    // build the panel (md-decor: excluded from source walks while the CM
    // owns the editing; the model block.tex is the source of truth)
    const bi2 = Array.prototype.indexOf.call(editor.root.children, div);
    const block2 = editor.blocks[bi2];
    if (!block2 || block2.type !== "math") return;
    div.classList.add("ic-contain-cm");
    const sourcePanel = div.querySelector(".md-math-source");
    const texSpan = sourcePanel.querySelector(":scope > .md-plain");
    const panel = el("div", { class: "md-mathblock-panel md-decor" });
    const ta = document.createElement("textarea");
    ta.className = "md-rawblock-input";
    ta.setAttribute("spellcheck", "false");
    ta.value = block2.tex || "";
    const preview = el("div", { class: "md-mathjax-preview md-decor", contenteditable: "false" });
    panel.appendChild(ta);
    if (texSpan) texSpan.replaceWith(panel);
    else sourcePanel.appendChild(panel);
    div.appendChild(preview);
    renderMathPreview(preview, block2.tex || "");
    const cm = CM.fromTextArea(ta, {
      lineWrapping: true,
      mode: "stex",
      placeholder: "Input Math TeX here",
      theme: "inner",
      styleSelectedText: true,
      styleActiveLine: true,
      autoCloseBrackets: editor.__settings?.autoPair !== false,
      lineNumbers: !!(editor.__settings && editor.__settings.showLineNumbersForFence),
      viewportMargin: Infinity,
      scrollbarStyle: "null",
      dragDrop: false,
      tabSize: 2,
      indentUnit: 2,
      // CM5's core never fires a "keydown" signal — the keymap is the
      // only interception point (extraKeys are checked before the default
      // bindings, so these win over the native Enter/Backspace behavior)
      extraKeys: {
        // Backspace on an empty block deletes the whole math block
        Backspace: (cmObj) => {
          if (cmObj.getValue().trim() === "") {
            mathDeleteBlock(div, editor);
            return "handled";
          }
          return CM.Pass;
        },
        // Cmd/Ctrl+Enter at the end of the TeX exits the block into a new
        // paragraph after it
        "Cmd-Enter": (cmObj) => mathExitAtEnd(cmObj, div, editor),
        "Ctrl-Enter": (cmObj) => mathExitAtEnd(cmObj, div, editor),
        Down: (cmObj) => {
          // Wrapped TeX still moves down until the final visible line.
          if (editor.readOnly || cmObj.__lettrineComposing || cmObj.somethingSelected() || !cmObj.findPosV(cmObj.getCursor(), 1, "line").hitSide) return CM.Pass;
          mathExitBlock(div, editor, { moveToNext: true });
          return "handled";
        },
      },
    });
    div.__cm = cm;
    bindCodeComposition(cm);
    div.setAttribute("contenteditable", "false");
    div.__getModelSource = () => editor.blocks.find((item) => item._cid === div.dataset.cid)?.src;
    div.__cmTa = ta;
    // start the cursor where the user pointed (or at the end for
    // keyboard-driven entry), like our start/edit position arg
    if (cursor?.anchor) cm.setSelection(cursor.anchor, cursor.head);
    else if (cursor && cursor.line != null) cm.setCursor(cursor.line, cursor.ch);
    else if (where === "end") cm.setCursor(cm.lineCount() - 1, cm.getLine(cm.lineCount() - 1).length);
    else if (where === "start") cm.setCursor(0, 0);

    cm.on("beforeChange", () => editor.checkpointSelection());
    cm.on("change", (_, change) => {
      if (div.__finishingMath) return;
      const i = Array.prototype.indexOf.call(editor.root.children, div);
      const b = editor.blocks[i];
      if (!b || b.type !== "math") return;
      const value = cm.getValue();
      const input = mathInput(b, value);
      if (input.closedByInput) {
        div.__finishingMath = true;
        queueMicrotask(() => {
          if (div.isConnected && div.__cm === cm) finishMathBlock(div, editor, input.source, input.tail);
        });
        return;
      }
      const reparsed = parseBlocks(input.source);
      inheritBlockLayout(b, reparsed);
      if (reparsed.length === 1 && reparsed[0].type === "math") {
        reparsed[0].__docBase = editor.docBase;
        editor.blocks[i] = reparsed[0];
        editor.pushHistory({ inputType: change.origin === "range-delete" ? "" : "insertText" }); // CM edits join the document undo timeline
        editor.emit();
      } else if (reparsed.length > 1) {
        // a closer line was typed: the block closes and any text after it
        // becomes following blocks — splice them in without touching the CM
        const before = editor.blocks.slice(0, i);
        const after = editor.blocks.slice(i + 1);
        for (const x of reparsed) x.__docBase = editor.docBase;
        editor.blocks = [...before, ...reparsed, ...after];
        // rebuild only the DOM after this block (the CM block itself is
        // left alone; its marker spans already carry the closed state)
        for (let k = editor.root.children.length; k > i + 1; k--) {
          const c = editor.root.children[k - 1];
          if (c !== div) c.remove();
        }
        let previous = div;
        for (let k = i + 1; k < editor.blocks.length; k++) {
          const fresh = renderBlockInner(editor.blocks[k]);
          previous.after(fresh);
          previous = fresh;
        }
        editor.pushHistory();
        editor.emit();
      }
      // live preview on our 100ms debounce (TeX body, not the raw
      // value with its closing marker)
      clearTimeout(div.__previewTimer);
      div.__previewTimer = setTimeout(() => renderMathPreview(preview, texForPreview(cm.getValue())), 100);
    });
    cm.on("blur", () => {
      setTimeout(() => {
        if (!cm.hasFocus() && div.isConnected && !div.__cmSticky) mathDowngrade(div, editor);
      }, 120);
    });
    if (cursor?.focused !== false && !document.querySelector(".modal.open") && (editor.root.contains(document.activeElement) || document.activeElement === document.body)) cm.focus();
    else mathDowngrade(div, editor);
  }).catch(() => { /* keep the contenteditable fallback */ });
}

function mathDowngrade(div, editor) {
  if (!editor || !div.isConnected) return;
  const bi = Array.prototype.indexOf.call(editor.root.children, div);
  if (bi < 0) return;
  const cm = div.__cm;
  const selection = editor.selectionOffsets();
  const ownsFocus = editor.root.contains(document.activeElement);
  if (cm) {
    // CM change events synchronously update the model. Keep that exact
    // source, including a closed block's delimiter and surrounding layout.
    try { cm.toTextArea(); } catch { /* already detached */ }
    div.__cm = null;
    div.__cmTa = null;
  }
  clearTimeout(div.__previewTimer);
  div.classList.remove("md-focus", "ic-contain-cm");
  div.setAttribute("contenteditable", "false");
  const block = editor.blocks[bi];
  if (block?.type === "math") editor._replaceBlock(bi, block, null);
  if (ownsFocus && selection && editor.blockIndexOfNode(window.getSelection()?.anchorNode) < 0) editor.selectOffsets(selection.start, selection.end, selection.backward);
}

function mathDeleteBlock(div, editor) {
  const bi = Array.prototype.indexOf.call(editor.root.children, div);
  if (bi === -1) return;
  editor.checkpointSelection();
  const cm = div.__cm;
  if (cm) {
    try { cm.toTextArea(); } catch { /* ok */ }
    div.__cm = null;
  }
  const block = { type: "paragraph", src: "", text: "", __docBase: editor.docBase };
  inheritBlockLayout(editor.blocks[bi], [block]);
  // An empty paragraph after the formula, like the one `$$` + Enter adds,
  // becomes the caret's paragraph rather than an extra blank line.
  const next = editor.blocks[bi + 1];
  if (next?.type === "paragraph" && !next.src) {
    if (next._after !== undefined) block._after = (block._after || "") + next._after;
    editor.blocks.splice(bi, 2, block);
    editor.renderAll();
    editor.root.focus({ preventScroll: true });
    editor.placeCaret(bi, 0, { scroll: true });
  } else {
    editor.blocks[bi] = block;
    editor.root.focus({ preventScroll: true });
    editor._replaceBlock(bi, block, 0);
  }
  editor.pushHistory();
  editor.emit();
}

// Cmd/Ctrl+Enter exits only when the cursor is at the very end of the TeX
function mathExitAtEnd(cmObj, div, editor) {
  const cur = cmObj.getCursor();
  const last = cmObj.lineCount() - 1;
  if (cur.line === last && cur.ch >= cmObj.getLine(last).length) {
    mathExitBlock(div, editor);
    return "handled";
  }
}

function mathExitBlock(div, editor, options) {
  const bi = Array.prototype.indexOf.call(editor.root.children, div);
  if (bi === -1) return;
  const cm = div.__cm;
  const value = cm ? cm.getValue() : (editor.blocks[bi]?.tex || "");
  const input = mathInput(editor.blocks[bi], value, true);
  finishMathBlock(div, editor, input.source, input.tail, options);
}

function finishMathBlock(div, editor, source, tail = "", { moveToNext = false } = {}) {
  const bi = Array.prototype.indexOf.call(editor.root.children, div);
  if (bi < 0) return;
  const original = editor.blocks[bi];
  const cm = div.__cm;
  div.__finishingMath = true;
  clearTimeout(div.__previewTimer);
  if (cm) {
    try { cm.toTextArea(); } catch { /* already detached */ }
    div.__cm = null;
  }
  div.classList.remove("md-focus", "ic-contain-cm");
  const reparsed = parseBlocks(source + (tail ? "\n" + tail : ""));
  const last = reparsed.at(-1);
  if (last?._after?.includes("\n")) {
    const separation = last._after;
    delete last._after;
    reparsed.push({ type: "paragraph", src: "", text: "", _before: separation });
  }
  const following = editor.blocks[bi + 1];
  const reuseFollowing = !!following && (moveToNext || following.type === "paragraph" && !following.src);
  if (!tail && !reuseFollowing) reparsed.push({ type: "paragraph", src: "", text: "" });
  inheritBlockLayout(original, reparsed);
  for (const block of reparsed) block.__docBase = editor.docBase;
  // Pasted content after the closer fills the existing empty paragraph.
  editor.blocks.splice(bi, tail && reuseFollowing ? 2 : 1, ...reparsed);
  editor._staleBrush.add(bi);
  editor.renderAll();
  editor.root.focus({ preventScroll: true });
  editor.placeCaret(bi + reparsed.length - (!tail && reuseFollowing ? 0 : 1), tail ? reparsed.at(-1).src.length : 0, { scroll: true });
  if (moveToNext) editor._syncMathFocus(editor.caretInfo().blockIndex);
  editor.pushHistory();
  editor.emit();
}

function renderQuote(block) {
  const bq = el("blockquote", { mdtype: "quote" });
  if (!block.alert && block.items.every((inner) => inner.type === "paragraph" && !inner.src.trim())) {
    bq.classList.add("md-simple-empty");
    bq.appendChild(el("span", { class: "md-simple-marker md-decor", contenteditable: "false" }, (block.src.match(/^ {0,3}(?:>[ \t]?)+/)?.[0] || ">").trimEnd()));
  }
  if (block.alert) {
    bq.classList.add("md-alert", "md-alert-" + block.alert);
    const title = el("div", { class: "md-alert-title md-decor", contenteditable: "false" });
    title.innerHTML = alertIcon(block.alert);
    title.appendChild(el("span", {}, ALERT_LABELS[block.alert]));
    localizeUI(undefined, title);
    bq.appendChild(title);
  }
  block.items.forEach((inner, index) => {
    const node = renderBlockInner(inner);
    if (block.alert && index === 0) {
      const prefix = alertMarker(inner.src)?.prefix || "";
      const rest = inner.src.slice(prefix.length);
      const content = node.querySelector(".md-plain");
      content.replaceChildren(marker(prefix), inlineEl(rest, block.__docBase));
      if (!rest && block.items.length > 1) node.classList.add("md-alert-source-only");
      decorateInline(node, block.__docBase);
    }
    bq.appendChild(node);
  });
  if (!block.items.length) bq.appendChild(renderBlockInner({ type: "paragraph", src: "", text: "", __docBase: block.__docBase }));
  bq.dataset.originalSource = block.src;
  bq.dataset.renderedSource = quoteSourceFromEl(bq);
  return bq;
}

// Footnote definition block. Lettrine renders the visible "[^" / "]:" markers
// with CSS pseudo-elements on .md-def-name; the DOM itself only holds
// name + split + content spans. The source walk needs the marker TEXT in the DOM for
// source reconstruction, so hidden .md-def-marker spans carry it and the
// same CSS paints the visuals.
function renderFootnoteDef(block) {
  const div = el("div", { mdtype: "def_footnote", class: "footnotes md-def-footnote md-end-block", contenteditable: "false" });
  const raw = /^(\s*\[\^)([^\]]*)(\]:)([ \t]*)(.*)$/.exec(block.src || "");
  div.appendChild(el("span", { class: "md-def-marker" }, raw?.[1] || "[^"));
  const name = el("span", { class: "md-def-name", contenteditable: "true" });
  if (raw ? raw[2] : block.ref) name.textContent = raw ? raw[2] : block.ref;
  else appendPlaceholder(name);
  div.appendChild(name);
  // the exact whitespace after the colon (our `pattern`); the block may
  // be the bare "[^]" state (markers mid-deletion), which renders only the
  // opening marker + (empty) name
  if ((block.src || "").trim() === "[^]") {
    div.appendChild(el("span", { class: "md-def-marker" }, "]"));
    return div;
  }
  div.appendChild(el("span", { class: "md-def-marker" }, "]:"));
  div.appendChild(el("span", { class: "md-def-split md-def-f" }, block.pattern ?? " "));
  const content = el("span", { class: "md-def-content md-plain", contenteditable: "true" });
  const contentHTML = segmentsToHtml(parseInline(block.text, currentEditor?.__settings), escapeHtml, currentEditor?.__settings);
  if (contentHTML) content.innerHTML = contentHTML;
  else appendPlaceholder(content);
  content.__docBase = block.__docBase;
  div.appendChild(content);
  if (contentHTML.includes('class="md-image"') || contentHTML.includes('class="md-inline-math"')) decorateInline(div, block.__docBase);
  return div;
}

// A def_footnote block stays alive while its ref is deleted down to empty
// (the "name ]" placeholder state); only an empty block fully reverts.
// The block type is re-derived from source, so persist the def type for
// the two empty-ref shapes when an edit would otherwise drop it.
function keepDefFootnote(oldType, reparsed, newSrc) {
  if (oldType !== "def_footnote") return reparsed;
  if (reparsed.length !== 1 || reparsed[0].type !== "paragraph") return reparsed;
  const t = newSrc.trim();
  let m = /^\[\^\]:(\s*)([^\n]*)$/.exec(t);
  if (m) {
    return [{ type: "def_footnote", src: t, ref: "", pattern: m[1] || " ", text: m[2] || "" }];
  }
  if (t === "[^]") {
    return [{ type: "def_footnote", src: t, ref: "", pattern: "", text: "" }];
  }
  return reparsed;
}

// Table-of-contents block: a terminal block whose source is just the
// trigger line ([toc] etc.). The trigger text lives in a hidden span for
// the source walk; the rendered items + tooltip are .md-decor.
function renderToc(block) {
  const div = el("div", { mdtype: "toc", class: "md-toc md-end-block", contenteditable: "false", spellcheck: "false", tabindex: "-1" });
  const options = tocOptions(block.pattern || block.src);
  if (options.width) div.style.width = options.width;
  div.dataset.depth = String(options.depth);
  div.appendChild(el("span", { class: "md-toc-src" }, block.src || block.pattern));
  const tip = el("div", { class: "md-tooltip-hide md-toc-tooltip md-decor" });
  tip.innerHTML = `<span>Table of Contents</span><button type="button" class="md-delete-toc md-decor" title="Remove Table of Contents" aria-label="Remove Table of Contents">Remove</button>`;
  div.appendChild(tip);
  const content = el("p", { class: "md-toc-content md-decor", role: "list" });
  div.appendChild(content);
  div.addEventListener("click", (e) => {
    const ed = currentEditor;
    if (!ed) return;
    if (e.target.closest && e.target.closest(".md-delete-toc")) {
      const bi = ed.blockIndexOfNode(div);
      if (bi !== -1) {
        ed.blocks.splice(bi, 1);
        if (!ed.blocks.length) ed.blocks.push({ type: "paragraph", src: "", text: "" });
        ed.renderAll();
        ed.pushHistory();
        ed.emit();
      }
      return;
    }
    const item = e.target.closest && e.target.closest(".md-toc-item");
    if (item) {
      const idx = parseInt(item.getAttribute("data-block") || "-1", 10);
      const b = ed.blocks[idx];
      if (b && b.type === "heading") {
        ed.placeCaret(idx, 0, { scroll: true });
        const h = ed.root.children[idx];
        if (h) {
          h.classList.add("blink-area");
          setTimeout(() => h.classList.remove("blink-area"), 2000);
        }
      }
    }
  });
  return div;
}

// Rebuild the item lists of every TOC block from the current top-level
// headings (our TOC.refresh: first-level blocks only).
function refreshTocs(editor) {
  if (editor._source()?.toc === false) return;
  const tocs = editor.root.querySelectorAll("[mdtype='toc']");
  if (!tocs.length) return;
  const heads = [];
  for (let i = 0; i < editor.blocks.length; i++) {
    const b = editor.blocks[i];
    if (b.type === "heading" && (b.text || "").trim()) heads.push({ level: b.level, text: b.text, index: i });
  }
  for (const div of tocs) {
    const content = div.querySelector(".md-toc-content");
    if (!content) continue;
    const signature = JSON.stringify([div.dataset.depth, heads]);
    if (content.__tocSignature === signature) continue;
    content.__tocSignature = signature;
    const items = heads.filter((h) => h.level <= Number(div.dataset.depth || 6)).map((h) => {
      const item = el("span", { role: "listitem", class: `md-toc-item md-toc-h${h.level}`, "data-block": String(h.index) });
      const inner = el("a", { class: "md-toc-inner" });
      inner.innerHTML = segmentsToHtml(parseInline(h.text, editor.__settings), escapeHtml, editor.__settings);
      item.appendChild(inner);
      return item;
    });
    content.replaceChildren(...items);
  }
}

// Number footnote references by first occurrence in document order and
// add the reverse ("back to document") links on definitions (our
// refreshFootnote + refreshFootnoteReverseLink). Refs match case-
// insensitively, as in our jumpToFootnote.
function refreshFootnotes(editor) {
  // Without references or definitions there is nothing to number or link.
  if (!editor._hasFootnotes()) return;
  const defined = new Set(
    editor.blocks.filter((b) => b.type === "def_footnote" && (b.ref || "").trim())
      .map((b) => b.ref.trim().toLowerCase()),
  );
  const numbers = new Map();
  const counts = new Map();
  for (const s of editor.root.querySelectorAll("sup.md-footnote")) {
    const ref = (s.getAttribute("data-ref") || "").trim();
    if (!ref) continue;
    counts.set(ref, (counts.get(ref) || 0) + 1);
    if (defined.has(ref) && !numbers.has(ref)) numbers.set(ref, numbers.size + 1);
    const numEl = s.querySelector(".md-fn-num");
    if (numbers.has(ref)) {
      s.classList.add("md-has-num");
      if (numEl && numEl.textContent !== String(numbers.get(ref))) numEl.textContent = String(numbers.get(ref));
    } else {
      s.classList.remove("md-has-num");
      if (numEl?.textContent) numEl.textContent = "";
    }
  }
  for (let i = 0; i < editor.blocks.length; i++) {
    const b = editor.blocks[i];
    if (b.type !== "def_footnote") continue;
    const div = editor.root.children[i];
    if (!div || !div.classList || !div.classList.contains("md-def-footnote")) continue;
    if (!(b.ref || "").trim()) {
      // empty ref (mid-deletion state): drop any stale back-links
      const area = div.querySelector(":scope > .md-reverse-footnote-area");
      if (area) area.remove();
      continue;
    }
    const n = counts.get(b.ref.trim().toLowerCase()) || 0;
    let area = div.querySelector(":scope > .md-reverse-footnote-area");
    if (!n) {
      if (area) area.remove();
      continue;
    }
    if (!area) {
      // md-decor: the back-links are rendered affordance, not source
      area = el("span", { class: "md-reverse-footnote-area md-decor", contenteditable: "false" });
      div.appendChild(area);
    }
    if (area.__referenceCount !== n) {
      area.innerHTML = Array.from({ length: n }, (_, k) =>
        ` <a class="reversefootnote" title="back to document" data-index="${k}">↩</a>`,
      ).join("");
      area.__referenceCount = n;
    }
  }
}

function refreshEquations(editor) {
  const version = editor.sourceVersion(), setting = editor.__settings?.numberEquations;
  if (editor._equationVersion !== version || editor._equationSetting !== setting) {
    editor._equations = equationIndex(editor.blocks, editor.__settings);
    editor._equationVersion = version; editor._equationSetting = setting;
  }
  const index = editor._equations;
  Array.from(editor.root.querySelectorAll(".md-math-block")).forEach((node, i) => {
    const equation = index.equations[i];
    if (!equation) return;
    node.id = equation.id;
    renderMathPreview(node.querySelector(":scope > .md-math-body"), equation.block.tex, true, equation, index);
    renderMathPreview(node.querySelector(".md-mathjax-preview"), equation.block.tex, true, equation, index);
  });
  for (const node of editor.root.querySelectorAll(".md-inline-math")) {
    if (window.__lettrine?.settings?.renderMath !== false) {
      renderMathPreview(node.querySelector(".md-math-body"), node.dataset.tex || "", false, null, index);
    }
  }
}

let nextBlockIdentity = 1;
let sourceRevision = 0;
function renderBlockInner(block) {
  block._cid ||= "block-" + nextBlockIdentity++;
  const node = renderBlockContent(block);
  node.dataset.cid = block._cid;
  node.setAttribute("cid", block._cid);
  node.__block = block;
  return node;
}

// Whether a rendered element can stand for a block without rendering it
// again. Rendering depends only on a block's type, source and document
// path. A block that is being edited (a mounted editor, or a formula showing
// its TeX) is kept only when it is the very block that was rendered. Typing
// is covered by the brush queue; code that edits a block's DOM in place
// must point node.__block at the block the element now shows.
function rendersAs(node, block) {
  const rendered = node.__block;
  if (!rendered || !block) return false;
  if (rendered === block) return true;
  if (node.__cm || node.classList.contains("md-focus") || (node.matches("pre.md-fences") && !node.classList.contains("mock-cm"))) return false;
  return rendered.type === block.type && rendered.src === block.src && rendered.pending === block.pending && rendered.__docBase === block.__docBase;
}
function renderBlockContent(block) {
  switch (block.type) {
    case "heading": return renderHeading(block);
    case "code": return renderCode(block);
    case "list": return renderList(block);
    case "quote": return renderQuote(block);
    case "table": return renderTable(block);
    case "math": return renderMath(block);
    case "hr": return renderHr(block);
    case "image": return renderImage(block);
    case "html": return renderHtml(block);
    case "frontmatter": return renderFrontmatter(block);
    case "def_footnote": return renderFootnoteDef(block);
    case "toc": return renderToc(block);
    case "paragraph":
    default:
      return renderParagraph(block);
  }
}

function renderTable(block) {
  const t = el("table", { mdtype: "table", class: "md-table" });
  const edit = (result) => {
    if (!result) return;
    const editor = currentEditor, index = Array.prototype.indexOf.call(editor.root.children, t);
    if (editor.guardReadOnly()) return;
    if (index < 0) return;
    editor.checkpointSelection();
    const updated = parseBlocks(result.source)[0];
    inheritBlockLayout(editor.blocks[index], [updated]);
    updated.__docBase = editor.docBase;
    editor._replaceBlock(index, updated, result.offset);
    editor.root.focus({ preventScroll: true });
    editor.pushHistory(); editor.emit();
  };
  const button = (className, title, label, run) => {
    const node = el("button", { class: className, type: "button", title, "aria-label": title }, label);
    node.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
    node.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); run(); });
    return node;
  };
  const mkCell = (text, tag, prefix, suffix) => {
    const td = el(tag, { mdtype: "table_cell" });
    td.appendChild(marker(prefix, true));
    const c = inlineEl(text, block.__docBase);
    td.appendChild(c);
    td.appendChild(marker(suffix, true));
    if (c.__decor) decorateInline(td, block.__docBase);
    return td;
  };
  const align = tableCellRanges(block.sepLine).map((c) => c.text.startsWith(":") && c.text.endsWith(":") ? "center" : c.text.endsWith(":") ? "right" : "left");
  const row = (line, tag) => {
    const tr = el("tr", { mdtype: "table_row" });
    const ranges = tableCellRanges(line);
    let cursor = 0;
    ranges.forEach((cell, index) => {
      const last = index === ranges.length - 1;
      const td = mkCell(cell.text, tag, line.slice(cursor, cell.start), last ? line.slice(cell.end) : "");
      td.style.textAlign = align[index] || "left";
      tr.appendChild(td);
      cursor = cell.end;
    });
    return tr;
  };
  const headerTr = row(block.headerLine, "th");
  t.appendChild(headerTr);
  const sepTr = el("tr", { mdtype: "table_row", class: "md-sep-row" });
  const sepTd = el("td", { mdtype: "table_cell", colspan: String(block.headers.length) });
  sepTd.appendChild(marker(block.sepLine, true));
  sepTr.appendChild(sepTd);
  t.appendChild(sepTr);
  const rawRows = block.src.split("\n").slice(2);
  for (let i = 0; i < block.rows.length; i++) t.appendChild(row(rawRows[i] ?? block.rowSrc(block.rows[i]), "td"));
  Array.from(t.rows).forEach((tr, rowIndex) => {
    if (rowIndex === 1) return;
    const first = tr.cells[0];
    const line = block.src.split("\n")[rowIndex];
    const offset = block.src.split("\n").slice(0, rowIndex).reduce((n, text) => n + text.length + 1, 0) + (tableCellRanges(line)[0]?.start || 0);
    const controls = el("span", { class: "app-table-row-controls md-decor", contenteditable: "false" });
    controls.append(button("app-table-add-row-above", "Insert Row Above", "+↑", () => edit(editTableRow(block, offset, "above"))),
      button("app-table-add-row-below", "Insert Row Below", "+↓", () => edit(editTableRow(block, offset, "below"))));
    if (rowIndex > 1) controls.append(button("app-table-remove-row", "Delete Row", "−", () => edit(editTableRow(block, offset, "delete"))));
    first.appendChild(controls);
  });
  Array.from(headerTr.cells).forEach((cell, column) => {
    const controls = el("span", { class: "app-table-column-controls md-decor", contenteditable: "false" });
    controls.append(button("app-table-add-column-before", "Insert Column Before", "+←", () => edit(editTableColumn(block, column, "before"))),
      button("app-table-add-column-after", "Insert Column After", "+→", () => edit(editTableColumn(block, column, "after"))),
      button("app-table-remove-column", "Delete Column", "−", () => edit(editTableColumn(block, column, "delete"))));
    const select = el("select", { class: "app-table-align-column", "aria-label": "Column alignment" });
    for (const value of ["left", "center", "right"]) select.appendChild(el("option", { value }, value));
    select.value = align[column] || "left";
    for (const event of ["keydown", "input", "beforeinput", "mousedown"]) select.addEventListener(event, (e) => e.stopPropagation());
    select.addEventListener("change", () => edit(editTableColumn(block, column, "align", select.value)));
    controls.appendChild(select); cell.appendChild(controls);
  });
  return t;
}

function renderMath(block) {
  // Math is a raw block container (md-rawblock-container
  // md-math-container): rendered when idle, TeX source while focused.
  // The marker spans carry the source VERBATIM so textOf(root) is always
  // the exact block source:
  //   unclosed: "$$\n" + tex
  //   closed:   "$$\n" + tex + "\n$$"
  const div = el("div", { mdtype: "math_block", class: "md-math-block md-rawblock-container md-math-container" });
  div.addEventListener("mousedown", (e) => {
    if (e.target.closest?.(".md-math-toolbar")) return;
    if (e.target.closest?.('a[href^="#md-equation-"]')) { e.preventDefault(); return; }
    if (!currentEditor || currentEditor.readOnly) return;
    // a click starts real editing:
    // mount CodeMirror with the cursor where the user pointed
    if (div.__cm) {
      if (!e.target.closest?.(".CodeMirror")) e.preventDefault();
      div.__cm.focus();
      return;
    }
    if (!div.classList.contains("md-math-opener")) {
      e.preventDefault();
      currentEditor.root.focus({ preventScroll: true });
    }
    let where = "auto";
    if (e && e.clientY != null) {
      const r = div.getBoundingClientRect();
      where = (e.clientY - r.top) < r.height / 2 ? "start" : "end";
    }
    mathUpgrade(div, currentEditor, where);
  }, true);
  div.addEventListener("focusout", () => {
    if (div.__cm) return; // the CM's own blur handler drives the downgrade
    if (!div.classList.contains("md-focus")) return;
    div.classList.remove("md-focus");
    div.setAttribute("contenteditable", "false");
    // re-render once with the final source (idle = rendered preview)
    const bi = Array.prototype.indexOf.call(currentEditor ? currentEditor.root.children : [], div);
    if (currentEditor && bi !== -1) currentEditor._brushSoon(bi);
  });

  const source = block.src || "$$";
  const firstBreak = source.indexOf("\n");
  div.classList.toggle("md-math-opener", firstBreak < 0);
  const toolbar = el("div", { class: "md-math-toolbar md-decor", contenteditable: "false" });
  const done = el("button", { type: "button", class: "md-math-done", title: "Done", "aria-label": "Done" });
  done.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  done.addEventListener("click", () => {
    if (currentEditor && !currentEditor.readOnly) mathExitBlock(div, currentEditor);
  });
  toolbar.addEventListener("mousedown", (e) => e.preventDefault());
  toolbar.append(el("span", {}, "Math"), done);
  localizeUI(undefined, toolbar);
  const sourcePanel = el("div", { class: "md-math-source" });
  div.append(toolbar, sourcePanel);
  const prefixLength = firstBreak < 0 ? source.length : firstBreak;
  const closingStart = block.closed ? source.lastIndexOf("\n") : source.length;
  sourcePanel.appendChild(marker(source.slice(0, prefixLength), block.closed));

  // the TeX region owns its leading newline (source-faithful: "$$\n" +
  // tex + "\n$$"); an editable plain span keeps the caret inside a text
  // node. Empty TeX renders as "\n" + ZWSP so the caret still has an
  // anchor and a visible second line exists after $$ + Enter.
  const texSpan = el("span", { class: "md-plain" });
  // "$$\n" is the opener's own newline (empty TeX → ZWSP anchor only);
  // any user content — including just an Enter ("\n") — is real source
  const texSrc = source.slice(prefixLength, closingStart);
  // "" → ZWSP (no second line yet); "\n" (user pressed Enter) → ZWSP on
  // BOTH sides of the newline so the empty line still forms a line box
  if (texSrc === "") appendPlaceholder(texSpan);
  else if (texSrc === "\n") appendPlaceholder(texSpan, "\u200B\n\u200B");
  else texSpan.textContent = texSrc;
  sourcePanel.appendChild(texSpan);

  if (block.closed) sourcePanel.appendChild(marker(source.slice(closingStart), true));

  // rendered preview (decoration — excluded from source walks)
  const c = el("div", { class: "md-math-body md-decor" });
  c.dataset.tex = block.tex;
  renderMathPreview(c, block.tex);
  div.appendChild(c);

  return div;
}

function renderHr(block) {
  if (block.pending) {
    const p = el("p", { mdtype: "hr", class: "md-hr-opener", autocorrect: "off", spellcheck: "false" });
    p.appendChild(marker(block.src, false));
    return p;
  }
  const hr = el("div", { mdtype: "hr", class: "md-hr", role: "separator" });
  hr.appendChild(marker(block.src || "---", true));
  return hr;
}

function renderImage(block) {
  const span = el("span", { mdtype: "image", class: "md-image" });
  span.dataset.url = block.url || "";
  span.dataset.alt = block.alt || "";
  if (block.width) span.dataset.width = block.width;
  if (block.height) span.dataset.height = block.height;
  if (block.zoom) span.dataset.zoom = block.zoom;
  const source = block.src || "![" + (block.alt || "") + "](" + (block.url || "") + ")";
  if (block.syntax === "html") span.appendChild(marker(source, true));
  else {
    const prefix = source.indexOf("![") + 2;
    span.appendChild(marker(source.slice(0, prefix), true));
    const c = inlineEl(block.alt || "", block.__docBase);
    span.appendChild(c);
    span.appendChild(marker(source.slice(prefix + (block.alt || "").length), true));
  }
  if (block.url) {
    const img = el("img", { class: "md-decor" });
    span.appendChild(img);
    decorateImages(span, block.__docBase);
  }
  return span;
}

function renderHtml(block) {
  const div = el("div", { mdtype: "html_block", class: "md-rawblock" });
  const c = inlineEl(block.src, null);
  div.appendChild(c);
  return div;
}

function renderFrontmatter(block) {
  const labelId = block._cid + "-label", hintId = block._cid + "-hint";
  const div = el("div", { mdtype: "frontmatter", class: "md-frontmatter", role: "group", "aria-labelledby": labelId, autocorrect: "off", spellcheck: "false" });
  const caption = el("div", { class: "md-frontmatter-caption md-decor", contenteditable: "false" });
  caption.appendChild(el("span", { class: "md-frontmatter-label", id: labelId }, "YAML Front Matter"));
  if (!block.closed) {
    caption.appendChild(el("span", { class: "md-frontmatter-hint", id: hintId }, "End with --- on a new line, then press Return."));
    div.setAttribute("aria-describedby", hintId);
  }
  caption.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const editor = currentEditor, index = Array.prototype.indexOf.call(editor.root.children, div);
    if (index < 0) return;
    editor.root.focus({ preventScroll: true });
    editor.placeCaret(index, editor.blocks[index].src.indexOf("\n") + 1);
  });
  div.appendChild(caption);
  const source = el("span", { class: "md-plain" }, block.src);
  if (block.src.endsWith("\n")) appendPlaceholder(source);
  div.appendChild(source);
  localizeUI(undefined, caption);
  return div;
}

// ---------------------------------------------------------------------------
// DOM -> source reconstruction (structured walks)
// ---------------------------------------------------------------------------

function liInline(li) {
  return li.querySelector(":scope > .md-plain");
}

// Element.closest for a position that may sit in a text node
function closestOf(node, selector) {
  const eln = node && node.nodeType === 1 ? node : node?.parentElement;
  return eln ? eln.closest(selector) : null;
}

export function listItemsFromDom(listEl) {
  const out = [];
  for (const li of listEl.children) {
    if (li.tagName !== "LI") continue;
    const it = {
      marker: li.dataset.marker || (li.dataset.ordered === "1" ? "1." : "-"),
      ordered: li.dataset.ordered === "1",
      text: "",
      task: null,
      prefix: "",
      indent: 0,
      _before: li.dataset.separator ?? "\n",
      children: [],
    };
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && c.classList && (c.classList.contains("md-tag") || c.classList.contains("md-attr"))) {
        const t = c.textContent;
        it.prefix = t;
        it.indent = t.length - t.replace(/^[ \t]+/, "").length;
        const tm = /^\[([ xX])\]/.exec(t.replace(/^\S+\s*/, ""));
        if (tm) it.task = { checked: tm[1].toLowerCase() === "x" };
        continue;
      }
      if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) {
        it.children.push(...listItemsFromDom(c));
        continue;
      }
      if (c.nodeType === 1 && c.classList && c.classList.contains("md-plain")) {
        it.text += textOf(c);
        continue;
      }
      if (c.nodeType === 3) it.text += c.data;
    }
    out.push(it);
  }
  return out;
}

// Inner blocks keep the separator they were parsed with: adjacent blocks
// (a paragraph and a list, or two lists of different types) stay adjacent.
function quoteSourceFromEl(root) {
  let source = "";
  const children = Array.from(root.children).filter((node) => node.hasAttribute("mdtype"));
  for (const [index, child] of children.entries()) {
    source += (index ? child.__block?._before ?? "\n\n" : child.__block?._leading || "") + blockSourceFromEl(child);
  }
  source += children.at(-1)?.__block?._after || "";
  return source.split("\n").map((line) => line === "" ? ">" : "> " + line).join("\n");
}

// Quote prefixes vary in width, and lazy continuation lines have none.
// Map through the actual source lines instead of assuming two characters.
function quoteOffset(source, offset, toSource = false) {
  let outer = 0, inner = 0;
  for (const line of source.split("\n")) {
    const content = quoteLineContent(line), prefix = line.length - content.length;
    if (toSource && offset <= inner + content.length) return outer + prefix + Math.max(0, offset - inner);
    if (!toSource && offset <= outer + line.length) return inner + Math.max(0, Math.min(content.length, offset - outer - prefix));
    outer += line.length + 1;
    inner += content.length + 1;
  }
  return toSource ? source.length : inner - 1;
}

export function blockSourceFromEl(root) {
  if (root.__cm && root.__getModelSource) return root.__getModelSource() ?? "";
  const t = root.getAttribute ? root.getAttribute("mdtype") : null;
  if (t === "list") {
    const items = listItemsFromDom(root);
    const norm = (list, depth) => {
      for (const it of list) {
        it.indent = depth * 2;
        if (it.children.length) norm(it.children, depth + 1);
      }
    };
    norm(items, 0);
    return listSrcFromItems(items);
  }
  if (t === "table") return Array.from(root.querySelectorAll("tr")).map((tr) => textOf(tr)).join("\n");
  if (t === "fences") return textOf(root);
  if (t === "quote") {
    const current = quoteSourceFromEl(root);
    const original = root.dataset.originalSource;
    if (original == null) return current;
    if (current === root.dataset.renderedSource) return original;
    const raw = original.split("\n");
    const next = current.split("\n");
    if (raw.length !== next.length) return current;
    return raw.map((line, i) => {
      const prefix = /^(\s{0,3}>[ \t]?)/.exec(line)?.[0];
      return prefix ? prefix + next[i].replace(/^> ?/, "") : next[i].replace(/^> ?/, "");
    }).join("\n");
  }
  if (t === "heading") {
    // whole-block walk: text typed outside the md-plain span must still
    // be part of the source (the marker span carries "# ")
    return textOf(root);
  }
  if (t === "math_block") {
    // whole-block walk: the TeX source lives in the marker spans, so edits
    // made while focused flow back through here
    return textOf(root);
  }
  if (t === "hr") {
    return textOf(root);
  }
  if (t === "image") return textOf(root);
  if (t === "html_block") {
    const c = root.querySelector(".md-plain");
    return c ? textOf(c) : textOf(root);
  }
  // paragraph and fallback — walk the whole block so text the browser
  // inserted outside the md-plain span is still part of the source
  return textOf(root);
}

// ---------------------------------------------------------------------------
// caret mapping (source offset <-> DOM position)
// ---------------------------------------------------------------------------

function offsetInInline(inlineEl, node, offset) {
  if (node === inlineEl) {
    let a = 0;
    const kids = inlineEl.childNodes;
    for (let i = 0; i < offset && i < kids.length; i++) a += nodeLen(kids[i]);
    return a;
  }
  let acc = 0;
  const walk = (n) => {
    if (n === node) {
      acc += n.nodeType === 3 ? sourceText(n, offset).length : offset;
      return true;
    }
    if (n.nodeType === 1) {
      for (const c of n.childNodes) {
        if (c.contains && c.contains(node)) {
          if (walk(c)) return true;
        } else acc += nodeLen(c);
      }
    } else if (n.nodeType === 3) {
      acc += nodeLen(n);
    }
    return false;
  };
  for (const c of inlineEl.childNodes) {
    if (c.contains && c.contains(node)) {
      if (walk(c)) return acc;
    } else acc += nodeLen(c);
  }
  return acc;
}

function nodeLen(n) {
  if (n.nodeType === 3) return sourceText(n).length;
  if (n.nodeType !== 1) return 0;
  if (n.classList && n.classList.contains("md-decor")) return 0;
  return textOf(n).length;
}

export function caretOffsetInEl(blockEl, node, offset) {
  const t = blockEl.getAttribute ? blockEl.getAttribute("mdtype") : null;
  if (t === "def_footnote") return domOffsetToText(blockEl, node, offset);
  if (t === "list") {
    const target = closestOf(node, "li");
    let acc = 0;
    let first = true;
    for (const li of blockEl.querySelectorAll("li")) {
      if (!first) acc += (li.dataset.separator ?? "\n").length;
      first = false;
      const prefix = li.querySelector(":scope > .md-tag, :scope > .md-attr");
      const inline = liInline(li);
      const base = prefix?.textContent.length || 0;
      if (li === target) return acc + base + (inline ? offsetInInline(inline, node, offset) : 0);
      acc += base + (inline ? textOf(inline).length : 0);
    }
    return acc;
  }
  if (t === "table") {
    const row = closestOf(node, "tr");
    let acc = 0;
    for (const tr of blockEl.querySelectorAll("tr")) {
      if (tr === row) return acc + domOffsetToText(tr, node, offset);
      acc += textOf(tr).length + 1;
    }
    return acc;
  }
  if (t === "fences") {
    const code = blockEl.querySelector(".md-code-body");
    const opening = blockEl.querySelector(":scope > .md-tag, :scope > .md-attr");
    if (opening?.classList.contains("md-tag") && opening.contains(node)) return offsetInInline(opening, node, offset);
    const base = opening ? textOf(opening).length : Number(blockEl.dataset.prefixLength || 0);
    if (!code || !code.contains(node)) return base + (code ? textOf(code).length : 0);
    return base + offsetInInline(code, node, offset);
  }
  if (t === "quote") {
    let inner = node.nodeType === 1 ? node : node.parentElement;
    while (inner && inner.parentElement !== blockEl) inner = inner.parentElement;
    if (!inner?.hasAttribute("mdtype")) return 0;
    const inners = Array.from(blockEl.children).filter((c) => c.getAttribute && c.getAttribute("mdtype"));
    let acc = 0;
    for (const [index, child] of inners.entries()) {
      acc += (index ? child.__block?._before ?? "\n\n" : child.__block?._leading || "").length;
      if (child === inner) return quoteOffset(blockSourceFromEl(blockEl), acc + caretOffsetInEl(child, node, offset), true);
      acc += blockSourceFromEl(child).length;
    }
    return blockSourceFromEl(blockEl).length;
  }
  if (t === "heading") {
    const inline = blockEl.querySelector(".md-plain");
    // Native typing can extend the marker before the next brush pass.
    const base = inline ? domOffsetToText(blockEl, inline, 0) : 0;
    return inline?.contains(node) ? base + offsetInInline(inline, node, offset) : domOffsetToText(blockEl, node, offset);
  }
  if (t === "math_block") {
    // whole-block text offsets (markers + tex span are the source)
    return domOffsetToText(blockEl, node, offset);
  }
  if (t === "image") return domOffsetToText(blockEl, node, offset);
  // paragraph / fallback
  const inline = blockEl.querySelector(".md-plain") || blockEl;
  if (!inline.contains(node)) return textOf(inline).length;
  return offsetInInline(inline, node, offset);
}

// ---------------------------------------------------------------------------
// caret placement from a source offset
// ---------------------------------------------------------------------------

export function positionInBlock(blockEl, offset) {
  const t = blockEl.getAttribute ? blockEl.getAttribute("mdtype") : null;
  if (t === "def_footnote") {
    const name = blockEl.querySelector(".md-def-name");
    const content = blockEl.querySelector(".md-def-content");
    const prefix = blockEl.querySelector(".md-def-marker")?.textContent.length || 2;
    const nameLength = name ? textOf(name).length : 0;
    if (name && (offset <= prefix + nameLength || !content)) return positionInInline(name, Math.max(0, offset - prefix));
    const contentPrefix = prefix + nameLength + 2 + (blockEl.querySelector(".md-def-split")?.textContent.length || 0);
    return positionInInline(content, Math.max(0, offset - contentPrefix));
  }
  if (t === "list") {
    let acc = 0;
    let last;
    for (const li of blockEl.querySelectorAll("li")) {
      if (last) acc += (li.dataset.separator ?? "\n").length;
      const prefix = li.querySelector(":scope > .md-tag, :scope > .md-attr");
      const inline = liInline(li);
      const base = prefix?.textContent.length || 0;
      const length = inline ? textOf(inline).length : 0;
      if (inline && offset <= acc + base + length) return positionInInline(inline, Math.max(0, offset - acc - base));
      acc += base + length;
      last = inline;
    }
    return last ? positionInInline(last, textOf(last).length) : { node: blockEl, offset: 0 };
  }
  if (t === "fences") {
    const code = blockEl.querySelector(".md-code-body");
    const opening = blockEl.querySelector(":scope > .md-tag, :scope > .md-attr");
    const base = opening ? textOf(opening).length : Number(blockEl.dataset.prefixLength || 0);
    if (opening?.classList.contains("md-tag") && offset <= base) return positionInInline(opening, offset);
    const local = Math.max(0, offset - base);
    if (!code) return { node: blockEl, offset: blockEl.childNodes.length };
    return positionInInline(code, local);
  }
  if (t === "table") {
    let acc = 0;
    const rows = Array.from(blockEl.querySelectorAll("tr"));
    for (const row of rows) {
      const length = textOf(row).length;
      if (!row.classList.contains("md-sep-row") && offset <= acc + length) return positionInInline(row, Math.max(0, offset - acc));
      acc += length + 1;
    }
    const last = rows.at(-1)?.querySelector("td:last-child .md-plain, th:last-child .md-plain");
    return last ? positionInInline(last, textOf(last).length) : { node: blockEl, offset: 0 };
  }
  if (t === "heading") {
    const inline = blockEl.querySelector(".md-plain");
    if (!inline) return { node: blockEl, offset: blockEl.childNodes.length };
    const base = domOffsetToText(blockEl, inline, 0);
    return positionInInline(inline, Math.max(0, offset - base));
  }
  if (t === "quote") {
    const inners = Array.from(blockEl.children).filter((c) => c.getAttribute && c.getAttribute("mdtype"));
    const local = quoteOffset(blockSourceFromEl(blockEl), offset);
    let acc = 0;
    for (const [index, child] of inners.entries()) {
      acc += (index ? child.__block?._before ?? "\n\n" : child.__block?._leading || "").length;
      const length = blockSourceFromEl(child).length;
      if (local <= acc + length) return positionInBlock(child, Math.max(0, local - acc));
      acc += length;
    }
    const last = inners[inners.length - 1];
    return last ? positionInBlock(last, 1000000) : { node: blockEl, offset: 0 };
  }
  if (t === "math_block") {
    if (blockEl.classList.contains("md-math-opener")) {
      const opening = blockEl.querySelector(".md-math-source > .md-tag");
      return positionInInline(opening, Math.min(offset, textOf(opening).length));
    }
    return positionInInline(blockEl, offset);
  }
  if (t === "hr" && blockEl.classList.contains("md-hr-opener")) {
    return positionInInline(blockEl.querySelector(".md-tag"), offset);
  }
  if (t === "image") {
    const length = textOf(blockEl).length;
    if (offset <= 0) return { node: blockEl, offset: 0 };
    if (offset >= length) return { node: blockEl, offset: blockEl.childNodes.length };
    blockEl.classList.add("md-source-focus");
    let remaining = offset;
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (remaining <= node.data.length) return { node, offset: remaining };
        remaining -= node.data.length; return null;
      }
      if (node.nodeType !== 1 || node.classList.contains("md-decor")) return null;
      for (const child of node.childNodes) { const found = walk(child); if (found) return found; }
      return null;
    };
    return walk(blockEl) || { node: blockEl, offset: blockEl.childNodes.length };
  }
  const inline = blockEl.querySelector(".md-plain") || blockEl;
  return positionInInline(inline, offset);
}

function positionInInline(inlineEl, offset) {
  // A browser cannot keep an insertion caret in display:none closing syntax.
  // Give the edges of a styled inline a real, source-free text anchor so
  // continued typing stays outside the style in both WebKit and Chromium.
  if (offset === 0 && inlineEl.firstChild?.nodeType !== 3) {
    const anchor = document.createTextNode("\u200B"); anchor.__mdPlaceholderCount = 1;
    inlineEl.insertBefore(anchor, inlineEl.firstChild);
    return { node: anchor, offset: 0 };
  }
  if (offset >= textOf(inlineEl).length && inlineEl.lastChild?.nodeType !== 3) {
    appendPlaceholder(inlineEl);
    return { node: inlineEl.lastChild, offset: inlineEl.lastChild.data.length };
  }
  let acc = 0;
  const walk = (n) => {
    if (n.nodeType === 3) {
      if (n.classList && n.classList.contains("md-decor")) return null;
      const len = sourceText(n).length;
      if (offset <= acc + len) {
        let remaining = Math.max(0, offset - acc);
        let rawOffset = 0;
        let placeholders = n.__mdPlaceholderCount || 0;
        while (rawOffset < n.data.length && remaining > 0) {
          if (n.data[rawOffset] !== "\u200B" || placeholders-- <= 0) remaining--;
          rawOffset++;
        }
        return { node: n, offset: rawOffset };
      }
      acc += len;
      return null;
    }
    if (n.nodeType !== 1) return null;
    if (n.classList && n.classList.contains("md-decor")) return null;
    if (n.classList && n.classList.contains("md-attr")) {
      if (n.classList.contains("md-smart-source") && offset >= acc && offset <= acc + nodeLen(n)) {
        n.parentElement.classList.add("md-smart-editing");
        currentEditor?._smartFocused.add(n.parentElement);
        for (const c of n.childNodes) { const result = walk(c); if (result) return result; }
        return null;
      }
      acc += nodeLen(n); return null;
    }
    for (const c of n.childNodes) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  const r = walk(inlineEl);
  if (r) return r;
  let last = null;
  const findLast = (n) => {
    if (n.nodeType === 3) { last = n; return; }
    if (n.nodeType !== 1) return;
    if (n.classList && (n.classList.contains("md-decor") || n.classList.contains("md-attr"))) return;
    for (const c of n.childNodes) findLast(c);
  };
  findLast(inlineEl);
  if (last) return { node: last, offset: last.data.length };
  return { node: inlineEl, offset: inlineEl.childNodes.length };
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export class Editor {
  constructor({ root, onChange, onCaret }) {
    this.root = root;
    root.setAttribute("autocorrect", "off");
    currentEditor = this;
    this.onChange = onChange || (() => {});
    this.onCaret = onCaret || (() => {});
    this.blocks = [];
    this.docBase = null;
    this._historyText = "";
    this._history = [{ textLength: 0, selection: { start: 0, end: 0 } }];
    this._future = [];
    this._suppressInput = false;
    this.readOnly = false;
    this._smartFocused = new Set();
    this._lastPush = 0;
    // deferred block re-renders (the "brush" queue): a constant 200 ms
    // interval that never runs while an IME composition or a mouse press owns
    // the input; the caret's text node must never be destroyed synchronously
    // with a keystroke or the macOS input-method connection
    // (NSTextInputClient) breaks
    this._staleBrush = new Set();
    this._brushTimer = null;
    this._brushInterval = 200;
    this._brushIdle = 0;
    for (const type of ["beforeinput", "paste", "cut", "drop"]) root.addEventListener(type, (event) => {
      if (!this.guardReadOnly()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    root.addEventListener("keydown", (event) => {
      if (!this.readOnly || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1 && !["Enter", "Backspace", "Delete"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.guardReadOnly();
    }, true);
    document.addEventListener("mousedown", (event) => {
      if (root.contains(document.activeElement) && !root.contains(event.target)) this.checkpointSelection();
    }, true);

    // IME composition: pause re-rendering while the IME owns the DOM;
    // re-rendering mid-composition tears down the text node the IME is
    // editing into
    root.addEventListener("compositionstart", (event) => {
      if (this.readOnly) return;
      if (eventInCmBlock(root, event)) return;
      window.__hideEmoji?.();
      this.checkpointSelection();
      this._compositionStart = { text: this.getMarkdown(), selection: this.selectionOffsets(), generation: this._generation };
      this._composing = true;
    });
    root.addEventListener("compositionend", (event) => {
      if (this.readOnly) return;
      if (eventInCmBlock(root, event)) return;
      const initial = this._compositionStart;
      this._compositionStart = null;
      this._composing = false;
      if (this._dirtyFromComposition) {
        this._dirtyFromComposition = false;
        // let the final committed text settle in the DOM, then re-parse once
        this._compositionTimer = setTimeout(() => {
          this._compositionTimer = null;
          // WebKit may move a native marked-text insertion across hidden
          // closing syntax, deleting adjacent whitespace in the process.
          // Reconcile the committed text with the original source selection
          // after the IME releases its nodes. Leave correctly targeted DOM
          // untouched so ordinary composition retains its native anchor.
          if (initial?.selection && initial.generation === this._generation && event.data) {
            const { start, end } = initial.selection;
            const expected = initial.text.slice(0, start) + event.data + initial.text.slice(end);
            const first = this.globalOffsetToBlock(start).index, last = this.globalOffsetToBlock(end).index;
            const live = this.root.children.length === this.blocks.length ? blocksToMarkdown(this.blocks.map((block, i) => i < first || i > last || this.root.children[i].__cm ? block : { ...block, src: blockSourceFromEl(this.root.children[i]) })) : null;
            if (live !== expected) {
              this.setText(expected, { docBase: this.docBase, resetHistory: false });
              this.selectOffsets(start + event.data.length);
              this.pushHistory({ inputType: "insertCompositionText" }); this.emit();
              return;
            }
          }
          this.handleInput({ inputType: "insertCompositionText" });
          this._afterTextInput({ inputType: "insertCompositionText" });
        }, 0);
      }
    });
    root.addEventListener("keydown", (event) => {
      if (event.target.closest?.(".md-lang-input")) return;
      const sel = window.getSelection();
      if (sel && sel.rangeCount && sel.anchorNode && !this.root.contains(sel.anchorNode)) {
        this._normalizeCaret();
      }
    }, true);
    root.addEventListener("beforeinput", (e) => this.handleBeforeInput(e));
    root.addEventListener("input", (e) => {
      this.handleInput(e);
      this._afterTextInput(e);
    });
    root.addEventListener("keydown", (e) => handleKeydown(this, e));
    root.addEventListener("paste", (e) => handlePaste(this, e));
    root.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    root.addEventListener("drop", (e) => this._handleDrop(e));
    root.addEventListener("dragstart", (e) => {
      if (eventInCmBlock(root, e)) return;
      const selection = this.selectionOffsets();
      if (!selection || selection.start === selection.end || !e.dataTransfer) return;
      const markdown = this.getMarkdown().slice(selection.start, selection.end);
      e.dataTransfer.setData("text/plain", markdown);
      e.dataTransfer.setData("text/markdown", markdown);
      const fragment = window.getSelection().getRangeAt(0).cloneContents();
      for (const node of fragment.querySelectorAll(".md-decor, .md-attr, input, textarea")) node.remove();
      const wrap = document.createElement("div"); wrap.appendChild(fragment);
      e.dataTransfer.setData("text/html", wrap.innerHTML);
      e.dataTransfer.effectAllowed = "copy";
    });
    root.addEventListener("click", (e) => this._handleEditorClick(e));
    root.addEventListener("change", (e) => {
      if (!e.target.matches?.("input[type='checkbox']")) return;
      if (this.guardReadOnly()) { e.target.checked = !e.target.checked; return; }
      const li = e.target.closest("li");
      const prefix = li?.querySelector(":scope > .md-attr, :scope > .md-tag");
      const index = this.blockIndexOfNode(li);
      if (!prefix || index < 0) return;
      this.checkpointSelection();
      prefix.textContent = prefix.textContent.replace(/\[[ xX]\]/, e.target.checked ? "[x]" : "[ ]");
      const updated = parseBlocks(blockSourceFromEl(this.root.children[index]));
      inheritBlockLayout(this.blocks[index], updated);
      for (const block of updated) block.__docBase = this.docBase;
      this.blocks.splice(index, 1, ...updated);
      // the element was edited in place and now shows the updated block
      this.root.children[index].__block = updated.length === 1 ? updated[0] : null;
      this.pushHistory();
      this.emit();
    });
    root.addEventListener("contextmenu", (e) => this._handleImageContext(e));
    root.addEventListener("mousedown", (e) => {
      if (e.target.closest?.('a[href^="#md-equation-"]')) e.preventDefault();
      const smart = e.target.closest?.(".md-smart");
      if (!this.readOnly && smart) { smart.classList.add("md-smart-editing"); this._smartFocused.add(smart); }
    });
    document.addEventListener("selectionchange", () => { this._syncSmartFocus(); this._syncSimpleBlockFocus(); });
    for (const type of ["focusin", "focusout"]) root.addEventListener(type, () => queueMicrotask(() => this._syncSimpleBlockFocus()));
    // Chromium can drop the caret outside every block (e.g. a click in the
    // empty area below a short document, or an empty first paragraph), and
    // typing there inserts a stray top-level text node. Snap the caret back
    // into a block before that happens.
    root.addEventListener("mousedown", (e) => { this._mousePressed = true; this._mousePressedAt = Date.now(); this._lastMouseDown = { x: e.clientX, y: e.clientY }; this._lastMouseDownAt = Date.now(); });
    root.addEventListener("mouseup", () => { this._mousePressed = false; setTimeout(() => this._normalizeCaret(), 0); });
    // Releasing outside the editor (including in the sidebar) must also
    // resume brushing and caret centering after a drag.
    window.addEventListener("mouseup", () => { this._mousePressed = false; });
    window.addEventListener("blur", () => { this._mousePressed = false; });
    bindFenceCompletion(this, doEnter);
  }

  guardReadOnly() {
    if (!this.readOnly) return false;
    window.__lettrineNotify?.("Readonly mode is on. Turn it off to edit.");
    return true;
  }

  setReadOnly(enabled) {
    enabled = !!enabled;
    if (enabled === this.readOnly) return;
    if (enabled) {
      this.checkpointSelection();
      this._readonlySelection = this.selectionOffsets();
      this._readonlyGeneration = this._generation;
      const mounted = this._activeCmBlock();
      this._readonlyMounted = mounted ? { ...mounted, selections: mounted.cm.listSelections() } : null;
      window.__hideEmoji?.();
    }
    this.readOnly = enabled;
    if (enabled) hideCodeCompletion();
    if (enabled) for (const image of this.root.querySelectorAll(".md-image.md-source-focus")) image.classList.remove("md-source-focus");
    this._applyReadOnly();
    this._syncSmartFocus();
    if (!enabled && this._readonlyGeneration === this._generation && this._readonlySelection) {
      const mounted = this._readonlyMounted;
      if (mounted?.element.isConnected && mounted.element.__cm === mounted.cm) {
        mounted.cm.setSelections(mounted.selections);
        mounted.cm.focus();
        return;
      }
      const selection = this._readonlySelection;
      this.root.focus({ preventScroll: true });
      this.selectOffsets(selection.start, selection.end, selection.backward);
    }
  }

  _applyReadOnly(root = this.root) {
    const nodes = [root, ...root.querySelectorAll("[contenteditable], input, textarea, button, select")];
    for (const node of nodes) {
      if (this.readOnly) {
        node.__beforeReadOnly ||= { editable: node.getAttribute("contenteditable"), disabled: node.disabled, readOnly: node.readOnly };
        if (node.hasAttribute("contenteditable")) node.setAttribute("contenteditable", "false");
        if (node.matches("input, textarea")) node.readOnly = true;
        if (node.matches("button, select, input[type=checkbox]")) node.disabled = true;
      } else if (node.__beforeReadOnly) {
        const previous = node.__beforeReadOnly;
        if (previous.editable === null) node.removeAttribute("contenteditable");
        else node.setAttribute("contenteditable", previous.editable);
        if (previous.disabled !== undefined) node.disabled = previous.disabled;
        if (previous.readOnly !== undefined) node.readOnly = previous.readOnly;
        delete node.__beforeReadOnly;
      }
    }
    // CodeMirror also changes its textarea: remember that field before updating it.
    for (const node of nodes) if (node.__cm) node.__cm.setOption("readOnly", this.readOnly);
    this.root.setAttribute("aria-readonly", String(this.readOnly));
  }

  // sync and tear down any mounted CodeMirror blocks (fences / math) so a
  // full rebuild doesn't orphan their edits — called before setText
  _cedeCmBlocks() {
    for (const c of Array.from(this.root.children)) {
      if (!c.__cm) continue;
      if (c.getAttribute && c.getAttribute("mdtype") === "fences") fenceDowngrade(c, this);
      else mathDowngrade(c, this);
    }
  }

  setText(md, opts = {}) {
    window.__hideEmoji?.();
    hideCodeCompletion();
    clearTimeout(this._compositionTimer);
    this._compositionTimer = null;
    this._compositionStart = null;
    this._composing = false;
    this._mousePressed = false;
    this._dirtyFromComposition = false;
    if (!this._renderPending) this._cedeCmBlocks();
    // Edits of the open document parse only the blocks they touched and keep
    // the others, with their identities and rendered elements.
    const previous = opts.resetHistory === false && (opts.docBase || null) === this.docBase ? this._source() : null;
    if (previous?.math !== false) for (const block of this.root.querySelectorAll(":scope > .md-math-block")) block.classList.remove("md-focus");
    this.docBase = opts.docBase || null;
    const blocks = (previous && reparseBlocks(this.blocks, previous.starts, previous.text, md || "")) || parseBlocks(md || "");
    if (!blocks.length) blocks.push({ type: "paragraph", src: "", text: "" });
    const last = blocks.at(-1);
    if (last._after?.includes("\n")) {
      const separation = last._after;
      delete last._after;
      blocks.push({ type: "paragraph", src: "", text: "", _before: separation });
    }
    for (const b of blocks) b.__docBase = this.docBase;
    this.blocks = blocks;
    if (opts.render === false) {
      this._staleBrush.clear();
      this._renderPending = true;
    } else this.renderAll();
    if (opts.resetHistory !== false) {
      this._generation = (this._generation || 0) + 1;
      this._historyText = this.getMarkdown();
      this._history = [{ textLength: this._historyText.length, selection: { start: 0, end: 0 } }];
      this._future = [];
      this._lastPush = 0;
      this._historyGroup = null;
    }
  }

  getMarkdown() {
    const state = this._source();
    return state ? state.text : blocksToMarkdown(this.blocks);
  }

  // Serialized source and block offsets, shared by every caret, selection,
  // history and save query. Blocks are replaced rather than edited in place,
  // so comparing block, source, separator and type references validates the
  // cache without joining the document again. When the blocks differ only in
  // one run (typing, Enter, a paste, an incremental reparse), the text and
  // offsets are patched; anything else rebuilds them. Returns null for a
  // model with missing sources, which callers serialize directly.
  _source() {
    const blocks = this.blocks, state = this._sourceState, count = blocks.length;
    if (state && count && blocks[0]?._leading === state.leading && blocks[count - 1]?._after === state.after) {
      const { refs, sources, befores, types } = state;
      const same = (block, i) => block === refs[i] && block.src === sources[i] && block._before === befores[i] && block.type === types[i];
      const limit = Math.min(count, state.count);
      let head = 0;
      while (head < limit && same(blocks[head], head)) head++;
      if (head === count && count === state.count) return state;
      let tail = 0;
      while (tail < limit - head && same(blocks[count - 1 - tail], state.count - 1 - tail)) tail++;
      // The first block is written without a separator, so a kept block that
      // is or was first joins the run; so does a kept block without its own
      // separator, which follows the type of the block before it.
      while (tail && (tail === count || tail === state.count || blocks[count - tail]._before === undefined)) tail--;
      if ((head || tail) && blocks.slice(head, count - tail).every((block) => block && typeof block.src === "string")) {
        this._patchSource(state, head, tail);
        return state;
      }
    }
    this._sourceState = null;
    if (!count || blocks.some((block) => !block || typeof block.src !== "string")) return null;
    const next = { count, leading: blocks[0]._leading, after: blocks[count - 1]._after, refs: blocks.slice(), sources: new Array(count), befores: new Array(count), types: new Array(count), starts: new Array(count), version: ++sourceRevision, footnotes: undefined };
    const parts = [blocks[0]._leading || ""];
    let offset = parts[0].length;
    for (let i = 0; i < count; i++) {
      const block = blocks[i];
      if (i) { const separator = blockSeparator(blocks, i); parts.push(separator); offset += separator.length; }
      next.sources[i] = block.src; next.befores[i] = block._before; next.types[i] = block.type; next.starts[i] = offset;
      parts.push(block.src); offset += block.src.length;
    }
    parts.push(next.after || "");
    next.text = parts.join("");
    next.math = next.types.includes("math");
    next.toc = next.types.includes("toc");
    this._sourceState = next;
    return next;
  }

  // Replace cached blocks [head, count - tail) with the model's run.
  _patchSource(state, head, tail) {
    const blocks = this.blocks, count = blocks.length, oldCount = state.count;
    // The run's text: from the end of the block before it (or the document
    // start) to the separator of the first kept block after it (or the end).
    const from = head ? state.starts[head - 1] + state.sources[head - 1].length : 0;
    const to = tail ? state.starts[oldCount - tail] - blocks[count - tail]._before.length : state.text.length;
    const parts = head ? [] : [blocks[0]._leading || ""], starts = [];
    let offset = from + (head ? 0 : parts[0].length);
    for (let i = head; i < count - tail; i++) {
      if (i) { const separator = blockSeparator(blocks, i); parts.push(separator); offset += separator.length; }
      starts.push(offset); parts.push(blocks[i].src); offset += blocks[i].src.length;
    }
    if (!tail) { parts.push(state.after || ""); offset += (state.after || "").length; }
    const delta = offset - to;
    const removedSources = state.sources.slice(head, oldCount - tail), removedTypes = state.types.slice(head, oldCount - tail);
    const run = blocks.slice(head, count - tail);
    state.text = state.text.slice(0, from) + parts.join("") + state.text.slice(to);
    const kept = state.starts.slice(oldCount - tail);
    for (let i = 0; i < kept.length; i++) kept[i] += delta;
    state.starts = [...state.starts.slice(0, head), ...starts, ...kept];
    state.refs.splice(head, oldCount - tail - head, ...run);
    state.sources.splice(head, oldCount - tail - head, ...run.map((block) => block.src));
    state.befores.splice(head, oldCount - tail - head, ...run.map((block) => block._before));
    state.types.splice(head, oldCount - tail - head, ...run.map((block) => block.type));
    state.count = count;
    const footnotes = (sources, types) => types.includes("def_footnote") || sources.some((source) => source.includes("[^"));
    if (state.footnotes === false) state.footnotes = footnotes(run.map((block) => block.src), run.map((block) => block.type));
    else if (state.footnotes && footnotes(removedSources, removedTypes)) state.footnotes = undefined;
    state.math = state.types.includes("math");
    state.toc = state.types.includes("toc");
    state.version = ++sourceRevision;
  }

  // Changes whenever the serialized document changes; lets views that
  // summarize the whole document skip work for caret-only updates.
  sourceVersion() {
    return this._source()?.version ?? ++sourceRevision;
  }

  // Whether any footnote reference or definition can need numbering.
  _hasFootnotes() {
    const state = this._source();
    if (!state) return true;
    if (state.footnotes === undefined) state.footnotes = state.types.includes("def_footnote") || state.sources.some((source) => source.includes("[^"));
    return state.footnotes;
  }

  getSpeechText() {
    const selection = this.selectionOffsets();
    const text = this.getMarkdown();
    return readableMarkdown(selection && selection.start !== selection.end ? text.slice(selection.start, selection.end) : text, this.__settings);
  }
  exitRawBlock() {
    const mounted = this._activeCmBlock();
    if (!mounted) return;
    if (this.blocks[mounted.index].type === "math") mathExitAtEnd(mounted.cm, mounted.element, this);
    else fenceExit(mounted.cm, mounted.element, this);
  }

  async _handleDrop(event) {
    event.preventDefault();
    if (this.guardReadOnly()) return;
    if (eventInCmBlock(this.root, event)) {
      this._notifyImageSaved("Drop files in the document text outside the code or formula editor.");
      return;
    }
    const data = event.dataTransfer;
    if (!data) return;
    let point;
    try { point = document.caretRangeFromPoint?.(event.clientX, event.clientY); } catch { /* browser fallback */ }
    if (point && this.root.contains(point.startContainer)) {
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(point);
    }
    const range = this.selectionOffsets() || { start: this.globalIndexOfCaret(), end: this.globalIndexOfCaret() };
    const generation = this._generation, source = this.getMarkdown();
    const files = Array.from(data.files || []);
    if (!files.length) {
      this.replaceRange(range.start, range.end, data.getData("text/markdown") || data.getData("text/plain"));
      return;
    }
    try {
      const references = [], imports = [];
      for (const file of files) {
        const path = window.bridge.path.forFile(file);
        if (!path) continue;
        if (importFormat(path) && this.__settings?.editorFileDrop === "import") { imports.push(path); continue; }
        const image = file.type.startsWith("image/") || /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(file.name);
        const result = image ? await window.bridge.images.import({ sourcePath: path, docPath: this.docBase })
          : await window.bridge.path.reference({ path, docPath: this.docBase });
        if (!result.canceled) references.push((image ? "!" : "") + linkMarkdown(image ? "" : file.name, result.reference).source);
      }
      if (this.readOnly || generation !== this._generation || source !== this.getMarkdown()) { this._notifyImageSaved("The document changed while importing files. Drop them again at the new position."); return; }
      if (references.length) this.replaceRange(range.start, range.end, references.join("\n\n"));
      for (const path of imports) {
        if (this.readOnly) return;
        await window.__lettrine?.importDocument(path);
      }
    } catch (error) { this._notifyImageSaved("File import failed: " + error.message); }
  }

  setDocumentPath(path) {
    this.docBase = path;
    for (const block of this.blocks) block.__docBase = path;
    decorateInline(this.root, path);
  }

  // outline: headings with their top-level block index
  setDiagramTheme(dark) {
    const font = documentFont();
    if (_diagramDark === !!dark && _diagramFont === font) return;
    _diagramDark = !!dark;
    _diagramFont = font;
    for (const panel of this.root.querySelectorAll(".md-diagram[data-tex]")) renderDiagramInto(panel, panel.dataset.tex);
  }

  getOutline() {
    const items = [];
    this.blocks.forEach((b, i) => {
      if (b.type === "heading" && b.text && b.text.trim()) {
        items.push({ level: b.level, text: b.text.trim(), blockIndex: i });
      }
    });
    return items;
  }

  refreshImages() { decorateImages(this.root, this.docBase); }

  // Render the model into the editor. Leading and trailing blocks whose DOM
  // already shows the same source are kept, with their live formulas,
  // diagrams, images, code editors and spelling state, so structural edits,
  // undo and pastes render only what changed. { full: true } rebuilds every
  // block, for changes to rendering settings.
  renderAll(opts = {}) {
    this._renderPending = false;
    const hadFocus = this.root.contains(document.activeElement);
    const aligned = this.root.children.length === this.blocks.length && [...this.root.children].every((node, index) => node.dataset.cid && node.dataset.cid === this.blocks[index]?._cid);
    const selection = hadFocus && aligned ? this.selectionOffsets() : null;
    this._suppressInput = true;
    if (!this.blocks.length) this.blocks.push({ type: "paragraph", src: "", text: "" });
    const blocks = this.blocks, old = Array.from(this.root.children), stale = this._staleBrush;
    let head = 0, tail = 0;
    // Stray text nodes leave the DOM out of step with the model: rebuild.
    if (!opts.full && old.length && this.root.childNodes.length === old.length) {
      const limit = Math.min(old.length, blocks.length);
      while (head < limit && !stale.has(head) && rendersAs(old[head], blocks[head])) head++;
      while (tail < limit - head && !stale.has(old.length - 1 - tail) && rendersAs(old[old.length - 1 - tail], blocks[blocks.length - 1 - tail])) tail++;
    }
    this._staleBrush.clear();
    const removed = old.slice(head, old.length - tail);
    // capture CM-mounted blocks so the rebuild does not orphan their state
    const cmBlocks = [];
    for (let i = head; i < old.length - tail; i++) {
      const c = old[i];
      if (c && c.__cm) {
        let cursor = null;
        try { cursor = { anchor: c.__cm.getCursor("anchor"), head: c.__cm.getCursor("head"), focused: c.contains(document.activeElement) }; } catch { /* ok */ }
        cmBlocks.push({
          index: i,
          cid: c.dataset.cid,
          fence: c.getAttribute && c.getAttribute("mdtype") === "fences",
          cursor,
        });
        try { c.__cm.toTextArea(); } catch { /* editor may already be detached */ }
        c.__cm = null;
      }
    }
    const focusedIds = new Set(removed.map((c) => c.classList?.contains("md-focus") ? c.dataset.cid : null).filter(Boolean));
    // Kept elements keep their identities; rendered blocks must not reuse them.
    const identities = new Set();
    const keep = (block, node) => { node.__block = block; block._cid = node.dataset.cid; identities.add(block._cid); };
    for (let i = 0; i < head; i++) keep(blocks[i], old[i]);
    for (let i = 1; i <= tail; i++) keep(blocks[blocks.length - i], old[old.length - i]);
    const fragment = document.createDocumentFragment(), rendered = [];
    // a new document highlights its code in the background
    bulkRender = blocks.length - tail - head > 20;
    try {
      for (let i = head; i < blocks.length - tail; i++) {
        const b = blocks[i];
        if (b._cid && identities.has(b._cid)) delete b._cid;
        const node = renderBlockInner(b);
        fragment.appendChild(node); rendered.push(node); identities.add(b._cid);
      }
    } finally { bulkRender = false; }
    if (!head && !tail) this.root.replaceChildren(fragment);
    else {
      if (removed.length) {
        const range = document.createRange();
        range.setStartBefore(removed[0]); range.setEndAfter(removed.at(-1));
        range.deleteContents();
      }
      this.root.insertBefore(fragment, tail ? old[old.length - tail] : null);
    }
    // focused math blocks keep their editing state across re-renders
    for (const c of rendered) {
      if (!focusedIds.has(c.dataset.cid)) continue;
      if (c && c.classList && c.classList.contains("md-math-block")) {
        c.classList.add("md-focus");
        c.setAttribute("contenteditable", "true");
      }
    }
    // remount CodeMirror on blocks that had one before the rebuild
    for (const cb of cmBlocks) {
      const index = cb.cid ? this.blocks.findIndex((block) => block._cid === cb.cid) : cb.index;
      const c = this.root.children[index];
      if (!c || c.__cm) continue;
      if (cb.fence) fenceUpgrade(c, this, cb.cursor);
      else mathUpgrade(c, this, cb.cursor ? "end" : "auto", cb.cursor);
    }
    refreshTocs(this);
    refreshFootnotes(this);
    refreshEquations(this);
    if (this.readOnly) this._applyReadOnly();
    this._suppressInput = false;
    if (hadFocus && !this.root.contains(document.activeElement) && !document.querySelector(".modal.open")) {
      this.root.focus({ preventScroll: true });
      if (selection) this.selectOffsets(selection.start, selection.end, selection.backward);
    }
  }

  // Index of the top-level block containing node, or -1. Each block element
  // remembers its last index, which stays valid until blocks before it move.
  blockIndexOfNode(node) {
    let eln = node && node.nodeType === 3 ? node.parentElement : node;
    const root = this.root;
    while (eln && eln.parentElement !== root) eln = eln.parentElement;
    if (!eln || !eln.getAttribute("mdtype")) return -1;
    const children = root.children, hint = eln.__blockIndex;
    if (hint !== undefined && children[hint] === eln) return hint;
    const index = Array.prototype.indexOf.call(children, eln);
    eln.__blockIndex = index;
    return index;
  }

  caretInfo() {
    const mounted = this._activeCmBlock();
    if (mounted) {
      const { element, cm, index } = mounted;
      const prefix = (this.blocks[index].src.indexOf("\n") + 1) || 2;
      return { blockIndex: index, offset: prefix + cm.indexFromPos(cm.getCursor()) };
    }
    const lastBlock = this.blocks[this.blocks.length - 1];
    const fallback = { blockIndex: Math.max(0, this.blocks.length - 1), offset: (lastBlock?.src || "").length };
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return fallback;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (!this.root.contains(node)) return fallback;
    const bi = this.blockIndexOfNode(node);
    if (bi === -1) return fallback;
    const el = this.root.children[bi];
    const offset = caretOffsetInEl(el, node, r.startOffset);
    return { blockIndex: bi, offset };
  }

  globalOffsetToBlock(off) {
    const state = this._source();
    if (state) {
      // the first block whose source ends at or after the offset
      const { starts, sources, count } = state;
      let low = 0, high = count - 1;
      if (off > starts[high] + sources[high].length) return { index: high, offset: sources[high].length };
      while (low < high) {
        const middle = (low + high) >> 1;
        if (off <= starts[middle] + sources[middle].length) high = middle; else low = middle + 1;
      }
      return { index: low, offset: Math.max(0, off - starts[low]) };
    }
    let acc = (this.blocks[0]?._leading || "").length;
    for (let i = 0; i < this.blocks.length; i++) {
      const len = (this.blocks[i].src || "").length;
      if (off <= acc + len) return { index: i, offset: Math.max(0, off - acc) };
      acc += len + blockSeparator(this.blocks, i + 1).length;
    }
    const last = this.blocks.length - 1;
    return { index: last, offset: (this.blocks[last]?.src || "").length };
  }

  placeCaret(blockIndex, offset, opts = {}) {
    const blocks = this.root.children;
    if (blockIndex < 0 || blockIndex >= blocks.length) {
      const r = document.createRange();
      r.selectNodeContents(this.root);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      this._syncSimpleBlockFocus();
      return;
    }
    const el = blocks[blockIndex];
    const pos = positionInBlock(el, offset);
    const sel = window.getSelection();
    if (opts.anchor != null && pos.node) {
      const a = positionInBlock(el, Math.min(opts.anchor, offset));
      const z = positionInBlock(el, Math.max(opts.anchor, offset));
      if (a.node) {
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(z.node, z.offset);
        sel.removeAllRanges();
        sel.addRange(r);
        this._syncSimpleBlockFocus();
        return;
      }
    }
    const r = document.createRange();
    r.setStart(pos.node, pos.offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    this._syncSimpleBlockFocus();
    if (opts.scroll) this._revealCaret(el);
  }

  // Keep the caret visible after an edit or jump. Measuring waits for the
  // next frame, which lays out the document anyway, instead of forcing a
  // layout now (35 ms in a 5,000-block document). A visible caret does not
  // move the view; one at the edge scrolls just into view, and one off
  // screen is centered.
  _revealCaret(element) {
    this._revealTarget = element;
    if (this._revealFrame) return;
    this._revealFrame = requestAnimationFrame(() => {
      this._revealFrame = 0;
      const target = this._revealTarget;
      this._revealTarget = null;
      if (!target?.isConnected || !target.scrollIntoView) return;
      // Source Code Mode hides the laid-out document under its own view.
      if (window.getComputedStyle(this.root).visibility === "hidden") return;
      const scroller = this.root.parentElement, bounds = scroller?.getBoundingClientRect();
      const selection = window.getSelection();
      let rect = selection?.rangeCount && target.contains(selection.focusNode) ? selection.getRangeAt(0).getBoundingClientRect() : null;
      if (!rect || !rect.height) rect = target.getBoundingClientRect();
      if (!bounds || !bounds.height) { target.scrollIntoView({ block: "center" }); return; }
      const margin = Math.min(48, bounds.height / 6);
      if (rect.top >= bounds.top + margin && rect.bottom <= bounds.bottom - margin) return;
      const offscreen = rect.bottom < bounds.top || rect.top > bounds.bottom;
      if (offscreen) { target.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
      const delta = rect.top < bounds.top + margin ? rect.top - bounds.top - margin : rect.bottom - bounds.bottom + margin;
      scroller.scrollBy({ top: delta, behavior: "smooth" });
    });
  }

  // Enter-shaped inputs are ours. insertText is native WHEN the insertion
  // point is a text node inside a block — the macOS input method anchors on
  // that live text node and must not see it replaced (IME death otherwise).
  // Chromium resolves insertText at element-level/escaped selections by
  // dropping a top-level text node OUTSIDE the blocks, so those we take over
  // via the model (no IME marked text can be in flight there: compositions
  // always sit inside text nodes and are guarded by _composing).
  handleBeforeInput(e) {
    if (this.guardReadOnly()) { e.preventDefault(); return; }
    if (eventInCmBlock(this.root, e)) return; // CodeMirror owns this input
    if (this._suppressInput || this._composing) return;
    // WebKit's automatic substitutions have no replacement text in the
    // beforeinput event. Source-aware punctuation and replacement commands
    // own these changes, including inside code and in rendering-only mode.
    if (e.inputType === "insertReplacementText" && e.data == null) {
      e.preventDefault(); this._restoreNativeInputCaret = true; return;
    }
    this._lastNativeInputAt = performance.now();
    this.checkpointSelection();
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      if (e.inputType === "historyUndo") this.undo();
      else this.redo();
      return;
    }
    if (e.inputType === "insertText" && e.data?.length === 1 && this.__settings?.autoPairMarkdown) {
      const selection = this.selectionOffsets(), anchor = window.getSelection()?.anchorNode;
      const element = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
      const position = selection && this.globalOffsetToBlock(selection.start), block = position && this.blocks[position.index];
      if (selection?.start === selection?.end && e.data === "`" && element?.closest?.("code") && this.getMarkdown()[selection.start] === "`") {
        e.preventDefault(); this.selectOffsets(selection.start + 1); return;
      }
      const literal = element?.closest?.("code, a.url, .md-attr, .md-tex-src, .md-decor, .md-def-name, .md-def-marker");
      const opener = block?.type === "code" && !block.src.includes("\n");
      if (block && (!["code", "math", "html", "frontmatter"].includes(block.type) || opener) && !literal && this.globalOffsetToBlock(selection.end).index === position.index) {
        const source = this.getMarkdown(), edit = markdownPairEdit(source, selection, e.data, this._markdownPair, newCodeLanguage(this.__settings, this._lastCodeLanguage));
        if (edit) {
          e.preventDefault();
          if (edit.from !== edit.to || edit.text) this.replaceRange(edit.from, edit.to, edit.text, { recordHistory: false, emit: false });
          this.selectOffsets(edit.selection.start, edit.selection.end);
          this._markdownPair = edit.pair;
          this.pushHistory({ inputType: "markdown-pair" }); this.emit(); return;
        }
      }
      this._markdownPair = null;
    }
    if (e.inputType === "insertText" && e.data?.length === 1 && /["'.-]/.test(e.data)) {
      const selection = this.selectionOffsets(), anchor = window.getSelection()?.anchorNode;
      const element = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
      const position = selection && this.globalOffsetToBlock(selection.start), block = position && this.blocks[position.index];
      if (block && !["code", "math", "html", "frontmatter"].includes(block.type) && this.globalOffsetToBlock(selection.end).index === position.index) {
        const localEnd = selection.end - this.blockStart(position.index);
        const proposed = block.src.slice(0, position.offset) + e.data + block.src.slice(localEnd);
        const literal = element?.closest?.("code, a.url, .md-attr, .md-tex-src, .md-decor, .md-def-name, .md-def-marker");
        const change = literal ? null : punctuationInputEdit(proposed, position.offset + 1, this.__settings);
        e.preventDefault();
        // Keep the native character and its conversion as separate undo steps.
        this.replaceRange(selection.start, selection.end, e.data, { inputType: "insertText" });
        if (change) this.replaceRange(this.blockStart(position.index) + change.start, selection.start + 1, change.text, { inputType: "smartPunctuation" });
        this._afterTextInput(e);
        return;
      }
    }
    if (e.inputType === "insertText" && e.data?.length === 1 && "([{)]}".includes(e.data) && this.__settings && this.__settings.autoPair !== false) {
      const selection = this.selectionOffsets();
      const source = this.getMarkdown();
      const block = selection && this.blocks[this.globalOffsetToBlock(selection.start).index];
      if (selection && !["code", "math"].includes(block?.type)) {
        const closing = ({ "(": ")", "[": "]", "{": "}" })[e.data];
        if (closing) {
          e.preventDefault();
          this.replaceRange(selection.start, selection.end, e.data + source.slice(selection.start, selection.end) + closing, { recordHistory: false, emit: false });
          this.selectOffsets(selection.start + 1, selection.end + 1);
          this.pushHistory({ inputType: "insertText" }); this.emit(); return;
        }
        if (selection.start === selection.end && /[)\]}]/.test(e.data) && source[selection.start] === e.data) {
          e.preventDefault(); this.selectOffsets(selection.start + 1); return;
        }
      }
    }
    // Browser range edits can remove several block DOM nodes while leaving
    // their model entries behind. Apply them once to the complete source.
    const selection = this.selectionOffsets();
    if (selection && selection.start !== selection.end) {
      if (["insertText", "insertReplacementText"].includes(e.inputType) && typeof e.data === "string") {
        e.preventDefault();
        this.replaceRange(selection.start, selection.end, e.data, { inputType: e.inputType });
        this._afterTextInput(e);
        return;
      }
      if (e.inputType?.startsWith("delete")) {
        e.preventDefault();
        this.deleteSelection();
        return;
      }
    }
    if (e.inputType === "insertParagraph") {
      e.preventDefault();
      doEnter(this);
    } else if (e.inputType === "insertLineBreak") {
      e.preventDefault();
      hardBreak(this);
    } else if (e.inputType === "insertText" && typeof e.data === "string") {
      const sel = window.getSelection();
      const n = sel && sel.rangeCount ? sel.anchorNode : null;
      const inTextInsideBlock = n && n.nodeType === 3 && this.blockIndexOfNode(n) !== -1;
      if (!inTextInsideBlock && sel && sel.isCollapsed) {
        e.preventDefault();
        this._insertTextAtCaret(e.data);
        this._afterTextInput(e);
        return;
      }
      // Chromium can resolve the insertion against its own cached position
      // (getTargetRanges() pointed into the "$$" marker while the
      // live selection sat in the TeX span) — the character then lands
      // inside a marker and corrupts the source. When the cached target
      // disagrees with the live selection, take over.
      let cached = null;
      try {
        const ranges = e.getTargetRanges ? e.getTargetRanges() : [];
        cached = ranges[0] || null;
      } catch { /* no target ranges */ }
      if (cached && n && (cached.startContainer !== n || cached.startOffset !== sel.anchorOffset)) {
        e.preventDefault();
        this._insertTextAtCaret(e.data);
        this._afterTextInput(e);
        return;
      }
      this._nativeInputCaret = (this.selectionOffsets()?.start ?? this.globalIndexOfCaret()) + e.data.length;
    }
  }

  _afterTextInput(e) {
    if (this._composing || this._suppressInput || eventInCmBlock(this.root, e)) return;
    if (this._restoreNativeInputCaret && this._nativeInputCaret != null) this.selectOffsets(this._nativeInputCaret);
    this._restoreNativeInputCaret = false; this._nativeInputCaret = null;
    if (e.inputType === "insertText" || e.inputType === "insertReplacementText") this.applyTextReplacements();
    if (["insertText", "insertReplacementText", "insertCompositionText"].includes(e.inputType)) this.applySmartPunctuation();
    maybeEmojiPopup(this);
    this._updateCodeCompletion?.(true);
  }

  _syncSmartFocus() {
    if (!rendersSmartPunctuation(this.__settings)) {
      for (const element of this._smartFocused) element.classList.remove("md-smart-editing");
      this._smartFocused.clear(); return;
    }
    const selection = window.getSelection(), active = new Set();
    if (!this.readOnly && selection?.rangeCount && this.root.contains(document.activeElement)) {
      for (const node of [selection.anchorNode, selection.focusNode]) {
        const element = node?.nodeType === 3 ? node.parentElement : node;
        const smart = element?.closest?.(".md-smart");
        if (smart && this.root.contains(smart)) active.add(smart);
      }
    }
    for (const element of this._smartFocused || []) if (!active.has(element)) element.classList.remove("md-smart-editing");
    for (const element of active) element.classList.add("md-smart-editing");
    this._smartFocused = active;
  }

  _syncSimpleBlockFocus() {
    const selection = window.getSelection(), anchor = selection?.anchorNode;
    const element = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
    const focused = this.__settings?.autoExpandSimple !== false && !this.readOnly && this.root.contains(document.activeElement) ? element?.closest?.(".md-simple-empty") : null;
    if (this._simpleFocused && this._simpleFocused !== focused) this._simpleFocused.classList.remove("md-simple-focus");
    focused?.classList.add("md-simple-focus");
    this._simpleFocused = focused;
  }

  applySmartPunctuation() {
    if (this.readOnly || this._composing) return false;
    const selection = window.getSelection();
    if (!selection?.isCollapsed || !selection.rangeCount) return false;
    const node = selection.anchorNode, caret = selection.anchorOffset, bi = this.blockIndexOfNode(node);
    if (node?.nodeType !== 3 || bi < 0 || ["code", "math", "html", "frontmatter"].includes(this.blocks[bi]?.type)
      || node.parentElement.closest("code, a.url, .md-attr, .md-tex-src, .md-decor, .md-def-name, .md-def-marker")) return false;
    const change = punctuationInputEdit(node.data, caret, this.__settings);
    if (!change) return false;
    const offset = this.blockStart(bi) + caretOffsetInEl(this.root.children[bi], node, change.start);
    this.replaceRange(offset, offset + change.end - change.start, change.text, { inputType: "smartPunctuation" });
    return true;
  }

  // Model-side insertion used when the caret is NOT in a block's text node
  // (empty first block, escaped caret). Deterministic caret; the block
  // re-styles through the brush queue.
  _insertTextAtCaret(text) {
    if (this.blockIndexOfNode(window.getSelection()?.anchorNode) === -1) {
      this._normalizeCaret();
    }
    const ci = this.caretInfo();
    if (ci.blockIndex === -1) return;
    const src = this.blocks[ci.blockIndex].src || "";
    const newSrc = src.slice(0, ci.offset) + text + src.slice(ci.offset);
    const caret = ci.offset + text.length;
    const oldType = this.blocks[ci.blockIndex].type;
    let reparsed = parseBlocks(newSrc, { documentStart: ci.blockIndex === 0 && !this.blocks[0]._leading });
    if (!reparsed.length) reparsed.push({ type: "paragraph", src: newSrc, text: newSrc });
    reparsed = keepDefFootnote(oldType, reparsed, newSrc);
    if (oldType === "frontmatter" && (reparsed[0]?.type !== oldType || (this.blocks[ci.blockIndex].closed && !reparsed[0].closed && ci.blockIndex + 1 < this.blocks.length))) {
      const start = this.blockStart(ci.blockIndex);
      this.replaceRange(start, start + src.length, newSrc, { recordHistory: false, emit: false });
      this.selectOffsets(start + caret);
      this.pushHistory({ inputType: "insertText" }); this.emit();
      return;
    }
    inheritBlockLayout(this.blocks[ci.blockIndex], reparsed);
    if (reparsed.length === 1 && reparsed[0].type === oldType) {
      reparsed[0].__docBase = this.docBase;
      this._replaceBlock(ci.blockIndex, reparsed[0], caret);
      this._staleBrush.delete(ci.blockIndex);
    } else {
      const before = this.blocks.slice(0, ci.blockIndex);
      const after = this.blocks.slice(ci.blockIndex + 1);
      for (const b of [...reparsed, ...after]) b.__docBase = this.docBase;
      this.blocks = [...before, ...reparsed, ...after];
      this.renderAll();
      this.placeCaret(ci.blockIndex + (reparsed.length === 1 ? 0 : reparsed.length - 1), caret);
    }
    this.pushHistory({ inputType: "insertText" });
    this.emit();
  }

  // Deferred re-render of blocks whose source changed while typing (the
  // "brush" queue). Runs after a short typing pause so the caret's
  // text node is never destroyed mid-stroke; the caret is restored if the
  // focused block gets re-rendered.
  _brushSoon(bi) {
    this._staleBrush.add(bi);
    this._brushIdle = 0;
    if (this._brushTimer == null) {
      this._brushTimer = setTimeout(() => this._brushRun(), this._brushInterval);
    }
  }

  // Math blocks edit while the caret is inside them (our raw-block
  // semantics) — not only after a mouse click. Entering the block mounts
  // the CodeMirror panel (our mathBlock.startEditing); any other
  // focused math block steps out (downgrade + re-render on blur).
  _syncMathFocus(bi) {
    if (this.readOnly) return;
    const anchor = window.getSelection()?.anchorNode;
    for (const image of this.root.querySelectorAll(".md-image.md-source-focus")) if (!image.contains(anchor)) image.classList.remove("md-source-focus");
    const target = this.root.children[bi];
    // math elements always correspond to math blocks in the model
    if (this._source()?.math !== false) for (const c of this.root.querySelectorAll(":scope > .md-math-block")) {
      if (c === target) {
        if (!c.__cm) mathUpgrade(c, this, "end");
      } else if (c.__cm) {
        mathDowngrade(c, this);
      } else if (c.classList.contains("md-focus")) {
        c.classList.remove("md-focus");
        c.setAttribute("contenteditable", "false");
        this._brushSoon(this.blockIndexOfNode(c));
      }
    }
    const code = this.blocks[bi];
    const pre = this.root.children[bi];
    if (code?.type === "code" && code.src.includes("\n") && pre && !pre.__cm) fenceUpgrade(pre, this);
  }

  _brushRun() {
    // our brush queue: constant interval (200ms), skipped while
    // composing (isIME) or while the mouse is pressed. Ours also goes idle
    // after a few empty passes so host processes can exit when unused.
    // a mouseup can be lost (drag out of the window); treat a press older
    // than 3s as released so the queue cannot freeze forever
    if (this._mousePressed && Date.now() - (this._mousePressedAt || 0) > 3000) this._mousePressed = false;
    if (this._composing || this._mousePressed || document.activeElement?.matches?.(".md-lang-input")) {
      this._brushTimer = setTimeout(() => this._brushRun(), this._brushInterval);
      return;
    }
    // WebKit's NSTextInputClient may still be finishing an insertion after
    // the input event. Do not replace its text node during continuous typing.
    const settle = 80 - (performance.now() - (this._lastNativeInputAt ?? -Infinity));
    if (settle > 0 && this.root.contains(document.activeElement)) {
      this._brushTimer = setTimeout(() => this._brushRun(), Math.ceil(settle));
      return;
    }
    const stale = [...this._staleBrush].filter((bi) => bi < this.root.children.length);
    this._staleBrush.clear();
    if (stale.length) {
      this._brushPass(stale);
      this._brushIdle = 0;
    } else if (++this._brushIdle >= 5) {
      this._brushTimer = null;
      return;
    }
    this._brushTimer = setTimeout(() => this._brushRun(), this._brushInterval);
  }

  _brushPass(stale) {
    const ci = this.caretInfo();
    const selection = this.selectionOffsets();
    const ownsSelection = !!selection && this.root.contains(document.activeElement);
    const endpoint = (offset) => {
      const point = this.globalOffsetToBlock(offset);
      return { cid: this.root.children[point.index]?.dataset.cid, offset: point.offset, absolute: offset };
    };
    const endpoints = selection ? [endpoint(selection.start), endpoint(selection.end)] : null;
    this._suppressInput = true;
    for (const bi of stale) {
      const el = this.root.children[bi];
      if (el && el.__cm) continue; // CodeMirror owns this fence's DOM
      if (el && el.classList && el.classList.contains("md-focus")) continue; // focused math is being edited — re-render on blur
      this.blocks[bi]._cid ||= el.dataset.cid;
      const fresh = renderBlockInner(this.blocks[bi]);
      el.replaceWith(fresh);
    }
    this._suppressInput = false;
    // Keep both ends of a selection. A delayed brush must never collapse a
    // selection or steal focus from Find, a dialog, or the source editor.
    if (ownsSelection) {
      const offsetOf = (point) => {
        if (point.absolute === 0 || point.absolute === this.getMarkdown().length) return point.absolute;
        const index = this.blocks.findIndex((block) => block._cid === point.cid);
        return index < 0 ? point.absolute : this.blockStart(index) + Math.min(point.offset, this.blocks[index].src.length);
      };
      this.selectOffsets(offsetOf(endpoints[0]), offsetOf(endpoints[1]), selection.backward);
    }
    // the physical selection can survive as a detached node after
    // replaceWith — Chromium then redirects typing into a container-level
    // text node (stray "$$Z"). Re-place the caret whenever the anchor is
    // no longer inside the editor root.
    const sel = window.getSelection();
    if (ownsSelection && sel && sel.rangeCount && !this.root.contains(sel.anchorNode)) {
      this.placeCaret(ci.blockIndex, ci.offset);
    }
    refreshTocs(this);
    refreshFootnotes(this);
    refreshEquations(this);
  }

  handleInput(e) {
    if (this.readOnly) return;
    if (eventInCmBlock(this.root, e)) return; // CodeMirror owns this input
    if (this._suppressInput) return;
    this._lastNativeInputAt = performance.now();
    if (this._composing) {
      // composition owns the DOM right now; re-parse once on compositionend
      this._dirtyFromComposition = true;
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    const bi = this.blockIndexOfNode(node);
    if (bi === -1) {
      // input landed outside every block (stray top-level text/element):
      // rebuild the whole document from the live DOM instead of dropping it
      this._repairFromDom();
      return;
    }
    const el = this.root.children[bi];
    if (el && el.__cm) return; // CodeMirror owns this fence's DOM
    this._syncMathFocus(bi);
    const newSrc = blockSourceFromEl(el);
    const off = caretOffsetInEl(el, node, r.startOffset);
    const oldType = this.blocks[bi].type;
    if (oldType === "math" && this.blocks[bi].src.includes("\n")) {
      const block = this.blocks[bi];
      const prefix = block.src.indexOf("\n") + 1;
      const closingLength = block.closed ? block.src.length - block.src.lastIndexOf("\n") : 0;
      const input = mathInput(block, newSrc.slice(prefix, closingLength ? -closingLength : undefined));
      if (input.closedByInput) {
        finishMathBlock(el, this, input.source, input.tail);
        return;
      }
    }
    const hadFootnotes = oldType === "def_footnote" || this.blocks[bi].src.includes("[^");
    let reparsed = parseBlocks(newSrc, { documentStart: bi === 0 && !this.blocks[0]._leading });
    if (!reparsed.length) reparsed.push({ type: "paragraph", src: newSrc, text: newSrc });
    reparsed = keepDefFootnote(oldType, reparsed, newSrc);
    if (oldType === "frontmatter" && (reparsed[0]?.type !== oldType || (this.blocks[bi].closed && !reparsed[0].closed && bi + 1 < this.blocks.length))) {
      const start = this.blockStart(bi);
      this.replaceRange(start, start + this.blocks[bi].src.length, newSrc, { recordHistory: false, emit: false });
      this.selectOffsets(start + off);
      this.pushHistory({ inputType: e.inputType }); this.emit();
      return;
    }
    if ((oldType === "math" || oldType === "code") && !this.blocks[bi].closed && reparsed[0]?.type === oldType && reparsed[0].closed) {
      const closed = reparsed[0].src;
      const tail = newSrc.slice(closed.length).replace(/^\n/, "");
      finishMathBlock(el, this, closed, tail);
      return;
    }
    inheritBlockLayout(this.blocks[bi], reparsed);
    if (reparsed.length === 1 && reparsed[0].type === oldType) {
      // model-only update: keep the DOM (and the input-method anchor) as-is,
      // re-style this block later through the brush queue
      reparsed[0].__docBase = this.docBase;
      this.blocks[bi] = reparsed[0];
      // footnote numbering / back-links follow the model immediately (cheap,
      // idempotent); the block re-style itself waits for the brush
      if (hadFootnotes || newSrc.includes("[^")) refreshFootnotes(this);
      this._brushSoon(bi);
    } else {
      const target = bi + (reparsed.length === 1 ? 0 : reparsed.length - 1);
      if (reparsed.length === 1) {
        reparsed[0].__docBase = this.docBase;
        this._replaceBlock(bi, reparsed[0], off);
      } else {
        const before = this.blocks.slice(0, bi), after = this.blocks.slice(bi + 1);
        for (const b of [...reparsed, ...after]) b.__docBase = this.docBase;
        this.blocks = [...before, ...reparsed, ...after];
        this.renderAll();
        this.placeCaret(target, off);
      }
      // our autoSuggestCodeLang: typing a bare ``` inherits the last
      // used language, auto-inserted and selected for overtyping
      const fresh = reparsed.length === 1 && reparsed[0];
      if (fresh && fresh.type === "code" && !fresh.info && /^[`~]{3}$/.test(fresh.fence || "")) {
        const lang = newCodeLanguage(this.__settings, this._lastCodeLanguage);
        if (lang) {
          const fenceStr = fresh.fence || "```";
          const b2 = parseBlocks(fenceStr + lang)[0] || fresh;
          b2.__docBase = this.docBase;
          this._replaceBlock(target, b2, fenceStr.length + lang.length);
          this._staleBrush.delete(target);
          // select the language text inside the marker span
          const el = this.root.children[target];
          const markerEl = el && el.querySelector(":scope > .md-tag, :scope > .md-attr");
          const tnode = markerEl && [...markerEl.childNodes].find((n) => n.nodeType === 3 && n.data.includes(lang));
          if (tnode) {
            const start = tnode.data.indexOf(lang);
            const r = document.createRange();
            r.setStart(tnode, start);
            r.setEnd(tnode, start + lang.length);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          }
        }
      }
    }
    this.pushHistory(e);
    this.emit();
  }

  // Rebuild blocks from whatever the browser actually put into the DOM
  // (used when input escaped the block structure). Stray text adjacent to a
  // block merges INTO that block — typing must stay continuous, not shatter
  // into one-paragraph-per-character. The caret's position in the rebuilt
  // source is derived from its DOM text offset.
  _repairFromDom() {
    const sel = window.getSelection();
    const anchorNode = sel && sel.rangeCount ? sel.anchorNode : null;
    const anchorOffset = sel && sel.rangeCount ? sel.anchorOffset : 0;
    const kids = Array.from(this.root.childNodes);
    const isBlock = (k) => !!(k.nodeType === 1 && k.getAttribute && k.getAttribute("mdtype"));
    // CM-mounted blocks carry their source in the model (their DOM holds a
    // CodeMirror panel, excluded from text walks) — use the model src
    const cmSrc = new Map();
    let mi = -1;
    for (const k of kids) {
      if (isBlock(k)) {
        mi++;
        if (k.__cm) cmSrc.set(k, (this.blocks[mi] && this.blocks[mi].src != null) ? this.blocks[mi].src : blockSourceFromEl(k));
      }
    }
    const pieceOf = (k) => (isBlock(k) ? (cmSrc.has(k) ? cmSrc.get(k) : blockSourceFromEl(k)) : textOf(k));

    // group kids: a stray next to a block joins that block's chunk
    const groups = [];
    for (const k of kids) {
      if (isBlock(k)) {
        groups.push({ kids: [k], src: pieceOf(k) });
      } else {
        const t = pieceOf(k);
        const last = groups[groups.length - 1];
        if (last && last.blockAtEnd) {
          last.kids.push(k);
          last.src += t; // stray after a block → append to it
        } else {
          // stray before a block → becomes that block's prefix
          groups.push({ kids: [k], src: t, prefixOfNext: true });
        }
      }
      const last2 = groups[groups.length - 1];
      last2.blockAtEnd = isBlock(groups[groups.length - 1].kids[groups[groups.length - 1].kids.length - 1]);
    }
    // fold prefix groups into the block group that follows
    const chunks = [];
    for (const g of groups) {
      if (g.prefixOfNext) {
        g.mergedIntoNext = true;
        chunks.push({ kids: [], src: g.src, pendingPrefix: g.src, pendingKids: g.kids });
      } else if (chunks.length && chunks[chunks.length - 1].pendingPrefix != null) {
        const prev = chunks[chunks.length - 1];
        prev.src = prev.pendingPrefix + g.src;
        prev.kids = [...prev.pendingKids, ...g.kids];
        delete prev.pendingPrefix;
        delete prev.pendingKids;
      } else {
        chunks.push({ kids: [...g.kids], src: g.src });
      }
    }
    // trailing prefix chunk with no following block keeps its own chunk

    let src = "";
    let caret = -1;
    for (let ci = 0; ci < chunks.length; ci++) {
      const ch = chunks[ci];
      let local = 0;
      for (const k of ch.kids) {
        const piece = pieceOf(k);
        if (anchorNode && (anchorNode === k || (k.contains && k.contains(anchorNode)))) {
          local += Math.max(0, Math.min(domOffsetToText(k, anchorNode, anchorOffset), piece.length));
        } else {
          local += piece.length;
        }
      }
      if (anchorNode && ch.kids.some((k) => anchorNode === k || (k.contains && k.contains(anchorNode)))) {
        caret = src.length + Math.min(local, ch.src.length);
      }
      src += ch.src;
      if (ci < chunks.length - 1) src += "\n\n";
    }
    const gi = caret >= 0 ? caret : src.length;
    this.setText(src, { docBase: this.docBase, resetHistory: false });
    const pos = this.globalOffsetToBlock(gi);
    this.placeCaret(pos.index, pos.offset);
    this.pushHistory();
    this.emit();
  }

  // If the caret escaped the block structure after a click, snap it into the
  // block nearest the click (end of block when clicked at/below it, start
  // when clicked above it).
  _normalizeCaret() {
    if (this.readOnly) return;
    // Embedded editors own their caret; the outer DOM selection can be stale.
    if (document.activeElement?.matches("input, textarea, select, button")) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (!sel.isCollapsed) return;
    if (!this.root.contains(sel.anchorNode)) return;
    if (this.blockIndexOfNode(sel.anchorNode) !== -1) return;
    const blocks = Array.from(this.root.children).filter((c) => c.getAttribute && c.getAttribute("mdtype"));
    if (!blocks.length) return;
    let target = blocks.length - 1;
    let atEnd = true;
    if (sel.anchorNode === this.root) {
      // element-position at the container itself: snap by DOM offset
      // (deterministic; a collapsed range there has no reliable rect)
      const kids = Array.from(this.root.childNodes);
      const k = Math.min(sel.anchorOffset, kids.length);
      if (k <= 0) { target = 0; atEnd = false; }
      else {
        // the position sits between children; continue at the end of the
        // nearest block at or before it
        let bi = -1;
        for (let i = k - 1; i >= 0; i--) {
          if (kids[i].getAttribute && kids[i].getAttribute("mdtype")) { bi = blocks.indexOf(kids[i]); break; }
        }
        if (bi === -1) { target = 0; atEnd = false; }
        else { target = bi; atEnd = true; }
      }
    } else {
      // somewhere else outside the blocks (stray element): snap by geometry —
      // the selection rect first, a recent click second (a stale click point
      // must not win over keyboard moves), else by offset
      let y;
      const rect = sel.getRangeAt(0).getClientRects()[0];
      if (rect) y = rect.top;
      else if (this._lastMouseDown && Date.now() - (this._lastMouseDownAt || 0) < 600) y = this._lastMouseDown.y;
      else y = sel.anchorOffset === 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
      for (let i = 0; i < blocks.length; i++) {
        const brect = blocks[i].getBoundingClientRect();
        if (y < brect.top) { target = i; atEnd = false; break; }
        if (y <= brect.bottom) { target = i; atEnd = y > brect.top + brect.height / 2; break; }
      }
    }
    const idx = Array.from(this.root.children).indexOf(blocks[target]);
    this.placeCaret(idx, atEnd ? 99999 : 0);
  }

  _replaceBlock(index, block, caretOffset) {
    const hadFocus = this.root.contains(document.activeElement);
    this._suppressInput = true;
    const old = this.root.children[index];
    block._cid ||= old.dataset.cid;
    if (old.__cm) { try { old.__cm.toTextArea(); } catch { /* already detached */ } old.__cm = null; }
    const fresh = renderBlockInner(block);
    // math blocks keep (or gain) the editing state whenever the caret is
    // inside them — focus-follows-caret, not click-only
    if (caretOffset != null && fresh.classList && fresh.classList.contains("md-math-block") &&
        ((old.classList && old.classList.contains("md-focus")) || this.caretInfo().blockIndex === index)) {
      fresh.classList.add("md-focus");
      fresh.setAttribute("contenteditable", "true");
    }
    old.replaceWith(fresh);
    this.blocks[index] = block;
    this._suppressInput = false;
    if (caretOffset != null) {
      if (hadFocus && !this.root.contains(document.activeElement)) this.root.focus({ preventScroll: true });
      this.placeCaret(index, caretOffset);
      this._syncMathFocus(index);
    }
    refreshTocs(this);
    refreshFootnotes(this);
    refreshEquations(this);
    if (this.readOnly) this._applyReadOnly(fresh);
  }

  // footnote navigation: reference → definition, reverse link → Nth
  // reference (our jumpToFootnote / jumpToFootnoteDef)
  _handleEditorClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const equation = t.closest('a[href^="#md-equation-"]');
    if (equation) {
      e.preventDefault();
      const target = document.getElementById(equation.getAttribute("href").slice(1));
      if (target && this.root.contains(target)) {
        target.scrollIntoView?.({ block: "center", behavior: "smooth" });
        target.classList.add("blink-area");
        setTimeout(() => target.classList.remove("blink-area"), 2000);
      }
      return;
    }
    const link = t.closest("a.md-link, a.url");
    if (link) {
      e.preventDefault();
      if (this.readOnly || e.metaKey || e.ctrlKey) void window.__lettrine?.openLink?.(link.getAttribute("href") || "");
      return;
    }
    const rev = t.closest(".reversefootnote");
    if (rev) {
      e.preventDefault();
      const def = rev.closest(".md-def-footnote");
      const nameEl = def && def.querySelector(".md-def-name");
      const ref = nameEl ? (nameEl.textContent || "").trim().toLowerCase() : "";
      if (!ref) return;
      const k = parseInt(rev.getAttribute("data-index") || "0", 10);
      const sups = Array.from(this.root.querySelectorAll("sup.md-footnote")).filter(
        (s) => (s.getAttribute("data-ref") || "").trim() === ref,
      );
      const target = sups[k];
      if (target) this._jumpToNode(target);
      return;
    }
    const fn = t.closest("sup.md-footnote");
    if (fn) {
      e.preventDefault();
      const ref = (fn.getAttribute("data-ref") || "").trim();
      if (!ref) return;
      const bi = this.blocks.findIndex(
        (b) => b.type === "def_footnote" && b.ref && b.ref.trim().toLowerCase() === ref,
      );
      if (bi === -1) {
        this._footnoteHint(fn);
        return;
      }
      const defEl = this.root.children[bi];
      this._jumpToNode((defEl && defEl.querySelector(".md-def-name")) || defEl);
    }
  }

  // Right-click an image: Save Image As… / Copy All Images.
  _handleImageContext(e) {
    const wrap = e.target && e.target.closest ? e.target.closest(".md-image") : null;
    const diagram = e.target.closest?.(".md-diagram svg") || e.target.closest?.(".md-diagram")?.querySelector("svg");
    if (!wrap && !diagram) return; // let non-image right-clicks use the default menu
    e.preventDefault();
    const url = diagram ? "data:image/svg+xml," + encodeURIComponent(new window.XMLSerializer().serializeToString(diagram)) : wrap.getAttribute("data-url") || "";
    const local = resolveUrl(url, this.docBase);
    const isLocal = local && !/^(https?:|data:|blob:)/i.test(local);
    const isSVG = /^data:image\/svg\+xml/i.test(url) || /\.svg(?:[?#]|$)/i.test(url);
    const selectImage = () => {
      const index = this.blockIndexOfNode(wrap), block = this.root.children[index];
      if (index < 0) return;
      const start = this.blockStart(index) + domOffsetToText(block, wrap, 0);
      const end = this.blockStart(index) + domOffsetToText(block, wrap, wrap.childNodes.length);
      this.root.focus(); this.selectOffsets(start, end);
    };
    const run = (act) => async () => {
      try {
        if (act === "savesvg") {
          const result = await window.bridge.images.saveSVG({ url: isLocal ? local : url, docPath: this.docBase, suggestedName: "image.svg" });
          if (!result.canceled) this._notifyImageSaved(result.path);
        }
        if (act === "saveas") {
          const res = await window.bridge.images.saveAs({ url: isLocal ? local : url, docPath: this.docBase, suggestedName: /^data:/i.test(url) ? isSVG ? "image.svg" : "image.png" : decodeURIComponent(url.split("/").pop().split(/[?#]/)[0]) || "image.png" });
          if (res && !res.canceled && res.path) this._notifyImageSaved(res.path);
        }
        if (act === "reveal") await window.bridge.path.showInFinder({ path: decodeURIComponent(local.replace(/^lettrine:\/\/file/i, "").split(/[?#]/)[0]) });
        if (act === "open") {
          await window.bridge.images.open({ url, docPath: this.docBase });
        }
        if (["copy", "move", "delete"].includes(act)) await window.__lettrine?.manageImages(url, act);
        if (act === "copyall") {
          await window.__lettrine?.manageImages(null, "copy");
        }
        if (act === "moveall") await window.__lettrine?.manageImages(null, "move");
      } catch (error) {
        const translate = window.__lettrine?.i18nT || ((text) => text);
        this._notifyImageSaved(translate("Image operation failed:") + " " + translate(error.message || String(error)));
      }
    };
    // The interface presents this as a native context menu.
    window.__lettrineShowMenu?.([
      !diagram ? { label: "Open Image", run: run("open") } : null,
      !diagram ? { label: "Image Zoom", submenu: [25, 50, 75, 100, 125, 150, 200].map((zoom) => ({ label: zoom + "%", enabled: !this.readOnly, run: () => { selectImage(); formatImages(this, "html", zoom); } })) } : null,
      diagram ? { label: "Copy as Image…", run: () => window.__lettrine?.copyAsImage?.(diagram) } : null,
      { label: diagram ? "Save Diagram As…" : "Save Image As…", run: run("saveas") },
      isSVG ? { label: "Save Image as SVG…", run: run("savesvg") } : null,
      isLocal && !diagram ? { label: "Reveal in Finder", run: run("reveal") } : null,
      !diagram ? { label: "Copy Image File To…", enabled: !this.readOnly, run: run("copy") } : null,
      isLocal && !diagram ? { label: "Rename or Move Image File…", enabled: !this.readOnly, run: run("move") } : null,
      isLocal && !diagram ? { label: "Delete Image File…", enabled: !this.readOnly, run: run("delete") } : null,
      !diagram ? { label: "Use Markdown Image Syntax", enabled: !this.readOnly, run: () => { selectImage(); formatImages(this, "markdown"); } } : null,
      !diagram ? { label: "Use HTML Image Syntax", enabled: !this.readOnly, run: () => { selectImage(); formatImages(this, "html"); } } : null,
      { separator: true },
      { label: "Copy All Images To…", enabled: !this.readOnly, run: run("copyall") },
      { label: "Move All Images To…", enabled: !this.readOnly, run: run("moveall") },
    ], { x: e.clientX, y: e.clientY });
  }

  _notifyImageSaved(msg) {
    // lightweight toast reusing the notification bar
    if (window.__lettrineNotify) window.__lettrineNotify(msg);
    else if (typeof console !== "undefined") console.log("[lettrine]", msg);
  }

  _jumpToNode(node) {
    if (!node) return;
    const bi = this.blockIndexOfNode(node);
    if (bi === -1) return;
    const elB = this.root.children[bi];
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(true);
    const off = caretOffsetInEl(elB, r.startContainer, r.startOffset);
    this.placeCaret(bi, off, { scroll: true });
    node.classList.add("blink-area");
    setTimeout(() => node.classList.remove("blink-area"), 2000);
  }

  _footnoteHint(sup) {
    const ref = (sup.getAttribute("data-ref") || "").trim();
    const tip = document.createElement("div");
    tip.className = "md-fn-hint";
    tip.textContent = `Need to define the reference footnote [${ref}] with syntax [^${ref}]: ...`;
    (document.body || this.root.parentElement).appendChild(tip);
    const rect = sup.getBoundingClientRect();
    tip.style.left = rect.left + "px";
    tip.style.top = rect.bottom + 4 + "px";
    setTimeout(() => tip.remove(), 3000);
  }

  blockStart(index) {
    const state = this._source();
    if (state) {
      if (index <= 0) return state.starts[0];
      if (index < state.count) return state.starts[index];
      // past the end: the last block plus a default separator, as before
      return state.starts[state.count - 1] + state.sources[state.count - 1].length + 2;
    }
    let offset = (this.blocks[0]?._leading || "").length;
    for (let i = 0; i < Math.min(index, this.blocks.length); i++) offset += (this.blocks[i].src || "").length + blockSeparator(this.blocks, i + 1).length;
    return offset;
  }

  selectionOffsets() {
    const mounted = this._activeCmBlock();
    if (mounted) {
      const { cm, index } = mounted;
      const prefix = (this.blocks[index].src.indexOf("\n") + 1) || 2;
      const start = this.blockStart(index) + prefix + cm.indexFromPos(cm.getCursor("from"));
      const end = this.blockStart(index) + prefix + cm.indexFromPos(cm.getCursor("to"));
      const anchor = cm.indexFromPos(cm.getCursor("anchor"));
      const head = cm.indexFromPos(cm.getCursor("head"));
      return { start, end, backward: anchor > head };
    }
    const sel = window.getSelection();
    if (!sel?.rangeCount || !this.root.contains(sel.anchorNode) || !this.root.contains(sel.focusNode)) return null;
    const point = (node, offset, edge) => {
      if (node === this.root) return offset === 0 ? 0 : offset >= this.root.children.length ? this.getMarkdown().length : this.blockStart(offset);
      const index = this.blockIndexOfNode(node);
      if (index < 0) return this.globalIndexOfCaret();
      // The KaTeX preview has no source characters. A range selecting its
      // rendered glyphs selects the formula as one Markdown block.
      if (!sel.isCollapsed && this.blocks[index].type === "math" && closestOf(node, ".md-math-body")) {
        return this.blockStart(index) + (edge === "end" ? this.blocks[index].src.length : 0);
      }
      return this.blockStart(index) + caretOffsetInEl(this.root.children[index], node, offset);
    };
    const range = sel.getRangeAt(0);
    const start = point(range.startContainer, range.startOffset, "start");
    const end = point(range.endContainer, range.endOffset, "end");
    const backward = !sel.isCollapsed && (sel.anchorNode !== range.startContainer || sel.anchorOffset !== range.startOffset);
    return { start: Math.min(start, end), end: Math.max(start, end), backward };
  }

  selectAll() {
    this._cedeCmBlocks();
    this.root.focus({ preventScroll: true });
    this.selectOffsets(0, this.getMarkdown().length);
  }

  deleteSelection() {
    const selection = this.selectionOffsets();
    if (!selection || selection.start === selection.end) return false;
    this.replaceRange(selection.start, selection.end, "");
    this.root.focus({ preventScroll: true });
    this.selectOffsets(selection.start);
    return true;
  }

  selectOffsets(start, end = start, backward = false) {
    const a = this.globalOffsetToBlock(Math.max(0, start));
    const b = this.globalOffsetToBlock(Math.max(0, end));
    const opener = a.index === b.index && this.blocks[a.index]?.type === "code" && !this.blocks[a.index].src.includes("\n");
    // Start after the non-editable metadata caption: WebKit otherwise records
    // the range but does not paint it. The root end still includes final newlines.
    const from = start !== end && start === 0 && this.blocks[0].type !== "frontmatter"
      ? { node: this.root, offset: 0 } : positionInBlock(this.root.children[a.index], a.offset);
    const to = !opener && start !== end && end >= this.getMarkdown().length ? { node: this.root, offset: this.root.childNodes.length } : positionInBlock(this.root.children[b.index], b.offset);
    const sel = window.getSelection();
    if (sel.setBaseAndExtent) {
      if (backward) sel.setBaseAndExtent(to.node, to.offset, from.node, from.offset);
      else sel.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    } else {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this._syncSimpleBlockFocus();
  }

  replaceRange(start, end, text, opts = {}) {
    if (this.guardReadOnly()) return;
    this.checkpointSelection();
    const source = this.getMarkdown();
    const inserted = String(text).replace(/\r\n?/g, "\n");
    const next = source.slice(0, start) + inserted + source.slice(end);
    this.setText(next, { docBase: this.docBase, resetHistory: false });
    this.selectOffsets(start + inserted.length);
    if (opts.recordHistory !== false) this.pushHistory(opts);
    if (opts.emit !== false) this.emit();
  }

  replaceSelection(text, opts = {}) {
    const range = this.selectionOffsets();
    const caret = this.globalIndexOfCaret();
    this.replaceRange(range?.start ?? caret, range?.end ?? caret, text, opts);
  }

  checkpointSelection() {
    // A dialog button can make WebKit normalize the retained DOM selection
    // into the first editable block. Capture before leaving the editor and
    // never overwrite that history caret with a modal's incidental selection.
    if (!this.root.contains(document.activeElement)) return;
    const current = this._history[this._history.length - 1];
    const selection = this.selectionOffsets();
    if (current && this._historyText === this.getMarkdown() && selection) {
      if (current.selection.start !== selection.start || current.selection.end !== selection.end) this._historyBoundary = true;
      current.selection = selection;
    }
  }

  pushHistory(e = {}) {
    const text = this.getMarkdown();
    const last = this._history[this._history.length - 1];
    const selection = this.selectionOffsets() || { start: this.globalIndexOfCaret(), end: this.globalIndexOfCaret() };
    if (last && this._historyText === text) {
      last.selection = selection;
      return;
    }
    const now = Date.now();
    const group = /^(insertText|deleteContentBackward|deleteContentForward)$/.test(e.inputType || "") ? e.inputType : null;
    const canGroup = group && group === this._historyGroup && now - this._lastPush < 600 && !this._future.length && this._history.length > 1 && !this._historyBoundary;
    // Undo entries point backwards; moving an entry to redo inverts it.
    // Each stack retains only the text needed in its own direction.
    const before = canGroup ? applyTextChange(this._historyText, last.change) : this._historyText;
    const state = { change: textChange(text, before), textLength: text.length, selection };
    if (canGroup) this._history[this._history.length - 1] = state;
    else this._history.push(state);
    if (this._history.length > 201) {
      this._history.shift();
      delete this._history[0].change;
    }
    this._historyText = text;
    this._lastPush = now;
    this._historyGroup = group;
    this._historyBoundary = false;
    this._future = [];
  }

  _restoreHistory(state) {
    this.setText(this._historyText, { docBase: this.docBase, resetHistory: false });
    this.root.focus({ preventScroll: true });
    this.selectOffsets(state.selection.start, state.selection.end, state.selection.backward);
    const point = this.globalOffsetToBlock(state.selection.start);
    const block = this.blocks[point.index];
    if (block.type === "math" || block.type === "code") {
      const body = block.type === "math" ? block.tex || "" : block.body || "";
      const prefix = block.src.indexOf("\n") + 1;
      const position = (offset) => {
        const preceding = body.slice(0, Math.max(0, offset - this.blockStart(point.index) - prefix)).split("\n");
        return { line: preceding.length - 1, ch: preceding.at(-1).length };
      };
      const from = position(state.selection.start);
      const to = position(state.selection.end);
      const cursor = { anchor: state.selection.backward ? to : from, head: state.selection.backward ? from : to };
      if (block.type === "math") mathUpgrade(this.root.children[point.index], this, "auto", cursor);
      else fenceUpgrade(this.root.children[point.index], this, cursor);
    }
    this._lastPush = 0;
    this._historyGroup = null;
    this.emit();
  }

  _activeCmBlock() {
    const element = document.activeElement?.closest?.("[mdtype='fences'], [mdtype='math_block']");
    if (!element?.__cm || !this.root.contains(element)) return null;
    if (!document.activeElement.closest(".CodeMirror")) return null;
    const index = element.dataset.cid ? this.blocks.findIndex((block) => block._cid === element.dataset.cid) : -1;
    return { element, cm: element.__cm, index: index >= 0 ? index : this.blockIndexOfNode(element) };
  }

  undo() {
    if (this.guardReadOnly()) return;
    if (this._history.length < 2) return;
    const current = this._history.pop();
    const change = current.change;
    current.change = invertTextChange(this._historyText, change);
    this._historyText = applyTextChange(this._historyText, change);
    this._future.push(current);
    this._restoreHistory(this._history[this._history.length - 1]);
  }

  redo() {
    if (this.guardReadOnly()) return;
    if (!this._future.length) return;
    const next = this._future.pop();
    const change = next.change;
    next.change = invertTextChange(this._historyText, change);
    this._historyText = applyTextChange(this._historyText, change);
    this._history.push(next);
    this._restoreHistory(next);
  }

  globalIndexOfCaret() {
    const ci = this.caretInfo();
    if (ci.blockIndex === -1) return 0;
    return this.blockStart(ci.blockIndex) + ci.offset;
  }

  // Text replacements: after typing, if the text before the caret
  // ends with a user replacement key, expand it in place. Longest key wins.
  applyTextReplacements() {
    const reps = this._textReplacements;
    if (!reps) return false;
    const keys = Object.keys(reps);
    if (!keys.length) return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const md = this.getMarkdown();
    const gi = this.globalIndexOfCaret();
    let best = null;
    for (const k of keys) {
      if (!k) continue;
      if (gi >= k.length && md.slice(gi - k.length, gi) === k) {
        if (!best || k.length > best.length) best = k;
      }
    }
    if (!best) return false;
    const value = reps[best];
    const newMd = md.slice(0, gi - best.length) + value + md.slice(gi);
    this._suppressInput = true;
    this.setText(newMd, { docBase: this.docBase, resetHistory: false });
    const pos = this.globalOffsetToBlock(gi - best.length + value.length);
    this.placeCaret(pos.index, pos.offset, { scroll: true });
    this._suppressInput = false;
    this.pushHistory();
    this.emit();
    return true;
  }

  // Jump the caret to a 1-based line number of the reconstructed source
  // (file-search result lines). Line counting walks the block sources joined
  // by the same blank line the markdown uses between blocks.
  gotoLine(lineNo) {
    const lines = this.getMarkdown().split("\n");
    const target = Math.max(1, Math.floor(lineNo || 1));
    const offset = lines.slice(0, target - 1).reduce((sum, line) => sum + line.length + 1, 0);
    const pos = this.globalOffsetToBlock(offset);
    this.placeCaret(pos.index, pos.offset, { scroll: true });
    return target <= lines.length;
  }

  emit() {
    refreshEquations(this);
    this.onChange(this);
    const ci = this.caretInfo();
    this.onCaret(ci);
  }

  focus() {
    this.root.focus();
    if (this.blocks.length === 0) this.setText("", { docBase: this.docBase });
    const last = this.blocks.length - 1;
    if (last >= 0) this.placeCaret(last, (this.blocks[last].src || "").length);
  }
}
