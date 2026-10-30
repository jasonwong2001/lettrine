// Lettrine editor input — Enter / Backspace / Tab semantics.
// Implements the editor's block-transition rules:
//   - Enter splits the current block (list items continue, empty items pop
//     out, code blocks add a line, tables add a row, headings/quotes spawn
//     a paragraph after).
//   - Backspace at a block start joins with the previous block.
//   - Tab / Shift+Tab indent and outdent list items.
//   - Shift+Enter inserts a hard line break inside paragraph-like blocks.

import { splitBlock, joinWithPrev, listSrcFromItems, parseBlocks, locateOffset, inheritBlockLayout } from "../core/blocks.js";
import { editTableRow, joinTableRow } from "../core/table.js";
import { mathInput } from "../core/math.js";

const isMac = /Mac/.test(navigator.platform || "");
const mod = isMac ? "metaKey" : "ctrlKey";

function replaceBlocks(editor, newBlocks, caretBlock, caretOffset, opts = {}) {
  for (const b of newBlocks) b.__docBase = editor.docBase;
  editor.blocks = newBlocks;
  editor.renderAll();
  editor.placeCaret(caretBlock, caretOffset, opts);
  editor._syncMathFocus(caretBlock);
}

export function handleKeydown(editor, e) {
  if (editor.readOnly) return;
  // IME active (229 / isComposing): Enter confirms a candidate and Backspace
  // edits the composition — all of it belongs to the native pipeline
  if (e.isComposing || e.keyCode === 229) return;
  // a CodeMirror-mounted block (fence or math) owns its own keys
  // (Enter/Tab/history); the CM's own handlers update the model
  const t = e.target;
  if (t?.closest?.(".md-decor") && /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(t.tagName)) return;
  if (t && t.closest && t.closest("[mdtype='fences'], [mdtype='math_block']")?.__cm) return;
  editor.checkpointSelection();
  if (window.__emojiPopupOpen && window.__emojiOwner === editor) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); window.__moveEmoji?.(e.key === "ArrowDown" ? 1 : -1); return; }
    if (e.key === "Escape") { e.preventDefault(); window.__confirmEmoji?.(); return; }
    if (["Enter", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) window.__hideEmoji?.();
  }

  // ---- Enter ----
  if (e.key === "Enter") {
    if (e.shiftKey) {
      // hard break inside paragraph-like blocks
      e.preventDefault();
      hardBreak(editor);
      return;
    }
    if (e.metaKey || e.ctrlKey) return; // let browser handle
    e.preventDefault();
    const selection = editor.selectionOffsets();
    if (selection && selection.start !== selection.end) editor.replaceRange(selection.start, selection.end, "", { recordHistory: false, emit: false });
    doEnter(editor);
    return;
  }

  // ---- Backspace ----
  if (e.key === "Backspace" || e.key === "Delete") {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      // Chromium may not emit beforeinput for a selection made entirely of
      // rendered/readonly blocks. Delete their source at the key boundary.
      if (editor.deleteSelection()) e.preventDefault();
      return;
    }
    const ci = editor.caretInfo();
    if (ci.blockIndex === -1) return;
    if (e.key === "Backspace") {
      const b = editor.blocks[ci.blockIndex];
      if (b.type === "table" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const result = joinTableRow(b, ci.offset);
        if (result) {
          e.preventDefault();
          editor.replaceRange(editor.blockStart(ci.blockIndex), editor.blockStart(ci.blockIndex) + b.src.length, result.source, { recordHistory: false, emit: false });
          editor.placeCaret(ci.blockIndex, result.offset);
          editor.pushHistory(); editor.emit(); return;
        }
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && b.type === "heading") {
        const prefix = /^(\s{0,3}#{1,6}\s*)/.exec(b.src)?.[0].length ?? 0;
        if (ci.offset <= prefix) {
          e.preventDefault();
          if (b.setext) editor.replaceRange(editor.blockStart(ci.blockIndex), editor.blockStart(ci.blockIndex) + b.src.length, b.text);
          else editor.replaceRange(editor.blockStart(ci.blockIndex), editor.blockStart(ci.blockIndex) + prefix, "");
          return;
        }
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && b.type === "list") {
        const lineStart = b.src.lastIndexOf("\n", ci.offset - 1) + 1;
        const prefix = /^(\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(b.src.slice(lineStart))?.[0] || "";
        if (prefix && ci.offset === lineStart + prefix.length) {
          e.preventDefault();
          if (/^[ \t]{2}/.test(prefix)) indentList(editor, ci.blockIndex, false);
          else editor.replaceRange(editor.blockStart(ci.blockIndex) + lineStart, editor.blockStart(ci.blockIndex) + lineStart + prefix.length, "");
          return;
        }
      }
      // an EMPTY footnote definition reverts to a plain paragraph
      // (our backToParagraphBeforeDelete for def_footnote)
      if (b.type === "def_footnote" && !(b.ref || "").trim() && !(b.text || "").trim()) {
        e.preventDefault();
        const before = editor.blocks.slice(0, ci.blockIndex);
        const after = editor.blocks.slice(ci.blockIndex + 1);
        replaceBlocks(editor, [...before, { type: "paragraph", src: "", text: "" }, ...after], ci.blockIndex, 0);
        editor.pushHistory();
        editor.emit();
        return;
      }
    }
    if (e.key === "Backspace" && ci.offset === 0) {
      if (ci.blockIndex === 0) return; // nothing before
      e.preventDefault();
      doJoin(editor);
      return;
    }
    if (e.key === "Delete" && ci.offset === (editor.blocks[ci.blockIndex].src || "").length && ci.blockIndex + 1 < editor.blocks.length) {
      e.preventDefault();
      editor.placeCaret(ci.blockIndex + 1, 0);
      doJoin(editor);
      return;
    }
    // Backspace right at the start of an inline segment should not eat
    // across block boundaries silently — let the DOM handle char delete.
  }

  // ---- Tab in lists ----
  if (e.key === "Tab") {
    const ci = editor.caretInfo();
    if (ci.blockIndex !== -1 && editor.blocks[ci.blockIndex]?.type === "def_footnote") {
      const block = editor.root.children[ci.blockIndex];
      const anchor = window.getSelection()?.anchorNode;
      const node = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
      const target = e.shiftKey && node?.closest?.(".md-def-content") ? block.querySelector(".md-def-name")
        : !e.shiftKey && node?.closest?.(".md-def-name") ? block.querySelector(".md-def-content") : null;
      if (target) {
        e.preventDefault();
        target.focus();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        return;
      }
    }
    if (ci.blockIndex !== -1 && editor.blocks[ci.blockIndex]?.type === "list") {
      e.preventDefault();
      indentList(editor, ci.blockIndex, !e.shiftKey);
      return;
    }
    // Tab in tables moves to next cell; at the LAST cell of the last row
    // it appends a new row and moves into its first cell
    if (ci.blockIndex !== -1 && editor.blocks[ci.blockIndex]?.type === "table") {
      e.preventDefault();
      if (!e.shiftKey && atLastTableCell(editor, ci)) {
        tableTabNewRow(editor);
      } else {
        moveTableCell(editor, e.shiftKey ? -1 : 1);
      }
      return;
    }
    e.preventDefault();
    editor.replaceSelection(editor.__settings?.indentWithTabs ? "\t" : " ".repeat(editor.__settings?.tabSize || 4));
    return;
  }

  // ---- arrow navigation across blocks ----
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const ci = editor.caretInfo();
    if (ci.blockIndex === -1) return;
    const atEdge =
      (e.key === "ArrowUp" && ci.offset === 0) ||
      (e.key === "ArrowDown" && ci.offset >= (editor.blocks[ci.blockIndex].src || "").length);
    if (atEdge) {
      e.preventDefault();
      const target = e.key === "ArrowUp" ? ci.blockIndex - 1 : ci.blockIndex + 1;
      if (target >= 0 && target < editor.blocks.length) {
        editor.placeCaret(target, e.key === "ArrowUp" ? 99999 : 0, { scroll: true });
      }
    }
  }

  // Global modified shortcuts are dispatched by main from the saved map.

  // ---- Esc: emoji completion confirm / blur ----
  if (e.key === "Escape") {
    if (window.__emojiPopupOpen) {
      e.preventDefault();
      window.__confirmEmoji?.();
      return;
    }
    editor.root.blur();
  }
}

