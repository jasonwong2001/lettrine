// Lettrine editor ops — formatting commands (menu/shortcut driven).
// All ops are source-level: they edit the block markdown, re-render, and
// restore the selection. This keeps the DOM and source consistent.

import { parseBlocks, listSrcFromItems, inheritBlockLayout } from "../core/blocks.js";
import { emojiMatches, completeEmoji } from "../core/emoji.js";
import { caretOffsetInEl, blockSourceFromEl } from "./editor.js";
import { editTableRow } from "../core/table.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { parseInline } from "../core/inline.js";
import { linkMarkdown } from "../core/links.js";
import { linkDialog } from "./link-dialog.js";
import { ALERT_LABELS } from "../core/alerts.js";
import { newCodeLanguage } from "../core/code-tools.js";

function currentBlock(editor) {
  if (editor.guardReadOnly()) return null;
  editor.checkpointSelection();
  const ci = editor.caretInfo();
  if (ci.blockIndex === -1) return null;
  return { block: editor.blocks[ci.blockIndex], index: ci.blockIndex, offset: ci.offset };
}

function selectionRange(editor) {
  const range = editor.selectionOffsets();
  if (!range || range.start === range.end) return null;
  const start = editor.globalOffsetToBlock(range.start);
  const end = editor.globalOffsetToBlock(range.end);
  if (start.index !== end.index) return null;
  return { index: start.index, start: start.offset, end: end.offset };
}

function replace(editor, index, newBlock, selStart, selEnd) {
  inheritBlockLayout(editor.blocks[index], [newBlock]);
  newBlock.__docBase = editor.docBase;
  editor._replaceBlock(index, newBlock, null);
  editor.placeCaret(index, selEnd ?? selStart, { anchor: selStart, scroll: true });
  editor.pushHistory();
  editor.emit();
}

function singleBlock(newSrc) {
  const blocks = parseBlocks(newSrc);
  return blocks[0] || { type: "paragraph", src: "", text: "" };
}

// ---------------------------------------------------------------------------
// inline wraps
// ---------------------------------------------------------------------------

function wrapBlock(editor, marker, closing = marker, transform) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block, offset } = cur;
  const range = selectionRange(editor);
  let s, e;
  if (range && range.index === cur.index && range.end > range.start) {
    s = range.start;
    e = range.end;
  } else {
    s = e = offset;
  }
  const src = block.src || "";
  const inner = src.slice(s, e);
  if (transform && inner.includes("\n")) return;
  if (s >= marker.length && src.slice(s - marker.length, s).toLowerCase() === marker && src.slice(e, e + closing.length).toLowerCase() === closing) {
    const decoded = transform ? transform(inner, false) : inner;
    const newSrc = src.slice(0, s - marker.length) + decoded + src.slice(e + closing.length);
    replace(editor, cur.index, singleBlock(newSrc), s - marker.length, s - marker.length + decoded.length);
    return;
  }
  // toggle: if the selection is already wrapped, unwrap
  if (inner.toLowerCase().startsWith(marker) && inner.toLowerCase().endsWith(closing) && inner.length >= marker.length + closing.length) {
    const content = inner.slice(marker.length, inner.length - closing.length);
    const decoded = transform ? transform(content, false) : content;
    const newSrc = src.slice(0, s) + decoded + src.slice(e);
    const nb = singleBlock(newSrc);
    replace(editor, cur.index, nb, s, s + decoded.length);
    return;
  }
  const encoded = transform ? transform(inner, true) : inner;
  const newSrc = src.slice(0, s) + marker + encoded + closing + src.slice(e);
  const nb = singleBlock(newSrc);
  replace(editor, cur.index, nb, s + marker.length, s + marker.length + encoded.length);
}

