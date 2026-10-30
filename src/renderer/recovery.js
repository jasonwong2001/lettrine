export async function openRecovery(app) {
  if (!app.file) { window.__lettrineNotify?.("Save this document before viewing its history."); return; }
  const id = app._documentId, documentPath = app.file;
  const versions = await window.bridge.snapshots.list({ path: documentPath });
  if (app._documentId !== id || app.file !== documentPath) return;
  const modal = document.createElement("div"); modal.className = "modal open recovery-dialog";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", "Document History");
  modal.innerHTML = '<div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h2 class="modal-title">Document History</h2></div><div class="modal-body"><div class="recovery-versions" role="listbox" aria-label="Versions"></div><textarea readonly spellcheck="false" aria-label="Version preview" placeholder="Select a version to preview it."></textarea></div><div class="modal-footer"><button type="button" class="ui-btn" data-action="close">Cancel</button><button type="button" class="ui-btn ui-btn-primary" data-action="restore" disabled>Restore This Version</button></div></div></div>';
  const preview = modal.querySelector("textarea"), restore = modal.querySelector('[data-action="restore"]');
  let selected = null, contents = "", request = 0;
  const previousFocus = document.activeElement;
  const previousCM = app._sourceCM || app.editor._activeCmBlock()?.cm;
  const cmSelection = previousCM?.listSelections();
  const editorSelection = app.editor.selectionOffsets();
  const fieldSelection = typeof previousFocus?.selectionStart === "number" ? [previousFocus.selectionStart, previousFocus.selectionEnd, previousFocus.selectionDirection] : null;
  const close = () => {
    modal.remove(); document.removeEventListener("keydown", onKey);
    if (!previousFocus?.isConnected) return;
    previousFocus.focus({ preventScroll: true });
    if (previousCM && cmSelection) previousCM.setSelections(cmSelection);
    else if (fieldSelection) previousFocus.setSelectionRange(...fieldSelection);
    else if (app.editor.root.contains(previousFocus) && editorSelection) app.editor.selectOffsets(editorSelection.start, editorSelection.end, editorSelection.backward);
  };
  const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
  modal.querySelector('[data-action="close"]').onclick = close;
  const list = modal.querySelector(".recovery-versions");
  for (const version of versions) {
    const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "option");
    button.textContent = new Date(version.mtimeMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) + " · " + (version.size < 1024 ? version.size + " B" : (version.size / 1024).toFixed(1) + " KB");
    button.onclick = async () => {
      const sequence = ++request; restore.disabled = true; selected = null;
      try { const result = await window.bridge.snapshots.restore({ path: version.path }); if (sequence !== request || !modal.isConnected) return;
        selected = version; contents = result.text; preview.value = contents; restore.disabled = false;
        for (const item of list.children) { item.classList.toggle("active", item === button); item.setAttribute("aria-selected", String(item === button)); }
      } catch (error) { window.__lettrineNotify?.("Snapshot could not be read: " + error.message); }
    };
    list.appendChild(button);
  }
  if (!versions.length) list.textContent = "No earlier versions yet. Saving keeps a version, at most one every five minutes; the last 20 are retained.";
  restore.onclick = () => {
    if (app.editor.guardReadOnly()) return;
    if (!selected || app._documentId !== id || app.file !== documentPath) { window.__lettrineNotify?.("The open document changed. Open its history again."); return; }
    close();
    if (app._sourceCM) {
      const cm = app._sourceCM; cm.replaceRange(contents, { line: 0, ch: 0 }, cm.posFromIndex(cm.getValue().length), "snapshot"); cm.setCursor(0, 0); cm.focus();
    } else if (document.body.classList.contains("sourceview-on")) {
      const textarea = document.getElementById("source-editor"); textarea.value = contents; textarea.dispatchEvent(new Event("input", { bubbles: true })); textarea.focus();
    } else { app.editor.root.focus(); app.editor.replaceRange(0, app.editor.getMarkdown().length, contents); app.editor.selectOffsets(0); }
  };
  document.body.appendChild(modal); document.addEventListener("keydown", onKey);
  (list.querySelector("button") || modal.querySelector('[data-action="close"]')).focus();
}
