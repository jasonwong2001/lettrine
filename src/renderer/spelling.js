export function bindSpellSuggestions(editor) {
  let pending = 0;
  editor.root.addEventListener("dblclick", (event) => {
    if (event.target.closest?.(".CodeMirror, .md-decor, [mdtype=fences], [mdtype=math_block]")) return;
    setTimeout(() => { void showSpellSuggestions(editor, { x: event.clientX, y: event.clientY, request: ++pending }).catch((error) => window.__lettrineNotify?.(error.message)); }, 0);
  });
}

export async function showSpellSuggestions(editor, point = {}) {
  const selected = editor.selectionOffsets();
  if (!selected || selected.start === selected.end) return;
  const source = editor.getMarkdown(), word = source.slice(selected.start, selected.end), generation = editor._generation;
  if (!/^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(word) || !window.bridge.word.getSpellSuggestionInContext) return;
  const result = await window.bridge.word.getSpellSuggestionInContext({ word });
  const current = editor.selectionOffsets();
  if (!result?.misspelled || generation !== editor._generation || source !== editor.getMarkdown() || current?.start !== selected.start || current?.end !== selected.end) return;
  document.querySelector(".md-spelling-menu")?.remove();
  const menu = document.createElement("div"); menu.className = "md-spelling-menu md-decor dropdown-menu open";
  menu.setAttribute("role", "menu");
  menu.style.cssText = `position:fixed;left:${Math.max(4, Math.min(point.x || 20, innerWidth - 250))}px;top:${Math.min((point.y || 20) + 16, innerHeight - 200)}px;z-index:10000`;
  const close = () => menu.remove();
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  const add = (label, run) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("role", "menuitem");
    button.onclick = async () => { close(); try { await run(); } catch (error) { window.__lettrineNotify?.(error.message); } };
    menu.appendChild(button);
  };
  for (const suggestion of (result.suggestions || []).slice(0, 8)) add(suggestion, () => {
    if (editor._generation !== generation || source !== editor.getMarkdown()) return;
    editor.root.focus({ preventScroll: true }); editor.replaceRange(selected.start, selected.end, suggestion);
  });
  if (!result.suggestions?.length) { const empty = document.createElement("div"); empty.textContent = "No spelling suggestions"; menu.appendChild(empty); }
  add("Add to Dictionary", () => window.bridge.word.updateDictionary({ add: word }));
  add("Ignore Word", () => window.bridge.word.updateDictionary({ ignore: word }));
  menu.addEventListener("keydown", (event) => { if (event.key === "Escape") { close(); editor.root.focus(); } });
  document.body.appendChild(menu);
  const dismiss = (event) => { if (!menu.contains(event.target)) { close(); document.removeEventListener("mousedown", dismiss, true); } };
  document.addEventListener("mousedown", dismiss, true);
}

export function initDictionaryPreferences() {
  const panel = document.getElementById("pref-pane-spelling");
  if (!panel) return;
  panel.querySelector("#pref-dictionary-system").onclick = () => window.bridge.word.openDictionarySettings();
  panel.querySelector("#pref-dictionary-download").onclick = async () => {
    try { const state = await window.bridge.word.downloadDict({ language: panel.querySelector("select").value }); renderDictionaryLanguages(state); }
    catch (error) { window.__lettrineNotify?.(error.message); }
  };
  window.bridge.on("word.dictionaryChanged", (state) => { if (document.querySelector("#preferences-dialog.open")) renderDictionaryLanguages(state); });
}
function renderDictionaryLanguages(state) {
  const panel = document.getElementById("pref-pane-spelling");
  const native = !!state.nativeManaged;
  panel.querySelector("#pref-dictionary-note").textContent = native
    ? "macOS manages spelling languages and language packs in System Settings. Added and ignored words are shared with the system spelling dictionary."
    : "Enable a language to download its spelling dictionary. Dictionaries stay available offline after download.";
  panel.querySelector("#pref-dictionary-system").style.display = native ? "" : "none";
  panel.querySelector("#pref-dictionary-download-controls").style.display = native ? "none" : "";
  const select = panel.querySelector("select"); select.replaceChildren();
  for (const language of state.available || []) { const option = document.createElement("option"); option.value = language; option.textContent = language; select.appendChild(option); }
  const list = panel.querySelector("#pref-dictionary-languages"); list.replaceChildren();
  for (const language of state.languages || []) {
    const row = document.createElement("div"); row.textContent = language + " — " + (state.downloads?.[language] || "enabled");
    if (!native) { const remove = document.createElement("button"); remove.textContent = "Remove"; remove.className = "ui-btn";
      remove.onclick = async () => { try { renderDictionaryLanguages(await window.bridge.word.setDictionaryLanguages({ languages: state.languages.filter((value) => value !== language) })); } catch (error) { window.__lettrineNotify?.(error.message); } }; row.appendChild(remove); }
    list.appendChild(row);
  }
}
export async function loadDictionaryPreferences() {
  const panel = document.getElementById("pref-pane-spelling");
  if (!panel || !window.bridge.word.getUserDict) return;
  panel.dataset.loaded = "false";
  try {
    const state = await window.bridge.word.getUserDict();
    panel.querySelector("#pref-dictionary-words").value = state.words.join("\n");
    panel.querySelector("#pref-dictionary-ignored").value = state.ignored.join("\n");
    panel.querySelector("#pref-dictionary-path").textContent = state.path;
    panel.dataset.loaded = "true"; renderDictionaryLanguages(state);
  } catch (error) { window.__lettrineNotify?.("Dictionary could not be loaded: " + error.message); }
}
export async function saveDictionaryPreferences() {
  const panel = document.getElementById("pref-pane-spelling");
  if (panel?.dataset.loaded !== "true") return;
  await window.bridge.word.updateDictionary({ words: panel.querySelector("#pref-dictionary-words").value.split("\n"), ignored: panel.querySelector("#pref-dictionary-ignored").value.split("\n") });
}
