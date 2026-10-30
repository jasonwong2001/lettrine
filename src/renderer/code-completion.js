import { codeLanguageMatches, newCodeLanguage } from "../core/code-tools.js";
import { localizeUI } from "./localization.js";

let popup = null, current = null, dismissed = "", outsideBound = false;
function bindOutside() {
  if (outsideBound) return;
  outsideBound = true;
  document.addEventListener("mousedown", (event) => { if (current && !popup?.contains(event.target)) hideCodeCompletion(); });
  window.addEventListener("blur", hideCodeCompletion);
}

export function hideCodeCompletion() {
  if (current?.input) {
    current.input.removeAttribute("aria-activedescendant");
    current.input.removeAttribute("aria-controls");
    current.input.removeAttribute("aria-expanded");
  }
  popup?.remove(); popup = null; current = null;
}

function languageContext(editor, selection, text) {
  const point = editor.globalOffsetToBlock(selection.end), block = editor.blocks[point.index];
  if (block?.type !== "code") return null;
  const opening = block.src.split("\n")[0], match = /^(\s{0,3}(?:`{3,}|~{3,})[ \t]*)([a-z][\w+.#-]*)$/i.exec(opening);
  if (!match) return null;
  const start = editor.blockStart(point.index) + match[1].length, end = start + match[2].length;
  if (selection.start < start || selection.end > end) return null;
  return { start, end, query: text.slice(start, selection.end), text, index: point.index };
}

function show(context, input, rect, accept, owner, typed) {
  const key = context.start + ":" + context.query, matches = codeLanguageMatches(context.query);
  if (typed) dismissed = "";
  if (key === dismissed || !matches.length || matches.length === 1 && matches[0] === context.query) { hideCodeCompletion(); return; }
  const previous = current?.owner === owner && current.context.query === context.query ? current.selected : 0;
  hideCodeCompletion();
  popup = document.createElement("div");
  popup.id = "ui-code-languages"; popup.className = "ui-code-languages md-decor";
  popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", "Code languages");
  localizeUI(undefined, popup);
  current = { context, input, accept, owner, matches, selected: Math.min(previous, matches.length - 1) };
  for (const [index, language] of matches.entries()) {
    const option = document.createElement("button");
    option.type = "button"; option.id = "ui-code-language-" + index; option.textContent = language;
    option.setAttribute("role", "option"); option.setAttribute("tabindex", "-1");
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => complete(index, false)); popup.appendChild(option);
  }
  popup.style.left = Math.max(8, Math.min(window.innerWidth - 224, rect.left)) + "px";
  popup.style.top = Math.max(8, Math.min(window.innerHeight - 244, rect.bottom + 5)) + "px";
  document.body.appendChild(popup);
  input.setAttribute("aria-controls", popup.id); input.setAttribute("aria-expanded", "true");
  highlight();
}

function highlight() {
  if (!current || !popup) return;
  for (const [index, option] of [...popup.children].entries()) {
    option.setAttribute("aria-selected", String(index === current.selected));
    if (index === current.selected) {
      current.input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView?.({ block: "nearest" });
    }
  }
}

function complete(index, enter) {
  const item = current;
  if (!item) return;
  const language = item.matches[index]; hideCodeCompletion();
  item.accept(item.context, language, enter);
}

function keydown(event, owner) {
  if (event.isComposing || event.keyCode === 229 || current?.owner !== owner || event.metaKey || event.ctrlKey || event.altKey) return;
  if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === "Escape") { dismissed = current.context.start + ":" + current.context.query; hideCodeCompletion(); }
  else if (event.key === "Enter" || event.key === "Tab") complete(current.selected, event.key === "Enter");
  else { current.selected = (current.selected + (event.key === "ArrowDown" ? 1 : -1) + current.matches.length) % current.matches.length; highlight(); }
}

export function bindFenceCompletion(editor, enter) {
  bindOutside();
  const update = (typed = false) => {
    if (editor.readOnly || editor._composing || !editor.root.contains(document.activeElement) || document.activeElement.closest?.(".md-lang-input, .CodeMirror") || document.body.classList.contains("sourceview-on")) {
      if (current?.owner === editor) hideCodeCompletion();
      return;
    }
    const selection = editor.selectionOffsets(), context = selection && languageContext(editor, selection, editor.getMarkdown());
    if (!context) { if (current?.owner === editor) hideCodeCompletion(); return; }
    const marker = editor.root.children[context.index]?.querySelector(":scope > .md-tag, :scope > .md-attr");
    if (!marker) return;
    show(context, editor.root, marker.getBoundingClientRect(), (saved, language, startBody) => {
      if (editor.readOnly || editor.getMarkdown() !== saved.text) return;
      editor._lastCodeLanguage = language;
      editor.replaceRange(saved.start, saved.end, language);
      editor.root.focus(); editor.selectOffsets(saved.start + language.length);
      if (startBody) enter(editor);
    }, editor, typed);
  };
  editor._updateCodeCompletion = update;
  editor.root.addEventListener("keyup", (event) => { if (!["ArrowDown", "ArrowUp", "Escape", "Enter", "Tab"].includes(event.key)) update(); });
  editor.root.addEventListener("keydown", (event) => keydown(event, editor), true);
  editor.root.addEventListener("focusout", () => { if (current?.owner === editor) hideCodeCompletion(); });
  editor.root.addEventListener("compositionstart", hideCodeCompletion);
}

export function bindSourceCodeCompletion(app, cm) {
  bindOutside();
  const update = (typed = false) => {
    if (app.editor.readOnly || !cm.hasFocus() || cm.__lettrineComposing) { if (current?.owner === cm) hideCodeCompletion(); return; }
    const start = cm.indexFromPos(cm.getCursor("from")), end = cm.indexFromPos(cm.getCursor("to"));
    const context = languageContext(app.editor, { start, end }, cm.getValue());
    if (!context) { if (current?.owner === cm) hideCodeCompletion(); return; }
    const coordinates = cm.cursorCoords(cm.getCursor("to"), "window");
    show(context, cm.getInputField(), { left: coordinates.left, bottom: coordinates.bottom }, (saved, language, enter) => {
      if (app.editor.readOnly || cm.getValue() !== saved.text) return;
      app.editor._lastCodeLanguage = language;
      cm.replaceRange(language, cm.posFromIndex(saved.start), cm.posFromIndex(saved.end), "code-language");
      cm.setCursor(cm.posFromIndex(saved.start + language.length)); cm.focus();
      if (enter) cm.execCommand("newlineAndIndent");
    }, cm, typed);
  };
  cm.on("beforeChange", (_, change) => {
    if (app.editor.readOnly || cm.__lettrineComposing || change.origin !== "+input" || change.text.length !== 1 || !/^[`~]$/.test(change.text[0]) || change.from.line !== change.to.line || change.from.ch !== change.to.ch) return;
    const line = cm.getLine(change.from.line), proposed = line.slice(0, change.from.ch) + change.text[0] + line.slice(change.to.ch);
    if (!/^\s{0,3}(?:`{3}|~{3})$/.test(proposed)) return;
    const point = app.editor.globalOffsetToBlock(cm.indexFromPos(change.from)), block = app.editor.blocks[point.index];
    if (block?.type === "code" && point.offset > block.src.split("\n")[0].length) return;
    const language = newCodeLanguage(app.settings, app.editor._lastCodeLanguage);
    if (!language) return;
    change.update(change.from, change.to, [change.text[0] + language]);
    cm.__defaultCodeLanguage = { line: change.from.line, start: proposed.length, end: proposed.length + language.length };
  });
  cm.on("inputRead", () => {
    const inserted = cm.__defaultCodeLanguage;
    if (inserted) { delete cm.__defaultCodeLanguage; cm.setSelection({ line: inserted.line, ch: inserted.start }, { line: inserted.line, ch: inserted.end }); }
    update(true);
  });
  cm.on("cursorActivity", () => update());
  cm.on("blur", () => { if (current?.owner === cm) hideCodeCompletion(); });
  cm.getWrapperElement().addEventListener("keydown", (event) => keydown(event, cm), true);
  bindCodeComposition(cm);
}

export function bindCodeComposition(cm) {
  cm.getWrapperElement().addEventListener("compositionstart", () => { cm.__lettrineComposing = true; hideCodeCompletion(); }, true);
  cm.getWrapperElement().addEventListener("compositionend", () => { cm.__lettrineComposing = false; }, true);
}