// ---------------------------------------------------------------------------

export function doEnter(editor) {
  const ci = editor.caretInfo();
  if (ci.blockIndex === -1) return;
  const block = editor.blocks[ci.blockIndex];
  if (block.type === "hr" && ci.blockIndex === 0 && !block._leading && /^\uFEFF?---[ \t]*$/.test(block.src) && ci.offset >= block.src.length) {
    editor.replaceRange(0, block.src.length, block.src + "\n");
    return;
  }
  if (block.type === "frontmatter" && (!block.closed || ci.offset < block.src.length)) {
    const point = editor.blockStart(ci.blockIndex) + ci.offset;
    editor.replaceRange(point, point, "\n");
    return;
  }
  if (block.type === "math" && !block.src.includes("\n") && ci.offset >= block.src.length) {
    const completed = parseBlocks(mathInput(block, "", true).source);
    const after = editor.blocks.slice(ci.blockIndex + 1);
    if (after[0]?.type !== "paragraph" || after[0].src) completed.push({ type: "paragraph", src: "", text: "" });
    inheritBlockLayout(block, completed);
    replaceBlocks(editor, [...editor.blocks.slice(0, ci.blockIndex), ...completed, ...after], ci.blockIndex, block.src.length + 1, { scroll: true });
    editor.pushHistory();
    editor.emit();
    return;
  }
  if (block.type === "code" && block.closed && !block.body && ci.offset <= block.src.indexOf("\n")) {
    editor.placeCaret(ci.blockIndex, block.src.indexOf("\n") + 1);
    editor._syncMathFocus(ci.blockIndex);
    return;
  }
  if (block.type === "code" && !block.src.includes("\n") && editor.__settings?.autoPairMarkdown) {
    const start = editor.blockStart(ci.blockIndex), opening = block.src;
    editor.replaceRange(start, start + opening.length, opening + "\n\n" + block.fence, { inputType: "markdown-pair" });
    editor.selectOffsets(start + opening.length + 1); editor._syncMathFocus(ci.blockIndex);
    return;
  }
  if (block.type === "list" && editor.__settings?.smartList === false) {
    const point = editor.blockStart(ci.blockIndex) + ci.offset;
    editor.replaceRange(point, point, "\n\n");
    return;
  }
  if (block.type === "table") {
    const result = editTableRow(block, ci.offset, "below");
    const updated = parseBlocks(result.source)[0];
    for (const key of ["_leading", "_before", "_after"]) if (block[key] !== undefined) updated[key] = block[key];
    replaceBlocks(editor, [...editor.blocks.slice(0, ci.blockIndex), updated, ...editor.blocks.slice(ci.blockIndex + 1)], ci.blockIndex, result.offset);
    editor.pushHistory();
    editor.emit();
    return;
  }
  const res = splitBlock(block, ci.offset);
  const before = editor.blocks.slice(0, ci.blockIndex);
  const after = editor.blocks.slice(ci.blockIndex + 1);

  switch (res.kind) {
    case "replace": {
      replaceBlocks(editor, [...before, ...res.blocks, ...after], ci.blockIndex + res.caretBlock, res.offset ?? 0, { scroll: true });
      break;
    }
    case "split": {
      if (res.right) {
        const blocks = [...before, res.left, res.right, ...after];
        replaceBlocks(editor, blocks, ci.blockIndex + 1, res.offset ?? 0, { scroll: true });
      } else {
        // list item popped out: caret goes to the end of what remains
        const blocks = [...before, res.left, ...after];
        replaceBlocks(editor, blocks, ci.blockIndex, res.offset ?? (res.left.src || "").length, { scroll: true });
      }
      break;
    }
    case "stay": {
      const blocks = [...before, res.block, ...after];
      replaceBlocks(editor, blocks, ci.blockIndex, res.offset ?? ci.offset, { scroll: true });
      break;
    }
    case "after": {
      const blocks = [...before, res.block || block, res.newBlock, ...after];
      replaceBlocks(editor, blocks, ci.blockIndex + 1, res.offset ?? 0, { scroll: true });
      break;
    }
    case "after-row": {
      // table gained an empty row; caret at its first cell
      const blocks = [...before, res.block, ...after];
      const nCols = res.block.headers.length;
      const lastRowLen = 2 * nCols + 2; // "|  |  |" for empty cells
      const off = Math.max(0, (res.block.src || "").length - lastRowLen);
      replaceBlocks(editor, blocks, ci.blockIndex, off, { scroll: true });
      break;
    }
    case "none":
    default: {
      const empty = { type: "paragraph", src: "", text: "" };
      const blocks = [...before, block, empty, ...after];
      replaceBlocks(editor, blocks, ci.blockIndex + 1, 0, { scroll: true });
    }
  }
  editor.pushHistory();
  editor.emit();
}