export function formatBold(editor) { wrapBlock(editor, "**"); }
export function formatItalic(editor) { wrapBlock(editor, "*"); }
export function formatStrike(editor) { wrapBlock(editor, "~~"); }
export function formatHighlight(editor) { wrapBlock(editor, "=="); }
export function formatCode(editor) { wrapBlock(editor, "`"); }
export function formatUnderline(editor) { wrapBlock(editor, "<u>", "</u>"); }
function scriptSpaces(source, encode) {
  return parseInline(source, { subscriptSuperscript: true, _script: true }).map((part) => {
    if (part.type === "text") return encode ? part.src.replace(/[ \t]/g, "\\$&") : part.src;
    if (part.type === "escape" && /[ \t]/.test(part.char)) return encode ? part.src : part.char;
    if (["bold", "italic", "strike", "highlight", "underline", "subscript", "superscript"].includes(part.type)) {
      const start = part.open?.length || part.marker.length;
      return part.src.slice(0, start) + scriptSpaces(part.inner, encode) + part.src.slice(start + part.inner.length);
    }
    return part.src;
  }).join("");
}
function formatScript(editor, marker, tag) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const selection = window.getSelection();
  const parent = (node) => (node?.nodeType === 3 ? node.parentElement : node)?.closest?.(tag);
  const scope = parent(selection?.anchorNode);
  if (scope && scope === parent(selection?.focusNode) && editor.root.contains(scope)) {
    const source = blockSourceFromEl(scope), part = parseInline(source, editor.__settings)[0];
    if (part?.type === (tag === "sub" ? "subscript" : "superscript")) {
      const start = editor.blockStart(cur.index) + caretOffsetInEl(editor.root.children[cur.index], scope, 0);
      const inner = part.marker ? scriptSpaces(part.inner, false) : part.inner;
      editor.replaceRange(start, start + source.length, inner);
      editor.selectOffsets(start, start + inner.length);
      return;
    }
  }
  const range = selectionRange(editor), s = range?.start ?? cur.offset, e = range?.end ?? cur.offset;
  const src = cur.block.src, inner = src.slice(s, e), open = "<" + tag + ">", close = "</" + tag + ">";
  const wrapped = src[s - 1] === marker && src[s - 2] !== marker && src[e] === marker && src[e + 1] !== marker
    || inner.startsWith(marker) && !inner.startsWith(marker + marker) && inner.endsWith(marker) && !inner.endsWith(marker + marker);
  const html = src.slice(s - open.length, s).toLowerCase() === open && src.slice(e, e + close.length).toLowerCase() === close
    || inner.toLowerCase().startsWith(open) && inner.toLowerCase().endsWith(close);
  const ambiguous = !wrapped && (src[s - 1] === marker || src[e] === marker || inner.startsWith(marker) || inner.endsWith(marker));
  if (html || ambiguous) wrapBlock(editor, open, close);
  else wrapBlock(editor, marker, marker, scriptSpaces);
}
export function formatSubscript(editor) { formatScript(editor, "~", "sub"); }
export function formatSuperscript(editor) { formatScript(editor, "^", "sup"); }

export async function formatLink(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const source = editor.getMarkdown();
  const generation = editor._generation;
  const range = editor.selectionOffsets() || { start: editor.globalIndexOfCaret(), end: editor.globalIndexOfCaret() };
  const selection = window.getSelection();
  const node = selection?.anchorNode?.nodeType === 3 ? selection.anchorNode.parentElement : selection?.anchorNode;
  const anchor = node?.closest?.("a.md-link");
  let existing;
  if (anchor) {
    const raw = blockSourceFromEl(anchor);
    existing = parseInline(raw)[0];
    range.start = editor.blockStart(cur.index) + caretOffsetInEl(editor.root.children[cur.index], anchor, 0);
    range.end = range.start + raw.length;
  }
  const selected = source.slice(range.start, range.end);
  const result = await linkDialog({ text: existing?.inner || selected, url: existing?.url || "", title: existing?.title || "", editing: !!existing });
  editor.root.focus({ preventScroll: true });
  if (editor._generation !== generation || editor.getMarkdown() !== source) return;
  if (!result) { editor.selectOffsets(range.start, range.end); return; }
  if (result.remove) editor.replaceRange(range.start, range.end, existing.inner);
  else {
    const link = linkMarkdown(result.text || result.url, result.url, result.title);
    editor.replaceRange(range.start, range.end, link.source);
    editor.selectOffsets(range.start + 1, range.start + 1 + link.labelLength);
  }
}

