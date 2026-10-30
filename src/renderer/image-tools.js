import { imageReferences, convertImageSyntax, repairImageReferences, rebaseImageHistory, imageSelectionAfter } from "../core/images.js";
import { textChange } from "../core/history.js";
import { linkMarkdown } from "../core/links.js";

export function imageSnapshot(app) {
  const text = app._sourceCM?.getValue() ?? (document.body.classList.contains("sourceview-on") ? document.getElementById("source-editor").value : app.editor.getMarkdown());
  return { path: app.file, text, references: imageReferences(text), readonly: app.editor.readOnly };
}

function rebaseSourceHistory(cm, transform) {
  const CM = window.CodeMirror;
  if (!CM?.Doc) { cm.setValue(transform(cm.getValue())); return; }
  const scratch = new CM.Doc(cm.getValue(), cm.getOption("mode"));
  scratch.setHistory(cm.getHistory());
  const current = scratch.historySize().undo;
  while (scratch.historySize().undo) scratch.undo();
  const rebuilt = new CM.Doc(transform(scratch.getValue()), cm.getOption("mode"));
  let index = 0, currentUndo = 0;
  while (scratch.historySize().redo) {
    scratch.redo(); index++;
    const before = rebuilt.getValue(), after = transform(scratch.getValue()), change = textChange(before, after);
    if (before !== after) rebuilt.replaceRange(change.inserted, rebuilt.posFromIndex(change.start), rebuilt.posFromIndex(change.start + change.removeLength), "image-file-" + index);
    if (index === current) currentUndo = rebuilt.historySize().undo;
  }
  while (rebuilt.historySize().undo > currentUndo) rebuilt.undo();
  const before = cm.getValue(), after = transform(before);
  const selection = cm.listSelections().map(({ anchor, head }) => imageSelectionAfter(before, after, { start: cm.indexFromPos(anchor), end: cm.indexFromPos(head) }));
  cm.setValue(after); cm.setHistory(rebuilt.getHistory());
  cm.setSelections(selection.map(({ start, end }) => ({ anchor: cm.posFromIndex(start), head: cm.posFromIndex(end) })));
}

export function applyImageChanges(app, change) {
  const moves = change.moves || [], editor = app.editor;
  if (!editor) return;
  app._imageAssetVersion = (app._imageAssetVersion || 0) + 1;
  if (!moves.length) { editor.refreshImages(); return; }
  const transform = (text) => repairImageReferences(text, app.file, moves, app.settings);
  app._imageRepairing = true;
  try {
    if (app._sourceCM) rebaseSourceHistory(app._sourceCM, transform);
    else if (document.body.classList.contains("sourceview-on")) {
      const textarea = document.getElementById("source-editor"); textarea.value = transform(textarea.value);
    }
    rebaseImageHistory(editor, transform);
    editor.refreshImages();
  } finally { app._imageRepairing = false; }
}

export function formatImages(editor, syntax, zoom) {
  if (editor.guardReadOnly()) return;
  const source = editor.getMarkdown(), range = editor.selectionOffsets() || { start: editor.globalIndexOfCaret(), end: editor.globalIndexOfCaret() };
  const after = convertImageSyntax(source, range.start, range.end, syntax, zoom);
  if (after === source) return;
  const change = textChange(source, after);
  editor.replaceRange(change.start, change.start + change.removeLength, change.inserted);
}

export async function pasteSourceImage(app, image) {
  if (app.editor.guardReadOnly() || !image?.ok) return { ok: false };
  const cm = app._sourceCM, textarea = document.getElementById("source-editor"), id = app._documentId;
  const source = cm?.getValue() ?? textarea.value;
  const start = cm ? cm.indexFromPos(cm.getCursor("from")) : textarea.selectionStart;
  const end = cm ? cm.indexFromPos(cm.getCursor("to")) : textarea.selectionEnd;
  const saved = await window.bridge.images.import({ docPath: app.file, name: `paste-${Date.now()}.png`, data: image.png, upload: true });
  if (saved.uploadError) app.notify(app.i18nT("Image upload failed; the local image was kept.") + " " + app.i18nT(saved.uploadError));
  if (app.editor.readOnly || id !== app._documentId || !document.body.classList.contains("sourceview-on") || source !== (cm?.getValue() ?? textarea.value)) {
    app.notify("The document changed while preparing the image. Paste it again at the new position."); return { ok: false };
  }
  const insertion = "!" + linkMarkdown("", saved.reference).source;
  if (cm) { cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(end)); cm.replaceSelection(insertion, "end", "paste"); cm.focus(); }
  else { textarea.setRangeText(insertion, start, end, "end"); textarea.dispatchEvent(new Event("input", { bubbles: true })); }
  return { ok: true };
}

export async function manageImages(app, reference, operation, options = {}) {
  if (app.editor.guardReadOnly()) return false;
  if (operation === "delete" && !options.confirmed) {
    const choice = await app.confirmChoice("Delete the image file?", ["Cancel", "Delete Image File"], { detail: "The reference stays visible. Undo File Operation restores the image file." });
    if (choice !== "Delete Image File") return false;
    options = { ...options, confirmed: true };
  }
  const documents = [], targets = [];
  if (options.scope === "folder") {
    if (!app._libraryRoot) throw Error("Open a folder to manage its images.");
    const files = await window.bridge.library.listDocsUnder({ path: app._libraryRoot });
    for (const file of files.filter((item) => !item.isDirectory)) {
      const saved = await window.bridge.document.read({ path: file.path });
      if (saved.size > 2000000) continue;
      const snapshot = { path: file.path, text: saved.text, references: imageReferences(saved.text) };
      documents.push(snapshot);
      for (const image of snapshot.references) targets.push({ url: image.url, docPath: file.path });
    }
    // The initiating draft can contain references not saved to disk yet.
    if (app.file?.startsWith(app._libraryRoot + "/")) for (const image of imageSnapshot(app).references) targets.push({ url: image.url, docPath: app.file });
  } else if (!reference) {
    for (const image of imageSnapshot(app).references) targets.push({ url: image.url, docPath: app.file });
  }
  const result = await window.bridge.images.manage({ operation, reference, ...options, documents, folderPath: app._libraryRoot, ...(reference ? {} : { targets, batch: true }), docPath: app.file });
  return result?.canceled ? false : result;
}
