import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import MarkdownIt from "markdown-it";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
import { parseInline } from "../src/core/inline.js";
import { readableMarkdown } from "../src/core/readable.js";
import { ALERT_LABELS } from "../src/core/alerts.js";
import { MARKDOWN_EXTENSIONS, isMarkdownExtension } from "../src/core/documents.js";
import { buildNativeExport } from "../src/renderer/native-export.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.markdownit = MarkdownIt;
window.__lettrine = { settings: {} };
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { formatUnderline, formatBold, setAlert, handlePaste, clearFormat } = await import("../src/renderer/editor-ops.js");
const { localizeUI } = await import("../src/renderer/localization.js");
const { htmlToMarkdown } = await import("../src/renderer/html-to-markdown.js");

function makeEditor(source) {
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  root.tabIndex = 0;
  document.body.appendChild(root);
  const editor = new Editor({ root });
  editor.setText(source);
  root.focus();
  return editor;
}

for (const [type, label] of Object.entries(ALERT_LABELS)) test(`alerts: ${type} preserves source, nested formatting and decorations`, () => {
  const source = `  >[!${type.toUpperCase()}]  \n  > **Careful** with *this*.\n  >\n  > - first\n  > - second`;
  const editor = makeEditor(source);
  const quote = editor.root.firstElementChild;
  assert.equal(editor.blocks[0].alert, type);
  assert.ok(quote.classList.contains("md-alert-" + type));
  assert.equal(quote.querySelector(".md-alert-title").textContent, label);
  assert.ok(quote.querySelector(".md-alert-title.md-decor svg"));
  assert.equal(quote.querySelector("strong").textContent, "**Careful**");
  assert.equal(quote.querySelectorAll("li").length, 2);
  assert.equal(blockSourceFromEl(quote), source);
  assert.equal(blocksToMarkdown(editor.blocks), source);
  assert.equal(readableMarkdown(source), "Careful with this.\n\nfirst\nsecond");
});

test("alerts: only a known first-line marker changes a quote", () => {
  for (const source of ["> plain\n> [!NOTE]", "> [!UNKNOWN]\n> body", "> `[!NOTE]`", "> [!NOTE]book"]) {
    const editor = makeEditor(source);
    assert.equal(editor.blocks[0].alert, null);
    assert.equal(editor.root.querySelector(".md-alert"), null);
    assert.equal(blockSourceFromEl(editor.root.firstElementChild), source);
  }
  const editor = makeEditor("> [!nOtE]\n> body\n>\n> > [!TIP]\n> > nested");
  assert.equal(editor.root.querySelectorAll(".md-alert").length, 2);
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), editor.getMarkdown());
});

test("alerts: editing the marker and the body updates the style and preserves source", () => {
  const source = "> [!NOTE]\n> Careful.";
  const editor = makeEditor(source);
  editor.replaceRange(4, 8, "WARNING");
  assert.ok(editor.root.firstElementChild.classList.contains("md-alert-warning"));
  const text = editor.root.querySelector("blockquote .md-plain .md-plain").firstChild;
  text.data = "Edited **body**.";
  const updated = blockSourceFromEl(editor.root.firstElementChild);
  assert.equal(updated, "> [!WARNING]\n> Edited **body**.");
});

test("alerts: the paragraph command converts and changes types as one undo step", () => {
  const editor = makeEditor("first\nsecond");
  editor.selectOffsets(8);
  setAlert(editor, "tip");
  assert.equal(editor.getMarkdown(), "> [!TIP]\n> first\n> second");
  assert.equal(editor.selectionOffsets().start, 21);
  editor.undo();
  assert.equal(editor.getMarkdown(), "first\nsecond");
  editor.setText(" >[!nOtE] \n > body");
  editor.selectOffsets(editor.getMarkdown().length);
  setAlert(editor, "caution");
  assert.equal(editor.getMarkdown(), " >[!CAUTION] \n > body");
  editor.undo();
  assert.equal(editor.getMarkdown(), " >[!nOtE] \n > body");
  editor.setText("  >  [!nOtE] \n  > body");
  editor.selectOffsets(editor.getMarkdown().length);
  setAlert(editor, "warning");
  assert.equal(editor.getMarkdown(), "  >  [!WARNING] \n  > body");
  editor.setText("> plain\n> quote");
  editor.selectOffsets(editor.getMarkdown().length);
  setAlert(editor, "important");
  assert.equal(editor.getMarkdown(), "> [!IMPORTANT]\n> plain\n> quote");
});

