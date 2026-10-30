import { markdownPairEdit } from "../core/writing-options.js";
import { markdownSpans } from "../core/selection.js";
import { newCodeLanguage } from "../core/code-tools.js";

export function bindSourceMarkdownPairs(app, cm) {
  let pending = null, pair = null;
  cm.on("beforeChange", (_, change) => {
    if (!app.settings.autoPairMarkdown || app.editor.readOnly || cm.__lettrineComposing || change.origin !== "+input") return;
    if (change.text.length === 2 && change.text.every((line) => !line) && change.from.line === change.to.line && change.from.ch === change.to.ch) {
      const point = app.editor.globalOffsetToBlock(cm.indexFromPos(change.from)), block = app.editor.blocks[point.index];
      if (block?.type === "code" && !block.src.includes("\n") && point.offset === block.src.length) {
        const start = cm.indexFromPos(change.from);
        change.update(change.from, change.to, ["", "", block.fence], "markdown-pair");
        pending = { start: start + 1, end: start + 1 }; pair = null; return;
      }
      if (block?.type === "code" && block.closed && !block.body && point.offset === block.src.indexOf("\n")) {
        change.cancel(); queueMicrotask(() => cm.setCursor({ line: change.from.line + 1, ch: 0 })); return;
      }
    }
    if (change.text.length !== 1 || change.text[0].length !== 1) return;
    const source = cm.getValue(), start = cm.indexFromPos(change.from), end = cm.indexFromPos(change.to), character = change.text[0];
    if (!/[*_`~#> ]/.test(character)) { pair = null; return; }
    const spans = markdownSpans(source, app.settings);
    if (spans.nested.some((span) => ["code", "math", "html", "frontmatter"].includes(span.block.type) && start >= span.start && end <= span.end && !(span.block.type === "code" && !span.block.src.includes("\n")))) return;
    const literal = spans.inline.find((span) => ["code", "math"].includes(span.kind) && start >= span.contentStart && end <= span.contentEnd || span.kind === "link" && start > span.contentEnd && start < span.end);
    if (literal) {
      if (literal.kind === "code" && start === end && start === literal.contentEnd && character === "`" && source[start] === character) {
        change.cancel(); queueMicrotask(() => cm.setCursor(cm.posFromIndex(start + 1)));
      }
      return;
    }
    const edit = markdownPairEdit(source, { start, end }, character, pair, newCodeLanguage(app.settings, app.editor._lastCodeLanguage));
    if (!edit) { pair = null; return; }
    if (edit.from === edit.to && !edit.text) {
      change.cancel(); pair = null;
      queueMicrotask(() => cm.setCursor(cm.posFromIndex(edit.selection.start)));
    } else {
      change.update(cm.posFromIndex(edit.from), cm.posFromIndex(edit.to), edit.text.split("\n"), "markdown-pair");
      pending = edit.selection; pair = edit.pair;
    }
  });
  cm.on("change", () => {
    if (!pending) return;
    const selection = pending; pending = null;
    cm.setSelection(cm.posFromIndex(selection.start), cm.posFromIndex(selection.end));
  });
}