function doJoin(editor) {
  const ci = editor.caretInfo();
  const prev = editor.blocks[ci.blockIndex - 1];
  const cur = editor.blocks[ci.blockIndex];
  const { prev: merged, leftover } = joinWithPrev(prev, cur);
  const joinOffset = Math.min((prev.src || "").length, (merged.src || "").length);
  const before = editor.blocks.slice(0, ci.blockIndex - 1);
  const after = editor.blocks.slice(ci.blockIndex + 1);
  const blocks = [...before, merged, ...(leftover ? [leftover] : []), ...after];
  replaceBlocks(editor, blocks, ci.blockIndex - 1, joinOffset, { scroll: true });
  editor.pushHistory();
  editor.emit();
}

export function hardBreak(editor) {
  const ci = editor.caretInfo();
  if (ci.blockIndex === -1) return;
  const block = editor.blocks[ci.blockIndex];
  if (!["paragraph", "heading", "quote"].includes(block.type)) {
    doEnter(editor);
    return;
  }
  let src = block.src || "";
  src = src.slice(0, ci.offset) + "  \n" + src.slice(ci.offset);
  const before = editor.blocks.slice(0, ci.blockIndex);
  const after = editor.blocks.slice(ci.blockIndex + 1);
  const updated = { ...block, src, text: src };
  replaceBlocks(editor, [...before, updated, ...after], ci.blockIndex, ci.offset + 3);
  editor.pushHistory();
  editor.emit();
}