test("alerts: marker-only quotes and localized titles never become document text", () => {
  const editor = makeEditor("> [!NOTE]");
  localizeUI({ locale: "zh-Hans", strings: { Note: "注意" } });
  assert.equal(editor.root.querySelector(".md-alert-title").textContent, "注意");
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), "> [!NOTE]");
  assert.equal(readableMarkdown(editor.getMarkdown()), "");
  localizeUI({ locale: "en", strings: {} });
});

test("alerts: an empty inserted alert has an editable body with an exact caret offset", () => {
  const editor = makeEditor("");
  editor.selectOffsets(0);
  setAlert(editor, "note");
  assert.equal(editor.getMarkdown(), "> [!NOTE]\n> ");
  assert.equal(editor.blocks[0].items.length, 2);
  assert.equal(editor.selectionOffsets().start, editor.getMarkdown().length);
  editor.replaceSelection("New body");
  assert.equal(editor.getMarkdown(), "> [!NOTE]\n> New body");
  assert.ok(editor.root.querySelector(".md-alert-note"));
});

test("alerts: separate alerts and newly wrapped neighbors stay separate after reopening", () => {
  const source = "> [!NOTE]\n> First.\n\n> [!TIP]\n> Second.";
  const editor = makeEditor(source);
  assert.equal(editor.root.querySelectorAll(".md-alert").length, 2);
  assert.equal(editor.getMarkdown(), source);
  editor.setText("> [!NOTE]\n> First.\n");
  editor.selectOffsets(editor.getMarkdown().length);
  setAlert(editor, "warning");
  assert.equal(editor.getMarkdown(), "> [!NOTE]\n> First.\n\n> [!WARNING]\n> ");
  assert.equal(editor.root.querySelectorAll(".md-alert").length, 2);
  editor.undo();
  assert.equal(editor.getMarkdown(), "> [!NOTE]\n> First.\n");
});

test("quotes: caret positions follow real prefixes across lines, blank lines and nesting", () => {
  for (const source of [
    "> [!NOTE]\n> first\n>\n> second",
    " >[!TIP]\n > body",
    "> [!NOTE]\nlazy continuation",
    "> [!WARNING]\n>\n> > nested text",
  ]) {
    const editor = makeEditor(source);
    const start = source.lastIndexOf(source.includes("nested") ? "nested" : source.includes("lazy") ? "lazy" : source.includes("second") ? "second" : "body");
    editor.selectOffsets(start, start + 3);
    assert.equal(window.getSelection().toString(), source.slice(start, start + 3), source);
    assert.deepEqual(editor.selectionOffsets(), { start, end: start + 3, backward: false }, source);
  }
});

test("underline: nested marks, code and literal tag spelling round-trip", () => {
  const samples = [
    "<u>**bold** and *italic* with `code`</u>",
    "before <U>word</U> after",
    "<u>outer <u>inner</u></u>",
    "<u>`</u>` is code</u>",
    "<u>line one\nline two</u>",
    "\\<u>escaped</u>",
    "<u>unfinished",
    "<u onclick=\"bad()\">literal HTML</u>",
  ];
  for (const source of samples) {
    const editor = makeEditor(source);
    assert.equal(blockSourceFromEl(editor.root.firstElementChild), source);
    assert.equal(editor.getMarkdown(), source);
  }
  assert.equal(parseBlocks(samples[0])[0].type, "paragraph");
  assert.equal(parseInline(samples[3])[0].inner, "`</u>` is code");
  assert.equal(readableMarkdown(samples[0]), "bold and italic with code");
  const editor = makeEditor(samples[0]);
  assert.ok(editor.root.querySelector("u > strong"));
  assert.ok(editor.root.querySelector("u > em"));
  assert.ok(editor.root.querySelector("u > code"));
  assert.equal(makeEditor(samples[5]).root.querySelector("u"), null);
});

test("underline: toggles inner selections, complete tags, empty typing regions and undo", () => {
  const editor = makeEditor("a word z");
  editor.selectOffsets(2, 6);
  formatUnderline(editor);
  assert.equal(editor.getMarkdown(), "a <u>word</u> z");
  assert.deepEqual(editor.selectionOffsets(), { start: 5, end: 9, backward: false });
  formatUnderline(editor);
  assert.equal(editor.getMarkdown(), "a word z");
  editor.undo();
  assert.equal(editor.getMarkdown(), "a <u>word</u> z");
  editor.selectOffsets(2, 13);
  formatUnderline(editor);
  assert.equal(editor.getMarkdown(), "a word z");
  editor.selectOffsets(0);
  formatUnderline(editor);
  editor.replaceSelection("typed");
  assert.equal(editor.getMarkdown(), "<u>typed</u>a word z");
  assert.ok(editor.root.querySelector("u"));
  editor.selectOffsets(4);
  clearFormat(editor);
  assert.equal(editor.getMarkdown(), "typeda word z");
  assert.equal(htmlToMarkdown("<p><u>Keep <strong>formatting</strong></u></p>"), "<u>Keep **formatting**</u>");
});

