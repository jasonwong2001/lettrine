import { structuralRange, structuralDeletion } from "../core/selection.js";

export function editingContext(app) {
  const editor = app.editor;
  if (!editor || document.querySelector(".modal.open")) return null;
  const active = document.activeElement;
  if (active?.matches?.("input,textarea,select") && !active.closest("#app-source") && !(editor.root.contains(active) && active.closest(".CodeMirror"))) return null;
  const editable = active?.closest?.("[contenteditable=true]");
  if (editable && !editor.root.contains(editable)) return null;
  const source = document.body.classList.contains("sourceview-on"), mounted = source ? null : editor._activeCmBlock();
  const cm = source ? app._sourceCM : mounted?.cm, textarea = source && !cm ? document.getElementById("source-editor") : null;
  if (editor._composing || cm?.__lettrineComposing) return null;
  const text = source ? cm?.getValue() ?? textarea.value : editor.getMarkdown();
  const anchor = source ? cm ? cm.indexFromPos(cm.getCursor("anchor")) : textarea.selectionStart : null;
  const head = source ? cm ? cm.indexFromPos(cm.getCursor("head")) : textarea.selectionEnd : null;
  const selection = source ? { start: Math.min(anchor, head), end: Math.max(anchor, head), backward: anchor > head || textarea?.selectionDirection === "backward" }
    : editor.selectionOffsets() || { start: editor.globalIndexOfCaret(), end: editor.globalIndexOfCaret() };
  const bodyStart = mounted ? editor.blockStart(mounted.index) + editor.blocks[mounted.index].src.indexOf("\n") + 1 : 0;
  return { editor, source, mounted, cm, textarea, text, selection, bodyStart };
}

function select(context, range) {
  const { editor, source, cm, textarea, mounted, bodyStart } = context;
  if (cm && (!mounted || range.start >= bodyStart && range.end <= bodyStart + cm.getValue().length)) {
    cm.setSelection(cm.posFromIndex(range.start - bodyStart), cm.posFromIndex(range.end - bodyStart)); cm.focus();
  } else if (source && textarea) {
    textarea.focus(); textarea.setSelectionRange(range.start, range.end);
  } else {
    if (mounted) editor._cedeCmBlocks();
    editor.root.focus({ preventScroll: true });
    if (range.wholeBlocks) {
      const first = editor.root.children[range.first], last = editor.root.children[range.last];
      const selection = window.getSelection(), domRange = document.createRange();
      domRange.setStartBefore(first); domRange.setEndAfter(last);
      selection.removeAllRanges(); selection.addRange(domRange);
    } else editor.selectOffsets(range.start, range.end);
    editor._revealCaret(editor.root.children[editor.globalOffsetToBlock(range.start).index]);
  }
}

export function runSelectionCommand(app, action) {
  const context = editingContext(app);
  if (!context) return false;
  const { editor, source, cm, textarea, mounted, text, selection, bodyStart } = context;
  const deleting = action.startsWith("delete"), kind = action.replace(/^(?:select|delete)/, "").replace(/^./, (char) => char.toLowerCase());
  if (deleting && editor.guardReadOnly()) return false;
  const settings = { ...app.settings, locale: app.i18n?.locale };
  const range = deleting ? structuralDeletion(text, selection, kind, settings) : structuralRange(text, selection, kind, settings);
  if (!deleting) { select(context, range); return true; }
  if (range.start === range.end) return false;
  if (cm && (!mounted || range.start >= bodyStart && range.end <= bodyStart + cm.getValue().length)) {
    cm.operation(() => {
      cm.replaceRange("", cm.posFromIndex(range.start - bodyStart), cm.posFromIndex(range.end - bodyStart), "range-delete");
      cm.setCursor(cm.posFromIndex(range.start - bodyStart));
    });
    cm.focus();
  } else if (source && textarea) {
    textarea.setRangeText("", range.start, range.end, "start");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true })); textarea.focus();
  } else {
    editor.checkpointSelection();
    editor.replaceRange(range.start, range.end, "", { inputType: "range-delete" });
    editor.root.focus(); editor.selectOffsets(Math.min(range.start, editor.getMarkdown().length));
  }
  return true;
}