export function formatMath(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block, offset } = cur;
  const range = selectionRange(editor);
  let s, e;
  if (range && range.index === cur.index && range.end > range.start) { s = range.start; e = range.end; }
  else { s = e = offset; }
  const src = block.src || "";
  const inner = src.slice(s, e) || "E = mc^2";
  const ins = `$${inner}$`;
  const newSrc = src.slice(0, s) + ins + src.slice(e);
  const nb = singleBlock(newSrc);
  replace(editor, cur.index, nb, s + 1, s + 1 + inner.length);
}

// ---------------------------------------------------------------------------
// headings
// ---------------------------------------------------------------------------

function headingFromText(level, text) {
  return { type: "heading", level, text, src: "#".repeat(level) + (text ? " " + text : "") };
}

export function setHeading(editor, level) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block, offset } = cur;
  let text = "";
  if (block.type === "heading") text = block.text;
  else if (block.type === "paragraph") text = block.src;
  else return;
  replace(editor, cur.index, headingFromText(level, text), Math.min(2, offset));
}

export function headingUp(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  if (cur.block.type === "heading") setHeading(editor, Math.max(1, cur.block.level - 1));
  else setHeading(editor, 1);
}

export function headingDown(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  if (cur.block.type === "heading") setHeading(editor, Math.min(6, cur.block.level + 1));
  else setHeading(editor, 6);
}

// ---------------------------------------------------------------------------
// block inserts / toggles
// ---------------------------------------------------------------------------

export function insertBlockAfter(editor, block, caretOffset = 0) {
  if (editor.guardReadOnly()) return;
  const cur = currentBlock(editor) || { index: editor.blocks.length - 1, block: null, offset: 0 };
  const before = editor.blocks.slice(0, cur.index + 1);
  const after = editor.blocks.slice(cur.index + 1);
  block.__docBase = editor.docBase;
  editor.blocks = [...before, block, ...after];
  editor.renderAll();
  editor.placeCaret(cur.index + 1, caretOffset, { scroll: true });
  editor.pushHistory();
  editor.emit();
}

export function insertHr(editor) {
  insertBlockAfter(editor, { type: "hr", src: "---" });
}

export function insertTOC(editor) {
  insertBlockAfter(editor, singleBlock("[TOC]"));
}

export function insertCodeBlock(editor) {
  const language = newCodeLanguage(editor.__settings, editor._lastCodeLanguage);
  insertBlockAfter(editor, singleBlock("```" + language + "\n```\n"), 4 + language.length);
}

export function insertQuote(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const text = cur.block.type === "paragraph" ? cur.block.src : "quote";
  const item = { type: "paragraph", src: text, text };
  replace(editor, cur.index, { type: "quote", items: [item], src: "> " + text }, 2);
}

export function insertTable(editor, cols = 3, rowsCount = 4) {
  const headers = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  const rows = Array.from({ length: Math.max(0, rowsCount - 1) }, () => headers.map(() => ""));
  const rowSrc = (cells) => `| ${cells.join(" | ")} |`;
  const src = [rowSrc(headers), "| " + headers.map(() => "---").join(" | ") + " |", ...rows.map(rowSrc)].join("\n");
  const block = {
    type: "table",
    src,
    headers,
    headerLine: rowSrc(headers),
    sepLine: "| " + headers.map(() => "---").join(" | ") + " |",
    rows,
    lead: "|",
    trail: "|",
    rowSrc,
  };
  insertBlockAfter(editor, block, 3);
}

