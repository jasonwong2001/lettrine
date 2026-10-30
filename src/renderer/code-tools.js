import { codeOptions, codeRanges, codeFormatEdits, applyCodeEdits, codeSelectionAfter } from "../core/code-tools.js";
import { parseBlocks, inheritBlockLayout } from "../core/blocks.js";
import { textChange } from "../core/history.js";

const sourceMode = () => document.body.classList.contains("sourceview-on");
function selectionOf(cm) {
  const anchor = cm.indexFromPos(cm.getCursor("anchor")), head = cm.indexFromPos(cm.getCursor("head"));
  return { start: Math.min(anchor, head), end: Math.max(anchor, head), backward: anchor > head };
}
function selectCM(cm, selection) {
  const start = cm.posFromIndex(selection.start), end = cm.posFromIndex(selection.end);
  cm.setSelection(selection.backward ? end : start, selection.backward ? start : end);
}
export function replaceCodeMirrorText(cm, after, selection, origin = "code-format") {
  const before = cm.getValue();
  if (before !== after) {
    const change = textChange(before, after);
    cm.operation(() => {
      cm.replaceRange(change.inserted, cm.posFromIndex(change.start), cm.posFromIndex(change.start + change.removeLength), origin);
      selectCM(cm, selection);
    });
  }
}

export function formatCodeInApp(app, action, scope = "selection") {
  const editor = app.editor, source = sourceMode();
  if (editor.guardReadOnly()) return false;
  if (document.querySelector(".modal.open")) return false;
  const active = document.activeElement;
  if (active?.matches?.("input,textarea,select") && !active.closest(".CodeMirror, #app-source")) return false;
  const cm = source ? app._sourceCM : editor._activeCmBlock()?.cm;
  if (editor._composing || cm?.__lettrineComposing) return false;
  const textarea = source && !cm ? document.getElementById("source-editor") : null;
  const text = source ? cm?.getValue() ?? textarea.value : editor.getMarkdown();
  let selection = source ? cm ? selectionOf(cm) : { start: textarea.selectionStart, end: textarea.selectionEnd, backward: textarea.selectionDirection === "backward" } : editor.selectionOffsets();
  selection ||= { start: editor.globalIndexOfCaret(), end: editor.globalIndexOfCaret() };
  const targets = codeRanges(text).filter((range) => selection.start === selection.end ? selection.start >= range.start && selection.start <= range.end : selection.end > range.start && selection.start < range.end);
  if (!targets.length) { app.notify?.("Place the caret in a code block."); return false; }
  const edits = codeFormatEdits(window.CodeMirror, text, selection, app.settings, action, scope);
  if (!edits.length) return false;
  const after = applyCodeEdits(text, edits), mapped = codeSelectionAfter(text, edits, selection);
  if (source) {
    if (cm) { replaceCodeMirrorText(cm, after, mapped); cm.focus(); }
    else {
      const change = textChange(text, after);
      textarea.setRangeText(change.inserted, change.start, change.start + change.removeLength);
      textarea.setSelectionRange(mapped.start, mapped.end, mapped.backward ? "backward" : "forward");
      textarea.dispatchEvent(new Event("input", { bubbles: true })); textarea.focus();
    }
  } else if (cm && edits.length === 1 && editor._activeCmBlock()?.index === edits[0].index) {
    const edit = edits[0];
    replaceCodeMirrorText(cm, edit.after, { ...mapped, start: mapped.start - edit.bodyStart, end: mapped.end - edit.bodyStart });
    editor.pushHistory();
  } else {
    editor.checkpointSelection();
    for (const edit of edits) {
      const source = edit.block.src.slice(0, edit.bodyStart - edit.start) + edit.after + edit.block.src.slice(edit.bodyEnd - edit.start);
      const block = parseBlocks(source)[0];
      inheritBlockLayout(edit.block, [block]); block.__docBase = editor.docBase; editor.blocks[edit.index] = block;
    }
    editor.renderAll();
    editor.root.focus({ preventScroll: true }); editor.selectOffsets(mapped.start, mapped.end, mapped.backward);
    editor.pushHistory(); editor.emit();
  }
  return true;
}

function sourceCodeContext(cm, editor) {
  const selection = selectionOf(cm), start = editor.globalOffsetToBlock(selection.start);
  const block = editor.blocks[start.index];
  if (block?.type !== "code") return false;
  const bodyStart = editor.blockStart(start.index) + block.src.indexOf("\n") + 1;
  return block.src.includes("\n") && selection.start >= bodyStart && selection.end <= bodyStart + block.body.length;
}

export function codeKeyMap(editor, settings, source = false) {
  const indent = (cm, direction) => {
    if (editor.guardReadOnly()) return;
    if (cm.__lettrineComposing) return window.CodeMirror.Pass;
    if (source && !sourceCodeContext(cm, editor)) return window.CodeMirror.Pass;
    const previous = { indentUnit: cm.getOption("indentUnit"), tabSize: cm.getOption("tabSize"), indentWithTabs: cm.getOption("indentWithTabs") };
    const options = codeOptions(settings());
    for (const [key, value] of Object.entries(options)) cm.setOption(key, value);
    try {
      if (direction === "auto") window.__lettrine?.formatCode?.("indent", "selection");
      else if (direction === "add" && !cm.somethingSelected()) {
        const cursor = cm.getCursor(), column = window.CodeMirror.countColumn(cm.getLine(cursor.line), cursor.ch, options.tabSize);
        cm.replaceSelection(options.indentWithTabs ? "\t" : " ".repeat(options.indentUnit - column % options.indentUnit), "end", "code-indent");
      } else cm.operation(() => cm.indentSelection(direction));
    } finally { for (const [key, value] of Object.entries(previous)) cm.setOption(key, value); }
  };
  return {
    Tab: (cm) => indent(cm, "add"),
    "Shift-Tab": (cm) => indent(cm, settings().codeShiftTab === "auto" ? "auto" : "subtract"),
  };
}