test("export: alerts and underline survive HTML/PDF preparation without enabling arbitrary HTML", async () => {
  window.bridge = { theme: { resolve: async () => ({}) } };
  const source = [
    "> [!warning]\n> <u>Keep **source**</u>.",
    "> \n> > [!TIP]\n> > Nested.",
    "\n> [!NOTE]",
    "\n<u>Standalone</u>",
    "\n<script>unsafe()</script>",
  ].join("\n");
  const html = await buildNativeExport({ text: source, style: false });
  const output = new JSDOM(html).window.document;
  assert.equal(output.querySelectorAll("blockquote.md-alert").length, 3);
  assert.equal(output.querySelector(".md-alert-warning .md-alert-title").textContent, "Warning");
  assert.ok(output.querySelector(".md-alert-warning u strong"));
  assert.equal(output.querySelectorAll("u").length, 2);
  assert.equal(output.querySelector("script"), null);
  assert.doesNotMatch(output.querySelector("article").textContent, /\[!(NOTE|TIP|warning)\]/);
  assert.match(output.querySelector("article").textContent, /<script>unsafe\(\)<\/script>/);
});

test("readonly: input, commands, controls and undo are blocked, then caret and history return", () => {
  const editor = makeEditor("text\n\n- [ ] task\n\n[^n]: note\n\n```js\ncode\n```");
  editor.selectOffsets(4);
  editor.replaceSelection(" draft");
  editor.selectOffsets(2, 4);
  const source = editor.getMarkdown(), history = editor._history.length;
  editor.setReadOnly(true);
  assert.equal(editor.root.getAttribute("contenteditable"), "false");
  assert.equal(editor.root.querySelector("[contenteditable=true]"), null);
  assert.ok(editor.root.querySelector("input[type=checkbox]").disabled);
  for (const type of ["beforeinput", "cut", "paste", "drop"]) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    editor.root.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, type);
  }
  formatBold(editor);
  setAlert(editor, "warning");
  editor.replaceSelection("blocked");
  editor.undo();
  editor.redo();
  handlePaste(editor, { preventDefault() {}, target: editor.root });
  assert.equal(editor.getMarkdown(), source);
  assert.equal(editor._history.length, history);
  editor.renderAll({ full: true });
  assert.equal(editor.root.querySelector("[contenteditable=true]"), null);
  editor.setReadOnly(false);
  assert.equal(editor.root.getAttribute("contenteditable"), "true");
  assert.equal(editor.root.querySelector("input[type=checkbox]").disabled, false);
  assert.deepEqual(editor.selectionOffsets(), { start: 2, end: 4, backward: false });
  editor.undo();
  assert.match(editor.getMarkdown(), /^text\n\n/);
});

test("readonly: plain-click document links still open for reading", () => {
  const editor = makeEditor("[Read more](notes.md)");
  const previous = window.__lettrine.openLink;
  let opened;
  window.__lettrine.openLink = (url) => { opened = url; };
  try {
    editor.setReadOnly(true);
    editor.root.querySelector("a").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(opened, "notes.md");
    assert.equal(editor.getMarkdown(), "[Read more](notes.md)");
  } finally { window.__lettrine.openLink = previous; }
});

test("readonly: CodeMirror cannot overwrite the remembered state of its own textarea", () => {
  const editor = makeEditor("```js\ncode\n```");
  const fence = editor.root.firstElementChild;
  const input = document.createElement("textarea");
  fence.appendChild(input);
  fence.__cm = { setOption: (_, value) => { input.readOnly = value; } };
  editor.setReadOnly(true);
  assert.equal(input.readOnly, true);
  editor.setReadOnly(false);
  assert.equal(input.readOnly, false);
  fence.__cm = null;
});

test("documents: all supported Markdown suffixes use one case-insensitive classification", () => {
  assert.equal(new Set(MARKDOWN_EXTENSIONS).size, MARKDOWN_EXTENSIONS.length);
  for (const extension of MARKDOWN_EXTENSIONS) {
    assert.ok(isMarkdownExtension(extension));
    assert.ok(isMarkdownExtension("." + extension.toUpperCase()));
  }
  for (const extension of ["txt", "text", "pdf", "md.bak", ""]) assert.equal(isMarkdownExtension(extension), false);
});