export function tableAddRow(editor, above = false) {
  const cur = currentBlock(editor);
  if (!cur || cur.block.type !== "table") return;
  const result = editTableRow(cur.block, cur.offset, above ? "above" : "below");
  if (result) replace(editor, cur.index, parseBlocks(result.source)[0], result.offset);
}

export function moveTableRow(editor, direction) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const result = editTableRow(cur.block, cur.offset, direction < 0 ? "up" : "down");
  if (result) replace(editor, cur.index, parseBlocks(result.source)[0], result.offset);
}

export function toggleTask(editor) {
  const cur = currentBlock(editor);
  if (!cur || cur.block.type !== "list") return;
  const block = cur.block;
  const findItem = (items, offset) => {
    let acc = 0;
    for (const it of items) {
      const taskPart = it.task ? 4 : 0;
      const len = it.marker.length + 1 + taskPart + (it.text ? it.text.length + 1 : 0);
      if (offset <= acc + len) return it;
      acc += len + 1;
      if (it.children.length) {
        const r = findItem(it.children, offset - acc - 1);
        if (r) return r;
      }
    }
    return null;
  };
  const item = findItem(block.items, cur.offset);
  if (!item) return;
  if (!item.task) item.task = { checked: false };
  else if (item.text) item.task = { checked: !item.task.checked };
  else item.task = null;
  const updated = { ...block, items: block.items, src: listSrcFromItems(block.items) };
  replace(editor, cur.index, updated, cur.offset);
}

// ---------------------------------------------------------------------------
// emoji completion
// ---------------------------------------------------------------------------

let emojiState = null;
export function maybeEmojiPopup(editor) {
  if (editor._composing || editor._activeCmBlock()) { window.__hideEmoji?.(); return; }
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!selection?.isCollapsed || !selection.rangeCount || node?.nodeType !== 3 || !editor.root.contains(node)) { window.__hideEmoji?.(); return; }
  const source = editor.getMarkdown(), end = editor.globalIndexOfCaret();
  const match = /:([a-z0-9_+-]{2,32})$/i.exec(source.slice(0, end));
  if (!match) { window.__hideEmoji?.(); return; }
  const matches = emojiMatches(match[1], 8).map((token) => ({ token, char: completeEmoji(token.slice(1, -1)) })).filter((item) => item.char);
  const popup = document.getElementById("emoji-completion");
  if (!popup || !matches.length) { window.__hideEmoji?.(); return; }
  const start = end - match[0].length;
  if (source.slice(start, end) !== match[0] || (source.slice(0, start).match(/\\+$/)?.[0].length || 0) % 2) { window.__hideEmoji?.(); return; }
  const state = { editor, source, generation: editor._generation, start, end, matches, index: 0 };
  emojiState = state; popup.replaceChildren();
  const apply = () => {
    const point = editor.selectionOffsets();
    if (emojiState !== state || editor._generation !== state.generation || editor.getMarkdown() !== source || point?.start !== end || point?.end !== end) { window.__hideEmoji?.(); return; }
    const character = matches[state.index].char;
    window.__hideEmoji?.(); editor.root.focus({ preventScroll: true });
    editor.replaceRange(start, end, character + " ");
  };
  matches.forEach((item, index) => {
    const cell = document.createElement("div"); cell.className = "emoji-item" + (index === 0 ? " active" : "");
    cell.setAttribute("role", "option"); cell.setAttribute("aria-selected", String(index === 0)); cell.textContent = item.char + "  " + item.token;
    cell.addEventListener("mousedown", (event) => { event.preventDefault(); state.index = index; apply(); });
    popup.appendChild(cell);
  });
  const rect = selection.getRangeAt(0).getBoundingClientRect?.() || { left: 0, bottom: 0 };
  popup.style.left = Math.max(8, Math.min(window.innerWidth - 240, rect.left - 70)) + "px";
  popup.style.top = Math.max(8, Math.min(window.innerHeight - 180, rect.bottom + 6)) + "px";
  popup.setAttribute("role", "listbox"); popup.classList.add("active");
  window.__emojiPopupOpen = true; window.__emojiOwner = editor; window.__confirmEmoji = apply;
  window.__moveEmoji = (direction) => {
    if (emojiState !== state) return;
    state.index = (state.index + direction + matches.length) % matches.length;
    [...popup.children].forEach((cell, index) => { cell.classList.toggle("active", index === state.index); cell.setAttribute("aria-selected", String(index === state.index)); });
  };
  window.__hideEmoji = () => { popup.classList.remove("active"); emojiState = null; window.__emojiPopupOpen = false; window.__emojiOwner = null; window.__confirmEmoji = null; };
}