// ---------------------------------------------------------------------------
// list indent / outdent
// ---------------------------------------------------------------------------

export function indentList(editor, blockIndex, indent) {
  const block = editor.blocks[blockIndex];
  const ci = editor.caretInfo();
  const lines = block.src.split("\n");
  const lineIndex = block.src.slice(0, ci.offset).split("\n").length - 1;
  const current = lines[lineIndex];
  const currentIndent = current.match(/^[ \t]*/)[0].length;
  if (indent) {
    let previous = lineIndex - 1;
    while (previous >= 0 && !lines[previous].trim()) previous--;
    if (previous < 0 || lines[previous].match(/^[ \t]*/)[0].length < currentIndent) return;
  } else if (!currentIndent) return;
  let delta = 0;
  for (let i = lineIndex; i < lines.length; i++) {
    const depth = lines[i].match(/^[ \t]*/)[0].length;
    if (i > lineIndex && lines[i].trim() && depth <= currentIndent) break;
    const old = lines[i];
    lines[i] = indent ? "  " + old : old.replace(/^(?: {1,2}|\t)/, "");
    if (i === lineIndex) delta = lines[i].length - old.length;
  }
  // an outdented item of another marker type starts a list of its own
  const updated = parseBlocks(lines.join("\n"));
  const caret = locateOffset(updated, Math.max(0, ci.offset + delta));
  inheritBlockLayout(block, updated);
  replaceBlocks(editor, [...editor.blocks.slice(0, blockIndex), ...updated, ...editor.blocks.slice(blockIndex + 1)], blockIndex + caret.index, caret.offset);
  editor.pushHistory();
  editor.emit();
}

// ---------------------------------------------------------------------------
// table cell navigation
// ---------------------------------------------------------------------------

// is the caret in the LAST cell of the last data row? Judged on the live
// DOM (the source-offset mapping for tables is approximate).
function atLastTableCell(editor, ci) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.anchorNode) return false;
  const eln = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
  const td = eln && eln.closest ? eln.closest("td,th") : null;
  if (!td) return false;
  const tr = td.parentElement;
  const table = tr && tr.closest ? tr.closest("table") : null;
  if (!table) return false;
  const rows = Array.from(table.querySelectorAll("tr")).filter((r) => !r.classList.contains("md-sep-row"));
  const lastRow = rows[rows.length - 1];
  return !!lastRow && tr === lastRow && td === lastRow.lastElementChild;
}

// append an empty row and place the caret in its first cell
function tableTabNewRow(editor) {
  const ci = editor.caretInfo();
  const block = editor.blocks[ci.blockIndex];
  editor.placeCaret(ci.blockIndex, block.src.length);
  doEnter(editor);
}

function moveTableCell(editor, dir) {
  const sel = window.getSelection();
  const td = (sel?.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel?.anchorNode)?.closest?.("td,th");
  const table = td?.closest("table");
  if (!table) return;
  const cells = Array.from(table.querySelectorAll("th,td")).filter((c) => !c.closest(".md-sep-row"));
  const next = cells[cells.indexOf(td) + dir]?.querySelector(".md-plain");
  if (!next) return;
  const range = document.createRange();
  range.selectNodeContents(next);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  next.scrollIntoView?.({ block: "nearest" });
}

// ---------------------------------------------------------------------------
// word selection (⌘D)
// ---------------------------------------------------------------------------

function selectWord(editor) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== 3) return;
  const text = node.data;
  const pos = sel.anchorOffset;
  const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch || "");
  let start = pos;
  let end = pos;
  // expand current word
  if (sel.isCollapsed) {
    while (start > 0 && isWord(text[start - 1])) start--;
    while (end < text.length && isWord(text[end])) end++;
  } else {
    // next occurrence
    const word = text.slice(start, end).trim();
    if (!word) return;
    const nextIdx = text.indexOf(word, end);
    if (nextIdx === -1) return;
    start = nextIdx;
    end = nextIdx + word.length;
  }
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  sel.removeAllRanges();
  sel.addRange(r);
}