async function pasteImage(editor) {
  const generation = editor._generation;
  const snapshot = editor.getMarkdown();
  const range = editor.selectionOffsets() || { start: editor.globalIndexOfCaret(), end: editor.globalIndexOfCaret() };
  const setImg = await window.bridge.setting.get({ key: "__patch" });
  if (editor.guardReadOnly()) return;
  // Preferences → Image → Paste Image Into (./assets | ./ | inline)
  const insertDir = (setImg && setImg.imageInsertDir) || "./assets";
  const res = await window.bridge.clipboard.readImage();
  if (editor.guardReadOnly()) return;
  if (!res || !res.ok) return;
  let ref;
  if ((insertDir === "inline" || !editor.docBase) && !setImg?.imageUploadOnPaste) {
    // keep inline as a data URI
    ref = `data:image/png;base64,${res.png}`;
  } else {
    const saved = await window.bridge.images.import({
      docPath: editor.docBase,
      name: `paste-${Date.now()}.png`,
      data: res.png,
      upload: true,
    });
    ref = saved.reference;
    if (saved.uploadError) window.__lettrineNotify?.((window.__lettrine?.i18nT?.("Image upload failed; the local image was kept.") || "Image upload failed; the local image was kept.") + " " + (window.__lettrine?.i18nT?.(saved.uploadError) || saved.uploadError));
  }
  if (editor.readOnly || editor._generation !== generation || editor.getMarkdown() !== snapshot) {
    window.__lettrineNotify?.("The document changed while preparing the image. Paste it again at the new position.");
    return;
  }
  const ins = "!" + linkMarkdown("", ref).source;
  editor.replaceRange(range.start, range.end, ins);
}

function pathJoin(a, b) {
  if (!a) return b;
  return a.replace(/\/+$/, "") + "/" + b;
}
function pathBasename(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

// ---------------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------------

export function handlePaste(editor, e) {
  if (editor.guardReadOnly()) { e.preventDefault(); return; }
  // a CodeMirror-mounted block (fence or math) handles its own pastes
  const t = e.target;
  if (t && t.closest && t.closest("[mdtype='fences'], [mdtype='math_block']")?.__cm) return;
  const cur = currentBlock(editor);
  if (!cur) return;
  // image paste → save into the document's img folder and insert a reference
  const items = e.clipboardData && e.clipboardData.items;
  const hasImage = items && Array.from(items).some((it) => it.type && it.type.startsWith("image/"));
  if (hasImage) {
    e.preventDefault();
    return pasteImage(editor).catch((err) => window.__lettrineNotify?.("Image paste failed: " + (err?.message || err)));
  }
  const text = e.clipboardData?.getData("text/plain");
  if (typeof text !== "string") return;
  e.preventDefault();
  const html = !editor._pastePlainOnce && e.clipboardData?.getData("text/html");
  editor.replaceSelection(html ? htmlToMarkdown(html, document, editor.__settings) || text : text);
}

// ---------------------------------------------------------------------------
// "Paragraph" menu ops (block toggles) — ⌥⌘B/C/Q/O/U/T family
// ---------------------------------------------------------------------------

export function toggleList(editor, ordered) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block, offset } = cur;
  if (block.type === "list") {
    // remove list: flatten items to paragraphs
    const flat = [];
    const walk = (items, d) => {
      for (const it of items) {
        const t = (it.text || "").trim();
        if (t) flat.push({ type: "paragraph", src: t, text: t });
        if (it.children.length) walk(it.children, d + 1);
      }
    };
    walk(block.items, 0);
    const before = editor.blocks.slice(0, cur.index);
    const after = editor.blocks.slice(cur.index + 1);
    editor.blocks = [...before, ...flat, ...after];
    editor.renderAll();
    editor.placeCaret(cur.index, (flat[0] ? flat[0].src : "").length, { scroll: true });
    editor.pushHistory();
    editor.emit();
    return;
  }
  const text = block.type === "paragraph" ? block.src : "";
  if (!text.trim()) return;
  const items = [{ marker: ordered ? "1." : "-", ordered, text, task: null, indent: 0, children: [] }];
  const nb = { type: "list", ordered, items, src: listSrcFromItems(items) };
  replace(editor, cur.index, nb, 2);
}

export function toggleQuote(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block } = cur;
  if (block.type === "quote") {
    const flat = block.items.map((b) => ({ ...b, src: b.src || "" }));
    const before = editor.blocks.slice(0, cur.index);
    const after = editor.blocks.slice(cur.index + 1);
    editor.blocks = [...before, ...flat, ...after];
    editor.renderAll();
    editor.placeCaret(cur.index, (flat[0] ? flat[0].src : "").length, { scroll: true });
    editor.pushHistory();
    editor.emit();
    return;
  }
  const text = block.type === "paragraph" ? block.src : "quote";
  if (!text.trim()) return;
  const item = { type: "paragraph", src: text, text };
  replace(editor, cur.index, { type: "quote", items: [item], src: "> " + text }, 2);
}

export function setAlert(editor, type) {
  if (!Object.hasOwn(ALERT_LABELS, type)) return;
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block, offset } = cur;
  let source, caret;
  const marker = "[!" + type.toUpperCase() + "]";
  if (block.type === "quote") {
    const existing = /^(\s{0,3}>[ \t]{0,2})\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?=[ \t\n]|$)/i.exec(block.src);
    if (existing) {
      source = block.src.slice(0, existing[1].length) + marker + block.src.slice(existing[0].length);
      caret = offset >= existing[0].length ? offset + existing[1].length + marker.length - existing[0].length : existing[1].length + marker.length;
    } else {
      source = "> " + marker + "\n" + block.src;
      caret = offset + marker.length + 3;
    }
  } else {
    const prefix = "> " + marker + "\n";
    source = prefix + (block.src || "").split("\n").map((line) => "> " + line).join("\n");
    caret = prefix.length + offset + 2 * ((block.src || "").slice(0, offset).split("\n").length);
  }
  if (source === block.src) return;
  if (block.type === "quote") { replace(editor, cur.index, singleBlock(source), caret); return; }
  const start = editor.blockStart(cur.index), next = editor.blocks[cur.index + 1];
  const before = cur.index && !(block._before ?? "\n\n").includes("\n\n") ? "\n" : "";
  const after = next && !(next._before ?? "\n\n").includes("\n\n") ? "\n" : "";
  editor.replaceRange(start, start + block.src.length, before + source + after, { recordHistory: false, emit: false });
  editor.selectOffsets(start + before.length + caret);
  editor.pushHistory(); editor.emit();
}

export function toggleCodeFence(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block } = cur;
  if (block.type === "code") {
    const body = (block.body || "").replace(/\n+$/, "");
    const nb = { type: "paragraph", src: body, text: body };
    replace(editor, cur.index, nb, 0);
    return;
  }
  if (block.type === "paragraph") {
    const body = block.src;
    const language = newCodeLanguage(editor.__settings, editor._lastCodeLanguage);
    const source = "```" + language + "\n" + body + "\n```";
    replace(editor, cur.index, singleBlock(source), 4 + language.length);
    return;
  }
}

export function toggleMathBlock(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const { block } = cur;
  if (block.type === "math") {
    const nb = { type: "paragraph", src: block.tex || "", text: block.tex || "" };
    replace(editor, cur.index, nb, 0);
    return;
  }
  if (block.type === "paragraph") {
    const tex = block.src;
    const nb = { type: "math", tex, closed: true, src: "$$\n" + tex + "\n$$" };
    replace(editor, cur.index, nb, 3 + tex.length);
    return;
  }
}

export function toggleTaskStatus(editor) {
  return toggleTask(editor);
}

// ---------------------------------------------------------------------------
// selection ops — ⌘D / ⌘L / ⌘E / ⌘J / ⌘⇧D
// ---------------------------------------------------------------------------

export function deleteRow(editor) {
  // ⌘⇧⌫: delete the table row containing the caret
  const cur = currentBlock(editor);
  if (!cur || cur.block.type !== "table") return;
  const result = editTableRow(cur.block, cur.offset, "delete");
  if (result) replace(editor, cur.index, parseBlocks(result.source)[0], result.offset);
}

export function jumpToSelection(editor) {
  // ⌘J: move caret to the selection
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const r = sel.getRangeAt(0);
  const node = r.startContainer;
  const bi = editor.blockIndexOfNode(node);
  if (bi === -1) return;
  const off = caretOffsetInEl(editor.root.children[bi], node, r.startOffset);
  const selR = document.createRange();
  selR.setStart(node, r.startOffset);
  selR.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(selR);
  editor.placeCaret(bi, off, { scroll: true });
}

// ---------------------------------------------------------------------------
// clear format (⌘\): strip inline styling in selection, else whole block
// ---------------------------------------------------------------------------

export function clearFormat(editor) {
  const cur = currentBlock(editor);
  if (!cur) return;
  const strip = (s) => s
    .replace(/(\*\*|__)([^*_]+)\1/g, "$2")
    .replace(/(\*|_)([^*_]+)\1/g, "$2")
    .replace(/(~~)([^~]+)\1/g, "$2")
    .replace(/(==)([^=]+)\1/g, "$2")
    .replace(/<\/?u>/gi, "")
    .replace(/(`+)([^`]+)\1/g, "$2");
  let src = strip(cur.block.src || "");
  if (editor.__settings?.subscriptSuperscript) src = parseInline(src, editor.__settings).map((part) =>
    ["subscript", "superscript"].includes(part.type) ? scriptSpaces(part.inner, false) : part.src).join("");
  const nb = parseBlocks(src)[0] || { type: "paragraph", src, text: src };
  replace(editor, cur.index, nb, Math.min(cur.offset, nb.src.length));
}

// ---------------------------------------------------------------------------
// insert image (⌃⌘I)
// ---------------------------------------------------------------------------

export async function insertImage(editor) {
  if (editor.guardReadOnly()) return;
  const generation = editor._generation, source = editor.getMarkdown();
  const selection = editor.selectionOffsets() || { start: editor.globalIndexOfCaret(), end: editor.globalIndexOfCaret() };
  try {
    const image = await window.bridge.images.import({ docPath: editor.docBase });
    if (image.canceled) return;
    if (editor.readOnly || generation !== editor._generation || source !== editor.getMarkdown()) { window.__lettrineNotify?.("The document changed while choosing the image. Insert it again at the new position."); return; }
    editor.replaceRange(selection.start, selection.end, "!" + linkMarkdown("", image.reference).source);
  } catch (error) { window.__lettrineNotify?.("Image insert failed: " + error.message); }
}
